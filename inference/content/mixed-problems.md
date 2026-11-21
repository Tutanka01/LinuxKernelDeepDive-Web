# Mixed Problems, No Labels

Every exercise in the course sits under the chapter that teaches its method, so the
chapter has already told you which idea to use. Here it has not. Thirty problems
from every part of the course come in shuffled order, with no headings, and the
first step of each is the one the chapters did for you: deciding which constraint
binds and which idea applies.

Work on paper. Before you compute anything, write one line: the resource you think
binds (weights, KV pool, bandwidth, compute, queue, link, quality) and the chapter
whose idea you will use. Then work the numbers, then open the reveal. Each reveal
says what applied and how you could have recognised it, works the solution, and
links the chapters it draws on. Some problems need two of them at once.

Artifacts are in the formats the course taught — real field and metric names,
illustrative values — and some contain a line that looks alarming and is not the
cause. Case numbers are those of Ask Halden; the step-time model is
`step ≈ max(t_w, t_c) + t_kv`, and `--gpu-memory-utilization` is a fraction of a
GPU's total memory.

<div class="exercise">

**Problem 1.** A team must pick one GPU per replica for an internal assistant on
Llama-3.1-8B-Instruct in BF16 (16 GB of weights; 32 layers, 8 KV heads of 128).
Requests carry ~4,000 prompt tokens and ~300 output tokens, and about 20 are in
flight at the busy hour. Two offers cost the same per hour: one L40S (48 GB,
0.86 TB/s, 362 TFLOP/s dense BF16) or one A100 80GB (2.0 TB/s, 312 TFLOP/s dense
BF16). Which serves this traffic better, and by how much on TTFT, TPOT and
capacity? Would the answer change for a document classifier that sends 4,000
tokens and reads back one?

<details>
<summary>Reveal</summary>

**What applies.** The two phases have different ceilings: decode is priced by
bytes ÷ bandwidth, prefill by FLOPs ÷ FLOP/s, and capacity by the memory budget.
The cue is two chips whose FLOPs and bandwidth rank in opposite orders.

```text
                                    L40S                    A100 80GB
decode floor, batch 1               16 GB ÷ 0.86 = 18.6 ms  16 GB ÷ 2.0 = 8.0 ms
achievable read (85%), t_w          21.9 ms                 9.4 ms
KV read, 20 × 4,300 tokens × 131 KB = 11.3 GB per step
  t_kv                              15.4 ms                 6.6 ms
step with 20 in flight              ≈ 37 ms                 ≈ 16 ms
prefill, 4,000 tokens at 40% MFU    6.4e13 FLOPs × 1.066 (attention, T ÷ 61,000)
                                    0.47 s                  0.55 s
KV pool at 0.90, 4 GB non-KV        43.2 − 16 − 4 = 23 GB   72 − 16 − 4 = 52 GB
  requests of 4,300 tokens          41                      92
```

For the assistant, the A100: TPOT about 2.3× better (16 against 37 ms; t_c = 20 ×
0.11 ms stays under t_w on both) and twice the pool, for a TTFT 16% worse. The
L40S's ridge is 421 FLOP/byte: its extra FLOPs wait on a bus a third as wide. For
the classifier there is no decode, the work is all prefill, and the L40S is ~16%
faster (362 ÷ 312) with ample memory: the choice flips.

*Taught in:* [The GPU Mental Model](#/gpu-mental-model),
[Inference Arithmetic](#/inference-arithmetic),
[Choosing: Model, GPU, Framework](#/choosing-model-gpu-framework).

</details>

</div>

<div class="exercise">

**Problem 2.** Ask Halden, phase 2, two FP8 TP=2 replicas. A gateway migration
went live on Thursday; since then TTFT p95 at the morning peak has doubled. No
errors, agents still file tickets, `vllm:kv_cache_usage_perc` reads 0.14 and 0.15
on the two replicas, and the application dashboard shows "requests with a
prefix-cache hit: 100%". One agent session, as the gateway logged it:

```plaintext
call  upstream     usage
1     llm-a:8000   {"prompt_tokens":3500,"total_tokens":3700,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":2944}}
2     llm-b:8001   {"prompt_tokens":9000,"total_tokens":9200,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":2944}}
3     llm-a:8000   {"prompt_tokens":14500,"total_tokens":14700,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":3456}}
4     llm-b:8001   {"prompt_tokens":20000,"total_tokens":20250,"completion_tokens":250,"prompt_tokens_details":{"cached_tokens":8960}}
```

*Real format, illustrative values — `usage` fields from vLLM v0.34.0 `vllm/entrypoints/serve/engine/protocol.py` (`prompt_tokens_details` with `--enable-prompt-tokens-details`); the `upstream` column is the gateway's own log, invented; token counts computed from the case with 64-token blocks.*

What is wrong, which numbers prove it, and what does it cost the node?

<details>
<summary>Reveal</summary>

**What applies.** A prefix hits only on the replica that holds it; the cue is the
`cached_tokens` sequence, which should grow call by call.

With session affinity the four values would be 2,944, 3,456, 8,960, 14,464: each
call reuses the previous call's prompt, rounded down to 64-token blocks. Here call
2 reuses only the shared 3,000-token preamble (46 blocks), call 3 reuses call 1's
prompt and call 4 call 2's. Every call hits the call *before last*: the calls
alternate between replicas, so the new gateway balances request by request and
has lost the affinity the case decided on.

```text
computed prompt tokens per session
  sticky:       556 + 5,544 + 5,540 + 5,536   = 17,176
  alternating:  556 + 6,056 + 11,044 + 11,040 = 28,696   (1.67×)
node prefill at the peak, capacity ~22.6K tokens/s
  sticky:       0.5 × 17.2K + 1.0 × 2.2K ≈ 10.8K  (~47%)
  alternating:  0.5 × 28.7K + 1.0 × 2.2K ≈ 16.5K  (~73%)
```

A server's mean queue wait grows as ρ ÷ 2(1 − ρ): from 0.44 to 1.35 service times
between 47% and 73% load, about three times longer, which is the TTFT tail. The
token-weighted hit rate on the node falls from ~59% to ~37%, below the 50% at which
the case's `PrefixHitRateLow` alert pages. The 100% is a per-request rate: every
call hits the preamble, so it cannot see this. The low KV usage is normal — parked
sessions' blocks count as free. Fix: route by session again.

*Taught in:* [The Agentic Era](#/agentic-serving), [The KV Fabric](#/the-kv-fabric),
[PagedAttention & Prefix Caching](#/paged-kv-cache),
[How to Read a Number](#/how-to-read-a-number).

</details>

</div>

<div class="exercise">

**Problem 3.** A colleague's evaluation report for switching a support bot's KV
cache to FP8. Find the errors before opening the reveal.

```text
FP8 KV cache: evaluation (approved)
1. Setup: vLLM v0.34.0 for both runs, same attention backend
   (FLASH_ATTN, FlashAttention 3) per the startup logs.
2. 300 questions from the support set, temperature 0.7, one run per variant.
3. Accuracy 84.0% (BF16 KV) vs 83.3% (FP8 KV): -0.7 points, within noise,
   so there is no loss.
4. 18 answers changed (10 right->wrong, 8 wrong->right): 6% flips, under
   our 10% limit.
5. Needle-in-a-haystack at 4K tokens: 100% for both.
6. Deployment: --kv-cache-dtype fp8 --max-model-len 32768.
```

<details>
<summary>Reveal</summary>

**What applies.** The paired-evaluation method and the FP8-KV failure history; the
cue is a "no loss" verdict drawn from a small sample at a short context.

1. **Right.** Pinning engine and backend is what makes the comparison mean
   something.
2. **Wrong.** At temperature 0.7 with one run each, the 18 flips mix quantization
   with sampling noise, and there is no floor: run both at temperature 0 (or the
   production sampling with many seeds) and measure BF16 against BF16 under
   production concurrency.
3. **Wrong.** "Within noise" is not "no loss". With b = 10 and c = 8 the paired
   difference is −0.67 points with a standard error of √(18 − 4/300) ÷ 300 ≈ 1.4
   points: the 95% interval runs from −3.4 to +2.1. A 3-point loss is as consistent
   with the data as a gain; a gate of "interval above −2" fails. Resolving 2 points
   at a 6% flip rate takes ~1,200 paired questions.
4. **Unanchored.** A 10% limit means nothing without the flip floor.
5. **Wrong.** The Hopper FP8-KV failure grew with context and appeared near 100K
   tokens; a 4K needle cannot see a 32K deployment. Test at 32K on the deployed
   backend.

Also missing: generated tokens per answer against the baseline, and the scores
under the production output cap.

*Taught in:* [Did Quantization Break Your Model?](#/did-quantization-break-your-model).

</details>

</div>

<div class="exercise">

**Problem 4.** An eight-GPU H100 node will serve Qwen3-32B in BF16. From its
configuration:

```json
{
  …
  "head_dim": 128,
  …
  "hidden_size": 5120,
  …
  "intermediate_size": 25600,
  "max_position_embeddings": 40960,
  …
  "num_attention_heads": 64,
  "num_hidden_layers": 64,
  "num_key_value_heads": 8,
  …
  "torch_dtype": "bfloat16",
  …
}
```

*Verbatim — trimmed; `config.json` of Qwen/Qwen3-32B on Hugging Face (revision 9216db57, checked 2026-11-21). The Hub API counts 32,762,123,264 BF16 parameters.*

Option A is one TP=8 replica, option B four TP=2 replicas. Take the course's
all-reduce model (8 µs + 2(n − 1)/n × size ÷ 360 GB/s, two per layer), weights read
at 2.85 TB/s, 40% MFU, a 0.90 budget with ~4 GB per GPU of non-KV memory, and
conversations of ~4,100 tokens. Compare the batch-1 decode step, the number of
conversations the KV pools hold, decode throughput with every pool full, and the
prefill of a 4,096-token prompt. Which would you deploy for an interactive coding
assistant, and which for a high-volume summarisation API?

<details>
<summary>Reveal</summary>

**What applies.** Tensor parallelism buys latency and one large pool and pays in
all-reduces; data parallelism buys redundancy and pays a copy of the weights per
replica. The cue is a model that fits several ways on one node.

```text
                                   A: 1 × TP=8               B: 4 × TP=2
weights per GPU                    8.2 GB → 2.87 ms          32.8 GB → 11.5 ms
decode all-reduces (128, batch 1)  ~1.2 ms                   ~1.1 ms
batch-1 step (4,100-token context) 4.0 ms                    12.7 ms
KV per token per GPU               32 KB (1 of 8 heads)      128 KB (4 of 8)
KV pool                            576 − 65.5 − 32 = 478 GB  144 − 65.5 − 8 = 70.5 GB each
conversations of 4,100 tokens      445                       4 × 65 = 260
full pools: step, node tokens/s    34 ms, ~13,100            25 ms, ~10,400
prefill 4,096 tokens               85 ms + 27 ms all-reduce  339 ms + 16 ms
node prefill capacity              ~36,600 tokens/s          ~46,200 tokens/s
```

(At full pools the all-reduce of 445 sequences is 4.6 MB and adds 3.9 ms; it is
added outside the `max`, since it is communication, not arithmetic.) A stores the
weights once, so its pool is 1.7× larger and its TPOT floor a third of B's — the
coding assistant's choice. All-reduces add 32% to A's prefill and 5% to B's, and B
has four failure domains: for a summarisation API, whose work is mostly
prefill, B gives ~26% more prompt tokens per second and survives a GPU fault with
three replicas. B also has four prefix caches to route between. TP=8 is the
ceiling here: at TP=16 the 8 KV heads would be replicated.

*Taught in:* [Parallelism for Inference](#/parallelism-for-inference),
[Inference Arithmetic](#/inference-arithmetic),
[Sizing a Deployment](#/sizing-a-deployment).

</details>

</div>

<div class="exercise">

**Problem 5.** A ticket classifier runs Llama-3.2-1B-Instruct on one H100 under
vLLM v0.34: ~300-token prompts, `max_tokens: 1`. At 08:00 traffic rose from 120 to
250 requests per second, and since then the client's p95 latency is ~1.6 s instead
of ~60 ms. A five-minute window at 08:30:

```plaintext
increase(vllm:time_to_first_token_seconds_sum[5m])        63750
increase(vllm:time_to_first_token_seconds_count[5m])      75000
increase(vllm:request_queue_time_seconds_sum[5m])           450
increase(vllm:request_prefill_time_seconds_sum[5m])        1350
rate(process_cpu_seconds_total[5m])                       0.994
vllm:num_requests_running                                     4
vllm:num_requests_waiting                                     0
vllm:kv_cache_usage_perc                                   0.01
DCGM_FI_DEV_GPU_UTIL_RATIO{gpu="0"}                        0.97
DCGM_FI_PROF_TENSOR_UTIL_RATIO{gpu="0"}                    0.18
```

*Real format, illustrative values — vLLM names from v0.34.0 `vllm/v1/metrics/loggers.py`; `process_cpu_seconds_total` as exported by the API server process; DCGM names from dcgm-exporter 4.9.0; values invented for the problem.*

Where does the time go, what binds, and which two lines are tempting and wrong?

<details>
<summary>Reveal</summary>

**What applies.** TTFT splits into time before the engine, queue and prefill; the
cue is a GPU-side picture with no queue and a latency that grew anyway.

Per request: TTFT 0.85 s = queue 0.006 s + prefill 0.018 s + **0.826 s before the
engine saw it** — template, tokenization, HTTP, JSON in the API server. That
process uses 0.994 CPU-seconds per second: one core, saturated. At ~4 ms of CPU per
request, 120 req/s kept it half busy; 250 puts it near 100%, where a single server's
queue explodes. The two decoys: `DCGM_FI_DEV_GPU_UTIL_RATIO` 0.97 says only that a
kernel was running (the tensor pipes are 18% busy — 250 × 300 tokens × 2.5 GFLOP is
~19% of peak), and `num_requests_waiting` 0 says the engine's queue is empty because
the queue is in front of the engine.

Fix: more API server processes (`--api-server-count`, which v0.34 accepts), confirm
with `pidstat` that the `vllm serve` process sits at 100% of one core, and cut
per-request overhead at the client (the completions endpoint takes a list of
prompts). The GPU has room for twice the traffic.

*Taught in:* [Anatomy of a Serving Engine](#/anatomy-of-an-engine),
[Operating It](#/operating-it).

</details>

</div>

<div class="exercise">

**Problem 6.** A triage assistant runs Qwen3-32B in thinking mode on two H100s
(TP=2): TTFT ~0.4 s, ~25 ms per output token at load. Product asks for "advice
within 60 s for 90% of tickets". Logged `usage.completion_tokens_details.reasoning_tokens`
has a median of 1,400 and a p90 of 4,800. The team ran its paired harness on 1,500
real tickets at temperature 0, each budget against unlimited thinking (BF16-against-BF16
floor: 38 flips):

```plaintext
== thinking_token_budget 4000 vs unlimited ==
questions 1500   baseline 86.2%   candidate 86.0%
flips 41 (2.7%): right->wrong 22, wrong->right 19
paired difference -0.2% +/- 0.8% (95%)
McNemar exact p = 0.755
== thinking_token_budget 2000 vs unlimited ==
questions 1500   baseline 86.2%   candidate 84.9%
flips 76 (5.1%): right->wrong 48, wrong->right 28
paired difference -1.3% +/- 1.1% (95%)
McNemar exact p = 0.029
== thinking_token_budget 1000 vs unlimited ==
questions 1500   baseline 86.2%   candidate 80.7%
flips 137 (9.1%): right->wrong 110, wrong->right 27
paired difference -5.5% +/- 1.5% (95%)
McNemar exact p = 0.000
```

*Real format, illustrative values — the output format of the harness in Did Quantization Break Your Model?; `thinking_token_budget` is a vLLM v0.34.0 request field; counts invented, intervals and p-values computed from them.*

Which budget would you ship, and what number decides it?

<details>
<summary>Reveal</summary>

**What applies.** Thinking tokens are output tokens, and the promise a user feels
is time to first answer token; a budget is a model change and is judged paired
against a floor. The two pull in opposite directions here.

```text
time to first answer token = TTFT + reasoning tokens × TPOT
  unlimited, p90 4,800       0.4 + 4,800 × 0.025 = 120 s
  budget 4,000 (p90 capped)  0.4 + 4,000 × 0.025 = 100 s
  budget 2,000               ≤ 50 s
  largest budget meeting 60 s:  (60 − 0.4) ÷ 0.025 ≈ 2,380 tokens
```

The 4,000 budget costs nothing measurable (−0.2 ± 0.8, flips at the floor's level)
but misses the promise. The 2,000 budget meets it at a real cost: −1.3 points with
an interval that excludes zero, and flips at twice the floor. 1,000 is far worse.
So the decision is a product trade with its price on the table: ship 2,000 and
state "−1.3 points", or keep accuracy and change the promise — or move the boundary
itself, since it is (60 − TTFT) ÷ TPOT: a faster decode (speculation, a smaller
model) raises the affordable budget. The deciding numbers are the p90 of
`reasoning_tokens` on real traffic and the paired score at each budget.

*Taught in:* [The Agentic Era](#/agentic-serving),
[Where a Model Comes From](#/where-models-come-from),
[Did Quantization Break Your Model?](#/did-quantization-break-your-model).

</details>

</div>

<div class="exercise">

**Problem 7.** A colleague asks whether the company could run this model for a
coding agent:

```plaintext
- Language Model
    - Number of Parameters: 2.4T in total and 95B activated
    - Hidden Dimension: 8192
    - Number of Layers: 92
    - Hidden Layout: 23 × (3 × (Gated DeltaNet → MoE) → 1 × (Gated Attention → MoE))
    - Gated DeltaNet:
        - Number of Linear Attention Heads: 128 for V and 16 for QK
        - Head Dimension: 128
    - Gated Attention:
        - Number of Attention Heads: 64 for Q and 4 for KV
        - Head Dimension: 256
…
- Context Length: 262,144 natively and extensible up to 1,010,000 tokens.
…
> Qwen3.8-2.4T-A95B is a text-only model that requires thinking mode for all interactions. Multimodal inputs are not supported, and thinking cannot be disabled.
```

*Verbatim — trimmed; model card (`README.md`) of Qwen/Qwen3.8-2.4T-A95B on Hugging Face (revision 4f885e51, checked 2026-11-21). The Hub API counts 2,446,182,725,504 parameters in its BF16 files; its `config.json` stores the linear-attention state in float32 (`mamba_ssm_dtype`), and its licence tag is `other` (`qwen3.8-max`).*

(a) How much memory do the weights need in BF16, in FP8 and in NVFP4, and which of
8 × H100, 8 × B200 (180 GB) or 8 × Rubin (288 GB) holds them at a 0.90 budget? (b)
Arithmetic per token, against Llama-3.3-70B? (c) Cache for one request of 4,000
prompt tokens, 3,000 thinking tokens and a 500-token answer? (d) Which two lines of
the card change the sizing, besides the parameter counts?

<details>
<summary>Reveal</summary>

**What applies.** Total parameters set memory, active ones arithmetic; a hybrid
model's cache counts only its attention layers per token and adds a fixed state per
sequence. The cue is a card with two parameter counts and two layer types.

```text
(a) weights   BF16 4.89 TB   FP8 2.45 TB   NVFP4 (4.5 bits) 1.38 TB
    budgets   8 × H100: 576 GB   8 × B200: 1,296 GB   8 × Rubin: 2,074 GB
(b) 2 × 95e9 = 190 GFLOP per token, against Llama's 140
(c) KV: 23 attention layers × 2 × 4 heads × 256 × 2 bytes = 94,208 B per token
         7,500 tokens → 0.71 GB
    state: 69 DeltaNet layers × 128 × 128 × 128 × 4 bytes = 8.4 MB each → 579 MB,
           plus ~8.5 MB of convolution state → ~0.59 GB per sequence
    total ≈ 1.3 GB, of which the fixed state equals ~6,200 tokens of KV
```

(a) Nothing fits eight H100s or eight B200s, even in NVFP4; eight Rubins hold the
NVFP4 copy (~1.38 TB of ~2.07 TB) and nothing larger — a whole node for one replica.
(b) More arithmetic per token than the dense 70B, although only 4% of the weights
are active: compute follows the 95B. (c) The fixed state is as large as the KV of a
6,000-token context, so short requests pay mostly for state. (d) "Thinking cannot be
disabled": every answer carries a reasoning chain, so decode steps, KV time and cost
per request multiply by however long it thinks — measure `reasoning_tokens` before
sizing anything. And the licence is not a standard one: read it before the first
estimate.

*Taught in:* [Reading a Model Card](#/reading-a-model-card),
[Quantization](#/quantization), [Serving MoE at Scale](#/moe-serving),
[Attention Architectures for Serving](#/attention-for-serving).

</details>

</div>

<div class="exercise">

**Problem 8.** A postmortem for a summarisation API on a four-H100 node
(Llama-3.3-70B, BF16, TP=4, vLLM v0.34). Prompts are ~6,000 tokens. Find the errors.

```text
Impact     Tue 10:00-10:40: TTFT p95 4.1 s, TPOT p95 71 ms. No errors.
Trigger    Campaign traffic: 1.2 -> 2.0 req/s; answers grew from ~300 to ~900 tokens.
Cause      KV pool too small. Preempted sequences were swapped to CPU memory and the
           PCIe traffic slowed every step.
Fix        10:40: raised --gpu-memory-utilization 0.90 -> 0.99 on the running replica,
           no restart; preemptions stopped.
Analysis   Little's law gives 20 requests in flight; --max-num-seqs 64 is three times
           that, so admission was not a factor.
Action     Alert when vllm:kv_cache_usage_perc > 0.9 for 5 minutes.
```

<details>
<summary>Reveal</summary>

**What applies.** How vLLM v0.34 admits and preempts, what a launch flag is, and
Little's law with the numbers of the day; the cue is a fix that cannot have
happened as written.

1. **Cause, wrong mechanism.** v0.34 preempts by recomputation; there is no swap to
   CPU. The cost was re-prefilling evicted requests, visible as prompt throughput
   rising while generation fell, `Preemptions:` in the stats log.
2. **Fix, impossible as written.** `--gpu-memory-utilization` is a launch flag:
   changing it restarts the engine — minutes of outage and a cold prefix cache. It
   also added only 0.09 × 80 = 7.2 GB per GPU and left 0.8 GB of headroom. The
   preemptions most likely stopped because the restart emptied the engine as the
   campaign wave passed.
3. **Analysis, stale and averaged.** With the day's numbers W ≈ 0.6 s + 900 × ~30 ms
   ≈ 27.6 s, so L ≈ 2.0 × 27.6 ≈ 55 on average, p95 ≈ 55 + 1.65√55 ≈ 67 — above the
   cap of 64. And the cap does not protect the pool: admission reserves nothing for
   output. Fifty-five live requests of ~6,450 tokens hold 55 × 2.1 GB ≈ 116 GB of
   the 132 GB pool; the p95 count needs ~142 GB. Preemption follows.
4. **Action, the wrong signal.** A busy pool runs at high usage without harm; the
   failure was preemption. Alert on sustained `rate(vllm:num_preemptions_total) > 0`,
   and on the TTFT and TPOT burn rates.

*Taught in:* [Continuous Batching & Scheduling](#/continuous-batching),
[Operating It](#/operating-it).

</details>

</div>

<div class="exercise">

**Problem 9.** A legal-research agent runs Qwen3-32B in BF16 (65.5 GB) at TP=2 on
two H100s, `--gpu-memory-utilization 0.90`. Sessions grow to ~60,000 tokens; tool
waits last about two minutes. At the peak 24 sessions are open: ~6 running (p95: 8),
the rest parked. The team can add `--kv-cache-dtype fp8`, a host-memory tier
(`--kv-offloading-size`), or both. Which, and what number decides?

<details>
<summary>Reveal</summary>

**What applies.** Two different problems that look like one: running sessions need
room in HBM; parked sessions need somewhere cheaper than recomputation. The cue is
the split between running and parked.

```text
pool: 0.90 × 160 − 65.5 − 8 = 70.5 GB
KV per 60K session:  BF16 60,000 × 262,144 B = 15.7 GB   FP8 7.9 GB
running sessions that fit:  BF16 4.5        FP8 9
parked (18):         BF16 283 GB            FP8 142 GB — no HBM holds either
recompute one session: 2 × 32.76e9 × 60,000 + attention (×1.96) at 7.9e14 FLOP/s ≈ 9.7 s
restore over two PCIe Gen5 links (~50 GB/s each): BF16 157 ms   FP8 79 ms
decode step, 6 running:  BF16 ≈ 23 ms       FP8 ≈ 15 ms
```

The host tier is needed in every case: 18 parked sessions do not fit any GPU, and
restoring one is ~60× cheaper than recomputing it. It must be larger than the pool
— 256 GiB or more, if the host has the RAM — because the connector mirrors blocks
as they complete. FP8 KV answers the other question: in BF16 only 4.5 sessions run
at once, below the 6 seen (and the p95 of 8), so the engine preempts and each victim
costs 9.7 s. In FP8, 9 fit. So: both, with FP8 conditional on its evaluation at
60K tokens on the deployed backend (needle and paired task set), because the FP8-KV
failure the course describes grew with context. If FP8 fails, the alternative is
more HBM — TP=4 gives ~206 GB of pool, 13 BF16 sessions — not a smaller cache. The
deciding number: the p95 of `vllm:num_requests_running` × KV per session against
the pool.

*Taught in:* [The KV Fabric](#/the-kv-fabric), [Quantization](#/quantization),
[Did Quantization Break Your Model?](#/did-quantization-break-your-model),
[Sizing a Deployment](#/sizing-a-deployment).

</details>

</div>

<div class="exercise">

**Problem 10.** A team serves google/gemma-4-26B-A4B-it (25.8B parameters, 3.8B
active; 30 layers, 128 experts per layer of three 2,816 × 704 matrices, top-8) in
BF16 on one H100. They predicted "3.8B active means 7.6 GB per step, ~2.7 ms at any
batch". Their concurrency sweep, short prompts:

```plaintext
$ grep -E 'concurrency|Output token throughput|Median TPOT' c1.txt c4.txt c16.txt c32.txt c64.txt
c1.txt:Maximum request concurrency:              1
c1.txt:Output token throughput (tok/s):          243.60
c1.txt:Median TPOT (ms):                         4.10
c4.txt:Maximum request concurrency:              4
c4.txt:Output token throughput (tok/s):          597.31
c4.txt:Median TPOT (ms):                         6.70
c16.txt:Maximum request concurrency:             16
c16.txt:Output token throughput (tok/s):         1193.85
c16.txt:Median TPOT (ms):                        13.40
c32.txt:Maximum request concurrency:             32
c32.txt:Output token throughput (tok/s):         1871.35
c32.txt:Median TPOT (ms):                        17.10
c64.txt:Maximum request concurrency:             64
c64.txt:Output token throughput (tok/s):         3386.24
c64.txt:Median TPOT (ms):                        18.90
```

*Real format, illustrative values — output lines of `vllm bench serve` from vLLM v0.34.0 `vllm/benchmarks/serve.py`; values computed from the estimate in the reveal plus ~1 ms of overhead, not measured.*

Explain the shape, and say what it means for this model against a dense 26B one.

<details>
<summary>Reveal</summary>

**What applies.** An MoE stores and, at batch, reads like its total; only its
arithmetic follows the active count. The cue is a TPOT that climbs with concurrency
far below any compute knee.

```text
experts: 3 × 2,816 × 704 × 128 × 30 = 22.8B parameters; everything else ≈ 3.0B
touched fraction ≈ 1 − (1 − 8/128)^B          bytes = 2 × (3.0B + f × 22.8B)
  B = 1    6%    8.8 GB    3.1 ms at 2.85 TB/s
  B = 4   23%   16.3 GB    5.7 ms
  B = 16  64%   35.3 GB   12.4 ms
  B = 32  87%   45.8 GB   16.1 ms
  B = 64  98%   50.9 GB   17.9 ms      (a dense 25.8B model: 18.1 ms at any batch)
rows per expert = B × 8 ÷ 128: 4 at batch 64 — still a matrix-vector product
```

The prediction priced bytes by the active count, which holds only at batch 1. Each
token picks its own 8 experts, so by batch 32 the step reads most of the model, and
by 64 nearly what a dense 26B model reads. The sweep follows the estimate within
~1 ms. Uniform routing is an upper bound; real routing is skewed and touches a
little less. What the MoE keeps is arithmetic — 7.6 GFLOP per token against ~52 — so
it wins at prefill and at batch 1, and decodes at high concurrency like a dense
model of its total size.

*Taught in:* [Serving MoE at Scale](#/moe-serving),
[Inference Arithmetic](#/inference-arithmetic).

</details>

</div>

<div class="exercise">

**Problem 11.** A vendor writes: *"Our appliance — one node, 8 × H100 SXM — serves
Llama-3.3-70B-Instruct in full BF16 precision at 420 tokens per second per user and
30,000 tokens per second in total, using all 1,979 TFLOPS of every GPU."* Find the
problems before opening the reveal.

<details>
<summary>Reveal</summary>

**What applies.** The bandwidth floor and the reading questions for any performance
claim; the cue is a per-user speed with no batch, model format or run attached.

1. **420 tokens/s per user in BF16 breaks the floor.** That is 2.4 ms per token. At
   TP=8 each GPU reads 140 ÷ 8 = 17.5 GB per step: 17.5 GB ÷ 3.35 TB/s = 5.2 ms at
   nameplate, before any all-reduce. One token per step cannot be faster. It needs
   fewer bytes (quantization — "full BF16" says no) or several tokens per step
   (speculative decoding). Ask which.
2. **The two numbers are not one run.** 30,000 ÷ 420 ≈ 71 users at 2.4 ms each; at
   batch 71 the weight read alone is still 5.2 ms per step, and speculation at
   71 × (γ + 1) verify tokens is past the knee. The per-user figure is from batch 1,
   the total from a deep batch — probably all requests sent at once.
3. **1,979 TFLOPS is the sparse BF16 figure** (or dense FP8). A dense BF16 model gets
   ~990, and decode uses a few percent of it anyway: "using all" of it cannot be
   true of a memory-bound phase.
4. **Which tokens?** "Total" may be input plus output; with long prompts that is
   most of it. Ask for output tokens per second against TPOT, at your prompt shape,
   with arrivals on a clock.

*Taught in:* [How to Read a Number](#/how-to-read-a-number),
[The GPU Mental Model](#/gpu-mental-model),
[Speculative Decoding](#/speculative-decoding).

</details>

</div>

<div class="exercise">

**Problem 12.** One H100 serves Llama-3.1-8B-Instruct in BF16 (hidden 4,096; 8 KV
heads of 128, so K and V projections are 1,024 wide; MLP 14,336; 32 layers) for
twelve departments, each with its own rank-32 LoRA adapter on all seven projection
matrices. Every request starts with the same 1,500-token policy prompt. (a) How big
is one adapter? (b) What must the launch line set, and what does
`--max-loras 8` reserve? (c) How many copies of the policy prompt does the prefix
cache hold, and what does that cost? (d) What happens when nine departments are busy
at once?

<details>
<summary>Reveal</summary>

**What applies.** An adapter adds r × (d_in + d_out) parameters per matrix; slots
are reserved at startup; the adapter is part of every block hash. The cue is many
adapters over one shared prefix.

```text
per layer Σ(d_in + d_out): q 8,192 + k 5,120 + v 5,120 + o 8,192
                           + gate 18,432 + up 18,432 + down 18,432 = 81,920
(a) 32 × 81,920 × 32 layers = 83.9M parameters = 168 MB in BF16
(b) 8 slots × 168 MB = 1.34 GB reserved = ~10,240 tokens of KV (131 KB each)
(c) 1,500 tokens → 23 full blocks = 1,472 tokens × 131 KB = 193 MB per copy
    12 copies = 2.3 GB, against 193 MB without adapters
```

(b) `--enable-lora --max-lora-rank 32`: the default cap is 16, and rank-32 adapters
would be refused. Eight slots take ~1.3 GB out of the ~52 GB pool, whether loaded
or not. (c) Each department hits only its own copy, and its first request after an
eviction recomputes 1,472 tokens (~60 ms); a request that runs on the base model
hits none of them. (d) `--max-loras 8` is how many adapters one batch can mix: the
ninth department's requests wait until a slot frees, with idle memory — raise the
slot count only as far as the pool allows.

*Taught in:* [Beyond Chat](#/beyond-chat),
[PagedAttention & Prefix Caching](#/paged-kv-cache).

</details>

</div>

<div class="exercise">

**Problem 13.** Ask Halden, phase 1, Wednesday. Users say answers "take longer to
start and come out slower". From the dashboards and the node:

```plaintext
                                                             replica A          replica B
                                                          Tue 10-11 Wed 10-11  Tue 10-11 Wed 10-11
increase(vllm:request_prompt_tokens_sum) / …_count           3,010     9,020     3,004     9,031
increase(vllm:time_to_first_token_seconds_sum) / …_count      0.21      0.77      0.21      0.78
increase(vllm:request_time_per_output_token_seconds_sum) / …  0.016     0.025     0.016     0.025
avg_over_time(vllm:num_requests_running[1h])                   3.1       5.3       3.2       5.3
increase(vllm:num_preemptions_total[1h])                         0         0         0         0

$ dmesg -T | grep -i xid
[Wed Nov 18 07:42:10 2026] NVRM: Xid (PCI:0000:5a:00): 63, …

$ nvidia-smi -q   (GPU 00000000:5A:00.0, replica B)
    ECC Errors
        Volatile
            DRAM Correctable                           : 7
            DRAM Uncorrectable                         : 0
    Remapped Rows
        Correctable Error                              : 1
        Uncorrectable Error                            : 0
        Pending                                        : Yes
        Remapping Failure Occurred                     : No

change log: Tue 18:00  retrieval-service 3.1  "top_k 4 -> 12 for better recall"
```

*Real format, illustrative values — vLLM metric names from v0.34.0 `vllm/v1/metrics/loggers.py`; the Xid line format and `nvidia-smi -q` fields as shown in When It Breaks; values computed from the case's step model, the rest invented.*

What binds, which artifact is the red herring, and what do you do?

<details>
<summary>Reveal</summary>

**What applies.** Read symptoms in pairs: TTFT and TPOT up together with zero
preemptions means prefill chunks riding more steps. The cue that rules out the
hardware is that both replicas moved identically.

Prompts tripled, 3,000 → 9,000 tokens: retrieval now returns ~8,000 more. Per
replica (0.75 req/s), uncached prefill rises from 2,200 to 8,200 tokens per request:

```text
                       hybrid steps/s   share of time in ~47 ms hybrids   mean TPOT   TTFT
3,000-token prompts         3.2                    15%                    ~16 ms     ~0.20 s
9,000-token prompts        12.0                    57%                    ~25 ms     ~0.76 s
decode-only step (14 ms + KV reads): 14.3 → 15.4 ms — the longer contexts add little
prefill load per replica: 15% → 54% of ~11.3K tokens/s
```

Both promises still hold (TTFT p95 ≤ 1.5 s, TPOT ≤ 60 ms), but the TTFT margin
nearly halved and the change broke a rule the case wrote in its first chapter: retrieved text is
capped at 4,000 tokens. The Xid 63 and pending remap concern one GPU of replica B;
A, with no event, shows the same numbers, and a pending remap does not slow a GPU.
The catalog's action is a reset at the next opportunity: book it off-peak with B
drained. Then restore the cap in the application and alert on
`usage.prompt_tokens` drifting from 3,000.

*Taught in:* [Operating It](#/operating-it), [When It Breaks](#/when-it-breaks),
[Continuous Batching & Scheduling](#/continuous-batching),
[What Actually Happens When You Call an LLM](#/what-is-inference).

</details>

</div>

<div class="exercise">

**Problem 14.** One H100 serves Llama-3.1-8B in BF16 for two kinds of traffic. By
day, a support chat: ~1,200-token prompts, ~300-token answers, ~12 requests in
flight on average (~18 at p95). By night, a batch of 400,000 summaries of the same
shape, run at a client concurrency of 256. An EAGLE-3 head is available (γ = 3,
draft cost c ≈ 0.05); on a shadow replay its first-position acceptance α was 0.7 on
chat and 0.5 on the summaries. Speculation on or off, for each? What would flip each
answer?

<details>
<summary>Reveal</summary>

**What applies.** Speculation trades idle arithmetic for tokens: free while
B·(γ + 1) stays under the knee, a loss beyond it unless acceptance is high or KV
reads dominate. The cue is one model at two very different batch sizes.

```text
this GPU: t_w = 16 GB ÷ 2.85 TB/s = 5.6 ms, t_c = 0.040 ms/token (knee ~140),
          t_kv = 46 ns per context token per sequence, contexts ~1,500 tokens
E = 1 + α + α² + α³:  α 0.7 → 2.53    α 0.5 → 1.88
chat, B ≈ 12:   plain 6.5 ms per token;  spec (48 verify tokens, under the knee) ≈ 2.7 ms
                — and B stays far below where speculation stops paying (~87 at α 0.5)
batch, B = 256: plain step 28.0 ms → 9,140 tokens/s
                spec at α 0.5: 1,024 verify tokens → 33.7 ms per token-step → 7,590 tokens/s
                break-even acceptance at B = 256: α ≈ 0.63
```

Chat: on — ~2.4× faster streams, and it would take a sevenfold rise in concurrency
at the worse acceptance to undo it. Night batch: off at α 0.5 — 17% less throughput,
~0.7 h more decode on the job. It flips if the summaries' acceptance rises above
~0.63, which a better-matched drafter or temperature 0 might give: measure it from
the per-position counters on the batch's own prompts. One configuration can serve
both: `num_speculative_tokens_per_batch_size` shortens or drops the draft above a
running count you choose.

*Taught in:* [Speculative Decoding](#/speculative-decoding),
[Inference Arithmetic](#/inference-arithmetic).

</details>

</div>

<div class="exercise">

**Problem 15.** zai-org/GLM-5.3 is a candidate for an 8-GPU node. From its
configuration and the Hub:

```json
  "architectures": [
    "GlmMoeDsaForCausalLM"
  ],
  …
  "kv_lora_rank": 512,
  …
  "n_routed_experts": 256,
  …
  "num_experts_per_tok": 8,
  "num_hidden_layers": 78,
  "num_key_value_heads": 64,
  …
  "qk_rope_head_dim": 64,
  …
  "quantization_config": {
    "activation_scheme": "dynamic",
    "fmt": "e4m3",
    "quant_method": "fp8",
    "weight_block_size": [
      128,
      128
    ],
    …
  },
```

*Verbatim — trimmed; `config.json` of zai-org/GLM-5.3 on Hugging Face (revision ba32f8c1, checked 2026-11-21). The Hub API counts 751,226,191,872 F8_E4M3, 2,103,729,152 BF16 and 19,456 F32 parameters.*

(a) Does it fit 8 × H100 or 8 × H200 at a 0.90 budget, with ~4 GB per GPU of
non-KV memory? (b) KV per token in BF16 (ignore the sparse-attention indexer's small
key)? (c) Under TP=8, how many 32,768-token sequences fit? (d) Under data-parallel
attention with expert parallelism, each GPU keeps only its own sequences' cache but
must also hold a full copy of everything that is not a routed expert — about 18 GB
more per GPU than under TP=8, estimated from the config's shapes. How many now?

<details>
<summary>Reveal</summary>

**What applies.** An MLA cache is one latent per token with no heads to shard, so
tensor parallelism replicates it on every GPU. The cue is `kv_lora_rank` in a config
that also says `num_key_value_heads` 64.

```text
(a) weights: 751.2 GB × 1 B + 2.1 GB × 2 B ≈ 755.4 GB
    8 × H100: 0.90 × 640 = 576 GB < 755 → no
    8 × H200: 0.90 × 1,128 = 1,015 GB → pool 1,015 − 755 − 32 ≈ 228 GB, 28.5 GB per GPU
(b) (512 + 64) × 78 layers × 2 B = 89,856 B ≈ 90 KB per token
(c) TP=8: every GPU holds every token's latent → 28.5e9 ÷ 89,856 ≈ 317K tokens
          on the whole node → 9 sequences of 32K
(d) DP attention: (28.5 − 18.4) GB = 10.1 GB per GPU, each its own sequences
          → 8 × 10.1e9 ÷ 89,856 ≈ 900K tokens → 27 sequences of 32K
```

Data-parallel attention triples capacity here, not the 8× the division suggests,
because each rank now replicates attention, shared experts, dense layers and
embeddings. It also needs a router that balances requests across eight ranks. The
real figure for (d) is the startup log's `Available KV cache memory` on the actual
deployment, and with FP8 KV (where the engine and model support it) both answers
double.

*Taught in:* [Attention Architectures for Serving](#/attention-for-serving),
[Serving MoE at Scale](#/moe-serving), [Sizing a Deployment](#/sizing-a-deployment).

</details>

</div>

<div class="exercise">

**Problem 16.** An internal Q&A service runs the case's FP8 TP=2 replica shape:
3,000-token prompts (800 cached), 250-token answers, chunked prefill. Last week
someone changed one launch flag "to speed up TTFT". Users now say the text
"stutters". The acceptance run at 1.5 req/s on one replica:

```plaintext
============ Serving Benchmark Result ============
Successful requests:                     2700
Failed requests:                         0
Request rate configured (RPS):           1.50
Benchmark duration (s):                  1803.52
Request throughput (req/s):              1.50
Output token throughput (tok/s):         374.27
Peak concurrent requests:                30.00
Total token throughput (tok/s):          4865.38
---------------Time to First Token----------------
Mean TTFT (ms):                          267.00
Median TTFT (ms):                        213.89
P95 TTFT (ms):                           452.97
P99 TTFT (ms):                           621.14
-----Time per Output Token (excl. 1st token)------
Mean TPOT (ms):                          19.74
P95 TPOT (ms):                           24.65
---------------Inter-token Latency----------------
Mean ITL (ms):                           19.74
Median ITL (ms):                         14.81
P95 ITL (ms):                            91.71
P99 ITL (ms):                            92.38
```

*Real format, illustrative values — labels from vLLM v0.34.0 `vllm/benchmarks/serve.py`, some lines trimmed; values from running the course's step model (Load Testing) on 1.5 req/s of Poisson arrivals with the changed setting — computed, not measured. Mean E2EL was 5,182 ms.*

Which flag changed, to what, and did it buy the TTFT it was meant to? Is "peak
concurrent 30" a problem for a plan of 20?

<details>
<summary>Reveal</summary>

**What applies.** ITL percentiles expose the hybrid step that TPOT averages away; a
hybrid step costs (chunk + decodes) × t_c + t_kv. The cue is a median ITL that is a
plain decode step and a p95 six times larger.

The median ITL, 14.8 ms, is a decode-only step (14 ms + KV reads). The p95, ~92 ms,
is a step carrying a prefill chunk: (B + ~8 decodes) × 0.089 ms + ~1 ms = 92 ms gives
B ≈ 1,000 — the token budget went from 512 to ~1,024. It bought nothing: the step
model at 512 gives a TTFT p95 of 0.44 s against 0.45 s here, because above the knee
a bigger chunk does the same prefill work in fewer, longer steps. It cost the
stutter: worst gaps of ~92 ms instead of ~47. TPOT p95 (24.7 ms) passes the 60 ms
promise and hides it. Revert to 512.

Peak concurrency is not a contradiction: Little's law gives the mean, 1.50 × 5.18 s
≈ 7.8 in flight, and the peak of a Poisson count sits far above it. The 20 in the
plan was always headroom over ~7. "Total token throughput" is 13× the output figure
because 92% of the tokens are prompt.

*Taught in:* [Load Testing](#/load-testing),
[Continuous Batching & Scheduling](#/continuous-batching).

</details>

</div>

<div class="exercise">

**Problem 17.** A cost memo for a document-Q&A bot. Find the errors.

```text
Self-host vs API (draft)
Traffic: 20,000 requests/day; 6,000 tokens in (incl. a 500-token system prompt),
         200 out.
API:     $0.20 per M input, $0.80 per M output, $0.02 per M cached input.
1. One H100 at $2.50/h = $1,825 a month.
2. Llama-3.1-8B (BF16) decodes ~2,700 tokens/s on it at batch 64 with 6K contexts.
3. $2.50 / (2,700 x 3,600) = $0.26 per M output tokens, against the API's $0.80:
   self-hosting is three times cheaper.
4. At our 10:00 peak the GPU runs at ~80% utilisation, so the real cost is
   ~$0.32 per M.
5. Input is cheap prefill on our side; it can be ignored.
```

<details>
<summary>Reveal</summary>

**What applies.** Cost per request from work-seconds and day-average utilisation,
with input counted. The cue is a per-output-token price for a workload that is 97%
input.

1. **Right** ($2.50 × 730 h).
2. **Right in method, wrong operating point.** The step model gives ~2,700 tokens/s
   at batch 64 — but 20,000 requests a day average 0.23 per second; this traffic
   never builds a batch of 64.
3. and 5. **Wrong: input dominates.** Each request computes 6,000 − 448 cached (seven
   full blocks of the system prompt) + 200 = 5,752 tokens at ~0.040 ms: 0.23 s of
   GPU. Pricing only output prices 3% of the tokens.
4. **Wrong utilisation.** Cost needs the day average, not the peak: 20,000 × 0.23 s
   ÷ 86,400 s = 5.4%.

```text
GPU: $60 per day         API: 20,000 × (6,000 × 0.20 + 200 × 0.80) ÷ 10⁶ ≈ $27 per day
u* = ($2.50 ÷ 3,600 × 0.23 s) ÷ $0.00136 ≈ 11.9%   against 5.4% actual
break-even ≈ $60 ÷ $0.00136 ≈ 44,000 requests a day at this shape
```

The API is ~2.2× cheaper today (a little more with its cached-input line). The
memo's verdict needs about twice the traffic. One more caveat it never mentions: the
API's model counts the same text in different tokens.

*Taught in:* [Hardware & Economics](#/hardware-and-economics),
[Choosing: Model, GPU, Framework](#/choosing-model-gpu-framework).

</details>

</div>

<div class="exercise">

**Problem 18.** Qwen3-32B in BF16 (config in Problem 4; 262,144 bytes of KV per
token) runs at TP=2 on two H100s. A 16,000-token prompt's cache has to be on another
replica for the next call. Compare: recomputing it there (40% MFU, attention
included); moving it over NVLink inside the node (~450 GB/s), one 400 Gb/s NIC
(~50 GB/s), 25 GbE (~3.1 GB/s); restoring it from host memory over the two GPUs'
PCIe links (~50 GB/s each); reading it from a shared NFS mount (~1 GB/s). Which media
beat recomputing, and what is the tie bandwidth per GPU?

<details>
<summary>Reveal</summary>

**What applies.** A cache is expensive to make and cheap to move: restore wins when
KV bytes per token ÷ bandwidth is below the time to recompute a token. The cue is a
choice of links for one cache.

```text
KV: 16,000 × 262,144 B = 4.19 GB
recompute: 2 × 32.76e9 × 16,000 = 1.05e15 FLOPs + attention
           (2 × 64 layers × 8,192 × 16,000² = 0.27e15, +26%) at 7.9e14 FLOP/s ≈ 1.66 s
move:  NVLink 9 ms   one NIC 84 ms   two NICs 42 ms   host over 2 × PCIe 42 ms
       25 GbE 1.35 s   NFS 4.2 s
tie, per GPU (half the KV per token): 131,072 B ÷ 82.7 µs ≈ 1.6 GB/s
       (1.3 GB/s once attention's extra work is counted at 16K)
```

Everything down to 25 GbE beats recomputing, though 25 GbE only just (~1.55 GB/s per
GPU when shared by two, at the tie); NFS at 1 GB/s loses. The ranking changes with
the use: as a fetch for a parked session, host memory at 42 ms is the obvious tier;
for a prefill/decode split with a 2 s TTFT budget, 25 GbE's 1.35 s on top of the
prefill blows it, while one NIC fits.

*Taught in:* [Disaggregated Serving](#/disaggregation), [The KV Fabric](#/the-kv-fabric).

</details>

</div>

<div class="exercise">

**Problem 19.** Ask Halden's phase-2 rollout restarts both FP8 TP=2 replicas from a
new deployment template. Their startup lines:

```plaintext
replica A:
(Worker_TP0 pid=3311) INFO 11-21 14:02:51 […] Available KV cache memory: 30.73 GiB
(EngineCore_DP0 pid=3190) INFO 11-21 14:02:52 […] GPU KV cache size: 402,816 tokens, Maximum concurrency for 24,576 tokens per request: 16.39x
replica B:
(Worker_TP0 pid=4410) INFO 11-21 14:09:13 […] Available KV cache memory: 30.73 GiB
(EngineCore_DP0 pid=4302) INFO 11-21 14:09:14 […] GPU KV cache size: 201,408 tokens, Maximum concurrency for 24,576 tokens per request: 8.20x
```

*Real format, illustrative values — message formats from vLLM v0.34.0 `vllm/v1/worker/gpu_worker.py` and `vllm/v1/core/kv_cache_utils.py`; numbers computed from the case's 33 GB per-GPU pool, not measured.*

A colleague posts: "B can only take 8 agent sessions!" What is actually wrong, how
much does it matter, and which number in the message is the misreading?

<details>
<summary>Reveal</summary>

**What applies.** The startup lines can be reproduced from bytes per token per GPU.
The cue is the same pool in GiB with half the tokens.

Both pools are 30.73 GiB = 33 GB per GPU. A: 33e9 ÷ 81,920 B → 6,294 blocks of 64 =
402,816 tokens — FP8 KV, 164 KB per token split over two GPUs. B: 33e9 ÷ 163,840 B →
3,147 blocks = 201,408 tokens — twice the bytes per token: B's cache is BF16. Its
line lacks `--kv-cache-dtype fp8`; the template dropped it.

"8.20x" is not sessions: it is how many requests of the full 24,576 tokens fit.
Sessions hold ~8K unique tokens behind a shared preamble. The real consequence is
worse than the colleague thinks, though: in BF16, phase 2's ~31 GB per replica
becomes ~62 GB of 66 (93%), and a failover onto B would need ~122 GB — impossible.
Fix the template, restart B outside 09:00–11:00, and add a startup check that the
token count equals the planned 402,816.

*Taught in:* [PagedAttention & Prefix Caching](#/paged-kv-cache),
[Quantization](#/quantization), [Sizing a Deployment](#/sizing-a-deployment).

</details>

</div>

<div class="exercise">

**Problem 20.** Four replicas of an 8B model (one H100 each, ~0.040 ms of prefill
arithmetic per token) serve a coding agent. A typical call carries ~12,000 tokens:
~4,000 of tool definitions and instructions shared by every session, ~7,000 of the
session's own history, ~1,000 new. Should the router send each call to the
least-loaded replica, or keep a session on one replica? What does each cost, and
what number would make you move a call anyway?

<details>
<summary>Reveal</summary>

**What applies.** Routing is cache management: a globally shared prefix is cached
everywhere and needs no affinity, a session's history lives on one replica. The cue
is a prompt made of a global part and a per-session part.

```text
least-loaded (history found on 1 replica in 4):
  computed per call ≈ 1,000 + 0.75 × 7,000 = 6,250 tokens → ~0.25 s, ~4 calls/s per GPU
sticky:
  computed per call ≈ 1,000 tokens → ~0.04 s, ~25 calls/s per GPU
the 4,000 shared tokens hit on every replica either way
```

Session affinity cuts prefill per call about six times. The force pulling the other
way is load: sessions are uneven, and a pinned replica can queue while others idle.
Move a call when its expected wait at the pinned replica exceeds the cost of
rebuilding its history elsewhere — ~7,000 × 0.040 ms ≈ 0.28 s plus attention.
SGLang's gateway encodes the same trade as thresholds (an imbalance of 32 requests
and 10%). The numbers to watch are per-call `cached_tokens` (does each call find its
history?) and per-replica running and waiting counts; exact KV events instead of a
router's guess remove the stale-cache misses after a restart.

*Taught in:* [The KV Fabric](#/the-kv-fabric), [The Agentic Era](#/agentic-serving).

</details>

</div>

<div class="exercise">

**Problem 21.** A colleague's launch line for a contract-review service on two
H100s, comments included. Find the errors.

```bash
vllm serve Qwen/Qwen3-32B \
  --tensor-parallel-size 2 \
  --max-model-len 131072 \          # reserves 128K tokens of KV for each request
  --gpu-memory-utilization 0.98 \   # 98% of what is left after the weights
  --kv-cache-dtype fp8 \            # halves the KV per token
  --max-num-seqs 256 \
  --enforce-eager                   # skips graph capture: faster restarts, nothing else changes
```

*Real format, illustrative values — flag names from vLLM v0.34.0 `vllm/engine/arg_utils.py`; the line and its comments are invented for the problem. Qwen3-32B's `config.json` is in Problem 4.*

<details>
<summary>Reveal</summary>

**What applies.** What each flag spends, and what the engine checks at startup. The
cue is a line whose comments explain the flags.

1. **`--max-model-len 131072` will not start.** The config declares
   `max_position_embeddings` 40,960, and vLLM v0.34 raises an error for a larger
   value unless `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1` is set — with a warning that RoPE
   positions past the derived length produce NaN. Longer contexts need the model's
   documented rope-scaling configuration and an evaluation at that length. The
   comment is wrong too: it is an admission limit, not a reservation.
2. **0.98 is a fraction of total memory**: 78.4 − 32.8 − 4 ≈ 41.6 GB of pool per GPU,
   and only 1.6 GB of headroom for anything the profile did not see.
3. **`--enforce-eager` changes more than restarts**: in v0.34 it also turns off
   compilation, so fused kernels and CUDA graphs both go — more kernels per step.
   A persistent compile cache is the way to faster restarts.
4. **The comments break the command**: a `#` after the line-continuation backslash
   ends the line, so the flags below the first comment are never passed.

`--kv-cache-dtype fp8` is right (then a 131K-token request still holds 17 GB — four
fit in the pool), but needs its long-context evaluation; `--max-num-seqs 256` is
only a cap and reserves nothing.

*Taught in:* [Anatomy of a Serving Engine](#/anatomy-of-an-engine),
[Sizing a Deployment](#/sizing-a-deployment),
[Kernels, Graphs & Compilation](#/kernels-and-compilation),
[Reading a Model Card](#/reading-a-model-card).

</details>

</div>

<div class="exercise">

**Problem 22.** A short-answer FAQ bot runs Llama-3.1-8B in BF16 on one H100
(prompts ~400 tokens, answers ~100). On Thursday an EAGLE-3 head was switched on with
`num_speculative_tokens` 4. Daytime concurrency is ~120.

```plaintext
                                                                   Wed (off)   Thu (on)
avg vllm:num_requests_running, 10:00-11:00                              121        118
Δ vllm:spec_decode_num_drafts_total                                       —    100,000
Δ vllm:spec_decode_num_draft_tokens_total                                 —    400,000
Δ vllm:spec_decode_num_accepted_tokens_total                              —    184,000
Δ vllm:spec_decode_num_accepted_tokens_per_pos_total{position="0"}       —     72,000
Δ …{position="1"}                                                          —     51,000
Δ …{position="2"}                                                          —     36,000
Δ …{position="3"}                                                          —     25,000
mean TPOT: Δ…request_time_per_output_token_seconds_sum / Δ…_count     8.6 ms    10.4 ms
```

*Real format, illustrative values — counter names and the `position` label from vLLM v0.34.0 `vllm/v1/spec_decode/metrics.py` and `loggers.py`; values computed from the step model, not measured.*

The team suspects the draft head. Are they right? What would you set?

<details>
<summary>Reveal</summary>

**What applies.** Verification puts B·(γ + 1) tokens in a step; past the knee it is
paid for. The cue is good acceptance and a worse TPOT at high concurrency.

Acceptance is healthy: 1 + 184,000 ÷ 100,000 = 2.84 tokens per round; per position
0.72, 0.51, 0.36, 0.25, conditionally 0.72, 0.71, 0.71, 0.69. (The 46% that
accepted ÷ drafted gives is not α.) The batch is the problem:

```text
t_w 5.6 ms, t_c 0.040 ms/token (knee ~140), contexts ~500 tokens
plain, B = 120:  max(5.6, 4.8) + 120 × 500 × 46 ns = 8.4 ms per token
γ = 4: 600 verify tokens → 24.2 + 2.8 + 4 × 0.05 × 8.4 = 28.6 ms per round ÷ 2.84 = 10.1 ms
γ = 2: 8.1 ms (1.03×)        γ = 1: 7.5 ms (1.12×)
at B = 20, γ = 4: ~2.6 ms per token against 6.1 — 2.4× faster
```

With short contexts there are no long KV reads to hold the crossover up: γ = 4 stops
paying near 91 concurrent sequences. Keep the head, and step the draft down with
concurrency (`num_speculative_tokens_per_batch_size`): γ = 4 at night, γ = 1 above
~90.

*Taught in:* [Speculative Decoding](#/speculative-decoding),
[Inference Arithmetic](#/inference-arithmetic).

</details>

</div>

<div class="exercise">

**Problem 23.** A four-H100 node will serve Llama-3.3-70B with ~3,000-token
contexts. Two quantized layouts are on the table: four single-GPU replicas of an
AWQ W4A16 checkpoint (40 GB of weights each, BF16 arithmetic), or two TP=2 replicas
of the FP8 checkpoint with FP8 KV in both cases. Which would you choose, and what
numbers decide it?

<details>
<summary>Reveal</summary>

**What applies.** Weight formats move t_w, arithmetic formats t_c, and the layout
moves the pool, the prefill rate and the failure domains; quality decides last. The
cue is two layouts with the same decode floor.

```text
                                   4 × W4A16, TP=1          2 × FP8, TP=2
t_w (weights read per GPU)         40 GB → ~14.3 ms         35 GB → ~14 ms
t_c per token in a step            0.354 ms (BF16, 1 GPU)   0.088 ms (FP8, 2 GPUs)
knee                               ~41 tokens               ~158 tokens
pool per replica (FP8 KV)          72 − 40 − 4 = 28 GB      66 GB
node step at concurrency 40        16.1 ms                  15.7 ms
                         160       21.2 ms                  20.9 ms
                         200       26.3 ms                  22.6 ms
prefill 3,000 tokens               1.06 s                   0.27 s
node prefill capacity              ~11.3K tokens/s          ~22.6K tokens/s
3K sequences the node holds        4 × 57 = 228             2 × 134 = 268
```

Decode is a tie up to ~160 sequences on the node, because both read about the same
bytes per GPU per step. What separates them is prefill: one GPU at BF16 rates takes
a second over a 3,000-token prompt, four times the FP8 replica, and the node's prompt
capacity halves. W4A16 buys four failure domains and no all-reduces; FP8 buys
latency headroom on TTFT, a higher knee and quality (AWQ 4-bit cost ~0.8 point at 70B
in the largest sweep; 8-bit nothing measurable). The numbers to fetch:
`vllm:request_prompt_tokens` (long prompts rule W4A16 out against a 1.5 s TTFT), the
peak of `vllm:num_requests_running`, and the paired evaluation of each checkpoint.

*Taught in:* [Quantization](#/quantization),
[Parallelism for Inference](#/parallelism-for-inference),
[Did Quantization Break Your Model?](#/did-quantization-break-your-model).

</details>

</div>

<div class="exercise">

**Problem 24.** A chat product runs Llama-3.1-8B in BF16 on one H100 at
`--gpu-memory-utilization 0.90` (52 GB of pool). Users want to paste whole
repositories, so the team plans to raise the admitted context from 8K to 64K tokens.
For a session at each length (prompt plus ~500 output tokens), compute TTFT on an
idle GPU at 40% MFU with attention included, KV per session, sessions the pool
holds, and the decode step with the pool full. Which wall moves?

<details>
<summary>Reveal</summary>

**What applies.** Context length changes three things at once: prefill arithmetic
(with a quadratic attention term), KV per session, and the KV read per step. The cue
is a context limit raised eightfold.

```text
                         8K prompt                       64K prompt
TTFT, idle               0.32 s × (1 + 8,000/61,000)     2.59 s × (1 + 64,000/61,000)
                         ≈ 0.37 s                        ≈ 5.3 s
KV per session           8,500 × 131 KB ≈ 1.1 GB         64,500 × 131 KB ≈ 8.5 GB
sessions in 52 GB        46                              6
decode step, pool full   5.6 + 46 × 8,250 × 46 ns        5.6 + 6 × 64,250 × 46 ns
                         ≈ 23 ms                         ≈ 23 ms
```

The decode step with a full pool is the same, ~23 ms, because a full pool is the
same bytes to read whatever the context: three quarters of each step is KV.
What moves is how many users share those bytes — 46 down to 6, so each long session
costs ~8× the GPU — and TTFT, 14× longer, half of it attention at 64K. The walls are
the KV pool and prefill compute, not decode speed. Size from real traffic: the p95
of `usage.prompt_tokens`, since most sessions will not be 64K; FP8 KV would double
the sessions at any length, after its evaluation.

*Taught in:* [Inference Arithmetic](#/inference-arithmetic),
[Attention Architectures for Serving](#/attention-for-serving),
[Sizing a Deployment](#/sizing-a-deployment).

</details>

</div>

<div class="exercise">

**Problem 25.** Four H100s serve an 8B chat model as two prefill and two decode
instances (NIXL, inside one node). On Monday the model was swapped for a reasoning
variant: answers went from ~300 to ~4,000 tokens, thinking included. Arrivals are
unchanged at ~3 req/s with ~1,000-token prompts. TTFT p95 went from 0.3 s to 40 s.

```plaintext
prefiller-0 log:
KV Transfer metrics: Num successful transfers=27, Avg xfer time (ms)=0.418,
P90 xfer time (ms)=0.507, Avg post time (ms)=0.651, P90 post time (ms)=0.792,
Avg MB per transfer=131.07, Throughput (MB/s)=313564.593, …,
Num failed transfers=0, Num KV expired reqs=17

prefiller-0 /metrics:
vllm:num_requests_running{…} 0.0
vllm:kv_cache_usage_perc{…} 0.71

decoder-0 and decoder-1 /metrics (both alike):
vllm:num_requests_running{…} 132.0
vllm:num_requests_waiting{…} 23.0
vllm:kv_cache_usage_perc{…} 0.99
rate(vllm:generation_tokens_total[5m]) 5540.2
```

*Real format, illustrative values — the log line format from vLLM v0.34.0 `docs/features/nixl_connector_usage.md` (one field trimmed), metric names from `vllm/v1/metrics/loggers.py`; values computed for the problem.*

What binds, why does TTFT suffer, and what do you change?

<details>
<summary>Reveal</summary>

**What applies.** The prefill-to-decode ratio follows GPU-seconds per phase, and a
full decode pool backs up into TTFT through leased blocks. The cue is a prefiller
running nothing while its memory is 71% full.

```text
decode demand: 3 req/s × 4,000 tokens = 12,000 tokens/s
one decode GPU at its memory limit: 52 GB ÷ (3,000 × 131 KB) ≈ 132 sequences,
  step = max(5.6, 5.3) + 132 × 3,000 × 46 ns ≈ 23.8 ms → ~5,540 tokens/s
  two decoders ≈ 11,100 < 12,000; three ≈ 16,600
prefill demand: 3 × 1,000 × 0.040 ms ≈ 0.12 of one GPU
GPU-seconds per request: prefill 0.04, decode 4,000 × 23.8 ms ÷ 132 ≈ 0.72 → ~1 : 18
```

The decoders are full (132 running, 99% KV, a queue), so finished prefills wait for
room while holding their blocks under a lease; the prefiller's memory fills with
leased caches, leases expire (17), and those requests are prefilled again. TTFT pays
for the decode side's shortage. The transfer is not the problem: 131 MB in 0.4 ms.
Change the ratio to one prefiller and three decoders (with decode-only CUDA graphs on
them), and consider a thinking budget, since output length is what moved the ratio.

*Taught in:* [Disaggregated Serving](#/disaggregation),
[The Agentic Era](#/agentic-serving).

</details>

</div>

<div class="exercise">

**Problem 26.** A proposal for a Llama-3.3-70B FP8 service. Find the errors.

```text
Move from two TP=2 replicas on four H100s to four single-GPU replicas on four H200s
(141 GB, 4.8 TB/s):
1. KV pool per replica = (141 - 70) x 0.90 = 63.9 GB.
2. Decode gets faster: the H200 reads at 4.8 TB/s against the H100's 3.35.
3. Our FP8 weights also halve the KV cache, to 164 KB per token.
4. Prefill doubles: each H200 does 1,979 TFLOPS in FP8.
5. Four replicas instead of two: a GPU fault takes out a quarter of capacity,
   not half.
```

<details>
<summary>Reveal</summary>

**What applies.** The memory budget, per-GPU bytes per step, the independence of KV
dtype from weight format, and what a spec sheet holds fixed. The cue is a faster
chip doing all the work of two slower ones.

1. **Wrong.** The budget is a fraction of the whole GPU: 0.90 × 141 − 70 − 4 ≈
   53 GB (~323K FP8 tokens per replica).
2. **Wrong.** Each H100 of a TP=2 pair reads 35 GB per step; a single H200 reads all
   70 GB: 70 ÷ 4.8 = 14.6 ms of floor against 10.4 ms, ~17 ms achievable against
   ~14 ms. Slower per token, though no all-reduces.
3. **Wrong.** KV precision is its own choice, `--kv-cache-dtype fp8`; FP8 weights do
   not change it.
4. **Wrong.** An H200 has the H100's compute die: 1,979 TFLOPS of dense FP8 each, the
   same as each H100. A one-GPU replica has half the prefill compute of a TP=2 pair:
   a 3,000-token prompt takes ~0.53 s instead of ~0.27 s.
5. **Right**, and the real argument for the move — together with more pool on the
   node (~212 GB against 132) and no all-reduces.

*Taught in:* [Sizing a Deployment](#/sizing-a-deployment),
[Choosing: Model, GPU, Framework](#/choosing-model-gpu-framework),
[Quantization](#/quantization).

</details>

</div>

<div class="exercise">

**Problem 27.** A law firm wants to index a 30-million-chunk archive (400 tokens per
chunk) with Qwen3-Embedding-0.6B and rerank 40 candidates per query (~650-token
pairs) with Qwen3-Reranker-0.6B. Both models have ~0.88 GFLOP of weight arithmetic
per token (440M non-embedding parameters; 28 layers, 16 query heads of 128). It has
A100 80GB GPUs (312 TFLOP/s dense BF16). At 40% MFU: (a) a full re-index on one A100,
(b) a nightly re-index of the 2% that changed, (c) rerank latency and the share of an
A100 at 3 queries per second, (d) the vector store at 1,024 float32 dimensions.

<details>
<summary>Reveal</summary>

**What applies.** Embedding and reranking are prefill without decode: time = FLOPs ÷
achieved FLOP/s, with attention's share growing with length. The cue is a workload
with no output tokens.

```text
per token: 0.88 GFLOP + attention 2 × 28 × 2,048 × T
  T = 400: 0.926 GFLOP        T = 650: 0.955 GFLOP
A100 at 40%: 1.25e14 FLOP/s
(a) 30e6 × 400 × 0.926e9 = 1.1e19 FLOPs → ~24.7 A100-hours
(b) 2% → ~30 minutes
(c) 40 × 650 = 26,000 tokens × 0.955e9 = 2.5e13 FLOPs → ~0.20 s per query
    at 3 queries/s: ~60% of one A100 (an H100 would take ~63 ms)
(d) 30e6 × 1,024 × 4 B ≈ 123 GB
```

The full re-index is a day of one GPU — run it once, then incrementally. The
reranker's 0.2 s sits inside the user's TTFT and outside the LLM engine's TTFT
metric: measure retrieval at the gateway, and if the budget is tight, rerank fewer
candidates or move it to a faster GPU. A 123 GB store needs a machine with that much
RAM, or fewer dimensions if recall holds.

*Taught in:* [Beyond Chat](#/beyond-chat), [Inference Arithmetic](#/inference-arithmetic).

</details>

</div>

<div class="exercise">

**Problem 28.** A request router built on Llama-3.1-8B (one H100) classifies
traffic: each request is a 120-token shared instruction plus ~40 unique tokens, and
the answer is 8 tokens. About 1,000 sequences are in flight. With vLLM v0.34's
default 64-token blocks, how many tokens per request come from the prefix cache,
what is the token hit rate, how many prompt tokens are computed, and how much KV does
the fleet of sequences hold privately? Then redo it with `--block-size 16`.

<details>
<summary>Reveal</summary>

**What applies.** Only full blocks are cached and a sequence's private part is
allocated in whole blocks. The cue is prompts not much longer than a block.

```text
                                   64-token blocks        16-token blocks
shared tokens hit                  64 (1 block)           112 (7 blocks)
token hit rate (of 160)            40%                    70%
prompt tokens computed             96                     48
private tokens (168 − hit)         104 → 2 blocks         56 → 4 blocks
  slots, wasted                    128, 24                64, 8
KV per sequence (131 KB/token)     16.8 MB                8.4 MB
1,000 sequences                    16.8 GB                8.4 GB
```

With prompts this short the default block halves the hit, doubles the prefill and
doubles private KV memory. Smaller blocks cost kernel efficiency (shorter contiguous
reads), which is why 64 is the default for ordinary chat; here the trade favours 16.
v0.34 also has `prefix_match_unit`, which lets hits land on boundaries finer than the
block without changing it. Measure the effect with the token hit rate, not the
per-request one: every request "hits" in both layouts.

*Taught in:* [PagedAttention & Prefix Caching](#/paged-kv-cache).

</details>

</div>

<div class="exercise">

**Problem 29.** A code-review assistant runs Llama-3.1-8B in BF16 on H100s: prompts
of ~30,000 tokens (a diff and the files it touches), ~600-token answers, ~8 reviews
decoding per GPU. Promises: TTFT p95 ≤ 3 s, ITL p99 ≤ 30 ms. Keep prefill and decode
on the same GPUs with chunked prefill, or split them? Remember that a chunk deep in a
30K prompt also pays attention over everything before it (per token, 4 × 4,096 × 32
layers × context FLOPs).

<details>
<summary>Reveal</summary>

**What applies.** Chunked prefill trades the prompt's TTFT against everyone's worst
gap; a split removes chunks from decode steps at the cost of a KV transfer. Which
wins depends on the gap target against what a chunk costs at this context. The cue
is a strict ITL promise with very long prompts.

```text
decode-only step, 8 × 30,300 tokens of KV:  5.6 + 11.1 ≈ 16.8 ms
attention at the end of the prompt ≈ 15.7 GFLOP per token, nearly the 16 of the weights
chunk   worst step (late chunk)   prefill of 30K, colocated
512     52.5 ms                   2.5 s
256     32.0 ms                   3.2 s
128     21.7 ms                   4.5 s
split:  decode steps 16.8 ms; prefill on its own GPU 1.81 s
        + 4.0 GB of KV: ~79 ms over one 50 GB/s NIC, ~9 ms over NVLink
GPU-seconds per request: prefill 1.81, decode 600 × 16.8 ms ÷ 8 ≈ 1.26
```

No chunk size meets both promises colocated: chunks small enough for 30 ms make
TTFT 3.2 s or worse. Split, the decode GPUs never see a chunk and TTFT is ~1.9 s; the
work ratio is ~1.4 : 1, so start near three prefill GPUs to two decode GPUs and tune
on goodput. The deciding number is the gap target: at an ITL p99 of 60 ms,
colocated 512-token chunks would pass both (52.5 ms, 2.5 s) and the split would buy
nothing. Measure `vllm:inter_token_latency_seconds` p99 with long prompts in the mix
before committing GPUs to either.

*Taught in:* [Disaggregated Serving](#/disaggregation),
[Continuous Batching & Scheduling](#/continuous-batching),
[Inference Arithmetic](#/inference-arithmetic).

</details>

</div>

<div class="exercise">

**Problem 30.** Halden's Legal department wants 300,000 archived e-mails summarised:
~1,500 tokens each (a 600-token instruction first, the same for all), ~200 tokens
out. The data rule forbids an API, so it would run on the node, in phase 1, between
20:00 and 06:00, on the two FP8 replicas. Does it fit the night? What does it cost,
what does it do to the node's day-average utilisation, and what could make it
collide with the morning?

<details>
<summary>Reveal</summary>

**What applies.** Cost from work-seconds on a fixed-price node, with the prefix
cache for the shared instruction; a batch job's metric is makespan. The cue is a
large job on hardware already paid for.

```text
instruction cached after the first request: 576 tokens (9 blocks)
work per e-mail: (1,500 − 576 + 200) × 0.088 ms ≈ 99 ms of a replica
300,000 e-mails: ~29,800 replica-seconds → ~4.1 h on two replicas
  (instruction not first: 6.3 h)
day-average utilisation that day: (2,600 + 29,800) ÷ 172,800 ≈ 19%, against 1.5%
the same job on a batch API at the case's prices: ~$1,125 — not an option here
```

It fits with ~6 hours to spare, if the instruction comes first; the marginal cost is
zero, because the node's $7,300 a month is paid either way — the trough back-filled
with work, which is the only way a fixed-price node's utilisation rises. With the
pool full the replicas hold ~250 sequences each, past the knee, so the job runs
compute-bound as a batch should. The collision is the makespan: a late start, a
restart for a flag change or a slow first run can push it into 09:00. Cap the job's
client concurrency, give it a low priority (`--scheduling-policy priority`), and stop
it at 07:00 whatever remains.

*Taught in:* [Hardware & Economics](#/hardware-and-economics),
[Beyond Chat](#/beyond-chat),
[Choosing: Model, GPU, Framework](#/choosing-model-gpu-framework).

</details>

</div>

That is the course, mixed. The [Review Deck](#/review) keeps its calculations fresh
with new numbers each time; come back to this page in a few weeks and see which
problems you still have to think about.
