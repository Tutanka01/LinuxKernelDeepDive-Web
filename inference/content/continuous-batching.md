# Continuous Batching & Scheduling

> **The question:** requests arrive at random moments and finish at random
> lengths — how does a serving engine keep the batch full, and how does it stop
> one long prompt from freezing everyone else's stream?
>
> **You'll be able to:** explain why static batching wastes the GPU and what
> iteration-level scheduling changes; price a hybrid step and size a prefill
> chunk from a latency target; use Little's law, and its limits near
> saturation, to estimate how many requests the engine holds; read the
> scheduler's stats log and preemption metrics to tell a queue from memory
> pressure.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="scheduler,batch"></div>

[Inference Arithmetic](#/inference-arithmetic) ended with an offer that sounds
too good: below the critical batch size, each extra sequence in a decode step is
nearly free, because the step's cost is reading the weights and you read them
once regardless. Serve twenty users together and you get roughly twenty times the
throughput at almost the same per-token latency.

Collecting that offer is harder than it sounds. Requests do not arrive together.
They do not finish together either: one wants a three-token yes, another a
2,000-token report. Everything in this chapter is about the word *together*.

## Static batching runs at the speed of its slowest member

The first design anyone builds is **static** (or request-level) batching: gather
`B` requests, run them through the model step by step until *every* one has
finished, return them all, then start the next batch.

The flaw is that generation has no fixed length. Each sequence stops when the
model emits its end-of-sequence token, and that happens after very different
numbers of steps.

```text
  Static batching — 4 slots, the batch runs until ALL finish
  (■ = a step that produced a token for this request, □ = a slot that did nothing)

   R1  ■■■■■□□□□□□□□□□□□□□□□□□□   done after step 5
   R2  ■■■■■■■■■■■■□□□□□□□□□□□□   done after step 12
   R3  ■■■■■■■■□□□□□□□□□□□□□□□□   done after step 8
   R4  ■■■■■■■■■■■■■■■■■■■■■■■■   done after step 24
   R5  (arrives just before step 2) ... waits for the whole batch to drain
```

> [!predict] Before you read on
> In the diagram, what fraction of the 96 slots did useful work? And how many
> steps does R5 wait before its prompt is even looked at?

49 of 96 slots — about half. The other half are finished sequences still occupying
a place in the batch, paid for with weight reads that produce nothing for them.
R5 waits through steps 2 to 24, 23 steps, and its time to first token grows by
all of that for no computational reason. On real traffic, with output lengths
spread over two orders of magnitude, the waste is larger still.

## Iteration-level scheduling

The fix came from **Orca** (Yu et al.,
[OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu)): stop
treating the batch as a cohort. Schedule at the granularity of **one step**.
After every forward pass, the scheduler

- removes every sequence that just emitted end-of-sequence, returning it to its
  user immediately, and
- admits waiting requests into the freed slots for the very next step.

The batch becomes a revolving door whose membership changes every step. This is
**continuous batching** (NVIDIA's name for it is in-flight batching). Here are the
same four requests, plus two arrivals:

```text
  Continuous batching — same 4 slots, same request lengths
  (■ = produced a token in this step, ░ = waiting in the queue for a slot)

   step:  1  2  3  4  5  6  7  8  9 10 11 12
   R1     ■  ■  ■  ■  ■                         done after step 5
   R2     ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■    done after step 12
   R3     ■  ■  ■  ■  ■  ■  ■  ■                done after step 8
   R4     ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■ →  runs on to step 24
   R5        ░  ░  ░  ░  ■  ■  ■  ■  ■  ■  ■    arrives at 2, R1's slot at 6
   R6                    ░  ░  ░  ■  ■  ■  ■    arrives at 6, R3's slot at 9
```

R5 now waits 4 steps instead of 23, and no slot idles behind a finished
neighbour. This is the run queue from the Linux course: re-decide after every
tick, admit what became runnable, drop what exited. The difference is the
purpose. A CPU scheduler divides one core *between* tasks; this one packs
sequences *into the same* weight read — though each still reads its own KV cache,
a cost that grows with the batch.

### Selective batching

Orca's second idea makes the first one implementable. Most of a forward pass —
the attention projections and the MLP, the large matrix multiplies (**GEMMs**) —
treats each token independently, so tokens from different sequences stack into
one matrix and run as one multiply. Attention is the exception: each sequence
attends over its *own* KV cache, of its own length, at its own location in
memory. "Sequence A attends over 40 tokens, sequence B over 900" is not one
clean matrix multiply.

So engines batch what batches — the GEMMs, across every token in the step — and
handle attention apart. Orca ran it request by request. A modern engine launches
*one* attention kernel for the step, which walks each sequence's own list of
cache blocks at its own length ([the next chapter](#/paged-kv-cache) builds those
lists; [FlashAttention & Decode Kernels](#/flashattention) builds the kernel).

> **State of play (November 2026):** the widely cited "23×" comes from
> [Anyscale's June 2023 benchmark](https://www.anyscale.com/blog/continuous-batching-llm-inference),
> and it measured vLLM — continuous batching *plus* the paged memory of the next
> chapter — against naive static batching. Continuous batching alone (Ray Serve,
> TGI at the time) gave 8× in the same benchmark. Treat both as upper bounds from
> a favourable setup: the gain grows with the variance of output lengths and
> shrinks toward 1× when every request has the same length.

## How many requests are in the system?

Before going further, a number you need for any deployment: at a given arrival
rate, how many requests does the engine hold at once?

**Little's law** answers it for any stable queueing system: the average number in
the system equals the arrival rate times the average time each one spends there.

```text
   L  =  λ × W
   in the system  =  arrivals per second  ×  seconds per request
```

For an LLM server, `W` is TTFT plus `output_tokens × TPOT`: 2 requests per second
taking 5 seconds each means about 10 in the system. `L` is an **average** over
everything in the system — waiting as well as running. It is not the batch you
run on a given step, and not a p95.

It also hides how `W` behaves under load. A run queue is short until the CPU is
nearly always busy, then it is long; the same holds for any server of fixed
capacity:

```python
import random
random.seed(1)

def mean_wait(rho, n=200_000):
    """One server, fixed service time 1, Poisson arrivals at rate rho."""
    t = free_at = waited = 0.0
    for _ in range(n):
        t += random.expovariate(rho)          # next arrival
        start = max(t, free_at)               # queue if the server is busy
        waited += start - t
        free_at = start + 1.0
    return waited / n

for rho in (0.5, 0.7, 0.8, 0.9, 0.95):
    theory = rho / (2 * (1 - rho))            # M/D/1 mean wait
    print(f"utilisation {rho:.2f}: mean wait {mean_wait(rho):5.1f} "
          f"service times (theory {theory:5.1f})")
```

*Runnable — Python 3 standard library only; output shown is from an actual run.*

```plaintext
utilisation 0.50: mean wait   0.5 service times (theory   0.5)
utilisation 0.70: mean wait   1.2 service times (theory   1.2)
utilisation 0.80: mean wait   2.0 service times (theory   2.0)
utilisation 0.90: mean wait   4.1 service times (theory   4.5)
utilisation 0.95: mean wait   9.8 service times (theory   9.5)
```

*Runnable — output of the program above, pasted from a real run with `python3`.*

From 50% to 95% busy the wait grows twentyfold; at 100% it has no bound. An
engine is not this toy server, but it too has a ceiling on prefill per second. As
arrivals approach it, the queue term of `W` swallows everything else, and `L`
grows — in the waiting queue, not in the batch.

## Prefill interference: one long prompt stalls everyone

Continuous batching fixes the decode mismatch and exposes another. Not every step
is alike. Prefill pushes a whole prompt through the model in one compute-bound
pass; decode adds one token per sequence in a memory-bound pass. If a new
request's prefill is scheduled as one step, every sequence that is decoding waits
for it.

> [!predict] Before you read on
> Halden's node: Llama-3.3-70B on four H100s. Twenty users are streaming at
> ~16 ms per token. A request arrives with a **10,000-token** prompt. If its
> prefill runs as one step, how long do the twenty users see nothing?

About 0.9 seconds. Price the step with the course's one step-time model
(`case.md`, from [Inference Arithmetic](#/inference-arithmetic)):
`step ≈ max(t_w, t_c) + t_kv`, where `t_w` ≈ 14 ms is reading the weights once,
`t_c` is 0.089 ms of arithmetic per token in the step (40% of the node's peak
FLOP/s), and `t_kv` is the decoders' KV reads, ~1.7 ms for twenty 3,000-token
contexts.

```text
   tokens in the step  =  10,000 prompt + 20 decodes      =  10,020
   t_c                 =  10,020 × 0.089 ms               ≈  892 ms   ≫ t_w = 14 ms
   step                ≈  892 + 1.7                       ≈  0.89 s
```

(That ignores attention's own arithmetic, which grows with the square of the
prompt and adds ~9% at 10,000 tokens.) Every streaming user gets a single gap of
nearly a second — more than 50× their usual inter-token latency (**ITL**). Their
average TPOT barely moves, because it is one gap among hundreds; but the stream
visibly freezes. This interference was formalised by
**Sarathi-Serve** (Agrawal et al.,
[OSDI 2024](https://www.usenix.org/system/files/osdi24-agrawal.pdf)).

## Chunked prefill

A prefill does not have to run in one step. The prompt can be processed in
**chunks** over several steps, its KV cache growing chunk by chunk. Each step then
carries a **hybrid batch**: one chunk of prefill plus one decode token for every
running sequence.

A hybrid step is *not* priced as prefill time plus decode time. The chunk's
tokens and the decode tokens are rows of the same matrix multiplies; the weights
are read once for all of them, and the step costs whichever is larger, the read or
the arithmetic. A 512-token chunk with 20 decodes is 532 tokens: `t_c` ≈ 47 ms,
well above `t_w`, so the step is **~50 ms** with the KV reads — the decodes ride
along on arithmetic the chunk pays for anyway.

That also tells you how big a chunk is *free*. The step stays at the weight-read
floor while `t_c ≤ t_w`: up to `14 ÷ 0.089` ≈ **160 tokens per step**. That is
the effective knee of *this* node at the efficiencies the case assumes; the
nameplate ridge of ~295 (peak FLOP/s over peak bandwidth) is what the datasheet
promises, and no real step reaches peak. With twenty decodes in the step, a
chunk of ~140 tokens costs nothing; every token beyond adds 0.089 ms. Pricing one
3,000-token prompt at several chunk sizes:

```python
# Case step model: step = max(t_w, t_c) + t_kv  (case.md, rung 4)
T_W, T_C, T_KV = 14.0, 0.089, 29e-6   # ms; ms per token; ms per context token
DECODES, CTX, PROMPT = 20, 3000, 3000

def step_ms(chunk):
    return max(T_W, (chunk + DECODES) * T_C) + DECODES * CTX * T_KV

print("chunk  step_ms  steps  prefill_s")
for chunk in (64, 140, 256, 512, 1024, 3000):
    left, steps, total = PROMPT, 0, 0.0
    while left > 0:
        c = min(chunk, left)
        total += step_ms(c)
        left -= c
        steps += 1
    print(f"{chunk:5d}  {step_ms(chunk):7.1f}  {steps:5d}  {total / 1000:9.2f}")
```

*Runnable — Python 3 standard library only; output shown is from an actual run.*

```plaintext
chunk  step_ms  steps  prefill_s
   64     15.7     47       0.74
  140     16.0     22       0.35
  256     26.3     12       0.31
  512     49.1      6       0.29
 1024     94.7      3       0.28
 3000    270.5      1       0.27
```

*Runnable — output of the program above, pasted from a real run with `python3`.*

Above the knee, chunking is almost free for the long prompt: 512-token chunks
finish its prefill in 0.29 s against 0.27 s in one piece, while the streams' worst
gap falls from 270 ms to 49 ms. Below the knee it is expensive: 64-token chunks
each pay a full weight read for little work. The procedure: fix the ITL you are
willing to show, pick the largest chunk that stays under it, check it is not far
below the knee — then measure ITL p99 and TTFT with `vllm bench serve` at two or
three budgets ([Load Testing](#/load-testing) shows how).

Chunked prefill is on by default in vLLM v0.34. SGLang exposes the same knob as
`--chunked-prefill-size` (−1 disables it). The other answer to interference —
giving prefill and decode separate GPUs — is
[Disaggregated Serving](#/disaggregation).

## What the scheduler actually decides

vLLM's scheduler folds all of this into one abstraction: a **token budget** per
step (`--max-num-batched-tokens`; 8,192 by default for `vllm serve` on an
80 GB H100 in v0.34). A decoding sequence asks for one token; a prefilling one
asks for up to its next chunk. Here is what `schedule()` does each step,
condensed from `vllm/v1/core/sched/scheduler.py` at v0.34.0 (the real function
is 1,100 lines; this keeps the decisions and drops speculative decoding,
multimodal inputs and KV transfer):

```text
schedule():                                  # once per step, inside EngineCore
  budget = max_num_batched_tokens
  # 1. RUNNING requests first, in list order
  for req in running:
      n = min(tokens req still needs, budget)    # 1 for a decode, a chunk for a prefill
      while kv.allocate_slots(req, n) fails:     # not enough free blocks
          victim = running[-1]                   # fcfs: the request admitted last
                 # (priority policy: worst priority value, then latest arrival)
          preempt(victim)                        # free ALL its blocks, computed = 0,
                                                 # put it at the HEAD of the waiting queue
          if victim is req: break
      if req got no blocks: stop scheduling running requests
      schedule n tokens of req;  budget -= n
  # 2. WAITING requests — only if nobody was preempted in step 1
  while waiting and budget > 0 and len(running) < max_num_seqs:
      req = waiting.peek()                       # fcfs order, or priority order
      hit = prefix_cache.lookup(req)             # tokens already in cached blocks
      n = min(req.tokens - hit, budget)          # its first chunk
      if not kv.allocate_slots(req, n, full_sequence_must_fit=True):
          break                                  # the whole prompt must fit in free
                                                 # blocks now; future output is not reserved
      move req to running;  budget -= n
```

*Pseudocode condensed from vLLM v0.34.0 `vllm/v1/core/sched/scheduler.py`
(`schedule()`, `_preempt_request()`) and `vllm/v1/core/kv_cache_manager.py`
(`allocate_slots()`); not the code itself.*

Three decisions sit in there.

- **Admission is optimistic.** A new request is admitted when its whole prompt
  fits in free blocks right now (`scheduler_reserve_full_isl`, on by default);
  nothing is reserved for the tokens it will generate. `--max-num-seqs` caps how
  many run. A request blocked for another reason — no LoRA slot, a KV transfer in
  flight — is set aside as *deferred* and the next one tried.
- **Preemption is the backstop.** When a running request needs a block and none
  is free, the most recently admitted request loses *all* its blocks and goes back
  to the head of the queue, to be recomputed. There is no swap to CPU in v0.34.
- **Order is a policy.** `--scheduling-policy fcfs` (default) or `priority`,
  where each request carries a `priority` value, lower first. Priority reorders
  the waiting queue and picks preemption victims; it reserves no capacity and
  knows nothing about tenants. Fairness and load shedding between tenants live in
  the gateway — llm-d v1.0's flow control, Dynamo v1.6's policy queue
  ([The KV Fabric](#/the-kv-fabric)). The engine offers a valve:
  `--max-num-queued-reqs` and `--max-num-queued-tokens` make the API server answer
  HTTP 503 instead of queueing without bound.

> [!bridge] From the Linux course
> Preempt-by-recompute is page reclaim's choice. A dirty anonymous page must be
> written to swap, because nothing else can reproduce it; a clean file-backed page
> is dropped and re-read, because its bytes exist somewhere cheaper. A KV cache is
> the clean case — the engine still holds the tokens that produced it. What
> differs: re-reading a page costs one I/O, while rebuilding a KV cache costs a
> full prefill, which is why the next chapter's prefix cache matters so much here.
> [→ Linux: Virtual Memory](../#/memory)

Recompute is cheaper than it sounds once prefix caching is on: if the victim
shares a prompt prefix with requests still running, those blocks survive and only
its own tail is recomputed. The danger is **thrash**: under steady memory
pressure the same requests are admitted, grow, are preempted and recomputed,
and the GPU spends its time redoing prefills. You see it in the logs.

## Reading the scheduler's log

Every 10 seconds (`VLLM_LOG_STATS_INTERVAL`) the API server prints one line of
scheduler state. Look at four things: `Running` against your `--max-num-seqs`,
`Waiting`, `GPU KV cache usage`, and whether a `Preemptions` field appears at
all — it is printed only when the count for the interval is above zero.

```plaintext
(APIServer pid=2817) INFO 11-21 10:14:02 [loggers.py:335] Engine 000: Avg prompt throughput: 10412.6 tokens/s, Avg generation throughput: 412.0 tokens/s, Running: 52 reqs, Waiting: 0 reqs, GPU KV cache usage: 88.4%, Prefix cache hit rate: 61.2%
(APIServer pid=2817) INFO 11-21 10:14:12 [loggers.py:335] Engine 000: Avg prompt throughput: 10980.3 tokens/s, Avg generation throughput: 398.5 tokens/s, Running: 57 reqs, Waiting: 3 reqs, GPU KV cache usage: 96.9%, Prefix cache hit rate: 60.8%
(APIServer pid=2817) INFO 11-21 10:14:22 [loggers.py:335] Engine 000: Avg prompt throughput: 11104.9 tokens/s, Avg generation throughput: 351.2 tokens/s, Running: 58 reqs, Waiting: 9 reqs, Preemptions: 7, GPU KV cache usage: 99.6%, Prefix cache hit rate: 58.9%
(APIServer pid=2817) INFO 11-21 10:14:32 [loggers.py:335] Engine 000: Avg prompt throughput: 11130.0 tokens/s, Avg generation throughput: 322.7 tokens/s, Running: 55 reqs, Waiting: 17 reqs, Preemptions: 12, GPU KV cache usage: 99.8%, Prefix cache hit rate: 57.5%
```

*Real format, illustrative values — line format from vLLM v0.34.0
`vllm/v1/metrics/loggers.py` and `vllm/logger.py`; numbers constructed for Ask
Halden's phase-2 peak on the BF16 node, where the case puts the pool at 93% full
on paper and computed prefill at ~10.7K tokens/s, against a ceiling of ~11.2K
(1 ÷ 0.089 ms). Not measured.*

`Running` stops at 57–58, far below the default `--max-num-seqs`, while `Waiting`
climbs: the cap is not what binds. KV usage crosses 99% and `Preemptions`
appears: memory binds. The pair you might miss is throughput. *Prompt*
throughput keeps rising while *generation* throughput falls by a fifth — the
engine is re-prefilling the requests it just evicted. That is thrash.

The same story is on `/metrics`, where it can be graphed and alerted on
(counters gain `_total` when scraped):

```plaintext
vllm:num_requests_running{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 55.0
vllm:num_requests_waiting{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 17.0
vllm:num_requests_waiting_by_reason{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0",reason="capacity"} 17.0
vllm:num_requests_waiting_by_reason{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0",reason="deferred"} 0.0
vllm:kv_cache_usage_perc{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 0.998
vllm:num_preemptions_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 4212.0
vllm:request_num_preemptions_sum{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 4212.0
vllm:request_num_preemptions_count{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 31940.0
```

*Real format, illustrative values — metric names, types and labels from vLLM
v0.34.0 `vllm/v1/metrics/loggers.py`; values constructed for the same episode,
not measured.*

`waiting_by_reason` splits the queue: `capacity` means no room (budget,
`--max-num-seqs` or blocks), `deferred` means blocked on something else.
`vllm:request_num_preemptions` is a histogram over finished requests: `4212 /
31940` ≈ 0.13 preemptions per request since start; its buckets show whether a few
requests are preempted over and over. Alert on the *rate* of
`vllm:num_preemptions_total`, not its value.

> [!dashboard] The scheduler and its queue
> **Utilisation:** `vllm:num_requests_running` against `--max-num-seqs`;
> `vllm:iteration_tokens_total` (tokens per step) against `--max-num-batched-tokens`.
> **Saturation:** `vllm:num_requests_waiting` and
> `vllm:num_requests_waiting_by_reason`; `vllm:request_queue_time_seconds`.
> (`rate(vllm:num_preemptions_total)` is the KV pool saturating, not the queue.)
> **Errors:** `vllm:admission_rejections_total` (the 503s, only if queue limits are set).

## Watch the loop run

In the simulator, start on preset 1 and switch **batching** from Static to
Continuous: the grey finished slots refill on the next step and the queue drains.
Then take preset 2 — a 10,000-token prompt arriving every few seconds — and toggle
**chunked prefill** while watching the ITL meter. [Lab: Batching and the Prefix
Cache](#/lab-batching-and-cache) runs the same loop on your laptop.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

> [!case] The case: the morning peak
> Ask Halden at the peak: 1.5 requests per second, each 3,000 tokens in and 250
> out, on one four-GPU replica.
>
> - **In the system (Little's law):** `W` ≈ 0.3 s TTFT + 250 × 16 ms ≈ 4.3 s, so
>   `L` ≈ 1.5 × 4.3 ≈ **6–7** requests on average, queue included. Bursts and
>   slower steps push it higher; plan for **20**. Far below either knee for decode.
> - **Headroom:** each prefill costs ~0.27 s of the whole node and the decodes
>   mostly ride along, so prefill alone saturates the node near 1 ÷ 0.27 ≈ 3.7
>   requests/s — ~3 once decode's own cost counts. At 1.5 the node is half busy;
>   at ~2.7 (90%) queueing, not prefill, sets TTFT.
> - **Interference:** an unchunked 3,000-token prefill freezes every stream for
>   ~0.27 s. Each request decodes for ~4 s, while ~6 other prompts arrive, so each
>   answer would stutter six times. Average TPOT rises only ~6 ms: the 60 ms TPOT
>   promise would never notice.
>
> **What this settles:** chunked prefill stays on with a **512-token budget**.
> About 9 of the ~44 steps per second are ~50 ms hybrids, so mean TPOT is ~23 ms
> and p95 ITL ~50 ms, instead of 270 ms freezes, for 0.02 s more TTFT. The
> decision serves a promise Halden never wrote — smooth streaming. An ITL target
> below 50 ms would push the budget to ~256 (steps ~26 ms). And the next doubling
> of traffic needs a second replica, not a flag.

## Exercises

<div class="exercise">

**Exercise 1.** On Halden's node, with twenty decoders at 3,000-token contexts,
you want ITL never to exceed 40 ms while a long prompt is being prefilled. What
chunk size, and what `--max-num-batched-tokens`, should you set? What does it do
to the prefill time of an 8,000-token prompt compared with one step? And what
would a 128-token budget do to it?

<details>
<summary>Reveal answer</summary>

The step is `(C + 20) × 0.089 + 1.7 ≤ 40` ms, so `C + 20 ≤ 430`: a chunk of
**~410 tokens**, a budget of ~430 (round to 416 or 448 and measure).

One step for 8,000 tokens: `8,020 × 0.089 + 1.7` ≈ 0.72 s. Chunked: 19 steps of
~40 ms plus a short last one ≈ **0.78 s** — chunking costs the long prompt only
~0.06 s, because above the knee the work is the same and the decodes ride along.

A 128-token budget leaves 108 tokens of chunk: `128 × 0.089` = 11.4 ms is below
`t_w`, so every step costs the 14 ms weight read plus 1.7 ms, ~15.7 ms. That is
75 steps, ~1.2 s. Smoother than you need, and the long prompt pays 0.4 s for it:
a budget below the knee wastes weight reads.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team runs a 70B model on a node like Halden's for a
document-summarisation API (8,000-token prompts, 300-token answers). Their p95 TTFT went from 1.2 s to
19 s this week. Two consecutive stats lines from the busiest hour:

```plaintext
(APIServer pid=901) INFO 11-20 14:02:10 [loggers.py:335] Engine 000: Avg prompt throughput: 11021.4 tokens/s, Avg generation throughput: 409.8 tokens/s, Running: 14 reqs, Waiting: 41 reqs, GPU KV cache usage: 27.3%, Prefix cache hit rate: 2.1%
(APIServer pid=901) INFO 11-20 14:02:20 [loggers.py:335] Engine 000: Avg prompt throughput: 11009.8 tokens/s, Avg generation throughput: 412.2 tokens/s, Running: 14 reqs, Waiting: 46 reqs, GPU KV cache usage: 27.9%, Prefix cache hit rate: 2.0%
```

*Real format, illustrative values — format from vLLM v0.34.0
`vllm/v1/metrics/loggers.py`; numbers constructed for this exercise, not
measured.*

What is binding, what is not, and what do you do?

<details>
<summary>Reveal answer</summary>

Not memory: KV usage is under 30% and no `Preemptions` field appears. Not the
running cap: 14 is far below any `--max-num-seqs`. Prompt throughput is pinned at
~11,000 tokens/s — the node's prefill ceiling at ~0.089 ms per token — and
`Waiting` grows by 5 in 10 s: arrivals exceed what the node can prefill. This is
the queue of the simulation above at utilisation ≥ 1, so TTFT grows until traffic
falls. 11,000 tokens/s ÷ 8,000 tokens ≈ 1.4 requests/s is the most this node can
take.

Fixes: more prefill capacity (another replica); fewer tokens to prefill (a 2% hit
rate says no shared prefix — check the template); and `--max-num-queued-reqs`, so
a burst gets a fast 503 instead of a 19-second wait. A bigger token budget
changes nothing: the GPU is already busy.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Halden plans a nightly batch job on the same node:
5,000 contracts, 6,000 tokens in and 400 out each, all submitted at 02:00, while
Ask Halden still serves ~0.1 requests/s of night-shift users. Under FCFS, what
does a night-shift user's TTFT look like? What does `--scheduling-policy
priority` (users at priority 0, the batch at 10) change, and what does it not?

<details>
<summary>Reveal answer</summary>

Under FCFS a user's request joins the back of a queue of up to 5,000 contracts.
At the node's ~11,000 prefill tokens/s, the backlog is 30M tokens, about 45
minutes; the user waits behind whatever is still queued.

With priority, the user's request goes to the front of the waiting queue, and
once it runs, a block shortage preempts a contract (the worst priority value),
never the user. What it does not do: make room. Admission never preempts, so if
contracts fill the pool (~60 of them at 6,400 tokens) or `--max-num-seqs`, the
user waits for the next contract to finish — under a second here, since contracts
finish more than once a second — and then shares every step's budget with the
contracts still prefilling. TTFT goes from 45 minutes to around a second, not
to its daytime 0.3 s. A cleaner design also caps the batch job's concurrency at
the client, so the engine is never fully committed to it.

</details>

</div>

## What to remember

- Static batching holds a cohort until its longest member finishes; continuous
  batching reschedules every step and batches the GEMMs across sequences, while
  one attention kernel walks each sequence's own cache.
- Little's law gives the average number in the system, queue included. Near
  saturation the queue term dominates and grows without bound.
- A hybrid step costs `max(t_w, t_c) + t_kv`, not prefill plus decode. On
  Halden's node, ~160 tokens per step are free; beyond that each costs 0.089 ms.
- Choose the chunk from the ITL you will show, and keep it above the knee.
- vLLM v0.34 admits a request when its prompt fits now, reserves nothing for its
  output, and preempts the most recently admitted request by recompute when
  memory runs out.
- Preemption thrash reads as KV usage near 100%, `Preemptions` in the log, and
  generation throughput falling while prompt throughput rises.

```quiz
[
  {
    "q": "An 8B model on one H100: each decode step reads its weights in ~6 ms, and each token in a step costs ~0.04 ms of arithmetic at the MFU you expect. Thirty sequences are decoding. Roughly how large a prefill chunk can ride in each step at no extra cost?",
    "choices": [
      "About 120 tokens: the knee is ~150 tokens per step, minus the 30 decodes",
      "About 265 tokens: the H100's nameplate ridge of 295, minus the 30 decodes",
      "None at all: any prefill token in a decode step adds its full prefill cost",
      "About 4,000 tokens: an 8B model is small, so the GPU is mostly idle anyway"
    ],
    "answer": 0,
    "explain": "The step stays at the weight-read floor while tokens × 0.04 ms ≤ 6 ms, i.e. up to ~150 tokens per step; the 30 decodes use 30 of those. The nameplate ridge assumes peak FLOP/s, which no real step reaches, so the effective knee sits lower. Chunk tokens are not free beyond the knee, and a small model reaches its knee sooner, not later."
  },
  {
    "q": "A replica can prefill at most ~4 requests/s of its usual prompt shape. Traffic grows from 2 to 3.8 requests/s. What happens to mean TTFT?",
    "choices": [
      "It roughly doubles, in proportion to the arrival rate",
      "It grows far more than traffic did, because queueing delay explodes near saturation",
      "It is unchanged until the KV cache fills, since admission only checks memory, not compute",
      "It falls, because a fuller batch uses the GPU more efficiently per token"
    ],
    "answer": 1,
    "explain": "Utilisation goes from 0.5 to 0.95. For a server with a fixed capacity, mean wait grows roughly as ρ/(1−ρ): from about 1 to about 19 in those units, a factor of ~20, not ~2. Batching helps decode, but prefill is already compute-bound, so a fuller queue does not make it cheaper; memory need not be full for a queue to form."
  },
  {
    "q": "A server launched with --max-num-seqs 64 logs 'Running: 64 reqs, Waiting: 210 reqs, GPU KV cache usage: 31.0%' with no Preemptions field, line after line. What is binding?",
    "choices": [
      "KV memory: the waiting requests cannot get blocks for their prompts, so admission stalls",
      "Preemption thrash: requests keep cycling between running and waiting",
      "Prefill compute: the chunks cannot keep up with the arrival rate",
      "The running cap: 64 sequences run, memory is two-thirds free, nothing is evicted"
    ],
    "answer": 3,
    "explain": "Running sits exactly at --max-num-seqs while KV usage is 31% and no preemptions are logged, so the scheduler stops admitting because of the cap. Memory is not the limit, thrash would show a Preemptions field, and a prefill-bound engine would run fewer than its cap with prompt throughput pinned at the ceiling. Raising the cap (and checking TPOT) is the experiment."
  },
  {
    "q": "In vLLM v0.34 under the default fcfs policy, the KV pool is full and a running request needs a new block for its next token. What does the scheduler do?",
    "choices": [
      "Preempts the oldest running request, since it holds the most blocks and frees the most at once",
      "Swaps the least recently used request's blocks to CPU memory and copies them back when it is rescheduled",
      "Frees every block of the most recently admitted running request and requeues it at the head of the queue",
      "Skips this request for one step and waits for some other request to finish"
    ],
    "answer": 2,
    "explain": "The running loop pops the last request of the running list — the one admitted last — frees all its blocks, resets its computed tokens to zero and prepends it to the waiting queue, to be recomputed. V1 has no swap path. The request that needed the block is served first because it is older, which is what FCFS promises."
  },
  {
    "q": "Why can the decode tokens of 20 different sequences share one MLP matrix multiply, while attention needs per-sequence handling?",
    "choices": [
      "Attention is compute-bound in decode, so batching it would push the step past the knee",
      "Attention reads each sequence's own cached keys and values, of different lengths at different places",
      "Each request has its own attention weights, so their matrices cannot be stacked together in one multiply",
      "The MLP is cheap enough that batching it is only a convenience for the engine"
    ],
    "answer": 1,
    "explain": "The MLP applies the same weights to every token independently, so rows from any sequence stack. Attention combines a query with that sequence's own cache, whose length and location differ; one kernel can still serve the whole batch, but it must walk each sequence's block list. Attention weights are shared, and decode attention is memory-bound."
  }
]
```
