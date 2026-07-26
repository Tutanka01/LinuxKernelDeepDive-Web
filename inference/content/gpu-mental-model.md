# The GPU Mental Model

> **Goal of this chapter:** understand a GPU the way you already understand a
> CPU — cores, a memory hierarchy, and the gap between them. You will learn
> why an LLM runs on a GPU at all, what an H100 is made of, what a FLOP is,
> and the one model that governs everything: the **roofline**, a race between
> how fast the chip can compute and how fast it can move bytes. After this
> chapter, "989 TFLOP/s" and "3.35 TB/s" stop being spec-sheet noise and
> become the two numbers that predict performance.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,kernels"></div>

In [the previous chapter](#/what-is-inference) you watched the autoregressive
loop: the model consumes your prompt, then emits tokens one at a time, each
one a full pass through the network. Here is the question that decides
everything about how that runs: **what is the network actually *doing* during
one pass?**

The answer is almost embarrassingly simple. It is multiplying matrices. Not
mostly — overwhelmingly. Strip away the vocabulary of "attention" and
"transformers" (chapter 3) and a forward pass is a long chain of large
matrix multiplications with some cheap glue between them. So the real
question becomes: what kind of machine multiplies enormous matrices fastest?
It is not the CPU you know from the Linux course. Understanding *why* is the
whole chapter.

## Two philosophies of a chip: latency vs throughput

A matrix multiply has a property worth naming precisely: it is
**embarrassingly parallel**. Every entry of the output is an independent dot
product — a pile of multiply-then-add operations that depends on nothing
another entry is computing. A 4096×4096 output has 16 million such entries,
all computable at once, in any order. There are no branches, no pointer
chasing, no "it depends." Just the same tiny operation, multiply-accumulate,
repeated billions of times.

The CPU you already understand is built for the *opposite* workload. It is a
**latency machine**: a handful of very complex cores (8, 32, 64) each
engineered to finish *one* sequential thread of unpredictable, branchy code
as fast as possible. That is why so much of a CPU core's silicon goes to
things that have nothing to do with arithmetic — branch predictors,
out-of-order execution, deep cache hierarchies, speculative prefetch. All of
it exists to keep a single instruction stream from stalling. A CPU is a few
brilliant chefs, each improvising a whole dish end to end.

A GPU makes the opposite bet. It is a **throughput machine**: thousands of
simple arithmetic lanes, individually unremarkable and slow, that win by
sheer number when the work is uniform and parallel. It spends its transistors
on ALUs, not on cleverness. It is a kitchen with ten thousand line cooks,
each able to do exactly one chop — useless for improvising a dish, unbeatable
for chopping a mountain of onions. An LLM forward pass is a mountain of
onions.

That is the entire reason neural networks live on GPUs. The math is parallel;
the GPU is parallel; the match is near-perfect.

> [!bridge] You already know this — from the Linux course
> Everything you learned about why a CPU core is *shaped* the way it is —
> branch prediction, out-of-order issue, deep caches, speculative prefetch —
> was silicon spent making one unpredictable instruction stream go fast. None
> of that machinery earns its transistors on a matmul, because there is
> nothing to predict and nothing to reorder. The GPU is what you build when
> you delete all of it and spend the area on arithmetic instead.
> [→ Linux: The Machine Underneath](../#/prereq-hardware)

## Anatomy of an H100

Let us make it concrete with the workhorse of mid-2026 inference, NVIDIA's
**H100**. (GPU = graphics processing unit, though "graphics" is now
vestigial; these chips exist for matrix math.)

The compute is organized into **SMs — streaming multiprocessors**, the GPU's
rough equivalent of a CPU core. An H100 has **132 of them**. But an SM is not
one lane; it contains many arithmetic lanes that execute together. The
hardware groups threads into **warps of 32** that march in lockstep — every
thread in a warp runs the same instruction on different data at the same
instant. (This is called SIMT, single-instruction-multiple-thread; think of a
warp as one instruction with 32 data slots, the natural shape for "do this
same multiply to 32 numbers.") You will rarely reason at the thread level in
this course — the unit that matters is the SM and the whole chip — but keep
the picture: parallelism is baked in three levels deep (chip → SM → warp).

![Nested boxes showing the H100's levels: the whole chip with its 132 SMs and one shared 80 GB HBM pool, an SM holding shared memory, a warp scheduler and tensor cores, a warp of 32 threads issued one instruction in lockstep, and a single thread owning only its registers.](assets/diagrams/gpu-hierarchy.svg)

### The memory hierarchy, and why it will look familiar

From the Linux course you carry a mental pyramid: registers, then L1/L2/L3
cache, then DRAM across the NUMA bus — each level bigger, slower, and farther
from the ALU than the last. **A GPU has the exact same shape, with different
labels and very different numbers:**

```text
        CPU (the one you know)              GPU (H100)
        ────────────────────────            ──────────────────────────────
  fast  registers      ~KB/core        registers    256 KB/SM   \
   ▲    L1  ~48 KB/core                 SRAM (L1 +    ~256 KB/SM   } on-chip
   │    L2  ~1–2 MB/core                shared mem)               /  SRAM,
   │    L3  ~30–100 MB shared           L2 cache     ~50 MB       }  tens of
   │                                                              /   MB total
  slow  DRAM  ~100s GB               →  HBM          80 GB
        @ ~0.1–0.4 TB/s                 @ 3.35 TB/s
```

![Two side-by-side memory pyramids, CPU and GPU, with matching tiers — registers, on-chip cache, then DRAM or HBM — each labelled with capacity, bandwidth and latency. Every GPU tier is wider, yet the annotation notes the compute-to-bandwidth ratio is worse on the GPU, not better.](assets/diagrams/memory-hierarchy.svg)

Two things to read off this. First, the *structure* is identical: a tiny,
blazing-fast on-chip tier (registers and SRAM — static RAM, the same
technology as your CPU's cache) backed by a large, comparatively slow
off-chip tier. On the GPU the off-chip tier is **HBM — high-bandwidth
memory**, stacks of DRAM sitting right next to the compute die: **80 GB at
3.35 TB/s** on the H100. The on-chip SRAM is measured in *tens of megabytes
total* across the whole chip and delivers on-chip bandwidth far above HBM's —
tens of TB/s — but there is almost none of it.

Second, the numbers are shifted, not reinvented. HBM's 3.35 TB/s is close to
an order of magnitude more bandwidth than a well-provisioned server's DRAM —
but the *ratio* that hurt you on the CPU, fast compute starving on slow far
memory, is if anything worse here. Hold that thought; it is the roofline.

> [!bridge] You already know this — from the Linux course
> The reason you cared about cache blocking, page locality and which NUMA node
> a buffer was allocated on is the same reason you will care about SRAM tiling
> here: the compute unit is never the thing you are waiting for, the trip to
> far memory is. What differs is how brutal the ratio has become. A CPU core
> stalling on remote DRAM wastes a few ALUs; an H100 stalling on HBM idles
> almost a quadrillion FLOP/s of tensor core, which is why "keep the working
> set on-chip" stops being a tuning tip and becomes the design.
> [→ Linux: NUMA Deep Dive](../#/numa-deep-dive)

## Tensor cores, and what a FLOP actually is

First, the unit. A **FLOP** is one *floating-point operation* — a single
multiply, or a single add, on real numbers. **FLOP/s** (often written FLOPS)
is FLOPs per second, the rate. A multiply-accumulate — multiply two numbers,
add the result to a running total, the atom of every dot product — is
therefore **2 FLOPs**. That is all "TFLOP/s" (tera = 10¹²) is counting: how
many multiplies-and-adds per second.

Ordinary GPU lanes (called CUDA cores) do general scalar arithmetic. But
NVIDIA noticed that inference is *almost entirely* small matrix multiplies
and built dedicated silicon for exactly that: **tensor cores**. A tensor core
does not multiply two numbers; it multiplies two small *matrices* and
accumulates the result in a single hardware operation. By hard-wiring the
matmul pattern instead of issuing thousands of separate instructions, it
delivers an order of magnitude more throughput — and it is where essentially
all of an LLM's arithmetic happens.

Tensor cores hit their peak in **reduced precision**. This course's default
is **BF16** (bfloat16, a 16-bit floating-point number — 2 bytes — that
trades mantissa precision for the same exponent range as 32-bit float, which
neural nets tolerate well). In BF16, the H100's tensor cores are rated at
**989 TFLOP/s** — nearly a *quadrillion* multiply-adds per second. That is
the first of our two headline numbers.

## The second ceiling: bandwidth

989 TFLOP/s is a promise the chip can rarely keep, because those tensor cores
have to be *fed*. Every number a tensor core multiplies came from somewhere,
and unless it was already sitting in registers or SRAM, it had to travel from
HBM at 3.35 TB/s. Compute you cannot feed is compute you do not get.

So a GPU has **two independent ceilings**, and any operation is limited by
whichever it hits first:

- **compute:** peak arithmetic rate, 989 TFLOP/s (BF16, H100).
- **bandwidth:** peak byte-movement rate from HBM, 3.35 TB/s.

The whole game is knowing which one binds. That is the roofline.

## The roofline model

Any operation moves some bytes and does some FLOPs. Model its time as the
larger of two independent costs — the chip does both at once, so you wait for
the slower:

```text
   T = max( FLOPs / peak_FLOP_per_s ,  bytes_moved / peak_byte_per_s )
             └──── T_math ────┘          └──────── T_mem ────────┘
```

Which term wins depends on a single ratio — the most important number in this
course:

> **Arithmetic intensity** = FLOPs performed ÷ bytes moved. How much math you
> extract from each byte you drag off HBM.

The chef analogy makes it physical. A tensor core is a chef who chops
infinitely fast; HBM is a slow conveyor belt delivering ingredients.
Arithmetic intensity is **how many chops each ingredient gets before the next
one arrives**. If every onion gets a single chop, the chef stands idle
waiting on the belt — you are **memory-bound**, limited by the conveyor. If
every onion gets ten thousand chops, the belt is idle and the chef is
saturated — you are **compute-bound**.

The break-even point is where the two costs are equal. Set `T_math = T_mem`
and the FLOPs/bytes cancel into a pure property of the hardware:

```text
   I_ridge = peak_FLOP_per_s / peak_byte_per_s        (the "ridge point")

   H100:  9.9e14 FLOP/s / 3.35e12 byte/s  ≈  295 FLOP/byte
```

That is the rule you carry out of this chapter. An operation whose arithmetic
intensity is **below ~295 is memory-bound** on an H100 — it will run below
peak FLOPs no matter how fast the tensor cores are, because it is starved for
bytes. **Above ~295 it is compute-bound**, finally limited by the 989
TFLOP/s. The ridge is fixed by the chip, not by your workload.

```text
  attained
  FLOP/s
    989T ┤              ╭───────────────────  ← compute ceiling
         │            ╱ :
         │          ╱   :
         │        ╱     :
         │      ╱       :
         │    ╱  ← bandwidth-limited slope
         │  ╱           :
         └────────────────────────────────▶  arithmetic intensity
                    I_ridge ≈ 295            (FLOP/byte, log scale)
         └ memory-bound ─┘└─ compute-bound ─┘
```

![The H100 roofline on log-log axes: a sloping bandwidth roof of attainable = intensity × 3.35 TB/s meeting a flat compute roof at 990 TFLOP/s dense BF16, the two crossing at the ridge point of 295 FLOP/byte.](assets/diagrams/roofline-h100.svg)

### A worked intensity, start to finish

Take the simplest operation there is: add two BF16 vectors, element by
element, `c = a + b`. For each element the GPU **reads** two numbers (2 bytes
+ 2 bytes) and **writes** one (2 bytes) — 6 bytes moved — to perform exactly
**1 FLOP** (the add). Intensity:

```text
   1 FLOP / 6 bytes  ≈  0.17 FLOP/byte
```

That is roughly **1,700× below** the H100's ridge of 295. An element-wise add
is so byte-hungry that the mighty tensor cores are irrelevant; it runs at
memory speed and leaves 99.9% of the FLOPs on the table. Now contrast a large
square matmul, `[N,N]×[N,N]`: each value loaded from HBM gets reused across an
entire row or column of the output — roughly `N` multiply-adds per byte. For
`N` in the thousands, intensity lands in the hundreds to thousands: **well
past the ridge, compute-bound**, exactly the regime tensor cores were built
for. Same chip, same two ceilings; a factor of ten thousand in intensity
decides which one you hit.

Move the intensity yourself and watch which ceiling catches you:

<div class="inf-widget" data-widget="roofline-explorer">
<p class="inf-widget-fallback">Interactive roofline explorer — needs JavaScript enabled.</p>
</div>

## The generational table — and why the wall stands

Newer chips, same story. Here are the three flagships you will meet in
mid-2026, with dense BF16 figures:

| GPU | Dense BF16 | HBM bandwidth | Capacity | I_ridge |
|---|---|---|---|---|
| **H100** SXM5 | 989 TFLOP/s | 3.35 TB/s | 80 GB | **~295** |
| **H200** | 989 TFLOP/s | 4.8 TB/s | 141 GB | **~206** |
| **B200** | 2,250 TFLOP/s | 8.0 TB/s | 192 GB | **~281** |

Read the last column. From H100 to B200, compute grew ~2.3× and bandwidth
grew ~2.4× — so the ridge barely stirred, ~295 → ~281. (The H200 is the same
compute die as the H100 with faster, larger HBM bolted on; it *lowers* the
ridge to ~206 by adding bandwidth without adding FLOPs — a pure feed
upgrade.) The lesson is blunt: **the ridge point is not receding.** Each
generation adds compute and bandwidth in near-lockstep, so the balance point
between the two ceilings stays put. Any workload that was memory-bound on an
H100 is, to a first approximation, still memory-bound on a B200. **The memory
wall is not a problem you can buy your way out of by waiting for next year's
GPU** — which is precisely why the rest of this course exists.

> **Common trap — two numbers that will mislead you.** (1) Vendor decks quote
> the *sparse* peak: H100 as "1,979 TFLOPS," B200 as "~4.5 PFLOPS." Those
> include a 2× bonus from **2:4 structured sparsity** that standard dense
> inference does not get — always **halve them** to the dense figures above.
> Using the sparse number puts your ridge point off by 2×. (2) **Capacity
> (GB) and bandwidth (TB/s) are different limits that bind differently.**
> Capacity decides whether the model and its data *fit*; bandwidth decides
> how *fast* they stream. A model can sit comfortably in 80 GB and still be
> throttled by the 3.35 TB/s it takes to read those bytes every step. Do not
> conflate "it fits" with "it is fast."

## Frequently asked

<div class="faq">

<details>
<summary>Does the roofline account for the SRAM, or only for HBM?</summary>

Only for HBM, and that is deliberate. The `bytes_moved` term counts traffic
across the slow off-chip boundary, because that is the ceiling that binds;
on-chip SRAM traffic is fast enough to ignore in a first-order estimate.
Keeping data in SRAM does not raise the roof — it *raises your arithmetic
intensity*, by letting one HBM read serve many more FLOPs before the value is
evicted. That is precisely what tiling does, and it is the whole idea behind
[FlashAttention & Decode Kernels](#/flashattention).

</details>

<details>
<summary>If the ridge point is fixed by the hardware, can I ever move it?</summary>

You cannot move the chip's ridge, but you can move it *for your workload* by
changing how many bytes a number costs. Quantizing weights from BF16 to FP8
halves the bytes without changing the FLOPs, which doubles your effective
intensity — the same operation lands twice as far to the right on the same
roofline. Buying a chip with more bandwidth per FLOP does the other thing: the
H200 lowers the ridge to ~206 by adding HBM speed to an unchanged compute die.
Those are the only two moves, and [Quantization](#/quantization) is the one
you control.

</details>

<details>
<summary>An H100 has 132 SMs. Should I be reasoning about SM counts the way I reason about CPU cores?</summary>

Rarely. On a CPU you size work to cores because a core is the unit that runs
one thread. On a GPU the unit that matters for capacity planning is the whole
chip — its aggregate 989 TFLOP/s and 3.35 TB/s — because a well-written kernel
already spreads across every SM and every warp. SM counts start to matter only
when you are writing or tuning kernels, where occupancy, shared-memory budget
per SM and tail effects on the last wave of blocks decide throughput. Until
then, treat the GPU as one very fast, very hungry unit.

</details>

</div>

## What to remember

- An LLM forward pass is overwhelmingly **matrix multiplication**, which is
  **embarrassingly parallel** — the ideal workload for a GPU's **throughput**
  design (thousands of simple lanes) and the worst case for a CPU's
  **latency** design (few complex cores).
- An H100 is **132 SMs** of tensor cores, backed by the same *shape* of
  memory hierarchy you know: tiny fast on-chip **SRAM** (tens of MB total)
  over large, slower off-chip **HBM** (80 GB @ 3.35 TB/s).
- A **FLOP** is one multiply or add; a multiply-accumulate is 2. **Tensor
  cores** do matmul in hardware and are where the H100's **989 TFLOP/s**
  (dense BF16) lives.
- Every operation is capped by whichever ceiling it hits first — **989
  TFLOP/s compute** or **3.35 TB/s bandwidth**. **Arithmetic intensity**
  (FLOPs per byte) decides which. Below the **ridge point I_ridge ≈ 295**
  you are memory-bound; above it, compute-bound.
- Across GPU generations the ridge barely moves (~295 → ~281): **the memory
  wall is not receding.** And always halve marketing "sparse" FLOPs for dense
  inference.

We now have the machine and the one law that governs it. The obvious next
question — which side of the ridge does an actual LLM live on? — is where the
next chapter, [Inference Arithmetic](#/inference-arithmetic), begins. The
answer turns out to be *both*, on different steps of the very same loop you
saw in chapter 1: prefill lands on one side, decode on the other. That split
is not a footnote. It is the fact the entire field of inference engineering
is built to exploit.

```quiz
[
  {
    "q": "Why is a GPU, not a CPU, the right machine for an LLM forward pass?",
    "choices": [
      "GPUs run at much higher clock speeds than CPUs",
      "The forward pass is overwhelmingly matrix multiplication, which is embarrassingly parallel — a throughput machine with thousands of simple lanes beats a latency machine with a few complex cores",
      "CPUs cannot perform floating-point math",
      "GPUs have far more total memory than CPUs"
    ],
    "answer": 1,
    "explain": "Matmul is a mountain of independent multiply-accumulates with no branches or dependencies. That uniform parallelism is exactly what a GPU's thousands of simple ALUs devour, and exactly what a CPU's branch-predicting, out-of-order cores are wasted on. It is a match of workload shape to hardware shape, not clock speed or memory size."
  },
  {
    "q": "An operation on an H100 has an arithmetic intensity of 12 FLOP/byte. Is it compute-bound or memory-bound, and why?",
    "choices": [
      "Compute-bound, because any operation using tensor cores is compute-bound",
      "Memory-bound, because 12 is far below the ridge point of ~295, so it is starved for bytes long before it saturates the 989 TFLOP/s",
      "Compute-bound, because 12 FLOP/byte is a high intensity",
      "It depends on how many GB the data occupies in HBM"
    ],
    "answer": 1,
    "explain": "The ridge point I_ridge = 989 TFLOP/s ÷ 3.35 TB/s ≈ 295 FLOP/byte. Intensity below the ridge means the chip runs out of bandwidth before it runs out of compute, so it is memory-bound and will sit far below peak FLOPs. Capacity (GB) is a separate limit and does not decide this."
  },
  {
    "q": "A spec sheet lists the H100 at 1,979 TFLOP/s BF16. What number should you use for dense inference math, and why?",
    "choices": [
      "1,979 TFLOP/s — it is the official rating",
      "989 TFLOP/s — the quoted figure includes a 2× bonus from 2:4 structured sparsity that dense inference does not receive",
      "3,958 TFLOP/s — you should double it for two tensor-core pipelines",
      "It does not matter; the FLOP number never affects inference performance"
    ],
    "answer": 1,
    "explain": "Marketing peaks fold in 2:4 structured sparsity, a 2× multiplier that standard dense inference cannot use. Halve to the dense 989 TFLOP/s. Using the sparse number would push your ridge point (and any compute-bound estimate) off by a factor of 2."
  },
  {
    "q": "Why does the ridge point stay near 295 FLOP/byte from the H100 to the B200, even though the B200 is far more powerful?",
    "choices": [
      "Because NVIDIA caps the ridge point in firmware",
      "Because compute and HBM bandwidth grew in near-lockstep (~2.3× and ~2.4×), so their ratio — which is exactly the ridge point — barely changed",
      "Because the B200 uses the same HBM as the H100",
      "Because arithmetic intensity is a property of the model, not the chip"
    ],
    "answer": 1,
    "explain": "The ridge is peak_FLOP/s ÷ peak_byte/s. When both numerator and denominator scale by roughly the same factor across a generation, the quotient is nearly unchanged. That is why the memory wall is not receding: buying a newer GPU does not move a memory-bound workload to the compute-bound side."
  },
  {
    "q": "A model fits comfortably in an H100's 80 GB of HBM but still runs slowly, well below peak FLOPs. What is the most likely explanation?",
    "choices": [
      "The model is too small to use the tensor cores",
      "It is bandwidth-bound: capacity (80 GB) only decides whether data fits, while bandwidth (3.35 TB/s) decides how fast those bytes can be streamed each step",
      "The GPU has run out of SMs",
      "80 GB is not enough memory, so it is swapping to the CPU"
    ],
    "answer": 1,
    "explain": "Capacity and bandwidth are independent ceilings. Fitting in 80 GB says nothing about speed; if the operation's arithmetic intensity is below the ridge, the chip spends its time waiting on the 3.35 TB/s pipe from HBM and leaves most of the 989 TFLOP/s idle. 'It fits' and 'it is fast' are different claims."
  }
]
```
