# The Frontier (a mid-2026 snapshot)

> **Goal of this chapter:** a tour of the moving edge. Every other chapter in
> this course was built to age well — the roofline, the KV cache, batching
> economics don't expire. This one is different: it has a date stamped on it.
> By the end you'll know what's genuinely new in mid-2026, what has actually
> shipped versus what is promising research, and — because you finished the
> course — how to read the field's next surprise without waiting for someone
> to explain it to you.

Read the date in the title again: **July 2026**. That is deliberate. This is
the one chapter written to be wrong by the time you're deep into your career —
maybe wrong by the time you read it. Treat everything below as a photograph of
a fast-moving thing, not a law. What makes it worth reading anyway is that you
now own the concepts to judge each frontier direction for yourself. So this is
less a list of news and more a set of bets: what the field is converging on,
what's still speculative, and why.

## The demand earthquake: test-time compute changed the target

Start with the force reshaping everything else. Reasoning models — the ones
that "think" before answering — emit **10–100× more output tokens per
request** than a 2023 chatbot did ([test-time-compute
analysis](https://arxiv.org/pdf/2510.18672)). You met the consequence in
[Inference Arithmetic](#/inference-arithmetic) and
[Hardware & Economics](#/hardware-and-economics): output tokens are generated
in the **decode** phase, and decode is **memory-bound** — its speed is set by
how fast you can stream weights and KV cache out of HBM, not by raw FLOPS.

So a workload made of long reasoning traces pushes the whole fleet toward the
memory-bound corner of the roofline. That single shift explains a startling
amount of what this course taught as "current practice":

- **Disaggregation ratios tilted decode-heavy.** Naive 1-prefill-1-decode
  splitting actively *hurts* reasoning models — the prefill GPUs sit idle
  while enormous decode phases run. Fleets moved to 1P3D and beyond
  ([disaggregation](#/disaggregation)).
- **Higher-HBM SKUs became the premium part.** The B300's 288 GB exists
  because KV cache for long reasoning is the binding constraint.
- **Single-stream speed became a product.** When one answer is 10,000 tokens,
  the tokens-per-second *one user* sees is a felt latency — which is exactly
  the niche SRAM-dataflow chips (Cerebras, Groq) sell into.
- **Speculative decoding got more valuable, not less.** Every accepted draft
  token is a decode step you skipped; on a decode-dominated workload the
  payoff compounds ([speculative decoding](#/speculative-decoding)).

The scarce resource stopped being "requests per second" and became "decode
tokens per second at an acceptable per-user speed." Hold that frame — the rest
of the frontier is the field reacting to it.

## Learned sparse attention: the one that shipped

Attention costs scale with the **square** of context length — every token
attends to every earlier token ([Attention Architectures for
Serving](#/attention-for-serving)). For years the fix-it literature was
*eviction*: throw away KV entries you guess you won't need (H2O, StreamingLLM,
SnapKV). You learned the honest verdict there — that literature is heavily
cited and **largely undeployed**; frontier labs went a different way.

The way that won is **trained** sparsity: teach the model, during training,
which tokens to attend to, so the sparse pattern is native rather than bolted
on. The research line ran NSA (DeepSeek) and MoBA (Moonshot) in early 2025,
and then it *shipped*: **DeepSeek Sparse Attention (DSA)** in V3.2, late 2025.
A cheap FP8 "lightning indexer" scores every past token, top-k keeps a few
thousand, and attention runs only over those — turning the O(L²) cost into
O(L·k). It landed day-0 in vLLM and SGLang and came with a **>50% API price
cut** ([DeepSeek-V3.2](https://arxiv.org/abs/2512.02556)).

> **State of play (mid-2026):** trained sparse attention is production-real and
> expanding — DeepSeek-V4's Compressed Sparse Attention, MiniMax, Kimi's MoBA
> lineage. The driver is million-token context: at that length dense attention
> is simply unaffordable, so the labs that want long context are all
> converging on trained sparsity. This is the frontier direction with the
> firmest ground under it — bet on more of it, not less.

## Diffusion LLMs: a beautiful idea that fights your whole stack

Here's a genuinely different way to generate text. A **diffusion LLM (dLLM)**
starts from a sequence of masked positions and, over several iterations,
denoises *all positions in parallel* — filling in and revising the whole
output at once — instead of committing to one token at a time, left to right.
Three sentences, done: it's parallel-in-position generation; the model sees
the whole (partly-masked) sequence each step; it converges the answer over a
handful of passes rather than one-token-per-pass.

The appeal is obvious — parallelism. The problem is that a dLLM breaks the two
pillars this entire course was built on:

1. **Exact KV caching dies.** The KV cache works because attention is
   *causal*: a token attends only to the past, so past keys and values are
   frozen and reusable ([PagedAttention & Prefix Caching](#/paged-kv-cache)).
   dLLMs use **bidirectional** attention — every position attends to every
   other, and every position can still change next iteration. Nothing is
   "past," so nothing is safely cacheable.
2. **Continuous batching strains.** [Orca-style continuous
   batching](#/continuous-batching) assumes each sequence advances one token
   per step and leaves when it emits its stop token. dLLM iterations converge
   *heterogeneously* — different requests need different iteration counts —
   so the tidy per-step slot-in/slot-out rhythm doesn't map cleanly.

A serving literature formed specifically to fix this. **Fast-dLLM**
(NVIDIA/MIT/HKU) reintroduces an *approximate* KV cache plus confidence-gated
parallel decoding — accept positions the model is already sure about, keep
iterating on the rest ([Fast-dLLM](https://arxiv.org/abs/2505.22618)).
SLO-aware dLLM schedulers (DiLaServe, BlockServe) bring goodput-driven
batching to the paradigm — call it the **Orca moment for diffusion**.

> **State of play (mid-2026):** this is a real subfield with serious backing —
> NVIDIA, MIT, HKU — and a genuine anchor survey. It is **not** a deployed
> production workload at any frontier lab. Teach it to yourself as *emerging*.
> The honest question isn't "is diffusion the future of text" — it's narrower
> and sharper: *will a dLLM's economics ever beat autoregressive decoding plus
> speculation on the same hardware?* Watch that number. Don't pre-commit to
> the answer.

## Block-diffusion speculative decoding: the paradigms compose

The most interesting turn in that story is that the two approaches may not
compete at all. Recall the structure of [speculative
decoding](#/speculative-decoding): a cheap **drafter** proposes tokens, the
expensive target model **verifies** them in one parallel pass, and the math
guarantees the output distribution is unchanged.

What makes a good drafter? Something fast that can propose *several* tokens at
once. A diffusion model proposes a whole **block** in parallel — which is
exactly the shape a verifier wants. The **DFlash** line puts a block-diffusion
model in the drafter seat inside an otherwise ordinary autoregressive stack:
diffusion proposes, the AR model verifies, losslessness preserved
([DFlash](https://arxiv.org/abs/2602.06036)). The elegant paradigm and the
deployed paradigm end up on the same team.

> **State of play (mid-2026):** hot research, not production default. But
> conceptually it's the cleanest resolution on offer — diffusion earns its
> keep as a component of the stack you already run, no bet-the-fleet rewrite
> required.

## The memory frontier grows another tier

You built a mental hierarchy for KV cache: SRAM, then HBM, then host DRAM,
then SSD, with paging and prefix reuse moving bytes between levels. Two things
are stretching that hierarchy outward in 2026.

**CXL-attached memory pools.** CXL lets a rack share a large, coherent pool of
DRAM across accelerators. For KV cache — which is bulky, read-heavy, and often
reusable across requests — a CXL pool is a natural new tier between local HBM
and the network: bigger than HBM, faster than SSD, addressable by many GPUs
(HyMCache, SAC). It slots straight into the tiering logic from
[disaggregation](#/disaggregation) as one more level.

**KV / prefill as a cross-datacenter service.** If prefill is compute-bound and
decode is memory-bound, and KV cache is just bytes, then in principle you can
compute a prompt's KV *somewhere else* and ship it to whichever fleet decodes.
The multi-region rule of thumb — *replicate weights, not KV* — is starting to
bend as prefill-as-a-service prototypes appear
([cross-DC KV](https://arxiv.org/pdf/2604.15039)).

> **State of play (mid-2026):** early hardware reality, not standard practice.
> CXL is shipping but its KV use is nascent; cross-DC KV is research with real
> latency and bandwidth costs to overcome. Promising, unsettled.

## Megakernels: the 2× still sitting on the table

One paragraph, because you already own the idea. In
[Kernels, Graphs & Compilation](#/kernels-and-compilation) you saw that every
kernel launch has overhead, and that stitching an inference step out of
hundreds of separate kernels leaves the GPU repeatedly idle between them.
Measurements keep finding real engines using **≤50% of available memory
bandwidth** on decode — which means, on a memory-bound workload, there is a
clean **~2×** still available inside a *single* GPU, before any new silicon.
Megakernels — fusing an entire forward pass into one persistent kernel launch
so the hardware never stalls waiting for the next dispatch — are the endgame of
that pursuit. Unglamorous, and one of the highest-leverage places left to win.

## RL-rollout serving becomes a first-class discipline

The last frontier is a boundary dissolving. Training a frontier model now leans
heavily on reinforcement learning, and RL needs **rollouts** — the model
generating long trajectories to be scored and learned from. Generating those
trajectories *is inference*. As traces got longer (test-time compute again),
rollout generation became the **bottleneck of post-training** — the training
cluster waits on the serving path.

So the tools of this course — continuous batching, PagedAttention, speculative
decoding, disaggregation — are now being pointed at rollout generation, and a
dedicated literature has appeared: rollouts on serving GPUs via cooperative
elasticity (ROSE), rollout-budget allocation (TRACE), asynchronous single-
rollout optimization. The [agentic era](#/agentic-serving) had already blurred
"one request" into long tool-using sessions; RL rollout erases the line between
*training* and *serving* entirely. Inference is no longer only how you *ship* a
model — increasingly it's how you *build* one.

> **State of play (mid-2026):** genuinely a new first-class serving problem, not
> hype — the affiliations are the labs doing frontier post-training. Expect it
> to keep growing.

## What we'd bet on — and what we wouldn't

This is the end of the course, so let's separate the invariants from the
weather.

**Durable — bet on these.** They're physics and arithmetic, not fashion:

- **The roofline asymmetry.** Prefill is compute-bound; decode is memory-bound.
  Every serving decision descends from that split, and it isn't going away.
- **KV-cache centrality.** The KV cache is the thing that grows, the thing that
  OOMs you, the thing worth paging, quantizing, sharing, and shipping. Own it
  and you understand most of serving.
- **Batching economics.** Throughput and per-user latency trade off along a
  Pareto curve; you provision on goodput at a target percentile. Always.
- **The memory wall.** Bandwidth and capacity, not FLOPS, gate inference — and
  energy per token falls with batch size, so the latency/throughput dial is
  also the power dial.

**Volatile — don't anchor to these.** They will churn, and that's fine:

- Engines and their defaults (vLLM, SGLang, TRT-LLM, Dynamo), numeric formats
  (FP8 → MXFP4/NVFP4 → whatever's next), specific SKUs and rack designs, and —
  most of all — **prices**. Every dollar figure in this course is a timestamp,
  not a fact.

The skill isn't memorizing the volatile layer. It's mapping each new thing onto
the durable layer fast enough that the news explains itself.

## How to stay current

You no longer need a curriculum — you need a feed. The high-signal sources:

- **Engine blogs:** the [vLLM](https://blog.vllm.ai/) and
  [SGLang](https://lmsys.org/blog/) blogs, and **LMSYS** — where deployed
  practice is announced first.
- **Economics & hardware:** **InferenceX / SemiAnalysis** for TCO-normalized,
  Pareto-honest benchmarks (never trust a lone tokens/sec number again) and
  **Artificial Analysis** for cross-provider price/speed.
- **The research floor:** **MLSys** and **OSDI** proceedings, and the survey
  papers in this course's bibliography — start with *A Survey on Efficient
  Inference for LLMs* and *Taming the Titans*, then follow their citations.
- **Primary postmortems:** the DeepSeek and Kimi (Mooncake) engineering
  writeups. They read like this course now.

## What to remember

- **Test-time compute is the demand-side earthquake** — it pushed the whole
  field toward memory-bound decode and explains disagg ratios, high-HBM SKUs,
  SRAM silicon, and the renewed value of speculation.
- **Trained sparse attention shipped** (DSA), cut prices >50%, and is the
  best-grounded frontier bet, driven by million-token context.
- **Diffusion LLMs** are a real, well-backed research subfield that breaks exact
  KV caching and continuous batching — **not** production at frontier labs.
  Watch whether their economics ever beat AR + speculation.
- **Block-diffusion speculative decoding** composes the two paradigms:
  diffusion drafts, AR verifies, losslessness intact.
- **CXL KV pools, cross-DC prefill, megakernels, and RL-rollout serving** are
  the other live edges — early hardware, a leftover 2× per GPU, and the
  dissolving training/serving boundary.
- **Bet on the invariants** (roofline, KV cache, batching, the memory wall);
  **hold the volatile layer loosely** (engines, formats, SKUs, prices).

You started this course not knowing what a token was. You're ending it able to
read a frontier lab's production postmortem — approximate KV caches, wide
expert parallelism, disaggregated prefill, FP4 KV — and see not magic but a
set of trade-offs you can name, price, and argue about. The field will keep
moving. You can now move with it, and read its papers as an insider. Go build
something fast.

```quiz
[
  {
    "q": "Why did the rise of reasoning models push serving fleets toward decode-optimized, high-HBM configurations?",
    "choices": [
      "Reasoning models have far more parameters, so they need more memory to hold weights",
      "Reasoning emits 10–100× more output tokens per request, and output tokens are produced in the memory-bound decode phase — inflating demand for HBM bandwidth and capacity",
      "Reasoning models require larger prefill batches, which are compute-bound",
      "Longer prompts mean prefill dominates, so more FLOPS are needed"
    ],
    "answer": 1,
    "explain": "Test-time compute multiplies output tokens, and output tokens are generated one-per-step in decode, which is bound by how fast you stream weights and KV out of HBM. The workload shifts hard toward the memory-bound corner — hence decode-heavy disagg ratios and higher-HBM SKUs like the B300."
  },
  {
    "q": "Why does a diffusion LLM break the exact KV cache that autoregressive serving depends on?",
    "choices": [
      "It uses too much memory to fit a KV cache in HBM",
      "Its attention is bidirectional — every position attends to every other and can still change each iteration — so no keys/values are frozen 'past' state to reuse",
      "It generates tokens faster than the cache can be written",
      "It does not use attention at all"
    ],
    "answer": 1,
    "explain": "The KV cache works because causal attention makes past keys/values immutable and reusable. A dLLM denoises all positions in parallel with bidirectional attention, so nothing is settled 'past' — exact caching has no fixed state to hold. Fast-dLLM's response is an *approximate* KV cache."
  },
  {
    "q": "In block-diffusion speculative decoding (DFlash lineage), what role does the diffusion model play?",
    "choices": [
      "It replaces the autoregressive model entirely as the production server",
      "It verifies the autoregressive model's tokens in parallel",
      "It acts as the drafter — proposing whole blocks in parallel — which the autoregressive model then verifies, preserving losslessness",
      "It compresses the KV cache before transfer"
    ],
    "answer": 2,
    "explain": "Speculative decoding needs a fast drafter that proposes several tokens at once; a diffusion model's parallel block generation fits that role exactly. The AR target verifies in one pass, so the output distribution is unchanged — the two paradigms compose rather than compete."
  },
  {
    "q": "Which of these is a DURABLE invariant to anchor on, rather than a volatile detail likely to churn?",
    "choices": [
      "The specific price of a B200 GPU-hour",
      "The prefill-is-compute-bound / decode-is-memory-bound roofline asymmetry",
      "vLLM being the default engine",
      "MXFP4 being the standard low-precision format"
    ],
    "answer": 1,
    "explain": "The roofline split is arithmetic and physics — it drives nearly every serving decision and doesn't expire. Prices, engines, and numeric formats are the weather: real today, changed tomorrow. The skill is mapping new developments onto the durable layer."
  },
  {
    "q": "Why has RL-rollout generation become a first-class serving discipline in 2026?",
    "choices": [
      "Rollouts require a completely different set of tools than production serving",
      "Reinforcement-learning post-training needs the model to generate long trajectories, which is inference — and as traces lengthened, rollout generation became the bottleneck of post-training, dissolving the training/serving boundary",
      "Rollouts run only on CPUs, needing new infrastructure",
      "RL eliminated the need for continuous batching"
    ],
    "answer": 1,
    "explain": "Generating rollouts is inference, so the same machinery — batching, paging, speculation, disaggregation — applies. With long reasoning traces, the training cluster waits on the serving path, making inference not just how you ship a model but how you build one."
  }
]
```
