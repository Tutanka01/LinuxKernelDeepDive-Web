# Research dossier — Axis 7: Hardware, Economics, Benchmarks, Production Ops (mid-2026)

> Opus research agent report, 2026-07-23. All numbers volatile; vendor claims flagged.

## 1. The Hardware Landscape

### NVIDIA — still ~80–90% of merchant inference silicon
The 2026 line is a **rack-scale** story, not a chip story:
- **B200 (Blackwell):** 192 GB HBM3e, ~8 TB/s, ~9,000 dense FP4 TFLOPS, 1000 W. ~4× H100 inference. ([Spheron](https://www.spheron.network/blog/nvidia-b200-complete-guide/), [RunPod](https://www.runpod.io/articles/guides/nvidia-b200))
- **B300 / Blackwell Ultra:** 288 GB HBM3e, ~15,000 FP4 TFLOPS, 1400 W. Extra memory matters for KV-bound decode / long-reasoning. ([axecompute](https://axecompute.com/nvidia-blackwell-gpu-comparison/))
- **GB200/GB300 NVL72:** the purchase unit is a **72-GPU rack** on one NVLink5 fabric (~900 GB/s unidirectional/GPU) presenting as one giant accelerator. GB300 NVL72 ≈ 1.1 FP4 ExaFLOPS, ~$3.3M/rack. ([verda](https://verda.com/blog/gb300-nvl72-architecture), [SemiAnalysis](https://newsletter.semianalysis.com/p/inferencex-v2-nvidia-blackwell-vs))
- **Vera Rubin (VR200):** GTC 2026, production June 2026, shipping fall 2026: 288 GB **HBM4**, ~**22 TB/s** (2.8× Blackwell), ~50 PFLOPS FP4, 3nm. Marketed "~10× lower token cost". Rubin Ultra 2027, Feynman ~2028. ([BIZON](https://bizon-tech.com/blog/nvidia-gtc-2026-key-announcements), [TechTimes](https://www.techtimes.com/articles/319203/20260627/nvidia-vera-rubin-ships-this-fall-8-cloud-partners-10x-lower-token-cost-hbm4-triples-bandwidth.htm))

**Why rack-scale changes serving:** a 72-GPU coherent NVLink domain enables **wide EP (EP64+)** for large MoE, shared high-bandwidth KV pools, and PD disaggregation *inside* one fabric. SemiAnalysis measures Hopper→Blackwell tokens-per-dollar gains of **9.7× up to 65×** largely from the fabric, not raw FLOPS.

### AMD — credible on memory, fighting on software composability
- **MI355X (CDNA4):** 288 GB HBM3e, 8 TB/s, native FP4/FP6, 1400 W liquid-cooled. **MI325X:** 256 GB, 6 TB/s. The "35× inference" headline is a stacked comparison (MI355X FP4 vs MI300X FP8). ([Tom's Hardware](https://www.tomshardware.com/pc-components/gpus/amd-announces-mi350x-and-mi355x-ai-gpus-claims-up-to-4x-generational-gain-up-to-35x-faster-inference-performance))
- **InferenceX v2 reality check:** MI355X matches B200 on *single-technique* runs, but the gap widens sharply when composing **FP4 + disaggregation + wide-EP simultaneously** — exactly the frontier production config. Bottleneck is ROCm maturity, not silicon. **The single most important nuance for AMD evaluation.**

### Google TPU — the "age of inference" pivot
- **TPU v7 "Ironwood"**, GA April 2026: 192 GB HBM3e, 7.37 TB/s, **4,614 FP8 TFLOPS** (first TPU with native FP8). Pods to **9,216 chips = 42.5 FP8 ExaFLOPS**. >4×/chip vs v6e Trillium. 8th-gen splits into separate training and inference chips (2nm). ([blog.google](https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/ironwood-tpu-age-of-inference/))

### AWS — vertical integration for captive demand
- **Trainium2:** ~25% the cost of H100 / ~54% lower cost-per-token claims; **Trainium3:** 2.52 PFLOPS FP8, 144 GB, 4.9 TB/s; Trainium4 announced. ([SemiAnalysis](https://newsletter.semianalysis.com/p/amazons-ai-self-sufficiency-trainium2-architecture-networking))
- **Project Rainier:** ~400–500k Trainium2 for Anthropic; Anthropic cites ~1M Trainium chips training and serving Claude. Apple moved Siri-tier inference to Trainium2 (Feb 2026). The 2026 template: hyperscalers deploying custom ASICs against captive inference demand. ([Anthropic](https://www.anthropic.com/news/trainium2-and-distillation))

### Specialized SRAM-based silicon — real speed, contested economics
- **Cerebras (WSE):** ~3,000 tok/s gpt-oss-120B — fastest single-stream.
- **Groq (LPU):** ~476 tok/s gpt-oss-120B (vs ~100–150 on H100).
- **SambaNova (RDU):** >600 tok/s gpt-oss-120B; full DeepSeek-R1 671B at 198 tok/s on 16 SN40L (three-tier memory). ([GMI](https://www.gmicloud.ai/en/blog/fastest-llm-platform-compare), [IntuitionLabs](https://intuitionlabs.ai/articles/cerebras-vs-sambanova-vs-groq-ai-chips))

Pitch: bypass HBM via on-chip SRAM dataflow → win **interactive single-stream latency**. Catch: tiny per-chip memory → huge chip counts for weights+KV → GPUs win **throughput-per-dollar at batch**. These vendors win latency-critical niches (voice, agentic loops, reasoning). **This latency-vs-throughput tension is THE framing device for the hardware chapter.**

## 2. Economics

### The token-price collapse (2023 → 2026)
Frontier output prices down **~94.5% since March 2023**; ~300× quality-adjusted by some indices. ([TokenCost](https://tokencost.app/blog/ai-price-index), [BenchLM](https://benchlm.ai/llm-pricing-trends))

| Milestone (volatile) | Input $/1M | Output $/1M |
|---|---|---|
| GPT-4 launch, Mar 2023 | $30 | $60 |
| GPT-4o (2024) | $2.50 | $10 |
| GPT-5 (2026) | $1.25 | $10 |
| Gemini 3.1 Flash (Apr 2026) | $0.10 | $0.40 |
| DeepSeek V3 (2026) | $0.27 | $1.10 |
| gpt-oss-120B on DeepInfra | $0.039 | $0.19 |

**The decline has slowed**: ~6% YTD through May 2026 (YipitData) — the low-hanging deflation (quantization, kernels, Blackwell) is harvested; further drops need new silicon. Frame as an S-curve, not permanent exponential.

### GPU rental market (mid-2026, volatile)
- **H100 80GB:** ~$1.38–$1.49/GPU-hr neoclouds; up to ~$11–12/hr hyperscaler on-demand. Neoclouds 40–85% cheaper. ([Spheron](https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/))
- **H200:** spot from ~$0.50/hr; dedicated from ~$2.60/hr.

### Where API margins come from — the "cost stack"
1. **Cached input** — Anthropic 1.25× write / **0.1× read**; OpenAI automatic 50% off; Gemini 75% off + storage. ([Finout](https://www.finout.io/blog/anthropic-api-pricing))
2. **Batch API** — flat 50% off for 24h SLA (backfills fleet troughs).
3. Stacked: batch + cache reads → ~95% savings on the repeated portion. For agentic/RAG workloads, **cache-hit rate is the dominant cost variable** — more than sticker price.

### The DeepSeek "545%" episode — canonical economics case study
Disclosed Mar 2025: theoretical **545% daily cost-profit ratio** ($87,072/day cost vs $562,027 theoretical revenue, ~$200M/yr annualized). Caveats: R1 costs more than V3, most traffic free, off-peak discounts → actual revenue far lower. ([Computerworld](https://www.computerworld.com/article/3837452/deepseek-claims-545-cost-profit-ratio-challenging-ai-industry-economics.html), [CNBC](https://www.cnbc.com/2025/03/02/chinas-deepseek-claims-theoretical-cost-profit-ratio-of-545percent-per-day.html)) **Lesson: peak-utilization theoretical margins are enormous; blended real-world margins are modest.** Best teaching vehicle for inference unit economics.

### Open-weight serving providers — business reality
- **Fireworks AI:** ~$800M ARR (May 2026, Sacra), >10,000 customers. **Gross margin ~50%** — GPU cost dominates COGS. ([Sacra](https://sacra.com/c/fireworks-ai/))
- **Together AI:** ~$1B ARR. **DeepInfra:** ~5T tokens/week, cheapest per token, thinner service layer.
- Structural truth: open-weight serving is a **commodity, capital-intensive, ~50%-margin** business; identical models priced to the floor. Differentiation: latency SLAs, fine-tuning, compliance, catalog — not the tokens.

## 3. Benchmarks

### InferenceMAX / InferenceX (SemiAnalysis) — the new standard
Launched Oct 2025 (renamed InferenceX by v2). **Continuous, open-source, TCO-normalized** — true-north metrics: **$/M tokens** and **tokens per provisioned megawatt**. Sweeps the full **throughput-vs-interactivity Pareto frontier** (tok/s/GPU against tok/s/user). v2 spans ~1,000 GPUs, all recent NVIDIA + AMD. ([InferenceX](https://inferencex.semianalysis.com/))

Concrete v2 numbers (8k/1k, volatile, vendor-run):
- DeepSeek R1 FP4, GB300 Dynamo/TRT-LLM: ~$0.56/M output at 50 tok/s/user → ~$4/M at 125 tok/s/user.
- B200 FP4 + MTP: $/M total tokens **$0.251 → $0.057** with MTP — **~21× price cut from software alone**.
- gpt-oss on B200: ~60,000 tok/s/GPU, ~$0.02/M (vendor-optimized).

**Pedagogical takeaway: never quote a single "tokens/sec" — meaningless without the tok/s/user it was achieved at. The Pareto curve is the honest unit of comparison.**

### MLPerf Inference v5.1 (Sept 2025)
Added **DeepSeek-R1 (reasoning)**, Llama-3.1-8B, tighter interactive-latency scenarios. Blackwell Ultra topped. Strength: audited, identical accuracy targets. Weakness: ~6-month lag, cherry-picked divisions. ([MLCommons](https://mlcommons.org/2025/09/mlperf-inference-v5-1-results/))

### Artificial Analysis
Tracks an **Intelligence Index v4.1** (9 evals) AND price/output-speed per provider. Essential for cross-provider comparison. ([methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking))

### Benchmark-gaming pitfalls (the honesty section)
- **Silent quantization** — FP4/INT4 served at full-model price; independent trackers: [quanteval.ai](https://quanteval.ai/). InferenceX guards with accuracy checks.
- **Single-point throughput** hiding the latency it required.
- **Peak vs sustained**; TTFT under load vs idle.
- **Cherry-picked sequence lengths** — short favors compute-bound configs; long exposes KV limits.

**Benchmark honestly with:** `vllm bench serve` (ttft/tpot/itl/e2el percentiles), NVIDIA **AIPerf** (ex genai-perf), **guidellm** for SLO sweeps. Always report **P50/P99 TTFT and TPOT at a fixed request rate**, not averages. ([vLLM docs](https://docs.vllm.ai/en/latest/cli/bench/serve/))

## 4. Production Operations

### Metrics vocabulary
TTFT (prefill-bound, users feel first), TPOT/ITL (decode-bound), E2EL, **Goodput** (throughput meeting SLO — the capacity metric; raw throughput over-counts SLO violations). ([Spheron SLO guide](https://www.spheron.network/blog/llm-inference-slo-ttft-itl-latency-budget-guide-2026/))

Observability standard: **OpenTelemetry GenAI semantic conventions**, Prometheus/Grafana on vLLM/SGLang, app-layer tracing (Langfuse, Arize Phoenix).

### PD disaggregation — now default infrastructure
Compute-bound prefill pool + bandwidth-bound decode pool, KV shipped between (NIXL standard). Supported by vLLM, SGLang, Dynamo, Ray Serve. Enables mixed hardware tiers. ([DigitalOcean](https://www.digitalocean.com/community/tutorials/prefill-decode-disaggregation))

**Critical caveat for reasoning models:** naive **1P1D disaggregation *hurts* reasoning LLMs** — decode dominates (long CoT), prefill GPUs idle, KV-transfer overhead is pure loss. Reasoning wants **decode-heavy ratios (1P3D)** or aggregation. ([arXiv 2510.18672](https://arxiv.org/pdf/2510.18672))

### Failure modes & reliability
- **OOM from KV growth** — the #1 killer. Mitigate: paged attention, KV quant, admission control/preemption.
- **Cache thrash** — eviction under diverse traffic destroys hit rates; route by prefix affinity.
- **Hot replicas** — sticky routing concentrates long-context requests; length-aware/power-of-two balancing.
- **Capacity planning** — provision on **goodput at target P99**, keep headroom (latency degrades non-linearly).
- **Multi-region** — replicate weights, not KV; emerging cross-DC KV/prefill-as-a-service ([arXiv 2604.15039](https://arxiv.org/pdf/2604.15039)).

## 5. Energy — the 2026 binding constraint
- **Per token:** ~0.0001–0.002 Wh/output-token; a full optimized frontier query **median ~0.31 Wh** (IQR 0.16–0.60). ([Cell/Joule](https://www.cell.com/joule/fulltext/S2542-4351(26)00114-5))
- **Rack density:** AI racks 40–100+ kW (GB300 NVL72 ~120–140 kW) vs ~10 kW legacy — liquid cooling standard.
- **Fleet:** datacenters ~415 TWh (2024) → ~945 TWh by 2030 (IEA); **inference is now ~60% of AI energy**, having overtaken training.
- **Energy/token falls with batch size** → the throughput-latency tradeoff is *also* an energy tradeoff. InferenceX's tokens-per-megawatt metric exists because power is the scarce input.

## 6. Test-Time Compute — the demand-side shift
Reasoning models (o-series, R1, extended thinking) are the biggest structural change to inference demand:
- **10–100× more output tokens per request** → workload shifts hard toward **decode** (memory-bound).
- Inflates real demand far faster than user count; explains why token deflation slowed.
- Serving implications: decode-heavy fleets, higher-HBM SKUs (B300 288GB), decode-optimized disaggregation ratios, premium on fast single-stream latency (favoring SRAM silicon for interactive reasoning). ([arXiv 2510.18672](https://arxiv.org/pdf/2510.18672), [InferenceX](https://inferencex.semianalysis.com/))
