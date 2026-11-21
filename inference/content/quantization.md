# Quantization

> **The question:** a decode step costs the bytes it reads and the arithmetic it
> does — how far can fewer bits per number shrink each, and what does each
> format buy in speed and capacity, on which hardware?
>
> **You'll be able to:** read a format name or a checkpoint's
> `quantization_config` and say what is stored, at what granularity, and what
> stays in 16 bits; compute weight and KV sizes and the step time each format
> buys at a given batch and context, with the course's one step model; choose
> formats and a launch line for a deployment, and say what would change the
> choice.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,kv"></div>

[Inference Arithmetic](#/inference-arithmetic) priced a decode step with one
model, used everywhere in this course:

```text
   step  ≈  max(t_w, t_c)  +  t_kv
            t_w  = time to read the weights (once per step)
            t_c  = arithmetic for every token in the step
            t_kv = time to read every running sequence's KV cache
```

Storing numbers in fewer bits — **quantization** — shrinks `t_w` and `t_kv`
directly. Doing the arithmetic in fewer bits shrinks `t_c`, but only on chips
that run the format natively. Read this chapter to choose a format, and
[Did Quantization Break Your Model?](#/did-quantization-break-your-model)
before you ship one.

## What fewer bits buys

On Halden's node each of the four GPUs reads its quarter of the weights every
step. At the achievable ~2.85 TB/s (rung 2 of the decode ladder):

```text
   BF16  (2 bytes):   140 GB  →  35 GB per GPU  →  12.3 ms of reading
   FP8   (1 byte):     70 GB  →  17.5 GB        →   6.1 ms
   4-bit (~0.5 byte):  40 GB  →  10 GB          →   3.5 ms
```

Published files run a little larger: the FP8 Llama-3.3-70B Halden will use is
72.7 GB and a popular AWQ 4-bit one 39.8 GB, because the embedding table and the
LM head (1.05 B parameters each) stay in 16 bits. The course keeps the case's
70 GB for FP8 and uses 40 GB for 4-bit. The same shrink pays three more ways:

- **Capacity.** Smaller weights leave more memory for the KV cache, and a smaller
  KV format makes each sequence cheaper. Both raise concurrency.
- **Fit.** 70B at 4 bits fits on one 80 GB GPU; at 8 bits, on two. In BF16 it
  needs four ([Inside a Forward Pass](#/inside-a-forward-pass) showed two GPUs
  come up 4 GB short).
- **Compute, on the right chip.** Tensor cores run lower precision faster: an
  H100 does FP8 at about twice its BF16 rate, and Blackwell does FP4 at about
  twice FP8. That shrinks `t_c` in prefill and in large decode batches.

> [!bridge] From the Linux course
> This is the zswap trade: spend some arithmetic to unpack a smaller
> representation so fewer bytes cross a slow boundary. What differs is
> reversibility. The kernel's compression is lossless; quantization rounds, and
> the rounding is permanent — which is why this chapter has a sequel about
> measuring damage.
> [→ Linux: Virtual Memory](../#/memory)

## What a number format is

A floating-point format splits its bits into a sign, an **exponent** (which power
of two the number lives near — its range) and a **mantissa** (the precision
within that range):

```text
   BF16   [S][E E E E E E E E][M M M M M M M]   8 exponent, 7 mantissa
   E4M3   [S][E E E E][M M M]                   an FP8: 4 exponent, 3 mantissa
   E5M2   [S][E E E E E][M M]                   an FP8: more range, less precision
   E2M1   [S][E E][M]                           FP4
```

E4M3 is used for weights, activations and KV; E5M2, with its wider range, mostly
for gradients in training. Decoding one byte by hand shows what 8 bits buy:

```python
def e4m3(byte):  # OCP FP8 E4M3 ("e4m3fn"): 1 sign, 4 exponent (bias 7), 3 mantissa bits
    sign = -1.0 if byte & 0x80 else 1.0
    exp, man = (byte >> 3) & 0xF, byte & 0x7
    if exp == 0xF and man == 0x7:
        return float("nan")                    # the only NaN pattern; there is no infinity
    if exp == 0:
        return sign * man / 8 * 2.0 ** -6      # subnormal: no implicit leading 1
    return sign * (1 + man / 8) * 2.0 ** (exp - 7)

for b in (0x01, 0x38, 0x39, 0x3A, 0x5A, 0x5B, 0x7E, 0x7F, 0xB8):
    print(f"0x{b:02X} = {b:08b} -> {e4m3(b)}")

grid = sorted({e4m3(b) for b in range(0x7F)})  # the 127 non-negative finite codes
x = 0.3
lo = max(v for v in grid if v <= x); hi = min(v for v in grid if v >= x)
best = min((lo, hi), key=lambda v: abs(v - x))
print(f"{len(grid)} values from 0 to {grid[-1]}; 0.3 lies between {lo} and {hi}")
print(f"0.3 is stored as {best}: relative error {abs(best - x) / x:.1%}")

# --- output of an actual run ---
# 0x01 = 00000001 -> 0.001953125
# 0x38 = 00111000 -> 1.0
# 0x39 = 00111001 -> 1.125
# 0x3A = 00111010 -> 1.25
# 0x5A = 01011010 -> 20.0
# 0x5B = 01011011 -> 22.0
# 0x7E = 01111110 -> 448.0
# 0x7F = 01111111 -> nan
# 0xB8 = 10111000 -> -1.0
# 127 values from 0 to 448.0; 0.3 lies between 0.28125 and 0.3125
# 0.3 is stored as 0.3125: relative error 4.2%
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. Encoding as in vLLM v0.34.0's FP8 docs: "values up to +/-448 and `nan`".*

Look at the spacing, not the values. Next to 1.0 the step is 0.125; next to 20
it is 2. The step is always an eighth of the power of two a value sits in, 6 to
12% of the value, so rounding costs up to 3–6% — and nothing above 448 exists. Every FP8 tensor therefore
needs a **scale** that maps its real range into ±448.

> [!predict] Before you read on
> Activations are long-tailed: most values are small, with rare large outliers.
> `INT8` maps a range onto 256 evenly spaced integers through one scale. With the
> same 8 bits, which represents such activations better — INT8 or FP8 (E4M3)?

Usually FP8. INT8's codes are evenly spaced, so to reach a rare outlier its scale
must stretch the grid, leaving coarse steps for the many small values. FP8's
codes are spaced logarithmically — dense near zero, sparse far out — so its
exponent reaches outliers while fine steps stay where most values are.

![Two number lines comparing 8-bit formats: INT8 spreads its 256 codes at a uniform step across minus 128 to 127, while FP8-E4M3 spaces its codes by exponent — packed tightly around zero and stretching out toward the extremes, so its finest resolution sits exactly where weight and activation values concentrate](assets/diagrams/float-spacing.svg)

## Every low-bit format is an element plus a scale

A 4-bit float has 16 values; E2M1 is exactly `{0, ±0.5, ±1, ±1.5, ±2, ±3, ±4,
±6}`. No weight matrix fits on that grid directly. So every practical low-bit
format stores

```text
   value  =  low-bit element  ×  a scale shared by a block of elements
```

The knobs that distinguish formats are **block size** and **scale precision**:

| Format | Element | Block | Scale | Bits per weight |
|---|---|---|---|---|
| INT4 (GPTQ / AWQ) | 4-bit integer | 128 | FP16 per group (+ 4-bit zero point) | ~4.16 |
| MXFP4 (OCP standard) | E2M1 | 32 | E8M0: a power of two | 4.25 |
| NVFP4 (NVIDIA Blackwell) | E2M1 | 16 | E4M3, plus one FP32 per tensor | 4.5 |
| `Q4_K` (llama.cpp) | 4-bit integer | 32, in super-blocks of 256 | 6-bit scale and min per block, FP16 per super-block | 4.5 |

Smaller blocks and finer scales track local ranges more closely, at the cost of
more scale bytes. When someone says "4-bit", the file holds 4.1 to 4.5 bits per
weight, before the layers left in 16 bits.

**GGUF names** add a mixing rule. `Q4_K_M` is not "everything in `Q4_K`": in
llama.cpp v1.0.0's `llama-quant.cpp`, the value projections (`attn_v`) and MLP
down-projections (`ffn_down`) of the first eighth, the last eighth and every
third layer between get `Q6_K`, and the output matrix gets `Q6_K`; `Q4_K_S`
mixes less. llama.cpp's own table puts Llama-3.1-8B in `Q4_K_M` at 4.89
bits per weight. [Lab: Bits, Bytes and Drafts](#/lab-squeezing) runs these
files on your own machine.

For 8-bit formats the knob is **granularity**: one scale per tensor, per output
channel, per token (activations), or per block (DeepSeek-V3 uses 128 × 128 blocks
for weights and 1 × 128 tiles for activations), and whether a scale is fixed
offline (**static**) or computed from each batch at runtime (**dynamic**). A
checkpoint states its choices. Here is the FP8 Llama-3.3-70B Halden will use:

```json
  "quantization_config": {
    "config_groups": {
      "group_0": {
        "input_activations": {
          …
          "dynamic": true,
          …
          "num_bits": 8,
          …
          "strategy": "token",
          "symmetric": true,
          "type": "float"
        },
        …
        "targets": [
          "Linear"
        ],
        "weights": {
          …
          "dynamic": false,
          …
          "num_bits": 8,
          "observer": "mse",
          …
          "strategy": "channel",
          "symmetric": true,
          "type": "float"
        }
      }
    },
    "format": "float-quantized",
    …
    "ignore": [
      "lm_head"
    ],
    "kv_cache_scheme": null,
    "quant_method": "compressed-tensors",
```

*Verbatim — trimmed; `config.json` of RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic, revision f50dbad2, checked 2026-11-21.*

Read it top to bottom: every `Linear` layer has FP8 weights with one static
scale per output channel, and FP8 activations with a scale computed per token on
every step. `lm_head` is excluded, and the embedding, not being a `Linear`, was
never a target. `kv_cache_scheme: null` means the file says nothing about the
cache: KV precision is a serving-time choice.

## Three things to quantize

The shorthand `W4A16` means 4-bit weights, 16-bit activations; `W8A8` means 8-bit
both; a `KV8` suffix means an 8-bit cache.

**Weights only (W4A16, W8A16).** Weights are fixed after training, so they can be
quantized once, offline, carefully — **post-training quantization (PTQ)**. Two
methods dominate at 4 bits:

- **GPTQ** ([Frantar et al., 2022](https://arxiv.org/abs/2210.17323)) rounds
  weights one at a time and adjusts the not-yet-rounded weights in the same layer
  to cancel the error just introduced, using second-order information.
- **AWQ** ([Lin et al., 2023](https://arxiv.org/abs/2306.00978)) observes that
  about 1% of weights — those meeting the largest activations — matter most. It
  multiplies those channels by a scale before rounding, so they keep more
  precision, and divides the matching activations by the same scale, so the
  product is unchanged. The scales come from activation statistics, with no
  weight reconstruction.

In the largest public sweep of quantized reasoning models
([Liu et al., COLM 2025](https://arxiv.org/abs/2504.04823)), 4-bit weights cost
0.4 points of average accuracy at 32B and 2.1 at 1.5B, and the authors recommend
AWQ over GPTQ: comparable accuracy, faster to produce, and less sensitive to the
calibration set.

**Weights and activations (W8A8).** Activations are computed live and have
outliers, which made INT8 activations hard until **SmoothQuant**
([Xiao et al., 2022](https://arxiv.org/abs/2211.10438)) applied the same
divide-here, multiply-there trick to move the difficulty from activations into
the weights. Today the W8A8 default on new GPUs is **FP8 (E4M3)**. In Liu et
al.'s sweep the best W8A8KV8 method stayed within one point at every size from
1.5B to 70B.

**KV cache.** Storing the cache in FP8 halves it. In vLLM v0.34 the flag is
`--kv-cache-dtype fp8` (an alias of `fp8_e4m3`; `fp8_e5m2` also exists), and the
docs state the pitfall: without a calibrated checkpoint, "all quantization
scales are set to `1.0`", so any key or value beyond ±448 cannot be represented.
The flag now accepts some twenty values, from NVFP4 to per-token-head INT4, and
some models default to a quantized cache (DeepSeek-V3.2 to FP8; GLM-5.x to FP8
on Blackwell since v0.32): read the startup configuration, never assume BF16.
Below 8 bits, method matters as much as bit count. **KIVI**
([Liu et al., ICML 2024](https://arxiv.org/abs/2402.02750)) reports near-baseline
quality at *2 bits* by quantizing keys per channel and values per token. In the
reasoning sweep, two 4-bit KV methods on the same 1.5B model scored 47.7 and 2.5
against a baseline of 49.0, and the better 3-bit methods still cost 6 to 12
points at 1.5B–7B and 2 to 3 at 14B–70B.

**PTQ or QAT?** Everything above is PTQ, and FP8 with dynamic activations needs
no calibration data at all. **Quantization-aware training (QAT)** simulates the
rounding during training so the weights learn to survive it; below 4-bit
weight-only, ask whether a QAT release exists. Calibration data matters
unevenly: on a 1.5B model, switching it from generic text to math moved GPTQ by
~10 points, AWQ by ~2, SmoothQuant and FlatQuant by under one (Liu et al.).

## What the hardware runs

A format speeds up arithmetic only if the tensor cores support it:

| Precision | A100 | L40S / L4 | H100 | B200 | MI300X |
|---|---|---|---|---|---|
| BF16 / FP16 | native | native | native | native | native |
| INT8 | native | native | native | native | native |
| FP8 | **no** | native | native | native | native |
| FP6 / FP4 | no | no | **no** | native | no |

Where a format is not native, the kernel **dequantizes** the small numbers
before multiplying: the memory and bandwidth saving stays, the compute speedup
does not. In vLLM, FP8 W8A8 needs compute capability 8.9 (Ada, Hopper,
Blackwell); on Ampere an FP8 checkpoint runs as W8A16 through FP8 Marlin.
W4A16 is a mixed-input matrix multiply — Marlin
([Frantar et al., 2024](https://arxiv.org/abs/2408.11743)), Machete, and since
vLLM v0.32 a kernel named Humming preferred on Hopper — and its advantage is
largest at small batch. The startup log's `Selected <kernel> for <module>` lines
tell you what runs.

## What each choice buys

> [!predict] Before you read on
> FP8 weights and an FP8 KV cache, 200 sequences of 3,000 tokens each decoding
> together. Which is the bigger read per step: the weights or the cache?

The cache. 70 GB of weights against 200 × 3,000 × 164 KB = 98 GB of KV. At high
concurrency `t_kv` is the largest term, so any analysis that counts only weight
bytes is wrong exactly where throughput matters.

Where arithmetic catches up with the weight read — the critical batch — still
depends on the format. [Inference Arithmetic](#/inference-arithmetic) derived
the nameplate ~295 for BF16 on an H100. W4A16 cuts the bytes four times but
keeps BF16 arithmetic: ~74. FP8 W8A8 halves the bytes *and* doubles the
arithmetic rate: still ~295, not half. The effective knee on the case's node is
lower (~160 in BF16, 14 ms ÷ 0.089 ms); measure it. The whole step model, for
three formats:

```python
# The course's step model: step = max(t_w, t_c) + t_kv  (case.md), on 4 x H100, TP=4.
BW, OVERHEAD = 2.85e12, 1.7e-3     # achievable bytes/s per GPU; all-reduce + launch (14 - 12.3 ms)
T_C_BF16 = 0.089e-3                # s of arithmetic per token at the BF16 rate, 40% MFU

formats = {  # weight GB on the node, KV bytes per token on the node, arithmetic rate vs BF16
    "BF16 W, BF16 KV":   (140, 327_680, 1),
    "FP8 W8A8, FP8 KV":  (70, 163_840, 2),
    "W4A16, FP8 KV":     (40, 163_840, 1),   # 39.8 GB as published: lm_head stays 16-bit
}
ctx = 3_000
print(f"{'':18}" + "".join(f"{f'batch {b}':>21}" for b in (1, 20, 200)) + "  knee")
for name, (wgb, kv, speed) in formats.items():
    t_w = wgb * 1e9 / 4 / BW + OVERHEAD
    t_c = T_C_BF16 / speed
    cells = []
    for b in (1, 20, 200):
        t_kv = b * ctx * (kv / 4) / BW
        step = max(t_w, b * t_c) + t_kv
        cells.append(f"{step * 1e3:5.1f} ms {b / step:6,.0f} tok/s")
    print(f"{name:18}" + "".join(f"{c:>21}" for c in cells) + f"{t_w / t_c:7.0f}")

# --- output of an actual run ---
#                                 batch 1             batch 20            batch 200  knee
# BF16 W, BF16 KV    14.1 ms     71 tok/s 15.7 ms  1,273 tok/s 35.0 ms  5,707 tok/s    157
# FP8 W8A8, FP8 KV    7.9 ms    127 tok/s  8.7 ms  2,298 tok/s 17.5 ms 11,413 tok/s    176
# W4A16, FP8 KV       5.3 ms    190 tok/s  6.1 ms  3,294 tok/s 26.4 ms  7,569 tok/s     59
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. Estimates from the course's step model, not measurements; replace them with a `vllm bench serve` concurrency sweep.*

The BF16 row reproduces the decode ladder: 14 ms at batch 1, ~16 ms at 20. At
batch 1, W4A16 is fastest: only `t_w` matters. At batch 200 it loses to FP8: past
its ~59-token knee, 200 tokens of BF16-rate arithmetic (17.8 ms) dominate, while
FP8 sits near its knee; both pay the same 8.6 ms of cache reads. The model even
flatters W4A16 by granting its kernels BF16's 40% of peak.

> [!trap] "4-bit weights will double my throughput at high load"
> Below its knee, W4A16 is excellent. Above it you are compute-bound at BF16
> rates plus dequantization, and the KV read ignores the weight format. At high
> concurrency the levers are FP8 arithmetic for `t_c` and a smaller KV format for
> `t_kv`.

## What labs ship

- **DeepSeek-V3/R1: FP8 end to end**, training and serving. Hopper's FP8 matrix
  multiplies accumulate with "around 14 bits", so partial sums are copied to
  FP32 every 128 elements. Its "below 0.25%" is the *training loss* error
  against BF16, not an accuracy score ([V3 report](https://arxiv.org/abs/2412.19437), §3.3).
- **OpenAI gpt-oss: MXFP4 expert weights**, the rest in BF16 (Exercise 3).
- **Llama:** Meta published FP8 Llama-3.1-405B and Llama 4 Maverick, but no FP8
  Llama-3.3-70B.

> [!dashboard] HBM bandwidth per step
> **Utilisation:** `DCGM_FI_PROF_DRAM_UTIL_RATIO` (dcgm-exporter's default
> counters): share of cycles the memory interface is busy; next to it,
> `DCGM_FI_PROF_TENSOR_UTIL_RATIO` shows whether a format moved the step toward
> compute. **Saturation:** `vllm:inter_token_latency_seconds` against the step
> model's prediction at the observed `vllm:num_requests_running` and context.
> **Errors:** none as a metric — quality damage is invisible here; the next
> chapter builds the check.

> [!case] The case: FP8 for Ask Halden
> Halden's H100s run FP8 natively. The plan: FP8 weights and an FP8 KV cache.
>
> - **The checkpoint.** Meta publishes none, so the options are Red Hat's
>   RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic (made with llm-compressor;
>   validated by its publisher on vLLM 0.8.4, not on v0.34), the same data-free
>   recipe run in-house, or vLLM's online `--quantization fp8_per_tensor`
>   (coarser per-tensor scales). Halden pins the published file by revision:
>   the recipe needs no calibration data, so producing it in-house buys nothing,
>   and the evaluation gates that exact file.
> - **The layout.** At 72.7 GB the model fits on two GPUs, so the node becomes
>   two TP=2 replicas. Per replica: 35 GB of weights per GPU and FP8 arithmetic
>   on two GPUs — the same `t_w` (~14 ms) and `t_c` as the BF16 node — and an FP8
>   cache at 82 KB per token per GPU, the same `t_kv`. Each replica behaves like
>   today's node, and there are two.
> - **The pool.** 0.90 × 160 = 144 − 70 − 6 − 2 = **66 GB** per replica, ~400K
>   FP8 tokens. Phase 2's peak needs ~61 GB across the node; if one replica fails,
>   the survivor must hold it in 66.
>
> ```bash
> vllm serve RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
>   --revision f50dbad2c84590ca17dc51e207c34321b65ff14b \
>   --device-ids 0,1 --port 8000 \
>   --tensor-parallel-size 2 \
>   --kv-cache-dtype fp8 \
>   --max-model-len 16384 \
>   --gpu-memory-utilization 0.90
> # second replica: --device-ids 2,3 --port 8001
> ```
>
> *Real format, illustrative values — flag names from vLLM v0.34.0 `vllm/engine/arg_utils.py`; values are the case's decisions, not a tested configuration.*
>
> **What this settles, and what could undo it:** FP8 ships only if the next
> chapter's evaluation passes, one change at a time — weights first, then KV —
> so a regression can be attributed. If FP8 weights fail, Halden stays on one
> BF16 TP=4 replica with no redundancy. If only FP8 KV fails, the BF16 cache
> doubles phase 2's need to ~122 GB of 132: it fits on paper, and a failed
> replica can no longer be absorbed.

## Exercises

<div class="exercise">

**Exercise 1.** Serve Llama-3.3-70B on 2 × H100 (160 GB). Average live context is
8,192 tokens. Ignoring overhead and the memory budget, how many concurrent
sequences fit with (a) BF16 weights and KV, (b) FP8 weights and KV, (c) 4-bit
weights (40 GB) and FP8 KV?

<details>
<summary>Reveal answer</summary>

KV per 8K sequence: BF16 `327,680 × 8,192 ≈ 2.68 GB`; FP8 1.34 GB.

```text
   (a) 160 − 140 =  20 GB ÷ 2.68  →   7 sequences
   (b) 160 −  70 =  90 GB ÷ 1.34  →  67 sequences
   (c) 160 −  40 = 120 GB ÷ 1.34  →  89 sequences
```

From 7 to 67 is not 2×: shrinking the weights enlarged the pool the cache is
divided into (20 → 90 GB, 4.5×), and FP8 KV halved each sequence (2×). The two
effects multiply, and the leverage is greatest when weights fill most of the
memory. With the case's 0.90 budget and overhead, (a) does not run at all.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team switches its 70B deployment on a 4 × H100 node
from FP8 W8A8 to an AWQ W4A16 checkpoint "to go faster", keeping FP8 KV. Their
concurrency sweep, 3,000-token contexts:

| Concurrency | FP8: step | FP8: tokens/s | W4A16: step | W4A16: tokens/s |
|---|---|---|---|---|
| 1 | 7.9 ms | 127 | 5.3 ms | 190 |
| 20 | 8.7 ms | 2,298 | 6.1 ms | 3,294 |
| 200 | 17.5 ms | 11,413 | 26.4 ms | 7,569 |

*Illustrative values, computed from the course's step model above, not measured.*

Explain both ends of the table. What would you check on the real system before
deciding?

<details>
<summary>Reveal answer</summary>

At concurrency 1 the step is `t_w`: 10 GB per GPU for W4A16 against 17.5 GB for
FP8, so W4A16 is a third faster. At 200, `t_c` decides. W4A16 multiplies at the
BF16 rate: 200 × 0.089 ms = 17.8 ms, far above its 5.2 ms weight read (its knee
is ~59). FP8 multiplies at twice that rate: 8.9 ms, about its 7.8 ms weight read.
Both add the same 8.6 ms of FP8 cache reads, which the weight format cannot
touch. On a real node W4A16 likely does worse than this, because mixed-input
kernels lose efficiency as the batch grows.

Check the startup log's `Selected <kernel>` lines and run your own sweep
(`vllm bench serve` at concurrency 1, 20, 200) to place the real knee. Then
choose by traffic: W4A16 for low concurrency, FP8 near peak load.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** gpt-oss-120b's `config.json` contains:

```json
  "quantization_config": {
    "modules_to_not_convert": [
      "model.layers.*.self_attn",
      "model.layers.*.mlp.router",
      "model.embed_tokens",
      "lm_head"
    ],
    "quant_method": "mxfp4"
  },
```

*Verbatim — `config.json` of openai/gpt-oss-120b on Hugging Face, checked 2026-11-21.*

The Hugging Face API reports 116.8 B parameters, 2.17 B of them in BF16, and
the weight files total 65.25 GB. What is stored in MXFP4, how many bits per
weight do the files imply, and what does an H100 do with it?

<details>
<summary>Reveal answer</summary>

Everything not excluded: the experts' MLP weights, 114.7 B parameters.
Attention, router, embedding and LM head stay in BF16: 2.17 B × 2 = 4.33 GB.
The rest, 65.25 − 4.33 = 60.9 GB, holds 114.7 B weights: 60.9 × 8 ÷ 114.7 =
**4.25 bits** — a 4-bit E2M1 element plus one 8-bit E8M0 scale per 32, exactly
MXFP4's table row. The whole model is 65 GB, so it fits one 80 GB GPU.

An H100 has no FP4 tensor cores: the kernel dequantizes the experts and
multiplies at a higher precision. You keep the memory and the bandwidth saving,
which is what a bandwidth-bound decode needs; prefill gets no FP4 speedup. On a
B200 the same file can run FP4 arithmetic.

</details>

</div>

<div class="exercise">

**Exercise 4 — find the flaw.** A colleague drafts Halden's FP8 rollout. Find
the errors before you open the answer.

```text
FP8 rollout plan (draft)
1. vllm serve meta-llama/Llama-3.3-70B-Instruct --quantization fp8 \
     --kv-cache-dtype fp8 -tp 2   # vLLM converts the BF16 weights at load
2. FP8 W8A8 halves the critical batch to ~148, so cap batches at 148.
3. Each GPU holds 35 GB of weights, leaving 80 − 35 = 45 GB of KV per GPU.
4. FP8 KV needs no calibration: vLLM uses scales of 1.0 and E4M3 reaches ±448.
5. Embeddings and lm_head are FP8 too, so the checkpoint is exactly 70 GB.
```

<details>
<summary>Reveal answer</summary>

1. **Wrong for v0.34.** Since v0.31, online FP8 conversion is
   `--quantization fp8_per_tensor`; `fp8` is for checkpoints that declare it.
   Per-tensor online scales are not the per-channel published file either.
2. **Wrong.** FP8 halves the bytes and doubles the arithmetic rate; the
   nameplate critical batch stays ~295, and the effective knee is ~160 per
   replica. Nothing about it requires a cap at 148.
3. **Wrong.** The budget is a fraction of total memory: 0.90 × 80 = 72 − 35 − 3
   (overhead) − 1 (activations) = 33 GB per GPU, 66 per replica.
4. **Half right.** Scales do default to 1.0 and E4M3 stops at 448. Whether
   Llama's keys and values stay in range is an empirical claim, for the
   evaluation to check; the docs recommend calibrated scales.
5. **Wrong.** `lm_head` is in the `ignore` list and the embedding is not a
   `Linear`: the published file is 72.7 GB.

</details>

</div>

## What to remember

- One model prices every format: `step ≈ max(t_w, t_c) + t_kv`. Weight formats
  shrink `t_w`, KV formats `t_kv`, native low-precision arithmetic `t_c`.
- At high concurrency the KV read can exceed the weight read; a weight-only
  analysis is wrong exactly where throughput matters.
- Every low-bit format is an element plus a scale; read a checkpoint's
  `quantization_config` for granularity, static or dynamic scales, and what is
  left in 16 bits.
- W4A16 cuts the nameplate critical batch to ~74 and wins at low concurrency;
  FP8 W8A8 keeps it at ~295 and wins near peak load.
- Non-native formats save memory and bandwidth, not compute: FP8 needs Ada,
  Hopper or Blackwell; FP4 arithmetic needs Blackwell.
- FP8 KV scales default to 1.0 without calibration; check the engine's KV dtype
  for your model rather than assuming BF16.

```quiz
[
  {
    "q": "Llama-3.1-8B (131 KB of BF16 KV per token) is served with FP8 weights (8 GB) and an FP8 cache, at 64 sequences of 8,192 tokens. The team considers 4-bit weights to speed up decode. How much can that help?",
    "choices": [
      "About 2× faster steps, since the weights are halved again",
      "Little: the 34 GB cache read is four times the weight read",
      "Nothing at all, since an 8B model is compute-bound at batch 64",
      "About 4× faster, since 4-bit arithmetic quadruples the FLOP rate"
    ],
    "answer": 1,
    "explain": "FP8 KV is 65.5 KB per token: 64 × 8,192 × 65,536 ≈ 34 GB read per step against 8 GB of weights. Halving the weights to 4 GB trims about 4 GB of 42, roughly 10%. W4A16 does not add FP4 arithmetic, and at 64 tokens per step an 8B model is not compute-bound."
  },
  {
    "q": "A checkpoint's quantization_config lists weights with strategy channel, dynamic false, and input_activations with strategy token, dynamic true. What is computed while serving?",
    "choices": [
      "Weight scales for each channel, refreshed on every decode step",
      "Nothing: all scales were calibrated offline and stored in the file",
      "One activation scale per token on each step; weight scales are stored",
      "One scale for the whole activation tensor, fixed after the first request"
    ],
    "answer": 2,
    "explain": "dynamic: false means the per-channel weight scales were fixed offline and stored. dynamic: true with strategy token means each token's activation scale is computed from that token's values at runtime, which is why FP8-dynamic needs no calibration data. A per-tensor static activation scale would say strategy tensor, dynamic false."
  },
  {
    "q": "A team deploys an FP8 checkpoint on A100s, which lack FP8 tensor cores. What do they get, per vLLM's documentation?",
    "choices": [
      "An error at load, because FP8 needs compute capability 8.9",
      "FP8 arithmetic in software, as fast as BF16 on the same GPU",
      "Prefill gets faster from FP8, but decode stays at the BF16 speed",
      "W8A16 through FP8 Marlin: half the weight bytes, BF16 arithmetic"
    ],
    "answer": 3,
    "explain": "On Ampere vLLM runs FP8 checkpoints weight-only through the FP8 Marlin kernel: the weights are dequantized and multiplied at BF16 rate. Bandwidth-bound decode benefits from the smaller reads; compute-bound prefill does not. The checkpoint loads; it does not run FP8 arithmetic."
  },
  {
    "q": "FP8 KV is enabled with no calibrated scales. One attention head's keys reach a magnitude of about 600 on some inputs. What happens to those values?",
    "choices": [
      "They cannot be represented: E4M3's largest finite value is 448",
      "They are stored exactly, since FP8 has an exponent for large values",
      "They round to the nearest step of about 4, since FP8 is log-spaced",
      "They are stored as infinity and the attention output becomes NaN"
    ],
    "answer": 0,
    "explain": "With the scale at 1.0 the stored value is the raw value, and E4M3 stops at 448 (0x7E); there is no infinity in E4M3, so a value of 600 cannot be stored as itself. A calibrated scale would map the head's range into ±448. Near 448 the step between codes is 32, not 4."
  },
  {
    "q": "A 70B GGUF file named Q4_K_M is about 43 GB, more than 70e9 × 4.5 bits ≈ 39 GB. Where does the difference come from?",
    "choices": [
      "GGUF stores every tensor twice, once per supported backend",
      "Q4_K_M uses 5-bit elements throughout, despite the name",
      "Some attn_v and ffn_down tensors and the output matrix are Q6_K",
      "The K-quant super-blocks keep a full FP32 copy of every block scale"
    ],
    "answer": 2,
    "explain": "Q4_K itself is 4.5 bits per weight (144 bytes per 256 weights). The _M mix gives Q6_K to the value and down projections of the first and last eighth of the layers and every third layer between, and to the output matrix; llama.cpp's table lists Llama-3.1-70B Q4_K_M at 43.1 GB. Scales are 6-bit and FP16, not FP32."
  }
]
```
