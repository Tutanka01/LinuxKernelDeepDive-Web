# The running case — single source of truth

> **v3 (2026-11-21).** Corrected after an audit against vLLM v0.34.0: the memory
> budget (0.90 is a fraction of total memory, so the pool is 132 GB, not 148),
> one step-time model for hybrid steps, the decode-time ladder, the shared-prefix
> accounting in phase 2, and the break-even wording. Engine facts in the course
> are pinned to **vLLM v0.34.0 (2026-11-16)**.

Every chapter's `> [!case]` box applies that chapter to this scenario. Keep
every number consistent with this file; if a chapter needs a new number,
derive it from these and add it to "Derived numbers" below.

## The brief (as the reader receives it in chapter 1)

You are the platform engineer at **Halden**, a 2,000-person logistics company
(fictional). Legal has ruled that internal documents may not leave the
company's cloud account, so a hosted API is off the table for the product
below. You are asked to self-host it.

**The product — "Ask Halden", phase 1:** an internal assistant that answers
questions over company documents (retrieval-augmented: the app retrieves a
few document chunks and puts them in the prompt).

**Phase 2 (announced in The Engine, lands in The Agentic Era):** an agent
that files and updates tickets through tool calls, looping several times per
user request.

## Fixed inputs

| | |
|---|---|
| Model | Llama-3.3-70B-Instruct — dense, 70B params, 80 layers, d_model 8192, 64 query heads, 8 KV heads (GQA), head_dim 128, MLP width 28,672, 128K context |
| Hardware | one rented node: 4 × H100 SXM 80 GB, NVLink |
| GPU price | $2.50 per GPU-hour → 4 × 2.50 × 730 h ≈ **$7,300 / month** for the node |
| Users | 2,000 employees, ~600 daily active, 20 requests per active user per day → **12,000 requests/day** |
| Peak | the 09:00–11:00 window carries ~35% of the day: **1.5 requests/s** at peak (rounded from 12,000 × 0.35 / 7,200 s = 0.58 → planned at ×2.5 burst headroom) |
| Prompt shape (phase 1) | 800-token system prompt (identical for everyone) + ~2,000 tokens of retrieved chunks + ~200-token question ≈ **3,000 tokens** in; **250 tokens** out (median) |
| SLOs | TTFT p95 ≤ 1.5 s; TPOT p95 ≤ 60 ms (≈ 17 tokens/s, faster than reading speed) |
| Phase 2 (agent) | agent requests at peak: 0.5/s (Q&A continues at ~1.0/s); each agent request → 4 model calls with tool waits between them, ~80 s per session; context per call 3.5K → 9K → 14.5K → 20K tokens (avg ~11K); system prompt + tool definitions = 3,000 shared tokens |

## Derived numbers (reuse these, do not re-derive differently)

- Weights BF16: 70e9 × 2 = **140 GB** → 35 GB per GPU under TP=4. FP8: 70 GB.
- KV per token (BF16): 2 × 80 × 8 × 128 × 2 = 327,680 B ≈ **328 KB**. FP8 KV: 164 KB.
- One phase-1 request at full length (3,250 tokens): 328 KB × 3,250 ≈ **1.07 GB** of KV.
- **Decode step, as a ladder of refinements (name the rung you are on):**
  1. *physics floor* — 35 GB per GPU ÷ 3.35 TB/s = **10.4 ms**;
  2. *at achievable bandwidth* (~85% of nameplate for a pure streaming read) — 12.3 ms;
  3. *planning figure, batch 1* — plus all-reduce and launch overhead → **~14 ms**
     (`W_MS` in the simulator; MBU ≈ 10.4 ÷ 14 ≈ 74%);
  4. *at ~20 concurrent 3K-token sequences* — plus KV reads (82 KB per context
     token per GPU ÷ 2.85 TB/s ≈ 29 ns per context token per sequence; 20 × 3,000
     tokens ≈ 1.7 ms) → **~16 ms**.
  These are estimates, not measurements. Published whole-engine batch-1 MBU is
  50–60% (Databricks), which would put rung 3 nearer 17–21 ms; the first thing
  Halden does with the node is measure it (`vllm bench serve` at concurrency 1).
  Every decision in the case holds across that range (the SLO is 60 ms).
- **Step-time model used everywhere (one model, not two):**
  `step ≈ max(t_w, t_c) + t_kv`, with `t_w` = 14 ms (the weights are read once
  per step, whatever rides on it), `t_c` = tokens in the step × 0.089 ms
  (2 × 70e9 FLOPs per token ÷ 1.58e15 FLOP/s achieved at 40% MFU) and `t_kv` as
  in rung 4. A hybrid step is **not** prefill time plus decode time: the same
  matrix multiplies read the weights and do the arithmetic. Example: a 512-token
  chunk + 20 decodes = 532 tokens → t_c ≈ 47 ms > t_w → step ≈ **~50 ms** with KV
  reads. Nameplate B_crit is 295 (peak FLOPs ÷ peak bandwidth); at these achieved
  efficiencies the knee sits nearer **~160 tokens per step** (14 ÷ 0.089). Say
  "nameplate ~295, effective ~160 on this node, measure it".
- Prefill of 3,000 tokens: 2 × 70e9 × 3,000 = 4.2e14 FLOPs; at 4 × 990 TFLOP/s ×
  40% MFU = 1.58e15 FLOP/s → **~0.27 s**. Inside the 1.5 s TTFT SLO.
- In-flight requests at peak (Little's law): W ≈ 0.3 s + 250 × 0.016 s ≈ 4.3 s →
  L ≈ 1.5 × 4.3 ≈ **6–7 on average**; bursts and slower steps push it higher.
  Plan for **20**. (Little gives an average over everything in the system,
  queue included — not a p95 and not "the batch".)
- **Memory budget semantics (vLLM v0.34.0, `vllm/v1/worker/utils.py`):**
  `--gpu-memory-utilization f` is a fraction of the device's *total* memory:
  `requested = total × f`, and the KV pool is `requested − non-KV memory`
  (weights, activations, CUDA-graph memory). It is **not** a factor applied to
  what is left after the weights. The case sets `0.90` explicitly, leaving 8 GB
  per GPU for what the engine does not measure. (Since v0.34.0 the default is
  unset → the "extensible KV cache" sizes the pool from measured free memory;
  chapters mention this in a State-of-play box and keep the explicit 0.90.)
- KV pool on the node (BF16 weights, TP=4): 0.90 × 320 = 288 GB budget − 140
  (weights) − 12 (overhead) − 4 (activations) = **132 GB** → ~123 phase-1
  requests at full length. Phase 1 is nowhere near the KV wall.
- KV pool per FP8 TP=2 replica: 0.90 × 160 = 144 − 70 − 6 − 2 = **66 GB**
  (132 GB on the node); in FP8 KV (164 KB/token) that is ~400K tokens per replica.
- Shared system prompt (800 tokens) = 262 MB of KV, stored once with prefix
  caching. Phase 2 shared prefix (3,000 tokens) = ~1 GB, stored once.
- Phase 2 peak: 0.5 agent req/s × ~80 s per session (Little) → **~40 agent
  sessions live** (active, or parked in a tool wait — the engine has no notion
  of a session: a parked session is prefix-cache blocks that are evictable).
  Contexts average ~11K tokens, of which 3K is the shared preamble.
  - Counted naively (no sharing): 40 × 11K × 328 KB = **144 GB in BF16** — more
    than the 132 GB pool. In FP8: 72 GB.
  - Counted properly (shared 3K preamble stored once per replica): 40 × 8K ×
    328 KB = 105 GB + ~1 GB; plus ~20 Q&A requests × 2,450 unique tokens × 328 KB
    ≈ 16 GB → **~122 GB of 132 GB in BF16 (93%)**: fits on paper, no margin, any
    burst preempts. In FP8 KV: 52 + 1 + 8 ≈ **~61 GB of 132 GB (46%)**.
  The forcing function for FP8 KV / offload / prefix caching. If one FP8 replica
  fails at the phase-2 peak, the survivor needs ~61 GB against its 66 GB pool.
- Phase 2 prefill per agent request: uncached 3.5+9+14.5+20 = 47K tokens;
  with session + preamble caching ≈ 17K (0.5K + 3 × 5.5K deltas). Peak prefill
  load: cached 0.5 × 17K + 1.0 × 2.2K ≈ 10.7K tok/s ≈ 1.5e15 FLOP/s ≈ **47%** of
  two FP8 TP=2 replicas (~3.2e15 at 40% MFU); uncached 0.5 × 47K + 1.0 × 3K ≈
  26.5K tok/s ≈ 3.7e15 FLOP/s → **over capacity**.
- Hosted-API comparison (for the economics chapter only; legal rules it out):
  at $3 in / $15 out per 1M tokens, phase 1 = 12,000 × (3,000 × 3 + 250 × 15)
  / 1e6 ≈ $153/day ≈ **$4,600/month** — cheaper than the $7,300 node. The case
  is *not* justified on price at phase-1 volume; it is justified by the data
  rule, and the economics flip at phase-2 volume. Chapters must say so honestly.
- Phase 2 economics (hardware-and-economics): ~4,000 agent requests/day; at API
  prices with provider caching ≈ $0.07 each → ~$8,600/month; total API ≈
  **$13,200/month** vs the $7,300 node (node ~1.8× cheaper). The flip happens
  because an API bill scales with tokens while the node is a fixed price — not
  because of a utilisation threshold. Break-even, stated unambiguously: the node
  matches the API when the *agent* traffic reaches (7,300 − 4,600) ÷ 8,600 ≈
  **31% of its phase-2 volume** on top of full phase-1 traffic (equivalently, at
  55% of the total phase-2 token bill).

## Decisions the chapters record (in order)

| chapter | the case box decides / records |
|---|---|
| what-is-inference | the request shape: 3,000 in / 250 out; TTFT and TPOT SLOs translated into what the user feels |
| inside-a-forward-pass | where the 140 GB and the 328 KB/token come from, in this model's own shapes |
| gpu-mental-model | the node: 4×H100, 320 GB, 13.4 TB/s aggregate; what the ridge means for this model |
| inference-arithmetic | decode floor ~14 ms, prefill ~0.27 s, 1.07 GB KV/request — phase 1 meets both SLOs at batch 1 with huge margin; the question becomes how many users, not how fast |
| how-to-read-a-number | evaluating a vendor's "3× faster serving" pitch for the node |
| continuous-batching | Little's law at peak → ~20 concurrent; chunked prefill so a 3,000-token prefill does not stall decodes |
| paged-kv-cache | the 800-token system prompt is shared; prefix caching on; what hit rate to expect |
| anatomy-of-an-engine | the vLLM launch line for the case and what each flag spends |
| attention-for-serving | GQA is why KV is 328 KB not 2.6 MB; why the phase-2 contexts still hurt |
| quantization | FP8 weights + FP8 KV: fits on 2 GPUs → two replicas instead of one |
| did-quantization-break-your-model | the eval plan to approve FP8 for Ask Halden |
| speculative-decoding | at ~20 concurrent, EAGLE-3 with γ=3 roughly halves TPOT on the cost model (~16 → ~7 ms at α 0.7): **on, conditional** on measured acceptance (≥ 1.5 tokens per round) and an A/B at concurrency 20. Phase 2 does not reverse it (long contexts keep steps KV-bound). It is a bet to be measured, not a default |
| flashattention | the FlashAttention backend on the H100s; decode attention is ~11% of a phase-1 step and ~40% of a phase-2 replica step; one thing to check: the FP8-KV path's accumulation fix, on the backend the startup log names |
| kernels-and-compilation | CUDA graphs on (`FULL_AND_PIECEWISE`); compilation and capture finish before the server listens, so there is no first-request spike — the stake is restart time as an outage window for as long as there is one replica (that is, until the FP8 evaluation passes and the second replica exists): persistent compile cache, readiness gate, restarts outside 09:00–11:00 |
| parallelism-for-inference | TP=4 × 1 replica vs TP=2 × 2 replicas (FP8) |
| moe-serving | should Halden switch to an MoE model? the memory-vs-compute answer |
| disaggregation | no: one node, short prompts — show the arithmetic |
| the-kv-fabric | phase 2: offload cold agent prefixes to CPU DRAM |
| agentic-serving | phase 2 lands: 4× calls, 20K contexts, prefix hit-rate becomes the business metric |
| sizing-a-deployment | capstone: the full budget, phase 1 and phase 2, final config |
| choosing-model-gpu-framework | API vs self-host vs other GPU, with the data rule |
| operating-it | the dashboard and the three alerts for Ask Halden |
| hardware-and-economics | cost per 1M tokens for the case vs the API; when the node pays for itself |
| frontier | which of the frontier items would change the case, and how you'd know |

### Chapters added in v3 (2026-11)

| chapter | the case box decides / records |
|---|---|
| where-models-come-from | Halden will not train or fine-tune: it runs a published checkpoint as it is. Everything it *can* change — precision, engine, hardware, scheduling — is the rest of the course |
| reading-a-model-card | why Llama-3.3-70B was approved (licence, 128K context, dense 70B that fits the node, tool-calling template) — and the stake: newer open-weights models exist by late 2026; what evidence (eval + arithmetic) would justify reopening the choice |
| lab-first-tokens | the reader's laptop as a miniature of the node: the same two numbers (bytes read per token, FLOPs per token) predict its decode and prefill speeds |
| lab-batching-and-cache | the 800-token shared system prompt, reproduced: what a hit and a miss look like in `timings.cache_n` |
| lab-squeezing | FP8-style evidence in miniature: does halving the bytes double the tokens/s on the reader's machine, and what does speculation's acceptance rate look like on Q&A-like prompts |
| beyond-chat | Ask Halden is retrieval-augmented, so something serves the embedding model and the reranker: on the same node or elsewhere, and what that takes from the pool |
| load-testing | the acceptance test that replaces the estimates: an open-loop sweep to 1.5 req/s and beyond with the real prompt shape, pass/fail on TTFT p95 ≤ 1.5 s and TPOT p95 ≤ 60 ms, and the measured knee recorded next to the predicted one |
| lab-load-test | the same sweep in miniature on the reader's machine; Little's law checked against `requests_processing` |
| when-it-breaks | one node means no hardware redundancy: the runbook for a GPU fault (Xid), a hung replica that still answers `/health`, and a template change that silently kills the prefix cache |
| mixed-problems | no case box (problem set) |
| review | no case box (review deck) |

### Numbers added by chapters during the v3 revision

- **Retrieval budget (what-is-inference):** at ~0.09 ms of prefill arithmetic per
  prompt token, 1.5 s of TTFT buys ~16,800 prompt tokens on an idle node (~14,900
  once attention's length-dependent work is counted). Decision: the application
  caps retrieved text at **4,000 tokens** and logs `usage.prompt_tokens` per request.
- **Exact size (inside-a-forward-pass):** 70,553,706,496 parameters → 141.1 GB in
  BF16 (matches the repo's `total_size`). The course rounds to **140 GB** after
  showing the exact count once.
- **BF16 on two GPUs does not fit** (budget −4 GB): BF16 needs all four GPUs.
- **Prefix cache granularity (paged-kv-cache):** vLLM v0.34.0's default block is
  64 tokens (16 before v0.34, and still on ROCm) and only full blocks are cached,
  so of the 800-token shared system prompt **768 tokens (12 blocks)** are shared;
  the last 32 are recomputed per request. Rounding to "800 shared" is fine in
  prose once this has been said.
- **Admission (continuous-batching):** in v0.34.0 a request is admitted only if
  its whole prompt fits in free KV blocks at admission; nothing is reserved for
  its output, which is why preemption exists.
- **Retrieval models (beyond-chat):** Ask Halden's retrieval runs
  Qwen3-Embedding-0.6B + Qwen3-Reranker-0.6B; corpus assumed 2M chunks × 500
  tokens (10⁹ tokens); 50 rerank candidates per question (≈ 37,500 tokens,
  ≈ 92 ms of one H100 at 40% MFU; ~14% of one GPU at 1.5 q/s). **Phase 1:**
  both run on GPU 0 of the node, the LLM at `--gpu-memory-utilization 0.80` →
  KV pool **100 GB** instead of 132 (phase 1 needs ~11–21 GB, so this is free).
  **Phase 2:** an FP8 TP=2 replica at 0.80 would hold only 0.80 × 160 − 78 =
  50 GB, less than the ~61 GB the survivor needs at the peak → the retrieval
  models **move off the node** (a small separate GPU) and the LLM goes back to
  0.90: 66 GB per replica, 132 GB on the node. The capstone's budget therefore
  uses 132/66 GB for phase 2. Retrieval latency sits inside the user's TTFT but
  outside the engine's TTFT metric.
- **Phase 2, as landed in agentic-serving / the-kv-fabric:**
  - Output per agent request ≈ **850 tokens** (3 tool calls × ~200 + a 250-token
    answer); input 47K uncached / 17K with session + preamble caching.
  - One FP8 TP=2 replica's prefill capacity ≈ **11.3K tokens/s** (1.58e15 ÷ 1.4e11);
    the node ≈ **22.6K**. Phase-2 peak demand ≈ 10.7K tok/s with caching (47%);
    if a template change breaks the agent preamble, ≈ 25.7K tok/s — over capacity.
  - Token-weighted prefix hit rate at the phase-2 peak: **~60%** normal; **~3%**
    when the agent preamble stops matching (only Q&A's 800-token prefix still hits).
  - ~40 sessions open: ~12 running, ~28 parked (evictable prefix-cache blocks);
    unique KV per session 1.3 GB in FP8 (8K × 164 KB); recompute of a parked
    session ≈ 0.71 s, restore from host memory 13–26 ms.
  - Host tier: `--kv-offloading-size 128` (GiB) per replica, 256 GiB pinned on the node.
  - Survivor after a replica failure at the phase-2 peak, parked sessions evicted:
    prefill demand ≈ 19.7K tok/s against 11.3K capacity — degraded mode queues
    agent requests ahead of shedding Q&A.
- **From inference-arithmetic (v3):** at the phase-1 peak prefill takes ~40% of
  the node's compute time; with 3K-token contexts the 60 ms TPOT promise is
  reached at ~343 concurrent sequences on the step-time model — far beyond what
  the KV pool admits (~123), so memory, not latency, is the wall that is reachable.
- **Prefix hit rate vocabulary:** vLLM v0.34.0 counts `vllm:prefix_cache_queries`
  / `vllm:prefix_cache_hits` in **tokens**. The trap is a hit rate quoted per
  request (share of requests with any hit) versus per token (share of prompt
  tokens served from cache). Do not use "logical/physical hit rate".
- **Capstone (sizing-a-deployment v3), final plan = 2 × FP8 TP=2 replicas:**
  - Phase 1 at 0.80 (retrieval models on the node): 50 GB pool per replica; KV in
    use ~4.1 GB (8%); mean TPOT ≈ 17 ms; hybrid steps 46–50 ms on ~5.5% of steps;
    TTFT ≈ 0.25 s.
  - Phase 2 at 0.90: 66 GB per replica; KV ~31 GB (47%), ~41 GB at p95 sessions;
    decode ≈ 16 ms (≤ 21 ms); ~27% hybrid steps; mean TPOT ≈ 25 ms; a prefill
    chunk at 17K context ≈ 63 ms (attention adds ~32% FLOPs) — the worst token
    gaps in phase 2 sit right at the 60 ms promise.
  - Little gives means; Poisson p95 of in-flight: phase 1 6.5 → 11 on the node;
    agent sessions 40 → 51 (20 → 28 per replica). Survivor KV at p95 sessions
    ≈ 75 GB against 66 GB: failover at a p95 peak does not fit without the host tier.
  - Startup log the reader reproduces (0.90, `--max-model-len 24576`, 64-token
    blocks): "30.73 GiB" available per GPU, "402,816 tokens", "16.39x".
  - Rule of thumb: a full pool adds pool-per-GPU ÷ 2.85 TB/s ≈ 11.6 ms per decode step.
- **Economics (hardware-and-economics v3):** day-average utilisation of the node
  is ~1.5% (phase 1) and ~5.2% (phase 2); the case's API comparison omits
  cache-write surcharges (~$1,500/month at Anthropic's 1.25× 5-minute write
  price); a second node for redundancy ($14,600 total) costs more than the
  phase-2 API bill. DeepSeek's published serving numbers cover 27–28 Feb 2025.
- **Quantization decisions (quantization / did-quantization-break-your-model v3):**
  - Meta publishes no FP8 checkpoint of Llama-3.3-70B; the case pins
    `RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic` at a fixed revision. Its files
    total 72.7 GB; the course keeps the rounded **70 GB** (un-rounded, the pool
    per replica would be ~63 GB instead of 66).
  - An FP8 TP=2 replica reads 35 GB per GPU per step — the same as BF16 TP=4 —
    so its batch-1 decode step is the same **~14 ms**. FP8 buys a second replica
    (capacity, redundancy), not a faster token.
  - **Evaluation gate (replaces "within one point on 1,500 questions", which
    1,500 paired questions cannot resolve):** the 95% interval of the paired
    accuracy difference stays above −2 points; answer flips stay at most twice
    the BF16-vs-BF16 flip floor; generated tokens stay within ±5%.
- **Operations (operating-it v3):** vLLM's default histogram buckets have no
  boundary at 1.5 s (TTFT) or 0.06 s (TPOT); the case adds them with
  `--custom-histogram-buckets` so the SLOs can be computed exactly. A single
  replica at the peak, with a 512-token per-step prefill budget, processes only
  ~9K prompt tokens/s (the scheduling limit) against the 11.3K compute limit.
  DCGM fields use the dcgm-exporter 4.9.0 names (`…_UTIL_RATIO`, 0–1 ratios).
- **Serving at Scale (parallelism / moe-serving / disaggregation v3):**
  - Interconnect, like for like (per direction, per GPU): NVLink 450 GB/s against
    one 400 Gb/s NIC at 50 GB/s → **~9×**, not "20–40×".
  - MoE alternative (gpt-oss-120b; checkpoint 65.25 GB): it wins on every serving
    number the course can compute; the decision therefore rests on the
    evaluation on Halden's questions and on its tool-call format, not on
    arithmetic. Halden stays on Llama-3.3-70B until that evaluation exists.
  - Disaggregation: **no**. Prefill interference costs ~1 ms of mean TPOT in
    phase 1; in phase 2 the worst token gaps reach the 60 ms line — the point at
    which a prefill-heavy split would start to pay.
  - DeepSeek's serving post: published 1 March 2025, statistics for 27–28 February.
- **Acceptance test (load-testing v3):** on the step-time model one FP8 TP=2
  replica's knee is predicted at **~3.3 requests/s** of the phase-1 request
  shape, TTFT-limited — written down before the sweep so the measurement can
  contradict it. In v0.34 there is no graph capture during the first minute of
  traffic (it finishes before the server listens); warm-up still matters for
  the prefix cache and the KV pool. Retrieval latency is outside the engine's
  TTFT and must be added to the user-facing budget.
- **Speculation and failover (capstone consistency pass):** an EAGLE-3 head
  takes ~4.9 GB per FP8 TP=2 replica, leaving ~61 GB of its 66 GB pool — exactly
  the survivor's ~61 GB phase-2 need. With speculation on, phase-2 failover has
  no KV margin without the host tier. The load-test sweep runs without speculation.
- **DeepSeek V4 KV per token (vLLM v0.34 FP8 layout, computed from configs, not
  published):** V4-Pro 4,521 B + 990 B indexer = 5,511 B; V4-Flash 3,157 B + 693 B
  = 3,850 B. Say which is meant (with or without the sparse-attention indexer).
- Launch lines load the pinned FP8 checkpoint
  (`RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic`), not `--quantization fp8` on
  the BF16 repository.
