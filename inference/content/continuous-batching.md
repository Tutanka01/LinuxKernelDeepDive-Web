# Continuous Batching & Scheduling

> **Goal of this chapter:** turn the arithmetic of Module 1 into a mechanism.
> You'll see why the obvious way to batch requests wastes most of your GPU,
> how Orca's iteration-level scheduling fixes it, why a single long prompt can
> freeze everyone else's stream, and how chunked prefill and a token budget
> keep a busy server smooth. After this, the word "scheduler" in a serving
> engine stops being a black box.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="scheduler,batch"></div>

You have one model — say Llama-3-70B — one 8-GPU box, and a thousand people
hitting your API right now. Their requests arrive at random moments. Some want
a three-token yes/no; some want a 2,000-token essay. [Inference Arithmetic](#/inference-arithmetic)
handed you the key fact: for **decode** (generating one token at a time), the
GPU spends almost all its time *reading the model weights out of HBM* — the
GPU's on-package high-bandwidth memory — not doing arithmetic. At batch size 1
you re-read all 140 GB of weights to produce a single token, running at maybe
1/300th of the chip's arithmetic ceiling. The fix was **batching**: run B
sequences together, read each weight once, reuse it across all B. Below the
critical batch size (`B_crit`, ~280 on an H100), adding a request is nearly
*free* — you were re-reading those weights anyway.

So the plan writes itself: gather requests, batch them, print money. The
trouble is entirely in the word *gather*. Requests don't arrive together and
they don't finish together, and a naive batch turns that mismatch into idle
silicon.

## Static batching: the batch runs at the speed of its slowest member

The first thing anyone builds is **request-level batching**, also called
**static batching**: collect B requests, run the whole batch through the model
until *every* sequence has finished, then return them all and start the next
batch. One forward pass — one full sweep through the model — produces one new
token for every sequence at once.

The problem is that autoregressive generation has no fixed length. Each
sequence runs until the model emits a special end-of-sequence token, and that
happens after wildly different amounts of output. Put a 20-token reply and a
2,000-token reply in the same static batch and the short one finishes on
iteration 20 — then sits there, occupying a slot, contributing nothing, for
1,980 more iterations while the batch waits for the long one. The batch runs at
the speed of its slowest member, and finished sequences can't leave.

```text
Static batching — 4 requests, batch runs until ALL finish
(each ■ = one decode iteration producing a token; □ = wasted slot)

 R1  ■■■■■□□□□□□□□□□□□□□□□□□□   done at it 5, then idle 19 iters
 R2  ■■■■■■■■■■■■□□□□□□□□□□□□   done at it 12
 R3  ■■■■■■■■□□□□□□□□□□□□□□□□   done at it 8
 R4  ■■■■■■■■■■■■■■■■■■■■■■■■   done at it 24  ← everyone waits for this
      └──────────── batch busy 24 iters ─────────────┘
 R5 (just arrived) ................ must wait for the whole batch to drain
```

Two wastes stack up. **Internally**, those `□` slots are dead GPU capacity —
you're paying to read weights for sequences that already finished. **At the
door**, a request that arrives one iteration after the batch starts waits for
the entire batch to drain before it can even begin — its time-to-first-token
(TTFT) balloons for no computational reason. On real traffic with mixed output
lengths, static batching leaves the GPU mostly idle.

## Orca's insight: schedule one iteration at a time

The fix, introduced by **Orca** (Yu et al., [OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu)),
is to stop thinking of a "batch" as a fixed cohort that lives and dies
together. Instead, schedule at the granularity of **a single decode
iteration**. After *every* forward pass, the scheduler wakes up and does
bookkeeping:

- Any sequence that just emitted end-of-sequence is **evicted** — its slot
  frees immediately, and it returns to the user right away.
- Any request waiting in the queue is **admitted** into a free slot, joining
  the batch mid-flight for the very next iteration.

The batch is now a revolving door. Its membership changes every iteration; a
sequence joins when there's room and leaves the instant it's done. This is
**continuous batching** (NVIDIA calls the same idea "in-flight batching").

```text
Continuous batching — sequences join and leave every iteration

 it:  1  2  3  4  5  6  7  8  9 10 11 12 ...
 R1   ■  ■  ■  ■  ✓                         leaves at it 5
 R2   ■  ■  ■  ■  ■  ■  ■  ■  ✓             leaves at it 9
 R3   ■  ■  ■  ✓                            leaves at it 4
 R4   ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■
 R5         ▶  ■  ■  ■  ✓                   ADMITTED at it 3 (R3's slot)
 R6                  ▶  ■  ■  ■  ■  ■       ADMITTED at it 5 (R1's slot)
              every freed slot is refilled the next iteration — no idle □
```

No sequence waits for the batch to drain, and no slot idles behind a finished
neighbour. The GPU stays as full as the arriving traffic allows, which — below
`B_crit` — is exactly the regime where extra sequences are nearly free.

> [!bridge] You already know this — from the Linux course
> Static batching is head-of-line blocking with extra steps, and Orca's answer
> is the run queue: re-decide after every tick, admit whatever became runnable,
> drop whatever exited. The quantum here is one forward pass — nothing can be
> preempted mid-pass — and the goal is inverted: CFS divides a CPU *between*
> tasks, while this scheduler is packing sequences *into the same* weight read,
> so below `B_crit` the members of the batch are barely competing at all.
> [→ Linux: CPU Scheduling](../#/scheduling)

Orca's second idea makes this actually implementable. You might assume you can
just stack all the sequences into one big tensor and run them together. For
most of the model you can: the heavy matrix multiplies — the QKV projection,
the MLP layers, what the hardware community calls **GEMMs** (general
matrix-matrix multiplies) — treat each token independently, so tokens from
different sequences batch together perfectly regardless of which sequence they
belong to. **Attention is the exception.** Each sequence attends over its *own*
KV cache — the running record of past keys and values, and every sequence's is
a different length and lives at a different memory location. You can't express
"sequence A attends over its 40 tokens, sequence B over its 900" as one clean
batched matmul.

Orca's answer is **selective batching**: batch the operations that batch
cleanly (the GEMMs, across all tokens at once) and handle attention
per-sequence (loop over sequences, or dispatch a specialized kernel that takes
each sequence's KV range separately). One batched GEMM feeds many individual
attention computations, which then merge back into the next batched GEMM. This
split — batch the weight-bound matmuls, special-case attention — is the
structural bones of every modern engine, and later chapters
([FlashAttention & Decode Kernels](#/flashattention)) are largely about making
that per-sequence attention step fast.

> **State of play (mid-2026):** Anyscale's widely-cited 2023 benchmark measured
> up to **23× throughput** for continuous batching over naive static batching.
> Treat that number as an upper bound from a favorable setup, not a guarantee:
> the gain grows with how *variable* your output lengths are (more variance →
> more wasted static slots to reclaim) and shrinks toward 1× when every request
> is the same length. The *mechanism* is not in doubt — it's in every
> production engine — but your mileage depends entirely on your traffic.

## The interference problem: one long prompt stalls everyone

Continuous batching solves the *decode* mismatch. But it exposes a second
problem, and to see it you have to remember that not all iterations are alike.

Generating a request has two phases. **Prefill** ingests the prompt: all its
tokens go through the model in a single parallel pass to build the KV cache and
produce the first output token. Because it processes many tokens at once,
reusing each weight across all of them, prefill is **compute-bound** — it
actually saturates the GPU's arithmetic units. **Decode** then produces the
rest one token at a time, memory-bound, as above. (This asymmetry was the whole
story of [Inference Arithmetic](#/inference-arithmetic).)

Now the collision. Your server is happily decoding for 50 users, each getting a
token every ~30 ms. A new request arrives with a **10,000-token prompt** — a
big RAG context, say. Its prefill is one giant compute-bound step. Roughly, it
costs `2 × P × T` FLOPs `= 2 × 70e9 × 10,000 ≈ 1.4e15` FLOPs; on an H100 doing
real work at maybe 450 effective TFLOP/s, that single step takes on the order
of **3 seconds**. If you run that prefill as one batch step, the GPU is busy
with it and *nothing else advances*. All 50 decoding users, who expect a token
every 30 ms, get nothing for three seconds — a **100× spike in inter-token
latency (ITL)**, the per-token gap they feel while streaming.

This is the prefill/decode interference problem, formalized by **Sarathi-Serve**
(Agrawal et al., [OSDI 2024](https://www.usenix.org/system/files/osdi24-agrawal.pdf)).
It's the throughput-vs-latency tension made concrete. Batch the big prefill
together with the decodes and the decodes stall (ITL disaster). Run prefills
and decodes in strict separation and you waste compute idling one while the
other runs. Either way you lose — as long as prefill is allowed to run as one
indivisible giant step.

## Chunked prefill: stall-free hybrid batches

The insight is that a prefill *doesn't have to run all at once*. The prompt's
tokens can be processed in **chunks** across several iterations. So split the
10,000-token prefill into, say, chunks of 512 tokens, and on each iteration
build a **hybrid batch**: one prefill chunk *plus* the single decode token from
every currently-active sequence, all in one forward pass.

Now every iteration does a bounded, predictable amount of work — one chunk's
worth of prefill and everyone's decode — instead of occasionally detonating a
3-second megastep. Sarathi calls this **stall-free batching**. The decoding
users see a modest, steady ITL (roughly the time for one chunk, ~160 ms in our
example, not 3 seconds), and the big prompt still makes progress, one chunk per
iteration, riding along in batches it would otherwise have blocked.

```text
                one 10K prefill = one 3s step; all decodes freeze
 NO CHUNKING:   [ ===== 10K-token prefill (≈3s) ===== ] then decodes resume
                 decoders' ITL:  30ms 30ms ....... 3000ms ....... 30ms

 CHUNKED:       each step = one 512-tok prefill chunk + everyone's decode token
                [c1+dec][c2+dec][c3+dec] ... [c20+dec]   (~160ms each)
                 decoders' ITL:  ~160ms ~160ms ~160ms — a bump, never a freeze
```

There's a real tradeoff dialed by the chunk size. Smaller chunks → smoother
decode (lower ITL) but the long prompt's own TTFT stretches over more
iterations, and you pay a little overhead re-reading weights for each chunk.
Bigger chunks → faster prefill, rougher decode. Chunked prefill is now the
**default in vLLM V1 and available in SGLang** — the mainstream answer to
interference on a single GPU pool. (The other answer, giving prefill and decode
*separate hardware*, is **disaggregation** — a Module 5 topic;
[Disaggregated Serving](#/disaggregation) picks it up.)

## The scheduler's actual job: token budgets, order, and eviction

Continuous batching plus chunked prefill collapse into one clean abstraction,
the one vLLM's V1 scheduler is built on. Every iteration has a **token
budget** — a cap on how many tokens the batch may process this step. The
scheduler fills that budget from waiting and running requests: a decoding
sequence asks for 1 token, a prefilling one asks for up to its remaining chunk.
Prefill chunk size, hybrid batches, and "how many decodes fit" all fall out of
one number. There's no separate prefill mode and decode mode — just a budget
and a queue.

Two more decisions define the policy:

- **Order (which waiting requests get admitted).** The default is **FCFS** —
  first come, first served, the fair and predictable choice. Engines also offer
  **priority** scheduling so latency-critical traffic can jump ahead of bulk
  batch jobs.
- **Admission control (whether to admit at all).** A new sequence needs room
  for its KV cache to *grow* as it generates. Admit too many and you'll run out
  of GPU memory mid-flight; the scheduler holds requests in the queue rather
  than start what it can't sustain.

Which raises the ugly case: you've admitted a batch, everyone's KV cache is
growing token by token, and you **run out of KV memory** anyway. Something
already running has to be kicked out — **preemption**. Two ways to do it:

- **Swap:** copy the victim's KV cache out to CPU RAM, and copy it back when
  the sequence resumes. You keep the computed state but pay the round-trip over
  the PCIe/NVLink bus.
- **Recompute:** simply *drop* the victim's KV cache. When it resumes, redo its
  prefill to rebuild it from the prompt (which you still have).

> [!bridge] You already know this — from the Linux course
> That is page reclaim's central choice. A dirty anonymous page has to be
> written to swap, because nothing else in the system can reproduce it; a clean
> file-backed page is simply dropped and re-read on the next fault, because the
> bytes still exist somewhere cheaper. KV is the clean case — you still hold the
> prompt that generated it — which is why "drop it and rebuild" is a
> respectable default here and would be madness for anonymous memory.
> [→ Linux: Virtual Memory](../#/memory)

vLLM V1 chose **recompute** as its default and deprecated V0's swap. The reason
is a preview of the next chapter: recompute pairs beautifully with **prefix
caching**. If the dropped sequence shared a prompt prefix — a system prompt,
a few-shot preamble, a RAG document — with something still cached, rebuilding
it isn't a full recompute at all; it reuses the surviving KV blocks and only
recomputes the genuinely new tail. Dropping state is cheap when you can get
most of it back for free. *How* those KV blocks are stored, shared, and
reclaimed is exactly where we go next.

## Watch the loop run

Every claim in this chapter is a claim about a loop, and loops are easier to
believe once you have watched one. In the simulator below, start on preset 1
and flip **batching** from Static back to Continuous: the grey finished slots
that were holding the door shut refill on the next step and the queue behind
them drains. Then take preset 2 — a 10,000-token prompt landing every three
seconds — and tick **chunked prefill** on and off while you watch the ITL
reading: that is the interference problem and its fix, at 4× speed.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

## Frequently asked

<div class="faq">

<details>
<summary>If the scheduler admits a new sequence every iteration, does that slow down the ones already decoding?</summary>

Below `B_crit` it barely does. The step's dominant cost is streaming the model
weights out of HBM, and that cost is paid once per step no matter how many
sequences ride along — so an extra sequence adds its own KV reads and a sliver
of arithmetic, not a whole weight sweep. Past `B_crit` the step becomes
compute-bound and every additional token in the batch does show up as inter-token
latency for everyone. That is why engines cap the batch (`--max-num-seqs`) and
the per-step work (`--max-num-batched-tokens`) rather than admitting everything
that has arrived.

</details>

<details>
<summary>What should I set the prefill chunk size to?</summary>

Start with the engine's default (commonly 512–2,048 tokens) and move it only
against a measurement. Smaller chunks smooth inter-token latency for the users
already decoding and stretch the long prompt's TTFT across more iterations;
bigger chunks do the reverse, and waste less on re-reading weights per chunk. The
honest procedure is to fix your ITL target, then raise the chunk size until you
are about to break it — the largest chunk that still meets your latency SLO is
also the most throughput you can have.

</details>

<details>
<summary>My server logs preemptions constantly. What is it telling me?</summary>

That you admitted more concurrent sequences than your KV pool can feed as they
grow, so the scheduler is repeatedly dropping and re-prefilling somebody's
cache. It is not a crash and it is not free: recompute burns prefill FLOPs you
already spent. The levers are to give the pool more room
(`--gpu-memory-utilization`, a shorter `--max-model-len`, quantized KV) or to
admit fewer sequences (`--max-num-seqs`) so the ones you did admit can finish. A
low, occasional preemption rate under a traffic spike is healthy; a steady one
means you are sized wrong, which is [Sizing a Deployment](#/sizing-a-deployment)'s
subject.

</details>

</div>

## What to remember

- **Static (request-level) batching** runs a fixed cohort until all finish: the
  batch moves at the speed of its slowest member, finished sequences waste their
  slots, and new arrivals wait for a full drain. On mixed-length traffic it
  leaves the GPU mostly idle.
- **Continuous batching** (Orca, OSDI 2022) reschedules **every iteration** —
  evict the finished, admit the waiting — so freed slots refill immediately and
  the GPU stays as full as arriving traffic allows.
- **Selective batching:** the weight-bound GEMMs batch across all tokens
  cleanly; **attention can't** (each sequence has its own variable-length KV).
  Batch the former, special-case the latter. This split is the skeleton of
  every engine.
- **Prefill/decode interference:** a long prompt's prefill is one big
  compute-bound step that freezes every decoder's stream — an ITL spike
  (Sarathi-Serve, OSDI 2024).
- **Chunked prefill** splits the prompt into chunks and builds **hybrid
  batches** (one chunk + everyone's decode token), bounding per-step work.
  Stall-free, and the default in vLLM V1 / SGLang.
- The V1 scheduler unifies all of this under a **per-step token budget**;
  policy is **FCFS or priority** plus admission control; when KV memory fills it
  **preempts by recompute** (drop and rebuild — cheap thanks to prefix caching)
  rather than swapping to CPU.
- Scheduling decides **who** computes each step. The next chapter,
  [PagedAttention & Prefix Caching](#/paged-kv-cache), decides **where** their
  KV state lives.

```quiz
[
  {
    "q": "Why does static (request-level) batching waste GPU capacity on real traffic?",
    "choices": [
      "It re-reads the model weights for every sequence individually, defeating the point of batching",
      "The batch runs until every sequence finishes, so short replies hold dead slots while the batch waits for the longest one — and new arrivals wait for a full drain",
      "It can only ever batch two requests at a time",
      "Attention forces every sequence to run in a separate forward pass"
    ],
    "answer": 1,
    "explain": "Autoregressive outputs have wildly different lengths. A fixed cohort runs at the speed of its slowest member; finished sequences can't leave and keep occupying slots, and a request that arrives mid-batch must wait for the whole thing to drain before it starts."
  },
  {
    "q": "What exactly is scheduled 'continuously' in continuous batching?",
    "choices": [
      "The GPU clock speed is adjusted continuously to match load",
      "Requests are admitted in a continuous stream but still run to completion as a fixed batch",
      "After every single decode iteration the scheduler evicts finished sequences and admits waiting ones, so batch membership changes each step",
      "Prompts are streamed token-by-token from the client continuously"
    ],
    "answer": 2,
    "explain": "Orca's iteration-level scheduling reschedules after each forward pass: finished sequences leave immediately and queued ones join for the next iteration. The batch is a revolving door, so freed slots refill at once instead of idling until a drain."
  },
  {
    "q": "Selective batching batches the big GEMMs across sequences but handles attention per-sequence. Why the special case?",
    "choices": [
      "Attention is compute-bound while GEMMs are memory-bound, so they can't share a batch",
      "Each sequence attends over its own KV cache of a different length at a different memory location, which can't be expressed as one clean batched matmul",
      "Attention must run on CPU while GEMMs run on GPU",
      "The softmax in attention is not differentiable across a batch"
    ],
    "answer": 1,
    "explain": "The QKV and MLP matmuls treat every token independently, so tokens from different sequences stack into one GEMM. Attention is the exception: sequence A over 40 tokens and B over 900 have different-length, differently-located KV, so attention is looped or dispatched per-sequence."
  },
  {
    "q": "A 10K-token prompt arrives while 50 users are decoding. Run its prefill as one step and they all stall for seconds. What does chunked prefill do about it?",
    "choices": [
      "It runs the long prefill on a separate GPU so decodes are untouched",
      "It drops the long prompt to the back of a low-priority queue until the server is idle",
      "It splits the prefill into chunks and builds hybrid batches — one chunk plus every active sequence's decode token per step — bounding per-step work",
      "It lowers the precision of the prefill so it finishes fast enough not to matter"
    ],
    "answer": 2,
    "explain": "The prefill needn't run all at once. Chunking it and packing one chunk together with everyone's decode tokens caps the work per iteration, so decoders see a steady modest ITL instead of a multi-second freeze — Sarathi's stall-free batching. (Separate hardware is disaggregation, a different answer.)"
  },
  {
    "q": "When KV memory fills, vLLM V1 preempts by recompute (drop the KV cache and rebuild on resume) rather than swapping it to CPU RAM. Why is recompute a natural default?",
    "choices": [
      "Recompute is always faster than a PCIe copy under every workload",
      "It pairs with prefix caching: a resumed sequence often shares a cached prefix, so rebuilding reuses surviving KV blocks and only recomputes the new tail",
      "Swapping to CPU RAM corrupts the KV cache",
      "Recompute uses less GPU memory than the original request did"
    ],
    "answer": 1,
    "explain": "Dropping state is cheap when you can get most of it back for free. If the preempted sequence shares a system prompt, few-shot preamble, or RAG context with something still cached, resuming reuses those KV blocks and recomputes only the genuinely new tokens — so recompute is rarely a full recompute."
  }
]
```
