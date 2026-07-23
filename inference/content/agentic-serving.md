# The Agentic Era

> **Goal of this chapter:** understand how the *workload* changed in 2025–26
> — from humans chatting to agents looping and reasoning models thinking —
> and why that reshuffled the value of every optimization in this course.
> After this chapter you can say precisely why cache hit rate, not model
> choice, is the number that sets an agent's bill; why reasoning models push
> fleets the opposite way; and why RL now runs a serving engine *inside*
> training. It closes Module 5 by naming the one thing everything orbits.

Rewind to 2023. A person opens a chat box, types a sentence, waits, reads a
paragraph, types again. From the engine's side this is a gift: input is
short, output is short, and there is a human-shaped pause between turns long
enough to schedule anything you like. Every optimization in Modules 1–4 was
tuned, implicitly, for that shape.

Now look at 2026 traffic. Two new workloads dominate, and they pull in
**opposite directions**.

An **agent** is a model in a loop. It reads a task, calls a tool (search a
codebase, run a query, hit an API), reads the result, calls another tool,
and repeats — ten, thirty, a hundred times — before it answers. There is no
human in the loop and no human-shaped pause. Critically, each iteration
re-sends the *entire growing context*: the system prompt, the tool
definitions, and every prior step's output. Agent traffic is
**prefill-heavy** to a degree chat never was — input-to-output ratios
reported as high as **267:1**, with prefill making up **85–95%** of the
compute.

A **reasoning model** goes the other way. Given a hard problem it emits a
long private chain of "thinking" tokens before its visible answer —
**10–100× more output tokens per request** than a 2023 chat reply. That is
brutally **decode-heavy**.

One fleet now has to serve both. This chapter is about what that costs and
what engineering it forces.

## The agent loop, in tokens

Make the prefill-heaviness concrete. Take an agent whose working context
sits around **20,000 tokens** (a system prompt, a pile of tool schemas, a
few files it pulled in) and let it run **30 tool-call iterations** to finish
a task.

Naively, each iteration is a fresh request: the engine re-reads the whole
context to rebuild the KV cache — the per-token key/value vectors you met in
[Inference Arithmetic](#/inference-arithmetic) — then generates one tool
call. Thirty iterations over a ~20K context is

```text
  30 iterations × 20,000 tokens ≈ 600,000 token-reads of prefill
```

for an agent that emitted maybe a few thousand tokens of actual tool calls.
Almost all of that prefill is **identical** to the previous iteration's —
the same system prompt, the same tools, the same history, plus one new tool
result appended at the end. You are paying to recompute the same KV cache
thirty times.

You already know the fix. [PagedAttention & Prefix
Caching](#/paged-kv-cache) showed that a shared prefix's KV blocks can be
computed once and reused. Turn prefix caching on and iteration *N* keeps the
KV for tokens 1..(previous end) and prefills **only the newly appended
tokens** — the last tool's output, a few hundred to a couple thousand
tokens. The 600K collapses to roughly one full pass to build the context up
(~20K) plus thirty small deltas. That is the 10–30× reduction that turns an
agent from unaffordable into routine.

Which makes **cache hit rate the single biggest economic lever in the
system — ahead of which model you picked.**

> **State of play (mid-2026):** one widely-cited cost breakdown puts it
> starkly: moving an agent workload's prefix-cache hit rate from **0% to
> 90%** takes a ~**$20k monthly GPU bill down to ~$2k**. Reported
> achievable hit rates are **60–85%** on agent loops and repo-QA, **81–91%**
> on deep multi-turn — a 5–12× cut in per-call cost. These specific
> percentages come from vendor/practitioner blogs, not peer review; treat
> the *direction* as solid and the exact figures as illustrative.

Notice this is the same physics you saw priced two ways already. When a
provider's API charges roughly **10× less for "cached input" than for fresh
input** (Anthropic reads at 0.1× the write price; OpenAI and Gemini have
their own cached tiers), that discount *is* the prefix cache from
[PagedAttention](#/paged-kv-cache), passed through to your invoice. The
"cached tokens, 10× cheaper" line that looked like a pricing gimmick two
chapters ago is now the dominant term in an agent's cost. The loop opened in
[Inference Arithmetic](#/inference-arithmetic) closes here: the KV cache is
the bill.

## What the agent era forces on the fleet

Three consequences follow directly.

**Routing must become cache-aware.** A cache hit only happens if iteration
*N+1* lands on the *same worker* where iterations 1..*N* left their KV. A
plain round-robin load balancer treats replicas as interchangeable and
scatters the iterations across the fleet, throwing away every prefix cache
and re-running every prefill. So the router grows a memory of KV topology:
**prefix-aware / session-affinity routing** sends a request to the worker
most likely to already hold its prefix. This is the same KV-aware router you
met in [Disaggregated Serving](#/disaggregation) (SGLang's `sgl-router`
maintaining a prefix tree, Dynamo's Smart Router scoring cache-overlap minus
load) — the agent era is simply what made it non-optional.

**Caches must tier, because agent sessions outlive HBM.** A tool call can
take seconds to minutes — a database query, a web fetch, another model's
reply. For that whole stretch the session's KV cache is idle but must
survive, and HBM (the GPU's scarce on-package memory) is far too precious to
hold thousands of parked sessions. So the KV cache spills down a hierarchy —
HBM for the active few seconds, CPU DRAM for minutes, NVMe beyond — exactly
the [LMCache](#/disaggregation) / Mooncake tiering from the last chapter. A
"logical" 90% hit rate is worthless if HBM eviction forced a recompute;
tiering is what makes a logical hit a *physical* one.

**The client must engineer its context.** Caches are only hittable if the
prefix is *stable* and *append-only*. Reorder your tool definitions between
turns, or edit something in the middle of the history, and every KV block
after the edit is invalidated — its hash no longer matches. So a discipline
called **context engineering** emerged on the app side: keep the system
prompt and tool schemas byte-stable, only ever append to the running
context, never mutate the middle. It is prompt engineering's unglamorous
cousin, and it exists entirely to keep the server's cache warm. (Agent
*frameworks* and prompt design are out of scope here — we care only that
their output has to be cache-friendly.)

> **Common trap:** "cache hit means same answer." Reusing KV blocks is
> exact when the reused tokens really are identical — that is arithmetic,
> not approximation. But in **multi-agent and LLM-as-judge** setups, reusing
> a prefix across roles can leak state in ways that quietly change behavior:
> a "fresh" judge that shares KV with the thing it is judging is not
> actually fresh. Whether this subtly degrades quality is
> [open research](https://arxiv.org/pdf/2601.08343) — flag it, don't reuse
> blindly across independent reasoners.

## Reasoning models pull the other way

Now the opposite pressure. A reasoning model's long chain of thought is pure
**decode** — token after token, each reading the whole KV cache, the
memory-bandwidth-bound regime from [Inference
Arithmetic](#/inference-arithmetic). Ten to a hundred times more output per
request shifts the whole fleet decode-heavy.

That breaks a tidy assumption from the last chapter. Naive **1-prefill /
1-decode** disaggregation assumes prefill and decode are roughly balanced;
for reasoning they are wildly not. The prefill pool sits idle while decode
grinds for thousands of tokens, and the KV-transfer between pools becomes
pure overhead. The fix is to skew the ratio — **decode-heavy layouts like
1P3D** (three decode pools per prefill pool), covered in
[Disaggregated Serving](#/disaggregation) — or to not disaggregate reasoning
at all.

There is an economic echo too. Reasoning inflates the real compute behind
each request far faster than user counts grow, and it is a big reason the
token-price free-fall of 2023–25 **slowed** to single-digit deflation in
2026. That story — the S-curve, the hardware behind it — belongs to
[Hardware & Economics](#/hardware-and-economics), the next chapter.

## Inference moved inside the training loop

Here is the genuinely new thing. Reinforcement-learning post-training —
teaching a model from its own generated attempts — needs to **generate those
attempts**, thousands of them, fast. Generating is inference. So modern RL
runs a real serving engine to produce **rollouts**, and the serving stack
you have spent this course learning now sits *inside* training.

That creates problems training never had. The rollout engine and the trainer
often want the same GPUs, alternating: generate a batch, train on it, repeat.
Engines grew **sleep/wake modes** — between phases, free the KV cache and
optionally offload the model weights to host memory so the trainer can use
the GPU, then *wake* and reload for the next rollout, all without tearing
down the server.

And every training step changes the weights, so the freshly-trained weights
must be pushed back into the rollout engine before the next batch — the
**weight-sync problem**. Do it naively (ship every parameter) and it is
glacial: a 32B model resynced the dumb way is reported around **14 minutes
per round**, which would dwarf the rollouts themselves. The 2025–26 systems
send only what changed — **weight-update sparsity over peer-to-peer RDMA** —
and hit roughly **1.3-second cross-machine updates even at 1-trillion-parameter
scale.** That is a fun number: a thousand-billion-parameter sync in the time
it takes to blink, because you refuse to send the parts that didn't move.
(The 1T/1.3s figures are from frontier-lab reports and
[research systems](https://arxiv.org/pdf/2605.07330); directionally
established, exact numbers volatile.) This is why SGLang and vLLM both grew
first-class RL APIs — the training frameworks needed a serving engine they
could drive programmatically.

## Multi-LoRA: thousands of models, one base

One more agent-era pattern, promised back in [Anatomy of a Serving
Engine](#/anatomy-of-an-engine). Fine-tuning a full model per customer or
per task is absurdly expensive to serve — a separate multi-hundred-GB copy
each. **LoRA** adapters are the cheap alternative: a small low-rank "diff"
(often megabytes) layered onto a shared base model. The serving question is,
can you host *thousands* of adapters over *one* base model's weights and
switch between them per request?

Two ideas, both of which you will recognize:

- **S-LoRA's unified paging.** The adapters live in host RAM and page into
  GPU on demand — out of the **same paged pool** as the KV cache blocks.
  This is [PagedAttention](#/paged-kv-cache) eating yet another problem: the
  block allocator doesn't care whether a block holds KV or adapter weights,
  so a single pool absorbs both and LRU-evicts whichever is cold. Thousands
  of adapters on one GPU.
- **Punica's SGMV kernel.** A batch can contain requests for *different*
  adapters. A Segmented Gather Matrix-Vector kernel applies each request's
  own adapter within one batched GPU call, so mixing adapters costs almost
  nothing versus serving the bare base model.

In the agent era this is not a niche: per-customer, per-task, per-tool
adapters are exactly how you specialize one base model across a fleet of
agents without paying for a fleet of models.

## The through-line of Module 5

Step back across the whole module. Parallelism split the model across GPUs.
MoE serving spread experts across a fabric. Disaggregation cut prefill from
decode into separate pools. Tiering pushed caches down a memory hierarchy.
Affinity routers steered requests by where cache lives. RL fleets folded
serving into training. Multi-LoRA paged adapters beside cache blocks.

Say the through-line plainly, once: **every one of these systems is
infrastructure orbiting the KV cache.** Expert-parallel pods exist so a
batch big enough to feed the KV cache stays GEMM-efficient. Disaggregated
pools exist to protect the KV cache's decode bandwidth from prefill bursts.
Tiered caches, affinity routers, sleep/wake, unified paging — all of it is
machinery for computing the KV cache once, keeping it warm, and finding it
again. The cache hit rate is the dial that converts all that architecture
into dollars. Learn to see the KV cache at the center and Module 5 stops
being a list of tricks and becomes one system with one gravity well.

## What to remember

- **The workload flipped.** 2023 was chat; 2026 is agents (prefill-heavy,
  up to 267:1 input:output, 85–95% prefill) plus reasoning models
  (decode-heavy, 10–100× more output). One fleet serves both opposite
  pressures.
- **Cache hit rate is the #1 lever, ahead of model choice.** An agent
  re-sends a growing context every iteration; prefix caching turns 30 full
  prefills into one build-up plus small deltas. 0%→90% hit rate is roughly a
  10× bill cut. Provider "cached input, ~10× cheaper" pricing *is* this
  physics on your invoice.
- **It forces three things:** cache-aware/session-affinity routing (so
  iteration N+1 finds N's cache), KV tiering (sessions outlive HBM during
  slow tool calls), and client-side context engineering (stable, append-only
  prefixes to keep caches hittable). Caveat: reused KV can subtly break
  fresh-judgment semantics in multi-agent/judge setups.
- **Reasoning wants decode-heavy layouts** (1P3D over naive 1P1D) and is part
  of why token deflation slowed.
- **RL runs a serving engine inside training:** sleep/wake to share GPUs,
  and sparse P2P-RDMA weight-sync (~14 min naive → ~1.3s at 1T scale).
- **Multi-LoRA** hosts thousands of adapters on one base: S-LoRA pages them
  from the same pool as KV blocks; Punica's SGMV batches different adapters
  in one call.
- **The whole module orbits the KV cache.** Every system is machinery to
  compute it once, keep it warm, and find it again.

```quiz
[
  {
    "q": "An agent runs 30 tool-call iterations over a ~20K-token context. Why does prefix caching cut its cost by roughly an order of magnitude?",
    "choices": [
      "It lets the agent skip tool calls whose results are already cached",
      "Each iteration re-sends a nearly identical growing context; without caching that is ~30 full prefills of the same tokens, and caching makes each iteration prefill only the newly appended tokens",
      "It compresses the KV cache so it fits in HBM",
      "It switches the agent to a smaller model after the first iteration"
    ],
    "answer": 1,
    "explain": "Naively the agent re-prefills the whole context every loop: 30 × 20K ≈ 600K token-reads of mostly-identical content. Prefix caching keeps the shared KV and prefills only the last tool result each iteration, collapsing 600K to one build-up plus small deltas — the 10–30× reduction."
  },
  {
    "q": "Why must an agent-serving router be cache-aware rather than round-robin?",
    "choices": [
      "Round-robin is slower to compute per request",
      "A prefix-cache hit only occurs if iteration N+1 lands on the same worker holding iterations 1..N's KV; round-robin scatters iterations and destroys every cache",
      "Round-robin cannot handle more than one model",
      "Cache-aware routing uses less network bandwidth"
    ],
    "answer": 1,
    "explain": "The cache is physically on one worker's HBM/tier. Round-robin treats replicas as interchangeable and sends the next iteration anywhere, so the prefix isn't there and the prefill re-runs. Prefix/session-affinity routing steers the request to where its KV already lives."
  },
  {
    "q": "How does a reasoning model's workload differ from an agent's, and what serving layout does it favor?",
    "choices": [
      "Reasoning is prefill-heavy and wants more prefill pools",
      "Reasoning is decode-heavy (long chains of thought) and favors decode-skewed layouts like 1P3D, whereas naive 1P1D disaggregation leaves prefill GPUs idle",
      "Reasoning and agents have identical profiles",
      "Reasoning needs no KV cache because it thinks internally"
    ],
    "answer": 1,
    "explain": "Reasoning emits 10–100× more output tokens, all decode (memory-bandwidth-bound). Balanced 1P1D disaggregation wastes the prefill pool and adds pure KV-transfer overhead, so reasoning wants decode-heavy ratios (1P3D) or no disaggregation — the mirror image of prefill-heavy agents."
  },
  {
    "q": "In RL post-training, why is the weight-sync problem solved by sparse P2P-RDMA updates instead of shipping all weights?",
    "choices": [
      "RDMA can only transfer sparse tensors",
      "Every training step changes the weights the rollout engine must use next; sending all of a large model each round is glacial (~14 min for 32B), so systems send only the parameters that changed",
      "The trainer and rollout engine never share weights",
      "Sparse updates improve model accuracy"
    ],
    "answer": 1,
    "explain": "RL alternates generate-and-train on the same weights, so fresh weights must reach the rollout engine before each batch. Naive full sync (~14 min for 32B) would dwarf the rollouts; exploiting weight-update sparsity over P2P RDMA hits ~1.3s updates even at 1T scale."
  },
  {
    "q": "What is S-LoRA's core trick for hosting thousands of adapters on one base model?",
    "choices": [
      "It merges all adapters into the base weights ahead of time",
      "Adapters page into GPU on demand from the same paged pool as the KV cache, so one allocator manages both and LRU-evicts whichever is cold",
      "It runs one GPU process per adapter",
      "It quantizes every adapter to 1 bit"
    ],
    "answer": 1,
    "explain": "Unified paging reuses the PagedAttention block allocator: a block can hold KV or adapter weights, adapters live in host RAM and page in when needed, and the shared pool with LRU eviction lets thousands of adapters coexist on one GPU. Punica's SGMV kernel then batches different adapters in a single call."
  }
]
```
