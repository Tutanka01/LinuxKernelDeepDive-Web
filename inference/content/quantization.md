# Quantization

> **Goal of this chapter:** give you the *one* mental model that organizes the
> whole alphabet soup — GGUF, GPTQ, AWQ, FP8, MXFP4, NVFP4 — so it stops being a
> zoo and becomes a small set of choices. By the end you'll know why fewer bits
> buys speed, what a floating-point format actually is, the three things you can
> quantize and how hard each is, which silicon can run which format, and exactly
> what each choice buys you in bytes, in critical batch size, and in decode
> latency.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,kv"></div>

In [Inference Arithmetic](#/inference-arithmetic) you learned the single most
useful fact about serving: a decode step is **bandwidth-bound**. To generate one
token the GPU reads every weight once and moves it from memory, and the latency
is almost exactly

```text
   decode latency per token  ≈  (weight bytes + KV bytes) / HBM bandwidth
```

The FLOPs barely matter; the *bytes* are the whole game. So the biggest lever in
inference jumps out: **shrink the bytes.** A weight in 8 bits instead of 16 is
half the bytes to move — half the bytes, roughly half the decode latency. That is
quantization, and this chapter is how it works: the formats, the mechanics, the
methods, and the silicon that does or does not accelerate them.

The other half — proving you did it without silently wrecking the model — is the
next chapter, [Did Quantization Break Your Model?](#/did-quantization-break-your-model).
Read this one for what to choose; read that one before you ship it.

## Why fewer bits is the biggest lever you have

Take Llama-3-70B. In BF16 (16-bit, the training-precision baseline) its 70
billion weights occupy **140 GB**. On an H100 (3.35 TB/s of memory bandwidth) a
batch-1 decode step moves those 140 GB, so:

```text
   BF16:  140 GB / 3.35 TB/s  ≈  42 ms/token   ≈  24 tokens/sec
   FP8:    70 GB / 3.35 TB/s  ≈  21 ms/token   ≈  48 tokens/sec
   FP4:    35 GB / 3.35 TB/s  ≈  10 ms/token   ≈  95 tokens/sec
```

Halving the bits roughly doubles the speed. But the same shrink pays off three
more ways at once:

- **Capacity / throughput.** Below the critical batch size `B_crit` from
  [Inference Arithmetic](#/inference-arithmetic), added requests are nearly free
  because you re-read the same weights anyway. Halve the bytes per weight and
  you can pack roughly twice the concurrent requests under the same bandwidth
  ceiling.
- **Fit bigger models.** 70B in FP4 is 35 GB — it fits on **one** 80-GB H100
  with room to spare for the KV cache, instead of needing two GPUs in BF16. A
  smaller footprint is fewer GPUs, less network, less cost.
- **Faster compute, too.** Modern tensor cores (the GPU's matrix-multiply units)
  run *low precision faster*: an H100 does FP8 matmuls at ~2× its BF16 FLOP/s, a
  Blackwell B200 does FP4 at ~2× FP8 again. That barely helps bandwidth-bound
  decode, but it directly speeds up compute-bound **prefill** and large batches.

Four wins from one idea. Now the mechanics of how.

> [!bridge] You already know this — from the Linux course
> This is the zswap trade. Linux compresses cold anonymous pages in RAM rather
> than paging them to disk, spending CPU cycles to avoid moving bytes across a
> slow boundary — because on that machine the bytes were the expensive part.
> Quantization is the same bargain against HBM: pay a little arithmetic to
> unpack a smaller representation, and you move fewer bytes per decode step.
> What differs is that the kernel's compression is exactly reversible and
> quantization's is not, which is why this chapter has a sequel.
> [→ Linux: Virtual Memory](../#/memory)

## What a number format actually is

You already know integers: `INT8` is a byte holding one of 256 evenly spaced
whole numbers. Floating point is the other family, and the difference is the key
to everything below. A float splits its bits into three fields:

```text
   FP16   [S][ E E E E E ][ M M M M M M M M M M ]   1 sign, 5 exp, 10 mantissa
   BF16   [S][ E E E E E E E E ][ M M M M M M M ]   1 sign, 8 exp,  7 mantissa
   E4M3   [S][ E E E E ][ M M M ]                   1 sign, 4 exp,  3 mantissa  (an FP8)
   E5M2   [S][ E E E E E ][ M M ]                    1 sign, 5 exp,  2 mantissa  (an FP8)
   E2M1   [S][ E E ][ M ]                            1 sign, 2 exp,  1 mantissa  (FP4)
```

- **Sign** picks positive or negative.
- **Exponent** sets the *scale* — the power of two the number lives near. More
  exponent bits = wider **dynamic range** (tiny and huge values both reachable).
- **Mantissa** sets the *precision* within that scale. More mantissa bits = finer
  steps.

So `E4M3` reads as "4 exponent bits, 3 mantissa bits." `E5M2` trades a mantissa
bit for an exponent bit: wider range, coarser steps — which is why E5M2 is used
for gradients and E4M3 for weights and activations.

> **Common trap: "FP8 is just INT8 with extra steps."** No — they distribute
> their 256 codes completely differently. INT8 spaces its values *uniformly* (the
> gap 3→4 equals 200→201); FP8 spaces them *logarithmically* — dense near zero,
> sparse far out. That matters because activations are long-tailed: mostly small
> values with rare large **outliers**. INT8 must stretch its uniform grid to reach
> the outliers, wasting resolution on the common small values; FP8's exponent
> reaches them for free while keeping fine steps where the mass is. Same 8 bits,
> FP8 usually wins on the distributions we actually have.

![Two number lines comparing 8-bit formats: INT8 spreads its 256 codes at a uniform step across minus 128 to 127, while FP8-E4M3 spaces its codes by exponent — packed tightly around zero and stretching out toward the extremes, so its finest resolution sits exactly where weight and activation values concentrate](assets/diagrams/float-spacing.svg)

## The real design axis: a low-bit element plus a shared scale

Here is the insight that collapses the whole zoo. A 4-bit number can encode only
16 distinct values — the `E2M1` set is exactly `{0, ±0.5, ±1, ±1.5, ±2, ±3, ±4,
±6}`. That is hopeless for a weight matrix whose values span many orders of
magnitude. So **no one uses the low-bit element alone.** Every modern low-bit
format is really two parts:

```text
   stored value  =  low-bit element  ×  a SCALE shared by a block of elements
```

You group, say, 32 weights into a block, find the largest magnitude in it, and
store one higher-precision **scale** mapping the block's range onto the tiny
element grid. Now the 16 FP4 codes are *relative* positions inside each block's
own range. The two knobs that actually define a format are therefore **how big
the block is** and **how precise the scale is**:

| Format | Element | Block size | Scale type |
|---|---|---|---|
| INT4 (GPTQ/AWQ) | 4-bit int | group of 128 | FP16 per group |
| **MXFP4** | E2M1 (FP4) | **32** | **E8M0** — power-of-two only |
| **NVFP4** | E2M1 (FP4) | **16** | **E4M3** float + one FP32 global |

MXFP4 (the open OCP "microscaling" standard) uses a big 32-element block and a
*power-of-two* scale (E8M0 is 8 exponent bits, no mantissa) — cheap to store and
portable, but coarse, so one outlier drags the whole block. NVFP4 (NVIDIA's
Blackwell-native format) halves the block to 16 and uses a real FP8 scale plus a
global FP32 factor — more metadata, markedly less error. That is the entire
difference between them: **[consensus]** NVFP4 is more accurate at equal bits,
MXFP4 is more portable.

The scales are not free, and it is worth seeing how little they cost. MXFP4
stores one 8-bit scale per 32 elements: `(32 × 4 + 8) / 32 = 4.25` bits per
weight. NVFP4 stores one 8-bit scale per 16: `(16 × 4 + 8) / 16 = 4.5` bits per
weight. So NVFP4's extra accuracy costs about 6% more memory than MXFP4's, and
both are still comfortably under a quarter of BF16. When someone quotes "4-bit,"
they mean 4.25 or 4.5 in the file.

## The three things you can quantize

Quantization targets three different tensors, in increasing order of difficulty.
The shorthand is `W`eights / `A`ctivations / `KV` cache, each with a bit count —
so `W4A16` means 4-bit weights, 16-bit activations.

**1. Weights only (W4A16) — the easy win.** Weights are fixed after training, so
you can quantize them offline, carefully, once. This is **PTQ** (post-training
quantization — no retraining). Two methods dominate:

- **GPTQ** rounds weights to the grid but *compensates as it goes*: after
  rounding one weight, it nudges the not-yet-quantized weights in the same layer
  to cancel the error just introduced (using second-order/Hessian information).
  Error-correcting rounding.
- **AWQ** (activation-aware weight quantization) starts from an observation:
  roughly **1% of weight channels are "salient"** — they carry most of the
  model's quality. AWQ measures which channels see the largest activations and
  scales them up before quantizing so they survive with more precision. Protect
  the vital 1%, quantize the rest hard.

Both land near-lossless at 4 bits. In 2026, AWQ has become the common INT4
weight-only default (simpler and robust, first-class in vLLM/SGLang), with GPTQ
persisting through the HuggingFace back-catalog. **[directional — this ranking
rests on secondary sources, not a head-to-head paper.]**

**2. Weights + activations (W8A8) — harder, because activations move.** Weights
are known offline; activations are computed live at every step and, worse, they
have vicious outliers. **SmoothQuant** (2022) fixed this with a migration trick:
divide the activations by a per-channel factor to tame their outliers, and
multiply the corresponding weight columns by the same factor to keep the math
identical. It *moves* the difficulty from the hard-to-quantize activations into
the easy-to-quantize weights. That unlocked W8A8 in INT8.

Today the W8A8 default is **FP8 (E4M3)**, native on Hopper and Blackwell and
**near-lossless** — a COLM 2025 study found W8A8KV8 essentially lossless (under
1 point) even on a 1.5B model. **[consensus]** FP8 end-to-end is the 2026 serving
default for a reason: you get the bandwidth *and* the compute speedup with almost
no quality cost.

**3. KV cache (FP8/INT8 safe, INT4 for big models only).** The KV cache
([PagedAttention & Prefix Caching](#/paged-kv-cache)) grows with every token and
caps concurrency, so quantizing it frees memory for more requests. **FP8 KV** is
~50% of BF16 with typically under 0.5-point loss — vLLM's `--kv-cache-dtype fp8`
default; **INT8 KV** is the conservative equivalent. **INT4 KV** (KIVI, KVQuant)
reaches 25% footprint — lossless on large models, but drops 1–2 points on small
ones. Two-bit KV breaks consistently; do not go there.

## PTQ and QAT: when to pay with training compute

Everything above is **PTQ** — you take a finished model, run a few hundred
calibration samples through it to observe the activation ranges, pick scales, and
write out the quantized weights. It costs minutes to hours on one GPU, needs no
labels, and it is what virtually all served quantization is.

**QAT** (quantization-aware training) is the alternative: simulate the rounding
*during* training or a fine-tune, so gradients flow through the quantization and
the weights learn to land on grid points that survive it. The usual mechanism is
the straight-through estimator — quantize in the forward pass, pretend the
rounding was the identity in the backward pass.

The trade is blunt. QAT costs real training compute and needs data you may not
have; PTQ costs almost nothing. So the rule is a threshold, not a preference:

- **At 8 bits, PTQ is enough.** FP8 and INT8 are near-lossless with calibration
  alone; nobody spends a training run to recover a fraction of a point.
- **At 4 bits weight-only, PTQ is still usually enough** — that is exactly the
  gap GPTQ and AWQ were built to close.
- **Below 4 bits, or 4-bit weights *and* activations on a small model**, PTQ
  starts falling off a cliff and QAT is the only thing that reliably rescues it.
  **[consensus]** That is also the regime where you should be asking whether a
  smaller model at 8 bits would have been the better deal.

Note where the cost lands: QAT is paid once, by whoever publishes the checkpoint,
and everybody who serves it gets the benefit for free. If you are choosing rather
than training, "is there a QAT release of this model?" is a better question than
"should I run QAT?"

## What the hardware actually supports

A format only helps if the silicon has tensor cores for it. This table is the one
people forget, and it produces the most confused benchmarks:

| Precision | A100 | H100 (Hopper) | B200 (Blackwell) | AMD MI300X |
|---|---|---|---|---|
| BF16 / FP16 | native | native | native | native |
| INT8 | native | native | native | native |
| **FP8** | **✗** | **native** | native | native |
| FP6 | ✗ | ✗ | native | ✗ |
| **FP4 (MX/NV)** | ✗ | ✗ | **native** | ✗ |

**Two rules to memorize. The A100 has no FP8 tensor cores** — quantize to FP8 on
an A100 and you save memory but get *zero* compute speedup. **FP4 requires
Blackwell.** So "running FP4 on an H100" is a memory trick, not a speed trick:
35 GB instead of 140 GB is real, but the matmul still runs at FP8/BF16 rates.
Match the format to the chip.

> **GGUF, demystified in one paragraph.** GGUF is the file format llama.cpp uses
> for local/CPU/Apple-silicon inference, paired with block-quant types named like
> `Q4_K_M` (roughly "4-bit weights, K-quant scheme, medium size"). Despite the
> different vocabulary it is the *same science* as everything above — a low-bit
> element plus a per-block scale — a packaging choice for the local ecosystem, not
> a rival theory of quantization.

## What each choice actually buys you

Now put the format next to the arithmetic and read off the consequences. Three
quantities move: the bytes, the critical batch size, and the decode latency.

**Bytes, for Llama-3-70B on an 80-GB H100.** Weights are `P × bytes_per_weight`;
KV is `2 × 80 layers × 8 kv_heads × 128 head_dim × bytes` = 328 KB/token in BF16,
scaling linearly with the KV dtype.

| Choice | Weights | KV per token | KV for one 128K seq | Decode step |
|---|---|---|---|---|
| BF16, BF16 KV | 140 GB | 328 KB | ~40 GB | ~42 ms |
| FP8 W8A8, FP8 KV | 70 GB | 164 KB | ~20 GB | ~21 ms |
| W4A16, FP8 KV | 35 GB | 164 KB | ~20 GB | ~10 ms |
| NVFP4, FP8 KV | ~39 GB | 164 KB | ~20 GB | ~12 ms |

(The NVFP4 row is 4.5 bits/weight including scales, hence slightly above the
idealized 35 GB. Decode step is weights ÷ 3.35 TB/s, the batch-1 floor before
KV traffic and kernel overhead are added.)

Read the second column across and you get the number that decides your
concurrency: going from BF16 KV to FP8 KV doubles how many 128K sequences fit in
whatever HBM the weights left behind. On a single 80-GB H100 running W4A16, the
weights take 35 GB and the remaining ~45 GB holds two 128K sequences in BF16 KV
or four in FP8. That is not a latency win; it is a throughput win, and it is
usually the larger one.

**Critical batch size.** `B_crit` is where decode stops being memory-bound, and
it moves with the format — but not always in the direction people expect. Derive
it. Intensity at batch `B` is FLOPs ÷ bytes = `2·P·B / (P × bytes_per_weight)`:

- **W4A16** — weights at 0.5 bytes, matmul still at BF16 rates (you dequantize on
  the way in). Intensity = `4B` against an unchanged H100 ridge of ~295, so
  `B_crit ≈ 74`. Weight-only quantization **lowers the knee by 4×**: you reach
  compute-bound much sooner, which is exactly why it is the low-latency,
  low-concurrency choice.
- **FP8 W8A8** — weights at 1 byte, but Hopper's FP8 tensor cores also do ~2× the
  FLOP/s, so the ridge moves too: ~1,980 TFLOP/s ÷ 3.35 TB/s ≈ 590 FLOP/byte.
  Intensity = `2B` against 590 → `B_crit ≈ 295`, essentially where it started.
  The win here is not a lower knee; it is that **every point on the curve got
  about twice as fast**.

That distinction is worth holding: weight-only quantization moves you along the
roofline, full low-precision execution raises the roofline. **[directional — the
2× FP8 rate is the vendor dense figure; achieved speedups run lower.]**

> [!trap] "4-bit weights will double my throughput"
> Read the `B_crit ≈ 74` line again and see what it costs you. Below batch 74
> W4A16 is wonderful — a quarter of the bytes on a bandwidth-bound step. Above
> it you are compute-bound, the matmul still runs at BF16 rates because that is
> the only rate the hardware has for it, and the dequantization is extra work
> the BF16 path never had to do. Weight-only 4-bit is a **memory and
> low-latency** choice; the throughput lever at high concurrency is FP8, which
> raises the ceiling instead of moving you along it.

## What frontier labs actually ship

- **DeepSeek-V3/R1 — FP8 end-to-end**, training and serving. Fine-grained
  scaling (tile-wise 1×128 activations, block-wise 128×128 weights) plus a
  **two-level accumulation** trick: H800 tensor cores accumulate FP8 products in a
  limited (~14-bit) register, so every 128 elements DeepSeek promotes the partial
  sum to a full FP32 accumulator in the CUDA cores. Relative error vs BF16 stayed
  under 0.25%. (Kernels open-sourced as DeepGEMM.)
- **OpenAI gpt-oss (120B/20B, 2025) — MXFP4 MoE weights**, letting 120B fit on a
  single 80-GB H100. They chose the *open* OCP standard, not anything proprietary.
- **Llama — official FP8 releases** as the efficient serving tier.

The pattern: FP8 is the safe production floor; FP4 is the bleeding edge, reserved
for weights that tolerate it (MoE experts) on hardware that has the cores.

## Choosing, and then proving

Put the whole chapter into one default. On Hopper or Blackwell, **FP8 W8A8 with
FP8 KV** is the choice with the best ratio of win to risk: half the bytes, twice
the tensor-core rate, twice the concurrency, and near-lossless on everything but
the smallest models. Reach for **W4A16** when memory is the binding constraint
and you want full activation precision — a 70B on one GPU instead of two. Reach
for **FP4** only on Blackwell, only for weights, and only after the next chapter.

Because none of the above is a quality claim. Every number here is a byte count
or a bandwidth division; not one of them tells you whether the model still gets
the answer right. The evaluation half — why the standard metric for this is
almost useless, and what to measure instead — is
[Did Quantization Break Your Model?](#/did-quantization-break-your-model).

## What to remember

- Decode is bandwidth-bound, so **fewer bits ≈ proportionally faster** — plus
  more concurrency, bigger models per GPU, and (on the right chip) faster compute.
- A float is **sign + exponent (range) + mantissa (precision)**; `E4M3` = 4
  exponent, 3 mantissa. **FP8 ≠ INT8**: log-spaced vs uniform steps, so FP8
  handles outliers better at the same width.
- Every low-bit format is **a tiny element + a per-block scale**; the real axes
  are **block size** and **scale precision** — MXFP4 (32-elem, power-of-two,
  4.25 bits/weight) vs NVFP4 (16-elem, FP8 scale, 4.5 bits/weight, more accurate).
- Three targets, increasing difficulty: **W4A16** (GPTQ error-compensation, AWQ
  protects the salient 1%) → **W8A8/FP8** (SmoothQuant migrates outliers; FP8 the
  near-lossless default) → **KV cache** (FP8/INT8 safe, INT4 big-models-only).
- **PTQ** — calibrate and round, minutes of compute — carries you to 8 bits and
  usually to 4-bit weight-only. **QAT** is the rescue below that, and it is
  someone else's training bill: look for a QAT checkpoint rather than running one.
- **A100 has no FP8; FP4 needs Blackwell.** "FP4 on Hopper" is memory savings
  only. **GGUF** is a local-inference file format, not different science.
- The consequences, derived: FP8 halves weights (140 → 70 GB) and halves the
  batch-1 decode step (42 → 21 ms); FP8 KV halves KV/token (328 → 164 KB) and
  doubles long-context concurrency. **W4A16 cuts `B_crit` to ~74** (same ridge,
  quarter the bytes); **FP8 W8A8 leaves `B_crit` near 295** but doubles the
  ceiling itself.

## Exercises

<div class="exercise">

**Exercise 1.** You are serving Llama-3-70B (70B parameters, 80 layers, 8 K/V
heads, `head_dim` 128) on a node of **2× H100 80 GB = 160 GB** of HBM. The
average request holds an **8,192-token** context. Ignore activations and
workspace. Compute the weight bytes, the KV bytes per sequence, and how many
concurrent 8K sequences fit, for three configurations: (a) BF16 weights with
BF16 KV, (b) FP8 weights with FP8 KV, (c) INT4 weights with FP8 KV.

<details>
<summary>Reveal answer</summary>

**Weights** are `70e9 × bytes_per_weight`:

```text
   BF16 (2 B):    140 GB
   FP8  (1 B):     70 GB
   INT4 (0.5 B):   35 GB
```

**KV per token** is `2 × 80 × 8 × 128 × bytes` = `163,840 × bytes`:

```text
   BF16 KV:  163,840 × 2 = 327,680 B  ≈ 328 KB/token
   FP8  KV:  163,840 × 1 = 163,840 B  ≈ 164 KB/token
```

**KV per 8,192-token sequence** is that times 8,192:

```text
   BF16 KV:  327,680 × 8,192 = 2.68 GB per sequence
   FP8  KV:  163,840 × 8,192 = 1.34 GB per sequence
```

**Concurrency** is the HBM left over after the weights, divided by the
per-sequence KV:

```text
   (a) BF16 / BF16 KV:  160 − 140 =  20 GB ÷ 2.68 GB  →   7 sequences
   (b) FP8  / FP8  KV:  160 −  70 =  90 GB ÷ 1.34 GB  →  67 sequences
   (c) INT4 / FP8  KV:  160 −  35 = 125 GB ÷ 1.34 GB  →  93 sequences
```

**7 → 67 → 93 concurrent sequences: 9.6× and 13× more than BF16.** Notice where
that came from. Halving the KV dtype only doubled the per-sequence cost; the
enormous factor is that shrinking the weights *enlarged the pool the KV is
divided into* — 20 GB became 90 GB, a 4.5× jump for a 2× shrink in weights. The
two effects multiply, and the leverage is highest exactly when the weights are
eating most of the HBM. That is why "how much room is left after the weights"
is the number to compute first when concurrency is your binding constraint.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>If FP4 is half the bytes of FP8, why isn't it simply twice as fast on an H100?</summary>

Because on an H100 the FP4 saving is only in *storage and traffic*, not in
arithmetic. Hopper has no FP4 tensor cores, so the kernel loads 4-bit weights,
dequantizes them into FP8 or BF16 registers, and runs the matmul at the higher
precision. Batch-1 decode — which is pure bandwidth — does get most of the win.
Prefill and large batches, which are compute-bound, get essentially none of it.
On a B200, where FP4 is native, both halves land.

</details>

<details>
<summary>Does quantizing the KV cache speed up decode, or only save memory?</summary>

Both, but the memory effect is much larger. Decode reads the whole KV cache of
every sequence in the batch every step, so halving KV bytes does cut real traffic
— the effect grows with context length and batch size, and at 128K it is
substantial. But the reason people turn it on is capacity: 328 KB/token → 164
KB/token doubles the number of concurrent sequences that fit in the HBM your
weights left over, and concurrency is what sets throughput.

</details>

<details>
<summary>Everything here is per-weight. What about the activations and the scales — do they matter for memory?</summary>

Not for capacity. Activations are transient: one layer's worth exists at a time
and is reused as scratch, so their footprint is megabytes against tens of
gigabytes of weights and KV. The scales are small too — one 8-bit value per 16 or
32 weights is a 6–12% overhead on the quantized tensor, which is why "4-bit" in
practice means 4.25 or 4.5 bits. The activation *dtype* still matters enormously,
but for tensor-core throughput and for accuracy, not for how much fits.

</details>

<details>
<summary>Is a quantized checkpoint portable across GPU generations?</summary>

The file always loads; what varies is whether the silicon executes it or the
kernel has to unpack it first. A W4A16 checkpoint (GPTQ/AWQ) is the most
portable, because dequantization to BF16 happens in software and every GPU can
multiply in BF16 — you keep the memory win everywhere. An FP8 checkpoint runs
natively on Hopper and Blackwell and merely as a memory saving on an A100. An
FP4 checkpoint is a Blackwell artifact in performance terms. So pick the format
for the oldest chip in the fleet you intend to serve on, not the newest one you
benchmarked on.

</details>

<details>
<summary>How much calibration data does PTQ need, and does its content matter?</summary>

A few hundred sequences is the usual working range, and the content matters more
than the count. Calibration exists to observe activation ranges, so the samples
have to look like your traffic: calibrate a multilingual deployment on English
web text and the scales are fitted to the wrong distribution, which shows up as
clipped outliers on the languages you did not include. Same for long context —
if you serve 128K, calibrate on long sequences, not on 512-token snippets. This
is the cheapest place in the whole pipeline to make an expensive mistake.

</details>

<details>
<summary>Should I quantize the weights and the KV cache in the same change?</summary>

Separately, and measure between them. They fail for different reasons — weight
quantization damages the matmul, KV quantization damages long-context attention
— and if you flip both at once and quality drops, you have no way to attribute
it without running the experiment again anyway. The usual order is FP8 weights
first because it is the safest step, then FP8 KV because it is the one that buys
concurrency, with a quality run in between. The next chapter is what "a quality
run" has to contain.

</details>

</div>

```quiz
[
  {
    "q": "Why does halving the bits per weight roughly halve batch-1 decode latency?",
    "choices": [
      "Fewer bits means fewer FLOPs, and decode is compute-bound",
      "Decode is bandwidth-bound: latency ≈ bytes moved / HBM bandwidth, and half the bits is half the bytes to read",
      "Smaller weights fit in the GPU's L2 cache, eliminating memory reads entirely",
      "The tensor cores automatically run twice as fast on any smaller format"
    ],
    "answer": 1,
    "explain": "A decode step reads every weight from HBM once; its latency is set by bytes/bandwidth, not FLOPs. Halve the bytes per weight and you halve the bytes moved, so the step is roughly twice as fast — independent of any compute speedup (which an A100 in FP8, for instance, doesn't even get)."
  },
  {
    "q": "At the same 8-bit width, why does FP8 (E4M3) typically handle activation outliers better than INT8?",
    "choices": [
      "FP8 has more total codes than INT8",
      "INT8 is signed while FP8 is unsigned, giving FP8 more range",
      "FP8 spaces its values logarithmically (dense near zero, sparse far out), so its exponent reaches outliers while keeping fine steps where most values live; INT8's grid is uniform",
      "FP8 stores a separate scale per element and INT8 does not"
    ],
    "answer": 2,
    "explain": "Both have 256 codes, but INT8 spaces them uniformly and FP8 spaces them by exponent. Activations are long-tailed — mostly small with rare large outliers — so FP8's log spacing covers the outliers for free while preserving precision near zero, where the mass is."
  },
  {
    "q": "What is the single biggest difference between MXFP4 and NVFP4?",
    "choices": [
      "MXFP4 uses 4-bit elements and NVFP4 uses 6-bit elements",
      "They use different block sizes and scale precisions: MXFP4 shares a power-of-two scale over 32 elements, NVFP4 shares a finer FP8 scale over 16",
      "MXFP4 is for weights and NVFP4 is only for the KV cache",
      "NVFP4 runs on any GPU while MXFP4 needs Blackwell"
    ],
    "answer": 1,
    "explain": "Both use the same E2M1 4-bit element. A low-bit format is really 'element + shared block scale,' and that's where they diverge: MXFP4's coarse power-of-two scale over 32 elements is portable but outlier-sensitive; NVFP4's finer FP8 scale over 16 elements is more accurate at equal bits. In bits per weight that is 4.25 vs 4.5."
  },
  {
    "q": "You quantize a 70B model to FP8 and deploy it on an A100. What do you actually get?",
    "choices": [
      "Half the weight bytes and roughly 2× the matmul rate, as on an H100",
      "Half the weight bytes — so faster batch-1 decode and more room for KV — but zero compute speedup, because the A100 has no FP8 tensor cores",
      "Nothing at all: FP8 weights cannot be loaded on Ampere",
      "Full FP8 compute, but the KV cache must stay in BF16"
    ],
    "answer": 1,
    "explain": "The A100 has no FP8 tensor cores. The bandwidth win is real — 70 GB instead of 140 GB to stream per decode step, plus HBM freed for concurrency — but the kernel must dequantize to BF16 to multiply, so compute-bound prefill and large batches see no speedup. The same logic makes 'FP4 on Hopper' a memory trick, not a speed trick."
  },
  {
    "q": "Weight-only W4A16 quantization on an H100 changes B_crit from ~295 to ~74, while FP8 W8A8 leaves it near ~295. Why the difference?",
    "choices": [
      "W4A16 uses a smaller block size, which raises arithmetic intensity",
      "W4A16 quarters the weight bytes but the matmul still runs at BF16 rates, so the ridge is unchanged and the knee moves down 4×; FP8 halves the bytes but also roughly doubles peak FLOP/s, so the ridge moves with it and the knee stays put",
      "FP8 KV cache reads dominate and cancel the change",
      "B_crit is a property of the model, not the hardware or format"
    ],
    "answer": 1,
    "explain": "B_crit is the batch where intensity reaches the ridge. W4A16: intensity = 4B against an unchanged ridge of ~295 → B_crit ≈ 74. FP8 W8A8: intensity = 2B, but Hopper's FP8 peak is ~1,980 TFLOP/s, so the ridge rises to ~590 → B_crit ≈ 295. Weight-only quantization moves you along the roofline; full low-precision execution raises the roofline."
  }
]
```
