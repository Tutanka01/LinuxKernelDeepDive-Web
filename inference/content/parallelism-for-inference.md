# Parallelism for Inference

> **Goal of this chapter:** understand why serious models are split across
> many GPUs, and how. You will learn the **interconnect hierarchy** that
> decides every choice, then the four ways to cut a model up — **tensor**,
> **pipeline**, **expert**, and **context** parallelism — what each one costs
> in communication, and which link it can survive on. After this chapter,
> "TP=8, PP=2, EP=64" stops being a config incantation and becomes a set of
> decisions you can make and defend.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="fabric,runner"></div>

Everything so far in this course has lived on one GPU — the
[roofline](#/gpu-mental-model), the [prefill/decode split](#/inference-arithmetic),
[paged KV cache](#/paged-kv-cache), [FlashAttention](#/flashattention). For a
7B or 13B model that is the whole story. Now the model gets bigger and the
single chip runs out — in **three different ways**, worth separating because
they demand different answers.

1. **The weights don't fit.** Llama-3-70B in BF16 is 70 billion parameters
   × 2 bytes = **140 GB**. An H100 has **80 GB** of HBM. The model does not
   fit on one GPU — not with room for a KV cache, not at all. It must span at
   least two.
2. **The weights fit, but the KV cache doesn't.** A 30B model fits in 80 GB
   with ~20 GB to spare — but [KV cache](#/paged-kv-cache) grows with
   concurrency, and at high request counts those 20 GB cap you at a handful of
   sequences. You want more GPUs just to hold more cache.
3. **It's all too slow.** Decode is [memory-bound](#/inference-arithmetic):
   each token reads *every weight* from HBM, so time per token ≈ weight bytes
   ÷ HBM bandwidth. Two GPUs, each reading half the weights, have twice the
   aggregate bandwidth — roughly twice the decode speed. Sometimes you split a
   model that *fits*, purely for speed.

Fit, cache, speed — three problems, answered by different strategies below.
But none of them make sense until you understand the wires between the GPUs,
because the wires decide everything.

## The interconnect hierarchy decides everything

The distributed course taught you that crossing a machine boundary changes the
physics of a system. The same is true here, one level down — except now the
"network" has three tiers, **orders of magnitude apart**.

```text
  Link              Where                    Bandwidth (per GPU)
  ────────────────  ───────────────────────  ───────────────────
  NVLink (Hopper)   GPU↔GPU inside one node   ~900 GB/s
  NVLink5 (B'well)  GPU↔GPU inside one node   ~1.8 TB/s
  InfiniBand/RoCE   node ↔ node               ~25–50 GB/s
  PCIe Gen4/5       host bus, GPU↔GPU no-NVL   ~32–64 GB/s
```

Read the gap. Inside a node, NVIDIA's **NVLink** — a dedicated GPU-to-GPU
fabric, not the PCIe bus — moves ~900 GB/s per GPU on Hopper, ~1.8 TB/s on
Blackwell. Cross a node boundary onto **InfiniBand** or **RoCE** (RDMA over
Ethernet — the same RDMA the distributed course met, GPU memory to GPU memory
without the CPU) and you drop to ~25–50 GB/s: a **cliff of roughly 20–40×**.
And **PCIe**, the bus a GPU sits on when there's no NVLink between two cards,
is no better — ~32–64 GB/s.

So the single most important fact about multi-GPU serving is this: **there is
a fast island (the NVLink domain, typically 8 GPUs in a node) surrounded by a
slow sea.** Every parallelism strategy is a decision about *which communication
pattern you run across which link*. Chatty patterns must stay on the island;
only frugal ones may cross the sea.

![Two nodes, each an eight-GPU NVLink island at about 900 GB/s per GPU, joined by an InfiniBand or RoCE link at about 50 GB/s per node — a 20 to 40 times bandwidth cliff at the node boundary](assets/diagrams/interconnect-islands.svg)

> [!bridge] You already know this — from the Linux course
> NUMA taught you that "memory" is not one uniform resource: a core reaching
> across a socket boundary pays a real penalty, so you pin threads and allocate
> on the local node. This is the same locality reasoning with the penalty turned
> up two orders of magnitude — remote NUMA costs you perhaps 1.5–2× on latency,
> while leaving the NVLink island costs 20–40× on bandwidth. Pinning a process
> to its node is optional tuning; keeping a TP group on one island is not.
> [→ Linux: NUMA Deep Dive](../#/numa-deep-dive)

Hold that map. Now the four strategies.

## Tensor parallelism: shard every matrix, pay twice a layer

**Tensor parallelism (TP)** cuts *inside* each layer. Take a weight matrix —
say the big [MLP](#/what-is-inference) matrix — and slice it into `N` vertical
strips, one per GPU. Each GPU multiplies the input by its strip and produces a
*partial* result: a piece of the true output. To get the real output, you add
the pieces back together across all `N` GPUs — a **collective operation** called
an **all-reduce**.

Here is an all-reduce in one paragraph, because the distributed course taught
you gossip and quorums but not collectives. In gossip, one node sends one
message to one peer. An all-reduce is different: **every** GPU starts with a
partial array, and when it finishes, **every** GPU holds the element-wise
*sum* of all of them. It is one group-wide move — nobody proceeds until
everybody's contribution is folded in, so it is only as fast as the slowest
link between any two members.

> [!bridge] You already know this — from the Distributed Systems course
> "Only as fast as the slowest member" is the straggler shape you met when a
> fan-out read had to wait on its slowest replica, and it's why tail latency,
> not the mean, is the number that matters. The difference is the time scale and
> the frequency: there you tolerated a slow participant on one request, here the
> barrier fires twice per layer, 160 times per token, so even a small per-member
> skew compounds into a visible share of latency.
> [→ Distributed: The Network Is Hostile](../distributed/#/the-network-is-hostile)

A transformer layer has two such recombination points — one after attention,
one after the MLP — so **TP costs two all-reduces per layer, every layer, every
token.** An 80-layer model burns 160 all-reduces to produce a single decode
token. That is relentless, and it is why TP's home matters so much.

The cost math is stark. Even on NVLink, those all-reduces measure at **~20–30%
of end-to-end latency**. Push the same TP group onto PCIe or across nodes and
the share climbs toward **half** — you've spent your GPUs making the model
*slower*. Hence the iron rule of TP:

> **Keep tensor parallelism inside a single NVLink domain.** TP across nodes,
> over InfiniBand, is almost always a mistake for decode. The chatty pattern
> must stay on the fast island.

**Worked example.** Llama-3-70B, 140 GB of weights, split TP=2:

- **Two H100s in one node, NVLink.** Each GPU holds 70 GB of weights — it
  *fits*, with room for KV cache. Aggregate HBM bandwidth doubles to ~6.7
  TB/s, so decode (memory-bound) runs ~2× faster. The two all-reduces per
  layer ride the ~900 GB/s NVLink and cost ~20–30%. Net: a large win. This
  is the standard way to serve a 70B.
- **Two H100s with no NVLink between them (PCIe or across machines).** Same
  weights, same split — but now every one of those 160 all-reduces per token
  crawls across a ~40 GB/s link. Communication balloons toward half the
  latency; you have built a slower 70B than a well-chosen quantized one on a
  single GPU. A disaster, and a common one.

Identical strategy, identical model. The *only* difference is the wire — and
the wire decides win or disaster.

### The tradeoff the blogs miss: TP is also a memory decision

Everyone frames TP as a latency knob. It is also a **capacity** knob, and this
is the subtle part. The more ways you shard the weights, the **thinner each
GPU's slice of weights becomes** — and the more HBM is left over on each GPU
for KV cache.

Concretely: 70B at TP=2 puts 70 GB of weights on each 80 GB card, leaving ~10
GB for cache; at TP=4, only 35 GB per card, leaving ~45 GB — **more than four
times the KV headroom per GPU.** More headroom means more concurrent sequences
([continuous batching](#/continuous-batching) has more room to fill) and a
bigger [prefix cache](#/paged-kv-cache), often the dominant cost lever in the
agentic era. So raising TP buys faster decode *and* more cache at once — at the
price of more all-reduce traffic and more GPUs per replica. **TP is a latency
and a memory decision in one number.** Judge it on both.

## Pipeline parallelism: layers in stages, cheap wire, decode bubbles

**Pipeline parallelism (PP)** cuts the *other* way: not inside layers, but
*across* them. Put layers 1–40 on GPU A and layers 41–80 on GPU B. A token's
activations flow through A, then get handed to B, then out. The hand-off is a
single small **point-to-point** transfer — one activation vector to one
neighbor — not an all-reduce. That is **cheap**, kilobytes not megabytes, and
crucially it **survives a slow link.** Pipeline parallelism is the one you run
*across* nodes, over InfiniBand, precisely because its communication is
frugal enough to cross the sea.

![Side-by-side collectives: an all-reduce where four GPUs each end holding the same summed megabyte-scale tensor twice per layer, versus a point-to-point handoff where one GPU passes a kilobyte-scale activation vector to a single neighbor at each stage boundary](assets/diagrams/collectives.svg)

The catch is the **bubble**. A pipeline is only efficient when full — stage A
on token *n+1* while stage B works on token *n*. But
[decode emits one token at a time](#/inference-arithmetic), and token *n+1*
cannot start until token *n* is sampled. So in single-stream decode, GPU A
computes while GPU B waits, then they swap — each idle half the time. That
idle is the **pipeline bubble**, and it is why PP is a poor fit for
latency-sensitive decode. (Large batches hide it somewhat by feeding each
stage *different* requests, but the tension is real.)

So PP earns its place in one situation: **fitting a giant model across cheap
interconnects** — spanning nodes when a single NVLink island isn't enough
GPUs. Frequently you *combine* the two: TP inside each node (on NVLink), PP
across nodes (on InfiniBand) — each strategy on the link it can afford.

## Expert parallelism: the defining pattern of modern serving

A quick flag, because it owns the [next chapter](#/moe-serving). A
**Mixture-of-Experts (MoE)** model replaces the single MLP with many
**experts** and routes each token to only a couple of them. **Expert
parallelism (EP)** scatters those experts across GPUs and routes each token to
wherever its chosen experts live. That routing is an **all-to-all** collective:
every GPU sends its tokens to (potentially) every other GPU, then gathers the
results back — even chattier than an all-reduce. It is **the** defining
parallelism of 2026-era frontier serving, and how a 671B model is served at
all. Mechanics, load-balancing, and why rack-scale NVLink changed the game are
the whole of [Serving MoE at Scale](#/moe-serving). For now: know it rides
all-to-all, and hold the question for next chapter.

## Context parallelism: sharding the sequence for the million-token prefill

The three above shard the *model*. **Context parallelism (CP)** shards the
*sequence*. When a prefill is enormous — a 1-million-token document — no single
GPU can hold that prompt's activations and KV at once, so CP splits the
**sequence** across GPUs: rank 0 takes tokens 1–8k, rank 1 takes 8k–16k, and
so on.

But attention needs every query to see every *key* — including keys on other
ranks. The trick is **ring attention**: arrange the GPUs in a ring and pass KV
blocks around it, neighbor to neighbor, so that over one full lap every rank
sees every other rank's keys. The passing is point-to-point and overlaps with
compute, so it tolerates being spread wide.

The payoff is real: Meta reported a **1-million-token Llama3-405B prefill in
77 seconds on 128 H100s, at 93% efficiency**
([Meta Engineering, 2025](https://engineering.fb.com/2025/10/17/ai-research/scaling-llm-inference-innovations-tensor-parallelism-context-parallelism-expert-parallelism/)).
CP is a **prefill** technique — that's where the giant sequence lives. Decode
appends one token at a time, has no long sequence to shard, and stays on TP
(and EP). The frontier recipe is **CP for prefill, TP+EP for decode**, the two
phases often split onto separate GPU pools — a foreshadow of
[disaggregated serving](#/disaggregation) two chapters out.

## Why inference parallelism isn't training parallelism

If you've read about GPUs before, it was probably in a *training* context —
data parallelism, ZeRO, FSDP. Serving is a different world, and the inversion
is this: **training is throughput-bound and forgiving; decode is latency-bound
and unforgiving.**

- Training pushes huge batches in lockstep, so it can *overlap* communication
  behind a mountain of compute and tolerate pipeline bubbles — it cares only
  about aggregate tokens-per-second, not any one token. Decode has skinny
  [GEMMs](#/inference-arithmetic) one token wide, almost no compute to hide
  communication behind, and a human waiting on every token. A bubble that
  vanishes in training is a visible stall in decode.
- Training synchronizes **gradients** every step — that's what data
  parallelism's all-reduce is *for*. Serving has **no gradients**: weights are
  frozen, read-only replicas. No ZeRO, no FSDP, no optimizer state to shard.
  The only things that move are activations (PP), partial sums (TP), and
  tokens (EP).

So don't import training intuitions — the tolerances and the very things being
communicated are different.

## Putting it together: serving Llama-70B on 4×H100

You are serving Llama-3-70B for a chat product. You have one node: **4×H100,
all on NVLink**. Walk the decision.

- **TP=4, one node.** Weights: 140 GB ÷ 4 = **35 GB per GPU**, leaving ~45 GB
  each for KV cache — plenty of concurrency and a fat prefix cache. All four
  GPUs are on NVLink, so the two all-reduces per layer stay on the fast island
  at ~20–30%, and aggregate bandwidth is ~4× a single card. **This is the
  answer** — it solves all three problems at once: fit, cache, speed.
- **Why not TP=8 across 2 nodes?** Reaching 8 crosses a node boundary, so
  TP's all-reduces would ride ~50 GB/s InfiniBand instead of ~900 GB/s
  NVLink. Communication swamps the gain; decode gets *slower* despite doubling
  the GPUs. The iron rule forbids it.
- **Where would PP fit?** If the model needed, say, 16 GPUs across two nodes,
  you'd run **TP=8 inside each node** (NVLink) and **PP=2 across the nodes**
  (InfiniBand, cheap point-to-point) — each pattern matched to its link.

That is the craft: read which of the three problems you have, then match the
communication pattern to the wire you can afford.

And for a **671B MoE** — the frontier of mid-2026 — none of this is enough.
The weights dwarf a node, the experts must scatter across dozens of GPUs, and
the all-to-all becomes the whole ballgame. That is
[Serving MoE at Scale](#/moe-serving), next.

## What to remember

- One GPU runs out in **three distinct ways** — weights don't fit, KV cache
  doesn't fit, or decode is too slow — and they call for different answers.
- **The interconnect hierarchy decides everything.** NVLink inside a node
  (~900 GB/s Hopper, 1.8 TB/s Blackwell) is a fast island; InfiniBand/RoCE
  between nodes and PCIe (~25–64 GB/s) are a slow sea 20–40× narrower. Match
  each parallelism pattern to the link it can survive.
- **Tensor parallelism** shards every matrix, costs **two all-reduces per
  layer**, and must stay **inside an NVLink domain** — ~20–30% latency there,
  disastrous on PCIe/IB. It's also a memory knob: higher TP = thinner weight
  slices = more HBM for KV cache and prefix reuse.
- **Pipeline parallelism** stages layers, uses tiny point-to-point transfers
  that cross nodes cheaply, but suffers **decode bubbles** — use it to fit
  giant models over cheap links, often combined with TP inside each node.
- **Expert parallelism** (all-to-all, next chapter) is the defining pattern of
  frontier serving; **context parallelism / ring attention** shards the
  *sequence* for million-token prefills (Meta: 1M tokens in 77 s on 128
  H100s).
- Serving parallelism ≠ training parallelism: decode is latency-bound with
  skinny GEMMs and **no gradients** — weights are read-only replicas (no
  ZeRO/FSDP), and bubbles that hide in training are visible stalls here.

## Frequently asked

<div class="faq">

<details>
<summary>Can I set TP to any number, or does it have to divide something?</summary>

It has to divide the model's attention heads, and in practice that means powers
of two. TP shards the head dimension, so TP=6 on a 64-head model leaves ranks
with unequal head counts and most engines will simply refuse to load it. The
tighter constraint is GQA: if a model has 8 key/value heads, TP=16 means some
ranks hold no KV heads at all and must either replicate them or fall back — check
`num_key_value_heads`, not `num_attention_heads`, before promising a TP degree.

</details>

<details>
<summary>If the model fits on two GPUs, is TP=8 still worth it?</summary>

Sometimes, and the deciding question is whether you are selling latency or
throughput. TP=8 gives you roughly 4× the aggregate bandwidth of TP=2, so decode
gets faster per token and each GPU has far more KV headroom — good if you are
chasing p99 TPOT. But the all-reduce cost is paid per layer regardless of how
little work each rank does, so tokens-per-second *per GPU* falls; you are buying
latency with hardware efficiency. For a batch-throughput workload, running four
independent TP=2 replicas usually beats one TP=8 replica.

</details>

<details>
<summary>How do I confirm my GPUs are actually on NVLink and not just PCIe?</summary>

Run `nvidia-smi topo -m`. The matrix labels each GPU pair: `NV#` means NVLink
with that many links, `PIX`/`PXB` means they share a PCIe switch, `SYS` means the
traffic crosses the host bridge — the worst case. This matters more than it
sounds, because cloud instances of the same nominal type can differ, and a TP=8
group that silently spans two PCIe-connected quads is exactly the disaster in the
worked example above. Check it once per instance type and record it.

</details>

</div>

```quiz
[
  {
    "q": "Why is tensor parallelism kept inside a single NVLink domain rather than spread across nodes?",
    "choices": [
      "Because InfiniBand cannot transmit floating-point data",
      "Because TP requires two all-reduces per layer per token, and on a slow inter-node link those collectives balloon toward half of end-to-end latency, making decode slower despite more GPUs",
      "Because NVLink is the only link that supports RDMA",
      "Because tensor cores only function within one node"
    ],
    "answer": 1,
    "explain": "TP's all-reduce after both attention and MLP fires every layer, every token — a relentless, chatty pattern. On NVLink (~900 GB/s) it costs ~20–30% of latency; over IB or PCIe (~25–64 GB/s, 20–40× slower) it climbs toward half, and you've built a slower model. The chatty collective must stay on the fast island."
  },
  {
    "q": "Besides latency, what does raising the tensor-parallel degree from TP=2 to TP=4 on a 70B model change?",
    "choices": [
      "Nothing else — TP is purely a latency knob",
      "It thins each GPU's weight slice (35 GB vs 70 GB per card), freeing far more HBM for KV cache — more concurrency and a bigger prefix cache",
      "It increases the number of gradients that must be synchronized",
      "It reduces total HBM bandwidth because fewer bytes are read"
    ],
    "answer": 1,
    "explain": "Sharding weights across more GPUs makes each slice smaller, so more HBM is left over per card for KV cache. At TP=4 a 70B leaves ~45 GB/card for cache versus ~10 GB at TP=2 — over 4× the concurrency and prefix-cache headroom. TP is a memory decision as much as a latency one."
  },
  {
    "q": "Why does pipeline parallelism tolerate a slow inter-node link where tensor parallelism does not?",
    "choices": [
      "Pipeline parallelism doesn't communicate at all between stages",
      "Its hand-off between stages is a single small point-to-point activation transfer, not a group-wide all-reduce — frugal enough to cross the slow sea",
      "Pipeline parallelism runs entirely on one GPU",
      "It compresses activations to eliminate all network cost"
    ],
    "answer": 1,
    "explain": "PP cuts across layers, so a stage boundary passes one activation vector to one neighbor — kilobytes, point-to-point. That frugal pattern survives ~50 GB/s InfiniBand, which is why PP is the cross-node strategy. Its price is the decode bubble, not communication volume."
  },
  {
    "q": "What is the pipeline 'bubble' that makes pipeline parallelism a poor fit for single-stream decode?",
    "choices": [
      "A memory leak in the KV cache across stages",
      "Idle time: decode emits one token at a time, so while an early stage computes, later stages sit waiting — and token n+1 can't start until token n is sampled, leaving GPUs idle much of the time",
      "The all-to-all collective saturating the network",
      "A rounding error that accumulates across pipeline stages"
    ],
    "answer": 1,
    "explain": "A pipeline is only efficient when full — every stage busy on a different token. But decode is sequential: token n+1 depends on token n, so a single stream can't keep all stages fed, and each GPU idles waiting its turn. That idle time is the bubble. Large batches hide it partly; single-stream latency exposes it."
  },
  {
    "q": "Context parallelism (ring attention) is applied to which phase, and what does it shard?",
    "choices": [
      "Decode; it shards the model weights across GPUs",
      "Prefill; it shards the sequence across GPUs and passes KV blocks around a ring so every rank sees all keys",
      "Both phases equally; it shards the KV cache by layer",
      "Decode; it shards the vocabulary across GPUs"
    ],
    "answer": 1,
    "explain": "CP targets the giant prefill, where a million-token sequence won't fit on one GPU. It splits the sequence across ranks and rings KV blocks between neighbors so every query eventually sees every key. Decode appends one token at a time — no long sequence to shard — so it stays on TP/EP. Meta prefilled 1M tokens in 77 s on 128 H100s this way."
  }
]
```
