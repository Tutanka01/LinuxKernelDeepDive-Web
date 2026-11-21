# The GPU Mental Model

> **The question:** why does a chip rated at nearly a quadrillion operations
> per second spend most of an LLM's decode time waiting — and how can you tell,
> before running anything, whether a given operation will?
>
> **You'll be able to:** compute an operation's arithmetic intensity and place
> it on the roofline; predict whether faster memory or more compute would speed
> it up, or neither; read a GPU spec sheet — precision, sparsity, variant — and
> compute the ridge of a chip this chapter never worked.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,kernels"></div>

[Inside a Forward Pass](#/inside-a-forward-pass) showed that a pass over the
model is, almost entirely, a chain of large matrix multiplications: the attention
projections and the MLP, 80 times over, with cheap glue in between. So the
question of what hardware to run inference on reduces to a narrower one: what
kind of machine multiplies large matrices fastest, and what stops it from going
faster?

## Why matrix multiplication wants a GPU

Every entry of a matrix product is an independent dot product. A 4,096 × 4,096
output has 16 million of them, none depending on another: no branches, no pointer
chasing, the same multiply-and-add in any order. The CPU you know from the Linux
course spends most of each core's silicon making *one* unpredictable instruction
stream fast — branch prediction, out-of-order execution, prefetching — and a matrix
multiply gives that machinery nothing to do.

A GPU (graphics processing unit — the name is historical) spends its
transistors the other way: thousands of simple arithmetic lanes and very little
control logic. Individually the lanes are unremarkable; together they win
whenever the work is uniform and parallel.

## Anatomy of an H100

This course's reference chip is NVIDIA's H100 in its SXM form (the version
that plugs into a multi-GPU server board rather than a PCIe slot), still a common
inference GPU in late 2026.

Its compute is divided into 132 **streaming multiprocessors (SMs)**, the rough
counterpart of CPU cores. Within an SM, threads are scheduled in warps of 32
that execute the same instruction at the same time on different data, on ordinary
arithmetic lanes NVIDIA markets as **CUDA cores**. Each SM also holds **tensor
cores**: dedicated units that multiply two small matrices and accumulate the
result as a single hardware operation. Essentially all of an LLM's FLOPs run on
tensor cores; the norms, softmax and sampling run on the CUDA cores and are cheap
in FLOPs, though not always in time.

![Nested boxes showing the H100's levels: the whole chip with its 132 SMs and one shared 80 GB HBM pool, an SM holding shared memory, a warp scheduler and tensor cores, a warp of 32 threads issued one instruction in lockstep, and a single thread owning only its registers.](assets/diagrams/gpu-hierarchy.svg)

You will rarely reason about individual SMs or warps in this course. For capacity
planning, a GPU is one unit with two headline numbers — and you need to know where
they come from.

### The memory hierarchy

The GPU's memory has the same shape as the CPU's: small and fast close to the
arithmetic, large and slow far from it.

```text
        CPU (one socket, 2026 server)       GPU (H100 SXM)
        ─────────────────────────────       ──────────────────────────────
  fast  registers     ~KB per core          registers      256 KB per SM
   ▲    L1            ~48 KB per core       L1 + shared    256 KB per SM
   │    L2            ~1–2 MB per core      L2             50 MB, shared
   │    L3            ~30–100s MB shared
  slow  DRAM          TBs                   HBM            80 GB
                      @ ~0.6 TB/s                          @ 3.35 TB/s
```

![Two side-by-side memory pyramids, CPU and GPU, with matching tiers — registers, on-chip cache, then DRAM or HBM — each labelled with capacity, bandwidth and latency. Every GPU tier is wider, yet the annotation notes the compute-to-bandwidth ratio is worse on the GPU, not better.](assets/diagrams/memory-hierarchy.svg)

Two tiers need a word. **Shared memory** is an on-chip scratchpad that the
program manages explicitly — a cache with no replacement policy, where the kernel
decides what to load and when; on the H100 up to 228 KB of each SM's 256 KB of
L1 can be used this way (NVIDIA's Hopper tuning guide). It is the SRAM that
fast kernels stage data in. **HBM** (high-bandwidth memory) is stacks of DRAM
packaged next to the compute die: 80 GB at 3.35 TB/s. For comparison, a
current AMD EPYC 9005 socket has 12 DDR5-6400 channels, a theoretical 614 GB/s,
so a two-socket server reaches ~1.2 TB/s: HBM is roughly 2.7× that, on one card.
The weights and the KV cache live in HBM, because nothing on-chip is within a
factor of a thousand of large enough.

> [!bridge] From the Linux course
> You cared about cache blocking and NUMA placement because the arithmetic units
> were never what you waited for — the trip to far memory was. The same is true
> here, with a harsher ratio: a CPU core stalled on remote DRAM idles a few
> arithmetic units, while an H100 stalled on HBM idles nearly a quadrillion
> operations per second of tensor core. Keeping data on-chip stops being a
> tuning trick and becomes the design principle of every kernel in
> [Under the Hood](#/flashattention).
> [→ Linux: NUMA Deep Dive](../#/numa-deep-dive)

## Two ceilings

A **FLOP** is one floating-point operation: one multiply or one add. A
multiply-accumulate — the atom of a dot product — is therefore two FLOPs.
FLOP/s is the rate.

In **BF16** (bfloat16, a 2-byte floating-point format with float32's exponent
range and less precision, which neural networks tolerate well), the H100's tensor
cores peak at about 990 TFLOP/s (990 × 10¹²). That is the first ceiling.

The second ceiling is how fast data reaches the tensor cores. Every number they
multiply has to come from somewhere, and unless it already sits in registers or
on-chip memory, it comes from HBM at 3.35 TB/s. Arithmetic you cannot feed is
arithmetic you do not get.

So any operation's time is set by whichever ceiling it hits first:

```text
   T  =  max(  FLOPs ÷ peak FLOP/s ,   bytes moved ÷ peak bytes/s  )
```

Three assumptions hide in that line: compute and data movement overlap
perfectly, the peaks are reachable, and nothing else costs time. Each is
optimistic, and the next chapter measures by how much.

## The roofline

Which term wins depends on one ratio, the operation's **arithmetic intensity**:

```text
   intensity  =  FLOPs performed ÷ bytes moved to or from HBM
```

It measures how much arithmetic each byte fetched from memory pays for. Set the
two costs equal and you get the break-even intensity, a property of the chip
alone, called the **ridge point**:

```text
   I_ridge  =  peak FLOP/s ÷ peak bytes/s
   H100:       990e12 ÷ 3.35e12  ≈  295 FLOP/byte
```

Below the ridge an operation is **memory-bound**: it finishes when the bytes
arrive, and the tensor cores idle part of the time. Above it, the operation is
**compute-bound**: the bytes arrive faster than they can be used. Plot attainable
FLOP/s against intensity, both axes logarithmic so that a slope of "intensity ×
bandwidth" is a straight line, and you get the shape that names the model.

![The H100 roofline on log-log axes: a sloping bandwidth roof of attainable = intensity × 3.35 TB/s meeting a flat compute roof at 990 TFLOP/s dense BF16, the two crossing at the ridge point of 295 FLOP/byte.](assets/diagrams/roofline-h100.svg)

> [!predict] Before you read on
> Element-wise addition of two BF16 vectors, `c = a + b`. Is it memory-bound or
> compute-bound on an H100, and by roughly how much — 2×, 50×, or over 1,000×?

Memory-bound, by well over a thousand. Each element reads two 2-byte numbers and
writes one: 6 bytes moved for 1 FLOP, an intensity of 0.17 FLOP/byte — about
1,700× below the ridge. The tensor cores are irrelevant to it; it runs at memory
speed.

Matrix multiplication is different because each fetched number is reused. For a
product of an `M × K` matrix by a `K × N` matrix in BF16:

```text
   FLOPs  =  2 · M · K · N
   bytes  =  2 · (M·K + K·N + M·N)       read both inputs, write the output
```

When the weight matrix (`K × N`) is large and `M` is small, the bytes are
dominated by the weights and the intensity comes out close to `M`. **The intensity
of multiplying a batch of `M` rows by a weight matrix is roughly `M`.** One row — a
single decode token — gives about 1. A few thousand rows — a prompt in prefill —
give thousands.

Here is what the two numbers predict for one of the case model's MLP weights,
`[M × 8,192] · [8,192 × 28,672]`, as `M` grows. Look at the time column before the
last one:

```python
# Roofline prediction for one MLP weight multiply of the case model:
# [M x 8192] @ [8192 x 28672] in BF16 on an H100 SXM, from two numbers.
PEAK_FLOPS = 989e12      # dense BF16 (the spec sheet's 1,979 is "with sparsity")
PEAK_BW = 3.35e12        # HBM bytes/s
K, N, B = 8192, 28672, 2 # inner dim, output dim, bytes per BF16 number

print(f"ridge = {PEAK_FLOPS / PEAK_BW:.0f} FLOP/byte")
print(f"{'M':>5} {'GFLOP':>8} {'MB moved':>9} {'FLOP/B':>7} "
      f"{'t_math us':>9} {'t_mem us':>9} {'predicted':>9}  bound by")
for M in (1, 8, 32, 64, 128, 256, 512, 1024, 4096):
    flops = 2 * M * K * N
    nbytes = B * (M * K + K * N + M * N)   # read X and W, write Y
    t_math, t_mem = flops / PEAK_FLOPS, nbytes / PEAK_BW
    t = max(t_math, t_mem)                  # perfect overlap, no overhead
    roof = "memory" if t_mem > t_math else "compute"
    print(f"{M:>5} {flops/1e9:>8.1f} {nbytes/1e6:>9.0f} {flops/nbytes:>7.0f} "
          f"{t_math*1e6:>9.1f} {t_mem*1e6:>9.1f} {t*1e6:>8.1f}us  {roof}")

# --- output of an actual run ---
# ridge = 295 FLOP/byte
#     M    GFLOP  MB moved  FLOP/B t_math us  t_mem us predicted  bound by
#     1      0.5       470       1       0.5     140.2    140.2us  memory
#     8      3.8       470       8       3.8     140.4    140.4us  memory
#    32     15.0       472      32      15.2     140.9    140.9us  memory
#    64     30.1       474      63      30.4     141.6    141.6us  memory
#   128     60.1       479     125      60.8     143.0    143.0us  memory
#   256    120.3       489     246     121.6     145.9    145.9us  memory
#   512    240.5       508     474     243.2     151.5    243.2us  compute
#  1024    481.0       545     882     486.4     162.8    486.4us  compute
#  4096   1924.1       772    2493    1945.5     230.4   1945.5us  compute
```

*Runnable — Python 3 standard library only; output shown is from an actual run. It is a prediction from two spec-sheet numbers, not a measurement.*

From `M` = 1 to `M` = 256 the work grows 256× and the predicted time grows 4%:
the 470 MB of weights cost 140 µs whether one row or 256 ride on them. Past the
ridge, at 512 rows, the time starts to double with `M`. A real kernel will not
draw this sharp corner. It reaches roughly 85–90% of the bandwidth roof and a
smaller fraction of the compute roof, so measured times sit above the prediction
and the knee moves left, below 295. [Inference
Arithmetic](#/inference-arithmetic) puts a number on that effective knee for the
case's node, and [Lab: Your First Tokens](#/lab-first-tokens) has you measure your own.

Move the intensity yourself and see which ceiling catches you:

<div class="inf-widget" data-widget="roofline-explorer">
<p class="inf-widget-fallback">Interactive roofline explorer — needs JavaScript enabled.</p>
</div>

### Where the roofline is silent

Two cases matter for serving.

**Decode attention does not climb the roofline with batch.** The weight
multiplies get `M` = batch size, because every sequence uses the same weights.
Attention does not: each sequence reads its *own* cached keys and values. A
128-number key in BF16 is 256 bytes, and the 8 query heads that share it under
GQA each do a 128-long dot product with it, 2,048 FLOPs: an intensity of about 8,
the group size, whatever the batch. Batching makes the weight reads cheaper per
token; it does nothing for the KV reads.

**Small kernels are overhead-bound.** A decode step of the case model is on the
order of a thousand kernel launches (80 layers × about a dozen operations). Each
launch costs the CPU and driver time that is neither FLOPs nor bytes: in NVIDIA's
own CUDA Graphs example, a kernel that executes in 2.9 µs cost 9.6 µs when launched
and synchronised one by one, and 3.4 µs when replayed from a captured graph. When
kernels are this short, the GPU idles between them and neither roof binds: you see
low FLOP/s *and* low bandwidth. That third regime is why [Kernels and
Compilation](#/kernels-and-compilation) exists.

## Newer chips, same ridge

> [!predict] Before you read on
> NVIDIA's Rubin GPU has about four times the H100's dense BF16 compute. Will an
> operation that is memory-bound on an H100 become compute-bound on a Rubin?

No, because bandwidth grew by a larger factor still:

| GPU | Dense BF16 | HBM bandwidth | Capacity | Ridge |
|---|---|---|---|---|
| H100 SXM | 990 TFLOP/s | 3.35 TB/s | 80 GB | ~295 |
| H200 | 990 TFLOP/s | 4.8 TB/s | 141 GB | ~206 |
| B200 | 2,250 TFLOP/s | 8.0 TB/s | 180 GB | ~281 |
| Rubin | 4,000 TFLOP/s | 19.2 TB/s | 288 GB | ~208 |

The B200 row is NVIDIA's 8-GPU systems divided by eight: the DGX B200 lists
"1,440 GB total, 64 TB/s HBM3e bandwidth", and the HGX B200 lists 36 PFLOPS of
FP16/BF16 under a footnote that says the figure is sparse and dense is half.
The Rubin row is NVIDIA's Vera Rubin NVL72 page, which lists the GPU at "288 GB
HBM4 | 19.2 TB/s" and "FP16/BF16 4 PFLOPS" under a footnote reading "Dense
specification": 4,000 ÷ 19.2 ≈ 208.

Across three generations the ridge stays between ~200 and ~300. Each one adds
compute and bandwidth roughly in step, so a workload that is memory-bound today
stays memory-bound on the next chip — it just runs at the new chip's bandwidth.
The H200 is the instructive case: the same compute die with faster, larger HBM.
It lowers the ridge and speeds up memory-bound work by the bandwidth ratio,
4.8 / 3.35 ≈ 1.4×, while leaving compute-bound work exactly as fast as before.

## Reading a spec sheet

Here is the H100's own specification table, as NVIDIA publishes it:

```plaintext
                          H100 SXM                  H100 NVL
TF32 Tensor Core*         989 teraFLOPS             835 teraFLOPs
BFLOAT16 Tensor Core*     1,979 teraFLOPS           1,671 teraFLOPS
FP16 Tensor Core*         1,979 teraFLOPS           1,671 teraFLOPS
FP8 Tensor Core*          3,958 teraFLOPS           3,341 teraFLOPS
GPU Memory                80GB                      94GB
GPU Memory Bandwidth      3.35TB/s                  3.9TB/s
Interconnect              NVIDIA NVLink™: 900GB/s   NVIDIA NVLink: 600GB/s
                          PCIe Gen5: 128GB/s        PCIe Gen5: 128GB/s
…
* With sparsity
```

*Verbatim — trimmed and re-aligned as text; cell text copied from the specification table at nvidia.com/en-us/data-center/h100/ (fetched 2026-11-21).*

The line to read is the last one. Every tensor-core figure above carries the
asterisk, so "1,979 teraFLOPS" for BF16 is the rate *with* **2:4 structured
sparsity**: a mode in which two of every four consecutive weights are zero and the
hardware skips them. A dense model — what you are almost certainly serving —
gets half: ~990. Blackwell's sheets say the same thing in other words:
"Specification in Sparse. Dense is ½ sparse spec shown." Use the sparse figure and
every ridge and every utilisation you compute is off by 2×.

A headline FLOP figure has two flags, and you must read both: sparse or
dense, and which precision. The H100's 1,979 is BF16 with sparsity, and it is
also exactly its *dense FP8* rate (3,958 ÷ 2). Same number, two meanings.

Two more things the table shows. The variant matters: the H100 NVL is a PCIe
card with a different column, more memory and bandwidth but less compute. And the
interconnect: **NVLink** is NVIDIA's GPU-to-GPU link, 900 GB/s per H100 SXM
against 128 GB/s for PCIe Gen5 — both counted in both directions, so 450 and
64 GB/s each way. When one model is split across GPUs, they exchange
partial results every layer over that link, so it is a third ceiling, the one
[Parallelism for Inference](#/parallelism-for-inference) prices.

Finally, capacity versus bandwidth. Gigabytes decide whether the model *fits*;
terabytes per second decide how *fast* it can be read. A model that fits easily
can still be slow, because the bytes that fit must also be read.

## Seeing it on a running GPU

The usual exporter for GPU metrics is NVIDIA's DCGM exporter. These lines from
its default metric list are the ones that tell the two ceilings apart; read the
help text, not the names:

```plaintext
# Utilization (the sample period varies depending on the product)
DCGM_FI_DEV_GPU_UTIL_RATIO, gauge, GPU utilization as a ratio.
…
DCGM_FI_PROF_TENSOR_UTIL_RATIO, gauge, Ratio of cycles the tensor (HMMA) pipe is active.
DCGM_FI_PROF_DRAM_UTIL_RATIO, gauge, Ratio of cycles the device memory interface is active sending or receiving data.
```

*Verbatim — trimmed; `etc/default-counters.csv` in NVIDIA dcgm-exporter 4.9.0 (released 2026-11-06).*

The first line is the trap. Its definition lives in NVIDIA's management library:

```c
    unsigned int gpu;                //!< Percent of time over the past sample period during which one or more kernels was executing on the GPU
```

*Verbatim — the `gpu` field of `nvmlUtilization_t` in `nvml.h`, as vendored by NVIDIA's go-nvml repository (checked 2026-11-21).*

"One or more kernels was executing" — any kernel, on any number of SMs. A
memory-bound decode loop keeps a kernel running nearly all the time, so GPU
utilisation reads close to 100% while the tensor pipes are busy a few percent of
cycles. The ceiling a decode step presses on is the memory interface, and
`DCGM_FI_PROF_DRAM_UTIL_RATIO` is the field that sees it. These names are new:
dcgm-exporter 4.9.0 adopted DCGM 4.7's names, and until 4.8.4 the same three
fields were `DCGM_FI_DEV_GPU_UTIL` (in percent), `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`
and `DCGM_FI_PROF_DRAM_ACTIVE`. Dashboards and blog posts written before November
2026 use the old ones.

> [!dashboard] The GPU itself
> **Utilisation:** `DCGM_FI_PROF_DRAM_UTIL_RATIO` for decode-heavy load,
> `DCGM_FI_PROF_TENSOR_UTIL_RATIO` for prefill-heavy load — never
> `DCGM_FI_DEV_GPU_UTIL_RATIO`, which reads ~1 whenever any kernel runs.
> **Saturation:** none as a metric — a memory-bound GPU has no queue of its own;
> derive it by comparing DRAM utilisation with the ~0.85–0.9 that streaming kernels
> reach. **Errors:** `DCGM_FI_DEV_XID_ERROR` (value of the last XID, the driver's
> error code; [When It Breaks](#/when-it-breaks) reads them).

> [!case] The case: what the four H100s give you
> The Ask Halden node is four H100 SXMs joined by NVLink (900 GB/s each, both
> directions). Taken
> together:
>
> - Capacity: 4 × 80 = 320 GB of HBM. The 140 GB of BF16 weights do not
>   fit on one GPU, and two would leave too little once the engine's budget and
>   overhead are counted ([Inside a Forward Pass](#/inside-a-forward-pass): −4 GB).
> - Bandwidth: 4 × 3.35 = 13.4 TB/s. Each GPU reads its 35 GB quarter of
>   the weights every decode step, so no step can be shorter than
>   35 GB ÷ 3.35 TB/s ≈ 10.4 ms, whatever the tensor cores can do — the
>   *physics floor*, first rung of the ladder [Inference
>   Arithmetic](#/inference-arithmetic) climbs.
> - Compute: 4 × 990 = 3,960 TFLOP/s. The ridge is unchanged at ~295.
>
> **What could go wrong:** Halden pays for 3,960 TFLOP/s and its decode steps use a
> few percent of it, by design. The first time someone opens the GPU dashboard
> during the morning peak, `DCGM_FI_DEV_GPU_UTIL_RATIO` will read close to 1 on all
> four cards, and the obvious conclusion — "the node is saturated, buy a second
> one" — would double the bill for a node whose memory interface still has
> headroom. **Decision recorded:** Halden's capacity panel plots
> `DCGM_FI_PROF_DRAM_UTIL_RATIO` and tokens per step, not GPU utilisation.

## Exercises

<div class="exercise">

**Exercise 1.** Redo the script's multiply with FP8 weights and FP8 activations (one
byte per number) on the H100, whose dense FP8 peak is 1,979 TFLOP/s. Compute the
intensity at `M` = 1, 64 and 4,096 and the FP8 ridge. At what `M` does the multiply
turn compute-bound — earlier or later than in BF16?

<details>
<summary>Reveal answer</summary>

```text
  bytes = 1 · (M·8,192 + 8,192·28,672 + M·28,672)     FLOPs unchanged
  M = 1:     4.70e8 FLOPs / 2.35e8 bytes   ≈ 2
  M = 64:    3.01e10      / 2.37e8         ≈ 127
  M = 4,096: 1.92e12      / 3.86e8         ≈ 4,990
  FP8 ridge: 1,979e12 ÷ 3.35e12            ≈ 591 FLOP/byte
```

Half the bytes double the intensity (≈ 2M instead of M), and the doubled peak
doubles the ridge, so the crossing stays near `M` ≈ 295. FP8 halves the time of
every memory-bound multiply — 70 µs instead of 140 µs at small `M` — without moving
the batch size at which compute takes over.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** During a decode-heavy benchmark, a colleague pastes one
GPU's scrape and asks for an upgrade, H200 or B200, "since the GPU is pegged":

```plaintext
DCGM_FI_DEV_GPU_UTIL_RATIO{gpu="0",…} 1
DCGM_FI_PROF_DRAM_UTIL_RATIO{gpu="0",…} 0.89
DCGM_FI_PROF_TENSOR_UTIL_RATIO{gpu="0",…} 0.06
```

*Real format, illustrative values — field names from dcgm-exporter 4.9.0 `etc/default-counters.csv`, labels trimmed; values invented for the exercise.*

Which ceiling is the workload against? Estimate the speedup each upgrade would give
this decode.

<details>
<summary>Reveal answer</summary>

GPU utilisation of 1 only says a kernel was always running. The memory interface
is busy 89% of cycles — about as high as streaming kernels get — while the tensor
pipe is active 6%: the bandwidth ceiling. The low tensor figure is the
signature of a memory-bound step, not a fault.

Speedup follows bandwidth, not compute. H200: 4.8 / 3.35 ≈ 1.4×, despite
identical FLOPs. B200: 8.0 / 3.35 ≈ 2.4× — its 2.3× compute contributes nothing
here. (If the scrape had shown DRAM at 0.3 and tensor at 0.05, neither roof would
bind: suspect the overhead regime, and a bigger GPU would not help at all.)

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** A cloud offers "H100" instances below the SXM price. The
fine print says H100 NVL. Using the NVL column of the spec table above: (a) what is
its dense BF16 ridge? (b) Against an H100 SXM, how fast would Ask Halden's batch-1
decode be, and its 3,000-token prefill? (c) Does the model fit on four of them?

<details>
<summary>Reveal answer</summary>

(a) 1,671 is "with sparsity": dense BF16 is ~835 TFLOP/s. Ridge 835 ÷ 3.9 ≈ 214.

(b) Decode is memory-bound, so it scales with bandwidth: 3.9 / 3.35 ≈ 1.16×
faster. Prefill is compute-bound, so it scales with compute: 835 / 990 ≈ 0.84,
~19% slower (0.27 s becomes ~0.32 s). Same name, opposite effects on the two
phases.

(c) 4 × 94 = 376 GB against 320 GB: the 140 GB fits with more room for KV cache.
But the NVL's NVLink is a 600 GB/s bridge between cards, not the switch that
joins all four SXM GPUs: whether all four are bridged decides whether tensor
parallelism runs over NVLink or over 128 GB/s PCIe — the third ceiling, which the
spec sheet also prints.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>Does the roofline account for on-chip memory, or only HBM?</summary>

Only HBM, deliberately: `bytes moved` counts traffic across the slow off-chip
boundary, because that is the ceiling that binds. Keeping data on-chip does not
raise the roof; it raises your *intensity*, by letting one HBM read serve more
arithmetic. That is what tiling in shared memory does, and it is the idea behind
[FlashAttention](#/flashattention).

</details>

<details>
<summary>Can I move the ridge point for my workload?</summary>

Not the chip's, but you can move your operation along the axis. Storing weights in
8 bits instead of 16 halves the bytes for the same FLOPs and doubles the
intensity. Batching more rows into each weight multiply raises `M` — though not
attention's intensity, which stays at the GQA group size. Those are the two
levers, and [Quantization](#/quantization) and
[Continuous Batching](#/continuous-batching) are about them.

</details>

</div>

## What to remember

- An H100 SXM is 132 SMs of tensor cores over 80 GB of HBM at 3.35 TB/s, with
  well under 100 MB of on-chip memory, shared memory included.
- Every operation is limited by compute (990 TFLOP/s dense BF16), by bandwidth
  (3.35 TB/s) or, for short kernels, by launch overhead. Arithmetic intensity
  decides between the first two; the H100's ridge is ~295.
- Multiplying `M` rows by a large weight matrix has an intensity of roughly `M`;
  decode attention's intensity is the GQA group size, whatever the batch.
- The ridge stays at 200–300 from H100 to Rubin, so memory-bound work stays
  memory-bound and speeds up with bandwidth.
- A FLOP figure has a precision and a sparsity flag; read both, and the variant.
- "GPU utilisation" means a kernel was running. Read DRAM and tensor activity.

```quiz
[
  {
    "q": "A Llama-style model with GQA (8 query heads per KV head) decodes at batch 64 with 4K-token contexts. What is the arithmetic intensity of its attention step, and what would raising the batch to 256 do to it?",
    "choices": [
      "About 64, because attention inherits the batch size from the weight multiplies",
      "About 8, set by the GQA group size, and unchanged by the larger batch",
      "About 256, since the four times larger batch shares each cached key",
      "About 1, as in single-token decode, and it falls further as batch grows"
    ],
    "answer": 1,
    "explain": "Each sequence reads its own keys and values, so batching shares nothing. Per 256-byte BF16 key, 8 query heads do 8 × 256 FLOPs: ~8 FLOP/byte at any batch. The tempting answer, 64, applies to the weight multiplies, where every sequence reuses the same weights."
  },
  {
    "q": "A profile of a small model's decode step on an H100 shows 1.1 TB/s of HBM traffic and 6% of peak FLOP/s, with gaps between kernels on the timeline. What would speed it up most?",
    "choices": [
      "An H200, because the step is memory-bound and the H200 has more bandwidth",
      "A B200, because its extra compute lifts a step that sits far below the ridge",
      "Capturing the step as a CUDA graph, because neither roof is binding here",
      "Quantizing the weights to FP8, because that halves the bytes of every read"
    ],
    "answer": 2,
    "explain": "1.1 TB/s is a third of the bandwidth roof and 6% is far from the compute roof: neither ceiling binds. Gaps between kernels point to launch overhead, the regime CUDA graphs remove. More bandwidth or fewer bytes would help only if the memory interface were busy, and here it mostly waits for the next launch."
  },
  {
    "q": "A vendor slide lists a GPU at '4.5 PFLOPS' and 8 TB/s, with no footnote. You will serve an FP8 model with FP8 arithmetic. What should you do before computing a ridge?",
    "choices": [
      "Halve it to 2.25 PFLOPS, since slide figures always include the sparsity bonus",
      "Use 4.5 PFLOPS as given, since a figure with no footnote is a dense figure",
      "Double it to 9 PFLOPS, since FP8 runs twice as fast as the figure's precision",
      "Ask its precision and sparsity: a B200's 4.5 is BF16 sparse and FP8 dense"
    ],
    "answer": 3,
    "explain": "On a B200, 4.5 PFLOPS is the per-GPU BF16 rate with sparsity and also the dense FP8 rate. For FP8 the dense ridge is 4.5e15 ÷ 8e12 ≈ 562; for BF16 it is 2.25e15 ÷ 8e12 ≈ 281. Halving by reflex is right for one reading and wrong by 2× for the other."
  },
  {
    "q": "What is the H100's ridge point, and what does it mean?",
    "choices": [
      "About 80 GB: the most data an operation can touch before spilling",
      "About 132: one unit of work per SM before the chip saturates",
      "About 295 FLOP/byte: below it, an operation waits on memory",
      "About 3.35 TB/s: the bandwidth above which compute limits speed"
    ],
    "answer": 2,
    "explain": "The ridge is peak FLOP/s divided by peak bytes/s — 990e12 / 3.35e12 ≈ 295 FLOP/byte. Operations with lower arithmetic intensity are memory-bound; higher, compute-bound. 80 GB is capacity, 3.35 TB/s is the bandwidth ceiling itself, and the SM count does not enter the ridge."
  },
  {
    "q": "On an A100 80 GB SXM (312 TFLOP/s dense BF16, 2,039 GB/s), a weight multiply with M = 200 rows is compute-bound. You move it unchanged to an H100 SXM. Which ceiling binds now?",
    "choices": [
      "Memory: 200 is above the A100's ridge of ~153 but below the H100's ~295",
      "Compute: an operation that is compute-bound on one chip stays so on any newer one",
      "Compute: the H100's 3× FLOP/s raises the ridge to roughly 460 for it",
      "Neither: at M = 200 both GPUs sit exactly on their ridge points"
    ],
    "answer": 0,
    "explain": "Intensity ≈ M = 200. A100 ridge: 312e12 ÷ 2.039e12 ≈ 153, so compute-bound there. H100 ridge: ≈ 295, so memory-bound. The H100 added more compute than bandwidth relative to the A100, which moved the ridge right; 'stays compute-bound' assumes ridges never move."
  }
]
```
