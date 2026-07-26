# Did Quantization Break Your Model?

> **Goal of this chapter:** answer the question every quantized deployment
> eventually has to answer, and answer it honestly. By the end you will know why
> the field's default quality metric is nearly useless here, why the damage
> scales with how hard the task is, why a model that "recovered" by thinking
> longer may have cost you money rather than saved it, how a *kernel* rather than
> a format lost a 91% score, and exactly what to measure before you ship.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner"></div>

[Quantization](#/quantization) gave you the formats and the arithmetic: fewer
bits, fewer bytes, faster decode, more concurrency. Every number in that chapter
was a division. Not one of them said anything about whether the model still gets
the answer right.

That is this chapter. It is the harder half, because quantization damage is
**silent by default**. Nothing crashes. No warning is logged. The model keeps
producing fluent, confident, plausible text — it just gets a little worse at the
things you actually deployed it for, and the standard way people check misses it
completely.

> [!bridge] You already know this — from the distributed course
> This is the Byzantine failure model, arriving where you did not expect it. A
> crash-stop failure announces itself and is easy to build around; a component
> that keeps answering, in the right format, at the right latency, with answers
> that are quietly wrong is the expensive class — which is why that chapter
> reaches for checksums at every layer rather than trusting the wire. A
> quantized model is exactly that component, and this chapter's harness is your
> checksum. What differs is that you cannot verify a token against a hash; the
> only detector you have is a comparison against a baseline you kept runnable.
> [→ Distributed: Failure Models & Detection](../distributed/#/failure-models)

## Perplexity lies

The default way people check "did quantization hurt?" is **perplexity** (PPL) —
roughly, how surprised the model is by held-out text. It is cheap, standard, and
for judging quantization **nearly useless.** PPL averages next-token loss over
ordinary text, where almost any quantization looks fine, and misses exactly where
low-bit models break: long chains of exact reasoning.

Look at what averaging does. A perplexity run over a few hundred thousand tokens
of web text is dominated by tokens that are *easy* — the second half of a common
word, the closing quote after a quotation, the word "the." A model that has lost
some precision still nails those, because the correct answer was miles ahead of
the alternatives and a little numerical noise does not close that gap. Those
tokens are the overwhelming majority, so they set the average.

The tokens where quantization actually bites are the ones where two candidates
were nearly tied and the right one won by a hair — a carry in an arithmetic step,
the choice between two lemma names, which of three retrieved facts is the
relevant one. Rounding error flips those. But they are rare, so flipping them
moves the mean loss by a fraction of a percent, and perplexity reports "fine."

This is the general shape of the problem, and it is worth stating on its own:

> [!trap] An average over easy cases cannot see damage in the tail
> Perplexity is a mean, and the mean is set by the common case. Quantization
> damages the *decisions that were close*, which are rare in ordinary text and
> concentrated in exactly the tasks people deploy models for. A metric can be
> flat and a capability can be gone at the same time, with no contradiction.

And a chain of reasoning multiplies this. If a 10-step derivation needs all ten
steps right, and quantization takes each step from 99% to 97%, end-to-end
accuracy falls from 90% to 74% — a 16-point collapse built entirely out of
per-token changes too small for perplexity to notice.

## The evidence: flat perplexity, collapsed accuracy

The numbers are stark. A study of 3-bit AWQ found perplexity essentially flat
while **MATH-500 accuracy collapsed from 85.6% to 47.0%** — and the model
*inflated* its chain-of-thought from 5.2K to **23.4K tokens (4.5×)** trying to
compensate. PPL saw none of it. **[from arXiv 2606.25519.]**

Read that twice. The metric everyone reports said nothing happened. The
capability the model was chosen for lost nearly half its accuracy. And a third
thing happened that nobody was measuring at all.

Two lessons hide in that one result, and each deserves its own section.

## Lesson one: degradation scales with task hardness

**The same quantization costs more the harder the task is.** The same setting
that costs ~7% on grade-school GSM8K costs ~15% on MATH and can drive
competition-level AIME to **total failure**. An easy eval blesses a model that
falls apart on hard ones.

This is not a mysterious property of low-bit arithmetic; it falls straight out of
the chain argument above. An easy task is a short chain with wide margins at
every step, so rounding noise never flips anything. A hard task is a long chain
with narrow margins, and the failure probability compounds along it. Task
difficulty *is* chain length times margin narrowness, which is precisely what
quantization attacks.

The practical consequence is uncomfortable, because it inverts the usual
convenience ordering. The evals that are cheap to run and quick to interpret are
the easy ones, and they are the ones with no diagnostic power. **The only evals
that tell you anything are the expensive ones.** If your quantized model scores
identically on GSM8K, you have learned that it can still do arithmetic a child
can do. You have learned nothing about the workload you are deploying it for.

The same slope shows up across every axis of difficulty, not just math:

- **Long context.** Retrieval over 128K tokens is a harder discrimination than
  retrieval over 4K — more distractors, thinner margins. Degradation is
  systematically worse at long context than short. The next section is an
  extreme case of exactly this.
- **Multilingual.** Quality loss is consistently larger on languages that were a
  smaller share of pretraining. The mechanism is the same margin story: the model
  is less certain in a low-resource language to begin with, so it has less
  headroom to spend on rounding error. Reported degradations on non-English
  evaluation sets run several times the English figure for the same setting.
  **[directional — the effect is well attested across model reports, but the
  multiplier varies enormously by language and model and no single number should
  be quoted.]** If you serve a multilingual product, an English-only eval of a
  quantized model is not an eval.
- **Agentic and tool-use.** A tool call is a long exact string: a function name,
  a schema-valid argument object, a well-formed JSON close. Every character is a
  narrow-margin decision, and one wrong one fails the whole call. Agentic
  workloads sit at the hard end of this scale, and they are usually the last
  thing anyone thinks to evaluate.

## Lesson two: count the tokens

This is the sharpest point in the material, and it is the one most often missed.

**A quantized reasoning model can recover accuracy by thinking longer.** That
sounds like a happy ending — the model compensates, the score comes back, no harm
done. It is not a happy ending. Those extra tokens are a hidden tax, and it can
cancel or reverse the entire speedup you quantized for.

Do the arithmetic, because it is the only way to see how large the effect is. You
are serving a 70B reasoning model and you move from BF16 to FP8. From
[Quantization](#/quantization), the batch-1 decode step goes from ~42 ms to ~21
ms: each token is **2× cheaper**. Now suppose the quantized model needs more
tokens to reach the same answer. What you actually care about is the time and the
cost of a whole *response*, which is tokens × cost-per-token:

```text
   net speedup  =  per-token speedup  ÷  token inflation factor
```

| Token inflation | Net speedup at 2× per-token | Verdict |
|---|---|---|
| 1.0× (no inflation) | 2.00× | the win you were promised |
| 1.2× | 1.67× | still good |
| 1.5× | 1.33× | most of the win is gone |
| **2.0×** | **1.00×** | **break-even — you gained nothing** |
| 4.5× (the 3-bit AWQ case) | 0.44× | **2.25× slower and 2.25× more expensive** |

The break-even is at token inflation equal to your per-token speedup. Below it
you win; above it you have paid engineering effort, accuracy risk, and an
evaluation campaign in order to make your service **slower**.

The 4.5× row is not hypothetical — that is the measured chain-of-thought
inflation from the 3-bit AWQ study, and it was measured on a model whose accuracy
had *also* collapsed. That configuration was worse on both axes at once, and the
metric everyone reports said it was fine.

Three things follow, and they are not obvious:

- **Latency is worse than the cost figure suggests.** Cost scales with total
  tokens; user-visible latency scales with total tokens too, but users experience
  it as a wait. A 2.25× longer response is a 2.25× longer wait, and TTFT — the
  metric you were probably watching — did not move at all, because prefill got
  faster.
- **The effect is invisible to accuracy evals.** A model that recovers its score
  by generating 4× the tokens scores the *same*. If your eval harness reports
  only accuracy, it reports a tie for a configuration that is far worse.
- **It hits reasoning models hardest, which are the ones you most want to
  quantize.** Long-chain-of-thought models are expensive precisely because they
  emit thousands of decode tokens, so they are the obvious quantization target —
  and they are the ones with a token budget elastic enough to absorb the damage
  and hide it.

**[the "token-inflation tax" framing is contested, but the length blow-up itself
is real and has been reproduced.]** So measure it. Generated-token count per
task, quantized versus baseline, is one line in an eval harness and it is the
cheapest insurance in this chapter.

> [!trap] "Accuracy held, so we shipped it"
> Accuracy held *at unbounded token budget*. Re-run the same eval with a hard cap
> on generated tokens — the cap your product actually enforces — and the
> quantized model's recovered accuracy often evaporates, because the mechanism it
> was using to recover was the budget you just took away.

## The 91% → 13% → 89% story: correctness lives in kernels too

Correctness doesn't only live in the format — it lives in the **kernels**. vLLM
documented FP8 KV cache on Hopper silently collapsing at long context:
128k-token needle-in-a-haystack retrieval fell from **91% (BF16) to 13%**. The
format was fine; the *kernel* accumulated over the long context in low-precision
registers and lost the needle. The [two-level accumulation](#/flashattention) fix
— promote partial sums to real FP32 — restored it to **89%**. Perplexity, of
course, looked perfect throughout.

Sit with the shape of that. FP8 KV cache is the *safest* thing in the previous
chapter — the near-lossless default, the one vLLM turns on for you. And in one
specific kernel, at one specific context length, it went from working to
essentially random, then back to working, with **no change to the format at
all**. The bits stored in the cache were the same bits in all three
configurations.

What changed was the accumulator. Attention over a 128K context is a sum with
128K terms. Each term is small; each rounding error is tiny; but they accumulate,
and in a narrow register the running total eventually stops being able to
represent the difference between "this key matched" and "this key did not."
Two-level accumulation — exactly the DeepSeek trick from the previous chapter,
promoting partial sums to an FP32 accumulator every so often — fixes it, because
FP32 has range to spare for the total while the products stay cheap.

The general lesson is broader than KV cache:

- **A format is a claim about representation; a kernel is a claim about
  execution.** They fail independently. You can validate the format perfectly and
  still lose the model to the kernel that consumes it.
- **The failure mode was length-dependent.** At 4K context the same kernel was
  fine. Anything that only breaks past a threshold will pass every short test you
  run.
- **Therefore: evaluate the deployment, not the checkpoint.** Your engine, your
  version, your kernel selection, your context length, your batch size. A quality
  number measured on a different stack is a number about a different system. An
  engine upgrade is a reason to re-run the evals, not a reason to trust the old
  ones.

> [!bridge] You already know this — from the Linux course
> Two habits from performance methodology transfer intact. **Workload
> characterization** — measure what the system actually does, at the sizes it
> actually does it, rather than what the benchmark suite finds convenient — is
> the whole content of "your hardest real task, at your real context length."
> And the warning that a mean hides the tail is the same warning perplexity
> earns here. What differs is the direction of the danger: a latency
> investigation goes wrong when a metric looks *bad* for an uninteresting
> reason, and a quantization evaluation goes wrong when every metric looks
> *good* and the capability is gone anyway.
> [→ Linux: Performance Analysis Methodology](../#/perf-methodology)

## What to actually measure

Here is the harness. It is not long, and every line of it exists because
something in this chapter would otherwise have gone undetected.

**1. Your hardest real task, not a benchmark.** Take the actual workload — the
prompts your product sends, at the length it sends them — and score it. If you
must use public evals, pick the ones at the top of the difficulty range for your
domain, because the easy ones cannot resolve the damage.

**2. Long context, at your real maximum.** Needle-in-a-haystack at the context
length you advertise, not at 4K. This is the test that catches kernel
accumulation bugs, and it is the one nobody runs until after the incident.

**3. Generated-token count, per task, both configurations.** One extra column in
the results table. Divide your per-token speedup by the inflation factor to get
the number you actually care about.

**4. The same eval under your production token cap.** Not unbounded. If your
product cuts a response off at 4,000 tokens, evaluate at 4,000 tokens, so that
"recovered by thinking longer" cannot silently pass.

**5. Every language you serve, weighted by traffic.** An English-only eval on a
multilingual product measures a fraction of your users.

**6. Structured-output validity, if you use it.** Rate of schema-valid tool calls
and parseable JSON. This is a cheap, fast, brutally sensitive metric, because it
is pass/fail on exact strings.

**7. The tail, not the mean.** Report the worst decile of your task set alongside
the average. Quantization damage concentrates in the hard cases, so a mean over a
mixed eval suite reproduces perplexity's exact failure at a higher level.

**8. An A/B against the unquantized model on live traffic, if you can.** The only
measurement with no proxy in it. Watch retry rate, conversation length, and
thumbs-down rate; users detect degradation you did not think to test for.

And one process rule, which matters more than any single metric: **keep the BF16
baseline runnable.** The entire harness above is comparative. A quality number
without a same-day baseline on the same stack is uninterpretable, and the moment
the baseline becomes expensive to run is the moment you stop being able to answer
the question in this chapter's title.

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

> **State of play (mid-2026), the safe map from a COLM 2025 sweep:**
> **W8A8KV8** and **W4A16** are near-lossless across the board. **W4A4KV4** is
> risky — about 2.3% loss on a 32B model but **over 10% on a 7B**, and ~4× worse
> on hard tasks (AIME) than easy ones (GSM8K). **3-bit anything is a cliff —
> avoid it.** Smaller models and reasoning models are the fragile cases.

Notice the pattern in the failure column: **the fragile cases are small models,
reasoning models, long contexts, and low-resource languages.** All four are
narrow-margin regimes. If your deployment is none of those — a large model, short
contexts, English, non-reasoning — you can be much bolder than the guide
suggests. If it is all four, be conservative and stay at 8 bits.

Matched to situations:

- **Serving a large model on Hopper or Blackwell, general workload.** FP8 W8A8
  with FP8 KV. Run the harness once to establish the baseline, then ship.
- **Memory is the binding constraint** — you want 70B on one GPU. W4A16, full
  activation precision. Prove it on long context specifically, since weight-only
  quantization does not touch the KV path but your engine change might.
- **Concurrency is the binding constraint** at long context. FP8 KV first; it is
  the highest capacity-per-unit-risk move available. Then measure
  needle-in-a-haystack at your real maximum length, because that is the exact
  configuration that produced the 13%.
- **A small model, or a reasoning model, and someone is proposing 4-bit
  weights-and-activations.** Ask what the alternative is. A larger model at 8
  bits is frequently both more accurate and, after token inflation, no more
  expensive.
- **Anything at 3 bits.** No. If you have measured it working on your hardest
  task, at your token cap, with your kernels, then you have earned it — and that
  sentence is the point.

A diagnostic for the community's favorite argument: **when someone says
"quantization ruined my model," the first question is *which regime were they
in?*** Near-lossless FP8 and a 3-bit reasoning-model catastrophe are both
"quantization" and share almost nothing. The regime is the whole story.

## What to remember

- **Perplexity lies.** It is a mean over easy tokens, and quantization damages the
  rare close decisions. Flat PPL alongside a collapsed capability is not a
  contradiction — it is the expected result. 3-bit AWQ held perplexity while
  MATH-500 fell 85.6% → 47.0%.
- **Damage scales with task hardness**, because hard tasks are long chains of
  narrow-margin decisions. ~7% on GSM8K, ~15% on MATH, total failure on AIME, for
  the same setting. The same slope applies to long context, low-resource
  languages, and tool-use.
- **Count the tokens.** Net speedup = per-token speedup ÷ token inflation.
  Break-even at 2× inflation for a 2× format win; the measured 4.5× inflation
  makes the quantized model 2.25× *slower and dearer*. Accuracy evals score this
  as a tie.
- **Evaluate under your production token cap**, or "recovered by thinking longer"
  passes silently.
- **Correctness lives in kernels too.** FP8 KV: 91% → 13% → 89% at 128K with the
  format unchanged; the fix was two-level FP32 accumulation. Evaluate the
  deployment — your engine, version, context length — not the checkpoint.
- **The harness:** hardest real task, long context at your real max, token
  counts, production cap, every language, structured-output validity, the worst
  decile not the mean, and a live A/B. Keep the BF16 baseline runnable, because
  every one of those numbers is only meaningful as a difference.
- **Fragile regimes are narrow-margin regimes**: small models, reasoning models,
  long context, low-resource languages. Away from all four, be bold; inside all
  four, stay at 8 bits.

## Frequently asked

<div class="faq">

<details>
<summary>Is there any use left for perplexity?</summary>

Yes, one: as a *smoke test*. Perplexity is sensitive to gross breakage — a
mis-specified scale, a transposed block, a calibration set that did not match the
model. If PPL moves a lot, something is badly wrong and you can stop before
running anything expensive. What it cannot do is the opposite inference. Flat
perplexity is not evidence of preserved quality, only the absence of evidence of
catastrophe.

</details>

<details>
<summary>How many evaluation samples do I need for the difference to mean anything?</summary>

Enough that the confidence interval is smaller than the effect you care about. A
2-point difference on a 200-sample eval is well inside the noise — the standard
error on a proportion near 0.8 at n=200 is about 2.8 points, so you cannot
distinguish a 2-point regression from nothing. Detecting a few points reliably
needs low thousands of samples, or paired evaluation on identical prompts with a
fixed seed, which removes most of the variance and is much cheaper. Paired,
seeded, same-prompt comparison is the right default.

</details>

<details>
<summary>The quantized model passes everything. Am I done?</summary>

Until something in the stack changes. The 91% → 13% result came from a kernel,
not a checkpoint, so your quality guarantee is scoped to the exact engine
version, kernel selection, context length, and batch shape you tested. Treat an
engine upgrade the way you treat a model change: re-run the harness. And keep
watching production, because the tail of real traffic is longer and stranger than
any eval set you will assemble.

</details>

</div>

```quiz
[
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
  },
  {
    "q": "FP8 makes each decode token 2× cheaper, but your quantized reasoning model now emits 2.5× as many tokens to reach the same answer. What happened to the cost of a response?",
    "choices": [
      "It fell 2×, since per-token cost is what you pay for",
      "It stayed the same, since accuracy was preserved",
      "It rose ~1.25×: net speedup is per-token speedup ÷ token inflation = 2 ÷ 2.5 = 0.8×, so responses are slower and dearer",
      "It cannot be computed without knowing the batch size"
    ],
    "answer": 2,
    "explain": "You pay for whole responses, not tokens. Net speedup = per-token speedup ÷ token inflation, so break-even sits at inflation equal to the format win — 2× here. At 2.5× inflation you are at 0.8×, meaning 1.25× the cost and 1.25× the wait. Accuracy evals score this configuration as a tie, which is exactly why generated-token count belongs in the harness."
  },
  {
    "q": "The same quantization setting costs ~7% on GSM8K, ~15% on MATH, and drives AIME to near-total failure. Why does damage scale with task hardness?",
    "choices": [
      "Harder benchmarks use longer prompts, and long prompts overflow the block scales",
      "Hard tasks are long chains of narrow-margin decisions, so small per-step error probabilities compound; easy tasks are short chains with wide margins that rounding noise never flips",
      "Hard benchmarks are graded more strictly, which is a scoring artifact rather than a real effect",
      "AIME problems are underrepresented in quantization calibration sets"
    ],
    "answer": 1,
    "explain": "Quantization perturbs decisions that were nearly tied. Easy tasks have wide margins and few steps, so nothing flips. Hard tasks chain many narrow-margin steps, and per-step failure compounds: 99%→97% per step over ten steps takes end-to-end accuracy from 90% to 74%. The same mechanism explains why long context, low-resource languages, and exact-string tool calls all degrade earlier."
  },
  {
    "q": "Your quantized model matches the BF16 baseline's accuracy on your eval suite. Which single change to the harness is most likely to reveal a problem that is really there?",
    "choices": [
      "Run perplexity on a larger held-out corpus",
      "Re-run the same eval with the generated-token cap your product actually enforces, and record token counts per task",
      "Increase the batch size during evaluation",
      "Evaluate the checkpoint on a different serving engine to get a second opinion"
    ],
    "answer": 1,
    "explain": "Matched accuracy at unbounded token budget is the classic false pass: the quantized model can recover its score by thinking longer, which costs real money and real latency and shows up nowhere in an accuracy column. Capping generation at the production limit removes the mechanism it was using to recover, and logging token counts quantifies the tax. Perplexity on more text repeats the metric that already failed."
  }
]
```
