# Choosing: Model, GPU, Framework

> **Goal of this chapter:** make the four decisions that precede every
> deployment — where to run it, on what silicon, with which engine, and whether
> to run it at all — using physics you already have rather than a vendor deck.
> By the end you can defend each choice with a number, and you can name the
> exact utilisation at which self-hosting starts to beat an API.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,fabric"></div>

Every recommendation in this chapter is derived from something earlier in the
course. That constraint is the point. The alternative — choosing by benchmark
screenshot, by what a colleague used, by which vendor sponsored the conference
talk — produces decisions that cannot be re-examined when the numbers change,
and in this field the numbers change every quarter.

## Deployment shape: what physics you are buying out of

The first decision is not which GPU. It is whether you touch a GPU at all.
There are five shapes, and they differ on four axes: **utilisation** (can you
keep the silicon busy?), **latency floor** (how fast can a token possibly
arrive?), **data residency** (whose machine holds the bytes?), and **prefix
cache amortisation** (can your traffic reuse its own KV?).

**Token APIs (serverless).** You pay per token; someone else owns everything.
What you buy out of is the entire utilisation problem — the hardest problem in
this business, per [Hardware & Economics](#/hardware-and-economics) — because
the provider blends your spiky traffic with thousands of other tenants' and
runs the fleet at a utilisation you could never reach alone. You also buy out
of cold starts, capacity planning, and model upgrades. What you give up: the
latency floor is theirs, the model list is theirs, and your data leaves your
boundary.

**Managed / dedicated endpoints.** A named model on reserved capacity, billed
by the hour. You reclaim the latency floor and the ability to pin a model
version; you take back the utilisation problem, because reserved capacity is
yours whether it is busy or not.

**BYOC (bring your own cloud).** The vendor's control plane, your VPC, your
GPU quota. This exists almost entirely for **data residency** — the bytes never
leave your account — and it costs you the vendor's operational leverage,
because now their on-call cannot see your machines.

**Self-hosted on rented GPUs.** vLLM or SGLang on instances you rent. You own
the whole stack: model choice, quantization, chunk size, prefix cache policy,
routing. This is the shape the rest of this course is about, and it is the only
one where the levers in [Sizing a Deployment](#/sizing-a-deployment) are yours
to pull.

**On-prem.** Capital instead of rent. It wins only when utilisation is high and
sustained — you have converted a variable cost into a fixed one, so an idle
GPU is now unambiguously a loss — and when power and cooling are things you
can actually supply. A GB300 NVL72 draws 120–140 kW into one rack; most
buildings cannot.

### The line that decides it for agents

Here is the consequence people miss, and it follows directly from
[PagedAttention](#/paged-kv-cache).

A serverless token endpoint **cannot hold your KV cache warm between calls in
any way you control**. The provider may offer prompt caching, and increasingly
does; but the residency policy, the TTL, the eviction order, and the routing
that decides whether your next call even lands on the replica holding your
blocks are all theirs. You are a tenant in someone else's block pool.

For a chat request that is fine. For an **agent loop** it is the whole
economics. [The Agentic Era](#/agentic-serving) showed agent traffic running at
input:output ratios as extreme as 267:1, with 85–95% of the work being prefill,
and cache hit rate moving a monthly bill by roughly 10×. An agent's thirtieth
tool call is 95% the same tokens as its twenty-ninth. If you own the fleet, you
own cache-aware routing and can send iteration N+1 to the replica holding
iterations 1..N. If you rent tokens, you get whatever hit rate the provider's
router happens to give you, and you find out about it in the invoice.

So the rule is not "serverless is bad." It is: **serverless is priced for
traffic whose KV has no reuse. The more your workload is one long conversation
with itself, the more the cache is the product, and the more you want to own
it.**

> [!bridge] You already know this — from the Linux course
> Being a tenant in a shared resource pool is the cgroup story: your share of
> memory and CPU is set by limits somebody else wrote, and a noisy neighbour is
> something you observe rather than fix. A token API is that arrangement one
> level up. The difference is which resource is being shared — here it is the
> *block pool*, and there is no `memory.min` equivalent to reserve you a
> guaranteed slice of someone else's prefix cache.
> [→ Linux: Control Groups (cgroup v2)](../#/cgroups)

## Choosing a GPU, in strict order

Four criteria, and the order is not negotiable, because each one only matters
if the previous one passed.

**1. Capacity.** Can the weights *plus a useful KV pool* fit? Not "do the
weights fit" — the previous chapter showed a 70B whose weights fit in 160 GB
and whose pool held one user. Compute `max_concurrency` before you look at any
other number. If it lands in single digits, nothing else about the chip matters.

**2. Bandwidth.** Decode latency is bytes ÷ bandwidth and nothing else, so
**HBM GB/s is your tokens per second**. Between two chips that both pass the
capacity test, the faster-memory one is faster at decode by exactly the
bandwidth ratio. FLOPs do not appear in this sentence.

**3. FLOPs.** These matter for **prefill**, which is compute-bound, and for
**decode past `B_crit`**, where you have finally batched your way over the
ridge. Prefill-heavy traffic — RAG, classification, agent loops — is genuinely
FLOP-sensitive. Chat with short prompts and long answers is not.

**4. Interconnect.** This decides whether tensor parallelism is available to
you at all. Two all-reduces per layer per token cost 20–30% of end-to-end
latency on ~900 GB/s NVLink and swamp the gain entirely on PCIe or across
nodes. A chip with no NVLink is a chip you cannot usefully split a large model
across.

> [!bridge] You already know this — from the Linux course
> NUMA is the same shape of problem: memory that is nominally one address space
> but is 1.5–2× slower and much narrower across the socket boundary, so
> placement stops being an implementation detail and becomes an architectural
> constraint. Here the cliff is far steeper — 900 GB/s inside an NVLink domain
> against ~50 GB/s between nodes — and it is crossed on a schedule you set,
> because a tensor-parallel group that spans the boundary pays for it twice per
> layer, per token.
> [→ Linux: NUMA Deep Dive](../#/numa-deep-dive)

Ridge points below are `dense BF16 FLOP/s ÷ HBM byte/s`, computed from the two
columns to their left.

| GPU | HBM | Bandwidth | Dense BF16 | Ridge | Fabric | What it is actually for |
|---|---|---|---|---|---|---|
| **H100 SXM** | 80 GB | 3.35 TB/s | 990 TF | 295 | NVLink 4, 900 GB/s, 8-GPU domain | The workhorse. Everything in this course is calibrated to it. |
| **H200** | 141 GB | 4.8 TB/s | 990 TF | **206** | NVLink 4, 900 GB/s | Same compute, 1.43× bandwidth, 1.76× capacity. Strictly better for decode; the honest upgrade from H100. |
| **B200** | 192 GB | 8 TB/s | ~2,250 TF | 281 | NVLink 5, 1.8 TB/s, up to 72-GPU domain | Frontier. Its moat is composing FP4 + wide-EP + disaggregation in one domain, not the FLOPs. |
| **A100 80GB** | 80 GB | 2.0 TB/s | 312 TF | 156 | NVLink 3, 600 GB/s | Cheap capacity. **No FP8 tensor cores** — you can store FP8 but not compute in it. |
| **L40S** | 48 GB | 0.86 TB/s | 362 TF | **421** | PCIe only | Prefill-heavy work and models under ~20B. A trap for 70B decode. |

**The L40S trap, quantitatively.** It has 37% *more* dense BF16 FLOPs than an
A100 and **43% of its bandwidth**. Its ridge is 421 — the highest on the table
— which literally means you would need 421 concurrent sequences before its
compute became the limit. For decode, which is bandwidth-bound, an L40S serves
tokens at roughly a quarter the rate of an H100. And 48 GB with no NVLink means
a 70B needs four of them over PCIe, where the all-reduces destroy what is left.
It is an excellent card for prefill-heavy small-model serving and a
poor-to-terrible one for large-model decode. **Good FLOPs plus poor bandwidth is
the most common way to buy the wrong GPU**, because FLOPs are the number on the
box.

Criterion 1 is the one you can settle before you talk to anyone. Put a model and
a candidate card from the table into the calculator and read `max_concurrency`
straight out; if it lands in single digits, the rest of that row is decoration.

<div class="inf-widget" data-widget="kv-calculator">
<p class="inf-widget-fallback">Interactive KV-cache and memory-fit calculator — needs JavaScript enabled.</p>
</div>

Two families deliberately off the table above. **TPUs** (Ironwood: 192 GB,
7.37 TB/s, native FP8, pods to 9,216 chips) are competitive-to-excellent silicon
that you can only rent inside one cloud, with a compiler-first software stack —
choose them for capacity and price when your model and framework already run
there, not as a drop-in. And the **SRAM dataflow class** (Groq, Cerebras,
SambaNova) from [Hardware & Economics](#/hardware-and-economics) buys
single-stream latency by skipping the HBM wall — ~3,000 tok/s where an H100 does
100–150 — at the cost of needing many chips to hold one model, so it wins the
latency-critical niche and loses throughput-per-dollar at batch.

## Choosing a framework

All four criteria below are downstream of things you already understand from
[Anatomy of a Serving Engine](#/anatomy-of-an-engine). The comparison is a
**mid-2026 snapshot**; this space reorders itself every few months, so a dated
snapshot is honest and a timeless claim would be a lie.

| | **vLLM V1** | **SGLang** | **TensorRT-LLM** | **llama.cpp / Ollama** |
|---|---|---|---|---|
| Scheduler | Unified `{req: n_tokens}` token budget, two-process | Overlap scheduler (CPU prepares batch N+1 during N) | Engine-specific, tightly coupled to compiled plans | Simple; single-user oriented |
| Prefix cache | Hash of 16-token blocks, chained parent hash | **RadixAttention** trie — prefix-of-prefix and branch sharing fall out | Block reuse, supported | Basic prompt reuse |
| Structured output | XGrammar default | XGrammar default, plus a DSL that exposes branch structure | Supported | Limited |
| Quantization | Widest coverage (FP8, AWQ, GPTQ, FP4) | Broad | Deepest NVIDIA-native FP8/FP4 | GGUF, CPU-friendly ints |
| Multi-LoRA | Yes | Yes | Yes | Limited |
| Disaggregation | Via Dynamo / llm-d / LMCache connectors | Native PD support, `sgl-router` | Via Dynamo | No |
| Operational cost | Low — `pip install`, one command | Low-moderate | **High** — build a compiled engine per model/shape/GPU | Lowest |
| Velocity | Very fast, occasionally breaking | Very fast | Slower, more deliberate | Fast, different audience |

**Pick vLLM when** you want the default. Broadest model and hardware coverage,
the largest community, and the shortest path from a Hugging Face repo to a
served endpoint. If you have no specific reason to choose otherwise, this is the
reason to choose it. [directional]

**Pick SGLang when** your traffic is prefix-heavy, branching, structured, or
agentic. RadixAttention's trie expresses shared-prefix *trees* natively, where a
flat block hash only matches at boundaries you happened to create — and agent
fan-out, multi-turn chat with regeneration, and RL rollouts are exactly
tree-shaped. Its cache-aware router is first-class rather than bolted on.
[directional]

**Pick TensorRT-LLM when** you are locked to NVIDIA silicon, your model and
shapes are stable, and the last 15–25% of performance is worth a build step in
your release pipeline. The cost is real: an engine is compiled per model, per
precision, per GPU, per shape profile, and that artifact is now something your
CI must produce and your rollbacks must version. [directional]

**llama.cpp / Ollama** are not competitors to the above; they solve a different
problem. One user, one machine, often no GPU at all, GGUF weights quantized
hard enough to fit in consumer memory. They will lose badly on fleet throughput
because they are not trying to win it — there is no continuous batching win to
be had when the batch is one.

> **State of play (mid-2026):** vLLM and SGLang leapfrog each other release to
> release; TGI was archived read-only in March 2026. Treat any single
> cross-engine "X% faster" figure as noise unless you can see the workload
> shape, the batch size, and the latency point it was measured at — per
> [Hardware & Economics](#/hardware-and-economics), a throughput number without
> its latency point is half a fact.

## Buy vs build: derive the break-even

Start from the cost identity in [Inference Arithmetic](#/inference-arithmetic):

```text
cost_per_token = GPU_$/hr ÷ (tokens/s × 3600 × utilisation)
```

Work a concrete replica. Llama-3-70B in FP8 on 2 × H100 at ~$2.50/GPU-hr, so
**$5.00/hr**. Each GPU streams 35 GB of weights per decode step at 3.35 TB/s —
a 10.4 ms floor — and at ~55% achieved bandwidth utilisation plus the ~25%
all-reduce tax, call it ~24 ms per step, or ~42 tokens/s per sequence. At a
batch of 32 (well under the FP8 `B_crit` of ~148, so nearly free), aggregate
throughput is ≈ **1,400 tokens/s** [directional].

```text
u = 100%  →  5 / (1400 × 3600 × 1.0)  = $0.99 / 1M tokens
u =  60%  →                             $1.65 / 1M
u =  30%  →                             $3.31 / 1M
u =  10%  →                             $9.92 / 1M
```

Nothing changed but utilisation, and the cost moved 10×. Now invert it. Given an
API price `p` in dollars per token, the utilisation at which self-hosting breaks
even is:

```text
u* = GPU_$/hr ÷ (tokens/s × 3600 × p)
```

- Against a frontier-priced API at **$10/1M**: `u* = 5 / (1400 × 3600 × 10e-6) ≈ 10%`.
  You beat it almost immediately.
- Against a mid-tier API at **$3/1M**: `u* ≈ 33%`. Achievable, and comfortably
  inside the 30–60% band that real fleets reach.
- Against a commodity open-weight host at **$0.90/1M**: `u* ≈ 110%`. **You
  cannot break even at any utilisation.**

The three bullets above are one formula evaluated at three prices. Substitute
your own GPU rate, your own measured throughput and the API price you are
actually being quoted, and watch where `u*` crosses the utilisation you can
realistically sustain — that crossing, not a volume threshold, is the decision.

<div class="inf-widget" data-widget="cost-calculator">
<p class="inf-widget-fallback">Interactive cost-per-token and buy-vs-build break-even calculator — needs JavaScript enabled.</p>
</div>

That last line is the honest one, and it deserves stating plainly: **the
break-even is a utilisation question, not a volume question.** Volume matters
only because it is what makes high utilisation *achievable* — a steady 1,400
tokens/s of demand, around the clock, is what 100% utilisation means. But if a
commodity provider is serving the identical open weights at 50% gross margin
and higher utilisation than you will ever reach, you will lose to them on price.
The reason to self-host in that case is not cost. It is data residency, a
model they do not host, a latency floor you control, a prefix cache you own, or
freedom from someone else's rate limits.

**And the costs the spreadsheet omits.** One to two engineers on the serving
stack is $30–50k/month — the rent on six to ten of the replicas above. On-call
for a system whose failure mode is a five-minute cold start. Spare capacity for
the peak, which bites hardest: a 4:1 diurnal peak-to-mean ratio caps your mean
utilisation at 25% unless you backfill the troughs with batch work, which is
precisely why providers sell batch APIs at −50%. Model upgrades, each a
re-benchmark and a re-tune. And an evaluation harness, because the day you
quantize to save money is the day you need to prove you did not break the model
([Did Quantization Break Your Model?](#/did-quantization-break-your-model)).

As a rough gate: sustaining ~33% utilisation on one such replica means roughly
**1 billion output tokens per month** [directional]. Below that, a single
replica is mostly idle silicon. That threshold scales directly with your GPU
price, inversely with your achieved throughput, and inversely with the API price
you are comparing against — so recompute it rather than quoting it.

## The decision tree

Walk it top to bottom; the first "yes" that stops you is your answer.

| # | Ask | If yes | If no |
|---|---|---|---|
| 1 | Must the data stay inside your boundary? | BYOC, self-host, or on-prem. Skip to 4. | Continue. |
| 2 | Is your traffic under ~100M tokens/month, or bursty with long idle stretches? | **Token API.** You cannot fill a GPU; do not rent one. | Continue. |
| 3 | Is your workload an agent loop or otherwise cache-heavy (high input:output, repeated prefixes)? | Self-host or take a dedicated endpoint with a cache-affinity guarantee. Owning the block pool is the lever. | A token API is still likely cheapest. |
| 4 | Does the model + a *useful* KV pool fit on one node? | Choose the GPU by bandwidth, then FLOPs. Prefer H200 over H100 for decode. | Multi-node: you now need NVLink domains, TP/PP planning, and probably [disaggregation](#/disaggregation). |
| 5 | Is your traffic prefill-heavy or decode-heavy? | Prefill-heavy → FLOPs and chunk size matter; L40S-class becomes viable for small models. | Decode-heavy → bandwidth and KV capacity are the only things that matter. |
| 6 | Is the workload branching, structured, or agentic? | **SGLang.** | **vLLM.** |
| 7 | Locked to NVIDIA, stable shapes, and is 15–25% worth a build step? | **TensorRT-LLM**, behind Dynamo. | Stay on the OSS engine you picked in 6. |
| 8 | Can you sustain `u*` for your comparison price? | Build. | Buy, and revisit when volume grows. |

## Frequently asked

<div class="faq">

<details>
<summary>Is an H200 worth the premium over an H100?</summary>

For decode, almost always. Same 990 TF of dense BF16, but 4.8 TB/s against
3.35 — a 1.43× bandwidth ratio that translates almost one-for-one into
tokens/s, since decode latency is bytes ÷ bandwidth. And 141 GB against 80
means 61 GB more KV pool per card, which is a much larger relative gain than it
sounds once you subtract fixed weight cost. The ridge falls from 295 to 206, so
you also reach the compute-bound regime at a smaller batch. Price it per
token/s and per GB of pool, not per GPU-hour.

</details>

<details>
<summary>Why is "we'll just use the biggest model" usually wrong?</summary>

Because model size is the term that crowds out everything else in the memory
budget, and its effect is multiplicative. A 70B in BF16 leaves a sliver of pool
on two H100s; an 8B leaves the GPU as essentially one large cache. The right
question is not "which model is best" but "which is the smallest model that
passes my evaluation" — because the leftover HBM converts directly into
concurrency, and concurrency converts directly into cost per token.

</details>

<details>
<summary>If I self-host, am I stuck with my GPU choice for years?</summary>

Only if you buy rather than rent. This is a real argument for renting during
the current silicon cadence: H100 → H200 → B200 → Vera Rubin has been roughly
annual, and each step changed the bandwidth-to-FLOPs ratio enough to move the
right answer. Capital purchase makes sense when utilisation is high and
sustained enough that depreciation beats rent, and when you have the power and
cooling — which for 100+ kW racks is a building question, not an IT one.

</details>

</div>

## What to remember

- **Deployment shape is a physics purchase.** Token APIs buy you out of the
  utilisation problem — the hardest one — and cost you the latency floor, the
  model list, and your data boundary. Each step toward self-hosting buys back
  control and takes back utilisation.
- **A serverless endpoint cannot hold your KV cache warm on your terms.** For
  agent traffic, where 85–95% of the work is prefill and cache hit rate moves
  the bill ~10×, that is the whole decision. The more your workload talks to
  itself, the more the cache is the product.
- **GPU order: capacity → bandwidth → FLOPs → interconnect.** Capacity means
  weights *plus a useful pool*. Bandwidth is your tokens/s. FLOPs matter for
  prefill and past `B_crit`. Interconnect decides whether TP is available.
- **The L40S trap:** 362 TF against 0.86 TB/s is a ridge of 421 — great FLOPs,
  starved memory. Fine for prefill-heavy small models, poor for 70B decode.
  Good FLOPs plus poor bandwidth is the standard way to buy the wrong GPU.
- **Frameworks [directional, mid-2026]:** vLLM is the default; SGLang leads on
  prefix-heavy, branching, structured and agentic traffic; TensorRT-LLM trades a
  compile step for the last 15–25% on NVIDIA; llama.cpp/Ollama solve the
  one-user local problem, not the fleet one.
- **Break-even is utilisation, not volume:**
  `u* = GPU_$/hr ÷ (tok/s × 3600 × API_price)`. ~10% against a $10/1M API, ~33%
  against $3/1M, and **unreachable** against a $0.90/1M commodity host serving
  the same open weights. Below break-even, self-host for control, not cost.
- **Count the omitted costs:** engineers, on-call, peak headroom (a 4:1
  peak:mean ratio caps utilisation at 25%), upgrades, and evaluation.

```quiz
[
  {
    "q": "Why is a serverless token API a poor fit for a long-running agent loop, in physical rather than commercial terms?",
    "choices": [
      "Serverless endpoints impose a hard cap on context length",
      "You do not control KV cache residency or routing, so you cannot guarantee that iteration N+1 lands on the replica holding iterations 1..N's blocks — and agent traffic is 85–95% prefill whose cost is decided entirely by hit rate",
      "Serverless endpoints always run quantized models",
      "Agent loops require multi-LoRA, which serverless providers do not offer"
    ],
    "answer": 1,
    "explain": "An agent's next call is nearly the same tokens as its last, so its economics are the prefix cache's economics — hit rate moves the bill about 10×. Cache residency, TTL, eviction order and cache-aware routing are all the provider's to set. You are a tenant in someone else's block pool, and you learn your hit rate from the invoice."
  },
  {
    "q": "An L40S has 362 TFLOP/s of dense BF16 against an A100 80GB's 312, yet decodes a 70B far more slowly. Why?",
    "choices": [
      "The L40S lacks BF16 tensor cores",
      "Decode is bandwidth-bound, and the L40S has 0.86 TB/s against the A100's 2.0 — a ridge of 421 FLOP/byte means you would need 421 concurrent sequences before its compute mattered at all",
      "The L40S has a smaller L2 cache",
      "The L40S cannot run tensor parallelism at any size"
    ],
    "answer": 1,
    "explain": "Decode latency is bytes ÷ bandwidth; the FLOP number does not enter. The L40S pairs high compute with starved memory, giving the highest ridge point on the table — the signature of a chip whose arithmetic you can essentially never reach in decode. Add 48 GB and PCIe-only fabric and a 70B is the wrong workload for it entirely."
  },
  {
    "q": "You compute u* = 110% for self-hosting an open-weight model against a commodity host's price. What is the correct conclusion?",
    "choices": [
      "Your throughput estimate must be wrong; recompute it",
      "You cannot beat that provider on price at any utilisation, because they run the same weights at higher utilisation and 50% gross margin — so self-host only for residency, latency floor, cache ownership, model availability or rate limits",
      "Buy more GPUs so that utilisation exceeds 100%",
      "Switch to a smaller model until u* falls below 100%"
    ],
    "answer": 1,
    "explain": "u* above 1 means the break-even utilisation is unattainable by definition. Commodity hosts of open weights are a near-perfect-competition market priced to the floor, blending many tenants' traffic into utilisation a single customer cannot match. When the model is identical, self-hosting is a control decision, not a cost decision — and stating that plainly is more useful than a spreadsheet that assumes 100% utilisation."
  },
  {
    "q": "In the GPU selection order — capacity, bandwidth, FLOPs, interconnect — why must capacity come first rather than being traded off against the others?",
    "choices": [
      "Because HBM is the most expensive component of a GPU",
      "Because capacity is a hard pass/fail: if the weights plus a useful KV pool do not fit, max_concurrency collapses to single digits and no amount of bandwidth or FLOPs can serve users who have nowhere to store their cache",
      "Because bandwidth scales automatically with capacity on all modern GPUs",
      "Because FLOPs are irrelevant to inference entirely"
    ],
    "answer": 1,
    "explain": "The other three criteria improve a working deployment; capacity decides whether there is one. A 70B in BF16 on two H100s passes a naive 140-vs-160 GB check and leaves ~11 GB of pool — one concurrent 32K sequence. The chip's bandwidth and FLOPs are then irrelevant, because the binding constraint is that there is nowhere to put anyone's KV."
  },
  {
    "q": "When is TensorRT-LLM the right choice over vLLM or SGLang?",
    "choices": [
      "Whenever you run on NVIDIA hardware, since it is always faster",
      "When you are NVIDIA-locked, your model and shape profile are stable, and the last 15–25% of performance is worth adding a per-model, per-precision, per-GPU compile step to your release pipeline",
      "When you need the widest model coverage and fastest adoption of new architectures",
      "When you are serving many LoRA adapters at once"
    ],
    "answer": 1,
    "explain": "Its advantage is a compiled, NVIDIA-native plan; its cost is that the plan is an artifact your CI must build and your rollbacks must version, per model, precision, GPU and shape profile. That trade pays when shapes are stable and the margin matters, and does not pay when you are still changing models — which is why the OSS engines dominate general serving."
  }
]
```
