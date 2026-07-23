# Research dossier — Axis 8: Canonical Bibliography (mid-2026)

> Opus research agent report, 2026-07-23, built via alphaXiv + web cross-checks.
> Status legend: **[DEPLOYED]** = in production stacks; **[INFLUENTIAL]** = shaped the field; **[ACADEMIC]** = important idea, limited deployment; **[FRONTIER]** = 2025–2026, unsettled but significant.
> arXiv IDs use YYMM (25xx = 2025, 26xx = 2026). 2025–2026 IDs search-verified against alphaXiv.

## 1. Foundations

- **Orca: A Distributed Serving System for Transformer-Based Generative Models** (OSDI 2022, no arXiv). Iteration-level (continuous) scheduling + selective batching. The single most important systems idea in LLM serving. **[DEPLOYED/INFLUENTIAL]**
- **Efficient Memory Management for LLM Serving with PagedAttention** (2023, 2309.06180). vLLM's founding paper. **[DEPLOYED]**
- **FlashAttention** (2022, 2205.14135); **FlashAttention-2** (2023, 2307.08691); **FlashAttention-3** (2024, 2407.08608). Tiled IO-aware exact attention → work partitioning → Hopper asynchrony/FP8. **[DEPLOYED]**
- **Fast Inference from Transformers via Speculative Decoding** (Leviathan et al., 2022, 2211.17192) + **Accelerating LLM Decoding with Speculative Sampling** (Chen et al., 2023, 2302.01318). The canonical spec-dec originals with the rejection-sampling acceptance rule. **[DEPLOYED/INFLUENTIAL]**
- **Medusa** (2024, 2401.10774). Extra heads + tree attention; superseded by EAGLE in quality. **[INFLUENTIAL]**
- **EAGLE** (2024, 2401.15077) — feature-level drafting; **EAGLE-2** (2024, 2406.16858) — dynamic draft trees; **EAGLE-3** (2025, 2503.01840) — multi-layer fusion + training-time test; production standard (SGLang/TRT-LLM default). **[DEPLOYED]**
- **SGLang: Efficient Execution of Structured Language Model Programs** (2023, 2312.07104). RadixAttention. **[DEPLOYED]**

## 2. Disaggregation & Scheduling

- **DistServe** (2024, 2401.09670). PD-disaggregation for goodput; formalized "goodput". **[DEPLOYED/INFLUENTIAL]**
- **Splitwise** (2023/24, 2311.18677). Microsoft phase splitting. **[INFLUENTIAL]**
- **Mooncake** (2024, 2407.00079). KVCache-centric disaggregated architecture (Kimi). **[DEPLOYED]**
- **Sarathi-Serve** (2024, 2403.02310). Chunked prefill + stall-free batching; now default in vLLM/SGLang. **[DEPLOYED]**

2025–2026 successors (frontier = KV-transfer cost, MoE-awareness, memory tiering):
- **KVServe** (2026, 2605.13734) — SLO-keyed KV compression for disagg transfer. **[FRONTIER]**
- **SpectrumKV** (2026, 2606.08635) — per-token mixed-precision KV transfer. **[FRONTIER]**
- **ELDR** (2026, 2607.00466) — expert-locality-aware decode routing for MoE PD. **[FRONTIER]**
- **ExpertPlex** (2026, 2607.18002) — expert-level disaggregation, persistent kernels. **[FRONTIER]**
- **HBM Is Not All You Need** (2026, 2606.29986) — decode on memory-heterogeneous accelerators. **[FRONTIER]**
- **Load-Aware Prefill Deflection** (2026, 2607.02043). **[FRONTIER]**

## 3. Quantization

- **GPTQ** (2022, 2210.17323); **AWQ** (2023, 2306.00978); **SmoothQuant** (2022, 2211.10438); **FP8 Formats for Deep Learning** (2022, 2209.05433). The four canonical references. **[DEPLOYED]**
- **KIVI** (2024, 2402.02750) — 2-bit asymmetric KV; **KVQuant** (2024, 2401.18079) — 10M-context KV quant. **[INFLUENTIAL]**

FP4/MXFP4 era + KV frontier:
- **Benchmarking PTQ under Microscaling FP** (2026, 2601.09555). **[FRONTIER]**
- **TORQ** (2026, 2605.19561) — rotations for MXFP4 blocks. **[FRONTIER]**
- **Diagnosing FP4: NVFP4 vs MXFP4 sensitivity** (2026, 2603.08747). **[FRONTIER]**
- **SAW-INT4** (2026, 2604.19157) — serving-regime-aware KV quant. **[FRONTIER]**
- **KVarN** (2026, 2606.03458) — KV-quant error accumulation in reasoning + fix. **[FRONTIER]**
- **Alignment Collapse Under KV Cache Quantization** (2026, 2606.09864) — safety degradation invisible to perplexity. **[FRONTIER]**

## 4. Architecture-for-Inference

- **DeepSeek-V2** (2024, 2405.04434) — introduces **MLA**; most consequential inference-oriented attention change of the era. **[DEPLOYED/INFLUENTIAL]**
- **DeepSeek-V3** (2024, 2412.19437) — MLA + fine-grained MoE + MTP + FP8 + co-designed inference stack. The reference open blueprint. **[DEPLOYED]**
- **NSA: Native Sparse Attention** (DeepSeek, 2025, 2502.11089) — trainable, hardware-aligned sparse attention. ACL 2025 best paper. **[INFLUENTIAL/FRONTIER]**
- **MoBA** (Moonshot, 2025, 2502.13189) — MoE-style block attention, deployed in Kimi. **[DEPLOYED/FRONTIER]**
- **DeepSeek-V3.2** (2025, 2512.02556) — **DSA** (lightning indexer + top-k); made learned sparse attention production-real. **[DEPLOYED/FRONTIER]**
- **DeepSeek-V4** (2026, 2606.19348) — Compressed Sparse Attention, million-token context. **[FRONTIER]**
- **Nemotron-H** (NVIDIA, 2025, 2504.03624) — leading Mamba-Transformer hybrid. **[INFLUENTIAL]**
- **Kimi Linear** (Moonshot, 2025, 2510.26692) — hybrid linear attention (KDA), production-viable. **[FRONTIER]**
- **MiniMax Sparse Attention** (2026, 2606.13392). **[FRONTIER]**

## 5. Long-Context Serving

- **Ring Attention** (2023, 2310.01889). Basis of context parallelism. **[DEPLOYED]**
- **StreamingLLM** (2023, 2309.17453). Attention-sink insight broadly used; eviction scheme niche. **[INFLUENTIAL]**
- **H2O** (2023, 2306.14048). Most-cited KV eviction — **mostly academic**; production prefers paging + prefix reuse or trained sparse attention. **[ACADEMIC/INFLUENTIAL]**
- **SnapKV** (2024, 2404.14469). Prompt-time KV compression; more adopted than most. **[INFLUENTIAL]**
- *Reality check:* the eviction literature (H2O, StreamingLLM, SnapKV, Ada-KV, QUEST, PyramidKV…) is **largely undeployed as-is** — frontier labs moved to trained sparse attention (NSA/MoBA/DSA) + KV quantization. Teach this gap explicitly.
- **Protection Is (Nearly) All You Need** (2026, 2605.18053) — head-to-head: structural token protection dominates scoring in capped KV eviction. Excellent critical-perspective paper. **[FRONTIER]**
- **Vortex** (2026, 2606.06453) — programmable sparse-attention serving layer. **[FRONTIER]**

## 6. Surveys (top picks first)

- **A Survey on Efficient Inference for LLMs** (2024, 2404.14294). Best-structured foundational survey — **course backbone pick**. **[INFLUENTIAL]**
- **A Survey on LLM Acceleration based on KV Cache Management** (2024, 2412.19442). Definitive KV survey — **KV-module pick**. **[INFLUENTIAL]**
- **Taming the Titans** (2025, 2504.19720). Most comprehensive serving-systems survey — **systems-module pick**. **[FRONTIER]**
- **A Survey on Inference Engines** (2025, 2505.01658). Compares 25+ actual engines — uniquely practical. **[FRONTIER]**
- **A Survey of LLM Inference Systems** (2025, 2506.21901). **[FRONTIER]**
- **From Tensor Buffer to Distributed Memory Hierarchy** (2026, 2607.02574); **System-Aware KV Cache Optimization** (2026, 2607.08057). Most current KV-management surveys. **[FRONTIER]**

## 7. New in 2025–2026 — genuinely new directions

**(a) RL rollout / agentic-RL serving** (inference is now the training bottleneck):
- **Single-Rollout Asynchronous Optimization for Agentic RL** (2026, 2607.07508). **[FRONTIER]**
- **ROSE** (2026, 2605.06534) — rollouts on serving GPUs via cooperative elasticity. **[FRONTIER]**
- **TRACE** (2026, 2606.11119) — rollout budget allocation. **[FRONTIER]**

**(b) Agentic serving:**
- **Efficient LLM Serving for Agentic Workflows: A Data Systems Perspective** (2026, 2603.16104). Conceptual anchor. **[FRONTIER]**
- **DualPath** (2026, 2602.21548) — multi-turn agentic inference dominated by KV **storage I/O**, not compute. **[FRONTIER]**
- **ThunderAgent** (2026, 2602.13692) — program-aware engine+runtime co-design. **[FRONTIER]**
- **Session-centric Scheduling for Serving Agents** (2026, 2607.08565). **[FRONTIER]**
- **HyMCache** (2026, 2607.18141) & **SAC** (2026, 2606.19746) — CXL/tiered-memory KV pools. **[FRONTIER]**

**(c) Diffusion LLM (dLLM) serving — becoming real in 2026:** bidirectional attention breaks exact KV caching and continuous batching; a serving literature formed to fix that.
- **Fast-dLLM** (NVIDIA/HKU/MIT, 2025, 2505.22618) — approximate KV cache + confidence-gated parallel decoding; the breakout paper. **[FRONTIER]**
- **Taming the Memory Footprint Crisis** (2025, 2512.17077) — first production dLLM serving design. **[FRONTIER]**
- **DiLaServe** (2026, 2606.29094), **BlockServe** (2026, 2607.08930) — SLO-aware scheduling + continuous batching for dLLMs ("the Orca moment for diffusion"). **[FRONTIER]**
- **Sangam** (2026, 2607.04206) — serve dLLMs with the AR stack. **[FRONTIER]**
- **Accelerating Masked Diffusion LLMs: A Survey** (2026, 2607.12829) — anchor survey. **[FRONTIER]**
- *Assessment:* real research subfield with strong affiliations, **not yet a deployed production workload** at frontier labs. Teach as emerging, not established.

**(d) Block-diffusion speculative decoding:**
- **DFlash** (2026, 2602.06036) — block-diffusion drafter for AR verification; spawned a sub-line (DFlare 2606.02091, draft trees 2604.12989). **[FRONTIER]**
- **Speculative Speculative Decoding** (Stanford/Princeton/Together, 2026, 2603.03251). **[FRONTIER]**

## Curation notes for the course

- **Cite-everywhere core (must-cover):** Orca, PagedAttention, FlashAttention 1–3, Leviathan spec-dec, EAGLE-3, SGLang/RadixAttention, Sarathi-Serve, DistServe, Mooncake, MLA (DeepSeek-V2/V3), GPTQ/AWQ/SmoothQuant, FP8 formats.
- **Teach-the-gap:** KV eviction literature heavily cited but under-deployed — contrast with what shipped (trained sparse attention + KV quant + prefix caching); 2605.18053 makes it concrete.
- **Freshest high-signal frontier:** NSA, DeepSeek-V3.2/DSA, DeepSeek-V4, Kimi Linear, Fast-dLLM, DFlash, DualPath.
- **Genuinely-new 2026 axes:** (1) RL-rollout inference as first-class serving problem; (2) agentic/session-centric scheduling + CXL-tiered KV; (3) dLLM serving as a subfield; (4) learned inference-time sparse attention shipped.
- Volume caveat: disaggregation/KV-quant/dLLM each have dozens of near-identical 2026 papers; selection was by engagement, affiliation, and conceptual distinctness.
