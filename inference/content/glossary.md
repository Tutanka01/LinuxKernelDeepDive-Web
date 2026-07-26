# Glossary

This page is a reference, not a chapter — there is no quiz and nothing here is
meant to be read in order. Every term is defined in one or two sentences and,
where a chapter teaches it properly, linked to that chapter. Come back to it when
a word in the middle of a paragraph has stopped meaning anything.

<dl class="glossary">

<dt>acceptance rate (α)</dt>
<dd>In speculative decoding, the fraction of draft tokens the target model
accepts. It is the single number that decides the speedup, and it depends on both
the draft model's quality and how predictable the text is. See
<a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>all-reduce</dt>
<dd>A collective in which every rank contributes a tensor and every rank receives
the sum. It is the communication pattern of tensor parallelism, executed after
each parallelized matmul. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>all-to-all</dt>
<dd>A collective in which every rank sends a different slice to every other rank.
It is the pattern of expert parallelism: tokens are dispatched to whichever GPUs
host their chosen experts and gathered back. See <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>arithmetic intensity</dt>
<dd>FLOPs performed per byte moved from memory, for a given operation. Compare it
to the ridge point to learn whether that operation is compute-bound or
memory-bound. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>B_crit (critical batch size)</dt>
<dd>The decode batch size at which arithmetic intensity reaches the ridge point
and serving stops being memory-bound — about 280–300 on an H100 in BF16. Below
it, extra requests are nearly latency-free. See
<a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>block table</dt>
<dd>The per-sequence map from logical KV positions to physical block numbers in
the pool. It is a page table by another name, and it is what lets a sequence's KV
cache be physically scattered. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>chunked prefill</dt>
<dd>Slicing a long prompt's prefill into pieces so each piece shares a batch with
ongoing decodes instead of stalling them. It converts one large latency spike
into many small ones. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>collective</dt>
<dd>A communication operation involving a whole group of ranks at once —
all-reduce, all-gather, all-to-all, reduce-scatter. Collectives synchronize, so
the slowest rank sets the pace. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>continuous batching</dt>
<dd>Scheduling at the granularity of one decode step rather than one request, so
finished sequences leave the batch and waiting ones join immediately. The single
largest throughput win in modern serving. See
<a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>CP (context parallelism)</dt>
<dd>Splitting a single sequence's tokens across GPUs so that very long contexts
fit and their attention can be computed in parallel. See
<a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>CUDA graph</dt>
<dd>A pre-recorded sequence of GPU operations replayed as one unit, removing
per-kernel launch overhead from the CPU. Essential for decode, where the kernels
are small and the launch gap would otherwise dominate. See
<a href="#/kernels-and-compilation">Kernels, Graphs &amp; Compilation</a>.</dd>

<dt>decode</dt>
<dd>The phase that generates output tokens one at a time, each conditioned on all
previous ones. Memory-bound, sequential, and the expensive half of serving. See
<a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>DP (data parallelism)</dt>
<dd>Running independent replicas of the whole model and splitting requests
between them. The simplest scaling axis and the one with no communication cost
inside a request. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>draft model</dt>
<dd>A small, fast model that proposes several tokens at once for a large model to
verify in a single pass. Its job is to be right often, not to be good. See
<a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>dtype</dt>
<dd>The numeric type of a tensor's elements — BF16, FP16, FP8, INT8, FP4 — which
sets both how many bytes it occupies and how precisely it represents values. See
<a href="#/quantization">Quantization</a>.</dd>

<dt>EP (expert parallelism)</dt>
<dd>Distributing a Mixture-of-Experts model's experts across GPUs, so each device
holds a few and tokens are routed to them. The parallelism that makes very sparse
models servable. See <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>FFN (feed-forward network)</dt>
<dd>The per-token two-layer network that follows attention in each transformer
block; a synonym for MLP in this context. It holds most of a dense model's
parameters.</dd>

<dt>FP8</dt>
<dd>An 8-bit floating-point format, in two variants: E4M3 (4 exponent, 3 mantissa
bits — used for weights and activations) and E5M2 (wider range, coarser steps).
Native on Hopper and Blackwell, and the 2026 serving default. See
<a href="#/quantization">Quantization</a>.</dd>

<dt>GEMM</dt>
<dd>General matrix–matrix multiply, the operation almost all transformer compute
reduces to. When people talk about kernel performance they usually mean GEMM
performance. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>goodput</dt>
<dd>Throughput counting only the requests that met their latency SLO. It is the
production metric, because a request served too late contributes nothing. See
<a href="#/disaggregation">Disaggregated Serving</a>.</dd>

<dt>GQA (grouped-query attention)</dt>
<dd>An attention variant in which several query heads share one key/value head,
cutting KV cache size by the sharing ratio at little quality cost. Llama-3 shares
8 KV heads across 64 query heads. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>HBM</dt>
<dd>High-bandwidth memory: the GPU's main memory — 80 GB at 3.35 TB/s on an H100.
Large and fast in absolute terms, and still far too slow to keep the compute units
busy during decode. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>InfiniBand</dt>
<dd>The high-performance interconnect used between nodes in a GPU cluster,
typically ~50 GB/s per node at NDR. Roughly 20–40× slower than NVLink inside a
node, which is why the node boundary shapes every parallelism decision. See
<a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>ITL (inter-token latency)</dt>
<dd>The instantaneous gap between two consecutive output tokens. Often used
interchangeably with TPOT, but TPOT is an average while ITL can spike when the
scheduler reshuffles the batch. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>KV cache</dt>
<dd>The stored key and value vectors of every token processed so far, kept so
attention does not have to recompute them at every step. It grows with context
length and concurrency, and it usually — not the weights — caps how many requests
you can serve at once. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>LoRA</dt>
<dd>Low-rank adaptation: a small pair of matrices that modifies a frozen base
model's behavior, cheap enough that many adapters can be served from one set of
base weights. See <a href="#/agentic-serving">The Agentic Era</a>.</dd>

<dt>MBU (model bandwidth utilization)</dt>
<dd>Achieved bytes/second divided by peak memory bandwidth. The right utilization
meter for decode, where the ceiling of 100% is meaningful; real values are around
50–60% at batch 1. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>MFU (model FLOPs utilization)</dt>
<dd>Achieved FLOP/s divided by peak FLOP/s. The right meter for prefill; real
dense prefill runs 35–55%. A low decode MFU means you are reading the wrong
gauge, not that the GPU is broken. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>MHA (multi-head attention)</dt>
<dd>The original attention design, with one key/value head per query head. The
most expressive and by far the most expensive in KV cache bytes. See
<a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>MLA (multi-head latent attention)</dt>
<dd>DeepSeek's design, which caches a single compressed latent vector per token
instead of full keys and values, cutting KV to roughly 70 KB/token on a 61-layer
model. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>MLP</dt>
<dd>Multi-layer perceptron — the dense feed-forward block inside each transformer
layer, and where most of a dense model's parameters and FLOPs live. Used
interchangeably with FFN.</dd>

<dt>MoE (mixture of experts)</dt>
<dd>An architecture where each token is routed to a few of many expert FFNs, so
active parameters are far fewer than total ones. Use active parameters for FLOPs
and total for memory. See <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>MQA (multi-query attention)</dt>
<dd>Attention with a single key/value head shared by all query heads — the
smallest possible KV cache, at some quality cost. GQA is the compromise between
this and MHA. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>MXFP4</dt>
<dd>The open OCP microscaling 4-bit format: an E2M1 element with one power-of-two
(E8M0) scale shared across 32 elements, or 4.25 bits per weight. Portable, and
coarse enough that one outlier drags a whole block. See <a href="#/quantization">Quantization</a>.</dd>

<dt>NCCL</dt>
<dd>NVIDIA's collective communications library — the implementation of all-reduce
and friends that every distributed inference stack calls into, topology-aware
across NVLink and InfiniBand. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>NVFP4</dt>
<dd>NVIDIA's Blackwell-native 4-bit format: an E2M1 element with an FP8 (E4M3)
scale over 16 elements plus a global FP32 factor, or 4.5 bits per weight. More
metadata than MXFP4, markedly less error. See <a href="#/quantization">Quantization</a>.</dd>

<dt>NVLink</dt>
<dd>NVIDIA's intra-node GPU interconnect — 900 GB/s per GPU on an H100. The cliff
between it and the inter-node network is what makes an NVLink domain the natural
unit of tensor parallelism. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>PagedAttention</dt>
<dd>vLLM's technique of storing the KV cache in fixed-size blocks indexed by a
block table, rather than one contiguous reservation per sequence. Virtual memory,
rediscovered on a GPU. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>point-to-point</dt>
<dd>Communication between exactly two ranks, as opposed to a collective. Pipeline
parallelism and KV transfer between disaggregated pools are point-to-point, which
is why they tolerate a slower fabric than tensor parallelism does. See
<a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>PP (pipeline parallelism)</dt>
<dd>Splitting a model by layers across GPUs, each stage passing activations to
the next. Cheap in communication, but it introduces pipeline bubbles that hurt
latency. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>preemption</dt>
<dd>The scheduler evicting a running sequence — swapping or dropping its KV cache
— to free blocks for others, then resuming it later. The pressure valve when the
KV pool is exhausted. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>prefill</dt>
<dd>The phase that processes the whole input prompt at once to produce the first
output token and populate the KV cache. Compute-bound, parallel, and cheap per
token. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>prefix caching</dt>
<dd>Reusing the KV cache of a prompt prefix that has been seen before — a shared
system prompt, a retrieved document, a growing agent conversation — so its prefill
is skipped entirely. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>PTQ (post-training quantization)</dt>
<dd>Quantizing a finished model using a small calibration set, with no retraining.
Minutes to hours of compute, and sufficient for 8-bit and usually for 4-bit
weight-only. See <a href="#/quantization">Quantization</a>.</dd>

<dt>QAT (quantization-aware training)</dt>
<dd>Simulating quantization during training or fine-tuning so the weights learn to
survive it. Expensive, and the only reliable rescue below 4 bits. See
<a href="#/quantization">Quantization</a>.</dd>

<dt>quantization</dt>
<dd>Representing weights, activations, or the KV cache in fewer bits to move fewer
bytes. The largest single lever on decode latency and on how much fits in a GPU.
See <a href="#/quantization">Quantization</a> and
<a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>RadixAttention</dt>
<dd>SGLang's prefix cache built on a radix tree of token sequences, so shared
prefixes are found and reused automatically across requests rather than being
declared. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>ridge point</dt>
<dd>The arithmetic intensity at which a device stops being memory-bound and starts
being compute-bound, equal to peak FLOP/s ÷ peak byte/s — about 295 FLOP/byte on
an H100. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>roofline</dt>
<dd>The model that plots achievable performance against arithmetic intensity, with
a bandwidth-limited slope meeting a compute-limited ceiling at the ridge point.
The organizing picture of the whole course. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>SM (streaming multiprocessor)</dt>
<dd>The GPU's independent processing unit; an H100 has 132 of them, each with its
own registers, shared memory, and tensor cores. Work is distributed across SMs in
blocks. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>speculative decoding</dt>
<dd>Having a cheap draft propose several tokens and the target model verify them
in one forward pass, accepting the longest correct prefix. Provably lossless, and
it stops helping at large batch sizes. See <a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>tensor core</dt>
<dd>The specialized matrix-multiply unit inside each SM. It provides nearly all of
a modern GPU's FLOP/s, and it supports only certain dtypes — which is why FP8
needs Hopper and FP4 needs Blackwell. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>TP (tensor parallelism)</dt>
<dd>Splitting each weight matrix across GPUs so every device computes part of
every layer. It cuts both latency and per-GPU memory, at the cost of an all-reduce
per layer — so it wants NVLink. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>TPOT (time per output token)</dt>
<dd>The average steady-state gap between output tokens, `(e2e − TTFT) / (output
tokens − 1)`. The metric that describes how fast a response feels once it has
started. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>TTFT (time to first token)</dt>
<dd>Time from request arrival to the first token reaching the user: queueing plus
prefill. It grows with prompt length and is the metric prefix caching most
directly improves. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>warp</dt>
<dd>A group of 32 threads on an SM that execute in lockstep. Divergent branches
within a warp serialize, which is why GPU code is written to keep a warp doing one
thing. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

</dl>
