# Disaggregated Serving

> **Goal of this chapter:** understand why serious 2026 deployments stop running
> prefill and decode on the same GPUs, and be able to decide — with arithmetic,
> not vibes — whether your deployment is one of them. By the end you can derive
> what it costs to ship a KV cache between pools, compare that against both
> recomputing it and against the interference you were suffering, and name the
> four regimes where disaggregation is the wrong answer.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="router,scheduler,kv"></div>

Two chapters set up this one. [Inference Arithmetic](#/inference-arithmetic)
proved the field's founding asymmetry: **prefill is compute-bound** (it crunches
the whole prompt through dense matmuls) while **decode is memory-bound** (each
token is a skinny operation dominated by streaming weights and KV out of HBM).
[Continuous Batching](#/continuous-batching) gave you **chunked prefill** —
slicing a prompt into pieces so it shares a batch with decodes instead of
stalling them. That *tames* interference but does not remove it: every prefill
chunk you fold in still burns HBM bandwidth and SM cycles a decode token wanted.
On one GPU, prefill and decode are roommates fighting over the same sink.

This chapter is the radical alternative. **Give each phase its own GPU
pool** — its own count, its own parallelism, even its own hardware tier — so
prefill machines never steal a decode machine's bandwidth. The catch is the rest
of the chapter: the prefill pool computes a prompt's KV cache, but the *decode*
pool is the one that needs it. Somebody has to **ship the KV cache across the
network**, and whether that is a good trade is a question with a numerical
answer.

## Why the two phases want different machines

Go back to the roofline and read it as a shopping list. The ridge point on an
H100 is `990 TFLOP/s ÷ 3.35 TB/s ≈ 295 FLOP/byte`, and the two phases sit on
opposite sides of it.

**Prefill** runs at arithmetic intensity ≈ `T`, the prompt length — a thousand
tokens share every weight read, so it is comfortably compute-bound. What prefill
wants is FLOP/s: the newest silicon, low precision, large batches, aggressive
tensor parallelism to cut the latency of one big matmul. It does not much care
about memory bandwidth, because it is not bandwidth-limited. It does not need
much HBM capacity either — a prompt's KV is written once and handed off.

**Decode** runs at intensity ≈ `B`, the batch size, which in a latency-sensitive
service is nowhere near 295. What decode wants is bytes per second and bytes of
capacity: high HBM bandwidth so each token's weight sweep is fast, and enough HBM
to hold the KV caches of every concurrent sequence, because
[KV capacity is what caps concurrency](#/paged-kv-cache). Its FLOP/s go almost
entirely unused.

Now the observation that motivates everything: **a GPU that satisfies both is
paying for one of them twice.** Buy compute-dense silicon and its bandwidth idles
during decode; buy bandwidth-dense silicon and its FLOP/s idle during prefill.
Colocated serving buys both on every GPU in the fleet, and then has the two
phases fight over the result.

They also scale differently. Prefill work scales with *tokens in* — roughly
`2·P·T` FLOPs for a prompt of length T, a quantity you can shed by batching or
delay by queueing. Decode work scales with *tokens out × concurrency*, and it is
a hard real-time commitment: every live sequence needs a token every TPOT
milliseconds or your inter-token-latency SLO breaks. One is throughput work with
a deadline at the end; the other is a heartbeat. Sizing a single pool to satisfy
both means sizing for the worse of two unrelated curves.

## Disaggregation: the core trade

Splitting the phases is called **prefill/decode disaggregation** (PD
disaggregation). The picture:

```text
   COLOCATED (chunked prefill)          DISAGGREGATED (PD)
   ─────────────────────────            ──────────────────
   ┌───────────────────────┐            ┌──────────┐   KV    ┌──────────┐
   │  one GPU pool          │           │ PREFILL  │ ──────► │  DECODE  │
   │  prefill chunks +      │           │  pool    │  over   │  pool    │
   │  decode tokens share   │           │ (compute)│  RDMA   │ (memory) │
   │  every batch → they    │           └──────────┘         └──────────┘
   │  fight for bandwidth   │            few big-batch        many latency-
   └───────────────────────┘            GPUs, high TP         sensitive GPUs
```

Each pool is now free to be *itself*. Prefill wants throughput: large batches,
aggressive tensor parallelism, the newest compute-dense silicon. Decode wants
low, steady latency: modest batches, parallelism tuned for tokens-per-second,
enough GPUs that no single long request wrecks everyone's inter-token latency.
You already saw the production shape in [Serving MoE at Scale](#/moe-serving):
DeepSeek runs prefill as EP32 across 4 nodes and decode as EP144 across 18 —
two differently-shaped machines for two differently-shaped jobs, wired together.

> [!bridge] You already know this — from the distributed systems course
> This is the stateless-tier / stateful-tier split you have drawn before: one
> service cut in two so each half can be sized, scaled, and placed against its
> own bottleneck instead of a compromise between them. What differs is the
> state. It is not a database you replicate once and read many times — it is one
> request's KV cache, useful to exactly one consumer, and it has to arrive
> before that consumer's first token.
> [→ Distributed: Real-World Architectures](../distributed/#/real-world-architectures)

The foundational research made the case twice, from two angles:

- **DistServe** (OSDI 2024) optimized for **goodput** — not raw throughput,
  but *throughput that actually meets your latency SLOs* (a time-to-first-token
  target for prefill, an inter-token-latency target for decode). Its insight:
  once you stop forcing both phases through one pool, you can **provision each
  independently** to hit its own SLO — pick the prefill:decode GPU ratio,
  parallelism, and batch size that maximize served-within-SLO requests per
  dollar. That is *goodput-driven provisioning*, and it is the reason to
  disaggregate at all.
- **Splitwise** (Microsoft, ISCA 2024) leaned into **heterogeneous hardware**:
  put prefill on compute-rich GPUs and decode on cheaper, memory-rich ones,
  because each phase is bottlenecked on a *different* resource so paying for
  both on every GPU is waste. Combined, these lines of work reported 2–7×
  throughput at fixed latency.

### Goodput is the metric that makes this legible

It is worth dwelling on why DistServe framed the problem around goodput rather
than throughput, because the choice of metric is what makes disaggregation look
like a win at all.

Raw throughput rewards the wrong behavior. You can maximize tokens per second on
a colocated pool by batching aggressively and letting TTFT drift to several
seconds — a configuration that posts an excellent number and violates every
latency promise you made. **Goodput counts only the requests that met their
SLO**, which means a request served late contributes nothing, exactly as it
contributes nothing to a user.

Under that metric, the colocated pool's real problem becomes visible: it is a
**single knob controlling two SLOs that pull in opposite directions**. Turning up
the prefill chunk size improves TTFT and degrades inter-token latency. Turning it
down does the reverse. There is one setting, and two constraints, and any traffic
mix that moves puts you on the wrong side of one of them.

Disaggregation's actual contribution is that it **turns one knob into two**. The
prefill pool is sized and tuned for its TTFT target; the decode pool for its ITL
target; and the prefill:decode ratio absorbs the traffic mix. That is the whole
argument, and note that it is an argument about *provisioning*, not about
efficiency — a disaggregated fleet does not do less work, it just stops being
forced to compromise.

## The transfer-cost math

Disaggregation is not free, and the price is one number: **the cost of moving
the KV.** Every request pays it. The decision is a comparison:

```text
  disaggregate when:   interference_saved  >  KV_size / link_bandwidth
```

Work the right-hand side with real numbers. A 70B model in fp16 (GQA, 8 KV
heads, 80 layers) holds **320 KiB of KV per token** — the same per-token math
you did for 8B in [PagedAttention](#/paged-kv-cache), scaled up. A 4,000-token
prompt therefore leaves behind ≈ **1.3 GB** of KV. Ship it over an
InfiniBand/RoCE RDMA link at ~50 GB/s:

```text
  1.3 GB ÷ 50 GB/s ≈ 26 ms
```

26 ms of one-time transfer, overlapped with work, to buy a decode pool that
never again hitches on this request's prefill — for interactive prompts, an
easy win. Now the *other* end of the regime: a 128K-token context on that same
70B model is ≈ **43 GB** of KV, and over a slow or oversubscribed fabric its
transfer can rival the decode time it was meant to protect. **Transfer cost
scales with prompt length; the benefit scales with how much interference you
were suffering.** When those cross, disaggregation stops paying.

> [!bridge] You already know this — from the distributed systems course
> Every distributed design eventually collapses to the same two questions: what
> does it cost to move these bytes, and what happens when the link is slower
> than you assumed. Same questions here. What differs is that the transfer sits
> on the critical path of a latency SLO you have already promised, so there is
> no retry budget and no eventual-consistency window to hide it in — a slow
> fabric shows up directly as time-to-first-token.
> [→ Distributed: The Network Is Hostile](../distributed/#/the-network-is-hostile)

### Against recomputation, and against colocation

Two comparisons hide inside that inequality, and conflating them is the most
common confusion about disaggregation. Do them separately.

**Transfer versus recompute.** If moving the KV were more expensive than making
it again, disaggregation would be dead on arrival — the decode pool could just
re-run the prefill locally. Check. Recomputing a 4,000-token prefill of a 70B
model costs `2 × 70e9 × 4,000 ≈ 5.6 × 10^14` FLOPs, i.e. 560 TFLOP. An H100 at a
realistic 40% prefill MFU delivers ~400 TFLOP/s, so:

```text
  recompute:  560 TFLOP ÷ 400 TFLOP/s  ≈  1.4 s   (one GPU)
  transfer:   1.3 GB    ÷ 50 GB/s      ≈  26 ms
```

Transfer is roughly **50× cheaper than recomputation**, and it also does not
consume a prefill slot. At 128K the gap is similar in shape: ~18,400 TFLOP of
recompute against 0.86 s of transfer. **KV is expensive to make and cheap to
move.** That asymmetry is the load-bearing fact of this whole module, and it is
why the answer is a fabric rather than a policy of recomputing everywhere.

**Transfer versus colocation.** This is the comparison that actually decides
anything, and it is much less flattering. The alternative to shipping the KV is
not recomputing it — it is *never having moved it*, by running decode on the same
GPU that did the prefill. Against that baseline, the transfer is pure added cost,
and it only pays if the interference you escaped was worth more. So the real
question is never "is transfer cheap?" (it is) but "**was colocation actually
hurting me?**"

Which is why the fabric's speed is a first-order design input rather than a
detail. The same 1.3 GB transfer, on three different links:

```text
  NVLink 4, intra-node   900 GB/s  →   1.4 ms   (free, ignore it)
  InfiniBand NDR         ~50 GB/s  →    26 ms   (fine)
  25 GbE                 ~3.1 GB/s →   420 ms   (fatal)
```

That 20–40× cliff between NVLink and the inter-node network is the same cliff you
met in [Parallelism for Inference](#/parallelism-for-inference), and it has the
same consequence: **the topology decides the architecture.** A pool boundary that
sits inside an NVLink domain is nearly free to cross. One that sits across
commodity Ethernet is not a pool boundary you should have drawn. If your cluster
has no RDMA fabric, this chapter is describing a system you cannot build, and
that is a legitimate answer.

> [!bridge] You already know this — from the distributed systems course
> "Draw the boundary where crossing it is cheap" is the partitioning rule,
> restated in hardware: a shard boundary you cross on every request is not a
> boundary, it is a bottleneck. What differs is who picks it. In a database you
> choose the key and inherit the cost; here the fabric fixes the cost first, and
> the legal places to put a pool boundary are whatever survives it.
> [→ Distributed: Partitioning & Sharding](../distributed/#/partitioning)

## When it does not pay

> **Common trap:** "disaggregation is strictly better, always turn it on." It
> is a *regime*, not a religion. At **low load** there is little interference
> to eliminate, so you pay the transfer tax for nothing — plain colocation
> wins. And **reasoning models break the naive setup**: long chain-of-thought
> requests emit thousands of decode tokens per short prompt, so the workload is
> overwhelmingly decode-bound. A symmetric 1-prefill-1-decode split leaves the
> prefill GPUs *idle* most of the time. The fix is asymmetric ratios — **1P3D**,
> 1P4D — or, at low enough load, not disaggregating at all. Match the pool
> ratio to your actual prompt:generation shape, or you are buying idle silicon.

Four regimes where the answer is no, each for its own reason. Learn them as a
checklist, because they cover most deployments.

**1. Short contexts.** Prefill interference is proportional to prefill work, and
prefill work is `2·P·T`. A 512-token prompt on a 70B model is 72 TFLOP — under
200 ms of GPU time, sliced by chunked prefill into pieces that barely dent
anyone's ITL. There is nothing to escape. You would be building a distributed
system to avoid a problem you do not have.

**2. Small models.** Two effects compound. The KV per token is smaller but so is
everything else, and crucially the *granularity* gets wrong: an 8B model fits on
one GPU, so a disaggregated deployment's smallest unit is one prefill GPU plus
one decode GPU, and the ratio can only be tuned in whole machines. At that scale
the quantization error in your provisioning is larger than the win. Small models
also prefill fast enough that chunked prefill genuinely does absorb the
interference.

**3. Low load.** Interference requires contention, and contention requires
concurrency. A pool running at 20% occupancy has idle slots for prefill chunks;
they are not stealing bandwidth from anyone because nobody is asking for it. The
benefit term in the inequality goes to zero while the transfer cost stays fixed
per request, so the trade inverts. This is also the regime where a disaggregated
fleet's *fixed* costs bite: two pools mean two sets of weights resident, two
warm-up costs, and a floor of at least one GPU on each side even when traffic
would fit on half of one.

**4. A fabric too slow to carry the KV.** Covered above and worth repeating as a
hard gate: check `KV_size / link_bandwidth` against your TTFT budget *before*
anything else. If shipping a typical prompt's KV eats a meaningful fraction of
your time-to-first-token allowance, no amount of pool tuning will save it.

And a fifth, which is really the reasoning-model case generalized: **whenever the
prompt:generation ratio is extreme in either direction**, the symmetric split
wastes silicon. Decode-heavy traffic (long chain-of-thought, agentic loops)
starves the prefill pool; prefill-heavy traffic (classification, embedding,
document scoring with short outputs) starves the decode pool. The fix is the
asymmetric ratio, and the ratio is a function of *your* traffic that must be
measured, not inherited from a paper.

The honest summary is that disaggregation is a **high-load, long-context,
large-model, fast-fabric** technique. That describes a frontier-scale serving
fleet very well and most deployments not at all. If you are running one model on
eight GPUs behind moderate traffic, the correct answer is chunked prefill and a
good scheduler, and this chapter is background reading rather than a plan.

## What comes next

Say yes to disaggregation, and you have made a decision with a consequence larger
than the one you were considering. The KV cache is no longer a buffer inside a
GPU; it is **a piece of state that travels**. The moment that is true, every
distributed-systems question arrives at once: where does it live, who holds a
copy, how is it found, what happens when it is evicted, and which machine should
a request go to given where its bytes already are.

That is [The KV Fabric](#/the-kv-fabric) — Mooncake's fleet-wide pool, NVIDIA
Dynamo and NIXL, the memory hierarchy rebuilt across machines, and the routing
and autoscaling rules that fall out of it. This chapter decided whether to move
the KV. The next one is about everything that happens because you did.

## What to remember

- **The two phases want different machines.** Prefill is compute-bound (intensity
  ≈ T): it wants FLOP/s, big batches, new silicon. Decode is memory-bound
  (intensity ≈ B): it wants HBM bandwidth and HBM capacity. A GPU that serves
  both is paying for one of them twice, and they scale on unrelated curves —
  tokens-in versus tokens-out × concurrency.
- **PD disaggregation** gives each phase its own pool, count, parallelism, and
  hardware tier, at the cost of **shipping KV** between them.
- **Goodput** — throughput counting only SLO-meeting requests — is the metric that
  makes the case. Colocation is one knob (chunk size) controlling two opposed
  SLOs; disaggregation turns it into two knobs plus a pool ratio. **DistServe** =
  goodput-driven independent provisioning; **Splitwise** = heterogeneous hardware
  per phase; together, 2–7× at fixed latency.
- **The decision is arithmetic:** disaggregate when interference saved >
  `KV_size / link_bandwidth`. A 4K-token 70B prompt is 1.3 GB → ~26 ms over
  50 GB/s RDMA; a 128K context is ~43 GB → ~0.9 s and can rival decode time.
- **Two different comparisons.** Transfer beats *recompute* by ~50× (26 ms vs
  ~1.4 s of prefill FLOPs) — KV is expensive to make and cheap to move. But the
  real baseline is *colocation*, against which transfer is pure added cost, so
  the question is always whether colocation was actually hurting you.
- **The fabric decides.** 1.3 GB is 1.4 ms on NVLink, 26 ms on InfiniBand NDR,
  420 ms on 25 GbE. The 20–40× intra-node/inter-node cliff sets where a pool
  boundary can legitimately go.
- **Four regimes where it does not pay:** short contexts (no interference to
  escape), small models (granularity too coarse), low load (no contention), and a
  slow fabric (transfer eats the TTFT budget). Plus extreme prompt:generation
  ratios, which want asymmetric pools (**1P3D**, 1P4D) rather than a 1:1 split.
  A **regime, not a religion**.

## Frequently asked

<div class="faq">

<details>
<summary>If transfer is 50× cheaper than recomputing, why not always disaggregate?</summary>

Because recomputation is the wrong baseline. The alternative to shipping the KV
is not rebuilding it somewhere else — it is having run decode on the GPU that
already holds it, which costs nothing to "transfer" at all. Against colocation,
the transfer is pure overhead, and it only pays for itself if the prefill/decode
interference it removes was costing you more than the transfer costs. The
recompute comparison tells you *why a fabric exists* rather than *whether you
need one*.

</details>

<details>
<summary>Doesn't chunked prefill already solve the interference problem?</summary>

It manages it; it does not remove it. Chunked prefill slices a prompt so it rides
along in decode batches instead of blocking them, which converts a large stall
into many small ones — much better tail latency, same total bandwidth stolen.
Every chunk still consumes HBM traffic and SM cycles that a decode token wanted.
For most deployments that is a good enough answer, which is exactly why
disaggregation is a high-load technique rather than a default.

</details>

<details>
<summary>How do I actually pick the prefill:decode pool ratio?</summary>

From your traffic, by measuring the two phases' GPU-seconds separately. Prefill
work per request is roughly `2·P·T_in` FLOPs divided by your achieved prefill
rate; decode work is `T_out` steps at your measured TPOT and batch size. The
ratio of those totals over a representative traffic sample is your starting pool
ratio, and then you tune it against goodput. Expect it to move: a product change
that lengthens outputs (turning on extended reasoning, say) can shift a workload
from 1P1D to 1P4D without a single line of serving code changing.

</details>

</div>

```quiz
[
  {
    "q": "Chunked prefill already shares a batch between prefill and decode. What does prefill/decode disaggregation do that chunked prefill does not?",
    "choices": [
      "It compresses the KV cache so it fits in less HBM",
      "It puts prefill and decode on separate GPU pools with independent parallelism and hardware, at the cost of transferring KV between them over the network",
      "It eliminates the KV cache entirely by recomputing attention each step",
      "It runs prefill and decode on the same GPU but in separate CUDA streams"
    ],
    "answer": 1,
    "explain": "Chunked prefill interleaves the phases on one pool, so every prefill chunk still steals bandwidth from decodes. Disaggregation gives each phase its own pool, count, parallelism, and hardware tier — which forces the prefill pool to ship each request's computed KV cache to the decode pool over RDMA."
  },
  {
    "q": "A 70B model in fp16 holds ~320 KiB of KV per token. Why is disaggregation an easy win for a 4,000-token prompt but questionable for a 128,000-token one?",
    "choices": [
      "Long prompts can't be tensor-parallelized",
      "The 4K KV is ~1.3 GB (ships in ~26 ms over RDMA), while the 128K KV is ~43 GB and its transfer time can rival the decode work it was meant to protect",
      "Decode is compute-bound for long prompts and memory-bound for short ones",
      "The KV cache for long prompts must be recomputed, not transferred"
    ],
    "answer": 1,
    "explain": "Transfer cost is KV_size / link_bandwidth, and KV size scales with prompt length. A 1.3 GB transfer over ~50 GB/s RDMA is ~26 ms — trivial next to the interference it removes. A 43 GB transfer is tens-to-hundreds of ms and, on a slow fabric, can approach the decode time itself, so the trade stops paying."
  },
  {
    "q": "Why does a naive 1-prefill-1-decode (1P1D) split waste GPUs on long chain-of-thought reasoning workloads?",
    "choices": [
      "Reasoning models have larger weights that don't fit on decode GPUs",
      "Long-CoT requests are decode-dominated (thousands of output tokens per short prompt), so a symmetric split leaves prefill GPUs mostly idle — asymmetric ratios like 1P3D or plain colocation fit better",
      "Reasoning models cannot use RDMA to transfer KV",
      "The KV cache for reasoning outputs cannot be paged"
    ],
    "answer": 1,
    "explain": "Disaggregation is a regime, not a religion. When generation vastly outweighs prompt length, the workload is overwhelmingly decode, so a 1:1 pool ratio starves the prefill pool. Matching the ratio to the real prompt:generation shape (1P3D, 1P4D) or colocating at low load recovers the wasted silicon."
  },
  {
    "q": "DistServe optimized for goodput rather than throughput. Why does that choice of metric matter for the disaggregation argument?",
    "choices": [
      "Goodput is easier to measure than throughput on production hardware",
      "Goodput counts only SLO-meeting requests, which exposes that a colocated pool has one knob (chunk size) trading TTFT against inter-token latency; disaggregation turns that into two independently provisioned pools plus a ratio",
      "Goodput ignores latency entirely, so disaggregated fleets score better on it",
      "Throughput cannot be measured when prefill and decode run on different machines"
    ],
    "answer": 1,
    "explain": "Raw throughput rewards batching until TTFT drifts into seconds — a great number and a broken promise. Goodput scores a late request as zero. Under that metric the colocated pool's structural problem is visible: one setting, two opposed SLOs. Disaggregation's contribution is provisioning freedom — each pool tuned to its own target — not doing less work."
  },
  {
    "q": "Shipping a 4K-token 70B prompt's KV (1.3 GB) takes ~26 ms over 50 GB/s RDMA, while recomputing that prefill costs ~560 TFLOP, or ~1.4 s on one H100 at 40% MFU. What does this comparison establish, and what does it not?",
    "choices": [
      "It establishes that disaggregation is always worth turning on",
      "It establishes that KV is expensive to make and cheap to move — justifying a transfer fabric over recompute-everywhere — but not that you should disaggregate, since the real baseline is colocation, against which transfer is pure added cost",
      "It establishes that recomputation should be preferred whenever the fabric is slower than 50 GB/s",
      "It establishes that prefill should always run on the decode pool"
    ],
    "answer": 1,
    "explain": "Two different comparisons live inside the decision. Transfer vs recompute is lopsided in transfer's favor (~50×), which is why the field built fabrics and tiering rather than recomputing on miss. Transfer vs colocation is the one that decides your deployment: colocation moves nothing, so the transfer only pays if the interference it escapes was worth more than 26 ms per request."
  }
]
```
