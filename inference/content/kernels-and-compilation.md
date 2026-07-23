# Kernels, Graphs & Compilation

> **Goal of this chapter:** understand everything between "here is the model
> and here is FlashAttention" and "the GPU runs fast." You'll learn what a
> kernel actually is, why launching hundreds of tiny ones per token starves
> the GPU (it's a syscall-overhead story you already know), how CUDA graphs
> and `torch.compile` fix it, who writes kernels and in what language, and
> what Blackwell changes. After this chapter, the phrase "we captured
> piecewise CUDA graphs with torch.compile" reads as an obvious engineering
> choice, not an incantation.

The [previous chapter](#/flashattention) took one kernel apart down to the
online-softmax recurrence. But attention is a single stop on a long assembly
line. Generating **one token** — a single decode step — runs *hundreds* of
separate GPU kernels: a norm, three matmuls for Q/K/V, a RoPE rotation, the
attention kernel, an output projection, a residual add, another norm, a few
matmuls and an activation for the MLP, more residuals — and that whole list
repeats once per transformer layer, eighty times over for a large model. Then
you do it all again for the next token. This chapter is about the machinery
that makes that torrent of tiny launches fast.

## What a kernel actually is

A **GPU kernel** is a single function written to run across thousands of
threads at once. You write the body once — "multiply this row by that column" —
and the hardware runs tens of thousands of copies of it, one per thread, spread
across the GPU's [streaming multiprocessors](#/gpu-mental-model). Launching a
kernel means the **CPU** puts a work item on a queue (a CUDA *stream*); the
**GPU** picks it up and executes it asynchronously. The CPU does not wait — it
races ahead, queuing the next kernel while the previous one runs.

That division of labor is the whole story of this chapter. The CPU is a
dispatcher; the GPU is the workforce. Everything that follows is about keeping
the workforce from standing idle while the dispatcher fumbles with paperwork.

## The launch-overhead problem is a syscall-overhead problem

Here is the trap, and you have seen its exact shape before. In the kernel
course you learned that a **syscall is cheap in absolute terms but expensive
relative to the work it guards**: crossing the user/kernel boundary costs a
fixed few hundred nanoseconds whether you `read()` one byte or a megabyte. Do a
million one-byte reads and the boundary crossings, not the copying, dominate.
That is why `io_uring` exists — to batch many submissions across the boundary
in one crossing instead of paying the fixed cost per operation.

GPU kernel launches are the same pathology on different hardware. Queuing a
kernel from Python costs a fixed **few microseconds** of CPU work — argument
marshalling, driver call, stream bookkeeping — regardless of how much math the
kernel then does. That fixed cost is your syscall boundary.

Now do the arithmetic that makes it hurt. At **batch size 1**, decode is
brutally [memory-bound](#/inference-arithmetic): each little matmul streams its
weights from HBM and does almost no arithmetic, so the *GPU* finishes a kernel
in a few microseconds. But the *CPU* also needs a few microseconds to launch
the next one. The two are now the same size. String 200 kernels together and
the CPU spends, say, 200 × 5 µs = 1 millisecond just *dispatching* — and for
much of that millisecond the GPU has run dry and sits waiting for its next
instruction. You bought a $30,000 accelerator and it is blocked on a Python
`for` loop.

```text
 Batch 1 decode, launching eagerly (CPU-bound):

 CPU:  [launch A][launch B][launch C][launch D]...   <- back-to-back, saturated
 GPU:   [A]  gap  [B]  gap  [C]  gap  [D]  gap ...    <- starving between kernels
             ^^^^      ^^^^      ^^^^
             GPU idle, waiting for the CPU to catch up
```

The fix is the `io_uring` fix: **stop paying the per-launch cost.** Submit the
whole batch of work in one crossing.

## CUDA graphs: record once, replay in one launch

The kernel sequence for a decode step is almost entirely **fixed**. Same
kernels, same order, same tensor shapes, step after step — only the *numbers*
in the tensors change. So why re-describe it to the driver 200 times per token?

**CUDA graphs** let you describe it once. You run the step once in *capture
mode*: instead of executing, CUDA records every kernel launch and its
dependencies into a **DAG** (directed acyclic graph — the launches, plus which
must finish before which). Then, every subsequent step, you *replay* the graph
with a **single** launch call. All 200 kernels fire on the GPU from one CPU
crossing. The dispatcher's millisecond of paperwork collapses to almost
nothing, and the GPU stops starving.

In production this recovers on the order of **25–30% of per-step decode
latency** ([Inside vLLM](https://vllm.ai/blog/2025-09-05-anatomy-of-vllm)) —
free speed, from doing nothing new, just describing it once.

The catch is in the word *fixed*. A captured graph bakes in the exact tensor
shapes it saw. But batch size changes constantly under
[continuous batching](#/continuous-batching), and the KV history grows every
step. Engines handle each axis differently:

- **Batch size** is discrete and small, so capture a **separate graph per
  bucket** — batch 1, 2, 4, 8, 16, … — at startup. At run time, round the real
  batch up to the nearest captured bucket and **pad** with dummy rows. A few
  wasted rows are far cheaper than launching eagerly.
- **Sequence length** is the problem child. The attention kernel reads a
  KV cache whose length is different for every request and grows every token —
  you cannot bake that shape in.

## Piecewise graphs: capture the static parts, run attention eagerly

The synthesis that shipped is beautifully pragmatic. Split the per-token kernel
sequence **at the attention boundaries**. Everything that isn't attention — the
norms, the projections, RoPE, the MLP, the residuals — has static shapes and
gets captured into CUDA graphs. Attention itself, with its ragged
per-request lengths, runs **eagerly** (launched the normal way) in the gaps
between graph replays.

```text
 Piecewise CUDA graphs (one transformer layer):

 [── graphed: norm + QKV + RoPE ──]  → (eager attention) →  [── graphed: O-proj + MLP + residual ──]
        one replay launch                per-request              one replay launch
```

Attention is a handful of the layer's kernels, and it's the one piece whose
launch cost is amortized anyway (it does real work over the whole KV cache), so
running it eagerly costs little — while the dozens of tiny static kernels around
it, the ones that were actually starving the GPU, get the graph treatment. This
is **vLLM V1's real default configuration**: piecewise CUDA graphs plus
`torch.compile` ([vLLM fusion
docs](https://docs.vllm.ai/en/stable/design/fusions/)).

## torch.compile and fusion: stop round-tripping to HBM

CUDA graphs cut *launch* cost but don't change *what* the kernels do. A
compiler does. `torch.compile` traces your model's Python into a graph and
lowers it to **fused** kernels — and fusion is a direct assault on the
[memory wall](#/inference-arithmetic).

Consider three ops in a row: an RMSNorm, then RoPE, then a residual add. Run
eagerly, each is its own kernel: norm reads the activation from **HBM**, writes
its result back to HBM; RoPE reads that back, writes back; the residual reads it
*again*. The tensor round-trips to slow HBM three times, and each op does almost
no arithmetic per byte moved — textbook bandwidth-bound waste.

**Fuse** them into one kernel and the intermediate never leaves the chip: read
once from HBM, do the norm *and* the rotation *and* the add while the data sits
in registers and SRAM, write once. Recall the roofline: **arithmetic intensity
is FLOPs per byte moved.** Fusion doesn't change the FLOPs but slashes the
bytes, so it *raises arithmetic intensity* — dragging a clump of memory-bound
elementwise ops rightward, toward the compute-bound side where the hardware
actually earns its FLOP rating. That is the whole economic case for a compiler
in this stack.

Beyond the automatic elementwise fusions, engines add **custom passes** for the
fusions a general compiler won't find — for example fusing a GEMM with the
[collective communication](#/parallelism-for-inference) that follows it, so a
matmul and its cross-GPU all-reduce overlap instead of running in series.

## Who writes kernels, and in what language

Nobody hand-writes all of this. There's a spectrum, trading authoring effort
against how close you get to the hardware's peak.

| Tool | Feel | Peak reached | Who uses it |
|---|---|---|---|
| **Triton** | Python-ish; you write tile logic, it handles the rest | ~80% | Most engine kernels (fused MoE, elementwise, many attention paths) |
| **CUTLASS / CuTe-DSL** | C++ template metaprogramming, or its new Python DSL | near-peak | The hottest matmul/attention (FlashAttention-4) |
| **Hand CUDA / PTX** | raw C/assembly, every detail manual | the last 20% | Only the single hottest paths (FlashMLA, DeepGEMM) |

**Triton** ([OpenAI](https://openai.com/index/triton/)) lets you write a kernel
in something close to Python — you reason about *tiles* of data, and the
compiler handles thread assignment, memory coalescing, and scheduling. You give
up maybe 20% of peak; you get a kernel a human can write and maintain in an
afternoon. Most kernels in a modern engine are Triton, and 80% of peak on 90%
of your kernels is a fantastic trade.

**CUTLASS/CuTe** and **hand-written CUDA** buy back that last slice for the few
kernels hot enough to deserve weeks of effort. FlashAttention-4 is written in
**CuTe-DSL**, CUTLASS's new *Python* kernel DSL — and that's the industry's
direction. The old CUTLASS was C++ template metaprogramming whose compiles could
take minutes and whose errors filled the screen; the Python DSLs compile
**~20–30× faster** and let a researcher iterate at Python speed while still
emitting near-peak code ([FlashAttention-4
reverse-engineering](https://modal.com/blog/reverse-engineer-flash-attention-4)).
The pain being engineered away is *compile-time pain* — the reason kernel work
was slow was as much the C++ toolchain as the GPU.

## MoE kernels: many tiny matmuls with awkward shapes

A quick primer, since [MoE serving](#/moe-serving) gets its own chapter. A
**Mixture-of-Experts** MLP replaces the one big feed-forward block with *many*
smaller "expert" MLPs, and a lightweight **router** sends each token to just a
few of them (say 8 of 256). Most experts see most tokens *not at all*. Same
total parameters on disk, far fewer touched per token.

That routing wrecks the GEMM shapes. A normal MLP is one fat matmul — a big
`M × K` times `K × N`, exactly what tensor cores love. Under MoE, each expert
gets a *variable and tiny* number of tokens: expert 3 might get 5 tokens this
step, expert 7 might get 200. You now have hundreds of little matmuls that share
the `N,K` dimensions but each have their own small, unpredictable `M`. Launched
naively that's hundreds of tiny kernels — the launch-overhead problem, back with
a vengeance.

**Grouped GEMM** is the answer: one kernel that does all the per-expert matmuls
together, grouping *along the M axis* (variable token counts) while `N` and `K`
stay fixed — which is *exactly* MoE's shape. **DeepGEMM**
([GitHub](https://github.com/deepseek-ai/DeepGEMM)) is DeepSeek's FP8 grouped-GEMM
library and it ties directly back to the [quantization
chapter](#/quantization). Recall the accumulation problem: FP8 tensor cores add
products in low precision, and errors pile up across a long `K` dimension.
DeepGEMM uses **two-level accumulation** — let the tensor cores accumulate a
short run fast, then periodically promote that partial sum into a full-precision
FP32 accumulator on the CUDA cores, so error can't snowball. It carries
**fine-grained block scaling** (a separate scale per small block of the tensor,
also from the quantization chapter), is fully **JIT-compiled**, and its core is
about **300 lines** — one of the most-studied kernels in the field.

**Fused MoE** goes further: fuse routing + gathering each expert's tokens +
the grouped GEMM + scattering results back into one kernel, so the giant
permutation of tokens-to-experts is never *materialized* in HBM. And once MoE
scales across many GPUs, the bottleneck stops being the matmuls and becomes the
**all-to-all** shuffle of tokens to whichever GPU holds their expert —
**DeepEP** ([GitHub](https://github.com/deepseek-ai/DeepEP)) is DeepSeek's
library of those communication kernels. That's the
[MoE-serving](#/moe-serving) chapter's story; here just note that the kernel and
the network become one problem.

## Blackwell: what actually changes for kernels

NVIDIA's Blackwell generation moves several things kernel authors used to do by
hand into the hardware:

- **TMA (Tensor Memory Accelerator)** — a hardware DMA engine for *tiles*. It
  bulk-copies a block of data HBM↔SRAM asynchronously, without tying up the
  threads that used to babysit the transfer. This is what lets a kernel *compute*
  on one tile while the *next* tile is still in flight — the overlap that
  FlashAttention-3 and -4 are built on.
- **FP4 tensor cores with hardware block scaling** — the 5th-gen tensor cores
  do 4-bit-float matmuls at 2–3× FP8 throughput, and the **per-block dequant
  scale is applied by the hardware in the GEMM prologue**. Quantization stops
  being a separate kernel step and moves *inside* the matmul.
- **TMEM (Tensor Memory)** — a dedicated on-chip space for accumulators,
  changing where and how kernels stage partial results.

And a genuinely funny consequence: the tensor cores got *so* fast that a piece
of attention nobody worried about became the bottleneck. Attention's softmax
needs an `exp()` per score, computed on the **Special Function Unit (SFU)** — a
small, slow corner of the GPU. When the matmuls ran at "normal" speed the SFU
kept up; at Blackwell tensor throughput the `exp()`s can't be produced fast
enough, and the mighty tensor cores stall waiting on them. FlashAttention-4's
fix is to stop using the SFU: compute `exp()` with a **polynomial
approximation** on the ordinary FMA/CUDA cores, which now have spare capacity.
The [FlashAttention chapter](#/flashattention) meets this trick from the
attention side; from the kernel side it's a clean lesson — *make one part 10×
faster and the bottleneck simply moves somewhere you never profiled.*

> **State of play (mid-2026):** even a replayed CUDA graph leaves small bubbles
> between kernels, and the boundaries between kernels still force intermediate
> results out to HBM. The frontier response is the **megakernel** — fuse the
> *entire* forward pass into a single kernel, no launches and no HBM hand-offs
> at all. Hazy Research reports that today's engines use as little as **~50% of
> an H100's memory bandwidth**, with these inter-kernel gaps a chief suspect
> ([Hazy Research, "megakernels"](https://hazyresearch.stanford.edu/blog/2025-05-27-no-bubbles)).
> This is research-grade and brittle to write — but it's the logical endpoint
> of everything in this chapter: if launch overhead is death, launch *once*.

## What to remember

- A **kernel** is one function run across thousands of GPU threads; the **CPU
  queues** launches, the **GPU** executes them asynchronously. One decode step
  is *hundreds* of small kernels.
- **Launch overhead is syscall overhead.** A launch costs a fixed few
  microseconds of CPU work no matter how little the kernel does; at batch 1 the
  GPU finishes each tiny kernel just as fast, so the CPU dispatcher becomes the
  bottleneck and the GPU starves. `io_uring` batched submissions; CUDA graphs do
  the same thing here.
- **CUDA graphs** record the fixed per-token DAG once and **replay it in one
  launch** (~25–30% of decode latency back). Graphs need fixed shapes, so
  engines capture **per-batch-size buckets** and pad; variable-length
  **attention runs eagerly** between graph replays — **piecewise graphs**, vLLM
  V1's default with `torch.compile`.
- **Fusion** (via `torch.compile`) merges elementwise ops so intermediates
  never round-trip to HBM — **raising arithmetic intensity**, the roofline made
  actionable.
- **Authorship spectrum:** **Triton** (Python-ish, ~80% of peak, most kernels)
  → **CUTLASS/CuTe-DSL** (near-peak, FA4) → **hand CUDA/PTX** (the last 20%,
  FlashMLA/DeepGEMM). The field is moving to Python DSLs to kill compile-time
  pain.
- **MoE** turns one fat matmul into many tiny variable-`M` ones; **grouped
  GEMM** / **DeepGEMM** (FP8, block scaling, two-level accumulation) and
  **fused MoE** handle the shape and skip materializing permutations.
- **Blackwell** hands kernel authors **TMA** (async tile DMA), **FP4 tensor
  cores with hardware block scaling** (dequant inside the GEMM), and **TMEM** —
  and made tensor cores so fast that softmax's `exp()` became the bottleneck.

```quiz
[
  {
    "q": "At batch size 1, why does launching hundreds of kernels per token leave an expensive GPU sitting idle?",
    "choices": [
      "The GPU runs out of memory capacity and has to swap to the CPU",
      "Each launch costs a fixed few microseconds of CPU work, and at batch 1 each tiny kernel also finishes in microseconds — so the CPU dispatcher can't queue work fast enough to keep the GPU fed",
      "The kernels are too large to fit in the GPU's SRAM",
      "Attention dominates the runtime and cannot be parallelized"
    ],
    "answer": 1,
    "explain": "It's the syscall-overhead pattern. A launch has a fixed CPU cost independent of the kernel's size; at batch 1 decode is memory-bound and each kernel does very little work, so the GPU drains it in about the same time the CPU needs to launch the next. The CPU becomes the bottleneck and the GPU starves between kernels."
  },
  {
    "q": "What does a CUDA graph do, and what is its core constraint?",
    "choices": [
      "It rewrites kernels to use fewer FLOPs; it only works on matmuls",
      "It records the fixed sequence of kernel launches as a DAG once and replays them in a single launch; but it bakes in fixed tensor shapes, so variable shapes must be handled separately",
      "It moves computation from the GPU to the CPU to save power; it needs a fast CPU",
      "It compresses the KV cache; it requires quantized weights"
    ],
    "answer": 1,
    "explain": "A CUDA graph captures the per-step launch DAG and replays it with one CPU crossing, killing per-launch overhead. Because it hard-codes the shapes it captured, engines capture one graph per batch-size bucket (and pad), while ragged, growing attention lengths can't be captured at all."
  },
  {
    "q": "In vLLM V1's piecewise CUDA graphs, why is attention the piece left to run eagerly?",
    "choices": [
      "Attention is the cheapest kernel, so graphing it wouldn't help",
      "Attention's KV-cache length differs per request and grows every step, so its shape can't be baked into a graph — and it does enough real work that its launch cost is already amortized",
      "Attention must run on the CPU for numerical stability",
      "torch.compile cannot trace attention kernels"
    ],
    "answer": 1,
    "explain": "Graphs need static shapes; attention's ragged, growing sequence lengths are exactly what a graph can't fix. It's also one of the few kernels that does substantial work per launch, so running it eagerly costs little — while the dozens of tiny static kernels around it, the ones that were starving the GPU, get captured."
  },
  {
    "q": "How does fusing norm + RoPE + residual into one kernel help, in roofline terms?",
    "choices": [
      "It reduces the number of FLOPs the ops perform, lowering compute cost",
      "It keeps the intermediate tensors on-chip instead of round-tripping to HBM, cutting bytes moved and thus raising arithmetic intensity toward the compute-bound region",
      "It lets the ops run on the tensor cores instead of the CUDA cores",
      "It quantizes the activations to FP8 automatically"
    ],
    "answer": 1,
    "explain": "Fusion doesn't change the FLOPs — it changes the bytes. Unfused, each op writes its result to HBM and the next reads it back; fused, the intermediate lives in registers/SRAM and HBM is touched once. Same FLOPs over far fewer bytes means higher FLOPs-per-byte, i.e. higher arithmetic intensity, pulling memory-bound elementwise work toward compute-bound."
  },
  {
    "q": "Most kernels in a modern engine are written in Triton rather than hand-tuned CUDA. Why is that usually the right call?",
    "choices": [
      "Triton kernels always beat CUDA on performance",
      "Triton reaches roughly 80% of peak with far less effort, and 80% on the many warm kernels beats spending weeks of CUDA work that only pays off on the one or two hottest paths",
      "CUDA cannot express fused MoE kernels",
      "Triton runs on the CPU, avoiding the GPU entirely"
    ],
    "answer": 1,
    "explain": "It's an effort-vs-peak trade. Triton's Python-ish tile model gets ~80% of peak cheaply and maintainably; hand CUDA/CUTLASS buys back the last ~20% at the cost of weeks per kernel, worth it only for the hottest paths like FlashMLA or DeepGEMM. The industry is even moving hot-path work to Python DSLs (CuTe-DSL) to cut compile-time pain."
  }
]
```
