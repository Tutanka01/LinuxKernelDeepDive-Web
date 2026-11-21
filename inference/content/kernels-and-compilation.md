# Kernels, Graphs & Compilation

> **The question:** a decode step is a thousand small GPU programs launched by a
> CPU — when does the launching, rather than the computing, become the bottleneck,
> and what do CUDA graphs and compilers do about it?
>
> **You'll be able to:** compute whether a step is launch-bound from its kernel
> count, kernel durations and launch cost; say what a captured CUDA graph fixes in
> place and what vLLM v0.34 captures; read a small Triton kernel and say what fusion
> does to the bytes moved; read a startup log to tell where a cold start went and
> when the server can take traffic.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kernels,runner"></div>

[FlashAttention](#/flashattention) took one kernel apart. But attention is one stop
on a long line. A decode step for Llama-3.3-70B runs, in every one of its 80
layers, a norm, the Q/K/V projection, a RoPE rotation, attention, the output
projection, an all-reduce across the four GPUs (combining their partial results —
[Parallelism for Inference](#/parallelism-for-inference) owns it), a residual add,
another norm, the MLP's matrix multiplies and activation, another all-reduce and
another residual: about 13 GPU programs per layer, ~1,000 per token before any
fusion. This chapter is about the machinery that makes that stream fast.

## What a kernel is

A **GPU kernel** is one function run by thousands of threads at once, spread across
the GPU's SMs. The CPU launches it by placing a work item on a queue (a CUDA
stream); the GPU executes queued items asynchronously while the CPU moves on to
queue the next one. The CPU is a dispatcher; the GPU is the workforce.

Here is a real one, written in **Triton**, the Python-embedded language in which
most of an engine's non-matmul kernels are written. It computes a row-wise softmax:

```python
@triton.jit
def softmax_kernel(output_ptr, input_ptr, input_row_stride, output_row_stride, n_rows, n_cols, BLOCK_SIZE: tl.constexpr,
                   num_stages: tl.constexpr):
    # starting row of the program
    row_start = tl.program_id(0)
    row_step = tl.num_programs(0)
    for row_idx in tl.range(row_start, n_rows, row_step, num_stages=num_stages):
        # The stride represents how much we need to increase the pointer to advance 1 row
        row_start_ptr = input_ptr + row_idx * input_row_stride
        # The block size is the next power of two greater than n_cols, so we can fit each
        # row in a single block
        col_offsets = tl.arange(0, BLOCK_SIZE)
        input_ptrs = row_start_ptr + col_offsets
        # Load the row into SRAM, using a mask since BLOCK_SIZE may be > than n_cols
        mask = col_offsets < n_cols
        row = tl.load(input_ptrs, mask=mask, other=-float('inf'))
        # Subtract maximum for numerical stability
        row_minus_max = row - tl.max(row, axis=0)
        # Note that exponentiation in Triton is fast but approximate (i.e., think __expf in CUDA)
        numerator = tl.exp(row_minus_max)
        denominator = tl.sum(numerator, axis=0)
        softmax_output = numerator / denominator
        # Write back output to DRAM
        output_row_start_ptr = output_ptr + row_idx * output_row_stride
        output_ptrs = output_row_start_ptr + col_offsets
        tl.store(output_ptrs, softmax_output, mask=mask)
```

*Verbatim — `python/tutorials/02-fused-softmax.py` in triton-lang/triton at tag v3.9.0 (2026-10-27).*

Read it as tile code, not thread code. `tl.program_id(0)` is which *program* this
is — Triton's unit of work is a program that owns a tile, and the compiler decides
how its threads share it. `tl.arange(0, BLOCK_SIZE)` is the tile: a vector of
column offsets, padded to a power of two, which is why every load and store
carries `mask`. One `tl.load` brings a whole row on chip; `max`, `exp`, `sum` and
the division run there; one `tl.store` writes the result. The line to notice is
the comment on the load: the *whole row* goes into on-chip memory. That works for
rows of a few thousand numbers. Attention's rows at 32K tokens do not fit, which
is the problem online softmax solved.

The tutorial launches it with one call, `kernel[(num_programs, 1, 1)](y, x, …)`:
the bracket is the grid, here one program per SM times the number that fit on an
SM at once. That call is the CPU's whole contribution — and its cost is this
chapter's first subject.

## When launching costs as much as computing

A launch costs CPU time whatever the kernel then does. NVIDIA's [CUDA graphs
introduction](https://developer.nvidia.com/blog/cuda-graphs/) measured kernels
that ran for 2.9 µs taking 3.8 µs each when launched back to back (V100, CUDA
10.1); Hazy Research measured an empty kernel on an H100 at about 2.1 µs on a
stream and 1.3 µs inside a graph ([No
Bubbles](https://hazyresearch.stanford.edu/blog/2025-05-27-no-bubbles)). A
framework adds its own Python and dispatcher work on top of the driver's, which
these figures do not include — `torch.profiler` shows it on your stack.

Whether launches hurt depends on order, not just totals. The CPU issues kernel `i`
at time `i × L`; the GPU starts it when the launch has arrived *and* the previous
kernel has finished. While the GPU is busy with a long matrix multiply, the CPU
runs ahead and banks launches; a run of tiny kernels spends that bank, and once it
is empty the GPU waits on each launch.

> [!predict] Before you read on
> One GPU of Halden's node at batch 1 runs ~1,040 kernels per step: per layer,
> four matrix multiplies of 42, 33.5, 235 and 117 MB of weights and nine small
> kernels of ~3 µs. How large can the per-launch CPU cost get before the step
> becomes launch-bound — around 2 µs, 13 µs, or 50 µs?

```python
# Async launches: the CPU issues kernel i at i*L; the GPU starts it when both
# the launch has arrived and the previous kernel has finished.
def step_us(kernels_us, launch_us):
    done = 0.0
    for i, k in enumerate(kernels_us):
        done = max(done, (i + 1) * launch_us) + k
    return done

BW = 2.85e6                      # bytes per µs at ~85% of 3.35 TB/s (rung 2)
def gemm(mb): return mb * 1e6 / BW
TINY = 3.0                       # norm, RoPE, add, activation, attention at batch 1 (µs)

# Llama-3.3-70B, one GPU of TP=4, batch 1: per layer, weights in MB
layer70 = [TINY, gemm(42), TINY, TINY, gemm(33.5), TINY, TINY,
           TINY, gemm(235), TINY, gemm(117), TINY, TINY]
step70 = layer70 * 80

for L in (0.0, 4.0, 10.0, 15.0):
    print(f"70B/GPU  launch {L:4.1f} µs: step {step_us(step70, L) / 1000:5.2f} ms"
          f"  (GPU work {sum(step70) / 1000:.2f} ms, {len(step70)} kernels)")

# 70B/GPU  launch  0.0 µs: step 14.16 ms  (GPU work 14.16 ms, 1040 kernels)
# 70B/GPU  launch  4.0 µs: step 14.17 ms  (GPU work 14.16 ms, 1040 kernels)
# 70B/GPU  launch 10.0 µs: step 14.21 ms  (GPU work 14.16 ms, 1040 kernels)
# 70B/GPU  launch 15.0 µs: step 15.67 ms  (GPU work 14.16 ms, 1040 kernels)
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. The 3 µs small-kernel time is an assumption near Hazy Research's measured launch floor; the all-reduces are counted as small kernels.*

About 13 µs: the break-even launch cost is the *average* kernel time, 14.16 ms ÷
1,040 ≈ 13.6 µs. Below it the 235 MB MLP multiply (~82 µs) lets the CPU bank enough
launches to cover the small kernels that follow; above it the dispatcher falls
behind for good, and at 15 µs the step grows by 1.5 ms. Note also the total: the
GPU's own work comes to ~14 ms, rung 3 of the case's ladder, because nine small
kernels per layer add ~2 ms to the ~12 ms weight read. A 70B model on four GPUs
has long kernels and is rarely launch-bound with graphs; a small model at batch 1
has short ones and is (Exercise 3).

> [!bridge] From the Linux course
> A syscall costs a fixed boundary crossing whether it moves one byte or a megabyte,
> and `io_uring`'s answer was to describe many operations once and submit them in one
> crossing. Kernel launches have the same shape. What differs is who waits: with a
> syscall, the CPU itself does the work afterwards; here every microsecond of
> dispatch is a microsecond in which a much more expensive device has nothing to do.
> [→ Linux: Modern I/O & io_uring](../#/modern-io)

![Timeline comparison: launching four kernels eagerly leaves the GPU idle in the gaps between CPU dispatches, while a single CUDA graph replay fires the same four kernels back to back with no gaps](assets/diagrams/launch-gap-v3.svg)

## CUDA graphs: record once, replay in one launch

The kernels of a decode step are the same every step: same kernels, same order,
same shapes. **CUDA graphs** exploit that. The engine runs a step once in *capture
mode*: instead of executing, CUDA records every launch and its arguments. Every
later step **replays** the record with one launch. PyTorch's documentation shows
the whole contract in twenty lines:

```python
g = torch.cuda.CUDAGraph()

# Placeholder input used for capture
static_input = torch.empty((5,), device="cuda")

# Warmup before capture
s = torch.cuda.Stream()
s.wait_stream(torch.cuda.current_stream())
with torch.cuda.stream(s):
    for _ in range(3):
        static_output = static_input * 2
torch.cuda.current_stream().wait_stream(s)

# Captures the graph
# To allow capture, automatically sets a side stream as the current stream in the context
with torch.cuda.graph(g):
    static_output = static_input * 2

# Fills the graph's input memory with new data to compute on
static_input.copy_(torch.full((5,), 3, device="cuda"))
g.replay()
# static_output holds the results
print(static_output)  # full of 3 * 2 = 6
```

*Verbatim — trimmed after the first replay; `docs/source/notes/cuda.md` ("CUDA Graphs → PyTorch API") in pytorch/pytorch at tag v2.15.0.*

The warm-up runs first, on a side stream, so that one-time work — allocations,
library initialisation, autotuning — is not recorded. Inside `torch.cuda.graph(g)`
nothing executes; the multiply is recorded. Then the line that explains every
constraint below: `static_input.copy_(…)`. A replay runs "the same kernels with the
same arguments. For pointer arguments this means the same memory addresses are
used", in the documentation's words, so new data must be copied *into* the buffers
the graph was recorded with, and the result appears in the buffer it wrote.

A captured graph therefore fixes in place the kernel sequence, every kernel's grid,
and every address. What it does not fix is what those addresses *contain*. That
gives an engine three obligations:

- **Static buffers.** Inputs, outputs and intermediates live at fixed addresses
  for the life of the process; the graphs' memory pool comes out of what would
  otherwise be KV cache. vLLM estimates it before sizing the pool and logs the
  actual figure after capture (`CUDA graph pool memory: … GiB (actual), … GiB
  (estimated)`).
- **Size buckets.** A graph recorded for 16 sequences runs 16 rows. vLLM captures a
  grid of sizes at startup and pads a batch of 13 up to the 16 graph. More sizes
  mean less padding, more memory and a longer startup.
- **Bounded variation.** Anything that would change a grid or a buffer size must be
  capped at capture. That is why FlashAttention's split count is held to 32 under
  graphs ([FlashAttention](#/flashattention)).

Varying sequence lengths are *not* on that list. An attention kernel reads lengths
and block tables from device memory at run time, so a replay with new lengths is
the same launch over new contents. What made attention hard to capture was backend
support for arbitrary mixed batches. vLLM v0.34's default, `FULL_AND_PIECEWISE`,
follows the line between the two:

```python
class CUDAGraphMode(enum.Enum):
    …
    NONE = 0
    PIECEWISE = 1
    FULL = 2
    FULL_DECODE_ONLY = (FULL, NONE)
    FULL_AND_PIECEWISE = (FULL, PIECEWISE)
```

*Verbatim — trimmed; vLLM v0.34.0 `vllm/config/compilation.py`. Its docstring: "FULL_AND_PIECEWISE mode: Capture full cudagraph for decode batches and piecewise cudagraph for prefill and mixed prefill-decode batches. This is the most performant mode for most models and is the default."*

A pair means "this mode for uniform decode batches, that one for the rest". A
step in which every sequence is decoding replays one **full** graph, attention
included — FlashAttention 3, Halden's backend, supports that for every batch shape.
A step that carries a prefill chunk replays **piecewise** graphs, with attention run
eagerly between them, because many backends "only support CUDA Graphs for pure
decode batches" (vLLM's CUDA-graph design notes). The pieces are what
`torch.compile` produces when vLLM splits the model at its attention operations:

```text
  decode-only step (FULL):       [ one graph: 80 × (norm, QKV, RoPE, attention, O-proj, MLP, …) ]
  step with prefill (PIECEWISE): [graph] → attention (eager) → [graph] → attention (eager) → … → [graph]
```

## Fusion: stop round-tripping to HBM

Graphs remove launch cost but leave each kernel's work unchanged. A compiler changes
the work. `torch.compile` captures the model's Python as a graph of operations, and
its Inductor backend generates fused Triton kernels for runs of them; vLLM adds
its own fusion passes for patterns it knows, such as a residual add fused with the
RMSNorm that follows it, or the all-reduce fused with that norm.

> [!predict] Before you read on
> Written as five PyTorch operations (row max, subtract, exp, row sum, divide), a
> softmax over an M × N matrix runs as five kernels, each reading its input from HBM
> and writing its output. Roughly how many elements cross the HBM boundary, and how
> many for the fused kernel above?

The Triton tutorial counts them in its comments: the five-operation version reads
`5MN + 2M` elements and writes `3MN + 2M`; the fused kernel reads `MN` and writes
`MN`. That is `(8MN + 4M) ÷ 2MN`, about 4× fewer bytes for the same arithmetic —
four times the arithmetic intensity, and for a memory-bound operation close to four
times the speed. It is also why ~1,000 is
an upper bound on the kernel count: an engine's compiled step launches fewer,
larger kernels than the operation list suggests.

## Who writes kernels, and MoE's special case

Triton covers fused elementwise work, norms, sampling and many attention and MoE
paths — written in hours, short of peak. **CUTLASS**, NVIDIA's C++ template library
for matrix multiplies, and CuTe-DSL, its Python form, reach near peak for the
hottest matmuls and attention (FlashAttention 4 is written in CuTe-DSL);
hand-written CUDA covers a few critical paths (FlashMLA, DeepGEMM). The trade is
development time against the last fraction of peak, and it is only worth paying for
kernels that dominate the profile.

A **mixture-of-experts** model replaces each MLP with many expert MLPs and routes
each token to a few of them ([Serving MoE at Scale](#/moe-serving)). One large
multiply becomes many small ones of unpredictable size — expert 3 gets 5 tokens this
step, expert 7 gets 200. A **grouped GEMM** does all of them in one launch: tokens
are first sorted by expert (padding each expert's count to the tile size), and the
kernel walks a list of `(expert, rows)` problems that share the weight shape.
Across GPUs, moving tokens to their experts is an all-to-all exchange — every GPU
sends to every other — which [Serving MoE at Scale](#/moe-serving) prices along
with DeepSeek's DeepEP library for it.

> **State of play (November 2026):** even replayed graphs leave a gap at every
> kernel boundary. A **megakernel** fuses a whole forward pass into one persistent
> kernel. Hazy Research's first one, for Llama-3.2-1B at batch 1, ran "almost 2.5x
> faster than vLLM" and over 1.5× faster than SGLang on an H100, where those engines
> used "at most 50% of available GPU bandwidth" ([No
> Bubbles](https://hazyresearch.stanford.edu/blog/2025-05-27-no-bubbles), May 2025).
> It is no longer research-only: SGLang v0.5.23 ships opt-in NVIDIA megakernel and
> AMD monokernel plugins (`--enable-nvidia-megakernel`) that "run
> DeepSeek-V4.1-Flash decode as fused persistent kernels, for up to 44% faster
> single-user decode on GB300 and 75% on MI350X", and vLLM v0.33 added a
> `--monokernel` decode for some models on ROCm. Note the conditions: one model
> family, single-user decode — where the step is shortest and boundaries cost most.

## The startup lifecycle

All of this — compilation, autotuning, graph capture — happens before vLLM serves
anything. Its `torch.compile` design notes say so: "we guarantee all the
compilation finishes before we serve any requests. No requests will trigger new
compilations." The server's socket is bound early, but it listens only after the
engine has finished initialising; until then `/health` cannot answer at all, and
afterwards it returns 200 while the engine is alive and 503 if it has died.

```plaintext
INFO … Using cache directory: /root/.cache/vllm/torch_compile_cache/…/rank_0_0 for vLLM's torch.compile
INFO … torch.compile took 14.80 s in total
INFO … Available KV cache memory: 30.73 GiB
INFO … GPU KV cache size: 402,816 tokens, Maximum concurrency for 131,072 tokens per request: 3.07x
Capturing CUDA graphs (PIECEWISE): 100%|██████████| …
Capturing CUDA graphs (FULL): 100%|██████████| …
INFO … Graph capturing finished in 12 secs, took 0.84 GiB
INFO … init engine (profile, create kv cache, warmup model) took 34.10 s (compilation: 14.80 s)
INFO … Starting vLLM server on http://0.0.0.0:8000
```

*Real format, illustrative values — messages from vLLM v0.34.0 (`vllm/compilation/backends.py`, `monitor.py`, `vllm/v1/worker/gpu_worker.py`, `kv_cache_utils.py`, `vllm/v1/worker/gpu/cudagraph_utils.py` and `model_runner.py`, `vllm/v1/engine/core.py`, `vllm/entrypoints/launchers/api_server/entry.py`), prefixes trimmed, order condensed; pool and token figures from the case's 33 GB per GPU, times and graph memory invented within the source's own "5~20 seconds" comment, not measured.*

Read the first and last lines. "Using cache directory" says where compiled
artefacts are stored and looked up; on a warm cache the log instead says it will
"Directly load the compiled graph(s) … from the cache". The last line is the moment
the server can be reached. Everything above it is time the node serves nobody.

> [!dashboard] The launch path
> **Utilisation:** `DCGM_FI_DEV_GPU_UTIL_RATIO` (some kernel running) against
> `DCGM_FI_PROF_DRAM_UTIL_RATIO` — a busy GPU with idle memory at batch 1 hints at
> launch or kernel-boundary gaps; `process_cpu_seconds_total` for the engine
> process. **Saturation:** none as a metric — derive from a trace: gaps between
> kernels that scale with their *number*. **Errors:** none — cold-start time is read
> from the `init engine … took` and `Starting vLLM server` log lines.

> [!case] The case: a restart is an outage
> Until the FP8 evaluation passes (and for good under the BF16 fallback), Ask Halden
> runs one replica. Every restart — an upgrade, a flag change, a crash — takes it
> offline from the moment the process stops until "Starting vLLM server": weight load, profiling, compilation, graph capture. No request pays for
> the compiler, because none is admitted before it finishes; what users see is the
> outage. In staging, the first deploy took longer than the later ones because the
> compile cache started empty; the first request after readiness was as fast as
> any other.
>
> **What this settles:** CUDA graphs stay on (no `--enforce-eager`, which disables
> them, and with them the launch savings); `VLLM_CACHE_ROOT` sits on a persistent
> volume so a restart loads compiled artefacts instead of rebuilding them; the
> orchestrator's readiness probe is vLLM's own `/health`; restarts are scheduled
> outside 09:00–11:00, and the restart time is measured from the log on every
> deploy. Two FP8 replicas turn this into a rolling restart, and [Operating
> It](#/operating-it) takes over.

## Exercises

<div class="exercise">

**Exercise 1.** Launches cost L = 5 µs. A stretch of ten kernels takes (µs)
`[40, 3, 3, 2, 30, 3, 2, 3, 60, 3]`. (a) With the recurrence above, when does the
last kernel finish? (b) Compare with Σk and with Σ max(L, k). (c) The same kernels
run in the order `[3, 3, 2, 3, 2, 3, 3, 40, 30, 60]`. What changes, and why?

<details>
<summary>Reveal answer</summary>

(a) Finish times: 45, 48, 51, 53, 83, 86, 88, 91, 151, **154 µs**. Only the first
launch shows: every later launch has arrived before the GPU needs it.

(b) Σk = 149 µs; Σ max(L, k) = 165 µs, the pessimistic bound for a CPU that never
gets ahead.

(c) 8, 13, 17, 23, 27, 33, 38, 80, 110, **170 µs**. The seven small kernels come
first, before any long kernel lets the CPU bank launches, so each waits for its own
launch: 21 µs lost instead of 5. Order matters, not only totals.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team runs vLLM in Kubernetes behind a sidecar proxy.
After a scale-up, the load balancer marks the new pod ready at 06:00:12, and
requests to it fail with 502s for over three minutes. Its log:

```plaintext
06:00:09 INFO … Using cache directory: /root/.cache/vllm/torch_compile_cache/…/rank_0_0 for vLLM's torch.compile
06:02:51 INFO … torch.compile took 162.40 s in total
06:03:21 INFO … Graph capturing finished in 18 secs, took 0.84 GiB
06:03:22 INFO … init engine (profile, create kv cache, warmup model) took 196.32 s (compilation: 162.40 s)
06:03:23 INFO … Starting vLLM server on http://0.0.0.0:8000
```

*Real format, illustrative values — messages from vLLM v0.34.0 as in the startup log above; timestamps and durations invented for the exercise.*

The readiness probe is a TCP check on port 8080, the proxy's. The pod's root
filesystem is ephemeral. What is happening, and what do you change?

<details>
<summary>Reveal answer</summary>

The probe checks the proxy, which answers immediately; vLLM itself listens only at
06:03:23, after initialisation. Every request in between hits a proxy with nothing
behind it. Point readiness at vLLM's `/health` on its own port.

The 162 s of compilation is a cold cache: the log looked in `/root/.cache/vllm`,
which an ephemeral filesystem empties on every new pod, and it never printed
"Directly load". Mount `VLLM_CACHE_ROOT` (and `TRITON_CACHE_DIR`, if set) on a
persistent volume shared by replicas of the same image and config. Then scale
earlier: even warm, a replica takes tens of seconds before it serves.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Llama-3.2-1B (16 layers, hidden 2,048, MLP 8,192, 8 KV
heads of 64, tied 128,256-token vocabulary; 2.5 GB in BF16) serves one user on an
H100. Per layer its four matrix multiplies read 12.6, 8.4, 67.1 and 33.6 MB; the LM
head reads 525 MB; there are seven small kernels per layer of ~3 µs. Which regime
dominates a decode step — weight reads, arithmetic, or kernel overheads — and what
would you change?

<details>
<summary>Reveal answer</summary>

Arithmetic: 2 × 1.24e9 FLOPs ≈ 2.5 GFLOP, about 6 µs at 40% of 989 TFLOP/s —
irrelevant. Weights: 2.47 GB ÷ 2.85 TB/s ≈ 0.87 ms. Small kernels: (16 × 7 + 2) × 3
µs ≈ 0.34 ms. The step model gives 1.21 ms of GPU work in 179 kernels, an average
of 6.8 µs per kernel: launch-bound for any per-launch cost above that, which an
eager framework easily exceeds. With graphs, ~28% of the step is still small-kernel
time, and the weight floor (0.74 ms at nameplate) is ~61% of it — consistent with
Hazy Research's "at most 50%" of bandwidth for engines on this model.

So: graphs first; then fewer kernels (fusion, then a megakernel), because halving
the weight bytes with quantization would remove ~0.4 ms but leave the 0.34 ms of
boundaries untouched. On the 70B the same changes are worth little — its kernels
are long.

</details>

</div>

<div class="exercise">

**Exercise 4 — find the flaw.** A change request for Ask Halden's node: *"To cut
restart time, add `--enforce-eager` (no compilation, no graph capture) and set
`VLLM_DISABLE_COMPILE_CACHE=1` so stale artefacts can't bite. Graphs only matter for
small models and our 70B is memory-bound anyway, so TPOT won't move — and the
0.84 GiB per GPU the graphs took goes back to the KV cache."* Find the errors.

<details>
<summary>Reveal answer</summary>

1. `--enforce-eager` does more than skip capture: in vLLM v0.34 it sets the
   compilation mode to none as well, so the fused kernels go too — more kernels,
   more bytes per step. "TPOT won't move" is a prediction; the launch model says the
   70B hides launches only while the per-launch cost stays under ~13 µs, and eager
   dispatch was never measured. Run `vllm bench serve` at concurrency 1 and 20,
   both ways, before deciding.
2. Disabling the compile cache works *against* restart time: with a cache on a
   persistent volume, a restart loads compiled graphs instead of rebuilding them.
3. The memory argument is small: 0.84 GiB per GPU is about 11,000 tokens of KV,
   three full-length requests in a pool of ~123.
4. It optimises the wrong term. Restart time is usually dominated by loading the
   weights ([Operating It](#/operating-it)), and a warm compile cache already
   removes most of the compilation.

</details>

</div>

## What to remember

- A decode step is ~1,000 kernels before fusion. Launches hurt when kernels are
  shorter than a launch and nothing long lets the CPU get ahead: compute
  `done = max(done, i·L) + k` before blaming the dispatcher.
- A CUDA graph fixes the kernel sequence, grids and addresses; data must be copied
  into static buffers, batches padded to captured sizes, and the graph pool comes
  out of the KV pool.
- vLLM v0.34 replays one full graph for decode-only steps and piecewise graphs,
  attention outside, for steps with prefill.
- Fusion keeps intermediates on chip: same FLOPs, fewer bytes — ~4× for softmax.
- vLLM compiles and captures before it listens: no request pays for the compiler;
  restarts cost availability instead.

```quiz
[
  {
    "q": "A 7B model on one GPU runs 450 kernels per decode step totalling 3.6 ms of GPU work, with no single kernel longer than 40 µs. The eager framework costs about 12 µs per launch. Roughly what step time should you expect without graphs?",
    "choices": [
      "About 3.6 ms, because the CPU always runs ahead and hides every launch",
      "About 5.4 ms: 450 × 12 µs of dispatch, which exceeds the GPU's work",
      "About 9.0 ms, the 5.4 ms of dispatch and the 3.6 ms of GPU work added",
      "About 3.6 ms plus a single 12 µs launch for the first kernel"
    ],
    "answer": 1,
    "explain": "The average kernel is 3.6 ms ÷ 450 = 8 µs, below the 12 µs launch, so the dispatcher cannot stay ahead: the step approaches 450 × 12 µs = 5.4 ms. Adding the two (9 ms) would assume the CPU and GPU never overlap; 3.6 ms would need launches cheaper than the average kernel."
  },
  {
    "q": "You set cudagraph_mode to FULL_DECODE_ONLY on a decode-only instance of a disaggregated deployment. What happens to a step that carries a prefill chunk, if one arrives?",
    "choices": [
      "It replays the full decode graph with the prefill tokens padded in",
      "It is rejected with an error, because no graph was captured for its shape",
      "It runs without CUDA graphs, eagerly, since no piecewise graphs exist",
      "It is captured on the fly as a new full graph, then cached for later steps"
    ],
    "answer": 2,
    "explain": "FULL_DECODE_ONLY = (FULL, NONE): full graphs for uniform decode batches and no graphs for anything else, which saves the piecewise graphs' memory where prefill is rare. vLLM never captures during serving, and a decode graph cannot absorb a prefill's different token count."
  },
  {
    "q": "Why can a full CUDA graph of a decode step include attention, even though every sequence's length grows by one each step?",
    "choices": [
      "Graphs record shapes only loosely, so lengths may change freely between replays",
      "Engines re-capture the attention part of the graph at every decode step",
      "Attention is skipped during replay and recomputed on the CPU afterwards",
      "The kernel reads lengths and block tables from device memory at run time"
    ],
    "answer": 3,
    "explain": "A graph fixes kernels, grids and addresses, not the contents of buffers. Sequence lengths and block tables are data in fixed buffers, so a replay over new lengths is the same launch. What must be bounded at capture is anything that changes a grid or a buffer size — hence the cap on FlashAttention's split count."
  },
  {
    "q": "Three elementwise operations on an activation of N bytes each read their input and write their output. Fused into one kernel, what changes?",
    "choices": [
      "Bytes moved fall from 6N to 2N; the FLOPs stay the same",
      "The FLOPs fall by two-thirds, since two operations disappear",
      "Nothing measurable, since elementwise operations are cheap anyway",
      "The kernel becomes compute-bound because it now does all three operations"
    ],
    "answer": 0,
    "explain": "Unfused, each operation reads N and writes N (6N); fused, the data is read once and written once (2N) with the intermediates kept on chip. The same arithmetic over a third of the bytes triples the intensity — still far below the ridge, so the gain is speed, not a change of regime."
  },
  {
    "q": "vLLM's log shows 'Graph capturing finished in 15 secs, took 3.10 GiB' on each GPU after you widened the capture sizes. What did the change cost besides startup time?",
    "choices": [
      "Nothing at run time, because graph memory is released once capture finishes",
      "3.10 GiB per GPU of pinned host memory, where the captured graphs are kept",
      "About 3.10 GiB per GPU of KV cache, since graph buffers share its budget",
      "Lower throughput, because wider graphs pad every batch to the largest size"
    ],
    "answer": 2,
    "explain": "Captured graphs keep their memory pool for the life of the process, and vLLM accounts for it before sizing the KV pool — about 3 GiB per GPU, roughly 40K tokens at the case's 82 KB per token per GPU. Batches pad to the nearest captured size, not the largest, so wider capture reduces padding."
  }
]
```
