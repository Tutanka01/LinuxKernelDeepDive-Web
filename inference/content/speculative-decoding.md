# Speculative Decoding

> **Goal of this chapter:** understand how to make one model generate several
> tokens per weight-pass without changing a single output. You'll see the
> rejection-sampling theorem that makes it provably lossless, do the speedup
> arithmetic yourself, meet the family (EAGLE, Medusa, MTP, n-gram), and learn
> the one thing most write-ups get wrong: the benefit *inverts* with batch size.
> After this chapter, "2× faster, same model, no quality loss" stops sounding
> like a free lunch and starts looking like what it is — arbitrage on idle silicon.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,batch"></div>

Here is a fact from [Inference Arithmetic](#/inference-arithmetic) that should
still bother you. When you generate text one request at a time, the GPU reads
its *entire* weight set — 140 GB for a 70B model in FP8 — out of high-bandwidth
memory (**HBM**, the fast memory soldered next to the chip) to produce **one
token**. The arithmetic units that could do a thousand trillion operations a
second sit ~99% idle, because there simply isn't enough work in a single token
to feed them. Decode is **bandwidth-bound**: you pay for the weight-read whether
you compute one token or fifty. The whole cost is dragging those bytes across
the bus.

So here's the trade you'd love to make: that weight-read is already paid for —
what if a single pass produced *several* tokens instead of one? The idle math
units are right there. The obstacle is that generation is **sequential**: token
11 is chosen by feeding token 10 back in, so you can't compute them together.

But notice the asymmetry. Generating token 11 requires knowing token 10.
**Checking** whether token 11 *would have been* "the" costs nothing extra —
scoring `k` candidate tokens is just `k` positions fed through the model in one
pass, at the same bandwidth cost, exactly like prefill. Generation is serial;
verification is parallel. Speculative decoding is built entirely out of that gap.

> [!bridge] You already know this — from the Linux course
> The CPU in front of you has been doing this since the 1990s. It guesses which
> way a branch will go, runs ahead down the predicted path, and squashes the
> results when the guess was wrong — because the execution units would otherwise
> have idled waiting for the comparison to retire. Same trade, same reason:
> spare capacity is worthless unless you spend it on a guess. What differs is
> the cleanliness of the rollback. A mispredicted CPU path leaves
> microarchitectural traces that turned into a decade of Spectre-class
> vulnerabilities; a rejected draft token leaves nothing behind but some KV
> cache entries the engine rolls back, and the accepted output is provably
> identical to what you would have got without speculating.
> [→ Linux: CPU Vulnerability Mitigations](../#/cpu-mitigations)

## The mechanism: guess cheap, check in bulk

Two models. A **target** — the big model whose output you actually want. And a
**draft** — something much cheaper that guesses what the target will say. The
loop:

```text
draft proposes γ tokens (cheap, sequential, but small):
     "the"  "cat"  "sat"  "on"          (γ = 4 guesses)

target scores all 4 in ONE forward pass (the expensive weight-read,
     paid once, now covering 4 positions instead of 1):
     ✓ "the"   ✓ "cat"   ✗ "sat"→"ran"   (stop at first reject)

accepted: "the" "cat", then "ran" from the target itself.
→ 3 tokens produced for the price of one target pass.
```

The draft runs γ small steps (say γ = 4); the target then does **one** pass
scoring all γ positions at once. You walk the proposals left to right, accepting
or rejecting each. On the first rejection you discard the rest of the draft (they
were conditioned on a token that didn't survive) and emit one token from the
target instead. Next round, the draft resumes from there.

![Two stacked timelines. Ordinary decode spends one full target forward pass per token, five passes for five tokens. Speculative decoding with gamma equal to 4 runs four cheap draft steps proposing "the", "cat", "sat", "on", then one target pass that verifies all four positions at once: "the" and "cat" are accepted, "sat" is rejected and replaced by the target's own correction "ran", and "on" is discarded because it was conditioned on the rejected token — three tokens emitted for one target pass, and the same tokens the target would have produced alone](assets/diagrams/spec-decode-timeline.svg)

The magic is entirely in the accept/reject rule. Get it wrong and you've built a
faster model that says different things — worthless. Get it right and the output
is *bit-for-bit* the target's own distribution. That rule is the theorem.

## The theorem: lossless by construction

This is one of the most elegant results in the field, and the course does real
math, so let's earn it. Write **p(x)** for the target's probability of token `x`
at this position, and **q(x)** for the draft's. The draft samples a token `x`
from `q`. The rule ([Leviathan et al. 2023](https://arxiv.org/pdf/2302.01318),
[Chen et al. 2023](https://arxiv.org/pdf/2302.01318)):

- **Accept** `x` with probability **min(1, p(x)/q(x))**.
- If **rejected**, don't just retry — sample a replacement from the *residual*
  distribution **r(x) ∝ max(p(x) − q(x), 0)**, normalized to sum to 1.

The claim: a token emitted by this procedure is distributed **exactly** as `p`.
Not approximately. Not "close in perplexity." Identically. Here's the whole
proof — it fits in four lines.

The probability we output a specific token `x` has two paths: the draft proposed
it *and* it was accepted, or the draft was rejected *and* the residual landed on
`x`.

```text
P(propose x and accept) = q(x) · min(1, p(x)/q(x)) = min(q(x), p(x))
P(reject overall)       = 1 − Σ min(q,p) = Σ max(p − q, 0) ≡ β
P(reject then residual→x)= β · [max(p(x)−q(x),0) / β] = max(p(x)−q(x), 0)

P(output x) = min(q(x),p(x)) + max(p(x)−q(x),0) = p(x)   ✓
```

That last equality is just case analysis: if `p(x) ≥ q(x)`, the terms are
`q(x) + (p(x)−q(x)) = p(x)`; if `p(x) < q(x)`, they're `p(x) + 0 = p(x)`. Either
way, `p(x)`. The normalizing constant `β` cancels perfectly — that's the trick
that makes it exact rather than merely unbiased. The draft's errors are *exactly*
corrected by the residual resample. **Speculative decoding does not approximate
the target; it is an alternate sampler for the identical distribution.**

### A three-token worked example

Vocabulary `{A, B, C}`. Target `p = [0.5, 0.3, 0.2]`, draft `q = [0.4, 0.4, 0.2]`.

- Draft proposes **A**: accept prob `min(1, 0.5/0.4) = 1`. Always accepted — the
  draft under-weighted A, so every proposed A is kept.
- Draft proposes **B**: accept prob `min(1, 0.3/0.4) = 0.75`. Kept 75% of the
  time. On the 25% rejection, resample from `r ∝ max(p−q,0) = [0.1, 0, 0]` →
  normalized `[1,0,0]` → emit **A**.
- Draft proposes **C**: accept prob `min(1, 0.2/0.2) = 1`.

Tally **A**: the draft yields it directly when it proposes A (`0.4`, always
accepted), plus the rejection path — total rejection probability is `1 −
(0.4+0.3+0.2) = 0.1` and the residual always emits A. So `P(A) = 0.4 + 0.1 = 0.5`
= `p(A)`. Likewise `P(B) = 0.4·0.75 = 0.3`, `P(C) = 0.2`. The output is exactly
`[0.5, 0.3, 0.2]` — the target — though every token came from the cheap draft.

> **Common trap:** "speculative decoding is a quality/speed trade-off like
> quantization." No. [Quantization](#/quantization) changes the numbers and can
> silently degrade hard reasoning. Speculative decoding changes *nothing* about
> the output distribution — the proof above holds for any draft, even a terrible
> one. A bad draft costs you **speed**, never **accuracy**. That decoupling is
> the whole reason it's safe to deploy by default.

## The speedup arithmetic

Losslessness is free; speed is not. Let **α** be the acceptance rate (the average
probability a proposed token survives) and **γ** the number of tokens drafted per
round. Modeling acceptances as independent, the expected number of tokens produced
per target pass is:

```text
E[tokens per pass] = (1 − α^(γ+1)) / (1 − α)
```

Plug in α = 0.8, γ = 4: `(1 − 0.8⁵)/(1 − 0.8) = (1 − 0.328)/0.2 = 3.36`. One
expensive weight-read now yields **3.36 tokens** instead of 1. That's the gross
win. The net win subtracts the draft's cost. If the draft runs at cost ratio
`c = (draft pass)/(target pass)` and takes γ steps, wall-clock speedup is roughly:

```text
speedup ≈ E[tokens per pass] / (1 + c·γ)
```

The denominator names the two ways it goes wrong:

- **Accurate but slow draft.** A draft that's 30% of the target's size (`c ≈ 0.3`)
  might hit α = 0.9 — but `1 + 0.3·4 = 2.2`, so even 4-plus tokens per pass
  barely nets 2×. High acceptance can't outrun a heavy draft. The draft must be
  *tiny*, an order of magnitude cheaper, or its own runtime eats the prize.
- **Fast but wrong draft.** A near-free draft (`c ≈ 0`) with α = 0.4 produces
  `(1−0.4⁵)/0.6 ≈ 1.66` tokens per pass — and half your drafted compute is
  thrown away on rejects. Below α ≈ 0.5 the bookkeeping overhead (extra draft
  passes, rejected-token compute, resampling) starts to *lose* to plain decoding.

The sweet spot is a draft that is both cheap **and** well-aligned with the target
— which sounds impossible until you see how the family tree chases exactly that.

## The family tree

**Independent draft model.** The original recipe: a small separate model (say a
1B drafting for a 70B). Two pains — you must *have* a small model speaking the
target's exact **vocabulary** (the token-ID tables must match, or proposals are
meaningless), and a generic small model often mispredicts the big one, capping α.

**Medusa.** Instead of a whole second model, bolt **extra prediction heads** onto
the target itself — head 2 guesses the token after next, head 3 the one after
that. Nearly free to run; trained on top of a frozen model. To lift acceptance it
verifies a small **tree** of candidate continuations at once rather than a single
line (more on tree verification below).

**EAGLE (1 → 3).** The key insight: draft at the **feature level**, not the token
level. A token is a lossy, discrete summary; the model's internal **hidden state**
(the rich vector it computes before projecting to a token) carries far more of
what the target is "about to do." EAGLE's drafter predicts the *next hidden
feature* and reuses the target's own output layer, so its guesses live in the
same representational space as the target — which is precisely why acceptance
climbs. EAGLE-2 made the draft tree dynamic; EAGLE-3 fuses features from multiple
layers and is, in mid-2026, the **de-facto production standard**, shipping in
vLLM, SGLang (`--speculative-algorithm EAGLE3`), and TensorRT-LLM.

**MTP (multi-token prediction).** Here the draft heads are trained **jointly with
the base model**, not bolted on afterward — so they're maximally aligned by
construction. [DeepSeek-V3](https://arxiv.org/pdf/2412.19437) ships an MTP module
in the open weights: second-token acceptance around 85–90%, worth roughly **1.8×**
tokens/sec in real serving. That 1.8× — not the flashier headline numbers — is
the honest figure for spec-dec *shipped inside a frontier model* under production
conditions.

**N-gram / prompt-lookup.** No draft model at all: propose the next few tokens by
**copying from the context** — if the last few tokens just appeared earlier in the
prompt or output, guess what followed them there. Free, and it wins big exactly
when output echoes input: summarization, retrieval-augmented generation (RAG),
and code editing where the model reproduces long spans of the file it was given.

**Tree speculation and dynamic γ.** Rather than one linear guess, propose a *tree*
of continuations and verify them together in a single pass with a masked
attention pattern — more chances to land a long accepted path. And γ needn't be
fixed: draft further when acceptance is running high, cut it short when the model
gets uncertain. The mechanics of verifying a tree and rolling back the
[KV cache](#/paged-kv-cache) on a rejection belong to the engine —
[Anatomy of a Serving Engine](#/anatomy-of-an-engine) owns that plumbing.

## The batch-size inversion

Now the section most write-ups skip, and the reason "does spec-dec help?" has no
context-free answer. Everything above assumed the target GPU was **idle** — the
low-batch, latency-bound world where decode is bandwidth-bound and the math units
starve. There, verifying γ tokens rides on the free FLOPs, and you get the famous
**2–4× latency** wins. **Every headline number lives here.**

Turn up the concurrency. [Continuous batching](#/continuous-batching) packs many
requests into each weight-pass; at high batch the GPU stops being bandwidth-bound
and becomes **compute-bound** — the math units are now *full*, because dozens of
requests supply plenty of work per weight-read. The idle FLOPs speculation was
spending are gone, and now the draft's compute and every rejected token's wasted
compute are **pure overhead** competing with real work. In this regime speculative
decoding can *reduce* throughput — you pay extra to produce tokens you throw away,
on a machine that had nothing to spare.

> **State of play (mid-2026) — treat these as rules of thumb, not constants.**
> Practitioner heuristics: you need α ≥ ~0.6 and γ ≥ ~5 for a solid win; below
> α ≈ 0.5 speculation actively hurts; and many teams **disable it above ~32
> concurrent requests**. These thresholds are model-, hardware-, and
> workload-dependent — they're starting points for measurement, not published
> laws. Measure your own crossover; don't inherit someone else's number.

![Wall-clock speedup from speculative decoding plotted against batch size on a log axis. The curve starts near 2.3x at batch 1, falls steadily as concurrency rises, crosses 1.0x at about batch 32 — the "disable above ~32" rule of thumb — and keeps falling into a shaded region below 1.0x where speculation is a net slowdown, reaching roughly 0.22x at batch 256. Same draft, same target model; only the batch size changes](assets/diagrams/spec-speedup-vs-batch.svg)

> [!bridge] You already know this — from the Linux course
> `SCHED_IDLE` is the same economics. A task in that class runs only on cycles
> nothing else wants: free when the machine is quiet, and a straight tax on
> everyone else the moment it isn't — which is why you put background work
> there and never latency-critical work. Speculative decoding is `SCHED_IDLE`
> for FLOPs. What differs is that the kernel *enforces* the priority for you,
> and here nothing does: at batch 64 the draft and the rejected tokens compete
> with real requests at equal priority, and the scheduler has no idea it is
> spending your throughput on a guess. You are the one who has to turn it off.
> [→ Linux: CPU Scheduling](../#/scheduling)

And the counter-twist, because reality enjoys symmetry: **very long context flips
it back on.** With a huge KV cache, each decode step must stream that enormous
cache out of HBM — so even at high batch you're *bandwidth-bound again*, this time
on the KV cache rather than the weights. The idle-FLOP condition returns, and
speculative decoding helps throughput once more
([MagicDec](https://infini-ai-lab.github.io/MagicDec-part2/)). The takeaway isn't
a threshold to memorize; it's a **discipline**: speculative decoding is a
*latency* tool first, its benefit tracks how idle your math units are, and that
depends on batch size **and** context length together. Measure, don't assume.

> **What actually ships (mid-2026):** paper and vendor headlines quote **2–5×**,
> almost always single-stream on a low-batch, favorable workload (EAGLE-3's
> "4.79× on Llama-3.3-70B" is exactly this kind of best case). Production serving
> at moderate concurrency sees **1.5–2.5×** on latency, tapering toward ~1× — or
> negative — as batch grows. DeepSeek-V3's built-in MTP at ~1.8× is the number to
> anchor on. If a pitch quotes 4× without stating the batch size, it's a
> low-batch number.

The inversion is easier to believe once you have watched it happen. Turn the
**speculative decoding** toggle on with the arrival rate down at 2 req/s and the
spec-versus-no-spec readout swings strongly positive — idle math units, verified
tokens riding free. Leave it on and drag the arrival rate up past the knee and
the same readout goes negative, with nothing special-cased to make it do so: the
draft's FLOPs are simply coming out of a budget that is already full. Preset 6
("speculation past the knee") starts you on the wrong side of it.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

## Neighbors, in one breath

Speculative decoding sits among other "make the model cheaper" levers.
**Distillation** — training a small model to mimic a big one — is in practice the
highest-ROI lever of all: it yields a cheaper model outright *and* excellent,
well-aligned drafts for speculation, so the two compound. **2:4 structured
sparsity** (forcing two of every four weights to zero for a hardware speedup)
remains mostly aspirational: the hard 50% constraint dents quality and needs
retraining, with real end-to-end gains still around ~1.2×.
**Early exit** (stopping at a middle layer when confident) has largely been
absorbed into *self-speculation* — a model drafting for itself with its own
shallow layers is just early-exit wearing the accept/reject rule, and that's the
version that reached production.

## What to remember

- **The gap it exploits:** generation is sequential, but **verification is
  parallel** — checking γ guesses costs one target forward pass, and at low batch
  that pass's idle FLOPs are already paid for.
- **Lossless by construction:** accept with `min(1, p/q)`, on rejection resample
  from `max(p−q, 0)` normalized. The output is *exactly* the target distribution
  — a bad draft costs speed, never quality. This is a theorem, not a benchmark.
- **Speedup:** `(1−α^(γ+1))/(1−α)` tokens per pass, divided by draft overhead
  `(1+cγ)`. Two failure modes: accurate-but-heavy drafts (overhead eats the win)
  and fast-but-wrong drafts (α too low, wasted compute).
- **The family:** independent drafts (vocab pain) → Medusa (bolt-on heads) →
  **EAGLE-3** (feature-level draft, today's standard) → **MTP** (heads trained
  with the model, ships in DeepSeek-V3 at ~1.8×) → n-gram (free, wins on RAG/code).
- **The inversion:** a **latency** tool. Big wins at low batch; overhead —
  possibly negative — at high batch; and long context flips it helpful again.
  Measure your crossover.

## Exercises

<div class="exercise">

**Exercise 1.** You are serving a 70B target at low batch. Your drafter proposes
**k = 5** tokens per round and each proposed token survives verification with
probability **α = 0.7**. (a) How many tokens do you get per target forward pass?
(b) The draft costs **5%** of a target pass (`c = 0.05`). What is the wall-clock
speedup? (c) A colleague proposes swapping in a much better drafter: **α = 0.9**,
but it is a 25%-of-target-size model (`c = 0.25`), same k = 5. Is that an
upgrade?

<details>
<summary>Reveal answer</summary>

**(a) Tokens per pass.** Acceptances are modelled as independent, so the
expected number of tokens emitted per verification is the geometric sum
`(1 − α^(k+1)) / (1 − α)`:

```text
   0.7⁶ = 0.117649
   E = (1 − 0.117649) / (1 − 0.7) = 0.882351 / 0.3 = 2.94 tokens
```

Just under three tokens for one expensive weight-read.

**(b) Wall-clock speedup**, dividing by the draft overhead `1 + c·k`:

```text
   1 + 0.05 × 5 = 1.25
   speedup = 2.94 / 1.25 = 2.35×
```

**(c) The better drafter.** Recompute both halves:

```text
   0.9⁶ = 0.531441
   E = (1 − 0.531441) / (1 − 0.9) = 0.468559 / 0.1 = 4.69 tokens
   1 + 0.25 × 5 = 2.25
   speedup = 4.69 / 2.25 = 2.08×
```

**No — it is a downgrade: 2.35× becomes 2.08×.** The gross win improved by 59%
(2.94 → 4.69 tokens per pass) and the net win still fell, because the overhead
term grew by 80% (1.25 → 2.25). This is the "accurate but slow draft" failure
mode with numbers attached: acceptance enters through a saturating function —
`E` can never exceed `1/(1−α)` no matter how long you draft — while draft cost
enters linearly and without limit. **Cheapness beats accuracy in this trade far
more often than people expect.**

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>How do I find out what my acceptance rate actually is?</summary>

You don't derive it, you read it: every engine that implements speculation
exposes an acceptance metric, usually as an acceptance rate per proposed token
or as a mean accepted length per verification. If you only have the latter,
that number *is* the `E` in the formula above — invert it to recover α rather
than guessing. Expect it to move a lot with workload: drafting for code
completion or RAG-style summarization, where the output echoes the input, lands
far higher than open-ended chat. Measure it on your traffic, not on a benchmark
prompt set.

</details>

<details>
<summary>If longer drafts mean more tokens per pass, why not set k = 20?</summary>

Because the two sides of the ratio grow differently. As k rises, `(1 − α^(k+1))
/ (1 − α)` climbs toward a hard ceiling of `1/(1−α)` — at α = 0.7 that is 3.33
tokens, and k = 5 already gets you 2.94 of them. Every extra draft step past
that buys almost nothing while adding a full `c` to the denominator, and each
one also costs a sequential draft forward pass on the latency path. That is why
production drafts are short, and why dynamic γ — draft further only while
acceptance is running high — is the version that actually helps.

</details>

<details>
<summary>Does speculative decoding cost extra memory?</summary>

Yes, and it is easy to forget when you are budgeting. An independent draft model
brings its own weights *and* its own KV cache; the target must hold KV slots for
the γ+1 verified positions per in-flight sequence, and the engine needs the
bookkeeping to roll those slots back on a rejection. That memory comes out of
the pool your concurrent sequences were sharing, so speculation can quietly cost
you a few slots of batch — the resource whose scarcity was already the argument
for turning it on. Bolt-on heads (Medusa, EAGLE, MTP) exist partly to make this
bill small.

</details>

</div>

```quiz
[
  {
    "q": "Why is speculative decoding described as 'lossless by construction' rather than a speed/quality trade-off?",
    "choices": [
      "The draft model is trained to match the target's outputs within a small error bound",
      "The accept/reject rule (accept with min(1, p/q), resample rejects from the normalized residual max(p−q,0)) makes the emitted token distributed exactly as the target's p — for any draft",
      "It only accepts tokens where the draft and target agree with probability 1",
      "The target model re-runs any token the draft got wrong, averaging out the error"
    ],
    "answer": 1,
    "explain": "The proof: P(output x) = min(q,p) [proposed and accepted] + max(p−q,0) [rejected then residual] = p(x) exactly, in both cases p≥q and p<q. The normalizer cancels, so it's exact, not approximate. A worse draft lowers the acceptance rate — costing speed — but never changes the distribution."
  },
  {
    "q": "With acceptance rate α = 0.8 and draft length γ = 4, how many tokens does one target forward pass yield on average, and what caps the real speedup?",
    "choices": [
      "Exactly 4 tokens; nothing, the draft is free",
      "About 3.36 tokens via (1−α^(γ+1))/(1−α), but the draft's own compute cost (the 1+cγ denominator) caps the net wall-clock gain",
      "About 0.8 tokens, since only 80% of one token is accepted",
      "About 5 tokens, one per draft step plus a bonus, with no offsetting cost"
    ],
    "answer": 1,
    "explain": "(1 − 0.8⁵)/(1 − 0.8) = 0.672/0.2 = 3.36 tokens per expensive weight-read. But you still ran the draft γ times, so wall-clock speedup ≈ 3.36 / (1 + c·γ). A heavy draft (large c) can erase the gain even at high acceptance."
  },
  {
    "q": "Why does speculative decoding's benefit shrink — even go negative — as batch size increases?",
    "choices": [
      "The draft model runs out of memory when many requests share it",
      "At high batch the GPU becomes compute-bound (math units full), so the previously-idle FLOPs that verification rode for free are gone, and draft + rejected-token compute become pure overhead",
      "Acceptance rate always falls as batch size rises",
      "The rejection-sampling proof only holds for a batch size of one"
    ],
    "answer": 1,
    "explain": "At low batch decode is bandwidth-bound: the weight-read dominates and the math units are ~99% idle, so verifying γ tokens is nearly free. Continuous batching fills those units; now speculation's extra compute competes with real work and can reduce throughput. The proof holds at any batch — only the economics change."
  },
  {
    "q": "What makes EAGLE's feature-level drafting achieve higher acceptance than an independent small draft model?",
    "choices": [
      "It uses a larger draft model, so its guesses are simply more accurate",
      "It predicts the target's next hidden-state feature and reuses the target's own output layer, so its proposals live in the same representational space as the target — closer alignment, higher α",
      "It skips the accept/reject step entirely for speed",
      "It only drafts tokens that appeared earlier in the prompt"
    ],
    "answer": 1,
    "explain": "A token is a lossy discrete summary; the hidden state carries much more of what the model is about to do. Drafting at the feature level and sharing the target's output projection aligns the draft with the target's actual distribution, raising acceptance. That last option describes n-gram/prompt-lookup, a different family."
  },
  {
    "q": "A vendor advertises '4.79× faster with speculative decoding.' What's the first question to ask?",
    "choices": [
      "Which quantization format was used",
      "At what batch size / concurrency — headline multipliers are single-stream, low-batch best cases, and production at moderate concurrency is typically 1.5–2.5×, tapering toward 1× or worse as batch grows",
      "Whether the output quality was degraded to achieve it",
      "How many GPUs were in the cluster"
    ],
    "answer": 1,
    "explain": "Speculative decoding is lossless, so quality isn't the variable — batch size is. Headline numbers come from the low-batch, latency-bound regime where idle FLOPs make verification free. DeepSeek-V3's built-in MTP at ~1.8× in real serving is the honest anchor for production conditions."
  }
]
```
