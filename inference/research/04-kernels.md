# Research dossier — Axis 4: GPU Kernels, Attention Variants & Compilation (mid-2026)

> Opus research agent report, 2026-07-23.

The through-line to teach: **inference is memory-bandwidth-bound, not compute-bound**, and almost every technique below is a different attack on that fact.

## 1. The Core Idea: Attention Is IO-Bound, and FlashAttention Fixes the Memory Traffic

Naive attention materializes the full `S = QKᵀ` score matrix (N×N) in slow HBM, reads it back for softmax, then again for `PV`. For long sequences the arithmetic is cheap relative to the HBM round-trips — attention is **IO-bound**. FlashAttention's insight is **tiling + online softmax**: never materialize the full N×N matrix. Load blocks of Q, K, V into SRAM, compute a partial score block, and update a running softmax (running max `m` and running normalizer `ℓ`) so results accumulate block-by-block. This is exact attention, just re-associated to be IO-aware. The **online softmax recurrence** — rescaling accumulated output by `exp(m_old − m_new)` — is *the single most important thing to teach*: FlashDecoding, FlashInfer, MLA kernels, and sparse kernels are all variations on it.

**FlashAttention-2** ([arXiv:2307.08691](https://arxiv.org/abs/2307.08691)) is a work-partitioning rewrite: (1) reduce **non-matmul FLOPs** (on A100, non-matmul FP32 runs at 19.5 TFLOP/s vs 312 for matmul — ~16× more expensive per op); (2) **parallelize over the query sequence dimension**, not just batch×heads, so long-context/small-batch fills the GPU; (3) better warp-level work split. ~2× over FA1, 50–73% of peak matmul ([Hazy Research](https://hazyresearch.stanford.edu/blog/2023-07-17-flash2)).

**FlashAttention-3** ([arXiv:2407.08608](https://arxiv.org/pdf/2407.08608), NeurIPS 2024) is Hopper-specific, about **asynchrony**: (1) **warp specialization** — some warpgroups do GEMM (WGMMA), others softmax, communicating through a shared-memory pipeline; (2) **ping-pong scheduling** — interleave matmul and softmax of different iterations; (3) **FP8 with block quantization + incoherent processing** (Hadamard rotation to spread outliers). ~840 TFLOP/s BF16 (75% of H100), ~1.3 PFLOP/s FP8 ([Tri Dao blog](https://tridao.me/blog/2024/flash3/)).

**FlashAttention-4** ([paper 2026-03](https://arxiv.org/html/2603.05451v1); [Together AI](https://www.together.ai/blog/flashattention-4); [Modal reverse-engineering](https://modal.com/blog/reverse-engineer-flash-attention-4)) targets Blackwell (SM100/B200), first attention kernel past **1 PFLOP/s**. Tricks: `exp()` via polynomial approximation on FMA/CUDA cores (the SFU is the bottleneck at Blackwell tensor throughput); **skips softmax rescaling** unless the running-max shift threatens stability (~10× fewer rescales). Written entirely in **CuTe-DSL** (CUTLASS's Python kernel DSL), ~20–30× faster compiles than C++ templates — kernel authorship is moving to Python DSLs. ~1.2–1.3× over cuDNN 9.13, ~2× over Triton.

## 2. Inference-Specific Kernels: Prefill vs Decode Are Different Beasts

Prefill: whole prompt in parallel, compute-bound, big GEMMs — FA-style kernels ideal. Decode: Q is a single row, K/V are the entire cached history; FA2's query-length parallelization collapses — most SMs idle.

**FlashDecoding** ([PyTorch](https://pytorch.org/blog/flash-decoding/), [Princeton NLP](https://princeton-nlp.github.io/flash-decoding/)): **split-K / split-KV** — chunk the KV history across SMs, compute partial attention with per-chunk log-sum-exp in parallel, then a tiny reduction kernel combines partials using the LSEs. Same online-softmax math, across *spatial* KV splits. FlashDecoding++ ([arXiv:2311.01282](https://arxiv.org/pdf/2311.01282), MLSys 2024): unified max for async softmax, flat GEMM.

**FlashInfer** ([arXiv:2501.01005](https://arxiv.org/abs/2501.01005), **MLSys 2025 Best Paper**; [GitHub](https://github.com/flashinfer-ai/flashinfer)) — the most important inference-kernel project to teach: the shared attention backend under **vLLM, SGLang, TensorRT-LLM, and MLC**. Ideas: (1) every KV layout (paged, ragged, radix-tree prefix sharing) represented as **block-sparse**; (2) **JIT-compiled customizable attention template** (masking, sinks, sliding window, custom score mods); (3) **load-balanced scheduler** for ragged serving traffic. Default attention backend on Blackwell in recent vLLM ([NVIDIA](https://developer.nvidia.com/blog/run-high-performance-llm-inference-kernels-from-nvidia-using-flashinfer/)). Reported 29–69% ITL reduction.

**FlashMLA** ([GitHub](https://github.com/deepseek-ai/FlashMLA)) — DeepSeek's Hopper MLA decode kernel (Open Source Week 2025). Paged, variable-length, ~3000 GB/s; the **production forward kernel for DeepSeek-V3.2 sparse attention**, upstreamed into cuDNN. FP8 KV support ([FP8/sparse deep-dive](https://github.com/deepseek-ai/FlashMLA/blob/main/docs/20250929-hopper-fp8-sparse-deep-dive.md)).

Meta-point: **Triton vs CUTLASS/CuTe vs hand-written CUDA** is a spectrum: Triton trades peak perf for authorability; CUTLASS/CuTe-DSL and hand-written CUDA (FA3/4, FlashMLA, DeepGEMM) squeeze the last 20–40% at much higher cost — worth it only for the hottest kernels.

## 3. Attention Architecture Variants: MHA → MQA → GQA → MLA

The KV cache is the villain: decode speed is bounded by streaming it from HBM.

- **MHA**: every query head has its own K,V. Max quality, max cache.
- **MQA**: all query heads share one K,V head. ~n_heads× smaller, can degrade long-context retrieval.
- **GQA**: `g` KV heads shared across query groups. GQA-8 recovers nearly all MHA quality. **By 2026 every flagship open model ships GQA.**
- **MLA** ([DeepSeek-V2/V3, arXiv:2412.19437](https://arxiv.org/pdf/2412.19437)): **jointly compress** K,V into one low-rank latent `c_t = W^DKV·h_t` (dim `d_c ≪ n_h·d_h`), cache **only `c`**; reconstruct per-head K,V by up-projection. Cache → ~4–14% of MHA at equal/better quality.

Two subtleties to teach:
1. **Decoupled RoPE.** Low-rank compression is incompatible with RoPE (position-mixing breaks the factorization). MLA splits keys into compressed *content* (no RoPE) + a small *decoupled RoPE* part. A great "why the obvious thing doesn't work" example.
2. **Matrix absorption** ([vLLM MLA analysis](https://simondong1.github.io/mla-decoding.html), [Red Hat](https://www.redhat.com/en/blog/enhancing-deepseek-models-mla-and-fp8-optimizations-vllm)). During decode, absorb up-projections into Q and O weights via associativity, so attention computes **directly on the compressed latent** — converting MLA decode from bandwidth-bound toward compute-bound (more math per byte = good when bandwidth-starved). Prefill uses "materialize"; decode uses "absorb". vLLM: up to 3× throughput, ~9.6× KV capacity (54K→512K tokens on 8×H200).

## 4. Sliding Window, Hybrid Layers, Attention Sinks

- **SWA** (Mistral, Gemma): attend only to last `W` tokens; cache bounded at `W`. Pure SWA loses long-range recall → modern models **interleave**.
- **Hybrid local/global.** **Gemma 3** ([arXiv:2503.19786](https://arxiv.org/pdf/2503.19786)): **5:1** local(1024-SWA):global, KV memory ~60% → <15% of activations at 128K context. Positional trick: **RoPE base 1M on global layers, 10K on local**. **gpt-oss** ([vLLM blog](https://blog.vllm.ai/2025/08/05/gpt-oss.html), [Raschka](https://magazine.sebastianraschka.com/p/from-gpt-2-to-gpt-oss-analyzing-the)): full+SWA(128) at **1:1**, GQA 64Q/8KV, head-dim 64. Llama 4 similar.
- **Attention sinks** ([StreamingLLM lineage; analysis](https://arxiv.org/pdf/2510.06477)): softmax dumps excess probability on the first token(s); evict them and SWA collapses. gpt-oss bakes in a **learnable per-head sink logit** (a head can "attend to nothing"). Serving implication: kernels need explicit sink support; engines need a **hybrid KV allocator** sharing cache between full and SWA layers (vLLM does this to zero fragmentation).

## 5. Sparse & Efficient Long-Context Attention (2025–2026): Production Status

- **NSA (Native Sparse Attention)** ([arXiv:2502.11089](https://arxiv.org/abs/2502.11089), ACL 2025 best paper) — DeepSeek. **Hardware-aligned, natively trainable** (sparsity in the pretraining loop). Three branches per query: **compressed** (block summaries), **selected** (top-block fine-grained), **sliding** (local). Block-wise for memory coalescing.
- **MoBA** (Moonshot/Kimi) — KV blocks as MoE experts; router picks which query-block attends to which KV-blocks.
- **DSA (DeepSeek Sparse Attention)** in **DeepSeek-V3.2-Exp** ([vLLM](https://blog.vllm.ai/2025/09/29/deepseek-v3-2.html), [LMSYS](https://www.lmsys.org/blog/2025-09-29-deepseek-V32/), [API docs](https://api-docs.deepseek.com/news/news250929/)) — **the one that reached production** (Sept 29 2025). **Token-wise**, finer-grained than NSA: a **Lightning Indexer** (ultra-light FP8 scorer over every past token) then **top-k selection** (k≈2048); MLA runs only over those. O(L²) → O(Lk). Shipped with TileLang (research) + CUDA (production) kernels; production forward is FlashMLA, now in cuDNN as [DSA](https://docs.nvidia.com/deeplearning/cudnn/latest/fe-oss-apis/dsa.html). Came with a **>50% API price cut**, day-0 vLLM/SGLang/Ascend support. Note: SGLang's code path is named "nsa" for historical reasons but implements DSA. DeepSeek-V4 followed with day-0 SGLang support ([LMSYS 2026-04](https://www.lmsys.org/blog/2026-04-25-deepseek-v4/)).
- **Verdict to teach: trainable fine-grained sparse attention is production-real, led by DeepSeek — the first genuine break from dense attention at frontier scale.**

## 6. Linear / Hybrid SSM Architectures: The KV-Cache-Free Path

**Mamba/SSM** layers keep a **fixed-size recurrent state** instead of a growing cache — O(1) memory in sequence length, constant-cost decode. Pure SSMs underperform on recall → production uses **hybrids** keeping a few attention layers:

- **Jamba** (early Mamba-Transformer MoE), **Nemotron-H / Nemotron Nano** ([EmergentMind](https://www.emergentmind.com/topics/nemotron-h-architecture)) — Mamba-2 + minority attention.
- **IBM Granite 4.0** — ~9:1 Mamba:Transformer.
- **Qwen3-Next**, MiniMax-Text-01 — linear/hybrid attention at scale.

Engine support: painful V0 hacks until vLLM made hybrids **first-class in V1** ([PyTorch blog](https://pytorch.org/blog/hybrid-models-as-first-class-citizens-in-vllm/)); SGLang added a hybrid-state manager ([Alibaba Cloud](https://www.alibabacloud.com/blog/hybrid-model-support-sglangs-support-scheme-for-hybrid-architecture-models-like-mamba-transformer_602857)). Teach as: attention gives quality, SSM gives cheap long context — the industry mixes rather than chooses.

## 7. Compilation & Launch Overhead: CUDA Graphs, torch.compile, Fusion

Decode runs **hundreds of tiny kernels per token**; at batch-1 **CPU-side launch overhead dominates**.

- **CUDA Graphs** ([Inside vLLM](https://vllm.ai/blog/2025-09-05-anatomy-of-vllm)): record the kernel sequence as a DAG, **replay** in a single launch — eliminates ~25–30% of per-step latency. vLLM captures one graph per (batch, seq-len) bucket at startup, pads to captured shapes. Cost: capture time / cold start ([Foundry](https://arxiv.org/html/2604.06664v1)).
- **torch.compile** ([vLLM blog](https://vllm.ai/blog/2025-08-20-torch-compile), [Red Hat](https://developers.redhat.com/articles/2025/09/03/vllm-torchcompile-efficient-llm-inference-pytorch)): lowers model code to fused Inductor kernels (elementwise, norms, RoPE fused into neighbors). vLLM V1 adds custom fusion passes (e.g. GEMM + collectives via symmetric memory).
- **Piecewise CUDA graphs** — the synthesis: split the graph at attention boundaries (variable-length ops can't be captured), graph the safe pieces, run attention eagerly between replays ([vLLM fusion docs](https://docs.vllm.ai/en/stable/design/fusions/)). The modern default.

## 8. MoE Kernels: Grouped GEMM, DeepEP, Fused MoE

MoE decode: per-expert GEMMs have variable, small M (token count), shared N,K.

- **DeepGEMM** ([GitHub](https://github.com/deepseek-ai/DeepGEMM)) — DeepSeek's FP8 GEMM library, **fine-grained (block/tile) scaling**. Groups **only the M-axis** (N,K fixed — exactly MoE's shape). **Two-level (CUDA-core) accumulation** against FP8 tensor-core error. Fully JIT; ~300-line core kernel; 1350+ FP8 TFLOP/s on Hopper.
- **Fused MoE** — routing + gather + grouped GEMM + scatter fused (Triton kernels in vLLM/SGLang).
- **DeepEP** ([GitHub](https://github.com/deepseek-ai/DeepEP)) — EP **all-to-all dispatch/combine** kernels; asymmetric NVLink↔RDMA forwarding, FP8 dispatch, ~20 SMs saturate the network. Separate high-throughput (prefill) and low-latency (decode) kernel sets. Backbone of large-scale EP ([LMSYS 96×H100](https://www.lmsys.org/blog/2025-05-05-large-scale-ep/)).

Teaching point: at frontier MoE scale the bottleneck shifts from GEMM to **all-to-all communication**; compute-communication overlap matters as much as kernels.

## 9. Position Encodings as a Serving Concern: RoPE Scaling / YaRN

**YaRN** ([arXiv:2309.00071](https://arxiv.org/pdf/2309.00071)): **NTK-by-parts** piecewise frequency interpolation (stretch low-frequency dims, leave high-frequency alone) + attention-temperature rescale. No parameters, works at inference — Qwen/LLaMA-derivatives ship YaRN configs for 4K→32K→128K. **Serving caveat:** with *dynamic* NTK scaling, RoPE must be recomputed each step, which **breaks naive caching of RoPE'd keys** — real tension between context extension and KV reuse.

## 10. Blackwell Specifics: FP4, TMA, What Changes for Kernel Authors

- **NVFP4 vs MXFP4** ([NVIDIA](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/), [Modal almanac](https://modal.com/llm-almanac/block-quants/nvidia-fp4)). Both 4-bit floats with block-shared scales. **MXFP4** (OCP): 32-elem blocks, E8M0 (power-of-two) scale. **NVFP4**: 16-elem blocks + FP8 E4M3 scale + per-tensor FP32 scale — finer, ~88% lower quant error. 5th-gen tensor cores: FP4 at 2×/3× FP8 throughput (GB200/GB300), ~20 PFLOP/s, memory halved vs FP8. Trade-off: MXFP4 = open standard (gpt-oss ships it); NVFP4 = more accurate, NVIDIA-specific.
- **TMA** — async bulk copy HBM↔SRAM without tying up threads; the enabler of FA3/FA4 overlap and TMA-multicast for shared prefixes.
- **For kernel authors:** (1) per-block scaling moves quantization into GEMM epilogue/prologue; (2) tensor cores so fast that **softmax/exp on the SFU is the bottleneck** (hence FA4's FMA exp); (3) authorship shifting to **CuTe-DSL / TileLang / Triton**; (4) **TMEM** (Blackwell on-chip accumulator space) changes result staging.

**Sources:** [FA3](https://arxiv.org/pdf/2407.08608) · [FA2](https://arxiv.org/abs/2307.08691) · [FA4](https://arxiv.org/html/2603.05451v1) / [Together](https://www.together.ai/blog/flashattention-4) · [Flash-Decoding](https://pytorch.org/blog/flash-decoding/) · [FlashInfer](https://arxiv.org/abs/2501.01005) · [FlashMLA](https://github.com/deepseek-ai/FlashMLA) · [DeepSeek-V3](https://arxiv.org/pdf/2412.19437) · [MLA absorb](https://simondong1.github.io/mla-decoding.html) · [Gemma 3](https://arxiv.org/pdf/2503.19786) · [gpt-oss/vLLM](https://blog.vllm.ai/2025/08/05/gpt-oss.html) · [NSA](https://arxiv.org/abs/2502.11089) · [DSA/V3.2](https://blog.vllm.ai/2025/09/29/deepseek-v3-2.html) · [Hybrid models vLLM](https://pytorch.org/blog/hybrid-models-as-first-class-citizens-in-vllm/) · [Inside vLLM](https://vllm.ai/blog/2025-09-05-anatomy-of-vllm) · [torch.compile](https://vllm.ai/blog/2025-08-20-torch-compile) · [DeepGEMM](https://github.com/deepseek-ai/DeepGEMM) · [DeepEP](https://github.com/deepseek-ai/DeepEP) · [YaRN](https://arxiv.org/pdf/2309.00071) · [NVFP4](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/)
