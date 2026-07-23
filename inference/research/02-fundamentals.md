# Research dossier — Axis 2: The Performance Model of Transformer Inference (FUNDAMENTALS)

> Opus research agent report, 2026-07-23. Raw material for the inference engineering course.
> Verified against primary sources; see flags at the end.

*The single mental model this course builds on: an LLM forward pass is a sequence of matmuls whose speed is set by a race between two hardware limits — how fast the GPU can do arithmetic (FLOP/s) and how fast it can move bytes from HBM (byte/s). Which limit binds depends entirely on **arithmetic intensity** (FLOPs per byte). Prefill and decode sit on opposite sides of this line, and almost every serving decision follows from that one fact.*

---

## 1. The roofline: two ceilings, one crossover

Any operation takes `T = max(T_math, T_mem)` where `T_math = FLOPs / (peak FLOP/s)` and `T_mem = bytes_moved / (peak byte/s)`. An operation is **compute-bound** when `T_math > T_mem`, which rearranges to:

```
arithmetic_intensity  =  FLOPs / bytes   >   peak_FLOP/s / peak_byte/s  =  I_ridge
```

`I_ridge` (the "ops:byte" ridge point) is a pure hardware constant. Below it you are memory-bandwidth-bound; above it, compute-bound. This is the roofline model (jax-ml scaling book, https://jax-ml.github.io/scaling-book/roofline/).

**Verified hardware numbers (dense BF16 tensor-core, no sparsity):**

| GPU | BF16 dense FLOP/s | HBM BW | HBM cap | I_ridge (FLOP/byte) |
|---|---|---|---|---|
| **H100 SXM5** | 9.9e14 (989 TFLOP/s) | 3.35 TB/s (HBM3) | 80 GB | **~295** |
| **H200 SXM** | 9.9e14 | 4.8 TB/s (HBM3e) | 141 GB | ~206 |
| **B200** | 2.25e15 (2.25 PFLOP/s) | 8.0 TB/s (HBM3e) | 192 GB | **~281** |
| **TPU v5e** (reference) | 1.97e14 | 8.2e11 | 16 GB | ~240 |

Sources: NVIDIA H100 datasheet figures via https://www.spheron.network/blog/nvidia-h100-specs/ and jax-ml roofline page; B200 dense figures https://www.cudocompute.com/blog/nvidias-blackwell-architecture-breaking-down-the-b100-b200-and-gb200 and datasheet https://www.primeline-solutions.com/media/categories/server/nach-gpu/nvidia-hgx-h200/nvidia-blackwell-b200-datasheet.pdf.

**CONTESTED / commonly-misquoted:** Marketing decks quote H100 as "1,979 TFLOPS BF16" and B200 as "5 PFLOPS FP16." Those numbers **include 2:4 structured sparsity (2×)** which does not apply to standard dense inference. Always halve them for real inference math. Use **989 TFLOP/s (H100)** and **2.25 PFLOP/s (B200)** dense. Note the crossover: B200's HBM (8 TB/s) grew ~2.4× vs H100 while dense FLOPs grew ~2.3×, so `I_ridge` barely moved (~295 → ~281). *The memory wall is not receding.*

---

## 2. Why 2·P FLOPs and why decode reads all weights

Per token, a forward pass costs **≈ 2·P FLOPs**, where P = parameter count. Intuition: every weight is used in exactly one multiply-accumulate = 2 FLOPs (kipply, https://kipp.ly/transformer-inference-arithmetic/). Per transformer layer per token the dense cost is `2·(12·d_model²)` — split as QKV `2·3·d²`, output proj `2·d²`, MLP `2·8·d²`. (For MoE models substitute *active* params: DeepSeek-V3 is 671B total but only **37B active**, so ≈ 2·37B FLOPs/token.)

The other cost is **moving bytes**. To generate one token the GPU must read:
- **every weight** once (P·bytes_per_param), and
- **the entire KV cache** for that sequence.

This is the crux. At batch size 1, decode does `2·P` FLOPs but moves `≈ P·bytes` of weights. In BF16 that's arithmetic intensity `2P / 2P = ~1 FLOP/byte` — roughly **300× below H100's ridge of 295**. So a batch-1 decode step runs at ~1/300 of peak FLOPs; it is *entirely* gated by how fast weights stream out of HBM.

**Worked latency (kipply, A100, 52B model):** weights = 104 GB. `T_mem = 104e9 / 1.5e12 ≈ 22 ms/token` at batch 1 — and measured FasterTransformer latency was 22.0 ms, confirming the model is a near-perfect memory-bandwidth predictor. The general rule: **decode latency ≈ (weights + KV bytes) / HBM bandwidth**, independent of FLOPs.

---

## 3. Prefill vs decode: the same matmul on opposite sides of the ridge

**Prefill** processes all T prompt tokens in parallel. The matmuls become `[T, d]×[d, F]` with T large, so the same weights are reused across T tokens → arithmetic intensity ≈ T (hundreds–thousands) ≫ I_ridge. **Prefill is compute-bound**; measured intensity 200–400 FLOP/byte on H100, ~40–70% MFU achievable. Cost scales with input length and with `T²` for attention.

**Decode** generates one token at a time (T=1). Weights are read fresh for a single token → intensity ≈ 1 → **memory-bandwidth-bound**. Attention during decode is *always* memory-bound regardless of batching, because each sequence's KV cache is read once to produce one query — the derived intensity is `S·T/(S+T)` with T=1 → ≈1, and "we cannot do anything to improve the arithmetic intensity of attention during generation" (jax-ml inference chapter, https://jax-ml.github.io/scaling-book/inference/).

This asymmetry is *the* reason for **prefill/decode disaggregation** (running prefill and decode on separate GPU pools), covered later in serving. Reference: https://towardsdatascience.com/prefill-is-compute-bound-decode-is-memory-bound-why-your-gpu-shouldnt-do-both/.

---

## 4. Batching: the only lever that moves decode toward compute-bound

Batching B independent sequences reuses each weight read across B tokens. Weight bytes moved stays constant (P·bytes); FLOPs scale as `2·P·B`. So arithmetic intensity ≈ B. Decode becomes compute-bound once **B ≥ I_ridge** — this is the **critical batch size**:

```
B_crit  =  peak_FLOP/s / HBM_byte/s   (× correction for quantization)
```

**Verified values (jax-ml):** H100 BF16 ≈ **280 tokens**; TPU v5e BF16 = 240; kipply's A100 analysis = **208** (312e12/1.5e12). Quantization shifts it: FP8/INT8 *weights* halve B_crit; FP8 *compute* doubles it.

**Interpretation — the throughput/latency tradeoff curve:**
- **B < B_crit:** decode is memory-bound. Adding requests is nearly *free* on latency (you're re-reading the same weights anyway) and throughput rises almost linearly. This is why continuous batching is such a large win.
- **B ≈ B_crit:** the knee. Best throughput-per-latency point.
- **B > B_crit:** compute-bound. Per-token latency now grows with B; you trade latency for marginal throughput. Also KV cache may exhaust HBM first.

**Caveat:** B_crit is the batch size at which the *matmul (weight) portion* saturates compute. Attention never does — so real serving is a mix, and very long contexts make attention KV reads dominate before weight-reuse saturates. This is why long-context serving behaves differently (KV-bound, not weight-bound).

---

## 5. KV cache: the exact formulas and why it dominates at scale

**Per-token KV bytes (MHA/GQA):**

```
kv_bytes_per_token = 2 (K and V) × n_layers × n_kv_heads × head_dim × bytes_per_elem
```

For a full sequence multiply by T; for a serving pool multiply by total tokens across all live sequences. (jax-ml, kipply, Raschka https://sebastianraschka.com/llm-architecture-gallery/kv-cache-calculations/.)

**Attention-variant reduction** (query heads = H_q, kv heads = H_kv):
- **MHA:** H_kv = H_q. Baseline.
- **GQA:** H_kv = H_q / G (Llama-3 uses 8 KV heads). Reduces KV by H_q/H_kv (8× for Llama-3-70B: 64 q / 8 kv).
- **MQA:** H_kv = 1. Reduces by full H_q factor.
- **MLA (DeepSeek):** stores a single compressed latent per token instead of per-head K/V. Cached size = `(d_c + d_rope) = 512 + 64 = 576` dims/layer, not `n_kv_heads·head_dim`.

**Concrete numbers (BF16 = 2 bytes), verified per-token and at typical context:**

| Model | Layers | KV heads × head_dim | KV bytes/token | @ 8K ctx | @ 128K ctx |
|---|---|---|---|---|---|
| **Llama-3-8B** (GQA) | 32 | 8 × 128 | 2×32×8×128×2 = **131 KB** | ~1.0 GB | ~16 GB |
| **Llama-3-70B** (GQA) | 80 | 8 × 128 | 2×80×8×128×2 = **328 KB** | ~2.5 GB | ~40 GB |
| **Llama-3-405B** (GQA) | 126 | 8 × 128 | 2×126×8×128×2 = **516 KB** | ~4.0 GB | ~63 GB |
| **DeepSeek-V3/R1** (MLA) | 61 | latent 576 | **~70 KB** | ~0.55 GB | ~8.8 GB |
| **Hypothetical MHA-70B** | 80 | 64 × 128 | **2.6 MB** | ~20 GB | — |

DeepSeek-V3 config verified (61 layers, 128 heads, d_c=512, d_rope=64) from the technical report https://arxiv.org/pdf/2412.19437; the **~70 KB/token, a 2.7–4.7× reduction vs GQA**, is the headline MLA result. Note MLA stores in FP16 → 576×61×2 ≈ 70,272 bytes.

**Why it dominates:** For Llama-3-70B (140 GB weights in BF16) served at 128K context, *one* sequence's KV is 40 GB. On an 80 GB H100 pair you fit weights + only a handful of long sequences. At high concurrency, **KV cache — not weights — is what caps batch size**, and therefore caps throughput. This is the entire motivation for PagedAttention, GQA/MLA adoption, KV quantization, and prefix caching (all later chapters). See https://www.spheron.network/blog/kv-cache-optimization-guide/.

---

## 6. Metrics: precise definitions and real-world values

- **TTFT (Time To First Token):** wall-clock from request to first token = queue + prefill time (+ network). Dominated by prefill (compute-bound), scales with prompt length.
- **TPOT (Time Per Output Token):** `(e2e_latency − TTFT) / (output_tokens − 1)`. The steady-state decode speed. Memory-bandwidth-bound.
- **ITL (Inter-Token Latency):** the per-token gap during streaming. Often used interchangeably with TPOT, but ITL is the *instantaneous* gap (can spike from batching/scheduling) while TPOT is the *average*. (vLLM defines them separately; the distinction is the subject of vLLM issue #6531.)
- **E2E latency:** `TTFT + (output_tokens−1)·TPOT`.
- **Throughput:** total output tokens/s across all concurrent requests (system metric), or tokens/s/GPU (efficiency metric). Rises with batch size until compute-bound.
- **Goodput:** throughput *counting only requests that met their SLO* (e.g. TTFT<1s AND TPOT<50ms). The metric that actually matters in production — you can have high raw throughput but low goodput if latency SLOs are violated. See https://www.spheron.network/blog/llm-inference-slo-ttft-itl-latency-budget-guide-2026/.

**MFU (Model FLOPs Utilization):** `observed_model_FLOP/s ÷ peak_FLOP/s`. Report for **prefill** (compute-bound → ceiling is 100%). Real values: dense prefill 35–55%; decode MFU is often <10% (e.g. vLLM 7B measured ~9.95%) precisely *because* decode is bandwidth-bound and MFU is the wrong metric there.

**MBU (Model Bandwidth Utilization):** `achieved_bandwidth ÷ peak_bandwidth`, where
```
achieved_bandwidth = (param_bytes + kv_bytes) / TPOT
```
Report for **decode** (bandwidth-bound → ceiling is 100%). Databricks canonical values: **60% MBU on 2×H100 at batch 1; 55% on 4×A100 at batch 1** (https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices). Example: 7B BF16 (14 GB) at 14 ms TPOT → 1 TB/s achieved / 2 TB/s peak = 50% MBU.

**The unifying identity:** `MFU / MBU = I_work / I_ridge`. In the memory-bound regime `I_work ≪ I_ridge` so MFU ≪ MBU — that is *the mathematical signature* of decode. **Rule: report the utilization whose ceiling is 100% for the binding resource** — MBU for decode, MFU for prefill.

---

## 7. Cost model: $/1M tokens and the input/output asymmetry

**Base formula:**
```
cost_per_token = GPU_hourly_cost / (throughput_tok/s × 3600 × utilization)
```

**Worked example (verified structure):** Llama-3.3-70B FP8 on H200 at $3.44/GPU-hr, 2,036 tok/s peak → `3.44 / (2036 × 3600) = $0.47 / 1M tokens` at 100% utilization (https://www.gmicloud.ai/en/blog/llm-inference-cost-per-million-tokens). **But real utilization is 30–60%**, so multiply cost by 1.7–3.3×: realistic ≈ **$0.8–1.5 / 1M**.

On-demand reference prices (mid-2026): H100 SXM ≈ $2.00/GPU-hr, H200 ≈ $2.60/GPU-hr.

**Why input tokens are cheaper than output tokens** — this maps *directly* onto prefill/decode physics:
- **Input (prefill):** compute-bound, all tokens processed in parallel in one pass. High MFU, high tokens/s → cheap.
- **Output (decode):** memory-bandwidth-bound, sequential, one forward pass per token, low utilization → expensive.

Result: commercial APIs price output **~5–6× input**. Mid-2026 examples: GPT-5.5 $5 in / $30 out; Claude Sonnet 4.6 $3 / $15; Gemini 3.1 Pro $2 / $12 (per 1M). Self-hosting pays the *same* GPU cost per token either way, so self-hosting favors output-heavy workloads. (https://amnic.com/blogs/compare-input-vs-output-token-pricing, https://introl.com/blog/inference-unit-economics-true-cost-per-million-tokens-guide.)

**Prefix caching economics:** if a prompt prefix (system prompt, RAG context, few-shot examples) is reused, its KV cache is computed once and reused — the prefill cost is amortized to ~0 on cache hits. Providers pass this on as **~10× cheaper "cached input" tokens** (e.g. cached-read pricing). Economically: prefix caching converts recurring prefill compute into a one-time cost + cheap HBM/DRAM storage. This is why long shared system prompts are nearly free on the second call.

---

## 8. Sampling / decoding: cheap, but it constrains the loop

Per decode step, after the final logits `[batch, vocab]` are produced, the sampler runs:
- **temperature** (divide logits by τ), **top-k** (keep k largest), **top-p/nucleus** (smallest set with cumulative prob ≥ p), **min-p** (dynamic threshold relative to peak prob). Cost is `O(batch × vocab)` — a few hundred thousand elements — **negligible vs the 2·P weight matmuls**, and it does not change the memory-bound character of decode.
- **Caveat — it's a sync point:** sampling (especially top-p/top-k sorts) runs on GPU but forces a logits materialization and can add small per-step latency; poorly-fused samplers show up as decode overhead. Greedy/temperature-only is cheapest.
- **Structured/constrained output** (JSON schema, grammars): a mask over the vocab is computed each step to zero out illegal tokens. The masking cost is small, but computing the allowed-token set from a grammar (e.g. Outlines/XGrammar FSM) can add measurable per-token CPU/GPU work and, if not precompiled, stall the pipeline. It also *changes the token distribution*, occasionally forcing extra tokens.

**Takeaway for the serving loop:** sampling never moves the roofline — decode stays bandwidth-bound. But samplers are a synchronization and scheduling concern, not a FLOPs concern.

---

## 9. Misconceptions to correct explicitly (pedagogical)

1. **"GPUs do petaFLOPs, so decode is fast."** No — batch-1 decode runs at ~1 FLOP/byte, ~300× below the H100 ridge. Decode speed = HBM bandwidth / bytes-read, and uses <10% of FLOPs. The teraFLOP number is irrelevant to single-stream decode.
2. **Confusing memory capacity with memory bandwidth.** 80 GB (capacity) determines *how many* tokens/weights fit; 3.35 TB/s (bandwidth) determines *how fast* decode runs. A model can fit comfortably yet still be bandwidth-starved. Both matter, for different reasons.
3. **"Bigger batches always cost more latency."** Below B_crit (~280 on H100), added requests are nearly latency-free because you're re-reading the same weights regardless. Batching is close to a free lunch *until* the ridge.
4. **"KV cache is a rounding error."** At long context / high concurrency it *exceeds* weight memory and becomes the binding constraint on batch size and throughput.
5. **"Marketing FLOPs are the ceiling."** Those include 2:4 sparsity (2×) and low precision; dense BF16 inference sees half. Using the sparse number makes B_crit and MFU estimates wrong by 2×.
6. **"Output tokens cost more because they're 'worth more.'"** No — it's physics: decode is sequential and bandwidth-bound, ~5–6× less GPU-efficient than parallel prefill.

---

### Primary sources (verify against these)

- jax-ml *How To Scale Your Model* — roofline: https://jax-ml.github.io/scaling-book/roofline/ ; inference: https://jax-ml.github.io/scaling-book/inference/
- kipply, *Transformer Inference Arithmetic*: https://kipp.ly/transformer-inference-arithmetic/
- Databricks, *LLM Inference Performance Engineering*: https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices
- NVIDIA H100 datasheet figures: https://www.spheron.network/blog/nvidia-h100-specs/ ; B200: https://www.cudocompute.com/blog/nvidias-blackwell-architecture-breaking-down-the-b100-b200-and-gb200 ; datasheet PDF: https://www.primeline-solutions.com/media/categories/server/nach-gpu/nvidia-hgx-h200/nvidia-blackwell-b200-datasheet.pdf
- DeepSeek-V3 Technical Report (MLA, 70 KB/token): https://arxiv.org/pdf/2412.19437
- Raschka, KV cache calculations: https://sebastianraschka.com/llm-architecture-gallery/kv-cache-calculations/
- gpt-oss model card (MoE/GQA/SWA): https://arxiv.org/pdf/2508.10925
- Cost: https://www.gmicloud.ai/en/blog/llm-inference-cost-per-million-tokens ; https://introl.com/blog/inference-unit-economics-true-cost-per-million-tokens-guide

**Flags for the author:** (a) B200 dense BF16 = 2.25 PFLOP/s is correct; anything quoting ~5 PFLOP "FP16" is sparse — footnote this everywhere. (b) B_crit varies by source (208 A100 / 240 TPU v5e / 280 H100) — all are the *same derivation* (`FLOP/s ÷ byte/s`), differences are just the hardware; present the formula, not a single magic number. (c) TPOT vs ITL are often conflated in blogs — worth an explicit callout box. (d) MoE models: use **active** params for FLOPs/B_crit but **total** params for memory-capacity — a common student error.
