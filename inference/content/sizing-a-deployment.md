# Sizing a Deployment

> **The question:** given a model, a node and a traffic forecast, how many requests
> can the deployment hold at once — and can it still keep its latency promises with
> that many?
>
> **You'll be able to:** write a deployment's memory budget the way the engine
> computes it, and predict the two lines it prints at startup; check a concurrency
> against the step-time model, Little's law, its p95 and the loss of a replica; size
> Ask Halden's node from the brief, phase 1 and phase 2, and say what breaks first.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kv,runner"></div>

The addition fails in a specific way: the deployment *starts*. Weights load, a test
request comes back beautifully — and under real traffic it serves a handful of people
and preempts constantly, because only the weights were checked.

## The method

Three steps: the **budget** (the KV pool's memory), the **capacity** (sequences it
holds), the **service** (promises kept at that concurrency, even with a replica dead).
Most errors stop after the second.

### Step 1: the budget, as the engine computes it

In vLLM v0.34 the worker does this subtraction at startup, per GPU
(`vllm/v1/worker/utils.py`, `gpu_worker.py`):

```text
   requested  =  gpu_memory_utilization × total HBM
   KV pool    =  requested − weights − peak activations − non-torch memory − CUDA-graph memory
   headroom   =  total HBM − requested          (the engine never touches it)
```

- **Weights** = parameters × bytes, divided by the tensor-parallel degree: 140 GB in
  BF16 for Llama-3.3-70B, 70 GB in FP8. A mixture-of-experts model allocates its
  *total* parameters.
- **Activations**: the peak of a profiling forward pass at `--max-num-batched-tokens`
  tokens; the course budgets 1 GB per GPU. A larger token budget spends pool.
- **Overhead**: CUDA context, tensor-parallel buffers, workspaces, CUDA-graph pools; the
  course budgets 3 GB per GPU (the engine measures it).
- **Headroom** is `(1 − f) × HBM`, a fraction of the *whole* GPU — not a factor applied
  to what is left after the weights. At `0.90` on an 80 GB GPU, 8 GB per GPU stay
  outside the engine for fragmentation, other processes and whatever the profile missed.

> **State of play (November 2026):** vLLM v0.34.0 turned the extensible KV cache on by
> default: unset, `gpu_memory_utilization` is 1.0 and the pool is sized from memory
> actually free after warm-up. The release notes recommend dropping the flag and report a
> TPOT cost of 6–18% on some H200 models. The case keeps an explicit `0.90` for a
> predictable pool and step time.

> [!bridge] From the Linux course
> Linux overcommits address space and backs the bet with demand paging, reclaim and
> the OOM killer. The engine overcommits nothing; the budget is fixed before the first
> request. What differs is the KV pool: it *can* sit in front of a lower tier — the CPU
> offload of [The KV Fabric](#/the-kv-fabric) — but only through an explicit policy
> that moves whole blocks, never a transparent page fault.
> [→ Linux: Virtual Memory](../#/memory)

### Step 2: capacity

```text
                      KV pool − shared-prefix KV (stored once)
   max_concurrency =  ────────────────────────────────────────────
                      kv_bytes_per_token × unique live context
```

Live context is prompt plus output so far, at your p95 from logs — not `max_model_len`:
a paged pool holds blocks for tokens a sequence has.

### Step 3: service

Price the step at that concurrency with the case's one model ([Inference
Arithmetic](#/inference-arithmetic)): `step ≈ max(t_w, t_c) + t_kv`, at rung 4 of the
decode ladder — `t_w` ≈ 14 ms for 35 GB of weights per GPU, `t_c` ≈ 0.089 ms per token
in the step, and `t_kv` ≈ 29 ns per context token per sequence on a GPU holding 82 KB
of KV per token. Two consequences:

- **A full pool costs a fixed amount per step.** Every decoding sequence's KV is read
  every step: a full pool adds `pool per GPU ÷ 2.85 TB/s`, 33 GB → 11.6 ms. A shared
  prefix is still read once *per sequence* (vLLM v0.32 removed cascade attention, which
  read it once per batch).
- **The worst gap is the hybrid step.** A step carrying a 512-token prefill chunk costs
  `512 × 0.089 ≈ 45 ms` of arithmetic, ~50 ms with KV reads, and every stream waits.

Then demand. Little's law gives the *average* in the system, `L = λW`. With independent
arrivals and no queue the count is Poisson with mean `L`, so its p95 is roughly
`L + 1.65√L`: a mean of 6.5 exceeds 11 5% of the time. Correlated bursts need headroom
on top. Then repeat every check with one replica gone (N+1).

## Worked: a long-document service on two H100s

A team wants Llama-3.3-70B for contract review — 32K-token documents — on two H100s
(TP=2).

> [!predict] Before you read on
> In BF16 (140 GB of weights) the model fits in the pair's 160 GB. How many concurrent
> 32K-token sequences does the pool hold?

None: the engine refuses to start. It may use 0.90 × 160 = 144 GB; weights, overhead and
activations take 148. The weights fit the GPUs and not the budget. Now pull the levers
one at a time:

| # | Configuration | Pool | KV per sequence | Fits | Decode step, pool full |
|---|---|---|---|---|---|
| 1 | 2 × H100, BF16 weights + KV, 32K | −4 GB | 10.7 GB | does not start | — |
| 2 | + FP8 weights | 66 GB | 10.7 GB | 6 | 14 + 11.6 ≈ 26 ms |
| 3 | + FP8 KV | 66 GB | 5.4 GB | 12 | ≈ 26 ms |
| 4 | 4 × H100, BF16 weights + KV, 32K | 132 GB | 10.7 GB | 12 | ≈ 26 ms |
| 5 | 4 × H100, FP8 weights + KV, 32K | 202 GB | 5.4 GB | 37 | ~8 + 17.7 ≈ 26 ms |
| 6 | row 3, but **8K live** context | 66 GB | 1.34 GB | 49 | ≈ 26 ms |
| 7 | row 6, 5K of the 8K a **shared prefix** | 66 GB | 0.50 GB + 0.84 once | 129 | 14 + 30.5 ≈ 45 ms |

> [!predict] Before you read on
> Which moved concurrency more: doubling the GPUs (row 3 → row 5), or two facts about the
> traffic that cost no hardware (rows 6 and 7)?

The facts, by far: doubling the GPUs took 12 to 37; measuring the real context and
sharing the common prefix took 12 to 129. (Rows 3 and 4: two FP8 flags buy what
doubling the GPUs buys, with an accuracy risk.) Row 6 is not a setting — lowering
`--max-model-len` changes nothing, since the pool never reserved 32K. It is the traffic,
measured.

The last column is the service check. In rows 2–6 a full pool costs the same ~12 ms per
step. Row 7 pays for its capacity: 129 sequences each read the shared prefix every step,
30 ms of KV reads; add a hybrid step and the worst gap is ~75 ms. The best capacity in
the table is the first to break a 60 ms TPOT promise.

When row 3 starts, it prints the budget:

```plaintext
INFO … Available KV cache memory: 30.73 GiB
INFO … GPU KV cache size: 402,816 tokens, Maximum concurrency for 32,768 tokens per request: 12.29x
```

*Real format, illustrative values — message formats from vLLM v0.34.0 `vllm/v1/worker/gpu_worker.py` and `vllm/v1/core/kv_cache_utils.py`, logger prefix trimmed; numbers computed from the 80 × 10⁹-byte budget above, not measured.*

Reproduce both. The first is per GPU, in GiB: 33 × 10⁹ ÷ 2³⁰ = 30.73. The
second divides by one token's cost *on one GPU* — 164 KB of FP8 KV split by KV head
across two GPUs, 81,920 bytes: 402,832, rounded down to whole 64-token blocks. The
concurrency is that over `max_model_len`, 12.29: "how many requests of `max_model_len`
fit", the right question only for row 3. A real engine starts from the total the driver
reports, not 80 × 10⁹: redo the arithmetic from your own line.

<div class="inf-widget" data-widget="kv-calculator">
<p class="inf-widget-fallback">Interactive KV-cache and memory-fit calculator — needs JavaScript enabled.</p>
</div>

## Which wall first?

The first limit met as load rises:

- **Weight wall:** no pool (row 1). Quantize, add GPUs, or shrink the model.
- **KV wall:** the pool fills before the batch reaches the knee — ~160 tokens per step
  on the case's node (nameplate B_crit ~295; measure it). Every 70B row above: decode
  stays memory-bound. Levers: FP8 KV, real contexts, prefix sharing, offload.
- **Compute wall:** the batch reaches the knee first — Llama-3.1-8B in FP8 on one H100
  at 1K-token contexts holds ~900 sequences against the same ~160 knee. Cap the batch
  near the knee.
- **Latency wall:** what fits is too slow (row 7).
- **No wall:** demand sits far below all four; something else — a data rule,
  redundancy — sized the deployment.

## Ask Halden: your sizing

Every chapter recorded a decision for Ask Halden; now they must add up, and the sizing
is yours. You inherit:

- **Model and format:** Llama-3.3-70B-Instruct, FP8 weights and FP8 KV, gated on the
  evaluation of [Did Quantization Break Your Model?](#/did-quantization-break-your-model);
  fallback BF16 on one TP=4 replica.
- **Layout:** two TP=2 replicas on the four-GPU node, routed by conversation
  ([Parallelism for Inference](#/parallelism-for-inference)).
- **Engine** ([Anatomy of an Engine](#/anatomy-of-an-engine), [Continuous
  Batching](#/continuous-batching)): `--max-num-seqs 64`, a 512-token budget, prefix
  caching on with the 800-token system prompt shared; `--max-model-len` above ~21K once
  agents arrive.
- **Memory** ([Beyond Chat](#/beyond-chat)): in phase 1 the embedding model and reranker
  share GPU 0, so the LLM runs at `--gpu-memory-utilization 0.80`; in phase 2 they move
  off the node and it returns to `0.90`.
- **Phase 2:** CPU-memory KV offload ([The KV Fabric](#/the-kv-fabric)), no
  disaggregation. Speculation is a separate bet (Stage 4).
- **Traffic** ([The Agentic Era](#/agentic-serving)): phase 1 at 1.5 req/s, 3,000 tokens
  in (2,200 after the cache) and 250 out, `W` ≈ 4.3 s. Phase 2: 1.0 Q&A req/s plus 0.5
  agent req/s, ~80 s sessions, contexts averaging 11K of which 3K is a shared preamble,
  ~17K prefill tokens per agent request with caching (47K without), ~850 output tokens
  per agent request (three tool calls of ~200 and a 250-token answer).

<div class="exercise">

**Exercise 1 — the capstone.** Fill in the table for one replica, then open the stages
one at a time.

| per replica (FP8, TP=2) | Phase 1 | Phase 2 |
|---|---|---|
| KV pool, and the two startup lines | | |
| Live at peak: mean and p95 | | |
| KV needed, shared prefixes once | | |
| Prefill load, share of capacity | | |
| Decode step, hybrid step, mean TPOT | | |
| With the other replica down | | |

<details>
<summary>Stage 1 — the budget</summary>

Phase 2: 0.90 × 160 = 144 GB requested, minus 70 of weights, 6 of overhead and 2 of
activations: **66 GB** per replica, 33 GB per GPU, 132 GB on the node. Phase 1, with the
retrieval models on GPU 0: 0.80 × 160 − 78 = **50 GB** per replica, 100 GB on the node.
With `--max-model-len 24576` each phase-2 replica prints:

```plaintext
INFO … Available KV cache memory: 30.73 GiB
INFO … GPU KV cache size: 402,816 tokens, Maximum concurrency for 24,576 tokens per request: 16.39x
```

*Real format, illustrative values — message formats from vLLM v0.34.0 `vllm/v1/worker/gpu_worker.py` and `vllm/v1/core/kv_cache_utils.py`; computed from the case's budget, not measured.*

At 0.80 the first line would read 23.28 GiB. If you wrote 74 GB, you applied 0.90 to
what was left after the weights.

</details>

<details>
<summary>Stage 2 — concurrency against capacity</summary>

**Phase 1.** `L` = 1.5 × 4.3 ≈ 6.5 on the node, p95 ≈ 11; the case plans 20, ten per
replica. Each request holds 2,450 unique tokens × 164 KB ≈ 0.40 GB, plus the system
prompt once (0.13 GB): ten take ~4.1 GB, **8%** of the 50 GB pool. `--max-num-seqs 64` is
affordable: 64 × 3,250 × 164 KB ≈ 34 GB, so no phase-1 admission can preempt.

**Phase 2.** 0.5 × 80 ≈ 40 agent sessions on the node (p95 ≈ 51), twenty per replica.
Each holds 8K unique tokens (1.31 GB) behind the 3K preamble stored once (0.49 GB):
20 × 1.31 + 0.49 + ten Q&A requests (4.1 GB) ≈ **31 GB, 47%**; ~61 GB on the node,
~41 GB per replica at the p95 of sessions. Counting the preamble per session — row 7's
lesson ignored — gives 83 GB on the node. The cap of 64 no longer protects (64 agent
calls at 20K need 210 GB): the pool and offload tier do, and `vllm:num_preemptions` is
the alarm.

</details>

<details>
<summary>Stage 3 — step time at that concurrency</summary>

**Phase 1.** Prefill load: 0.75 req/s × 2,200 tokens ≈ 1,650 tokens/s against ~11,300
(1 ÷ 0.089 ms): **15%**. A decode step with ten sequences of ~3.1K: 14 + 10 × 3,100 ×
29 ns ≈ **15 ms**. A hybrid step: 512 × 0.089 ≈ 45 ms + 1 ≈ **46–50 ms**. About 3.3
hybrids per second among ~60 steps (5.5%): mean TPOT ≈ 17 ms, worst gaps ~50 ms, TTFT
≈ 0.25 s (five chunks).

**Phase 2.** Prefill: 0.25 × 17K + 0.5 × 2.2K ≈ 5,350 tokens/s per replica, **47%**.
Decode-only steps, ~8 sequences decoding at ~8K: 14 + 8 × 8,000 × 29 ns ≈ **16 ms**
(~21 ms if every live item decoded at once: 250K tokens × 29 ns = 7 ms). Hybrids
(~48 ms) run ~11 times a second and fill half of it: 27% of ~40 steps/s, mean TPOT ≈
**25 ms**. The worst gaps sit at ~50 ms — but a chunk deep in a 20K context does
attention work of its own, 4 × 8,192 × 80 × 17,000 ≈ 4.5 × 10¹⁰ FLOPs per token at 17K,
~32% on top of 1.4 × 10¹¹: that step is **~63 ms**.

</details>

<details>
<summary>Stage 4 — the verdict and the launch line</summary>

Phase 1 meets no wall: 8% of the pool, 15% of prefill. The node is sized by the data
rule and by redundancy, which [Hardware & Economics](#/hardware-and-economics) turns
into a cost. Phase 2 fits with margin on memory (47%) and prefill (47%); the per-request
TPOT promise holds; the worst single gaps touch 60 ms. Each replica:

```bash
# replica B: --device-ids 2,3 --port 8002
vllm serve RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
  --device-ids 0,1 --port 8001 \
  --tensor-parallel-size 2 --kv-cache-dtype fp8 \
  --gpu-memory-utilization 0.90 --max-model-len 24576 \
  --max-num-seqs 64 --max-num-batched-tokens 512 \
  --kv-offloading-size 128 --kv-offloading-backend native \
  --enable-auto-tool-choice --tool-call-parser llama3_json
```

*Real format, illustrative values — flag names from vLLM v0.34.0 `vllm/engine/arg_utils.py`, `vllm/config/cache.py` (`kv_offloading_size` is GiB summed across the TP ranks) and `vllm/entrypoints/common/cli_args.py`; values are the case's decisions, not a tested configuration.*

`--max-model-len 24576` (384 blocks of 64) admits the longest agent call — 20K tokens
of context plus its ~200 output tokens; anatomy's 16,384 would reject it.
128 GiB of host memory per replica holds ~840K FP8 tokens, about a hundred parked
sessions. Pin the engine version that carries the FP8-attention fix
([FlashAttention](#/flashattention)), and admit traffic only after the warm-up of
[Kernels and Compilation](#/kernels-and-compilation).

Speculation is not in the line: the EAGLE-3 head of [Speculative
Decoding](#/speculative-decoding) is a bet layered on this plan, on only if acceptance
reaches 1.5 tokens per round and an A/B at concurrency 20 wins. Then decode-only gaps
fall from ~16 to ~7 ms (α 0.7); hybrid steps, the worst gaps, do not move. The budget
leaves it out: each replica's 4.9 GB head would come out of its pool — in phase 2,
nearly all of the survivor's ~5 GB margin.

</details>

<details>
<summary>Stage 5 — what breaks first</summary>

Lose one replica at the phase-2 peak. Memory: the survivor needs ~61 GB of its 66 at the
mean, ~75 GB at the p95 of sessions, so parked sessions spill to its host tier and come
back in tens of milliseconds instead of a ~0.7 s recompute — what the offload tier is
for. Prefill breaks: the dead replica's sessions arrive with their cache lost, and with
parked sessions evicted the survivor faces ≈ 19.7K tokens/s of prefill against 11.3K —
174% of capacity, settling to 94% only once those sessions end. A queue in front of a
server at 94% is already long (`ρ ÷ 2(1 − ρ)` ≈ 8 service times of ~0.4 s); above 100%
it grows without bound. **TTFT breaks first**, then TPOT, as nearly every step becomes
hybrid. Degraded mode queues agent requests before it sheds chat, because a ticket can
wait and a person reading a screen should not ([When It Breaks](#/when-it-breaks)
writes the runbook).

The BF16 fallback is worse: one TP=4 replica with a 132 GB pool needs ~122 GB in phase 2
— 93%, any burst preempts — and has no redundancy at all. That trade is the strongest
argument for getting the FP8 evaluation right.

</details>

</div>

> [!case] The case: the plan, and its first failure
> Your table is the plan: two FP8 replicas carry phase 1 at 8% of their 50 GB
> pools and 15% of their prefill, phase 2 at about half of 66 GB and of prefill. The decision that
> could have gone the other way is the failure mode: one replica down at the phase-2
> peak leaves the survivor ~19.7K tokens/s of prefill against 11.3K, and TTFT p95
> breaks before memory.
> Halden accepts that risk for a two-hour window rather than rent a second node,
> queues agent work before it sheds chat, and pages on `vllm:num_requests_waiting`.

## Estimates against measurement

Every number in your table rests on constants — 40% MFU, 85% of nameplate bandwidth,
3 GB of overhead — nobody has measured on Halden's node. The plan is accepted when
[Load Testing](#/load-testing) replaces them: an open-loop sweep with the real prompt
shape to 1.5 req/s and beyond, TTFT p95 and TPOT p95 at each rate, the measured knee
next to the predicted ~3.3 req/s per replica. Little gave an average; the sweep shows the p95, and
running it with one replica stopped is the N+1 test.

> [!dashboard] Capacity against the plan
> **Utilisation:** `vllm:num_requests_running` per replica against the planned ten
> (twenty-plus in phase 2), and `vllm:kv_cache_usage_perc` against the 8% and 47%
> above. **Saturation:** `vllm:num_requests_waiting` and
> `vllm:request_queue_time_seconds` — the stage-5 failure shows here first.
> **Errors:** none as a metric — derive SLO misses from the buckets of
> `vllm:time_to_first_token_seconds` above 1.5 s and of
> `vllm:request_time_per_output_token_seconds` above 0.06 s; `vllm:num_preemptions`
> counts the admissions the pool could not honour.

## Exercises

<div class="exercise">

**Exercise 2 — find the flaw.** A colleague sizes a second service, Ask HR, on its own
two H100s: Llama-3.3-70B, FP8 weights and KV, TP=2. Prompts are 6,000 tokens, of which
2,000 are a fixed policy preamble; answers 300 tokens; 0.5 req/s at peak; `W` ≈ 5 s.
Find the errors before you open the answer.

```text
Ask HR: capacity memo (draft)
1. Pool = (160 − 70 − 6 − 2) × 0.90 = 73.8 GB.
2. KV per request = 6,300 tokens × 164 KB = 1.03 GB.
3. In flight at peak (Little): 0.5 × 5 = 2.5, so p95 concurrency is 3.
4. Capacity = 73.8 / 1.03 ≈ 71 requests: 24× the p95. Approve.
5. Decode step at that load: 14 ms + 3 × 6,300 × 29 ns ≈ 14.5 ms.
```

<details>
<summary>Reveal answer</summary>

1. **Wrong.** 0.90 applies to the whole GPU: 144 − 78 = **66 GB**.
2. **Wrong.** The 2,000-token preamble is stored once: 4,300 × 164 KB ≈ 0.70 GB per
   request plus 0.33 GB shared.
3. **Wrong.** Little gives the mean; the Poisson p95 of 2.5 is **5** — and an
   all-staff policy e-mail is not Poisson.
4. Recomputed: (66 − 0.33) ÷ 0.70 ≈ 93. The verdict survives — at this traffic.
5. Right in method, but use the p95 count: 14 + 5 × 6,300 × 29 ns ≈ 15 ms.

</details>

</div>

<div class="exercise">

**Exercise 3 — diagnosis.** Row 6's replica (~49 sequences of capacity) switches to a
reasoning variant of its model; arrivals are unchanged. Stats lines before and after:

```plaintext
INFO … Engine 000: Avg prompt throughput: 6000.0 tokens/s, Avg generation throughput: 1236.0 tokens/s, Running: 22 reqs, Waiting: 0 reqs, GPU KV cache usage: 32.8%, Prefix cache hit rate: 0.0%
INFO … Engine 000: Avg prompt throughput: 5150.0 tokens/s, Avg generation throughput: 661.0 tokens/s, Running: 17 reqs, Waiting: 49 reqs, Preemptions: 3, GPU KV cache usage: 99.2%, Prefix cache hit rate: 0.0%
```

*Real format, illustrative values — log format from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`, logger prefix trimmed; values computed from the step-time model and Little's law (2 req/s, 3,000-token prompts), not measured.*

What is binding, why did generation throughput fall, and what is the shortfall?

<details>
<summary>Reveal answer</summary>

KV: usage at 99%, a growing queue, preemptions — and Running *fell*. Reasoning output
grows live contexts to ~24K, 3.9 GB each: the pool holds ~17. Demand rose too: each
request lives ~3× longer, `L` = 2 × 33 s ≈ 66 against 17, a 4× shortfall, and the queue
grows without bound. Each step now reads 17 × 24K tokens of KV, 14 + 11.7 ≈ 26 ms for
17 tokens. (Prompt throughput includes recomputed preemptions.) A model change that
triples output length is a capacity event.

</details>

</div>

<div class="exercise">

**Exercise 4 — transfer.** DeepSeek-V3 in FP8: 684.5 B parameters on the hub (~688 GB
with its BF16 parts); `config.json` has 61 layers, `kv_lora_rank` 512 and
`qk_rope_head_dim` 64 — one 576-wide latent per token per layer (MLA). (a) Does it fit on one 8 × H100 node at 0.90? (b) On two nodes
with TP=16, how many 32K-token sequences fit?

<details>
<summary>Reveal answer</summary>

(a) 8 × 72 = 576 GB requested, below 688 of weights: **no**.
(b) 1,152 − 688 − 64 ≈ 400 GB of pool, 25 GB per GPU; KV per token in BF16 is 576 × 61
× 2 B = 70,272 B. The trap: a latent has no heads to divide, so vLLM v0.34 declares
MLA's cache with one KV head and no TP sharding (`mla_attention.py`) — every GPU holds
all 70 KB for every sequence. 25 GB ÷ (70,272 × 32,768) ≈ **10** sequences, not the
~170 that 400 GB suggests. The fix is data-parallel attention, which vLLM's docs
recommend for MLA models: each GPU keeps KV only for its own sequences.

</details>

</div>

## What to remember

- Pool = `f × HBM − weights − activations − overhead`; headroom is `(1 − f)` of the
  whole GPU; vLLM prints the pool per GPU, in GiB.
- `max_concurrency = (pool − shared prefix) ÷ (kv_bytes_per_token × unique live
  context)` — never `max_model_len`.
- What fits must also be served: a full pool adds `pool per GPU ÷ bandwidth` to every
  step, a shared prefix is read once per sequence, and a hybrid step is the worst gap.
- Little's law gives a mean; plan on its p95, on bursts beyond Poisson and on N+1.

```quiz
[
  {
    "q": "A 40 GB FP8 model runs on one H200 (141 GB) with --gpu-memory-utilization 0.85, 2 GB of overhead and 1 GB of activations. How large is the KV pool?",
    "choices": [
      "About 83 GB: 85% of what is left after weights and overhead",
      "About 98 GB: everything left after weights and overhead",
      "About 77 GB: 85% of the GPU, minus weights and overhead",
      "About 80 GB: 85% of the GPU, minus the weights alone"
    ],
    "answer": 2,
    "explain": "requested = 0.85 × 141 ≈ 119.9 GB; minus 40 + 2 + 1 = 76.9 GB. Applying 0.85 to the remainder (141 − 43 = 98 → 83 GB) is the classic error: the fraction is of the whole GPU, and the other 15% is headroom the engine never touches."
  },
  {
    "q": "You raise --max-num-batched-tokens from 512 to 8,192 on a replica and restart it. Which startup line changes, and which way?",
    "choices": [
      "Available KV cache memory falls: the profiling pass is larger",
      "GPU KV cache size rises: larger chunks fill blocks more completely",
      "Maximum concurrency rises: requests now prefill in fewer steps",
      "Neither: the token budget only affects scheduling, not memory"
    ],
    "answer": 0,
    "explain": "The engine sizes the pool after a profiling forward pass at max_num_batched_tokens; a 16× larger step has a larger activation peak, and that comes out of the pool. Chunk size does not change block packing, and the concurrency line is just tokens ÷ max_model_len."
  },
  {
    "q": "A replica's metrics: vllm:num_requests_running flat at 64, vllm:num_requests_waiting rising, vllm:kv_cache_usage_perc at 0.41, no preemptions. What is binding?",
    "choices": [
      "The KV pool, which is about to start preempting requests",
      "Prefill compute, which is queueing the long prompts",
      "The --max-num-seqs cap of 64, with memory to spare",
      "The HTTP server, which is dropping requests before admission"
    ],
    "answer": 2,
    "explain": "Running pinned at a round number while KV usage sits at 41% and nothing is preempted says an admission cap binds, not memory. A KV wall shows usage near 1 and preemptions; a prefill bottleneck shows long prefill times with running below the cap."
  },
  {
    "q": "Requests arrive independently at 0.8 per second and spend 10 s in the system. Roughly how many are in flight at the 95th percentile?",
    "choices": [
      "8, since Little's law gives the in-flight count directly",
      "13, the Poisson p95 around a mean of 8",
      "16, twice the mean as a standard burst allowance",
      "24, three times the mean to be safe"
    ],
    "answer": 1,
    "explain": "Little gives the mean, L = 0.8 × 10 = 8. With independent arrivals and no queueing the count is Poisson(8), whose 95th percentile is 13 (≈ 8 + 1.65 × √8). Doubling or tripling is a policy for correlated bursts, not the p95 of this traffic."
  },
  {
    "q": "A 70B FP8 replica on one Rubin GPU (19.2 TB/s nameplate, ~85% achievable) has a 200 GB KV pool. When the pool is full, how much do KV reads add to each decode step?",
    "choices": [
      "About 10.4 ms, the pool divided by nameplate bandwidth",
      "About 1.2 ms, since KV is read only for the newest token",
      "Nothing, since KV reads overlap with the weight read",
      "About 12.3 ms, the pool divided by achievable bandwidth"
    ],
    "answer": 3,
    "explain": "Every decoding sequence's KV is read every step: 200 GB ÷ (19.2 × 0.85 ≈ 16.3 TB/s) ≈ 12.3 ms. Nameplate gives the 10.4 ms floor, which no streaming read reaches. Attention reads the whole context, not one token, and the bytes add to the weight bytes rather than hiding behind them."
  }
]
```
