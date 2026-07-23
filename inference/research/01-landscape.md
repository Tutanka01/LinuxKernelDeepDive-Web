# Research dossier — Axis 1: The LLM Inference Education Landscape (mid-2026)

> Opus research agent report, 2026-07-23. Gap analysis for positioning the course.

Scope: resources that teach LLM **inference/serving engineering** — the systems, math, and optimizations behind running trained models, not training or app-layer RAG/prompting.

---

## 1. Books & Handbooks

### LLM Inference Handbook (Modular, formerly BentoML)
- URL: https://handbook.modular.com/ (redirected from https://bentoml.com/llm/); source https://github.com/bentoml/llm-inference-handbook
- **Notable change:** as of mid-2026 the BentoML handbook now redirects to and is published under **Modular** at handbook.modular.com — a rebrand/acquisition worth flagging.
- **Covers:** Foundations (what inference is, training vs inference, CPU/GPU/TPU hardware, TTFT/TPOT/throughput metrics) → Planning deployment → Model preparation → Model interaction → Inference optimization (continuous batching, prefix caching, speculative decoding) → Kernel optimization (GPU architecture) → Infra & operations (InferenceOps, autoscaling, BYOC/on-prem). Ships **interactive calculators, batching simulators, memory/hardware comparison tools**.
- **Depth:** intermediate. Glossary + guidebook hybrid; strong as a reference lookup table, breadth over rigor.
- **Does well:** the single most complete free "everything in one place" reference; interactive tools; genuinely covers Ops (SLOs, monitoring).
- **Thin/outdated:** shallow on derivations (no roofline math worked end-to-end), light on MoE serving internals, disaggregation treated briefly. Vendor-adjacent framing. Not a "learn from zero with exercises" text.

### How To Scale Your Model — Google DeepMind (the "JAX/TPU scaling book")
- URL: https://jax-ml.github.io/scaling-book/ ; inference chapter https://jax-ml.github.io/scaling-book/inference/ ; GPU chapter https://jax-ml.github.io/scaling-book/gpus/ ; notes https://ss.ekzhang.com/p/abridged-notes-on-the-llm-scaling
- **Covers (inference-relevant):** Ch.7 "All About Transformer Inference" (latency vs throughput, KV cache math, disaggregated serving, roofline), Ch.8 "Serving LLaMA 3 on TPUs", Ch.12 "How to Think About GPUs" (added 2025).
- **Depth:** high / rigorous. The gold standard for **arithmetic-first** reasoning (FLOPs, bandwidth, arithmetic intensity, rooflines, parallelism cost models).
- **Thin/outdated:** **TPU/JAX-first** — no CUDA/Triton kernels, no vLLM/SGLang, no quantization depth, no serving-stack engineering (schedulers, batching implementations, Ops).

### The Ultra-Scale Playbook — Hugging Face
- URL: https://huggingface.co/spaces/nanotron/ultrascale-playbook
- 5D parallelism, ZeRO, kernels — based on 4000+ experiments up to 512 GPUs. **Training-focused**; essentially no dedicated inference serving.

### O'Reilly / trade books
- **Designing Large Language Model Applications** (Suhas Pai, 2025) — genuine inference-optimization chapter but app-developer altitude.
- **LLMs in Production** (Manning) — MLOps/deployment, light on kernel/algorithmic internals.
- **LLM Engineer's Handbook** (Packt) — inference is one late chapter, shallow.
- **Verdict:** no trade book is a rigorous, up-to-date inference-*engineering* textbook.

### Modal's LLM Engineer's Almanac
- URL: https://modal.com/llm-almanac/summary — empirical benchmark atlas (TTFT/ITL/QPS across vLLM/SGLang/TensorRT-LLM). Data-driven reference, not a teaching text.

---

## 2. University & Online Courses

- **CMU 15-779 Advanced Topics in ML Systems (LLM Edition)** — GPU programming, compilers, serving: batching, PagedAttention, RadixAttention, speculative decoding. Graduate depth, lecture-slide format, not beginner-accessible.
- **CMU 11-868 LLM Systems** — quantization (GPTQ), MoE, compilers, serving (vLLM, CacheGen).
- **Stanford CS336 Language Modeling from Scratch (2025)** — https://cs336.stanford.edu/ — excellent kernels/GPU lectures + assignments, but inference is ~1 of ~19 lectures.
- **Berkeley LLM Agents**, **MLSys open course** (https://mlsyscourse.org/), Coursera offerings — either agent-focused, general, or Ollama-level beginner.

---

## 3. Canonical Blog Series (the de-facto curriculum)

- **kipply — Transformer Inference Arithmetic** (2022) — https://kipp.ly/transformer-inference-arithmetic/ — foundational KV-cache + memory-bound derivations. Dated (pre-vLLM, pre-MoE, no continuous batching).
- **Yao Fu — Towards 100x Speedup** (2024) — https://yaofu.notion.site/Towards-100x-Speedup-Full-Stack-Transformer-Inference-Optimization-43124c3688e14cffaf2f1d6cbdf26c6c — best single mental map of the taxonomy of fixes. Snapshot, not maintained.
- **Aleksa Gordić — Inside vLLM** (Sep 2025) — https://www.aleksagordic.com/blog/vllm — the most in-depth code-level walkthrough of a real engine (scheduler, paged attention, continuous batching, chunked prefill, prefix caching, spec decode, serving layer). vLLM-specific, assumes priors. HN: https://news.ycombinator.com/item?id=46741285
- **PyTorch — GPT, Fast** (2023) — https://pytorch.org/blog/accelerating-generative-ai-2/ — torch.compile, quant, spec decode, TP in <1000 LOC (gpt-fast). 2023-era, single-request focus.
- **Hazy Research** — megakernels: https://hazyresearch.stanford.edu/blog/2025-05-27-no-bubbles ; ThunderKittens 2.0 https://hazyresearch.stanford.edu/blog/2026-02-19-tk-2 ; TP megakernels https://hazyresearch.stanford.edu/blog/2025-09-28-tp-llama-main — engines use ≤50% of H100 bandwidth due to launch overhead. Advanced/niche.
- **SemiAnalysis — InferenceMAX** — https://inferencex.semianalysis.com/blog/inferencemax-open-source-inference-benchmarking ; vLLM Blackwell https://blog.vllm.ai/2025/10/09/blackwell-inferencemax.html — the economics angle.
- **Databricks — LLM Inference Performance Engineering** — https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices — practical, slightly dated.
- **Modal — High-Performance LLM Inference + GPU Glossary** — https://modal.com/docs/guide/high-performance-llm-inference , https://modal.com/gpu-glossary — excellent GPU-architecture glossary.

---

## 4. Official Docs Serving as Textbooks

- **vLLM** — https://docs.vllm.ai/ + https://blog.vllm.ai/ — authoritative but reference-structured.
- **TensorRT-LLM** — disagg serving https://nvidia.github.io/TensorRT-LLM/features/disagg-serving.html — dense, hardware-specific.
- **NVIDIA Dynamo** — https://docs.nvidia.com/dynamo/latest/ — the modern disaggregation reference; vendor docs, not pedagogy.
- **SGLang** — https://docs.sglang.ai/ — RadixAttention, structured generation.

---

## 5. Survey Papers

- **Taming the Titans: A Survey of Efficient LLM Inference Serving** (2025) — https://arxiv.org/abs/2504.19720 — most current comprehensive survey.
- **LLM Inference Serving: Survey of Recent Advances and Opportunities** (2024) — https://arxiv.org/pdf/2407.12391
- **Towards Efficient LLM Serving: System-Aware KV Cache Optimization survey** (2025) — https://arxiv.org/pdf/2607.08057
- **Efficient Large Language Models: A Survey** (TMLR 2024) — https://github.com/AIoT-MLSys-Lab/Efficient-LLMs-Survey
- **Full-Stack Optimization of Transformer Inference** (2023) — https://arxiv.org/pdf/2302.14017

---

## 6. What Learners Complain Is Missing (Reddit/HN signal)

- **No single coherent path.** The real curriculum is a scavenger hunt: kipply → Yao Fu → scaling book → Aleksa's vLLM post → scattered docs. Repeated "where do I start" threads.
- **Quantization is a perennial confusion.** GGUF vs GPTQ vs AWQ vs FP8/INT4 — no rigorous source ties quant math to the roofline pedagogically.
- **Concept→code gap.** People understand "PagedAttention" conceptually but not how scheduler + block allocator + kernel fit together.
- **Consumer/local + single-request latency underserved** (llama.cpp/Ollama, single-GPU, offloading).
- **Stale fundamentals** — much material predates MoE-dominant serving, disaggregation, chunked prefill, FP8/Blackwell, long-reasoning workloads.
- **Missing Ops/economics bridge** — few resources connect kernel facts to $/token, SLOs, capacity planning.

---

## 7. Gap Analysis — What "The Best Inference Course" Must Do

The field has **excellent scattered parts and no coherent whole.** No existing resource is simultaneously (a) sequenced from zero, (b) arithmetic-rigorous, (c) GPU-first and vendor-neutral, (d) concept-to-real-code, (e) current to mid-2026.

| Axis | Best-in-class today | What's missing |
|---|---|---|
| Arithmetic rigor | Scaling book | TPU/JAX-centric, no serving stack |
| Real-engine code | Aleksa/vLLM post | vLLM-only, assumes priors |
| Breadth+Ops | Modular/BentoML handbook | shallow derivations |
| Kernels frontier | Hazy Research | niche, no scaffolding |
| Economics | SemiAnalysis/Modal | benchmark data, not teaching |
| Sequenced pedagogy | Stanford CS336 | 1 inference lecture, LM-focused |

To genuinely be the best, a new course should:

1. **Be GPU-first and vendor-neutral**, with scaling-book rigor on NVIDIA hardware.
2. **Teach concept→implementation together**: every concept paired with minimal readable code + how vLLM/SGLang do it for real.
3. **Sequence A-to-Z with a spine**: forward pass → memory-bound decode → KV cache → batching → paging → quantization (unified, roofline-tied) → attention kernels → parallelism → speculative decoding → **disaggregation + KV routing** (largely absent from all current teaching material) → MoE serving → schedulers → Ops/SLOs → **economics**.
4. **Cover the mid-2026 frontier**: disaggregation first-class, FP8/Blackwell, long-reasoning serving, MoE/EP, megakernels, structured decoding.
5. **Include the underserved local/single-request regime** and resolve the quantization-format confusion.
6. **Ship interactive tooling** (calculators/simulators) + worked exercises.
7. **Stay maintained/dated-honest**: pin a snapshot; the #1 decay mode is silent staleness.

The clearest white space: **a rigorous, sequenced, GPU-first serving-systems textbook that treats disaggregation, quantization economics, MoE/long-decode serving, and real-engine code as core.**
