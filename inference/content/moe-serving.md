# Serving MoE at Scale

> **Goal of this chapter:** understand what a Mixture-of-Experts model
> actually is, why every frontier lab moved to one, and why serving it breaks
> the parallelism playbook from the last chapter. By the end you can explain
> why expert parallelism replaces tensor parallelism here, what an all-to-all
> costs, why one hot expert can stall a whole cluster — and you can read
> DeepSeek's disclosed production system as an open book.

A dense model does the same arithmetic for every token: run the whole network,
top to bottom, weight by weight. DeepSeek-V3 has **671 billion** parameters but
spends only **37 billion** of them on any given token. That is not a rounding
error or a quantization trick — it is the entire architectural bet of the last
two years of frontier models, and it rewrites the serving problem from the
ground up. This chapter is about that bet and the machine you have to build to
cash it.

## What a Mixture-of-Experts actually is

Recall the shape of a transformer layer: an **attention** block (tokens look at
each other) followed by an **MLP** — a multi-layer perceptron, just two big
matrix multiplies with a nonlinearity between them, applied to each token
independently. In a dense model that MLP is one fat pair of weight matrices,
and *every* token flows through *all* of it.

A Mixture-of-Experts (MoE) layer replaces that one fat MLP with **many small
ones** — call them **experts** — plus a tiny **router**. DeepSeek-V3 has 256
routed experts per layer. For each token, the router (a single small matrix
that scores the token against all 256 experts) picks the **top-k** highest
scorers — here **top-8** — and sends the token only to those. The token's
output is the weighted sum of what those 8 experts produced. The other 248
experts never run for that token. (Many designs, DeepSeek's included, also keep
one **shared expert** that every token always visits, to capture common
patterns; the routed experts specialize.)

```text
   DENSE MLP                     MoE LAYER (top-2 of 4 shown)
   ─────────                     ─────────────────────────────
   token ──► [ one big MLP ]     token ──► router picks 2 of 4
                │                            │      │
                ▼                         [E1] [E2] [E3] [E4]
             output                        ▲    ▲   (E3,E4 idle
                                           └──┬─┘    for this token)
                                              ▼
                                    weighted sum ──► output
```

The router is trained, not hand-coded: over training the experts differentiate,
and the router learns which tokens each is good at. For serving you can treat it
as a black box that emits, per token, a short list of expert IDs and weights.

## The two numbers that define the serving problem

Go back to the [Inference Arithmetic](#/inference-arithmetic) chapter's rule:
memory holds *parameters*, compute burns *FLOPs*, and for a transformer the FLOP
cost is about `2 × (params used) × tokens`. MoE drives a wedge between two
counts that are identical in a dense model:

- **Total parameters** — everything that must live in HBM, because any expert
  might be routed to on the next token. DeepSeek-V3: **671B**. In FP8 (one byte
  per weight) that is ~671 GB of high-bandwidth memory you must provision before
  you serve a single request.
- **Active parameters** — what actually runs for a given token. DeepSeek-V3:
  **37B**. Compute per token ≈ `2 × 37B ≈ 74 GFLOP`, the cost of a ~37B dense
  model.

That is the whole pitch, and why the labs went MoE: **frontier-class capability
at a fraction of the FLOPs.** You get the knowledge capacity of a 671B model
(the total) at the compute bill of a 37B one (the active). Cheaper to train,
cheaper per token to run.

But look at what it does to serving. A 37B dense model fits comfortably on one
or two GPUs. DeepSeek-V3 needs ~671 GB just for weights — eight or more
80 GB GPUs before you have reserved a byte for the KV cache. The
compute is that of a small model; the *memory footprint* is that of a giant one.
**Memory capacity, not compute, becomes the binding constraint** — and that
single fact is why MoE serving looks nothing like dense serving.

> **Common trap:** "671B total, 37B active — so I can serve it like a 37B
> model." You can *compute* like one, but you must still *store* like a 671B
> one. The weights don't fit on a 37B model's hardware, and getting all 256
> experts onto enough GPUs while keeping each one busy is the entire problem
> below.

## Why tensor parallelism dies and expert parallelism wins

Last chapter's default for a too-big model was **tensor parallelism (TP)**:
slice each weight matrix across N GPUs, and after each layer do an **all-reduce**
so every GPU ends up with the same summed activations. That works because dense
matrices are big — a thin slice of a big matrix is still a respectable GEMM (a
GEMM is a general matrix-multiply, the GPU's bread-and-butter operation).

Try it on 256 experts and it collapses. Each expert is already small. Slice each
expert's matrices across, say, 8 GPUs and you get 256 × 8 = 2048 tiny matrix
fragments, each doing a sliver of work on a handful of tokens. GPUs are
throughput machines that need fat GEMMs to earn their keep; feed them slivers
and they run at a few percent of peak. TP shards the wrong dimension.

**Expert parallelism (EP)** shards the *right* one. Instead of splitting every
expert across all GPUs, put **different whole experts on different GPUs**. With
256 experts over 32 GPUs, each GPU owns 8 experts, intact. Now the tokens routed
to those 8 experts — pooled from *every* sequence in the batch across the whole
cluster — arrive as a healthy pile, and each expert runs one efficient
[grouped-GEMM](#/kernels-and-compilation) over its share. Each GPU sees a
GEMM-friendly batch again. That is the win.

The price is movement. A token is processed on the GPU that holds its attention
and router — but its chosen experts live on *other* GPUs. So every MoE layer, for
every token, you must:

1. **Dispatch:** send each token to the GPUs holding its top-k experts.
2. (experts compute)
3. **Combine:** gather the expert outputs back to the token's home GPU.

This is a **two-shot all-to-all**, and it is worth pinning down how it differs
from the all-reduce you already know:

```text
   ALL-REDUCE (tensor parallelism)      ALL-TO-ALL (expert parallelism)
   every GPU ends with the SAME         every GPU sends a DIFFERENT slice
   summed tensor                        to every other GPU, and receives
                                        a different slice from each
   GPU0 ─┐                              GPU0 ──► split ──► to G1,G2,G3
   GPU1 ─┼─► sum ─► copy to all         GPU1 ──► split ──► to G0,G2,G3
   GPU2 ─┘                              (a full regrouping / transpose
                                         of tokens by destination expert)
```

An all-reduce is a *reduction* — one shared result. An all-to-all is a
*regrouping* — every GPU hands every other GPU a personalized packet, sorting
tokens by which expert they need. It is pure network shuffle, no math, and you
pay it **twice per layer** (dispatch + combine) across dozens of layers, on
every token. Measured cost: an all-to-all eats **10–30% of decode latency** on
current systems, and far more at large batch sizes. Hiding it behind compute is
the central engineering fight of MoE serving.

## The straggler problem: one hot expert stalls everyone

Routing is not uniform. Some experts are popular — a token distribution has
"hot" experts that get far more traffic than the average. If expert 12 receives
3× its fair share, the GPU hosting expert 12 has 3× the work, and because the
all-to-all is a **synchronization barrier** — the combine step cannot finish
until *every* expert has produced its outputs — that one overloaded GPU makes
the entire cluster wait. Every other GPU sits idle at the barrier.

You met this exact shape in the distributed-systems course: the **straggler
problem**, where the slowest participant sets the pace of a synchronous step.
Here it is again, in silicon. The two production countermeasures:

- **Redundant experts.** Replicate the hottest experts onto multiple GPUs so
  their load splits. DeepSeek runs **32 redundant experts** on top of the base
  256, placed to smooth the peaks.
- **EPLB (Expert-Parallel Load Balancer).** Routing statistics drift as traffic
  changes, so a balancer periodically recomputes which expert lives where —
  which to replicate, which to co-locate — and shuffles placement to keep every
  GPU's load even. It is the level-triggered reconciliation reflex applied to
  expert placement: measure the imbalance, nudge toward even, repeat.

## Case study: DeepSeek-V3/R1 in production

In February 2025, DeepSeek disclosed its actual serving stack in detail — the
[V3/R1 inference system overview](https://github.com/deepseek-ai/open-infra-index/blob/main/202502OpenSourceWeek/day_6_one_more_thing_deepseekV3R1_inference_system_overview.md).
It remains the canonical worked example of everything above, and it does one
more thing: it runs prefill and decode as **separate pods** with different
parallelism — a split this course covers next, in
[Disaggregated Serving](#/disaggregation). Here, just note the shapes.

| | Prefill pods | Decode pods |
|---|---|---|
| Scale | **EP32** — 4 nodes × 8 H800 | **EP144** — 18 nodes × 8 H800 |
| Experts per GPU | 9 routed + 1 shared | 2 routed + 1 shared |
| Overlap trick | dual-microbatch overlap | 5-stage pipeline |

The per-GPU expert counts are just the arithmetic of spreading 256 routed
experts plus 32 redundant copies (288 total) over the GPUs: 288 / 32 ≈ 9 in
prefill, 288 / 144 ≈ 2 in decode. Thinner spreading in decode gives each expert
its own GPU-worth of bandwidth, which is what latency-bound decode needs.

The **overlap** tricks are how they hide the all-to-all. In prefill, each batch
is split into **two microbatches** run in lockstep, so while microbatch A is in
the network doing its dispatch/combine, microbatch B is on the tensor cores
doing attention and expert GEMMs — the shuffle disappears behind compute. In
decode, a **5-stage pipeline** subdivides the attention computation so there is
always math to run while the network moves tokens.

The plumbing under all this is **[DeepEP](https://github.com/deepseek-ai/DeepEP)**,
DeepSeek's open-sourced all-to-all library. Three ideas worth knowing: it
**forwards intelligently between NVLink and RDMA** (fast intra-node links vs
the slower inter-node network), so a token hops onto the right fabric for its
destination; it offers **zero-SM overlap hooks** that drive the network without
stealing streaming-multiprocessor cycles from the GEMMs; and it **dispatches in
FP8**, halving the bytes on the wire versus BF16.

Now the payoff numbers, from a real 24-hour window (Feb 27–28, 2025):

- **608B input tokens**, of which **342B (56.3%) were served from the KV cache**
  — a preview of why cache hit rate dominates the economics (a whole theme of
  the [agentic era](#/agentic-serving) and [Hardware & Economics](#/hardware-and-economics)).
- Throughput: **~73.7k tokens/s per node in prefill**, **~14.8k tokens/s per
  node in decode** — the ~5× gap between the compute-bound and memory-bound
  phases in one measurement.
- Economics: **$87,072/day** in GPU cost against **$562,027/day** of theoretical
  revenue at R1 API prices — a **545% theoretical margin**. Read "theoretical"
  loudly: it assumes every token billed at peak rates, so the *realized* margin
  is far lower. The full teardown lives in [Hardware & Economics](#/hardware-and-economics).

## Wide-EP goes mainstream, and racks replace GPUs

DeepSeek's disclosure looked exotic in early 2025. By mid-2026 it is a pattern
the open stacks reproduce. LMSYS
[rebuilt DeepSeek-scale serving on 96×H100 in SGLang](https://www.lmsys.org/blog/2025-05-05-large-scale-ep/);
vLLM and llm-d ship **"Wide-EP"** as a supported mode. Serving a DeepSeek-class
model with large expert parallelism plus prefill/decode disaggregation is now
the standard recipe, not a lab stunt.

The hardware is bending to fit it. The all-to-all's worst enemy is
**cross-node** traffic — RDMA over InfiniBand is far slower than the NVLink mesh
inside a single server. NVIDIA's **GB200 / GB300 NVL72** answers with a rack
where **72 GPUs share one NVLink domain**: cross-node all-to-all becomes
*intra-fabric* traffic, and the expert-parallel shuffle that used to crawl over
IB now runs on a ~130 TB/s aggregate mesh. LMSYS measured
[**7,583 decode tokens/s/GPU** on GB200 for DeepSeek 671B](https://www.lmsys.org/blog/2025-06-16-gb200-part-1/) — about **2.7× an H100 node** — and
[**13k+ decode tok/s/GPU with FP8 attention and NVFP4 experts**](https://www.lmsys.org/blog/2025-09-25-gb200-part-2/).
This is why the industry now buys **racks, not GPUs**: for wide-EP MoE, the
interconnect *is* the product.

> **State of play (mid-2026):** wide-EP MoE serving is production-standard for
> DeepSeek-class models across DeepEP, SGLang, vLLM/llm-d, and TensorRT-LLM.
> Rack-scale NVLink (GB200/GB300 NVL72) is shipping and is the preferred
> substrate. Absolute tok/s/GPU figures move with every software release and
> every quantization change — treat the *ratios* (rack ≈ 2.7–4.8× prior-gen) as
> the durable signal, not the exact numbers.

> **Frontier — splitting attention from experts.** EP puts experts on their own
> GPUs; the next idea splits the *layer type* too. In an MoE, attention is
> **memory-bound** (streaming the KV cache) while the experts are
> **compute-bound** (dense GEMMs). Running both on the same GPU wastes one or the
> other. **Attention–FFN disaggregation (AFD)** gives attention and experts
> separate GPU pools sized to their own bottleneck.
> [MegaScale-Infer](https://arxiv.org/pdf/2504.02263) (ByteDance, SIGCOMM 2025)
> pipes tokens between the two pools in a "ping-pong" pipeline for a reported
> ~1.9× gain; StepFun's Step3 runs AFD in production. Early days, but it is the
> logical next cut — more in [The Frontier](#/frontier).

## What to remember

- **MoE replaces one dense MLP with many small experts + a router;** each token
  visits only its **top-k** (e.g. 8 of 256). This splits parameters into
  **total** (all of them, must be in HBM) and **active** (the few that run).
- DeepSeek-V3: **671B total, 37B active.** You compute like a 37B model but must
  *store* like a 671B one — so **memory capacity becomes the binding
  constraint**, and dense-serving intuitions stop applying.
- **Tensor parallelism dies** on MoE (slivering already-small experts gives
  terrible GEMMs); **expert parallelism wins** by placing whole experts on
  different GPUs so each sees a fat, pooled batch.
- The price is a **two-shot all-to-all** (dispatch + combine) every layer,
  every token — a *regrouping*, not the *reduction* of an all-reduce — costing
  **10–30% of decode latency** and hidden behind compute via microbatch/pipeline
  overlap.
- Skewed routing creates **hot experts** and a **straggler** at the all-to-all
  barrier; **redundant experts + EPLB** rebalance placement to keep every GPU
  busy.
- DeepSeek's disclosed system (prefill EP32, decode EP144, DeepEP, 545%
  theoretical margin) is the reference implementation; **wide-EP is now
  mainstream** and **rack-scale NVLink** exists to make its all-to-all local.

```quiz
[
  {
    "q": "DeepSeek-V3 is 671B total parameters but 37B active per token. What does each number govern for serving?",
    "choices": [
      "671B sets the compute per token; 37B sets the HBM you must provision",
      "37B sets both compute and memory, since inactive experts can be dropped",
      "671B sets the HBM you must provision; 37B sets the compute per token",
      "Both numbers are the same for capacity planning"
    ],
    "answer": 2,
    "explain": "Every expert might be routed to on the next token, so all 671B of weights must sit in HBM (~671 GB in FP8). But only the 37B active parameters run for a given token, so FLOPs ≈ 2 × 37B. You store like a giant model and compute like a small one — which is exactly why memory capacity, not compute, becomes the binding constraint."
  },
  {
    "q": "Why is tensor parallelism a poor fit for a 256-expert MoE layer, while expert parallelism works?",
    "choices": [
      "TP requires an all-reduce, which is illegal across experts",
      "TP slices each already-small expert into tiny matrix fragments that run GPUs far below peak; EP places whole experts on separate GPUs so each sees a GEMM-efficient pooled batch",
      "EP uses less total memory than TP",
      "TP cannot run on more than 8 GPUs"
    ],
    "answer": 1,
    "explain": "GPUs need fat GEMMs to hit peak throughput. Slicing 256 already-small experts across many GPUs produces thousands of slivers, each doing trivial work. EP keeps each expert intact on one GPU, and the tokens routed to it — pooled from the whole cluster's batch — arrive as a healthy pile for one efficient grouped-GEMM."
  },
  {
    "q": "How does the all-to-all in expert parallelism differ from the all-reduce in tensor parallelism?",
    "choices": [
      "All-to-all is a reduction producing one shared tensor; all-reduce is a regrouping",
      "They are the same operation with different names",
      "All-to-all is a regrouping where every GPU sends a different personalized slice to every other GPU; all-reduce sums a tensor so every GPU ends with the same copy",
      "All-to-all runs only once per model; all-reduce runs every layer"
    ],
    "answer": 2,
    "explain": "An all-reduce is a reduction: combine everyone's tensor and hand back one shared result. An all-to-all is a regrouping/transpose: each GPU sorts its tokens by destination expert and sends every other GPU a different packet. MoE pays it twice per layer (dispatch + combine) on every token — pure network shuffle, no math — costing 10–30% of decode latency."
  },
  {
    "q": "A single expert receives far more tokens than its peers. Why does this stall the whole cluster, and what fixes it?",
    "choices": [
      "It runs out of memory; fix by quantizing that expert",
      "The all-to-all combine is a synchronization barrier, so the overloaded GPU makes every other GPU wait — the straggler problem; fix with redundant (replicated) hot experts plus EPLB to rebalance placement",
      "The router crashes; fix by disabling top-k routing",
      "It corrupts the KV cache; fix by flushing the cache each step"
    ],
    "answer": 1,
    "explain": "The combine step cannot complete until every expert has produced its outputs, so the busiest GPU sets the pace and everyone idles at the barrier — the straggler problem from distributed systems. Production fixes replicate the hottest experts across GPUs (DeepSeek adds 32 redundant experts) and run an Expert-Parallel Load Balancer that periodically recomputes placement as routing statistics drift."
  },
  {
    "q": "Why does the industry increasingly buy rack-scale systems like the GB200 NVL72 for MoE serving?",
    "choices": [
      "Racks are cheaper per GPU than individual servers",
      "A 72-GPU single NVLink domain turns cross-node all-to-all traffic into fast intra-fabric traffic, directly attacking the interconnect bottleneck that dominates wide-EP",
      "Racks let you run tensor parallelism instead of expert parallelism",
      "They eliminate the need for a KV cache"
    ],
    "answer": 1,
    "explain": "The all-to-all's worst enemy is cross-node traffic over relatively slow InfiniBand. Putting 72 GPUs on one ~130 TB/s NVLink mesh makes the expert-parallel shuffle a local operation, which is why measured rack-scale throughput runs ~2.7–4.8× prior-generation nodes. For wide-EP MoE, the interconnect is effectively the product."
  }
]
```
