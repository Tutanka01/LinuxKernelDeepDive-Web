# Research dossier — Axis 6: Distributed & Disaggregated Serving (mid-2026)

> Opus research agent report, 2026-07-23. **[PROD]** = deployed in production; **[RESEARCH]** = research-only.

## 1. Parallelism for Inference — Why It Differs From Training

Core inversion: **training is throughput-bound and tolerant of communication overlap; inference decode is latency-bound and memory-bound.** Decode GEMMs are skinny, dominated by weight/KV movement.

**Tensor parallelism (TP).** Shards each weight matrix; all-reduce after attention and after MLP of every layer. On NVLink (Hopper SXM ≈ 900 GB/s, NVLink5 1.8 TB/s bidirectional/GPU) cheap; on PCIe (Gen4 x16 ≈ 32–64 GB/s) it dominates. Measured all-reduce share of e2e latency: **~20–30%** even on NVLink; up to half on PCIe. Rule: keep TP inside an NVLink domain; cross-node TP over IB is usually a mistake for decode.
- Meta Engineering: https://engineering.fb.com/2025/10/17/ai-research/scaling-llm-inference-innovations-tensor-parallelism-context-parallelism-expert-parallelism/
- Flash Communication [RESEARCH]: https://arxiv.org/pdf/2412.04964
- NVLink vs PCIe primer: https://www.spheron.network/blog/what-is-nvlink-gpu-interconnect-bandwidth-explained/

Subtle TP tradeoff: lower TP = fewer GPUs sharing weights = **less HBM headroom for KV cache** → hurts prefix-cache capacity. TP degree trades latency against cache hit rate. (BentoML handbook: https://bentoml.com/llm/inference-optimization/data-tensor-pipeline-expert-hybrid-parallelism)

**Pipeline parallelism (PP).** Layer stages across nodes; small point-to-point activation passing (cross-node friendly) but decode "bubbles". Used to fit models across cheap interconnects. Vocabulary parallelism [RESEARCH]: https://arxiv.org/pdf/2411.05288

**Expert parallelism (EP).** Different experts on different GPUs; dispatch/combine is a **two-shot all-to-all** scaling with tokens×top-k×hidden. All-to-all: **10–30%** of decode latency (100 KB–2 MB messages), >79% at large batch. The defining parallelism for modern serving — lets each expert see a GEMM-efficient batch.

**Sequence/context parallelism (CP).** Shards the sequence for long prefill (§7).

## 2. MoE Serving at Scale

### DeepSeek-V3/R1 inference system [PROD]
The canonical production reference (Open Source Week, Feb 2025):
- **Prefill:** EP32 across 4 nodes (32 H800); 9 routed + 1 shared expert per GPU. Dual-microbatch overlap hides dispatch/combine.
- **Decode:** EP144 across 18 nodes; 2 routed + 1 shared expert per GPU. 5-stage pipeline subdivides attention to overlap all-to-all.
- **Redundant experts + EPLB:** high-load experts replicated; Expert-Parallel Load Balancer recomputes placement. Three balancers: prefill, decode, expert-parallel.
- **Measured (24h, Feb 27–28 2025):** 608B input tokens, **342B (56.3%) hit the on-disk KV cache**; 168B output; ~73.7k tok/s/node prefill, ~14.8k tok/s/node decode; peak 278 nodes; $87,072/day cost vs $562,027 theoretical revenue → **545% theoretical margin** (actual far lower).
- Primary: https://github.com/deepseek-ai/open-infra-index/blob/main/202502OpenSourceWeek/day_6_one_more_thing_deepseekV3R1_inference_system_overview.md
- Hardware reflections: https://arxiv.org/html/2505.09343v1

### DeepEP [PROD]
Two kernel families: **high-throughput** (prefill/training, asymmetric NVLink↔RDMA forwarding) and **low-latency pure-RDMA** (decode) with a **hook-based zero-SM compute-communication overlap**. FP8 dispatch.
- https://github.com/deepseek-ai/DeepEP ; Azure tuning: https://techcommunity.microsoft.com/blog/azurehighperformancecomputingblog/achieving-optimal-performance-for-deepseek-expert-parallelism-deepep-on-azure/4414699

### Wide-EP in open engines [PROD]
- LMSYS reproduced DeepSeek-scale serving on **96 H100s** (PD disagg + large EP): https://www.lmsys.org/blog/2025-05-05-large-scale-ep/
- Red Hat vLLM/llm-d Wide EP: https://developers.redhat.com/articles/2025/09/08/scaling-deepseek-style-moes-vllm-and-llm-d-using-wide-ep
- SGLang EP docs: https://sgl-project-sglang-93.mintlify.app/distributed/expert-parallelism

### GB200 NVL72 rack-scale [PROD]
72-GPU NVLink domain (130 TB/s aggregate) makes wide-EP all-to-all intra-NVLink:
- SGLang GB200, DeepSeek 671B, PD+EP: **7,583 decode tok/s/GPU (2.7× H100)** — https://www.lmsys.org/blog/2025-06-16-gb200-part-1/
- Part II (FP8 attention + NVFP4 MoE): **26,156 prefill / 13,386 decode tok/s/GPU (3.8×/4.8×)** — https://www.lmsys.org/blog/2025-09-25-gb200-part-2/
- TRT-LLM Wide-EP: up to 1.8×/GPU — https://developer.nvidia.com/blog/scaling-large-moe-models-with-wide-expert-parallelism-on-nvl72-rack-scale-systems/
- SemiAnalysis GB200 vs B200 (R1 FP4): up to 4.4×/GPU at 125 tok/s/user — https://inferencex.semianalysis.com/blog/gb200-nvl72-vs-b200-disagg-deepseek-r1-fp4-dynamo-trt

### Attention–FFN disaggregation (AFD) [RESEARCH → early PROD]
MoE makes attention memory-bound while FFN stays compute-bound → disaggregate them. **MegaScale-Infer** (ByteDance, SIGCOMM 2025, "ping-pong pipeline parallelism", 1.9×): https://arxiv.org/pdf/2504.02263 . StepFun Step3 uses AFD in production. Design space: https://arxiv.org/html/2605.28302v1 . FastAFD (Hao AI Lab): https://haoailab.com/blogs/fastafd/ . vLLM RFC #22799.

## 3. Prefill/Decode Disaggregation

**Rationale.** Prefill compute-bound and bursty; decode memory-bound and latency-sensitive. Co-location causes interference (TTFT/ITL blowups); disaggregation gives each phase its own pool + parallelism, transferring KV over RDMA.

**Foundational [RESEARCH, now widely adopted]:**
- **DistServe** (OSDI 2024, goodput-optimized placement): https://arxiv.org/abs/2401.09670 ; 18-months retrospective: https://haoailab.com/blogs/distserve-retro/
- **Splitwise** (Microsoft, ISCA 2024, phase splitting across machine types). Combined showings: 2–7× throughput.
- **TetriInfer**; unify-or-disaggregate debate at low load (2508.01989, DOPD 2511.20982).

**Mooncake (Moonshot/Kimi) [PROD].** KVCache-centric disaggregated architecture behind Kimi: separate prefill/decode clusters + **disaggregated KVCache pool** from spare CPU/DRAM/SSD across the fleet, KVCache-centric scheduler with prediction-based early rejection. Up to 525% throughput (simulation), +75% real requests. FAST 2025 Best Paper.
- Paper: https://arxiv.org/abs/2407.00079
- **Transfer Engine + Mooncake Store** open-sourced Mar 2025; integrated into vLLM v1 and TRT-LLM as KV connector (Dec 2025): https://github.com/kvcache-ai/Mooncake
- vLLM × Mooncake agentic (May 2026): https://vllm.ai/blog/2026-05-06-mooncake-store

**NVIDIA Dynamo [PROD].** The "inference OS" — orchestration layer *above* vLLM/SGLang/TRT-LLM. Four pillars: **Smart Router** (KV-aware, cache-overlap score + load); **disaggregated serving**; **KV Block Manager** (block tracking, reuse, tiered offload); **NIXL** transfer library (RDMA/IB, RoCE/UCX, TCP, NVMe-oF, S3; non-blocking VRAM→VRAM).
- **Dynamo 1.0 GA March 16 2026**; up to 7× on Blackwell. Adopters: Cursor, Perplexity, Baseten, Deep Infra, Fireworks, ByteDance, Meituan, PayPal, Pinterest; CSPs AWS/Azure/GCP/OCI; CoreWeave, Together, Nebius. https://nvidianews.nvidia.com/news/dynamo-1-0
- Design docs: https://docs.dynamo.nvidia.com/dynamo/design-docs/disaggregated-serving ; NIXL: https://www.spheron.network/blog/nvidia-nixl-disaggregated-inference-guide/

**llm-d [PROD, K8s-native].** Google/NVIDIA/IBM/CoreWeave, Red Hat-led. Built on vLLM + Envoy + **Inference Gateway (IGW)** (official K8s Gateway-API extension: model routing, priority, KV-cache-aware routing, disagg). Shipping on CoreWeave/Azure managed K8s. https://llm-d.ai/blog/llm-d-press-release ; https://developers.redhat.com/articles/2025/11/21/introduction-distributed-inference-llm-d ; v0.5: https://llm-d.ai/blog/llm-d-v0.5-sustaining-performance-at-scale

**vLLM production-stack [PROD].** Router + vLLM replicas + LMCache for K8s: https://github.com/vllm-project/production-stack

## 4. KV-Cache Tiering, Offload, Transfer

**LMCache [PROD].** Dominant open tiered KV layer for vLLM: HBM → **CPU DRAM → local SSD → remote**, cross-request and **cross-node P2P sharing**. Multi-node P2P to production Jan 2026; used by **Google Cloud GKE Inference, CoreWeave, Cohere**; cross-hardware since mid-2025. Reported up to 15× on cache-heavy workloads.
- https://github.com/lmcache/lmcache ; https://docs.lmcache.ai/

**Tiering rule of thumb (2026):** active KV (last ~30s) in HBM; 30s–10min CPU DRAM; >10min NVMe. PCIe ~40 GB/s restores a 128K-token 70B KV in hundreds of ms. (https://kga-it.com/en/blog/ml-inference-kv-cache-management-2026)

**Transfer libraries:** NIXL, Mooncake Transfer Engine, UCX-class RDMA P2P. All converge on RDMA/RoCE with NVMe-oF/object-store fallbacks.

**Physical vs logical gap:** logical hit rates (90–99% multi-agent) collapse when HBM eviction forces recompute — tiering makes logical hits physical. (https://www.weka.io/article/why-gpu-memory-scarcity-and-kv-cache-eviction-are-undermining-agentic-ai-economics-in-2026)

## 5. Request Routing and Load Balancing

**Why standard LBs break:** round-robin treats replicas as interchangeable → throws away prefix caches, re-runs prefills. The balancer must know KV topology. (https://www.truefoundry.com/blog/kv-cache-routing-why-standard-load-balancers-break-prefix-caching-and-how-to-fix-it)

**Prefix/cache-aware routing:** SGLang **sgl-router** (Rust) maintains a prefix tree, routes matches to the same worker: up to 1.9× throughput, 3.8× cache-hit-rate. SGLang v0.4: https://www.lmsys.org/blog/2024-12-04-sglang-v0-4/ ; DualMap [RESEARCH]: https://arxiv.org/pdf/2602.06502

**Affinity/balance tension:** pure affinity overloads hot replicas; pure balancing kills cache. Production routers (Dynamo Smart Router, IGW, sgl-router) score cache-overlap minus load, spill on saturation. Session affinity layered for multi-turn.

**SLO-aware autoscaling — why it's hard:**
- GPU utilization is a lagging, useless signal (pegs ~100% during batching). Scale on **queue depth, TTFT, throughput**.
- KV state makes scale-*down* dangerous (drops warm cache + in-flight sequences).
- **Cold starts** tens of seconds to minutes (weight loading) → pre-warmed pools, snapshotting. KEDA/Knative scale-to-zero viable only with fast-load mitigations.
- https://mbrenndoerfer.com/writing/auto-scaling-horizontal-vertical-policies-llm-production ; https://www.spheron.network/blog/keda-knative-gpu-autoscaling-kubernetes-llm-cold-start/ ; https://dev.to/soniarotglam/why-vllm-autoscaling-on-kubernetes-breaks-and-what-to-use-instead-1231 ; PolyServe [RESEARCH]: https://arxiv.org/pdf/2507.17769 ; Tangram [RESEARCH]: https://arxiv.org/pdf/2512.01357

## 6. Multi-Model Serving and GPU Sharing

- **MIG:** hardware partitioning (up to 7 isolated slices, dedicated memory/compute). Baseten: ~2 usable H100 serving instances per H100. Best for predictable multi-tenant/small models. https://www.baseten.co/blog/using-fractional-h100-gpus-for-efficient-model-serving/ ; Colfax vGPU comparison: https://research.colfax-intl.com/sharing-nvidia-gpus-at-the-system-level-time-sliced-and-mig-backed-vgpus/
- **MPS:** concurrent kernels from multiple processes, per-client SM caps (Volta+); higher utilization, **no memory isolation** → interference.
- **Fractional GPU / serverless:** time-slicing + MIG for A/B, low-QPS; cold-start weight loading remains the central serverless problem. https://www.spheron.network/blog/fractional-gpu-inference-vgpu-mps-right-sizing/

## 7. Long-Context Serving (1M+ tokens)

**Context parallelism / ring attention.** Sequence split across GPUs; a **ring** passes KV (or Q) blocks between neighbors. **Pass-KV** for prefill, **pass-Q** for decode. Interconnect-limited.
- Meta CP (MLSys 2025): **1M-token Llama3-405B prefill in 77s on 128 H100s, 93% efficiency**; 128K in 3.8s. https://mlsys.org/media/mlsys-2025/Slides/3255.pdf
- Fine-grained SP [RESEARCH]: https://arxiv.org/pdf/2511.06247 ; APB [RESEARCH]: https://arxiv.org/pdf/2502.12085 ; ring/tree overview: https://www.spheron.network/blog/ring-attention-tree-attention-sequence-parallelism-gpu-cloud/

Serving pattern: **CP for prefill** + **TP+EP for decode** + PD disaggregation to keep giant prefills off the decode pool.

## 8. Agentic-Era Traffic — Cache Hit Rate as THE Economic Driver

The biggest 2025→26 shift: agentic workloads (tool loops, deep multi-turn, shared system prompts/codebases) make **prefix cache hit rate the dominant cost lever, ahead of model choice.**
- Prefill is **85–95%** of agent inference; input:output ratios up to **267:1**. Hit rate 0%→90% can cut a $20k monthly GPU bill to $2k. https://yage.ai/share/prefix-cache-agent-cost-lever-en-20260625.html
- Achievable: 60–85% on agent loops / repo-QA → 5–12× lower per-call cost; multi-turn 81–91%.
- "Context engineering" stack (compression + routing + API caching) now distinct from prompt engineering: https://www.spheron.network/blog/context-engineering-production-ai-agents-kv-cache-long-context/
- Caveat: KV reuse can *fail semantically* in multi-agent/LLM-judge settings [RESEARCH]: https://arxiv.org/pdf/2601.08343

**RL rollout serving.** RL post-training *is* a distributed-serving problem: disaggregate rollout pool from trainer, rollout buffer, async weight sync over RDMA. Weight-sync is first-class: naive 32B sync ~14 min/round; 2025–26 systems hit **~1.3s cross-machine updates even at 1T params** (weight-update sparsity + P2P RDMA). RL job volume ~tripled Apr→Sep 2025.
- Async RL landscape: https://huggingface.co/blog/async-rl-training-landscape ; prime-rl 1T: https://www.primeintellect.ai/blog/rl-at-1t-scale ; SparseRL-Sync [RESEARCH]: https://arxiv.org/pdf/2605.07330 ; RolloutPipe/ROLLMUX [RESEARCH]: https://arxiv.org/pdf/2606.26997 , https://arxiv.org/pdf/2512.11306

## 9. Synthesis — What's Actually Deployed

| Capability | Production reality (mid-2026) | Leading systems |
|---|---|---|
| Wide-EP MoE serving | Standard for DeepSeek-class models | DeepEP, SGLang, vLLM/llm-d, TRT-LLM |
| PD disaggregation | Mainstream in large deployments | Dynamo, Mooncake, llm-d, DistServe-derived |
| KV tiering/offload | Production Jan 2026 | LMCache, Mooncake Store, Dynamo KVBM |
| KV-aware routing | Production | sgl-router, Dynamo Smart Router, IGW |
| Rack-scale NVLink serving | Shipping | GB200 NVL72 + Dynamo/SGLang/TRT-LLM |
| AFD (attn/FFN split) | Early production / research | MegaScale-Infer, Step3, FastAFD |
| CP for 1M+ context | Production at frontier labs | Meta CP, ring attention |
| SLO autoscaling w/ cold-start mitigation | Emerging, still hard | llm-d, KEDA/Knative, PolyServe [R] |

**The through-line: the KV cache is the center of gravity.** Every 2026 system — disaggregation, tiering, routing, autoscaling, agentic optimization — is KVCache-centric infrastructure, and cache hit rate is the metric that converts architecture into dollars.
