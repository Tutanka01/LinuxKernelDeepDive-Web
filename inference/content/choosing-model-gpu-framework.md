# Choosing: Model, GPU, Framework

> **The question:** before anything is deployed — API or own hardware, which model,
> which GPU, which engine — how do you make each choice with a number rather than a
> benchmark screenshot?
>
> **You'll be able to:** score deployment shapes against a data rule on four axes;
> shortlist, evaluate and price candidate models, and rank GPUs for a workload's shape;
> choose an engine for a traffic shape and a hardware platform from what each supports
> today; compute the utilisation at which self-hosting breaks even, input tokens
> included.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,fabric"></div>

Every recommendation here is derived from an earlier chapter. That is the point: a
choice made by screenshot or by habit cannot be re-examined when the numbers change,
and in this field they change every quarter.

## Deployment shape

The first decision is whether to touch a GPU at all. Six shapes differ on four axes:
who keeps the silicon busy (**utilisation**), who controls the **latency floor**, whose
machine holds the bytes (**data residency**), and who controls KV reuse (**cache**).

| Shape | Utilisation | Latency floor | Data residency | Cache |
|---|---|---|---|---|
| Token API | provider, blended across customers | provider's tiers | provider's account | provider's policy |
| Managed model API in your cloud | provider | provider | your cloud and region, provider's service account | provider's policy |
| Dedicated endpoint | you, by the hour | yours, on their stack | provider's account | partly yours |
| Bring your own cloud | you | yours | your account, vendor's control plane | yours |
| Self-hosted, rented GPUs | you | yours | your account | yours |
| On-premises | you, as capital | yours | your building | yours |

A token API takes the hardest problem of [Hardware & Economics](#/hardware-and-economics)
off your hands — utilisation — plus capacity planning and cold starts. On-premises wins
only at high, sustained utilisation and where the building can supply the power; a
modern rack draws over 100 kW.

> [!predict] Before you read on
> An agent workload and a chat workload send the same number of tokens per month. For
> which does owning the serving stack matter more, and why?

The agent. Its input is mostly a context it re-sends every iteration
([The Agentic Era](#/agentic-serving)), so cache hit rate sets most of its cost. On a
token API the provider may offer prompt caching, but the policy — time-to-live,
eviction, whether your next call reaches the replica holding your blocks — is theirs.
You are a tenant in someone else's block pool. The more a workload talks to itself, the
more the cache is the product, and the more you want to own it.

> [!bridge] From the Linux course
> Being a tenant in a shared pool is the cgroup situation: your share is set by limits
> someone else wrote, and noisy neighbours are something you observe, not fix. What
> differs is the shared resource — here the prefix cache — and there is no `memory.min`
> that reserves you a guaranteed slice of somebody else's.
> [→ Linux: Control Groups (cgroup v2)](../#/cgroups)

## Choosing a model

[Reading a Model Card](#/reading-a-model-card) taught how to read a candidate: its
licence, its sizes, its files and template. The decision takes three passes, each
cheaper than the next is expensive:

1. **Shortlist by licence and fit.** Drop what the licence forbids for your use, then
   what does not fit your hardware with a useful pool — the budget of [Sizing a
   Deployment](#/sizing-a-deployment), not the weights alone.
2. **Evaluate on your task.** Public leaderboards rank models on someone else's
   questions. Run each survivor through the harness of [Did Quantization Break Your
   Model?](#/did-quantization-break-your-model) — your questions, paired and seeded,
   with flips and token counts — in the precision you will deploy.
3. **Price each candidate** with the course's arithmetic: GPUs per replica, KV per
   request, arithmetic per token — and tokens per answer, because tokenizers and
   verbosity differ.

For Ask Halden, three candidates that pass step 1 (licences from each model's Hugging
Face card; sizes and KV from their `config.json`):

| | Llama-3.3-70B (FP8) | gpt-oss-120b (MXFP4) | Qwen3.8-27B (BF16) |
|---|---|---|---|
| Licence | Llama 3.3 Community | Apache-2.0 | Apache-2.0 |
| Weights | 70 GB | ~61 GB | 55.6 GB |
| GPUs per replica (H100) | 2 | 1 | 1 |
| KV for one 3,250-token request | 0.53 GB | ~0.13 GB | ~0.37 GB |
| Arithmetic per token (2 × active) | 1.4 × 10¹¹ | 1.0 × 10¹⁰ | 5.6 × 10¹⁰ |
| Halden evaluation, 1,500 questions | baseline | to run | to run |

The gpt-oss figures come from its config:

```json
  "experts_per_token": 4,
  "head_dim": 64,
  …
  "hidden_size": 2880,
  …
  "intermediate_size": 2880,
  "layer_types": [
    "sliding_attention",
    "full_attention",
    …
  ],
  …
  "num_hidden_layers": 36,
  "num_key_value_heads": 8,
  "num_local_experts": 128,
  …
  "quantization_config": {
    …
    "quant_method": "mxfp4"
  },
  …
  "sliding_window": 128,
```

*Verbatim — trimmed; `config.json` of openai/gpt-oss-120b on Hugging Face, revision b5c939de, checked 2026-11-21. The 36-entry `layer_types` list alternates as shown.*

Four of 128 experts per token, each three 2,880 × 2,880 matrices, plus attention and the
output layer: ~5.1 B parameters active. Only the 18 `full_attention` layers keep every
token; the other 18 keep the last 128. So the cache grows by 18 × 2 × 8 × 64 × 2 B ≈
37 KB per token — a ninth of Llama's 328 KB in BF16. The
Qwen figure is the hybrid-attention arithmetic of [Inside a Forward
Pass](#/inside-a-forward-pass).

At Halden's load the arithmetic column hardly matters: the node is idle 98% of the day
([Hardware & Economics](#/hardware-and-economics)). The row that moves money is GPUs
per replica. A model that passes the evaluation on one GPU lets two redundant replicas
run on a two-GPU node — half the rent. That is what the evaluation is worth.

## Choosing a GPU, in strict order

Each criterion matters only if the previous one passed.

1. **Capacity:** do the weights *plus a useful KV pool* fit? Compute `max_concurrency`
   before looking at anything else.
2. **Bandwidth:** decode time is bytes ÷ bandwidth, so for decode **HBM bandwidth is
   your tokens per second**.
3. **FLOPs:** matter for prefill and for decode past the knee. Prefill-heavy traffic —
   long retrieved contexts, classification, agents — is FLOP-sensitive; short prompts
   with long answers are not.
4. **Interconnect:** decides whether tensor parallelism is usable at all.

| GPU | HBM | Bandwidth | Dense BF16 | Ridge | Fabric | Best at |
|---|---|---|---|---|---|---|
| H100 SXM | 80 GB | 3.35 TB/s | 990 TF | 295 | NVLink, 8-GPU domain | the reference workhorse |
| H200 | 141 GB | 4.8 TB/s | 990 TF | 206 | NVLink, 8-GPU domain | decode and capacity, same compute |
| B200 (HGX) | 180 GB | 8 TB/s | ~2,250 TF | 281 | NVLink 5: 8-GPU domain in HGX, 72 in NVL72 racks | frontier, rack-scale MoE |
| Rubin | 288 GB | 19.2 TB/s | 4,000 TF | 208 | NVLink 6, 72 in NVL72 | the 2026–27 generation |
| A100 80GB | 80 GB | 2.0 TB/s | 312 TF | 153 | NVLink 3 | cheap capacity; no FP8 compute |
| L40S | 48 GB | 0.86 TB/s | 362 TF | 421 | PCIe only | prefill-heavy small models |

Dense figures, without 2:4 sparsity, from the vendors' datasheets (NVIDIA's HGX page
lists 36 PFLOPS of sparse BF16 for eight B200s, 2.25 dense each; DGX B200, 1,440 GB).
The ridge is FLOP/s ÷ bytes/s. It equals the decode batch at which compute catches up
only for two-byte weights: each sequence costs 2 FLOPs per parameter and each parameter
is 2 bytes, so 1 FLOP per byte per sequence. With FP8 weights and FP8 arithmetic the
batch is FP8 FLOP/s ÷ (2 × bandwidth); KV reads push it higher still.

> [!predict] Before you read on
> The L40S has more dense BF16 FLOPs than an A100. For 70B decode, which is better, and
> by roughly how much?

The A100, by far. Decode follows bandwidth: 2.0 against 0.86 TB/s, about 2.3×. With
2-byte weights the L40S's ridge of 421 means 421 concurrent sequences before its
compute mattered — and with 48 GB and no NVLink, a 70B needs several cards joined over
PCIe, where tensor parallelism's all-reduces hurt most. Strong FLOPs with weak
bandwidth is the most common way to buy the wrong GPU, because FLOPs are the number on
the box.

<div class="inf-widget" data-widget="kv-calculator">
<p class="inf-widget-fallback">Interactive KV-cache and memory-fit calculator — needs JavaScript enabled.</p>
</div>

Off the table: TPUs are rented inside one cloud, and their software moat is shrinking
(SGLang v0.5.23 runs on TPU7x through a PyTorch-native plugin). SRAM systems now serve
as the decode half of hybrid fleets ([Hardware & Economics](#/hardware-and-economics)).

## Choosing an engine

> **State of play (November 2026)**, from each project's release notes:
>
> | | vLLM v0.34 | SGLang v0.5.23 | TensorRT-LLM v1.3 | llama.cpp 1.0 |
> |---|---|---|---|---|
> | Runtime | PyTorch; Model Runner V2 only (V1 removed) | PyTorch; prefix cache on a Rust core | PyTorch only — TensorRT backend and `trtllm-build` removed | C/C++ (ggml), GGUF files |
> | Hardware | NVIDIA, AMD (ROCm 10 images) | NVIDIA, AMD, TPU7x, Apple Silicon | NVIDIA only; Rubin in preview | CPUs, laptops, consumer GPUs |
> | Prefix reuse | chained block hashes | radix tree: prefix trees, branches | prefix-aware scheduling, on by default | per-slot `--cache-reuse` |
> | KV beyond HBM | CPU offload, disk tier, LMCache | HiSparse host-memory tier | disk cache, LMCache and FlexKV connectors | — |
> | Prefill/decode split | NIXL connectors | native; instances switch roles live | via Dynamo | — |
>
> Orchestration sits above the engine, not instead of it: NVIDIA Dynamo v1.6 (router,
> flow control, LPX components; its KV block manager is deprecated for removal in
> v1.7) and llm-d v1.0 on Kubernetes both drive vLLM, SGLang or TensorRT-LLM.
> Hugging Face's TGI repository was archived in March 2026. vLLM and SGLang leapfrog
> each other between releases; a cross-engine "X% faster" without workload shape,
> batch and latency point is noise.

- **vLLM** by default: the broadest model and hardware coverage, the largest community,
  the shortest path from a model repository to an endpoint.
- **SGLang** when traffic is a tree — agent fan-out, regenerated chats, RL rollouts —
  which its radix cache expresses directly; and on TPUs.
- **TensorRT-LLM** when you are committed to NVIDIA and want its newest kernels and
  hardware first. It no longer compiles an engine per model and shape: since 1.0 the
  PyTorch backend was the default, and v1.3 removed the other one.
- **llama.cpp** solves a different problem: one user, one machine.

The procedure is the same whichever names are on the shortlist: replay your own trace
against two engines and compare goodput at your SLO ([Load Testing](#/load-testing)).

## Buy versus build: the break-even

From [Inference Arithmetic](#/inference-arithmetic), for output alone:

```text
   cost per output token  =  $ per hour  ÷  (tokens/s × 3,600 × utilisation)
   u*                     =  $ per hour  ÷  (tokens/s × 3,600 × API price)
```

Take one Llama-3.3-70B FP8 replica on two H100s at $5 an hour. At a batch of 32 with
~3,000-token contexts, a decode step costs 14 ms for the weights plus 32 × 3,000 ×
29 ns ≈ 2.8 ms of KV reads (rung 4 of the case's ladder): 32 tokens per 16.8 ms, about
1,900 output tokens/s. Then `u*` against $10 per million output tokens is `5 ÷ (1,900
× 3,600 × 10⁻⁵) ≈ 7%`; against $0.90 it is 81%, above what most fleets sustain.

Ask Halden cannot use that formula: 92% of its tokens are input. Count the work
instead, as [Hardware & Economics](#/hardware-and-economics) does — a saturated replica
spends ~0.089 ms per uncached prompt or output token:

```text
   u*  =  ($ per replica-second × work-seconds per request)  ÷  API price per request
       =  ($5 ÷ 3,600 × 2,450 × 0.089 ms)  ÷  $0.01275       ≈  2.4%
```

Phase 1's day-average utilisation is 1.5%: below the break-even, so the API would be
cheaper. And a break-even utilisation means nothing without the traffic's
peak-to-mean ratio. Halden's day averages 0.14 req/s (12,000 ÷ 86,400); the real
morning peak is 0.58 (≈ 4:1) and the plan provisions for 1.5 (≈ 11:1). A fleet sized
for its peak can average at most mean ÷ provisioned peak of its capacity unless troughs
are back-filled with batch work.

<div class="inf-widget" data-widget="cost-calculator">
<p class="inf-widget-fallback">Interactive cost-per-token and buy-vs-build break-even calculator — needs JavaScript enabled.</p>
</div>

## The decision tree

| # | Ask | If yes | If no |
|---|---|---|---|
| 1 | Must the data stay inside your boundary? | Ask *which* boundary: account, cloud, region, building. Then self-host, bring-your-own-cloud, or a managed API if the boundary admits it; go to 4 | continue |
| 2 | Is traffic small or bursty with long idle stretches? | **Token API** | continue |
| 3 | Is the workload cache-heavy (agents, repeated prefixes)? | Self-host, or a dedicated endpoint with cache affinity | a token API is still likely cheapest |
| 4 | Do weights plus a useful pool fit on one node? | Choose the GPU by bandwidth, then FLOPs | multi-node: NVLink domains, TP/PP plans, perhaps disaggregation |
| 5 | Which models pass shortlist, evaluation and price? | Deploy the cheapest passing one | widen the shortlist |
| 6 | Tree-shaped traffic, or TPUs? | **SGLang** | **vLLM**, or TensorRT-LLM if NVIDIA-only |
| 7 | Can you sustain `u*` against your comparison price? | build | buy, and revisit as volume grows |

> [!case] The case: walking the tree
> - **Step 1 — the boundary.** Legal's rule is that documents may not leave the
>   company's *cloud account*. The option the case never examined is a managed model
>   API inside the same cloud — same provider, same region, contractual no-retention.
>   Read as written, the rule excludes it: the model runs in the provider's service
>   account, not Halden's. But that is a reading, not a fact, and at phase-1 volume the
>   API is ~1.6× cheaper than the node. The plan records the question for legal, in
>   these words: "account" or "cloud provider and region"? If the answer is the
>   second, phase 1 moves to a managed API and the node waits for phase 2.
> - **Step 4 — it fits on one node**, two FP8 replicas. At the next contract renewal one
>   option deserves a quote: FP8 weights fit on **one H200** (0.90 × 141 − 74 ≈ 53 GB
>   pool), four single-GPU replicas with no all-reduces. Not faster per token: 70 GB ÷
>   4.8 TB/s ≈ 14.6 ms of weight read per step against 10.4 ms on today's two-GPU pair.
> - **Step 5 — the model.** Llama-3.3-70B stays; gpt-oss-120b and Qwen3.8-27B run the
>   1,500-question harness, because a one-GPU model that passes halves the rent.
> - **Step 6 — phase 2 is agentic:** vLLM serves phase 1; SGLang gets a replay of
>   Halden's agent traces before phase 2 ships, decided on goodput and measured hit rate.
> - **Step 7:** `u*` ≈ 2.4% against 1.5% today — the data rule, not price, justifies
>   phase 1; phase 2 crosses it.

> [!dashboard] The GPU you chose
> **Utilisation:** `DCGM_FI_PROF_DRAM_UTIL_RATIO` (memory interface busy — decode's
> resource) and `DCGM_FI_PROF_TENSOR_UTIL_RATIO` (tensor pipes — prefill's), from the
> DCGM exporter's default counters; not `DCGM_FI_DEV_GPU_UTIL_RATIO`, which counts any
> kernel running. **Saturation:** `vllm:num_requests_waiting` while the DRAM ratio sits
> high says the purchase was too small in bandwidth. **Errors:**
> `DCGM_FI_DEV_XID_ERROR` and `DCGM_FI_DEV_ROW_REMAP_UNCORRECTABLE_TOTAL`.

## Exercises

<div class="exercise">

**Exercise 1.** A summarisation service sends 6,000 tokens in and receives 400 out,
with no shared prefix, 20,000 requests a day. A two-H100 FP8 replica costs $5 an hour;
the API charges $2 in and $10 out per million. Compute `u*` with input included, the
day-average utilisation, and which is cheaper.

<details>
<summary>Reveal answer</summary>

Work per request: 6,400 × 0.089 ms ≈ 0.57 s, so $5 ÷ 3,600 × 0.57 ≈ $0.00079 at full
utilisation. API: 6,000 × $2 + 400 × $10 per million = $0.016. `u*` = 0.00079 ÷ 0.016 ≈
**4.9%**. Utilisation: 20,000 × 0.57 s ÷ 86,400 ≈ **13%**, so the replica costs ~0.37×
the API (4.9 ÷ 13). An output-only `u*` would have priced 6% of the tokens.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team moved its document classifier — Llama-3.1-8B in
BF16, 8K-token prompts, one output token — from H100s to H200s "for the 1.43×
bandwidth". The open-loop runs at 2 req/s on one GPU, before and after:

```plaintext
============ Serving Benchmark Result ============          (H100)
Request throughput (req/s):              2.00
---------------Time to First Token----------------
Mean TTFT (ms):                          655.10
P99 TTFT (ms):                           2104.37
============ Serving Benchmark Result ============          (H200)
Request throughput (req/s):              2.00
---------------Time to First Token----------------
Mean TTFT (ms):                          652.88
P99 TTFT (ms):                           2098.41
```

*Real format, illustrative values — result labels from vLLM v0.34.0 `vllm/benchmarks/serve.py`, other lines trimmed, GPU names added; values computed from the step-time model and an M/D/1 queue, not measured.*

Why did nothing improve, and what would have?

<details>
<summary>Reveal answer</summary>

One output token means the workload is all prefill, and prefill is compute-bound:
8,192 × 2 × 8 × 10⁹ FLOPs at 40% of 990 TFLOP/s ≈ 0.33 s per request on *both* GPUs —
same dense BF16 FLOPs. At 2 req/s each GPU is 66% busy, and the queue adds ~0.32 s on
average. The H200 bought bandwidth and capacity this workload never touches. FP8
arithmetic (2× the FLOPs on the same GPUs) or a B200 (~2.3×) would have moved TTFT.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer: choose an engine.** For each team, name an engine from the
table and the one measurement you would make before committing. (a) Sixteen MI355X GPUs
serving DeepSeek-V4.1-Flash to a coding agent that forks sub-agents from a shared
context. (b) A Google Cloud team whose quota is TPU7x. (c) An all-NVIDIA team getting
its first Rubin racks, whose clients speak the Anthropic Messages API. (d) A field
engineer who needs a model on an offline laptop.

<details>
<summary>Reveal answer</summary>

(a) SGLang — tree-shaped prefixes, AMD support, and its v0.5.22 notes report
DeepSeek-V4.1 on MI350X/MI355X; vLLM is the alternative. TensorRT-LLM is excluded by
the hardware. Measure goodput at the agent's SLO on a replay of real fork patterns.
(b) SGLang, through SGLang-TorchTPU; measure the model's kernels are supported before
the quota is committed. (c) TensorRT-LLM v1.3: Rubin preview support and a
`/v1/messages` endpoint; measure against vLLM on the same racks, since "preview" is a
release-notes word. (d) llama.cpp; measure tokens per second on the laptop itself
(the [first lab](#/lab-first-tokens)).

</details>

</div>

## What to remember

- A deployment shape is a choice of which problems to own; a data rule must name its
  boundary, or a managed in-account API can be neither excluded nor approved.
- Choose a model in three passes — licence and fit, your own evaluation, price — and at
  low load the price is set by GPUs per replica.
- Choose GPUs in order: capacity, bandwidth, FLOPs, interconnect. The ridge equals the
  critical batch only for two-byte weights.
- vLLM by default; SGLang for tree-shaped traffic or TPUs; TensorRT-LLM for NVIDIA-first
  kernels — no longer a compiled engine per shape.
- `u*` must count input: for Ask Halden it is ~2.4%, against 1.5% utilisation in
  phase 1.

```quiz
[
  {
    "q": "Llama-3.3-70B in FP8 (70 GB) can run on one H200 (4.8 TB/s) or on two H100s with TP=2 (3.35 TB/s each). At batch 1, which reads its weights faster per token?",
    "choices": [
      "The H200, by its 1.43× bandwidth advantage",
      "Neither: both read 70 GB in total per token",
      "The H200, because it avoids every all-reduce of tensor parallelism",
      "The H100 pair: ~10.4 ms against ~14.6 ms"
    ],
    "answer": 3,
    "explain": "Under TP=2 each H100 reads half the weights in parallel: 35 GB ÷ 3.35 TB/s ≈ 10.4 ms. One H200 reads all 70 GB alone: 70 ÷ 4.8 ≈ 14.6 ms. The 1.43× is per GPU, not per replica; skipping all-reduces saves a little but not 4 ms."
  },
  {
    "q": "A replica costs $6 an hour and spends 0.3 s of saturated work per request; the API charges $0.01 per request. What is the break-even utilisation?",
    "choices": [
      "About 5%",
      "About 18%",
      "About 50%",
      "About 0.5%"
    ],
    "answer": 0,
    "explain": "Cost per request at full utilisation = $6 ÷ 3,600 × 0.3 s = $0.0005; u* = 0.0005 ÷ 0.01 = 5%. 0.5% drops a factor of 10; 50% is the share of a day a fleet sized for a 2:1 peak could average, a different question."
  },
  {
    "q": "An accelerator offers 2,000 TFLOPS of dense FP8 and 5 TB/s. With FP8 weights and FP8 arithmetic, past roughly what decode batch does compute catch up with the weight read?",
    "choices": [
      "About 400, the FLOP-per-byte ridge itself",
      "About 200, half the FLOP-per-byte ridge",
      "About 100, a quarter of the ridge for FP8",
      "About 800, since FP8 doubles the usable FLOPs"
    ],
    "answer": 1,
    "explain": "Each sequence costs 2 FLOPs per parameter, and each parameter is one byte: B ≈ 2e15 ÷ (2 × 5e12) = 200. The ridge (400 FLOP/byte) equals the batch only for two-byte weights; KV reads push the real knee higher still."
  },
  {
    "q": "A team has TPU7x quota and wants an open-weights LLM endpoint. Which engine from this chapter's table runs there, per the November 2026 release notes?",
    "choices": [
      "TensorRT-LLM, through its PyTorch backend",
      "llama.cpp, since it runs on any accelerator",
      "SGLang, through the SGLang-TorchTPU plugin",
      "TGI, which Google Cloud still ships"
    ],
    "answer": 2,
    "explain": "SGLang v0.5.23 added TPU7x through SGLang-TorchTPU. TensorRT-LLM is NVIDIA-only whatever its backend, llama.cpp targets single machines, and TGI's repository was archived in March 2026."
  },
  {
    "q": "Legal writes: 'customer data may not leave our cloud provider's region'. Which option does this rule admit that 'may not leave our cloud account' would exclude?",
    "choices": [
      "A token API hosted by a third-party provider in another region",
      "A managed model API of the same cloud, same region",
      "Self-hosting on rented GPUs in the company's own account",
      "On-premises GPUs in the company's data centre"
    ],
    "answer": 1,
    "explain": "A managed in-region endpoint keeps data in the provider's region but runs in the provider's service account, so the region rule admits it and the account rule does not. Self-hosting satisfies both; another region violates both; on-premises is outside the cloud, a different question."
  }
]
```
