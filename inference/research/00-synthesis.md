# Inference Engineering course — Research synthesis & proposed structure

> Written 2026-07-23 from the 8-axis research dossier (files 01–08 in this directory).
> Status: PROPOSAL — awaiting validation before any chapter is written.

## 1. Verdict: the course is worth building

The research confirms a genuine white space. The field's "curriculum" today is a scavenger hunt (kipply → Yao Fu → the JAX scaling book → Aleksa Gordić's vLLM anatomy → vendor docs), and **no existing resource is simultaneously**: sequenced from zero, arithmetic-rigorous, GPU-first/vendor-neutral, concept-to-real-code, and current to mid-2026 (see 01-landscape.md §7). Community demand signals ("where do I start", quantization confusion, concept↔code gap) are strong and recurring.

## 2. The one mental model the whole course hangs on

**An LLM forward pass is a race between two hardware limits — FLOP/s and HBM byte/s — and arithmetic intensity decides which binds. Prefill is compute-bound; decode is memory-bandwidth-bound.** Every technique in the field is an attack on one side of that line:

- Batching, continuous batching → raise decode's arithmetic intensity
- KV cache management (paging, prefix caching, quantization, MLA, sparse attention) → shrink the bytes
- Speculative decoding → spend idle decode FLOPs to buy latency
- Disaggregation → stop making one GPU serve two opposite regimes
- Rack-scale MoE/EP → make the bytes come from more HBM in parallel

Secondary through-line for the second half: **the KV cache is the center of gravity of modern serving** — every 2026 production system (Mooncake, Dynamo, LMCache, cache-aware routing, agentic economics) is KV-centric infrastructure, and **cache hit rate is the metric that converts architecture into dollars**.

## 3. Anti-obsolescence strategy (the user's main worry)

The field moves fast, but not uniformly. Structure the course in layers by decay rate:

| Layer | Decay rate | Examples |
|---|---|---|
| Physics & math | ~zero | roofline, KV formulas, batching math, spec-dec theorem |
| Established systems ideas | slow | continuous batching, paging, prefix caching, chunked prefill, PD disagg |
| Current systems & numbers | fast | vLLM V1 details, EAGLE-3, GB200, prices | 
| Frontier | volatile | dLLM serving, DSA, CXL KV pools |

Conventions: every chapter frontmatter gets `verified: 2026-07`; volatile numbers are confined to clearly-marked "state of play, mid-2026" boxes; frontier topics live in ONE dedicated final chapter so staleness is localized. Same philosophy as the kernel-v6.12 pin.

## 4. Proposed course structure (mirrors distributed/ engine)

Sub-site `inference/` with the same course engine as `distributed/` (modules → chapters, quizzes, progress). ~16 chapters, 6 modules. Audience: someone who did the kernel + distributed courses — comfortable with systems thinking, no GPU background assumed.

### Module 1 — The Physics (Foundations)
1. **what-is-inference** — What Actually Happens When You Call an LLM. Tokens, the autoregressive loop, prefill vs decode, why serving is a systems problem. The API-to-GPU journey.
2. **gpu-mental-model** — The GPU Mental Model. SMs, HBM vs SRAM, tensor cores, the roofline model, arithmetic intensity, I_ridge; marketing-FLOPs traps (2:4 sparsity).
3. **inference-arithmetic** — Inference Arithmetic. 2·P FLOPs, why decode reads all weights, KV cache formulas (MHA/GQA/MLA numbers), batching math and B_crit, TTFT/TPOT/ITL/goodput, MFU vs MBU, $/token derivation. *The load-bearing chapter.*

### Module 2 — The Engine
4. **continuous-batching** — Batching & Scheduling. Orca, iteration-level scheduling, chunked prefill (Sarathi), prefill/decode interference, preemption (recompute vs swap).
5. **paged-kv-cache** — PagedAttention & Prefix Caching. The fragmentation problem, block tables, copy-on-write; hash-based caching vs RadixAttention; cache economics.
6. **anatomy-of-an-engine** — Anatomy of a Serving Engine. vLLM V1 & SGLang architecture: EngineCore, overlap scheduling, CUDA graphs + torch.compile, sampling, structured/constrained decoding (XGrammar, jump decoding). Engine landscape table.

### Module 3 — Making the Model Cheaper
7. **attention-for-serving** — Attention Architectures as Serving Decisions. MHA→MQA→GQA→MLA (decoupled RoPE, matrix absorption), SWA + hybrid layers + attention sinks, trainable sparse attention (NSA→DSA in production), SSM hybrids. RoPE scaling/YaRN.
8. **quantization** — Quantization. Formats hierarchy (FP8 default, INT4/AWQ, NVFP4 vs MXFP4), block scaling, KV quant, hardware mapping, the perplexity trap + FP8-KV long-context accumulation gotcha, what frontier labs ship.
9. **speculative-decoding** — Speculative Decoding. The rejection-sampling theorem (lossless!), families (draft models, EAGLE-3, MTP, n-gram), the batch-size inversion nobody explains, realistic speedups.

### Module 4 — Kernels (internals level)
10. **flashattention** — FlashAttention & Friends. Online softmax (THE recurrence), FA1→4, FlashDecoding/split-KV, FlashInfer as the universal backend, FlashMLA; Triton vs CUTLASS vs CUDA spectrum; Blackwell specifics (TMA, FP4 tensor cores).

### Module 5 — Serving at Scale
11. **parallelism-for-inference** — Parallelism for Inference. TP all-reduce math (NVLink vs PCIe), PP, EP + all-to-all, CP/ring attention for long context; why inference parallelism ≠ training parallelism.
12. **moe-serving** — Serving MoE at Scale. DeepSeek-V3/R1 system (EP32 prefill / EP144 decode, EPLB, redundant experts, DeepEP), wide-EP in open engines, GB200 NVL72 rack-scale, attention-FFN disaggregation.
13. **disaggregation** — Disaggregated Serving & the KV Fabric. DistServe/Splitwise/Mooncake, NVIDIA Dynamo (router, KVBM, NIXL), llm-d; KV tiering (LMCache, HBM→DRAM→SSD), cache-aware routing, autoscaling and why it's hard; the reasoning-model 1P3D caveat.
14. **agentic-serving** — The Agentic Era. Traffic patterns (267:1 input:output, 85-95% prefill), cache hit rate as the dominant cost lever, session scheduling, RL rollout serving (sleep/wake, weight sync), multi-LoRA.

### Module 6 — The Business & the Frontier
15. **hardware-and-economics** — Hardware & Economics. The landscape (NVIDIA rack-scale, AMD, TPU, Trainium, SRAM silicon and the latency-vs-throughput tension), token-price collapse and its S-curve, API pricing structure (cache/batch), the DeepSeek 545% case study, benchmark honesty (Pareto curves, InferenceX, MLPerf), energy as the binding constraint.
16. **frontier** — The Frontier (mid-2026 snapshot). Test-time compute's demand shift, dLLM serving, block-diffusion spec-dec, CXL KV pools, megakernels; explicitly dated, designed to be rewritten.

Optional later: a hands-on lab chapter (serve a model with vLLM on a rented GPU or llama.cpp locally, measure TTFT/TPOT, watch batching effects) — decide after the core chapters exist.

## 5. Differentiators to actually implement

- **Worked numbers everywhere** (the scaling-book strength, on GPUs): every claim backed by a computation the reader can redo.
- **"What actually shipped" honesty boxes**: e.g. KV-eviction papers (H2O et al.) are heavily cited but under-deployed — production went paging + prefix caching + trained sparse attention + KV quant. (08-bibliography.md "teach-the-gap".)
- **Misconception callouts** (02-fundamentals.md §9 list is ready-made).
- **Interactive calculators** (KV-cache size, B_crit, $/token) — the most-praised feature of the Modular handbook; fits our no-build-step engine as small inline JS.
- **Evidence discipline**: vendor-blog numbers flagged as such; primary sources linked per chapter (the dossier files carry the URLs).

## 6. Known verification debts (from agents' own flags)

Before writing the relevant chapters, re-verify against primary sources:
- "DeepSeek V4" / "GLM-5" / P-EAGLE version-merge specifics (possibly speculative secondary sources).
- "AWQ won over GPTQ" (secondary-blog sourcing).
- EAGLE-3 4.79× (single-stream favorable), SGLang-vs-vLLM percentage claims (vendor blogs).
- 2026 arXiv IDs cited by agents (e.g. 26xx numbers) — spot-check they resolve to the claimed papers.
- Mid-2026 prices/specs tables (volatile by nature — recheck at writing time).
