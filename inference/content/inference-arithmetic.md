# Inference Arithmetic

> **Goal of this chapter:** take the roofline from [The GPU Mental Model](#/gpu-mental-model)
> and apply it to a real transformer. By the end you can predict, on the back
> of an envelope, how fast a model decodes, why prefill and decode land on
> opposite sides of the hardware ridge, how big the KV cache gets, when
> batching stops being free, and what a token actually costs. Every later
> chapter leans on these numbers.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="batch,runner,kv"></div>

Here is a fact that surprises almost everyone. An H100 can do roughly 990
trillion floating-point operations per second. Ask it to generate text from a
70-billion-parameter model, one user at a time, and it runs at **under one
percent** of that. The GPU is not broken. It is starved — not for arithmetic,
but for the bytes it must haul out of memory to feed the arithmetic. This is the
load-bearing chapter of the course: disaggregation, batching, paged KV,
quantization, MoE serving are all responses to the numbers below.

Two refreshers from earlier chapters. A **FLOP** is one floating-point operation
(a multiply or an add). **HBM** is the GPU's high-bandwidth memory — big (80 GB
on an H100), fast (3.35 TB/s), but far slower than the compute units it feeds.
And the **roofline**: an operation is *compute-bound* when it has enough
arithmetic per byte to keep the math units busy, *memory-bound* otherwise. The
dividing line is a pure hardware constant, the **ridge point**
`I_ridge = peak_FLOP/s ÷ peak_byte/s` — about **295 FLOP/byte** on an H100.
Everything here is a story about which side of 295 you are on.

## The 2·P rule: a forward pass costs two FLOPs per weight

Start with the compute. A transformer is, to a first approximation, a stack of
matrix multiplies, and every one of its **parameters** (a learned weight) is
touched exactly once per token: it gets multiplied by an activation and added
into a running sum. That is one multiply and one add — **two FLOPs per weight**.

> **The 2·P rule.** Generating one token through a model with `P` parameters
> costs **≈ 2·P FLOPs**. A 70B model burns ~140 GFLOPs per token; an 8B model,
> ~16 GFLOPs.

You can rederive it per layer: the dense cost per layer is `2·(12·d_model²)`
FLOPs/token — QKV projections (`2·3·d²`), output projection (`2·d²`), MLP block
(`2·8·d²`) — and summing over layers collapses back to 2·P. (Attention's own
scores add a term that scales with sequence length; small for short contexts,
treated separately below.)

> **Common trap — MoE models.** A Mixture-of-Experts model routes each token to
> a few of its experts, so most weights sit idle on any given token. Use
> **active** parameters for FLOPs, **total** parameters for memory. DeepSeek-V3
> is 671B total but only **37B active**, so it costs ≈ 2·37B FLOPs/token to
> compute — while still needing all 671B in HBM. Plugging 671B into the 2·P rule
> overstates its compute by ~18×. This is one of the most common student errors.

## Decode at batch 1: bandwidth, and nothing else

Now the bytes. To generate a token, the GPU must **read every weight out of HBM
at least once** — you cannot multiply by a weight you have not loaded. In BF16
(2 bytes per weight) that is `P·2` bytes moved to do `P·2` FLOPs. The
arithmetic intensity is:

```text
intensity = FLOPs / bytes = 2P / 2P ≈ 1 FLOP per byte
```

One. Against an H100 ridge of 295. Decode at batch 1 sits **~300× below the
ridge** — as memory-bound as an operation can be. The tensor cores spend
virtually all their time waiting for weights to arrive. Consequently:

> **Decode latency ≈ bytes moved ÷ memory bandwidth**, essentially independent
> of how many FLOPs the GPU can do.

The worked example that makes this concrete (from kipply's *Transformer
Inference Arithmetic*). Take a 52B-parameter model in BF16 → **104 GB** of
weights. An A100 delivers ~1.5 TB/s of HBM bandwidth. Predicted time to stream
the weights once, i.e. to produce one token:

```text
T = 104e9 bytes / 1.5e12 bytes/s ≈ 69 ms per token
```

No FLOP count appears — only bytes and bandwidth. When kipply validated this
bandwidth model against real FasterTransformer measurements, predictions landed
within ~10–25% of measured latency, the gap being achievable bandwidth (~85–90%
of peak) plus kernel launch overhead — not any compute term. The model *is* the
memory system. Want faster decode? Move fewer bytes (quantize the weights,
[Quantization](#/quantization)) or move them faster. Adding FLOPs does nothing.

## Prefill vs decode: the same matmul, opposite sides of the ridge

Here is the pivot the entire field turns on. **Prefill** — processing the
prompt — hands the GPU all `T` prompt tokens *at once*. The matmul becomes
`[T, d] × [d, F]`: each weight, read once, now does work for all T tokens before
it leaves the chip. Arithmetic intensity rises to ≈ T, which for a prompt of
hundreds or thousands of tokens is far *above* 295.

**Prefill is compute-bound. Decode is memory-bound.** Same weights, same
kernels, same hardware — the only thing that changed is how many tokens share
each weight read. One (decode) puts you at intensity ≈ 1; a thousand (prefill)
puts you at intensity ≈ 1000.

```text
        memory-bound │ compute-bound
                     │
   decode  ≈1 ●──────┼──────────────●  prefill ≈ T
                     │
                  I_ridge ≈ 295  (H100)
```

![The H100 roofline with the workload plotted on it: batch-1 decode sitting far down the bandwidth slope at about 1 FLOP/byte, prefill sitting up on the flat compute roof, and a trail of intermediate points marking growing decode batch sizes walking from one to the other across the ridge at 295.](assets/diagrams/prefill-decode-roofline.svg)

This asymmetry is the single most important fact in inference serving. It is why
prefill and decode have completely different performance characters, different
metrics, different costs — and, later, why some systems run them on **separate
pools of GPUs** entirely ([Disaggregated Serving](#/disaggregation)). Hold onto
it; the rest of the course is footnotes to this picture.

> [!prereq] Attention in sixty seconds
> The next section derives a formula with four factors in it. Here is where
> every one of them comes from, from scratch.
>
> A transformer layer turns each token's embedding into **three** vectors by
> multiplying it with three learned matrices. The **query** (`Q`) is "what am I
> looking for." The **key** (`K`) is "what do I offer to anyone looking." The
> **value** (`V`) is "what I contribute if I am chosen." Nothing about the three
> is mystical; they are three different linear views of the same token.
>
> Attention then does one thing. It takes the current token's query and takes
> the dot product against the key of **every token at or before it** — that dot
> product is a relevance score, high when the query and the key point the same
> way. The scores go through a softmax, which turns them into weights that are
> positive and sum to one. The layer's output for this token is those weights
> applied to the values: a weighted average of what every earlier token
> contributes, mixed in proportion to how well it matched.
>
> Read that again with generation in mind. To produce token `N` you compute
> **one** query — the one belonging to token `N` — and you need the keys and
> values of tokens `1 … N−1` to score and mix against. Those keys and values do
> not change: token 7's key is a function of token 7 alone, and it is identical
> at step 8, step 800 and step 80,000. So they are worth keeping. The query is
> not: it is built from the token you are currently processing, consumed by one
> softmax, and never referenced again. **That asymmetry is the whole reason the
> cache is called a KV cache and not a QKV cache** — K and V are re-read on
> every future step, Q is used once and discarded.
>
> Two more factors. A layer does not run one attention but `n_heads` of them in
> parallel, each with its own smaller Q/K/V — so multiply by the head count.
> And each head's vectors have a width, `head_dim`, typically 64 or 128. Keys
> and values, times layers, times heads, times head_dim, times bytes per number:
> that is the formula you are about to meet. The architectural variations that
> shrink the head count are
> [Attention Architectures for Serving](#/attention-for-serving).

## The KV cache: what you store so you don't recompute

You met the KV cache conceptually in [chapter 1](#/what-is-inference). The
mechanism: attention needs, for every previous token, a **key** and a **value**
vector. Without caching, generating token 1000 would recompute K and V for all
999 prior tokens — quadratic waste. So we compute each token's K and V once and
**cache** them in HBM. The cost is memory that grows with every token generated.

The exact size, per token:

```text
kv_bytes_per_token = 2 (K and V) × n_layers × n_kv_heads × head_dim × bytes_per_elem
```

Worked, in BF16 (2 bytes), for models the course returns to repeatedly:

| Model | Layers | KV heads × head_dim | KV per token | One seq @ 128K ctx |
|---|---|---|---|---|
| **Llama-3-8B** (GQA) | 32 | 8 × 128 | **131 KB** | ~16 GB |
| **Llama-3-70B** (GQA) | 80 | 8 × 128 | **328 KB** | ~40 GB |
| **DeepSeek-V3** (MLA) | 61 | latent 576 | **~70 KB** | ~9 GB |

Two things stand out. First, **GQA** (Grouped-Query Attention — Llama-3 shares 8
KV heads across 64 query heads) is already doing heavy lifting: a plain multi-head
70B would spend ~2.6 MB/token, 8× more. **MLA** (DeepSeek's Multi-head Latent
Attention, one compressed latent per token) cuts it further still — the *why* is
[Attention Architectures for Serving](#/attention-for-serving); note the headline
~70 KB/token.

Second, the punchline: at 128K context, **one** Llama-3-70B sequence carries
~40 GB of KV cache — a large fraction of the 140 GB of weights themselves. Fit
the weights on a pair of 80 GB H100s and you have room for only a handful of long
sequences. At scale, **the KV cache — not the weights — caps how many requests
you can serve at once**, and so caps throughput. That single fact motivates
PagedAttention, prefix caching, KV quantization, and half the chapters that
follow.

![KV cache size for a single sequence against context length, three straight lines — Llama-3-8B at 131 KB per token, Llama-3-70B at 328 KB, DeepSeek-V3 with MLA at about 70 KB — crossing two dashed ceilings: 80 GB for one H100 and 140 GB for the 70B model's own BF16 weights, which the 70B line reaches at roughly 427,000 tokens.](assets/diagrams/kv-growth.svg)

Put your own model and context length in and watch the pool drain:

<div class="inf-widget" data-widget="kv-calculator">
<p class="inf-widget-fallback">Interactive KV-cache and memory-fit calculator — needs JavaScript enabled.</p>
</div>

## Batching: free lunch until the ridge

Decode is memory-bound because one token shares a weight read with no one. The
fix is obvious once stated: serve **B** independent sequences together. The
weight bytes moved stay fixed (you read each weight once and apply it to all B
tokens), while FLOPs scale as `2·P·B`. Arithmetic intensity ≈ **B**. Batching is
the *only* lever that walks decode up toward the ridge.

> [!bridge] You already know this — from the Linux course
> This is the same economics as batching submissions into an io_uring ring
> instead of paying a syscall per I/O: there is a large fixed cost per trip,
> so the second, tenth and hundredth item on the trip are nearly free, and the
> curve stays flat until some *other* resource starts binding. What differs is
> which fixed cost you are amortising — a ring transition there, a full read
> of the model's weights out of HBM here — and that the GPU's version has a
> sharp, computable break-even you can name in advance.
> [→ Linux: Modern I/O & io_uring](../#/modern-io)

Decode becomes compute-bound when `B` reaches the ridge — the **critical batch
size**, which is exactly the same ratio as `I_ridge`:

```text
B_crit = peak_FLOP/s ÷ peak_byte/s   ≈ 280–300 on an H100 (BF16)
```

(It is not a universal constant: ~208 on an A100, ~240 on a TPU v5e — same
formula, different silicon. Quantizing weights to FP8/INT8 halves the bytes and
so *halves* B_crit.) The interpretation is where the money is:

- **B below B_crit — memory-bound.** You re-read the same weights no matter what,
  so each added request rides along nearly **for free**: latency barely moves,
  throughput climbs almost linearly. This is why continuous batching
  ([next module](#/continuous-batching)) is such a large win.
- **B ≈ B_crit — the knee.** Best throughput-per-unit-latency; the sweet spot
  schedulers aim for.
- **B above B_crit — compute-bound.** Now FLOP-limited; per-token latency grows
  with B. You trade latency for diminishing throughput — and likely hit the
  KV-cache HBM wall first anyway.

![Dual-axis chart against batch size: throughput climbs linearly then flattens at a plateau, while per-token latency stays flat then rises linearly, both bending at the same vertical line at B_crit ≈ 295 — the region left of it shaded "free lunch", the region right of it shaded "you now pay latency".](assets/diagrams/batching-knee.svg)

> **Common trap — attention doesn't batch away.** B_crit is the batch size at
> which the *weight matmuls* saturate compute. Attention is different: each
> sequence reads its **own** KV cache to serve its **own** query, so KV reads do
> not amortize across the batch. Long contexts make attention's byte traffic
> dominate, and serving stays memory-bound (KV-bound) no matter how large the
> batch. Weight reuse saturates; KV reuse never does.

## Metrics, precisely

Blogs blur these; production does not.

- **TTFT** (Time To First Token): request arrival → first token. Queue + prefill;
  compute-bound, grows with prompt length.
- **TPOT** (Time Per Output Token): the steady-state decode gap, averaged —
  `(e2e − TTFT) / (output_tokens − 1)`. Memory-bound.
- **ITL** (Inter-Token Latency): the *instantaneous* gap between two tokens.
  Often used as a synonym for TPOT, but TPOT is the average while ITL can spike
  as the scheduler reshuffles the batch. (vLLM tracks them separately — issue #6531.)
- **End-to-end latency:** the identity `TTFT + (output_tokens − 1)·TPOT`.
- **Throughput:** output tokens/s across all live requests.
- **Goodput:** throughput *counting only requests that met their SLO* (e.g.
  TTFT < 1 s **and** TPOT < 50 ms). The production metric — raw throughput means
  nothing if the latency it buys breaks your promises.

And the two utilization numbers people confuse:

- **MFU** (Model FLOPs Utilization) = achieved ÷ peak FLOP/s. Report for
  **prefill**, where the 100% ceiling is meaningful. Real dense prefill: 35–55%.
- **MBU** (Model Bandwidth Utilization) = achieved ÷ peak byte/s, achieved =
  `(weight_bytes + kv_bytes) / TPOT`. Report for **decode**. Real: ~50–60% at
  batch 1 on H100/A100 (Databricks).

They are the same quantity seen from two sides, tied by one identity:

```text
MFU / MBU = I_work / I_ridge
```

In the memory-bound regime `I_work ≪ I_ridge`, so MFU ≪ MBU — quoting decode's
~10% MFU as if the GPU were broken is the classic misread. **Report the
utilization whose ceiling is 100% for the binding resource:** MBU for decode, MFU
for prefill.

> [!bridge] You already know this — from the Linux course
> "Find the binding resource before you optimise anything" is the USE method
> in a different costume: you were already taught not to read CPU utilisation
> on a box that is actually blocked on I/O. What differs is that a GPU offers
> you two plausible-looking meters, MFU and MBU, for what is really one
> quantity, and the misleading one reads *low* rather than high — a 9% decode
> MFU looks like a broken deployment and is in fact exactly what a healthy
> memory-bound decode looks like.
> [→ Linux: Performance Analysis Methodology](../#/perf-methodology)

## The money

Cost follows directly from throughput:

```text
cost_per_token = GPU_$/hr ÷ (tokens/s × 3600 × utilization)
```

Worked: Llama-3.3-70B in FP8 on an H200 at $3.44/GPU-hr, peaking ~2,036 tok/s.
At 100% utilization, `3.44 / (2036 × 3600) ≈ $0.47 / 1M tokens`. But real fleets
run at 30–60% utilization, so multiply by ~1.7–3.3×: a realistic **$0.8–1.5 /
1M**. Utilization, not sticker FLOPs, sets your bill.

> **State of play (mid-2026):** commercial APIs price **output tokens ~5–6×
> input**. GPT-5.5 ~$5 in / $30 out; Claude Sonnet 4.6 $3 / $15; Gemini 3.1 Pro
> $2 / $12 (per 1M). Numbers drift; the ratio is physics.

Why the 5× gap? The prefill/decode asymmetry. **Input** tokens are prefill —
compute-bound, parallel, high utilization, cheap. **Output** tokens are decode —
memory-bound, sequential, low utilization, expensive. Nothing about output being
"worth more"; it is simply ~5× less GPU-efficient to produce.

And **cached input is ~10× cheaper still**. If a prompt prefix (a long system
prompt, shared RAG context, few-shot examples) repeats across calls, its KV cache
is computed once and reused — prefill compute amortizes toward zero, leaving only
cheap storage. That is prefix caching; the full story is
[PagedAttention & Prefix Caching](#/paged-kv-cache) and
[The Agentic Era](#/agentic-serving).

## Six things people get wrong

1. **"GPUs do petaFLOPs, so decode is fast."** Batch-1 decode runs at ~1
   FLOP/byte, ~300× below the ridge, using under 10% of the FLOPs. Decode speed
   is bandwidth ÷ bytes-read; the teraFLOP number is irrelevant to one stream.
2. **Confusing capacity with bandwidth.** 80 GB decides *how much* fits; 3.35
   TB/s decides *how fast* decode runs. A model can fit easily and still starve.
3. **"Bigger batches always cost latency."** Below B_crit (~280 on H100), extra
   requests are nearly latency-free — you re-read the same weights regardless.
   Batching is a free lunch until the ridge.
4. **"KV cache is a rounding error."** At long context / high concurrency it
   exceeds the weights and becomes *the* limit on batch size and throughput.
5. **"Marketing FLOPs are the ceiling."** Vendor peak numbers include 2:4
   sparsity (2×); dense BF16 inference sees half. Using the sparse figure makes
   B_crit and MFU wrong by 2×.
6. **"Output costs more because it's worth more."** No — decode is sequential and
   bandwidth-bound, ~5× less efficient than parallel prefill. Physics, not
   marketing.

## Exercises

<div class="exercise">

**Exercise 1.** A GQA model has **64 layers**, **8 KV heads**, **head_dim
128**, and is served in **BF16**. Compute its KV cache per token, and for one
sequence at a **16K** context. If the engine leaves a **60 GB** KV pool after
weights and overhead, how many such sequences fit — and what does switching
the cache to FP8 buy you?

<details>
<summary>Reveal answer</summary>

Per token, straight from `2 × layers × kv_heads × head_dim × bytes`:

```text
2 × 64 × 8 × 128 × 2  =  262,144 bytes  =  256 KiB ≈ 262 KB / token
```

One sequence at 16,384 tokens:

```text
262,144 × 16,384  =  4.29e9 bytes  ≈  4.29 GB / sequence
```

Concurrency in a 60 GB pool: `60 / 4.29 ≈ 13` sequences. Thirteen — on a
model whose weights you probably sized in five seconds and then stopped
thinking about.

FP8 KV halves `bytes_per_elem` from 2 to 1, so per-token drops to 131 KB,
per-sequence to **2.15 GB**, and concurrency **doubles to ~27**. Nothing about
the weights changed; you bought 2× throughput out of the cache alone.

Worth noticing what GQA already saved you. Plain multi-head attention with 64
KV heads instead of 8 would cost `2 × 64 × 64 × 128 × 2 = 2.1 MB/token` — 8×
more, 34 GB for that one 16K sequence, and a concurrency of **one**.

</details>

</div>

<div class="exercise">

**Exercise 2.** Estimate TTFT for an **8,192-token prompt** to **Llama-3-8B**
in BF16 on a single **H100** (989 TFLOP/s dense), assuming a prefill **MFU of
40%** and no queue wait. Then say what happens at a 32K prompt against a 1-second
TTFT SLO.

<details>
<summary>Reveal answer</summary>

Prefill compute, from the 2·P rule applied to every prompt token:

```text
FLOPs = 2 × 8e9 × 8,192  =  1.31e14 FLOPs
```

The achieved rate is peak times MFU, not peak:

```text
rate = 989e12 × 0.40  =  3.96e14 FLOP/s

T    = 1.31e14 / 3.96e14  ≈  0.331 s  ≈  331 ms
```

So **~330 ms of prefill**, and TTFT is that plus queue wait plus tokenization.
Note that bandwidth never entered the calculation — prefill is compute-bound,
which is exactly why MFU is the meter to quote here.

At 32,768 tokens the 2·P term scales linearly, 4× → **~1.33 s**, already past
a 1 s SLO before the request has waited in a queue for a single millisecond.
Two honest caveats. The quadratic attention term
(`≈ 4 · n_layers · T² · d_model`, halved for causal masking) adds roughly
**13%** at 8K and grows as T², so it is a rounding error at short prompts and
is not one at 128K. And 40% MFU is optimistic if prefill is chunked to protect
running decodes — which is precisely the trade
[Continuous Batching & Scheduling](#/continuous-batching) is about.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>Does the 2·P rule apply to prefill as well, or only to decode?</summary>

To both — it is a cost *per token*, not per request. Prefilling a T-token
prompt costs about `2·P·T` FLOPs, which is why prefill time scales linearly
with prompt length. What changes between the phases is not the FLOP count but
the bytes: decode moves `P × bytes_per_weight` to produce one token, prefill
moves the same bytes to produce T of them. Same numerator, T× smaller
denominator, opposite sides of the ridge.

</details>

<details>
<summary>If B_crit is around 280, why do real deployments run batches of 32 or 64?</summary>

Because B_crit is the batch size at which *the weight matmuls* would saturate
compute, and you usually hit two other walls first. The KV cache runs out of
HBM — at 328 KB/token, 280 concurrent sequences at even 8K context is ~750 GB
of cache — and attention's KV reads never amortise across the batch, so
serving stays memory-bound anyway. B_crit tells you the batching lever is
*not* the thing costing you latency; it does not promise the lever goes that
far. [Sizing a Deployment](#/sizing-a-deployment) does the addition properly.

</details>

<details>
<summary>My measured decode is 20% slower than bytes ÷ bandwidth predicts. What am I missing?</summary>

Three things, in roughly that order of size. Achievable HBM bandwidth is
~85–90% of the spec figure, so start by deflating 3.35 TB/s accordingly. The
weights are not the only bytes — every sequence in the batch also streams its
own KV cache each step, and at long context that term stops being small.
Finally there is per-step overhead that is neither FLOPs nor bytes: kernel
launches, sampling, Python-side scheduling, which is what CUDA graphs exist to
remove ([Kernels, Graphs & Compilation](#/kernels-and-compilation)). Landing
within 10–25% of the naive bandwidth model is the expected outcome, not a bug.

</details>

</div>

## What to remember

- **2·P FLOPs per token** to compute; **P·bytes** moved to read the weights. For
  MoE, *active* params for FLOPs, *total* for memory.
- **Decode is memory-bound** (intensity ≈ 1): latency ≈ bytes ÷ bandwidth, FLOPs
  irrelevant. 104 GB / 1.5 TB/s ≈ 69 ms/token, confirmed by measurement.
- **Prefill is compute-bound** (intensity ≈ T): the same matmul, the other side
  of the ridge. This asymmetry drives everything downstream.
- **KV cache** = `2 × layers × kv_heads × head_dim × bytes` per token; 328 KB for
  Llama-3-70B, ~40 GB for one 128K sequence — the real cap on concurrency.
- **Batching** raises intensity ≈ B; free below `B_crit ≈ FLOP/s ÷ byte/s` (~280
  on H100), costly above. Attention KV reads never batch away.
- **Metrics:** TTFT/TPOT/ITL, goodput is the SLO-counted one that matters; MBU
  for decode, MFU for prefill, tied by `MFU/MBU = I_work/I_ridge`.
- **Cost** = GPU-$/hr ÷ (tok/s × 3600 × util); output ~5× input, cached input
  ~10× cheaper — both straight from prefill/decode physics.

```quiz
[
  {
    "q": "At batch size 1, why does an H100 generate tokens at under 1% of its peak FLOP rate?",
    "choices": [
      "The model doesn't fit in HBM, so weights spill to system RAM",
      "Decode reads ~P bytes of weights to do ~2P FLOPs — intensity ≈ 1 FLOP/byte, ~300× below the ridge, so it's bandwidth-bound and the compute units idle waiting for weights",
      "Sampling (top-p/top-k) dominates the per-token cost",
      "BF16 tensor cores are inherently 100× slower than the marketing number"
    ],
    "answer": 1,
    "explain": "One token shares each weight read with no other token, so arithmetic intensity is ~1 FLOP/byte against a ridge of ~295. The GPU spends its time streaming weights out of HBM, not computing. Decode latency ≈ bytes ÷ bandwidth, independent of FLOP capacity."
  },
  {
    "q": "Prefill and decode run the same matmuls on the same weights. Why is prefill compute-bound while decode is memory-bound?",
    "choices": [
      "Prefill uses tensor cores and decode uses CUDA cores",
      "Prefill processes T prompt tokens in parallel, so each weight read is reused across T tokens (intensity ≈ T ≫ ridge); decode does one token per weight read (intensity ≈ 1)",
      "Prefill is done in FP8 and decode in BF16",
      "Decode has to recompute the KV cache every step"
    ],
    "answer": 1,
    "explain": "The only variable that changes is how many tokens share each weight read. Prefill amortizes one read across the whole prompt (intensity ≈ T, above the ridge → compute-bound); decode amortizes across a single token (intensity ≈ 1, far below → memory-bound). This asymmetry is why some systems disaggregate the two."
  },
  {
    "q": "DeepSeek-V3 has 671B total parameters but 37B active per token. What do you use for a FLOPs-per-token estimate, and what for HBM capacity?",
    "choices": [
      "671B for both",
      "37B for both",
      "37B (active) for FLOPs via 2·P; 671B (total) for memory capacity",
      "671B for FLOPs; 37B for memory"
    ],
    "answer": 2,
    "explain": "Only the routed experts do arithmetic, so compute is 2 × 37B ≈ 74 GFLOPs/token. But every expert weight must still live in HBM in case it's routed to, so capacity needs all 671B. Using total params for FLOPs overstates compute ~18× — a classic MoE error."
  },
  {
    "q": "On an H100 (B_crit ≈ 280), you raise the decode batch from 8 to 40 sequences. What happens to per-token latency, and why?",
    "choices": [
      "It rises ~5× — more sequences means proportionally more work",
      "It stays nearly flat — below B_crit you're re-reading the same weights regardless, so extra requests are almost latency-free while throughput climbs",
      "It falls to 1/5 — batching always speeds up each token",
      "It becomes unpredictable because attention dominates"
    ],
    "answer": 1,
    "explain": "Below the critical batch size decode is memory-bound: weight bytes moved are fixed no matter the batch, so added sequences ride along for free on latency while throughput rises almost linearly. Latency only starts growing once B pushes past B_crit into the compute-bound regime."
  },
  {
    "q": "A decode benchmark reports 9% MFU and 58% MBU. What should you conclude?",
    "choices": [
      "The GPU is misconfigured — both numbers should be near 100%",
      "Nothing is wrong: decode is bandwidth-bound, so MBU (ceiling 100%) is the right metric and 58% is healthy; low MFU is the expected signature of the memory-bound regime",
      "The model is compute-bound and needs a faster GPU",
      "MFU and MBU should always be equal; the tool has a bug"
    ],
    "answer": 1,
    "explain": "MFU/MBU = I_work/I_ridge, and in decode I_work ≪ I_ridge, so MFU ≪ MBU by construction. Report the utilization whose ceiling is truly 100% for the binding resource — MBU for decode, MFU for prefill. A low decode MFU is a sign you're reading the wrong meter, not that the GPU is broken."
  }
]
```
