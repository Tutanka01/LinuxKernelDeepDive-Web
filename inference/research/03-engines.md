# Research dossier — Axis 3: Inference Engine Internals (mid-2026)

> Opus research agent report, 2026-07-23. Evidence-quality caveats at the end.

## 1. The foundation: iteration-level scheduling (Orca) and continuous batching

The conceptual bedrock of every modern serving engine is **iteration-level scheduling**, introduced by **Orca** (Yu et al., OSDI 2022, SNU/FriendliAI). Naive "request-level" batching processes a fixed batch to completion: a request that finishes early cannot return, and a new request waits for the whole batch to drain — catastrophic for autoregressive generation with wildly different output lengths. Orca schedules **at the granularity of a single decode iteration**: after each forward pass the scheduler can evict completed sequences and admit waiting ones — now called **continuous batching** ("in-flight batching" at NVIDIA).

Orca's second contribution is **selective batching**: attention cannot be naively batched across different-length sequences, so batching applies only where safe (the big GEMMs — QKV projection, MLP) while attention is computed per-sequence. Anyscale's 2023 benchmark measured up to **23x throughput** vs naive batching.

Sources: [Orca OSDI'22](https://www.usenix.org/conference/osdi22/presentation/yu), [FriendliAI](https://friendli.ai/research/orca), [Anyscale](https://www.anyscale.com/blog/continuous-batching-llm-inference).

## 2. PagedAttention and the KV-cache memory problem

**PagedAttention** (Kwon et al., SOSP 2023), vLLM's founding idea. Problem: KV cache grows one token at a time to an unknown final length; contiguous max-length reservation causes massive **internal and external fragmentation** — pre-PagedAttention systems wasted 60–80% of KV memory.

Solution borrows OS virtual memory: partition each sequence's KV cache into fixed-size **blocks** (default **16 tokens**), map logical→physical blocks via a per-sequence **block table**, allocate on demand from a shared pool. Fragmentation drops below one block per sequence (<4%). Block size: `2 (K/V) × block_size × num_kv_heads × head_size × dtype_bytes`. Blocks enable **copy-on-write sharing** for beam search / parallel sampling. The free pool (`free_block_queue`) commonly holds hundreds of thousands of blocks.

Sources: [PagedAttention SOSP'23](https://en.wikipedia.org/wiki/PagedAttention), [Inside vLLM](https://vllm.ai/blog/2025-09-05-anatomy-of-vllm).

## 3. The vLLM V1 rewrite (Jan 2025) — what changed and why

V0 accreted features until scheduling and multimodal paths became hard to extend. **V1** (alpha Jan 27 2025; default by mid-2025) is a ground-up core rewrite, **up to 1.7x higher throughput** on text models (more on VLMs):

- **Isolated `EngineCore` process.** Core loop (scheduler + executor) in its own process, separated from API server / tokenize / detokenize, so CPU-heavy work **overlaps** with GPU execution. vLLM's answer to SGLang's zero-overhead scheduler.
- **Simplified, unified scheduler.** No prefill/decode phase distinction. Each step allocates from a **token budget**; a request is `{request_id: num_tokens}`, uniformly supporting chunked prefill, prefix caching, spec decode. Policies: **FCFS** (default) and **priority**.
- **Chunked prefill on by default.**
- **Prefix caching by default with near-zero cost:** <1% throughput loss at 0% hit rate.
- **Piecewise CUDA graphs** + torch.compile integration (V1 graphs use more memory as a tradeoff).
- **FlashAttention 3** backend for mixed prefill/decode batches; the standalone PagedAttention kernel path was retired — paging lives inside the unified attention backends.
- **TP via multiprocessing** (`MultiProcExecutor`): daemon per rank, shared-memory message queues (`rpc_broadcast_mq`), incremental diffs only.

Sources: [V1 alpha](https://vllm.ai/blog/2025-01-27-v1-alpha-release), [V1 guide](https://docs.vllm.ai/en/stable/usage/v1_guide/), [Inside vLLM](https://vllm.ai/blog/2025-09-05-anatomy-of-vllm).

## 4. Prefix caching: hash-based (vLLM) vs RadixAttention (SGLang)

Chat, few-shot, RAG, and agent workloads share long prefixes; the prefix KV can be computed once and reused.

**vLLM — hash-based.** Each completed 16-token block gets a hash chaining `(previous_block_hash, current_tokens, metadata)` (builtin hash or SHA-256), indexing `cached_block_hash_to_block`. On a prefix match the engine reuses physical blocks and skips recompute. LRU eviction. Nearly free even on misses (post-V1).

**SGLang — RadixAttention.** KV cache stored in a **radix tree** (compressed trie) keyed on token sequences → automatic **prefix-of-a-prefix** sharing, LRU over tree nodes, cache-aware routing. Handles branching conversation trees and partial overlaps more naturally than flat hashing.

**Economics.** For unique prompts the two are within noise. Payoff scales with prefix overlap. Vendor benchmarks claim RadixAttention hits **85–95%** on shared few-shot, **75–90%** multi-turn, up to **6.4x** on prefix-heavy RAG — but these are marketing figures (Spheron/Techsy), not peer-reviewed. The **established** claim: both deliver large TTFT reductions once shared prefix exceeds ~50–60% of tokens; the trie-vs-hash difference matters most for branching/agentic trees.

Sources: [RadixAttention blog](https://www.lmsys.org/blog/2024-01-17-sglang/), [SGLang NeurIPS'24](https://proceedings.neurips.cc/paper_files/paper/2024/file/724be4472168f31ba1c9ac630f15dec8-Paper-Conference.pdf), [Inside vLLM](https://vllm.ai/blog/2025-09-05-anatomy-of-vllm).

## 5. Chunked prefill, prefill–decode interference, scheduling policy

**The interference problem** (formalized by **Sarathi-Serve**, Agrawal et al., OSDI 2024): prefill is compute-bound, decode is memory-bandwidth-bound. Batching a long prefill with ongoing decodes **stalls** the decodes, spiking TBT/ITL; separating them wastes compute. The fundamental throughput-latency tradeoff.

**Chunked prefill** splits a long prompt into near-equal chunks (capped by `long_prefill_token_threshold`) and interleaves chunks with decode tokens in **hybrid batches** — Sarathi's "**stall-free batching**". Default in vLLM V1, available in SGLang. **The alternative is disaggregation** (separate GPU pools; see axis 6).

**Preemption.** When KV memory is exhausted: **recompute** (drop KV, recompute on resume) vs **swap** (copy to CPU RAM). vLLM V1 uses **recompute** by default and deprecated V0's swap — recompute pairs naturally with prefix caching.

Sources: [Sarathi-Serve OSDI'24](https://www.usenix.org/system/files/osdi24-agrawal.pdf), [Beyond the Buzz](https://arxiv.org/pdf/2506.05508).

## 6. SGLang architecture

SGLang (UC Berkeley/LMSYS, NeurIPS 2024; in the **PyTorch ecosystem**). Four pillars:

1. **RadixAttention** (above).
2. **Zero-overhead / overlap scheduler.** Prepares the *next* batch's metadata on CPU while the *current* batch runs on GPU, using **negative-integer slot addresses** as placeholders. Claimed 95–98% GPU utilization (vendor-favorable; the *mechanism* is real and mirrors vLLM V1's isolated EngineCore).
3. **Cache-aware load balancing** via the Rust **sgl-router** — routes to the worker most likely to hold the prefix.
4. **PD disaggregation** built in.

Frontend DSL (`gen`, `select`, `fork`) for multi-call LLM programs whose structure the runtime exploits for KV reuse.

**vs vLLM (2025–2026):** comparisons swing per model/batch/version; both leapfrog constantly. Honest consensus: SGLang often leads on prefix-heavy/agentic/structured workloads; on general serving they are close; vLLM has broader hardware/model coverage and ecosystem. Nearly all cross-engine numbers online are vendor blogs.

Sources: [SGLang joins PyTorch](https://pytorch.org/blog/sglang-joins-pytorch/), [SGLang paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/724be4472168f31ba1c9ac630f15dec8-Paper-Conference.pdf), [CMU LLMSys talk](https://llmsystem.github.io/llmsystem2025spring/assets/files/llmsys-25-sglang-72edc5043338f59db34d47e5b96ac870.pdf).

## 7. Structured / constrained decoding

Engines enforce JSON/regex/grammar output by masking logits each step to grammar-legal tokens:

- **Outlines** — original regex/FSM approach; largely superseded as default.
- **XGrammar** (MLC, 2024) — compiles grammars to a **pushdown automaton**, precomputes adaptive token masks (context-independent vs -dependent tokens), overlaps mask computation with GPU work. Became vLLM's and SGLang's default backend.
- **llguidance** (Microsoft) — fast Rust grammar engine, alternative vLLM backend.
- **Jump-forward decoding** — when the grammar makes next tokens **deterministic** (e.g. `"name":` in a JSON schema), skip the forward pass and append the fixed string directly.
- **XGrammar-2** (Jan 2026) — agentic focus: **Structural Tag** protocol (Harmony format, tool-calling, reasoning channels), **TagDispatch** for mid-stream grammar switching, **Cross-Grammar Cache**. Claimed >6x tool-calling compile speedup. In vLLM, SGLang, TensorRT-LLM, MLC-LLM.

Sources: [XGrammar](https://arxiv.org/pdf/2411.15100), [XGrammar-2](https://arxiv.org/abs/2601.04426), [MLC blog](https://blog.mlc.ai/2026/05/04/xgrammar-2-fast-customizable-structured-generation), [vLLM structured decoding](https://vllm.ai/blog/2025-01-14-struct-decode-intro), [SqueezeBits benchmark](https://blog.squeezebits.com/guided-decoding-performance-vllm-sglang).

## 8. Speculative decoding — the engine/scheduler side

- **Batched verification**: each step processes a *variable* number of candidate tokens per sequence; token budget and attention masks must handle **tree/branch** candidates (EAGLE-style), not flat sequences.
- **KV bookkeeping**: draft KV for rejected tokens must be rolled back / not committed.
- **vLLM V1**: spec decode folded into the unified scheduler via the same `{request_id: num_tokens}` abstraction; EAGLE/EAGLE-3 first-class. **Speculators** library (v0.3.0, Dec 2025) standardizes draft-model packaging.
- **Key scheduling caveat**: speculation helps at **low batch/low utilization**; under high load it can *hurt* throughput — mature engines gate it dynamically on batch size.

Sources: [vLLM PR #15334](https://github.com/vllm-project/vllm/pull/15334), [Speculators v0.3.0](https://blog.vllm.ai/2025/12/13/speculators-v030.html), [docs](https://docs.vllm.ai/en/latest/features/spec_decode/).

## 9. Multi-LoRA serving and sleep/wake for RL

**Multi-LoRA:**
- **Punica** (2023) — **SGMV** kernel (Segmented Gather Matrix-Vector) batches different adapters in one call; ~12x throughput at ~2ms/token overhead.
- **S-LoRA** (2023) — **Unified Paging**: one paged pool holds KV cache *and* adapter weights of varying rank; adapters in host RAM, paged to GPU on demand. Thousands of adapters on one GPU.
- vLLM and SGLang adopted these operators (static HBM allocation + LRU adapter eviction).

**Sleep/wake for RL.** RLHF/GRPO loops alternate generation and training on the same GPUs. Engines added **sleep mode**: free KV cache, optionally offload weights to host, keep server alive, **wake** for next rollout. SGLang has fine-grained sleep/wake; vLLM has sleep + in-place **weight update** APIs. Open pain point: weight resync on wake without OOM from duplicate GPU copies (vLLM RFC #15254).

Sources: [S-LoRA](https://arxiv.org/abs/2311.03285), [Punica](https://arxiv.org/pdf/2310.18547), [SGLang LoRA](https://docs.sglang.io/advanced_features/lora.html), [SGLang RL](https://github.com/sgl-project/sglang/blob/main/docs/advanced_features/sglang_for_rl.md), [vLLM RLHF](https://docs.vllm.ai/en/stable/training/rlhf/).

## 10. The 2025–2026 engine landscape

| Engine | Status mid-2026 | Niche |
|---|---|---|
| **vLLM V1** | Default, dominant OSS engine | General high-throughput serving; de-facto standard |
| **SGLang** | PyTorch ecosystem; heavy production use | Prefix-heavy, structured, agentic, RL rollouts |
| **TensorRT-LLM** | Active; now a **Dynamo backend** | Max perf on NVIDIA |
| **NVIDIA Dynamo** | 1.0 shipped | Datacenter orchestration: disagg P/D, KV-aware routing |
| **TGI (HuggingFace)** | **Maintenance mode Dec 2025; archived read-only Mar 2026** | EOL — migrate off |
| **LMDeploy (InternLM)** | Active (v0.12–0.13) | TurboMind kernels; DeepSeek PD-disagg via DLSlime/Mooncake |
| **llama.cpp / Ollama** | Thriving | Edge/local, GGUF quant |
| **MLC-LLM** | Active | TVM-compiled; widest device matrix |
| **Modular MAX** | Commercial, growing | Mojo-based portable stack |

TGI's archival marks OSS consolidation around **vLLM and SGLang**. Research (Beyond the Buzz 2025, Nexus 2025) cautions disaggregation only wins above certain scale/SLO regimes — below that, colocated chunked prefill is simpler and competitive.

Sources: [Dynamo TRT-LLM backend](https://docs.nvidia.com/dynamo/backends/tensor-rt-llm), [TGI archived](https://github.com/huggingface/text-generation-inference/releases), [LMDeploy](https://github.com/internlm/lmdeploy), [Engine survey](https://arxiv.org/pdf/2505.01658).

## 11. What actually runs in production (public info)

- **xAI (Grok)** — publicly uses **SGLang**; SGLang cites 400,000+ GPUs across its user base.
- **Microsoft Azure** — publicly serves **DeepSeek R1 on AMD GPUs via SGLang**.
- **DeepSeek** — its **own** open-sourced stack (FlashMLA, DeepEP, DeepGEMM, EPLB, 3FS; Feb 2025 Open Source Week), heavy EP MoE + PD disaggregation.
- **Together / Fireworks / Baseten** — customized forks/proprietary stacks on the vLLM/SGLang/TRT-LLM lineage + in-house kernels. Baseten is a public Dynamo partner.
- **Groq / Cerebras** — bespoke hardware, fully custom stacks.
- **OpenAI / Anthropic / Google** — proprietary internal stacks; **no reliable public confirmation** that OpenAI or Anthropic serve production traffic on vLLM. Treat any unsourced "Lab X uses vLLM" claim as unverified.

## Evidence-quality caveats

- **Trust (peer-reviewed/primary):** Orca, PagedAttention, Sarathi-Serve, S-LoRA, Punica, SGLang, XGrammar papers; official vLLM/SGLang blogs/docs.
- **Vendor marketing blogs** are the source of most "29% faster / 6.4x / 95% hit-rate" figures — directionally useful, methodologically opaque. Robust consensus is only: (a) vLLM V1 and SGLang are close on generic serving, (b) SGLang tends to lead on prefix-heavy/structured/agentic, (c) exact deltas flip frequently.
- **Production-stack claims** — only xAI→SGLang and Azure→SGLang-for-DeepSeek are cleanly public.
