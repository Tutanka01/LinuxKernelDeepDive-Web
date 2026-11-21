# Inference Arithmetic

> **The question:** given a model and a GPU, how fast will it decode, how
> long will prefill take, how many users can share a step before they slow
> each other down — and what does a token cost?
>
> **You'll be able to:** price any engine step — prefill, decode or a mix — with
> one step-time model and say which term binds; compute the nameplate and the
> effective knee for a chip and number format; read MBU and MFU correctly; turn
> an hourly GPU price into a price per million tokens at a stated occupancy.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="batch,runner,kv"></div>

An H100 can perform about 990 trillion floating-point operations per second. Serve
a 70-billion-parameter model on it to one user at a time and it uses well under
1% of that. Nothing is broken. The tensor cores are waiting for bytes.

This chapter turns the roofline from [The GPU Mental Model](#/gpu-mental-model)
and the shapes from [Inside a Forward Pass](#/inside-a-forward-pass) into one
model of how long an engine step takes. Later chapters each respond to a term in
it and cite it rather than re-derive it, so this is the chapter to read slowly.

## Two numbers per token

[Inside a Forward Pass](#/inside-a-forward-pass) counted the work: every weight is
used once per token, in one multiply and one add, so a token costs about **2·P
FLOPs** — ~140 GFLOPs for a 70B model, ~16 for an 8B. The same pass must also
*read* every weight, 2 bytes each in BF16: **2·P bytes**. A mixture-of-experts
model splits the two: FLOPs follow its *active* parameters, bytes stored follow its
*total* ([MoE Serving](#/moe-serving)).

## Decode at batch 1: bandwidth and nothing else

To produce one token, the GPU must read every weight from HBM at least once:
`2·P` bytes moved for `2·P` FLOPs.

```text
   intensity  =  2P FLOPs ÷ 2P bytes  ≈  1 FLOP/byte
```

Against an H100 ridge of ~295, batch-1 decode is about 300× too low on the
intensity axis. The FLOPs barely matter; the time is set by the bytes.

> [!predict] Before you read on
> A 13B-parameter model in 16-bit on one A100 with ~1.5 TB/s of bandwidth.
> Estimate the time to generate one token at batch 1. Then: what would doubling
> the GPU's FLOP/s do to that number?

```text
   bytes  =  13e9 × 2  =  26 GB
   T      =  26e9 ÷ 1.5e12  ≈  17 ms per token
```

Doubling the FLOP/s would change nothing; the estimate has no FLOP term. kipply's
*Transformer Inference Arithmetic* (2022) made this prediction (16.8 ms) and
measured it on FasterTransformer: 22.0 ms, "meaning our guess was 76% there".
She closed the gap step by step: ~90% achieved bandwidth gives 18.5 ms,
activations add ~2.2 ms, sampling and kernel launches the last ~1.4 ms. None of
it is compute. So the rule is:

> **Decode latency at small batch ≈ bytes read per step ÷ memory bandwidth** —
> and the real number sits 20–30% above it, for reasons you can name.

To decode faster you must read fewer bytes — store the weights in fewer bits
([Quantization](#/quantization)) — or read them faster, with more bandwidth.

## Prefill: the same weights on the other side of the ridge

Prefill hands each layer all `T` prompt tokens at once. Every weight read from HBM
is used for all `T` of them: `2·P·T` FLOPs for the same `2·P` bytes, an intensity of
roughly `T`. For a prompt of a few hundred tokens or more, that is past the ridge.

```text
        memory-bound │ compute-bound
                     │
   decode  ≈ 1 ●─────┼──────────────● prefill ≈ T
                     │
                ridge ≈ 295 (H100)
```

![The H100 roofline with the workload plotted on it: batch-1 decode sitting far down the bandwidth slope at about 1 FLOP/byte, prefill sitting up on the flat compute roof, and a trail of intermediate points marking growing decode batch sizes walking from one to the other across the ridge at 295.](assets/diagrams/prefill-decode-roofline.svg)

**Prefill is compute-bound. Decode is memory-bound.** You have now derived it:
same weights, same kernels, same chip; the only difference is how many tokens
share each weight read. It is why the two phases have different metrics and
costs, why schedulers treat them differently, and why some systems run them on
separate GPUs ([Disaggregated Serving](#/disaggregation)).

For prefill the useful estimate is compute time:

```text
   T_prefill  ≈  2 · P · T  ÷  (peak FLOP/s × MFU)
```

where **MFU** (model FLOPs utilisation, defined below) is the fraction of peak you
actually achieve; the course plans dense prefill at 40%.

Attention adds work that grows with the square of the prompt. Under the causal
mask, token *i* scores against *i* earlier tokens, so a `T`-token prefill costs
`2 × layers × q_width × T²` FLOPs of attention (`q_width` = query heads × head_dim,
8,192 for the case model). Divided by the weight work `2·P·T`, the attention share
is `layers × q_width × T ÷ P`: for Llama-3.3-70B, `T ÷ 107,000` — about 3% at the
case's 3,000 tokens, 8% at 8K, 31% at 32K.

## The KV cache: bytes that grow

[Inside a Forward Pass](#/inside-a-forward-pass) derived the cache per token —
328 KB for the case model — and how to read it from a config. Set it against the
weights: one 128K-token Llama-3-70B sequence holds ~43 GB of cache, a third of the
140 GB of weights. Across many concurrent users, **the KV cache, not the weights,
usually caps how many requests you can serve at once** — which is why The Engine
is largely about managing it.

![KV cache per sequence against context length: Llama-3-8B at 131 KB per token, Llama-3-70B at 328 KB, DeepSeek-V3 with MLA at about 70 KB, crossing 80 GB (one H100) and 140 GB (the 70B model's weights, reached at ~427,000 tokens).](assets/diagrams/kv-growth.svg)

Try your own model and context length:

<div class="inf-widget" data-widget="kv-calculator">
<p class="inf-widget-fallback">Interactive KV-cache and memory-fit calculator — needs JavaScript enabled.</p>
</div>

## Batching: almost free, until the knee

Decode is memory-bound because each token shares a weight read with nobody. The
fix is to decode `B` independent sequences in the same step. The weight bytes stay
the same — each weight is read once and applied to all `B` tokens — while the
FLOPs grow to `2·P·B`. The intensity is now about `B`.

> [!predict] Before you read on
> On an H100, a decode step at batch 1 takes some time `t`. Raise the batch to 64
> sequences with short contexts. Does the step take about `t`, about `8t`, or
> about `64t`?

About `t`. At batch 64 the intensity is ~64, still far below the ridge, so the
step is still bounded by reading the weights, once. Sixty-four users get a token
each for nearly the price of one: throughput rises almost 64×, latency barely
moves.

This holds until the intensity reaches the ridge, at the **critical batch size**:

```text
   B_crit (nameplate)  =  peak FLOP/s ÷ peak bytes/s  ≈  295 on an H100 in BF16
```

It is the ridge read as a batch size, and it depends on the chip (~153 on an
A100 80 GB: 312 ÷ 2.04) and on the format. Store the weights in 8 bits but
multiply in BF16 and each weight costs half the bytes: B_crit halves. Multiply
in FP8 too and the H100's dense peak doubles to ~1,979 TFLOP/s — the number its
spec sheet prints for BF16 *with sparsity* — and the effects cancel at ~295.

Below the knee each added sequence rides along nearly free; near it you get the
most throughput per unit of latency; above it step time grows with `B` and every
user slows down for little extra throughput.

![Dual-axis chart against batch size at the nameplate knee: throughput climbs then flattens while per-token latency stays flat then rises, both bending at B_crit ≈ 295. A real node's effective knee sits further left.](assets/diagrams/batching-knee.svg)

> [!bridge] From the Linux course
> io_uring batches I/O submissions for the same reason: a large fixed cost per
> trip makes the second and the hundredth item on the trip nearly free, until
> some other resource binds. What differs is the fixed cost — a ring transition
> there, a full read of the model's weights here — and that the GPU's break-even
> can be computed in advance from two numbers on a spec sheet.
> [→ Linux: Modern I/O & io_uring](../#/modern-io)

## One model of a step

Batching, prefill and decode are three cases of one calculation. An engine step
runs every layer once over whatever tokens the scheduler put in it, and costs:

```text
   step  ≈  max( t_w , t_c )  +  t_kv

   t_w   reading the weights: once per step, whatever rides on it
   t_c   arithmetic: tokens in the step × 2·P ÷ achieved FLOP/s
   t_kv  reading each sequence's own KV cache: batch × context × bytes per token
```

The first two overlap, because the *same* multiplies read the weights and do the
arithmetic; the step pays the larger. The third adds: attention reads bytes no
other sequence shares, so it never batches away. A step carrying a prefill chunk
and some decodes is therefore *not* "prefill time plus decode time".

On the case's node (four H100s, tensor-parallel, BF16) the terms are `t_w` ≈ 14 ms
(the planning figure derived below), `t_c` ≈ 0.0885 ms per token (140 GFLOPs ÷
1.58 × 10¹⁵ FLOP/s, four GPUs at 40% MFU) and `t_kv` ≈ 29 ns per context token per
sequence (each GPU holds 2 of the 8 KV heads, 81,920 bytes per token, read at ~85%
of 3.35 TB/s). Run it across some batches:

```python
# The course's step-time model on the case node (4 x H100 SXM, TP=4, BF16).
P, GPUS = 70e9, 4
W_GPU = 2 * P / GPUS            # 35 GB of weights per GPU
BW, FLOPS = 3.35e12, 989e12     # per GPU: bytes/s; dense BF16 FLOP/s
KV_GPU = 2 * 80 * 2 * 128 * 2   # 81,920 B per token per GPU (2 of 8 KV heads)

floor = W_GPU / BW                       # rung 1: physics
achv = W_GPU / (0.85 * BW)               # rung 2: streaming at ~85%
t_w = 14e-3                              # rung 3: + all-reduce, launches
t_c = 2 * P / (GPUS * FLOPS * 0.40)      # seconds of arithmetic per token
t_ctx = KV_GPU / (0.85 * BW)             # KV read per context token
print(f"rungs: {floor*1e3:.1f} -> {achv*1e3:.1f} -> {t_w*1e3:.0f} ms;"
      f" t_c {t_c*1e3:.4f} ms/token; t_kv {t_ctx*1e9:.1f} ns/ctx token")
print(f"knee: nameplate {FLOPS/BW:.0f}, effective {t_w/t_c:.0f} tokens/step")

def step(batch, ctx):                    # decode-only step, seconds
    return max(t_w, batch * t_c) + batch * ctx * t_ctx

print(f"{'batch':>5} {'ctx':>6} {'step ms':>8} {'tok/s':>7} {'KV GB/step':>11}")
for batch, ctx in [(1, 3000), (20, 3000), (64, 1000), (160, 1000),
                   (256, 1000), (32, 30000)]:
    s = step(batch, ctx)
    kv_node = batch * ctx * KV_GPU * GPUS / 1e9
    print(f"{batch:>5} {ctx:>6} {s*1e3:>8.1f} {batch/s:>7.0f} {kv_node:>11.1f}")

# --- output of an actual run ---
# rungs: 10.4 -> 12.3 -> 14 ms; t_c 0.0885 ms/token; t_kv 28.8 ns/ctx token
# knee: nameplate 295, effective 158 tokens/step
# batch    ctx  step ms   tok/s  KV GB/step
#     1   3000     14.1      71         1.0
#    20   3000     15.7    1272        19.7
#    64   1000     15.8    4040        21.0
#   160   1000     18.8    8529        52.4
#   256   1000     30.0    8529        83.9
#    32  30000     41.6     769       314.6
```

*Runnable — Python 3 standard library only; output shown is from an actual run. Every number it prints is an estimate from the case's inputs, not a measurement.*

Read the second line. The nameplate knee is 295; the model puts it near 160
tokens per step, where `t_c` catches up with `t_w`. The nameplate divides *peak*
by *peak*, while a real step achieves different fractions of each: 40% of the compute (MFU) but ~74% of the
bandwidth (10.4 ÷ 14). The ratio of what you achieve, 990 × 0.40 ÷ (3.35 × 0.74),
is ~160. Say "nameplate ~295, effective ~160 on this node, measure it". Then read
the last two rows: at batch 256 the step reads ~84 GB of KV cache, 60% as much as
the weights, and 32 sequences of 30K tokens read more than twice the weights while
using a fifth of the knee. The KV term is what batching cannot buy back.

The same model prices mixed steps. A 512-token prefill chunk riding with 20
decodes is 532 tokens: `t_c` ≈ 47 ms > `t_w`, so the step takes ~50 ms with its
KV reads, and each of those 20 users waits 50 ms for that token instead of 16.
How big a chunk to allow is [Continuous Batching](#/continuous-batching)'s call.

## The decode time, as a ladder

The course quotes the case's decode step at several values: one estimate, refined
in steps. Name the rung you are on:

| rung | what it adds | case node, decode step |
|---|---|---|
| 1. physics floor | 35 GB per GPU ÷ 3.35 TB/s | 10.4 ms |
| 2. achievable bandwidth | streaming reads reach ~85% of nameplate | 12.3 ms |
| 3. planning figure, batch 1 | ~160 all-reduces and ~1,000 kernel launches | ~14 ms |
| 4. ~20 concurrent 3K-token sequences | their KV reads, 20 × 3,000 × 29 ns | ~16 ms |

Rung 3 is the weakest. Splitting each layer across four GPUs means two
all-reduces per layer — partial results summed over NVLink
([Parallelism for Inference](#/parallelism-for-inference)) — 160 tiny,
latency-bound exchanges per step. The course allows 1.7 ms for them and the
launches, about 10 µs apiece. That is an assumption: kipply measured 40–50 µs of communication per
layer on two A100s with 2022 software; at that rate 80 layers would add 3–4 ms
and put rung 3 near 16 ms.

Whole-engine measurements agree. Databricks defines **MBU** (model bandwidth utilisation) as achieved bandwidth — "(total model
parameter size + KV cache size) / TPOT" — over peak, and reports that "at batch
size 1, we can achieve a higher MBU of 60% on 2xH100-80GBs as compared to 55% on
4xA100-40GB GPUs" (Oct 2023, TensorRT-LLM). Rung 3 assumes 74%. At 50–60% the
planning figure would be 10.4 ÷ 0.6 to 10.4 ÷ 0.5: 17–21 ms. Streaming kernels
reach 85–90% of the bandwidth; whole decode steps, with their small kernels and
synchronisations, reach less.

So the ladder is an estimate with a known spread, and the case can live with it:
the TPOT promise is 60 ms, three times the pessimistic end. To stop estimating,
measure rung 3 on the real node, one request at a time with the case's shape:

```bash
vllm bench serve \
  --model meta-llama/Llama-3.3-70B-Instruct \
  --dataset-name random --random-input-len 3000 --random-output-len 250 \
  --max-concurrency 1 --num-prompts 50 --ignore-eos \
  --percentile-metrics ttft,tpot,itl --metric-percentiles 50,95
```

*Real format, illustrative values — flags from vLLM v0.34.0 `vllm/benchmarks/serve.py` and `vllm/benchmarks/datasets/datasets.py`; the values are the case's request shape.*

The line to read is `Median TPOT (ms)`: that is rung 3, measured (plus ~0.1 ms of
this request's own KV reads). Rerun with `--max-concurrency 20` for rung 4.
`--ignore-eos` keeps every answer at 250 tokens; without `--max-concurrency`, the
default `--request-rate` of `inf` sends all 50 requests at time zero.
[Load Testing](#/load-testing) builds the full sweep.

## Utilisation, read correctly

[What Actually Happens When You Call an LLM](#/what-is-inference) defined TTFT
and TPOT. Two refinements matter here. **ITL** (inter-token latency) is each
individual gap; TPOT averages them, so the 50 ms mixed step above barely shows in
a request's TPOT and is plain in its ITL. **Goodput** counts only requests that
met their promises.

Two utilisation numbers are routinely confused:

- **MFU** = achieved FLOP/s ÷ peak. The meter for prefill: the course plans
  40%; 35–55% is typical for dense prefill.
- **MBU** = achieved bytes/s ÷ peak. The meter for decode.

They are linked: `MFU ÷ MBU = intensity ÷ ridge`. In decode the intensity is far
below the ridge, so MFU is far below MBU by construction. A decode MFU of 9%
describes a healthy memory-bound step, not a broken one.

> [!dashboard] The step's time budget
> **Utilisation:** MBU as `rate(vllm:estimated_read_bytes_per_gpu_total)` ÷
> 3.35 TB/s (an engine estimate; needs `--enable-mfu-metrics`), or
> `DCGM_FI_PROF_DRAM_UTIL_RATIO`.
> **Saturation:** `vllm:inter_token_latency_seconds` rising toward the effective
> knee's step time. **Errors:** none as a metric — derive the share of
> `vllm:request_time_per_output_token_seconds` observations above 0.06 s from its
> buckets.

## What a token costs

```text
   $ per 1M tokens  =  GPU $ per hour  ÷  (tokens per second × 3,600 × occupancy)  × 10⁶
```

**Occupancy** is the fraction of paid hours in which the GPU works at that
operating point — not MFU or MBU, which describe how well busy time is used. On
the case node ($10 an hour), the script's rows price an output token at 100%
occupancy: batch 1, 71 tokens/s, $39 per million; batch 20, 1,272 tokens/s,
$2.18; near the knee, ~8,500 tokens/s, $0.33. Same hardware, a 120× range,
set by how many sequences share a step.

> [!predict] Before you read on
> APIs charge separately for input (prompt) and output tokens. From the step-time
> model, how many times more node-time does an output token cost than an input
> token — a fixed ratio, or one that depends on something?

It depends on the batch. An input token costs `t_c` ≈ 0.0885 ms of node time,
because prefill is compute-bound at any batch. An output token costs a step divided
by the sequences sharing it: 14 ms at batch 1 (~160× an input token), 15.7 ÷ 20
≈ 0.79 ms at Halden's 20 (~9×), 18.8 ÷ 160 ≈ 0.12 ms at the knee (~1.3×).
Physics says output is dearer by ~1× to ~160×; a provider's price is a business
decision inside that range.

> **State of play (November 2026):** list prices per 1M tokens put output at 5–6×
> input — Claude Opus 5.5 $4 / $20, Claude Sonnet 5.5 $2 / $10, gpt-6.2-sol
> $2 / $10, Gemini 3.1 Pro Preview $2 / $12. Cached input is now 10–40× cheaper
> than fresh input (0.05× at Anthropic and OpenAI for these models, 0.025× for
> Claude Fable 5.2, 0.1× for Gemini); batch tiers take about 50% off. Per-token
> prices do not compare across tokenizers: Anthropic says its newer tokenizer
> "produces approximately 30% more tokens for the same text". Sources: the
> providers' pricing pages, read 2026-11-21.

The cached-input discount has the same root: a repeated prefix's KV cache is
computed once and reused ([PagedAttention & Prefix Caching](#/paged-kv-cache)).

> [!case] The case: what the arithmetic settles
> Ask Halden: Llama-3.3-70B in BF16, tensor-parallel across four H100s.
>
> - Decode: ~14 ms per step at batch 1 (rung 3), ~16 ms with 20 sequences in
>   flight (rung 4) — or 17–21 ms if the node behaves like Databricks'
>   measurements. TPOT promise: 60 ms.
> - Prefill: 3,000 tokens × 0.0885 ms ≈ 0.27 s. TTFT promise: 1.5 s.
> - KV per request: 3,250 tokens × 328 KB ≈ 1.07 GB.
> - What the peak costs: 1.5 requests/s × 0.27 s ≈ 40% of the node's
>   arithmetic goes to prefill at the morning peak (~29% if the 800-token system
>   prompt is cached).
>
> **What would have to change for speed to matter:** with decode-only steps at
> 3,000 tokens of context, the model reaches 60 ms only at ~340 sequences decoding
> at once — 17 times the planned 20 — or with 20 sequences of ~80,000 tokens each.
> Phase 1 is nowhere near either; what remains is how many requests are in flight
> and how many fit, which The Engine answers. **Decision recorded:** these
> are estimates; Halden's first act on the node is `vllm bench serve` at
> concurrency 1 and 20, and the measured TPOTs replace rungs 3 and 4 in every
> later calculation.

## Exercises

<div class="exercise">

**Exercise 1.** Estimate TTFT for an 8,192-token prompt to Llama-3-8B (32 layers,
32 query heads × 128) in BF16 on one H100, at 40% prefill MFU and no queueing.
Then estimate it for a 32K prompt against a 1-second TTFT promise, attention
included.

<details>
<summary>Reveal answer</summary>

```text
   FLOPs  =  2 × 8e9 × 8,192    =  1.31e14
   rate   =  990e12 × 0.40      =  3.96e14 FLOP/s
   T      =  1.31e14 ÷ 3.96e14  ≈  0.33 s
```

Bandwidth never enters: prefill is compute-bound.

At 32,768 tokens the weight work grows 4× to ~1.3 s — over the promise before any
queueing. Attention's share is `layers × q_width × T ÷ P` = 32 × 4,096 × T ÷ 8e9,
i.e. `T ÷ 61,000`: ~13% at 8K and ~54% at 32K. The honest 32K estimate is
1.3 × 1.54 ≈ 2 s. The 8B model reaches a given attention share at about half
the prompt length the 70B does (`T ÷ 107,000`).

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A colleague sweeps concurrency on the case node
(200 tokens in, 1,600 out, so contexts average ~1,000) and pastes:

```plaintext
$ grep -E 'concurrency|Output token throughput|Mean TPOT' c16.txt c64.txt c256.txt
c16.txt:Maximum request concurrency:             16
c16.txt:Output token throughput (tok/s):         1041.37
c16.txt:Mean TPOT (ms):                          15.21
c64.txt:Maximum request concurrency:             64
c64.txt:Output token throughput (tok/s):         3742.80
c64.txt:Mean TPOT (ms):                          16.94
c256.txt:Maximum request concurrency:             256
c256.txt:Output token throughput (tok/s):         8048.15
c256.txt:Mean TPOT (ms):                          31.37
```

*Real format, illustrative values — output lines of `vllm bench serve` from vLLM v0.34.0 `vllm/benchmarks/serve.py`; numbers invented for the exercise, close to the step-time model.*

"256 is below B_crit of 295, so TPOT should be flat — the engine must be broken."
Is it? How many GB of KV cache does a batch-256 step read? And at concurrency 32,
what average context would bring the step to the 60 ms promise?

<details>
<summary>Reveal answer</summary>

Not broken: 295 is the nameplate knee; this node's effective knee is ~160. At
256, `t_c` = 256 × 0.0885 ≈ 22.7 ms exceeds `t_w` = 14 ms: compute binds. The KV term adds 256 × 1,000 × 28.8 ns ≈ 7.4 ms — the step reads
256 × 1,000 × 328 KB ≈ 84 GB of cache, 60% of the weights' 140 GB. Model:
22.7 + 7.4 ≈ 30 ms; measured 31.4. Throughput went from 3,740 to 8,050 tokens/s
(2.2×) for 4× the users: past the knee.

At 32 sequences, `t_c` = 2.8 ms < 14 ms, so step = 14 + 32 × ctx × 28.8 ns. Setting
it to 60 ms: ctx ≈ 46 ms ÷ (32 × 28.8 ns) ≈ 50,000 tokens. Long contexts
break the promise long before batch size does.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** NVIDIA lists the Rubin GPU at 288 GB of HBM4, 19.2 TB/s,
4 PFLOPS dense BF16 and 17.5 PFLOPS dense FP8. Ask Halden's model in FP8 (70 GB)
would fit on one. (a) What is the physics floor for its decode step? (b) What is
the nameplate B_crit in BF16, and with FP8 weights and FP8 arithmetic? (c) Does
the H100's rule "FP8 weights and FP8 math cancel" hold on Rubin?

<details>
<summary>Reveal answer</summary>

(a) 70 GB ÷ 19.2 TB/s ≈ 3.6 ms, a third of the case node's 10.4 ms floor.

(b) BF16: 4,000 ÷ 19.2 ≈ 208. FP8: the ridge is 17,500 ÷ 19.2 ≈ 911 FLOP/byte,
but an FP8 weight is one byte and yields 2 FLOPs per sequence, so the intensity
is ~2B and B_crit ≈ 911 ÷ 2 ≈ 456.

(c) No. On the H100 FP8 doubles the peak and halves the bytes, so B_crit stays at
295. Rubin's FP8 rate is 4.4× its BF16 rate, so FP8 *raises* the knee from 208 to
~456. Recompute both ratios from each new chip's sheet.

</details>

</div>

## What to remember

- Per token: 2·P FLOPs; per step: 2·P bytes of weights. Prefill shares
  the bytes over `T` tokens (compute-bound); decode over the batch (memory-bound).
- One step model: `step ≈ max(t_w, t_c) + t_kv`. A mixed step is one set of
  multiplies, not prefill time plus decode time.
- The case's decode step is a ladder: 10.4 (physics) → 12.3 (achievable) → ~14
  (planning) → ~16 ms (20 sequences); 17–21 ms at published MBU. Name the rung;
  measure with `vllm bench serve`.
- Nameplate B_crit = peak FLOP/s ÷ peak bandwidth (~295, H100 BF16); the
  effective knee uses achieved rates (~160 on the case node). KV reads never
  batch away.
- Read MBU for decode and MFU for prefill; promise with goodput.
- $/M tokens = $/hour ÷ (tokens/s × 3,600 × occupancy) × 10⁶. The batch
  moves it ~100×, and the output:input cost ratio with it.

```quiz
[
  {
    "q": "Llama-3-8B in BF16 (16 GB of weights) decodes alone on one H100 SXM. Which pair gives its first two rungs — physics floor, then achievable bandwidth?",
    "choices": [
      "About 0.016 ms, then 0.04 ms: 16 GFLOPs at 990 TFLOP/s, then at 40% MFU",
      "About 19 ms, then 22 ms: 16 GB through one memory channel's 0.85 TB/s",
      "About 4.8 ms, then 5.6 ms: 16 GB ÷ 3.35 TB/s, then at 85% of that rate",
      "About 1.2 ms, then 1.4 ms: 16 GB read from the 132 SMs' local memory"
    ],
    "answer": 2,
    "explain": "Batch-1 decode is memory-bound: 16e9 ÷ 3.35e12 ≈ 4.8 ms, and at ~85% achievable bandwidth ≈ 5.6 ms, about 180 tokens/s. The compute-based answer prices a term that is not binding; the weights live in HBM, not in on-chip memory, which is far too small."
  },
  {
    "q": "On the case node, one step carries a 1,024-token prefill chunk and 30 decodes at 3,000 tokens of context. What does the step-time model give?",
    "choices": [
      "About 96 ms: ~93 ms of arithmetic for 1,054 tokens, plus ~3 ms of KV",
      "About 107 ms: the chunk's 93 ms of prefill added to a 14 ms decode step",
      "About 16 ms: the weight read dominates, as it does for any decode step",
      "About 14 ms: the decodes ride free on the prefill chunk's weight read"
    ],
    "answer": 0,
    "explain": "All 1,054 tokens share one set of multiplies: t_c ≈ 1,054 × 0.0885 ≈ 93 ms > t_w = 14 ms, so the arithmetic binds; t_kv = 30 × 3,000 × 28.8 ns ≈ 2.6 ms adds. Adding prefill time to decode time counts the weight read twice — the error the one-model rule exists to stop."
  },
  {
    "q": "An 8-GPU decode benchmark of a 405B model reports 4% MFU and 71% MBU. What should you conclude?",
    "choices": [
      "The GPUs are compute-starved, and a chip with more tensor cores would help",
      "The two figures contradict each other, so the profiler is misconfigured",
      "Batch size should be cut, since an MFU below 5% signals contention",
      "Nothing is wrong: decode is memory-bound, and 71% MBU is a healthy reading"
    ],
    "answer": 3,
    "explain": "MFU ÷ MBU = intensity ÷ ridge, and decode's intensity is far below the ridge, so MFU is far below MBU by construction. 71% of the binding resource is good — better than the 50–60% Databricks reported at batch 1. Reading the low MFU as a fault is the classic misreading."
  },
  {
    "q": "A GPU rents for $2.50 an hour and produces 2,000 output tokens/s at its operating point. Your fleet is busy 40% of the hours you pay for. What does a million output tokens cost?",
    "choices": [
      "About $0.35: price ÷ tokens per hour, since idle hours earn no tokens anyway",
      "About $0.87: $2.50 ÷ (2,000 × 3,600 × 0.40), scaled to a million",
      "About $0.14: the 100% figure multiplied by the 40% occupancy",
      "About $0.49: the 100% figure plus 40% overhead for the idle time"
    ],
    "answer": 1,
    "explain": "You pay for every hour and get tokens in 40% of them: 2.50 ÷ (2,000 × 3,600 × 0.40) × 1e6 ≈ $0.87. The $0.35 figure assumes full occupancy; multiplying by 0.40 makes idle time cheaper rather than dearer; the cost scales with 1 ÷ occupancy, not by an additive margin."
  },
  {
    "q": "An H200 (990 TFLOP/s dense BF16, 4.8 TB/s) serves a model with weights stored in FP8 but multiplied in BF16. What is the nameplate critical batch size?",
    "choices": [
      "About 412: the BF16 ridge of ~206, doubled because each byte is cheaper",
      "About 295: the H100's figure, since the H200 has the same compute die",
      "About 206: the ridge is a property of the chip and ignores the format",
      "About 103: the BF16 ridge of ~206, halved since a weight is one byte"
    ],
    "answer": 3,
    "explain": "Ridge = 990 ÷ 4.8 ≈ 206 FLOP/byte. With one-byte weights and BF16 arithmetic, each sequence does 2 FLOPs per weight byte, so intensity ≈ 2B and B_crit ≈ 103. The H100's 295 ignores the H200's extra bandwidth; ignoring the format misses that cheaper bytes reach the ridge sooner."
  }
]
```
