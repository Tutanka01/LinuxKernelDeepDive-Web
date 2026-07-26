# FlashAttention & Decode Kernels

> **Goal of this chapter:** open the hood on the single hottest kernel in
> inference. You'll see why naive attention drowns in memory traffic, then
> *derive* online softmax by hand — the one recurrence that computes exact
> attention without ever writing the score matrix. From that seed grows the whole
> modern kernel stack: FlashAttention 1→4, FlashDecoding, FlashInfer, FlashMLA.
> After this chapter, "the attention kernel" stops being a black box.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kernels"></div>

This course keeps repeating that decode is **memory-bound** — limited by memory
bandwidth, not arithmetic ([Inference Arithmetic](#/inference-arithmetic) made it
quantitative). Here that claim gets cashed out in code: we take attention, the
operation that eats the most time, and watch one idea turn it from a memory hog
into the best-behaved kernel on the chip.

## The crime scene: attention writes gigabytes it never needed to

Recall the mechanics from [Attention Architectures for Serving](#/attention-for-serving):
for `N` tokens, attention scores every (query, key) pair, softmaxes each row into
weights, and uses those weights to average the values. The obvious way is three
array operations:

```text
  S = Q · Kᵀ        # scores:  N × N   (every query vs every key)
  P = softmax(S)    # weights:  N × N   (normalize each row)
  O = P · V         # output:   N × d   (weighted sum of values)
```

The villain is `S`, the `N×N` score matrix. A GPU computes only on data sitting
in **SRAM** — the tiny, fast on-chip scratchpad from
[the GPU mental model](#/gpu-mental-model). `S` is far too big to live there, so
the naive kernel parks it in **HBM**, the large-but-slow main memory, and
shuttles it back and forth:

1. compute `S = QKᵀ`, **write** all of it to HBM;
2. **read** `S` back to softmax it, **write** `P` to HBM;
3. **read** `P` back to multiply by `V`.

Count the bytes at a realistic long context. Take `N = 32,768` tokens, one
attention head, scores in 16-bit floats (2 bytes each):

```text
  S has 32,768 × 32,768 = 1,073,741,824 entries
  × 2 bytes  =  2,147,483,648 bytes  ≈  2 GiB   — per head
```

**Two gigabytes of scratch, for one head, that the answer doesn't even
contain** — and steps 1–3 push roughly *four* copies of it across the HBM bus
(write `S`, read `S`, write `P`, read `P`), ~8 GiB of traffic per head, per layer.

Weigh that against the arithmetic. The two matmuls do about `4N²d` operations,
the score traffic about `8N²` bytes; their ratio — the **arithmetic intensity**,
FLOPs per byte moved — is `d/2`, so for head dimension `d = 128`, **64 FLOPs per
byte**. An H100 can do ~295 FLOPs per byte of HBM bandwidth before arithmetic
becomes the limit; at 64, attention sits at barely a fifth of that, tensor cores
idling while the memory bus wheezes. **Attention isn't compute-heavy. It's
IO-heavy.** The score matrix is the reason.

> [!bridge] You already know this — from the Linux course
> "Memory-bound" is a verdict you have made before: `perf` showing low IPC next
> to a high cache-miss count says the CPU is waiting on memory, not computing.
> The reasoning here is identical, only you reach the verdict from a ratio
> (FLOPs per byte) instead of a counter, because the GPU's cost model is
> predictable enough to compute in advance.
> [→ Linux: /proc, strace, perf & eBPF](../#/observability)

## The dream, and the thing blocking it

So don't write the score matrix. Load a block of `Q`, `K`, and `V` into SRAM;
compute their little score tile *there*; use it and throw it away; move on. HBM
only ever sees `Q`, `K`, `V` and the output `O` — each just `N×d`, kilobytes not
gigabytes. The `N×N` matrix never touches main memory.

![Naive attention round-trips the N×N score matrix through HBM four times, while FlashAttention keeps the score tiles inside SRAM and moves only Q, K, V and O across the HBM boundary](assets/diagrams/flash-tiling.svg)

> [!bridge] You already know this — from the Linux course
> This is cache blocking, one level down. You met the ladder — registers, L1 at
> ~1 ns, RAM at ~100 ns — and the rule it implies: restructure the loop so the
> working set fits the fast tier and the slow tier is touched once. SRAM and HBM
> are the same ladder with different labels, except nothing is automatic: there
> is no hardware cache line pulling tiles in for you, so the kernel author
> schedules every load by hand.
> [→ Linux: The Machine Underneath](../#/prereq-hardware)

One thing blocks this, and it's not small. **Softmax needs a whole row at once.**
To turn scores into weights it divides by the sum of `exp(score)` across *every*
key — and for numerical safety first subtracts the row's maximum (else `exp`
overflows). Both the max and the sum are properties of the entire row. But tiling
holds only a few keys' scores in SRAM at a time. How do you normalize a row
before you've seen all of it?

## Online softmax, derived

Here is the whole trick, worth owning completely, because everything later in
this chapter is a rearrangement of it.

Process the keys tile by tile. Carry two running numbers for the query row:

- **`m`** — the largest score seen so far (running max),
- **`ℓ`** — the running sum of `exp(score − m)` over keys seen so far,

plus a running **output accumulator `o`** (the un-normalized weighted sum of
value vectors so far). When a new tile arrives with a bigger maximum than
anything you've seen, every `exp(· − m)` you already accumulated was computed
against the *wrong*, too-small max. You don't redo them — you **correct** them.
Because

```text
  exp(s − m_old) = exp(s − m_new) · exp(m_old − m_new)
```

every previously accumulated term is off by exactly the same constant factor
`exp(m_old − m_new)`. So when the max jumps from `m_old` to `m_new`, you scale
the old `ℓ` and `o` by that one factor — now they're expressed against the new
max — then fold in the new tile. That's online softmax: **when the max moves,
rescale what you've got by `exp(m_old − m_new)`.**

Run it on real numbers. One query row, four keys, split into two tiles of two.
Scores `[3, 1, 4, 2]`; the value vectors are just the numbers `[10, 20, 30, 40]`
so the arithmetic stays visible.

**Tile 1 — keys with scores `[3, 1]`, values `[10, 20]`:**

```text
  m = max(3, 1) = 3
  weights (un-normalized):  exp(3−3)=1.000,  exp(1−3)=0.135
  ℓ = 1.000 + 0.135 = 1.135
  o = 1.000·10 + 0.135·20 = 12.707
```

**Tile 2 — keys with scores `[4, 2]`, values `[30, 40]`:**

The new tile's max is 4, bigger than our running `m = 3`. So `m_new = 4`, and
the correction factor for everything we already have is `exp(3 − 4) = 0.368`.

```text
  rescale the old accumulators:
      ℓ ← 1.135 · 0.368 = 0.418
      o ← 12.707 · 0.368 = 4.675

  fold in tile 2, now measured against m_new = 4:
      weights:  exp(4−4)=1.000,  exp(2−4)=0.135
      ℓ ← 0.418 + (1.000 + 0.135)      = 1.553
      o ← 4.675 + (1.000·30 + 0.135·40) = 40.088
```

**Finalize** — divide the accumulated output by the accumulated normalizer:

```text
  O = o / ℓ = 40.088 / 1.553 = 25.81
```

![Four states of the online-softmax walkthrough for scores 3, 1, 4, 2: initial accumulators, tile one, the rescale when the running max moves from 3 to 4, and the folded-in final result 25.81](assets/diagrams/online-softmax.svg)

Compute the plain softmax over all four scores `[3, 1, 4, 2]` the textbook way
and you get `ℓ = 1.553`, `O = 25.81`. **Identical.** We never held more than two
scores at once, never wrote a score matrix, and landed on the same answer — and
that last word matters more than any speed number:

> **Common trap:** FlashAttention is not an approximation, not a cheaper
> attention that trades quality for speed. It computes the *same function* as
> naive attention — identical up to the floating-point rounding you'd get from
> summing in a different order. It is a pure re-association of the arithmetic to
> be kind to the memory hierarchy: same numbers, a fraction of the traffic.

This recurrence — running max, running sum, rescale-on-shift — is the seed of
the entire modern kernel stack. Everything below is the same bookkeeping sliced
across a different axis; learn it once and the rest is variations.

## The lineage: four generations, four problems

FlashAttention isn't one kernel but a four-year campaign, each generation
attacking a bottleneck the previous one exposed.

**FA1** (2022) established the idea above: tiling plus online softmax, and the
framing that attention is **IO-bound**, so the kernel is designed around *memory
traffic* first. Count the bytes, not the FLOPs — that reframing is the
contribution; the speedup followed from it.

**FA2** ([arXiv:2307.08691](https://arxiv.org/abs/2307.08691)) is a
work-partitioning rewrite. Two moves stand out. First, it slashes **non-matmul
operations**: on an A100 the tensor cores run matmuls ~16× faster than the
regular cores run rescales and exponentials, so every non-matmul FLOP is
punishingly expensive — FA2 does fewer of them, e.g. deferring the division by
`ℓ` to the very end. Second, it **parallelizes across the query dimension**, not
just batch and heads, so a single long sequence — even at
batch size 1 — has enough work to fill every streaming multiprocessor.

**FA3** ([arXiv:2407.08608](https://arxiv.org/pdf/2407.08608)) is about
**asynchrony** on Hopper (H100). Its signature idea is **warp specialization**:
inside a threadblock, some warps run the matmuls on the tensor cores while
*other* warps, at the same time, run the softmax on the regular cores, handing
results down a shared-memory pipeline. With **TMA** (a hardware unit that copies
HBM↔SRAM in the background, off the compute threads) and **FP8**, the matmul
units stop waiting on softmax — attention at roughly three-quarters of peak.

**FA4** ([2026](https://arxiv.org/html/2603.05451v1)) targets Blackwell (B200)
and is the first attention kernel past **1 PFLOP/s**, and its tricks tell you
where the bottleneck went. Blackwell's tensor cores are *so* fast that the chip's
special-function unit — which computes `exp()` — can't keep up, so FA4 computes
the exponential with a **polynomial approximation on the ordinary FMA
(multiply-add) units**, moving it off the congested path. It also **skips the
rescale** whenever the running max hasn't shifted enough to threaten overflow,
cutting corrections ~10×. And it's written in a **Python-based kernel DSL**
(CuTe-DSL) rather than C++ templates — a sign that authorship of even the hottest
kernels is moving up the abstraction ladder, a thread we pick up at the end.

> **State of play (mid-2026):** the headline numbers — FA3 at ~75% of H100 peak
> (~840 BF16 TFLOP/s), FA4 first past 1 PFLOP/s on Blackwell — are benchmark
> figures on specific hardware and will age. The *ideas* (tiling, online
> softmax, warp specialization, moving `exp` off the special-function unit) are
> the durable part.

## Decode breaks FA2's playbook

Every generation above optimizes **prefill**, where many query rows spread
across the GPU. **Decode** breaks the trick that made FA2 fast: you generate one
token at a time, so there is exactly
**one query row**, attending against the *entire* KV cache — tens of thousands of
past keys and values streamed from HBM. FA2's "parallelize over the query
dimension" has nothing to divide: one row can't be split across 132 streaming
multiprocessors, so most of the GPU idles while a handful of units crawl through
the KV history. At batch 1 with long context, the chip is almost entirely wasted.

**FlashDecoding** ([PyTorch](https://pytorch.org/blog/flash-decoding/)) fixes it
by parallelizing over the *other* axis — the KV history itself. Chop the cached
keys and values into chunks, hand each to a different SM, and let them compute a
**partial attention** over their slice at the same time. Each chunk emits its
output accumulator plus its **log-sum-exp** — precisely the running `m` and `ℓ`
from our derivation, recording "here's my partial answer and the normalizer it's
waiting on." A tiny reduction then combines the partials with exactly the
rescale-and-add rule we walked by hand: shift each to the global max, weight by
its `ℓ`, sum. The same online-softmax math — only now the tiles are spread across
*space* (SMs running concurrently) instead of walked in *time*. This is why a
well-built engine saturates the GPU on long-context decode even at batch 1:
split-KV manufactures the parallelism the single query row couldn't provide.

![Without split-KV a single query row keeps one SM busy while the rest idle; FlashDecoding splits the KV cache into chunks, computes a partial output and log-sum-exp per chunk in parallel, then merges them in one reduction](assets/diagrams/flash-decoding.svg)

## FlashInfer: where the block table finally meets a kernel

Back in [PagedAttention & Prefix Caching](#/paged-kv-cache) you learned that the
KV cache isn't one contiguous array — it's scattered across fixed-size **blocks**
in HBM, tracked by a per-request **block table** mapping token positions to
physical block numbers. That left a question open: how does a *kernel*, which
wants neat tiles, consume a cache deliberately shattered into non-contiguous
pages — where requests in a batch have different lengths, several share a prompt
prefix, and some models use sliding windows? From the kernel's point of view
that's chaos.

**FlashInfer** ([arXiv:2501.01005](https://arxiv.org/abs/2501.01005), MLSys 2025
best paper) is the answer, and the shared attention backend under **vLLM,
SGLang, and TensorRT-LLM**. Its unifying move: represent *every* KV layout —
paged blocks, ragged variable-length batches, shared prefix trees — as one
abstraction, a **block-sparse matrix**, where a block table is just the sparsity
pattern saying which blocks a query needs to read. Once paged, ragged, and
prefix-shared caches all look like "block-sparse attention," one well-tuned
kernel family handles them all — the concrete machinery that consumes the block
tables from the paged-cache chapter. On top of that, FlashInfer **JIT-compiles
customized attention variants** on demand — sinks, sliding windows, custom masks
— each a specialized kernel rather than one mega-kernel of runtime branches, plus
a **load-balancing scheduler** for batches of uneven length.

**FlashMLA** ([GitHub](https://github.com/deepseek-ai/FlashMLA)) is the
specialist cousin: DeepSeek's decode kernel for **Multi-head Latent Attention**,
the compressed-cache variant from
[Attention Architectures for Serving](#/attention-for-serving). MLA caches one
small latent vector per token instead of full per-head keys and values; FlashMLA
streams that latent cache at roughly 3 TB/s on Hopper, and by mid-2026 is
upstreamed into NVIDIA's cuDNN.

## Who writes these kernels

Kernel authorship is a spectrum. **Triton** (a Python-like language, next
chapter) writes a competitive kernel in an afternoon, trading the last 20–40% of
peak for huge gains in authorability; **CUTLASS / CuTe-DSL** and **hand-written
CUDA** sit at the other end — brutal to write, but they extract the final drops
that FA3, FA4, and FlashMLA depend on. Reach for Triton by default and pay the
CUDA tax only for the very hottest kernels — of which attention is the hottest.
The [next chapter](#/kernels-and-compilation) picks up this spectrum and the
machinery — CUDA graphs, compilation, fusion — that stitches these kernels into a
fast forward pass.

## What to remember

- Naive attention materializes the **`N×N` score matrix** in HBM — ~2 GiB *per
  head* at 32K context — and moves it four times. **Attention is IO-bound, not
  compute-bound.**
- **Online softmax** computes a row's softmax tile-by-tile in SRAM: carry a
  running max `m` and running sum `ℓ`, and when a new tile raises the max,
  **rescale the accumulators by `exp(m_old − m_new)`**. The score matrix never
  hits HBM, and the result is **exact** — same numbers, a fraction of the traffic.
- The lineage each attacked one bottleneck: **FA1** tiling + IO-awareness;
  **FA2** fewer non-matmul ops, parallelize over queries; **FA3** Hopper
  asynchrony (warp specialization, TMA, FP8); **FA4** Blackwell (polynomial
  `exp` on FMA units, skip-rescaling, Python DSL, >1 PFLOP/s).
- **Decode** has one query row, so FA2's query-parallelism collapses.
  **FlashDecoding** splits the *KV history* across SMs — partial attention +
  log-sum-exp per chunk, merged by a tiny reduction — so batch-1 long-context
  decode still saturates the GPU.
- **FlashInfer** unifies every KV layout (paged, ragged, prefix-shared) as
  **block-sparse attention** and JIT-generates variants — it's how the paged
  cache's block tables get consumed, and the shared backend under vLLM, SGLang,
  and TRT-LLM. **FlashMLA** is DeepSeek's MLA decode kernel, now in cuDNN.

## Frequently asked

<div class="faq">

<details>
<summary>If FlashAttention is exact, why do my logits shift slightly when I change attention backend?</summary>

Because "exact" means the same function, not the same rounding. Floating-point
addition isn't associative, and FA2, FA3, FlashInfer and FlashMLA each sum the
tiles in a different order with different tile sizes — so the last bit or two of
each logit moves. That is normally invisible, but at temperature 0 a shift of
1e-6 can flip two near-tied tokens and send a generation down a different path.
If you need bit-reproducible outputs, pin the backend and the batch size, not
just the model weights.

</details>

<details>
<summary>Does FlashAttention save memory as well as time?</summary>

It saves *activation* memory, dramatically: the `N×N` score matrix never exists,
so attention's footprint drops from `O(N²)` to `O(N·d)` — that ~2 GiB per head
at 32K context simply isn't allocated. For serving, though, that saving is
mostly a prefill story. Once you are decoding, the KV cache dominates your memory
budget and FlashAttention doesn't shrink it at all; that is what MLA, GQA and KV
quantization are for.

</details>

<details>
<summary>Do I ever pick an attention backend by hand, or does the engine decide?</summary>

The engine decides well by default — vLLM and SGLang choose FlashInfer, FA2/FA3
or FlashMLA based on your GPU, dtype and model architecture, and the default is
right nearly always. You override in three situations: a new GPU generation where
the fast backend isn't wired up yet, a model whose attention variant (sinks,
sliding window, a custom mask) only one backend supports, and debugging, where
forcing a simpler backend tells you whether a numerical problem is the kernel or
the model. Treat an override as a temporary diagnosis, not a tuning knob.

</details>

</div>

```quiz
[
  {
    "q": "Why is naive attention memory-bound rather than compute-bound at long context?",
    "choices": [
      "The matmuls Q·Kᵀ and P·V require more FLOPs than the GPU can perform",
      "It materializes the huge N×N score matrix in HBM and moves it several times, so the kernel spends its time on memory traffic while the tensor cores idle",
      "Softmax is a transcendental function that the GPU computes very slowly",
      "The KV cache does not fit in HBM and must be streamed from disk"
    ],
    "answer": 1,
    "explain": "The N×N score matrix (≈2 GiB per head at 32K context, fp16) is written and read back multiple times. Attention's arithmetic intensity is only ~d/2 FLOPs per byte — far below the GPU's balance point — so the bottleneck is bandwidth, not arithmetic."
  },
  {
    "q": "In online softmax, when a new tile contains a larger score than any seen before, what must happen to the already-accumulated normalizer ℓ and output o?",
    "choices": [
      "They are discarded and recomputed from the beginning with the new maximum",
      "Nothing — softmax is invariant to the order tiles are processed",
      "They are multiplied by exp(m_old − m_new) to re-express them against the new maximum, then the new tile is folded in",
      "They are multiplied by exp(m_new − m_old) to grow them toward the new maximum"
    ],
    "answer": 2,
    "explain": "Every accumulated term exp(s − m_old) equals exp(s − m_new)·exp(m_old − m_new), so all of them are off by the single factor exp(m_old − m_new). Since m_new > m_old, that factor is < 1: it shrinks the old accumulators to match the new, larger max before the new tile is added."
  },
  {
    "q": "How does FlashAttention's output compare to naive attention's?",
    "choices": [
      "It is an approximation that trades some accuracy for speed",
      "It is exact — the same function, up to ordinary floating-point rounding — just re-associated to avoid writing the score matrix",
      "It is more accurate because it avoids overflow in softmax",
      "It differs whenever the sequence is longer than one SRAM tile"
    ],
    "answer": 1,
    "explain": "FlashAttention changes only the order of the arithmetic to keep the score matrix out of HBM. It computes the identical attention function; the only difference from naive attention is the small rounding you'd expect from summing in a different order."
  },
  {
    "q": "Why does FlashAttention-2's key optimization — parallelizing over the query dimension — fail to help during decode, and what does FlashDecoding do instead?",
    "choices": [
      "Decode has only one query row so there is nothing to split over queries; FlashDecoding splits the KV history across SMs and combines the partials via their log-sum-exps",
      "Decode uses a different softmax; FlashDecoding switches to an approximate softmax to regain speed",
      "Decode is compute-bound; FlashDecoding adds more tensor-core matmuls",
      "FA2 works fine at decode; FlashDecoding only helps prefill"
    ],
    "answer": 0,
    "explain": "At decode there is a single query attending to the whole KV cache, so query-dimension parallelism has nothing to divide and most SMs idle. FlashDecoding parallelizes over the KV history instead: each SM computes a partial attention plus its log-sum-exp (the running m and ℓ), and a tiny reduction merges them with the same online-softmax rescale rule."
  },
  {
    "q": "What is FlashInfer's core unifying idea, and how does it connect to PagedAttention?",
    "choices": [
      "It compresses the KV cache into a low-rank latent, eliminating the block table",
      "It represents every KV layout — paged, ragged, prefix-shared — as a block-sparse matrix whose sparsity pattern is essentially the block table, so one kernel family consumes them all",
      "It replaces the paged cache with a single contiguous array to simplify the kernel",
      "It runs attention on the CPU to avoid GPU memory fragmentation"
    ],
    "answer": 1,
    "explain": "FlashInfer casts paged blocks, ragged batches, and shared prefixes all as block-sparse attention; a request's block table is just which blocks (which sparse entries) it must read. That is the concrete mechanism by which PagedAttention's scattered blocks get consumed by a kernel — and it's the shared backend under vLLM, SGLang, and TensorRT-LLM."
  }
]
```
