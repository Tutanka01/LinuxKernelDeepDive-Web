# Sizing a Deployment

> **Goal of this chapter:** turn the arithmetic of Module 1 into an answer to
> the only two questions anyone actually asks you — *will it fit, and how many
> users can it serve at once?* By the end you can write down a deployment's
> whole memory budget from a model card and a GPU spec sheet, invert it to get
> a concurrency number, and rank the levers that move that number. Nothing here
> is asserted; every figure is derived on the page.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kv,runner"></div>

You know the pieces. [Inference Arithmetic](#/inference-arithmetic) gave you
`2 × layers × kv_heads × head_dim × bytes` per token and the critical batch
size. [PagedAttention](#/paged-kv-cache) gave you the block pool. [Continuous
Batching](#/continuous-batching) gave you the scheduler that spends it. What
nobody has yet made you do is add them up.

That addition fails in a specific, humiliating way: the deployment *starts*.
The weights load, the health check passes, a single test request comes back
beautifully — and then under real traffic it serves three people and preempts
constantly. It looked like it fit because you only checked the weights.

## The budget, as one equation

Every byte of a GPU's HBM is spoken for by one of five things:

```text
HBM_total  =  weights
            + KV cache pool
            + activations (transient, per forward pass)
            + framework & CUDA overhead
            + headroom
```

Take them one at a time, honestly, because each has a trap in it.

**Weights** `= P × bytes_per_param`. Llama-3-70B in BF16 is
`70e9 × 2 = 140 GB`. In FP8, 70 GB. In INT4, 35 GB. This is the only term most
people compute, and it is the only one that is genuinely simple.

> [!trap] MoE: total parameters, not active
> [Inference Arithmetic](#/inference-arithmetic) told you to use *active*
> parameters for FLOPs. For **memory you use total**, always. DeepSeek-V3 is
> 37B active and 671B total: it computes like a 37B model and *occupies* like a
> 671B one, because any expert might be routed to on the next token and so must
> be resident. In FP8 that is ~671 GB of weights — a multi-node deployment
> before you have stored a single KV block. Sizing an MoE off its active
> parameter count is off by 18× here, in the direction that does not start.

**KV cache pool** `= kv_bytes_per_token × context × concurrency`. For
Llama-3-70B in BF16, `2 × 80 × 8 × 128 × 2 = 327,680` bytes per token — 320 KiB,
which is the 328 KB you have seen quoted; same number, different unit
convention. This is the term that grows with your traffic, and it is the term
that decides your concurrency.

**Activations** are the transient tensors of one forward pass. For **decode**
they are small and easy to forget about safely: a batch of 64 sequences through
a `d_model = 8192` model carries `64 × 8192 × 2 = 1 MB` per hidden state, and
even the widest MLP intermediate (~3.5× `d_model` for SwiGLU) is under 4 MB. A
rounding error.

For **prefill** it is not a rounding error, and this catches people. A chunked
prefill chunk of 8,192 tokens through the same model carries
`8192 × 8192 × 2 = 134 MB` per hidden state and `8192 × 28672 × 2 ≈ 470 MB` for
the MLP intermediate, with several such tensors live at once inside a layer.
Call it **1–2 GB per GPU** for a large chunk [directional]. The chunk size you
tuned in [Continuous Batching](#/continuous-batching) to smooth out ITL is
also a memory knob; doubling it doubles this term.

**Framework and CUDA overhead** is the part no formula on the internet
includes. The CUDA context alone is several hundred megabytes. PyTorch's
allocator, cuBLAS and cuDNN workspaces, the NCCL communication buffers that
tensor parallelism needs, and the memory pools that CUDA graph capture pins
down all sit on top. Budget **2–4 GB per GPU** [directional], toward the upper
end when you are running tensor parallelism and CUDA graphs, which in
production you are.

**Headroom** is not optional and not superstition. A pool sized to 100% of what
is left preempts — the scheduler admits a batch, a sequence grows one token
past the last free block, and something gets evicted and recomputed. Engines
expose this directly: vLLM's `gpu_memory_utilization` defaults to **0.90**, and
that 10% is exactly this term. Treat 5–10% as the floor, more if your context
lengths are heavy-tailed.

> [!bridge] You already know this — from the Linux course
> Linux lets you allocate far more address space than you have RAM because it
> only commits pages when they are touched, and when the bet goes wrong there is
> swap, reclaim and ultimately the OOM killer behind it. HBM has none of that:
> no swap device sits behind the block pool and no reclaim path will find you a
> spare gigabyte, so the whole five-term budget has to be right *before* the
> process starts. That is why `gpu_memory_utilization` is a headroom knob and
> not an overcommit ratio.
> [→ Linux: Virtual Memory](../#/memory)

## Inverting it

Now the move that makes the equation useful. You do not usually want to know
whether a *given* concurrency fits; you want to know the largest concurrency
that does. Solve for it:

```text
                        HBM_total − weights − overhead − activations − headroom
max_concurrency  =  ─────────────────────────────────────────────────────────────
                              kv_bytes_per_token × context
```

The numerator is your **KV pool**: everything left after the fixed costs. The
denominator is what one sequence costs. Two notes on reading it correctly.

First, `context` here is the **working context** — the number of tokens a
typical live sequence actually holds — not `max_model_len`. Because the pool is
paged, a sequence occupies blocks for the tokens it has, not the tokens it is
permitted to have. Sizing at the maximum is the single most expensive mistake
in this chapter; we return to it under the traps.

Second, notice what is *not* in the denominator: anything about FLOPs. Fit is a
capacity question and only a capacity question. Whether the concurrency you
compute here is *also* a good idea is a separate question, answered by
`B_crit`, and we ask it at the end.

## Worked: Llama-3-70B on two H100s

Here is the configuration people reach for first, because 140 GB of weights
"obviously" fits in 160 GB of HBM. Watch it fail.

The inputs: 2 × H100 80GB = **160 GB** HBM, NVLink-connected, TP=2. Llama-3-70B
— 80 layers, 8 KV heads, head_dim 128, 70B params — in BF16. A 32K context
window.

```text
  HBM_total                   160 GB
− weights   70e9 × 2 bytes  = 140 GB     (70 GB per GPU under TP=2)
− overhead  ~3 GB × 2 GPUs  =   6 GB
− activations ~1 GB × 2     =   2 GB
                              ───────
  raw KV pool                  12 GB
× 0.90 headroom             ≈  10.8 GB usable
```

And one sequence at full context:

```text
  328 KB/token × 32,768 tokens = 10.75 GB
```

**One sequence.** The KV pool holds exactly one 32K conversation, and only if
you shave the headroom. This deployment will serve a demo and collapse the
moment a second user arrives — it will admit them, run out of blocks, and spend
its life preempting and recomputing. It is not a tight deployment; it is a
broken one. Note too that "80 GB" is 80 GiB in some datasheets and 80 × 10⁹
bytes in others, a ~7% swing that on this budget is your entire margin.

Now fix it, one lever at a time, and watch what each one actually buys.

**Lever 1 — FP8 weights.** Halving `bytes_per_param` takes weights to 70 GB and
returns the whole 70 GB to the pool:

```text
160 − 70 − 6 − 2 = 82 GB raw  →  ×0.90 ≈ 74 GB pool
74 / 10.75 ≈ 6.9  →  6 concurrent 32K sequences
```

From 1 to 6. [Quantization](#/quantization) argues FP8 is near-lossless for
weights and activations; here is what that costs and buys in bytes.

**Lever 2 — FP8 KV cache on top.** The denominator halves too:
`2 × 80 × 8 × 128 × 1 = 164 KB/token`, so 5.37 GB per 32K sequence.

```text
74 / 5.37 ≈ 13.8  →  13 concurrent sequences
```

**Lever 3 — four H100s instead of two.** TP=4 gives you 320 GB. At BF16
weights: `320 − 140 − 12 − 4 = 164 GB` raw, ≈148 GB pool, `148 / 10.75 ≈ 13`.
Doubling your hardware bill buys **exactly what the two quantization flags
bought for free**. Do both and the pool is ~210 GB, giving `210 / 5.37 ≈ 39`.

**Lever 4 — size for the real context, not the window.** Your model supports
32K. Your p95 request is not 32K. Suppose the p95 live sequence is 8K tokens.
On two H100s with FP8 weights and FP8 KV, one sequence costs
`164 KB × 8192 = 1.34 GB`:

```text
74 / 1.34 ≈ 55 concurrent sequences
```

Fifty-five, from the same two GPUs, by changing a number in your head rather
than anything on the machine.

**Lever 5 — prefix caching.** Now suppose those 8K tokens are 5K of shared
system prompt and tool definitions plus 3K of per-user content — the shape of
essentially all agent traffic ([The Agentic Era](#/agentic-serving)). The
shared 5K is stored **once** in the block pool and pointed at by every block
table. The marginal cost of a sequence drops to `164 KB × 3072 ≈ 0.50 GB`:

```text
(74 − 0.82 shared) / 0.50 ≈ 145 concurrent sequences   [directional]
```

The ladder, ranked:

| # | Config | Weights | KV pool | KV/seq | Max concurrency |
|---|---|---|---|---|---|
| 1 | 2×H100, BF16 W, BF16 KV, 32K | 140 GB | 11 GB | 10.75 GB | **1** |
| 2 | + FP8 weights | 70 GB | 74 GB | 10.75 GB | **6** |
| 3 | + FP8 KV | 70 GB | 74 GB | 5.37 GB | **13** |
| 4 | 4×H100, BF16 W, BF16 KV, 32K | 140 GB | 148 GB | 10.75 GB | **13** |
| 5 | 4×H100, FP8 W, FP8 KV, 32K | 70 GB | 210 GB | 5.37 GB | **39** |
| 6 | 2×H100, FP8 W+KV, 8K working ctx | 70 GB | 74 GB | 1.34 GB | **55** |
| 7 | row 6 + 5K shared prefix | 70 GB | 74 GB | 0.50 GB | **~145** |

Read rows 3 and 4 together: **the free levers and the expensive lever bought
the same thing.** Then read row 6 and 7: the two biggest wins on the whole
table cost no hardware and no accuracy at all. They are facts about your
traffic that you were free to measure at any time. Sizing is mostly the
discipline of measuring your traffic before you buy silicon for it.

<div class="inf-widget" data-widget="kv-calculator">
<p class="inf-widget-fallback">Interactive KV-cache and memory-fit calculator — needs JavaScript enabled.</p>
</div>

## Worked: Llama-3-8B on one H100

The disaster case teaches the arithmetic; a normal case teaches what healthy
looks like. Llama-3-8B — 32 layers, 8 KV heads, head_dim 128 — in BF16 on one
H100.

```text
  HBM                            80 GB
− weights  8e9 × 2            =  16 GB
− overhead                    ≈   3 GB
− activations                 ≈   1 GB
                                ──────
  raw pool                       60 GB   →  ×0.90 ≈ 54 GB
```

KV per token is `2 × 32 × 8 × 128 × 2 = 131 KB`. At an 8K working context that
is 1.07 GB per sequence, so `54 / 1.07 ≈ 50` concurrent sequences. Switch the
weights and KV to FP8 and you get a 61 GB pool against 0.54 GB per sequence:
**~113 concurrent**.

The difference in character is worth naming. On the 70B, weights ate 87% of the
machine and the pool was the leftovers. On the 8B, weights are 20% and **the
GPU is essentially one large KV pool** — which is exactly why small models
serve so much more cheaply than their parameter ratio suggests. You are not
buying 8.75× fewer FLOPs; you are buying a machine that is mostly cache.

## The sanity check: which wall are you against?

A concurrency number is not yet a verdict. Compare it to `B_crit` — ~295 on an
H100 in BF16, and roughly **half that (~148) once weights are FP8**, since
halving the bytes per weight halves the ratio that defines the ridge. Three
regimes:

**Weight-bound.** Weights are more than ~60–70% of HBM and the pool is a
sliver. Row 1 above. Symptoms: tiny max batch, constant preemption, terrible
throughput at acceptable latency. Fixes, in order of cost: quantize the weights;
raise tensor parallelism to spread weights over more cards (TP=4 on a 70B leaves
35 GB per card free instead of 10 — see [Parallelism for
Inference](#/parallelism-for-inference)); or serve a smaller model.

**KV-bound.** The pool exists but `max_concurrency` lands well below `B_crit`.
Rows 2–5. You are memory-bound *and* you cannot batch your way up to the ridge,
so you are paying for FLOPs you can never reach. Fixes: FP8 KV, right-size the
working context, turn on prefix caching, pick an architecture with a cheaper
cache ([Attention Architectures](#/attention-for-serving) — MLA's ~70 KB/token
against GQA's 328 KB is a 4.7× concurrency multiplier for free), or offload cold
blocks to DRAM ([Disaggregated Serving](#/disaggregation)).

**Compute-bound.** `max_concurrency` comfortably exceeds `B_crit`, like row 7.
Congratulations — you have a well-shaped deployment. Now stop chasing KV
capacity: cap the running batch near the ridge, and spend the surplus HBM on a
larger prefix cache rather than a larger batch, because past `B_crit` extra
sequences buy throughput at a linear cost in everyone's TPOT.

The healthy target is a `max_concurrency` in the same neighbourhood as
`B_crit`. Far below it and your FLOPs are decoration; far above and your KV
pool is.

> [!bridge] You already know this — from the distributed course
> Sharding taught you that aggregate capacity is not capacity: a cluster sized
> correctly in total still falls over when one partition takes the hot keys, so
> you size the *unit* first and the fleet second. A replica here is that unit,
> and the number you have just computed is its capacity. What differs is that
> the hot key is a shared prefix — which, unlike a hot partition, you *want*
> concentrated on one replica, because that is what makes the cache hit.
> [→ Distributed: Partitioning & Sharding](../distributed/#/partitioning)

## Five traps

1. **Sizing at `max_model_len`.** If you compute the pool as
   `concurrency × max_context`, you have re-invented the pre-PagedAttention
   world of reserving for a worst case that never arrives. Size on the p95
   *live* context from your logs; use `max_model_len` only for the admission
   check on a single request.
2. **Forgetting the pool holds the whole batch.** The denominator is one
   sequence; the pool must hold all of them simultaneously. "10.75 GB fits in
   12 GB" is a true statement about one user and a false statement about a
   service.
3. **Forgetting the prefill chunk.** Activations are negligible for decode and
   are not for a big chunk. If you raised `max_num_batched_tokens` to speed up
   prefill, you spent HBM the KV pool was counting on.
4. **MoE active-vs-total.** Compute with active, allocate with total. Every
   time.
5. **"TP=8 gives me 8× the KV room."** It does — that is real and it is the
   most underrated capacity lever there is. But it also costs **two all-reduces
   per layer, per token**, which measure at 20–30% of end-to-end latency even on
   NVLink and become catastrophic the moment the TP group crosses a node
   boundary onto ~50 GB/s InfiniBand. TP is a capacity knob *and* a latency
   knob, pulling in opposite directions;
   [Parallelism for Inference](#/parallelism-for-inference) is where you learn
   to price it.

## Exercises

<div class="exercise">

**Exercise 1.** You have one H100 80GB and want to serve Llama-3-8B in BF16
with a 128K context window, where requests really do use the full window. How
many concurrent sequences fit, and what is the first thing you change?

<details>
<summary>Reveal answer</summary>

Pool: `80 − 16 (weights) − 3 (overhead) − 1 (activations) = 60 GB`, ×0.90 ≈
**54 GB**. One sequence: `131 KB × 131,072 = 17.2 GB`. So
`54 / 17.2 ≈ 3` concurrent sequences.

Three. The model is small and the *cache* is the whole problem — at 128K,
one sequence's KV is larger than the weights. First change: **FP8 KV cache**,
which takes the per-sequence cost to 8.6 GB and concurrency to 6. Second:
check whether your p95 request is genuinely 128K, because it almost certainly
is not.

</details>

</div>

<div class="exercise">

**Exercise 2.** DeepSeek-V3 (671B total, 37B active, 61 layers, MLA latent 576
→ ~70 KB/token) in FP8, on a node of 8 × H100. Does it fit, and what is the
concurrency at a 32K working context?

<details>
<summary>Reveal answer</summary>

HBM: `8 × 80 = 640 GB`. Weights at FP8: `671e9 × 1 = 671 GB`. **It does not
fit** — you are 31 GB over before a single KV block, and that is with zero
pool. One node is not enough; this is a two-node (or NVL72-domain) deployment,
which is exactly why MoE serving is a [rack-scale problem](#/moe-serving).

On two nodes (1,280 GB): `1280 − 671 − 24 (overhead) − 8 = 577 GB` raw, ≈519 GB
pool. MLA costs `70 KB × 32,768 = 2.29 GB` per sequence, so
`519 / 2.29 ≈ 226` concurrent sequences. Note the shape: the weights are
brutal and the *cache is nearly free* — MLA is why a 671B model can hold
hundreds of long conversations. Compare with GQA-70B's 328 KB/token, which
would have given 69.

</details>

</div>

<div class="exercise">

**Exercise 3.** On the row-6 configuration (2 × H100, FP8 weights, FP8 KV, 8K
working context, ~55 concurrent), your traffic shifts to a reasoning model
whose average live sequence grows from 8K to 24K tokens. Request rate is
unchanged. What happens?

<details>
<summary>Reveal answer</summary>

Per-sequence KV triples: `164 KB × 24,576 ≈ 4.03 GB`. Concurrency falls to
`74 / 4.03 ≈ 18`.

But the request rate did not change and each request now *lives ~3× longer*
(it emits ~3× more tokens at roughly the same TPOT). By Little's law the
concurrency you **need** rose ~3× at the same time your capacity fell ~3× — a
~9× shortfall. The queue does not degrade gracefully; it explodes. This is why
"we switched to a reasoning model" is an infrastructure event and not a
prompt change.

</details>

</div>

<div class="exercise">

**Exercise 4.** A different card and a different model card. Qwen3-32B — 64
layers, 8 KV heads, head_dim 128, ~32B parameters — on **2 × L40S 48GB**,
PCIe-connected, TP=2. Work the five-term budget in BF16 at a 32K context, then
apply the levers, then say whether the deployment is any good.

<details>
<summary>Reveal answer</summary>

**Term by term, BF16, 32K context.**

```text
  HBM_total   2 × 48 GB       =  96 GB
− weights     32e9 × 2 bytes  =  64 GB     (32 GB per GPU under TP=2)
− overhead    ~3 GB × 2 GPUs  =   6 GB
− activations ~1 GB × 2       =   2 GB
                                ───────
  raw KV pool                     24 GB
× 0.90 headroom               ≈  21.6 GB usable
```

KV per token: `2 × 64 × 8 × 128 × 2 = 262,144` bytes — **262 KB/token**,
noticeably worse than the 70B's 328 KB relative to model size, because Qwen3-32B
carries 64 layers of GQA-8 on a much smaller parameter count. One 32K sequence
therefore costs `262 KB × 32,768 = 8.59 GB`, and

```text
21.6 / 8.59 ≈ 2.5   →   2 concurrent 32K sequences
```

**Two.** Same shape of failure as the 70B-on-2×H100 case: the weights "fit" in
96 GB and the pool is the crumbs.

**The levers.** The L40S is Ada, so it *does* have FP8 tensor cores (unlike the
A100). FP8 weights take the weights to 32 GB:

```text
96 − 32 − 6 − 2 = 56 GB raw  →  ×0.90 ≈ 50.4 GB pool
```

FP8 KV halves the denominator to 131 KB/token, or 4.29 GB per 32K sequence:

```text
50.4 / 4.29 ≈ 11.7   →   11 concurrent
```

And right-sizing to a measured 8K p95 live context — `131 KB × 8192 = 1.07 GB`:

```text
50.4 / 1.07 ≈ 47 concurrent
```

**The verdict, which is the point of the exercise.** Compare 47 against this
card's `B_crit`. The L40S ridge is `362 TF ÷ 0.86 TB/s ≈ 421` FLOP/byte, so
`B_crit` is ~421 in BF16 and **~210 with FP8 weights**. You land at 47 against
210: comprehensively **KV-bound**, paying for compute you can never batch your
way up to — which is the L40S trap from
[Choosing: Model, GPU, Framework](#/choosing-model-gpu-framework) arriving
through the memory budget rather than the spec sheet.

Then the fabric. TP=2 here is two all-reduces per layer across **64 layers**
over PCIe, not NVLink — one to two orders of magnitude less bandwidth than the
900 GB/s the 20–30% all-reduce estimate assumed. The capacity arithmetic above
is real; the latency you get for it is not comparable.

For contrast, run the same model on **one H100 80GB** in FP8:
`80 − 32 − 3 − 1 = 44 GB` raw, ≈39.6 GB pool, `39.6 / 1.07 ≈ 37` concurrent —
slightly *fewer* slots than the two L40S, on one card, with **no all-reduce at
all** and 3.9× the memory bandwidth feeding every one of those slots. Capacity
was never the interesting difference.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>Why not just set gpu_memory_utilization to 0.98 and take the extra 8%?</summary>

Because the terms you did not budget for live there. Fragmentation at the
allocator level, CUDA graph pools captured after startup, a transient spike in
activation memory when a large prefill chunk coincides with a full decode
batch, and the difference between the vendor's GB and the driver's GiB. At 0.98
these do not produce a graceful slowdown — they produce an out-of-memory abort
in the middle of a forward pass, taking every in-flight request with it. The
10% buys you the right to be a few percent wrong about the other four terms.

</details>

<details>
<summary>My model fits on one GPU. Is there ever a reason to use two anyway?</summary>

Yes, two. **Capacity:** TP=2 halves the weight bytes on each card, and every
gigabyte freed goes to the KV pool — often more than doubling concurrency,
since the pool is what is left after a large fixed cost. **Latency:** decode is
bandwidth-bound, so splitting the weights across two memory systems roughly
halves the bytes each GPU must stream per token. You pay two all-reduces per
layer for both benefits, which is a good trade on NVLink and a bad one over
PCIe.

</details>

<details>
<summary>Should I size for peak traffic or mean traffic?</summary>

Neither, exactly. Size a *replica* for the concurrency at which it hits your
TTFT and TPOT SLOs — that is a physics question with one answer. Then size the
*fleet* so that peak arrival rate divided by per-replica concurrency is
covered, which is a queueing question. Conflating the two produces the classic
failure of a fleet that is correctly sized in aggregate and made of replicas
that each thrash. [Operating It](#/operating-it) is where the fleet half of
this lives.

</details>

</div>

## What to remember

- **The budget is five terms:** weights + KV pool + activations + framework and
  CUDA overhead + headroom. Most sizing errors are the last three being assumed
  to be zero.
- **Overhead is 2–4 GB per GPU** [directional] and headroom is a real 5–10%,
  exposed as `gpu_memory_utilization`. A pool sized to 100% preempts.
- **Invert the budget:**
  `max_concurrency = (HBM − weights − overhead − activations − headroom) ÷ (kv_bytes_per_token × context)`,
  where `context` is the **p95 live context**, never `max_model_len`.
- **The worked case:** 70B BF16 on 2×H100 leaves ~11 GB of pool against 10.75 GB
  per 32K sequence — **one** concurrent user. FP8 weights → 6, FP8 KV → 13,
  4 GPUs → 13, real 8K context → 55, prefix caching → ~145.
- **The free levers beat the expensive one.** Right-sizing the context and
  turning on prefix caching moved concurrency further than doubling the GPU
  count, at zero hardware cost and zero accuracy cost.
- **Then sanity-check against `B_crit`** (~295 BF16, ~148 with FP8 weights on an
  H100): far below it means KV-bound and your FLOPs are decoration; far above
  means compute-bound and more pool buys nothing.
- **Traps:** sizing at max context; sizing for one sequence instead of the whole
  batch; forgetting the prefill chunk's activations; MoE total-vs-active; and
  treating TP purely as a capacity knob when it is also two all-reduces per
  layer.

```quiz
[
  {
    "q": "Llama-3-70B in BF16 (140 GB of weights) on two H100 80GB cards. Why is 'it fits in 160 GB' the wrong conclusion?",
    "choices": [
      "The weights are actually 160 GB once you count the embedding table",
      "After ~6 GB of framework/CUDA overhead, ~2 GB of activations and 10% headroom, only ~11 GB of KV pool remains — and one 32K sequence costs 10.75 GB, so the deployment serves one concurrent user",
      "Tensor parallelism requires an exact power-of-two split that 140 GB does not satisfy",
      "BF16 weights cannot be split across two GPUs without a copy on each"
    ],
    "answer": 1,
    "explain": "Fit is a five-term budget, not a two-term one. Weights (140) + overhead (~3 GB/GPU) + activations (~1 GB/GPU) + 10% headroom leave ~11 GB of block pool, and at 328 KB/token a single 32K sequence needs 10.75 GB. The deployment starts, passes its health check, and then preempts constantly under any real load."
  },
  {
    "q": "You are sizing an MoE model with 37B active and 671B total parameters. Which numbers go where?",
    "choices": [
      "671B for FLOPs and for memory — the whole model participates",
      "37B for FLOPs (2·P per token) and 671B for HBM capacity, because any expert may be routed to and so must stay resident",
      "37B for both; the unrouted experts can be paged in from host RAM on demand",
      "671B for FLOPs and 37B for memory"
    ],
    "answer": 1,
    "explain": "Only routed experts do arithmetic, so compute is 2 × 37B. But routing is decided per token at runtime, so every expert weight must already be in HBM — capacity needs all 671B. Sizing off the active count understates memory 18×, which is the difference between a deployment that starts and one that does not."
  },
  {
    "q": "On 2×H100 with FP8 weights and FP8 KV, moving from a 32K assumed context to a measured 8K p95 working context raised concurrency from 13 to 55. Why is this legitimate rather than a trick?",
    "choices": [
      "Because FP8 KV compresses long contexts more efficiently than short ones",
      "Because the block pool is paged: a sequence occupies blocks for the tokens it actually holds, not for the tokens max_model_len permits, so the pool should be sized on real live context",
      "Because the scheduler truncates any request longer than the p95",
      "Because prefix caching automatically shortens every request to 8K"
    ],
    "answer": 1,
    "explain": "PagedAttention removed max-length reservation: allocation is on demand, one block at a time. So pool sizing is driven by the distribution of live context lengths, not the window. Sizing at max_model_len re-introduces exactly the worst-case reservation that paging was invented to eliminate — and it is the most expensive single error in deployment sizing."
  },
  {
    "q": "Your sizing math gives max_concurrency = 20 on a GPU whose B_crit is ~148 (FP8 weights). What does that tell you?",
    "choices": [
      "The deployment is compute-bound; buy a GPU with more FLOPs",
      "The deployment is KV-bound: you can never batch up to the ridge, so you are paying for FLOPs you cannot reach — spend effort on KV quantization, working context, prefix caching or a cheaper attention architecture",
      "Nothing — B_crit and concurrency are unrelated quantities",
      "The headroom is set too high; lower it to 0.99 and concurrency will reach B_crit"
    ],
    "answer": 1,
    "explain": "max_concurrency is a capacity limit; B_crit is where decode would stop being memory-bound. Landing far below B_crit means the KV pool caps your batch long before compute does, so every added FLOP is wasted money. The productive levers all shrink the denominator (bytes per token, tokens per sequence, sequences that share a prefix) rather than adding compute."
  },
  {
    "q": "A deployment sized for an 8K average live context is switched to a reasoning model that averages 24K, at an unchanged request rate. Why is the damage worse than 3×?",
    "choices": [
      "Reasoning models have three times as many parameters",
      "Per-sequence KV triples so capacity falls ~3×, while each request also lives ~3× longer (3× the output tokens at the same TPOT), so by Little's law the required concurrency rises ~3× at the same time — roughly a 9× shortfall",
      "The attention kernel becomes quadratic above 16K tokens",
      "FP8 KV cache becomes numerically unstable past 16K tokens"
    ],
    "answer": 1,
    "explain": "Two independent multipliers compound. Capacity: concurrency = pool ÷ (bytes/token × context), so 3× context is 3× less concurrency. Demand: Little's law says concurrency needed = arrival rate × holding time, and holding time scales with output length, so 3× more generated tokens needs 3× more slots. Supply down 3× and demand up 3× is a 9× gap, which is why adopting a reasoning model is a capacity-planning event."
  }
]
```
