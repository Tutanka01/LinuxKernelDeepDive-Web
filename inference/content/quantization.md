# Quantization

> **Goal of this chapter:** give you the *one* mental model that organizes the
> whole alphabet soup — GGUF, GPTQ, AWQ, FP8, MXFP4, NVFP4 — so it stops being a
> zoo and becomes a small set of choices. By the end you'll know why fewer bits
> buys speed, what a floating-point format actually is, the three things you can
> quantize and how hard each is, and — most important — why perplexity lies about
> whether quantization broke your model.

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
quantization, and this chapter is doing it without silently wrecking the model.

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

- **Capacity / throughput.** Below the critical batch size `B_crit` from chapter
  3, added requests are nearly free because you re-read the same weights anyway.
  Halve the bytes per weight and you can pack roughly twice the concurrent
  requests under the same bandwidth ceiling.
- **Fit bigger models.** 70B in FP4 is 35 GB — it fits on **one** 80-GB H100
  with room to spare for the KV cache, instead of needing two GPUs in BF16. A
  smaller footprint is fewer GPUs, less network, less cost.
- **Faster compute, too.** Modern tensor cores (the GPU's matrix-multiply units)
  run *low precision faster*: an H100 does FP8 matmuls at ~2× its BF16 FLOP/s, a
  Blackwell B200 does FP4 at ~2× FP8 again. That barely helps bandwidth-bound
  decode, but it directly speeds up compute-bound **prefill** and large batches.

Four wins from one idea. Now the mechanics of how.

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
([chapter 5](#/paged-kv-cache)) grows with every token and caps concurrency, so
quantizing it frees memory for more requests. **FP8 KV** is ~50% of BF16 with
typically under 0.5-point loss — vLLM's `--kv-cache-dtype fp8` default; **INT8
KV** is the conservative equivalent. **INT4 KV** (KIVI, KVQuant) reaches 25%
footprint — lossless on large models, but drops 1–2 points on small ones. Two-bit
KV breaks consistently; do not go there.

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

## Perplexity lies — how to actually evaluate

This is the section to remember. The default way people check "did quantization
hurt?" is **perplexity** (PPL) — roughly, how surprised the model is by held-out
text. It is cheap, standard, and for judging quantization **nearly useless.** PPL
averages next-token loss over ordinary text, where almost any quantization looks
fine, and misses exactly where low-bit models break: long chains of exact
reasoning.

The numbers are stark. A study of 3-bit AWQ found perplexity essentially flat
while **MATH-500 accuracy collapsed from 85.6% to 47.0%** — and the model
*inflated* its chain-of-thought from 5.2K to **23.4K tokens (4.5×)** trying to
compensate. PPL saw none of it. **[from arXiv 2606.25519.]**

Two lessons hide in that one result:

- **Degradation scales with task hardness.** The same quantization that costs
  ~7% on grade-school GSM8K costs ~15% on MATH and can drive competition-level
  AIME to **total failure**. An easy eval blesses a model that falls apart on hard
  ones.
- **Count the tokens.** A quantized reasoning model can *recover* accuracy by
  thinking longer — but those extra tokens are a hidden tax that can cancel the
  per-token speedup you quantized for. Measure generated-token count, not just
  accuracy. **[the "token-inflation tax" framing is contested, but the length
  blow-up is real and reproduced.]**

And correctness doesn't only live in the format — it lives in the **kernels**.
vLLM documented FP8 KV cache on Hopper silently collapsing at long context:
128k-token needle-in-a-haystack retrieval fell from **91% (BF16) to 13%**. The
format was fine; the *kernel* accumulated over the long context in low-precision
registers and lost the needle. The [two-level accumulation](#/flashattention) fix
— promote partial sums to real FP32 — restored it to **89%**. Perplexity, of
course, looked perfect throughout.

> **State of play (mid-2026), the safe map from a COLM 2025 sweep:**
> **W8A8KV8** and **W4A16** are near-lossless across the board. **W4A4KV4** is
> risky — about 2.3% loss on a 32B model but **over 10% on a 7B**, and ~4× worse
> on hard tasks (AIME) than easy ones (GSM8K). **3-bit anything is a cliff —
> avoid it.** Smaller models and reasoning models are the fragile cases.

The rule, then: **never trust perplexity alone. Evaluate on your hardest target
tasks — long-context retrieval, hard math, agentic tool-use — and count generated
tokens.** Silent failure is the default; you only catch it if you test for it.

## A decision guide

```text
   SAFE ZONE                         DANGER ZONE
   ─────────                         ──────────
   FP8 (W8A8)   ← 2026 default       ≤4-bit W+A on small models
   W4A16 (AWQ/GPTQ weight-only)      ≤4-bit W+A on reasoning models
   FP8 / INT8 KV cache               3-bit ANYTHING
                                     INT4 KV on small models
   (near-lossless, ship freely)      (test hard tasks before trusting)
```

**Default to FP8** on Hopper or Blackwell (biggest win, smallest risk).
**Weight-only W4A16** when you need the memory but want full activation precision.
**FP8/INT8 KV** to free concurrency headroom. Treat **≤4-bit W+A** and **3-bit**
as experiments to be *proven* on your own hard evals, never defaults.

A diagnostic for the community's favorite argument: **when someone says
"quantization ruined my model," the first question is *which regime were they
in?*** Near-lossless FP8 and a 3-bit reasoning-model catastrophe are both
"quantization" and share almost nothing. The regime is the whole story.

## What to remember

- Decode is bandwidth-bound, so **fewer bits ≈ proportionally faster** — plus
  more concurrency, bigger models per GPU, and (on the right chip) faster compute.
- A float is **sign + exponent (range) + mantissa (precision)**; `E4M3` = 4
  exponent, 3 mantissa. **FP8 ≠ INT8**: log-spaced vs uniform steps, so FP8
  handles outliers better at the same width.
- Every low-bit format is **a tiny element + a per-block scale**; the real axes
  are **block size** and **scale precision** — MXFP4 (32-elem, power-of-two) vs
  NVFP4 (16-elem, FP8 scale, more accurate).
- Three targets, increasing difficulty: **W4A16** (GPTQ error-compensation, AWQ
  protects the salient 1%) → **W8A8/FP8** (SmoothQuant migrates outliers; FP8 the
  near-lossless default) → **KV cache** (FP8/INT8 safe, INT4 big-models-only).
- **A100 has no FP8; FP4 needs Blackwell.** "FP4 on Hopper" is memory savings
  only. **GGUF** is a local-inference file format, not different science.
- **Perplexity lies.** Low-bit models break on hard reasoning and long context
  while PPL stays flat; correctness can even live in the *kernel* (the 91%→13%→89%
  KV story). Eval on your hardest tasks and count the tokens.

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
    "explain": "Both use the same E2M1 4-bit element. A low-bit format is really 'element + shared block scale,' and that's where they diverge: MXFP4's coarse power-of-two scale over 32 elements is portable but outlier-sensitive; NVFP4's finer FP8 scale over 16 elements is more accurate at equal bits."
  },
  {
    "q": "You quantize a 7B reasoning model to 3-bit and its perplexity barely moves. What is the correct conclusion?",
    "choices": [
      "The quantization is safe to ship; flat perplexity confirms quality is preserved",
      "Perplexity is a near-useless quant metric here — you must test hard reasoning/long-context tasks and count generated tokens, where 3-bit models often collapse",
      "3-bit is always lossless as long as the block scales are FP16",
      "The model will be faster with no downside because 3 bits is fewer bytes than 4"
    ],
    "answer": 1,
    "explain": "Perplexity averages loss over ordinary text and misses reasoning failures. Real sweeps show 3-bit holding PPL while MATH accuracy collapses (85.6%→47.0%) and chains inflate ~4.5×. Evaluate on your hardest target tasks and measure token counts; 3-bit is a known cliff."
  },
  {
    "q": "vLLM saw FP8 KV cache drop 128k needle-in-a-haystack retrieval from 91% to 13%, then fixed it back to 89% without changing the format. What does this teach?",
    "choices": [
      "FP8 is fundamentally broken for long context and should never be used",
      "The fix was to switch from FP8 to INT8 KV",
      "Correctness lives in kernels too: the failure was low-precision accumulation over the long contraction, fixed by promoting partial sums to FP32 — the format was fine",
      "Perplexity would have caught the regression immediately"
    ],
    "answer": 2,
    "explain": "The FP8 format was correct; the kernel accumulated over the long context in low-precision registers and lost the needle. Two-level accumulation (partial sums promoted to real FP32) restored retrieval. Lesson: quantization correctness is partly a kernel-accumulation problem, and perplexity looked perfect throughout — silent failure is the default."
  }
]
```
