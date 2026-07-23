# Research dossier — Axis 5: Quantization & Speculative Decoding (mid-2026)

> Opus research agent report, 2026-07-23. Claims flagged [consensus] / [contested] / [vendor claim].

## PART 1 — QUANTIZATION

### 1.1 The number-format landscape

Mental model: a low-bit *element type* + a *scaling granularity* (how many elements share a scale, and the scale's type). Coarser scales = cheaper but outlier-sensitive; finer = better accuracy, more metadata.

| Format | Element | Block / scale | Where it lives in 2026 |
|---|---|---|---|
| FP16 / BF16 | 16-bit | per-tensor | reference baseline |
| FP8 E4M3 | 8-bit (4-exp, 3-mant) | per-tensor or fine-grained | **the serving default** (W+A) |
| FP8 E5M2 | 8-bit (5-exp, 2-mant) | — | gradients, wide-range accumulation |
| INT8 | 8-bit int | per-channel/token | SmoothQuant-era; still fine for KV |
| INT4 | 4-bit int | group (g=128) | GPTQ/AWQ weight-only |
| MXFP4 | E2M1 | **32**-elem block, **E8M0** scale | OCP standard; gpt-oss MoE weights |
| NVFP4 | E2M1 | **16**-elem block, **E4M3** scale + FP32 global | Blackwell-native, 2026 accuracy leader |

**E2M1** values: {0, ±0.5, ±1, ±1.5, ±2, ±3, ±4, ±6}. The two FP4 standards differ almost entirely in *scaling*:
- **MXFP4** (OCP Microscaling): power-of-two scale is cheap but coarse ([emergentmind](https://www.emergentmind.com/topics/microscaling-fp4-mxfp4)).
- **NVFP4**: smaller blocks + real FP scale = markedly lower error ([Spheron](https://www.spheron.network/blog/nvfp4-vs-mxfp4-gpu-cloud-4bit-quantization-guide/), [Red Hat](https://developers.redhat.com/articles/2026/02/04/accelerating-large-language-models-nvfp4-quantization)).

**[consensus]** NVFP4 > MXFP4 on accuracy at equal bits; MXFP4 wins on portability.

### 1.2 Weight-only PTQ: GPTQ → AWQ → FP4

- **GPTQ** (2022, Hessian-based error-compensating rounding), **AWQ** (2023, activation-aware scaling protecting salient channels). In 2026: **AWQ is the production default** for INT4 weight-only (simpler, robust, first-class in vLLM/SGLang); GPTQ persists via the HF back-catalog. **[consensus, but sourced from secondary blogs — directional]**
- The live question shifted to **"INT4 weight-only (AWQ) vs FP4 (NVFP4)?"** — decided by hardware: FP4 pays off only with Blackwell FP4 tensor cores; on Hopper stay INT4/FP8.
- Hybrid FP4 recipes: **MR-GPTQ** (blockwise Hadamard rotations + scale search); NVFP4 calibration observers + SmoothQuant-style refinement ([Red Hat](https://developers.redhat.com/articles/2026/02/04/accelerating-large-language-models-nvfp4-quantization)).
- **PTQ vs QAT**: PTQ dominates deployment (cheap). QAT reserved for aggressive regimes; LMSYS shipped a **QAT recipe for gpt-oss MXFP4** via ModelOpt + SGLang ([LMSYS](https://www.lmsys.org/blog/2025-08-28-gpt-oss-qat/)).

### 1.3 Weight+activation & the FP8 default

**SmoothQuant** (2022) migrated activation outliers into weights for W8A8 INT8 — the bridge era. 2025–26 reality: **FP8 (E4M3) W+A is the serving default** — near-lossless, native Hopper/Blackwell ([Red Hat/vLLM](https://www.redhat.com/en/blog/enhancing-deepseek-models-mla-and-fp8-optimizations-vllm)).

COLM 2025 reasoning-quant study ([arXiv 2504.04823](https://arxiv.org/html/2504.04823v1)):
- **W8A8KV8: essentially lossless** (<1 pt even on 1.5B). **[consensus]**
- **W4A16: near-lossless** (often <1%).
- **W4A4KV4: risky** — ~2.3% on 32B but **>10% on 7B**; ~4× worse on hard tasks (AIME) than easy (GSM8K).
- **3-bit: sharp cliff — avoid.**

### 1.4 KV cache quantization

- **FP8 KV**: ~50% of BF16, typically <0.5 pt loss; vLLM default `--kv-cache-dtype fp8` ([vLLM FP8 KV blog](https://vllm-project.github.io/2026/04/22/fp8-kvcache.html)).
- **INT8 KV**: comparable to FP16 KV, half memory — the safe choice ([lmdeploy](https://lmdeploy.readthedocs.io/en/latest/quantization/kv_quant.html)).
- **INT4 KV** (KIVI, KVQuant, QuaRot): 25% footprint; lossless on large models, 1.3–1.7% drops on small ones. 2-bit KV breaks consistently.

**Gotcha [verified, concrete]:** vLLM documented FP8 KV + FA3 on **Hopper** silently collapsing at long context — 128k needle-in-haystack **91% (BF16) → 13%** because Hopper FP8 tensor cores lose precision accumulating over long contraction dims. A **two-level accumulation** fix (partial sums to real FP32 registers) restored 89%. Lesson: *KV-quant correctness is a kernel-accumulation problem, not just format choice* — perplexity looks fine while long-context retrieval silently dies. ([vLLM](https://vllm-project.github.io/2026/04/22/fp8-kvcache.html))

vLLM 2026 guidance: default FP8 KV, but skip sliding-window layers (`--kv-cache-dtype-skip-layers sliding_window`); avoid FP8 KV under ~7k tokens or head_dim=256 prefill-sensitive workloads.

### 1.5 What frontier labs ship

- **DeepSeek-V3/R1 — FP8 native training AND serving.** Tile-wise 1×128 activation quant, block-wise 128×128 weight quant, partials promoted to CUDA cores every 128 elements for FP32 accumulation (H800's 14-bit accumulator limit). Relative loss error vs BF16 <0.25%. Kernels open-sourced as **DeepGEMM**. ([DeepSeek-V3 report](https://arxiv.org/pdf/2412.19437); [Colfax](https://research.colfax-intl.com/deepseek-r1-and-fp8-mixed-precision-training/))
- **OpenAI gpt-oss (120B/20B, Aug 2025) — MXFP4 MoE weights**: 120B fits one 80GB H100/MI300X; 20B in 16GB. Chose the *OCP* standard, not proprietary. ([OpenAI](https://openai.com/index/introducing-gpt-oss/), [HF](https://huggingface.co/openai/gpt-oss-120b))
- **Llama family — official FP8 releases** as the efficient serving tier.
- DeepSeek newest Instruct checkpoints reportedly mixed FP4 (experts) + FP8 (rest) — **[contested / thin sourcing; verify against primary reports]**.

### 1.6 Evaluation pitfalls — the big pedagogical point

**Perplexity is a near-useless quantization metric.** A quantized model can hold flat PPL and GSM8K while catastrophically failing hard reasoning:
- MATH-500: **3-bit AWQ dropped 85.6% → 47.0%** while *inflating* CoT length **5.2K → 23.4K tokens (4.5×)** ([arXiv 2606.25519](https://arxiv.org/pdf/2606.25519)).
- Degradation is task-scaled: GSM8K ~7% avg, MATH ~15%, **AIME frequently → total failure** ([arXiv 2505.11574](https://arxiv.org/pdf/2505.11574)).
- **"Token inflation" is a hidden tax** [contested framing]: quantized reasoning models recover accuracy but generate longer chains that can cancel the per-token speedup ([arXiv 2606.00206](https://arxiv.org/pdf/2606.00206)).

**Rule for the book:** evaluate on task evals stressing the target regime (long-context retrieval, hard math, agentic tool-use), measure **generated-token count**, never trust PPL alone. Safe: W8A8, W4A16. Danger: ≤4-bit W+A on small/reasoning models, anything 3-bit.

### 1.7 Hardware format mapping [consensus]

| Precision | A100 | H100 | B200 | AMD MI300X |
|---|---|---|---|---|
| BF16/FP16 | native | native | native | native |
| INT8 | native | native | native | native |
| FP8 | ✗ | **native** | native | native |
| FP6 | ✗ | ✗ | **native** | ✗ |
| FP4 (MX/NV) | ✗ | ✗ | **native (5th-gen TC)** | ✗ |

([Exxact](https://www.exxactcorp.com/blog/hpc/comparing-nvidia-tensor-core-gpus), [Lambda](https://lambda.ai/blog/nvidia-hopper-h100-and-fp8-support)). **A100 has no FP8.** **FP4 requires Blackwell** — "FP4 on Hopper" = memory saving only, no compute speedup. AMD FP4/FP6 arrives with CDNA4 (MI355X-class).

## PART 2 — SPECULATIVE DECODING

### 2.1 The core theorem

Leviathan/Kalman/Matias 2023 + Chen et al. 2023 ([arXiv 2302.01318](https://arxiv.org/pdf/2302.01318)): a cheap **draft** proposes γ tokens; the **target** scores all γ in one parallel pass; token x with draft prob q(x), target prob p(x) accepted with **min(1, p(x)/q(x))**; on first rejection resample from **r(x) ∝ max(p(x) − q(x), 0)**.

**Theorem (modified rejection sampling):** output is distributed *exactly* as p. P(x) = min(q(x),p(x)) + (p(x) − min(q(x),p(x))) = p(x). Spec-dec is lossless by construction. **[consensus — foundational]**

**Speedup math:** acceptance rate α, draft length γ → expected accepted tokens ≈ (1 − α^(γ+1))/(1 − α); wall-clock speedup ≈ that / (1 + c·γ) with c = draft/target cost ratio.

### 2.2 The families

1. **Independent draft model** — small separate model; vocabulary must match (or heterogeneous-vocab tricks, [arXiv 2502.05202](https://arxiv.org/pdf/2502.05202)).
2. **Self-speculation / heads:** **Medusa** (N extra heads + tree attention); **EAGLE 1/2/3** — drafts at the **feature (hidden-state) level**; EAGLE-2 dynamic draft trees; **EAGLE-3** multi-layer feature fusion + training-time test ([SafeAILab/EAGLE](https://github.com/SafeAILab/EAGLE)).
3. **MTP** — heads trained *jointly with the base model*. **DeepSeek-V3** ships one MTP module (+2); second-token acceptance **85–90%**, **~1.8× TPS** in serving. GLM shares parameters across 3 MTP layers. The dominant "spec-dec shipped inside the open model" pattern in 2026.
4. **N-gram / prompt-lookup** — draft copied from context; near-zero cost, wins on summarization/RAG/code-edit.
5. **Tree/beam speculation** — verify a tree of candidates (Medusa/EAGLE-2/SpecInfer).
6. **Dynamic speculation length** — adapt γ per-step (BanditSpec 2505.15141, SpecDec++ 2406.14066).

### 2.3 Deployed in 2026

- **EAGLE-3 is the de facto production standard** — in vLLM, SGLang (`--speculative-algorithm EAGLE3`), TensorRT-LLM. Up to **4.79× on Llama-3.3-70B** **[low-batch vendor-favorable figure]** ([Spheron](https://www.spheron.network/blog/eagle-3-speculative-decoding-gpu-cloud/)).
- **MTP heads ship with open models** (DeepSeek-V3/R1, GLM) — no external draft training needed.
- **SpecForge** ([arXiv 2603.18567](https://arxiv.org/pdf/2603.18567)) — open EAGLE-drafter training framework (SGLang ecosystem).
- **P-EAGLE** (parallel EAGLE, all K draft tokens in one drafter pass) — active 2026 vLLM development ([vLLM blog](https://vllm.ai/blog/2026-03-13-p-eagle)) **[verify version claims against release notes]**.

### 2.4 The batch-size nuance (the thing everyone gets wrong)

**Spec-dec's benefit inverts with batch size:**
- **Low batch (latency-bound):** target GPU is memory-bound and under-utilized; verifying γ tokens is nearly free → 2–4× latency wins. All headline numbers come from here.
- **High batch (compute-bound):** draft compute + wasted rejected-token compute are pure overhead. **Spec-dec can reduce throughput.**

Thresholds from literature: below **~0.5 acceptance it actively hurts**; solid wins need **α ≥ 0.6, γ ≥ 5**; practitioners advised to **disable above ~32 concurrent requests** ([Goodput paper 2406.14066](https://arxiv.org/html/2406.14066v2), [Spheron guide](https://www.spheron.network/blog/speculative-decoding-production-guide/)).

**Caveat to the caveat: long context flips it back.** MagicDec / SPIRe: at long context KV reads dominate even at high batch, so spec-dec can help throughput there ([MagicDec](https://infini-ai-lab.github.io/MagicDec-part2/), [SPIRe 2504.06419](https://arxiv.org/pdf/2504.06419)). **[consensus the tradeoff exists; crossover is model/hardware/context-dependent — measure, don't assume]**

Framing: *spec-dec is a **latency** optimization first. Interactive/low-QPS/long-context: yes. Saturated high-throughput batch endpoint: neutral-to-negative.*

### 2.5 Realistic production speedups

- Paper/vendor headlines: 2–5× (near-single-request).
- Production batched: **1.5–2.5×** latency at moderate concurrency, tapering to ~1× (or worse) as batch grows.
- DeepSeek-V3 MTP in real serving: **~1.8× TPS** — the honest "shipped in a frontier model" number.
- Red Hat measured gpt-oss spec-dec gains in vLLM ([Red Hat](https://developers.redhat.com/articles/2026/04/16/performance-improvements-speculative-decoding-vllm-gpt-oss)).

## PART 3 — NEIGHBORS (brief status)

- **Distillation** — highest-ROI model-level lever in practice (DeepSeek-R1-Distill line ubiquitous); also powers spec-dec (distilled small model = great draft). **[consensus: matters a lot]**
- **2:4 structured sparsity** — practically underused; hard 50% constraint hurts quality, needs retraining. SpenseGPT: first real one-shot-pruned end-to-end decode speedup, but only ~1.2× on B200 FP8 ([arXiv 2606.10445](https://arxiv.org/abs/2606.10445)). **Niche.**
- **Unstructured pruning** (SparseGPT, Wanda) — no dense-hardware speedup without 2:4 → research/memory play.
- **Early exit** — diminishing returns ([arXiv 2603.23701](https://arxiv.org/pdf/2603.23701)); largely absorbed into self-speculation. **Minor in production.**

## Bottom line for the book

1. **FP8 W+A is the 2026 default**; **NVFP4 (Blackwell) is the frontier**, MXFP4 the portable standard. KV: FP8/INT8 safe, INT4 big-models-only.
2. **Never judge quantization by perplexity.** Reasoning + long-context are where low-bit silently breaks; measure task evals AND token counts.
3. **Spec-dec is lossless by construction** (rejection-sampling theorem) and a **latency** tool; EAGLE-3 + built-in MTP are the deployed reality; benefit inverts at high batch — the most misunderstood point.
4. **Distillation matters most among neighbors; sparsity/early-exit largely aspirational.**

**Flagged uncertainties:** "AWQ won" rests on secondary blogs; "DeepSeek V4"/"GLM-5"/P-EAGLE version specifics from 2026 secondary summaries — confirm against primary sources before publishing. EAGLE-3 4.79× is favorable single-stream.
