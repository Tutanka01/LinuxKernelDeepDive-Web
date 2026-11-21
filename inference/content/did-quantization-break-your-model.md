# Did Quantization Break Your Model?

> **The question:** how do you prove that a quantized deployment still does the
> job you deployed it for — and which of the usual checks would tell you
> everything is fine when it is not?
>
> **You'll be able to:** predict which models, tasks and settings are fragile,
> and why averages over easy text miss the damage; compute the net speedup after
> token inflation; size a paired evaluation and read its result — flips and
> McNemar's test — against the noise floor of the unquantized model; write the
> evaluation plan that gates a quantized release.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner"></div>

[Quantization](#/quantization) was all division: fewer bits, fewer bytes, faster
steps, more users. Not one of those numbers said whether the model still gets the
answer right.

Quantization damage is silent. Nothing crashes, nothing is logged, and the model
keeps producing fluent, confident text — slightly worse at some things, sometimes
much worse at the things you deployed it for. It is the storage engineer's
silent data corruption, without a checksum: you cannot verify a generated token
against a hash. The only detector is a comparison against a baseline you kept
runnable.

## Why averages miss it

The cheapest check people run is **perplexity**: how surprised the model is, on
average, by held-out text. It is a mean over every token, and most tokens of
ordinary text are easy — the rest of a common word, a closing quotation mark,
"the". On those, the right token wins by a wide margin, and a little rounding
noise changes nothing. They dominate the average.

Rounding noise flips the *close* decisions: a carry in an arithmetic step, which
of two similar names, which retrieved fact applies. Those are rare in ordinary
text, so flipping them barely moves the mean. They are common in exactly the
tasks people deploy models for.

> [!predict] Before you read on
> A task needs ten reasoning steps, all correct. Quantization lowers the success
> rate of each step from 99% to 97% — a change too small to see in any per-token
> average. What happens to the task's success rate?

It falls from 90% to 74%: `0.99¹⁰ ≈ 0.90`, `0.97¹⁰ ≈ 0.74`. A 2-point change per
step becomes a 16-point change per task. Chains multiply small per-step losses,
which is why the damage concentrates in long, exact work — multi-step reasoning,
long-context retrieval, tool calls that must be character-perfect.

Accuracy itself can hide damage too. Dutta et al.
([Accuracy is Not All You Need, NeurIPS 2024](https://arxiv.org/abs/2407.09141))
found that compressed models with nearly the baseline's accuracy still changed
individual answers — correct to wrong *and* wrong to correct, cancelling in the
total. They call these **flips**, and propose flips and the KL divergence
between the two models' next-token distributions as the metrics to report
alongside accuracy; they found the two well correlated.

KL divergence is the cheap first screen, because it needs no reference answers.
Send the same text to both servers and ask each for its top-20 log-probabilities
at every position of the *prompt*, so both models are scored on identical
contexts:

```bash
curl -s localhost:8000/v1/completions -H 'Content-Type: application/json' -d '{
  "model": "llama-3.3-70b-fp8",
  "prompt": "<a 2,000-token document from your own traffic>",
  "max_tokens": 1,
  "prompt_logprobs": 20
}' | jq '.choices[0].prompt_logprobs[1:3]'
```

*Real format, illustrative values — request fields from vLLM v0.34.0 `vllm/entrypoints/openai/completion/protocol.py` (`prompt_logprobs` returns, per position, a map of token id to `logprob`, `rank` and `decoded_token`); the server caps the count at `--max-logprobs`, 20 by default.*

From the two responses compute, per position, whether the top token agrees, and
the KL divergence over the top-20 tokens. A quantized model that agrees on
99.9% of positions has told you little; one whose disagreements cluster in
numbers, names or JSON has told you where to look. Generated text would not do:
after the first different token the two models continue from different
contexts.

## The evidence: size and difficulty

The most systematic public sweep is Liu et al.,
[Quantization Hurts Reasoning?](https://arxiv.org/abs/2504.04823) (COLM 2025).
They quantized DeepSeek-R1 distilled reasoning models from 1.5B to 70B with
several methods and averaged accuracy over five benchmarks. Notation:
`W4A4KV4` means 4-bit weights, activations and KV cache; FlatQuant is the
paper's best method at that setting, a learned transformation that flattens
outliers before rounding. "Best method" is the best of those tested at each size.

| Configuration | 1.5B | 7B | 14B | 32B | 70B (Llama) |
|---|---|---|---|---|---|
| W8A8KV8 (best method) | +0.2 | −0.2 | +0.6 | −0.0 | +0.5 |
| W4A16 (AWQ) | −2.1 | −2.1 | −1.1 | −0.4 | −0.8 |
| KV4 only (best method) | −1.4 | −1.0 | −0.1 | −0.3 | −1.0 |
| W4A4KV4 (FlatQuant) | −10.9 | −11.8 | −3.0 | −2.9 | −2.5 |
| W3A16 (AWQ) | −18.6 | −6.3 | −6.2 | −3.9 | −6.2 |

*Points of average accuracy versus BF16, from the paper's Table 1 (Qwen-based
1.5B–32B) and Table 4 (R1-Distill-Llama-70B).*

> [!predict] Before you read on
> Under W4A4KV4, which loses more: a 1.5B model or a 32B model? And on which
> benchmark — grade-school arithmetic (GSM8K) or competition math (AIME)?

The small model, on the hard benchmark. At 32B, W4A4KV4 left GSM8K unchanged
(94.2 → 94.2) while AIME fell 3.9 points (61.7 → 57.8). At 1.5B, GSM8K fell 7.7
points (84.5 → 76.8) and AIME fell from 23.3 to 8.6 — losing nearly two-thirds of
its score. The same setting is harmless or ruinous depending on model size and
task difficulty. So: 8 bits is safe at every size in this sweep; 4-bit weights
are within about a point from 14B up; 4-bit activations and anything at 3 bits
cost several points to many. And an easy evaluation cannot see the damage: if
your quantized model matches the baseline on GSM8K, you have learned that it
still does grade-school arithmetic.

The same margin argument applies beyond math. Long-context retrieval has more
distractors and thinner margins than short. Languages that were a small share of
pretraining start with less certainty to spend. Tool calls are long exact strings
in which one wrong character fails the call.

## Count the tokens

A reasoning model whose steps got slightly worse can sometimes hold its accuracy
by **thinking longer**. Every extra token is paid for.

Lian et al. ([Quantization Inflates Reasoning, 2026](https://arxiv.org/abs/2606.25519))
measured this. At 4 bits with AWQ, where accuracy held within a point, reasoning
tokens still grew 8% on Qwen3-4B and 14% on Qwen3-30B; naive round-to-nearest
grew them ~43% on both (their Table 2). Their headline +276% is a different
regime: Qwen3-4B at 3 bits with AWQ, where AIME25 accuracy fell from 76.7% to
20.0% and outputs on two code benchmarks grew 4.6× and 10.6×. That is a broken model rambling, not
a working one recovering. Liu et al. saw the same divide: output lengths close to
baseline for 8-bit, 4-bit weight-only and KV4, longer under aggressive settings,
especially on small models.

> [!predict] Before you read on
> FP8 makes each token twice as cheap. The quantized model needs 1.5× as many
> tokens per answer. What is the net speedup per answer?

`2 ÷ 1.5 ≈ 1.33×`. The time and cost of an answer is tokens × cost per token:

```text
   net speedup  =  per-token speedup  ÷  token inflation
```

| Token inflation | Net, at 2× per token |
|---|---|
| 1.0× | 2.0× — the promised win |
| 1.14× (AWQ-INT4, Qwen3-30B, accuracy held) | 1.75× |
| 1.5× | 1.33× |
| 2.0× | 1.0× — break-even |

Inflation is invisible to accuracy-only evaluation, and it hurts most on
reasoning models, the ones with the longest outputs and so the most tempting to
quantize. Lian et al. measured an end-to-end case: Qwen3-4B on BBH took 285 s in
BF16 and 292 s in 4-bit, although the 4-bit kernel was 1.2–1.4× faster per token.

> [!trap] "Accuracy held, so we shipped"
> Accuracy held with an unlimited token budget. Re-run the evaluation with the
> output cap your product enforces, and accuracy recovered by thinking longer can
> disappear — the recovery mechanism was the budget you just removed.

## Correctness also lives in kernels

vLLM's engineers [documented](https://vllm.ai/blog/2026-04-22-fp8-kvcache) a
failure on Hopper GPUs that every short test missed. With an **FP8 KV cache**, a
**needle-in-a-haystack** test — one fact hidden in a 128K-token document, then
asked for — fell from 91.2% retrieval in BF16 to 13.0% on Llama-3.1-8B-Instruct
([flash-attention PR #104](https://github.com/vllm-project/flash-attention/pull/104)).
The stored format was not the problem.

The cause is in the attention kernel's second multiply, softmax weights × values,
which sums one term per cached token: 131,072 terms at 128K. The PR states that
the FP8 tensor-core accumulator "does not correctly work in FP32 precision but in
some reduced format"; DeepSeek measured "around 14 bits" for Hopper's FP8
accumulation ([V3 report](https://arxiv.org/abs/2412.19437), §3.3). A narrow
accumulator loses any addend smaller than half its last bit. Spread attention
over 131,072 tokens and each term is ~1/131,072 of the total: once the running
sum is large enough, new terms vanish. A model of that, with 14 significant bits:

```python
import math, random

def rnd(x, bits=14):  # keep `bits` significant bits, round to nearest (a model, not the hardware)
    if x == 0.0:
        return 0.0
    m, e = math.frexp(x)
    return math.ldexp(round(m * 2 ** bits), e - bits)

def attend(n, tile=None):  # sum of n terms p_i * v_i, softmax weights spread evenly (p_i = 1/n)
    rng = random.Random(0)
    terms = [rng.uniform(0.5, 1.5) / n for _ in range(n)]
    acc = total = 0.0
    for i, t in enumerate(terms, 1):
        acc = rnd(acc + t)                   # every add lands in the narrow accumulator
        if tile and i % tile == 0:           # two-level: flush the tile into a wide register
            total, acc = total + acc, 0.0
    return math.fsum(terms), total + acc

print(f"{'context':>8}{'exact':>9}{'one level':>11}{'two-level (128)':>17}")
for n in (1_024, 8_192, 32_768, 131_072):
    exact, one = attend(n)
    _, two = attend(n, tile=128)
    print(f"{n:>8,}{exact:9.4f}{one:11.4f}{two:17.4f}")

# --- output of an actual run ---
#  context    exact  one level  two-level (128)
#    1,024   0.9979     0.9985           0.9979
#    8,192   1.0030     1.0034           1.0030
#   32,768   1.0004     1.0000           1.0004
#  131,072   0.9997     0.2500           0.9997
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. An illustration of the mechanism under DeepSeek's 14-bit figure, not a simulation of NVIDIA's hardware.*

At 32K tokens the narrow accumulator is still close; at 128K it stalls at a
quarter of the true sum, the shape of the failure the blog reports, which
appears when "the contraction dimension reaches 100K or more". The fix,
**two-level accumulation**, does what the last column does: accumulate one tile
in the tensor core, then flush it into a true FP32 register. It restored 89.2%,
cost ~5% of FP8 decode speed and some prefill speed, and is on by default.
Blackwell's kernel path does not need it. Lessons: a format is a claim about
storage and a kernel a claim about execution, and they fail independently;
evaluate the deployment — engine version, attention backend, GPU, context length
— not the checkpoint, and re-run after every engine upgrade.

## The noise floor: BF16 against BF16

Run the *unquantized* model twice on the same questions at temperature 0 and you
will not get identical answers. SGLang's v0.5.23 documentation names the cause:
"Different batch sizes cause GPU kernels to split reduction operations
differently, leading to different addition orders", and floating-point addition
is not associative. On a busy server a request's batch-mates change from run to
run, and with them the last bits of its logits, enough to flip a close decision.
That is why the same prompt can return different answers at temperature 0.

Engines now offer a cure, at a price. vLLM v0.34 has a **batch-invariant** mode,
`VLLM_BATCH_INVARIANT=1` ("currently in beta", "may impact performance"), whose
output is "independent of the batch size or the order of requests in a batch";
SGLang v0.5.23 has `--enable-deterministic-inference`. Production rarely runs
them, so the evaluation needs both views: a batch-invariant run isolates what
quantization changed, and a BF16-against-BF16 run under production-like
concurrency measures the **flip floor**, the flips you would see with no
quantization at all. A quantized model's flip count means something only above
that floor.

## The harness, as code

The comparison that matters is **paired**: both models answer the same
questions, and you look question by question. **McNemar's test** uses only the
discordant questions — `b` that went right→wrong and `c` that went wrong→right.
If quantization did nothing systematic, each discordant question is a coin flip,
and the test asks how unlikely a split as lopsided as `b` versus `c` is.

```python
import json, math, sys

def load(path):  # one JSON object per line: {"id": ..., "correct": true/false}
    with open(path) as f:
        return {r["id"]: r["correct"] for r in map(json.loads, f) if r}

def mcnemar_exact(b, c):  # two-sided: is a b-vs-c split this lopsided likely if flips are 50/50?
    n, k = b + c, min(b, c)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n) if n else 1.0

if len(sys.argv) == 1:  # no files given: write two tiny samples and use them
    base = "1111011101110111101101"; quant = "1101011111100111101001"
    for name, bits in (("bf16.jsonl", base), ("fp8.jsonl", quant)):
        with open(name, "w") as f:
            f.writelines(json.dumps({"id": f"q{i:02}", "correct": x == "1"}) + "\n"
                         for i, x in enumerate(bits, 1))
    sys.argv += ["bf16.jsonl", "fp8.jsonl"]
a, q = load(sys.argv[1]), load(sys.argv[2])
ids = sorted(a.keys() & q.keys())
b = sum(a[i] and not q[i] for i in ids)     # right before, wrong after
c = sum(q[i] and not a[i] for i in ids)     # wrong before, right after
n = len(ids)
print(f"questions {n}   baseline {sum(a[i] for i in ids) / n:.1%}   candidate {sum(q[i] for i in ids) / n:.1%}")
print(f"flips {b + c} ({(b + c) / n:.1%}): right->wrong {b}, wrong->right {c}")
se = math.sqrt(b + c - (c - b) ** 2 / n) / n    # standard error of the paired difference
print(f"paired difference {(c - b) / n:+.1%} +/- {1.96 * se:.1%} (95%)")
print(f"McNemar exact p = {mcnemar_exact(b, c):.3f}")

# --- output of an actual run (no arguments: the two sample files) ---
# questions 22   baseline 77.3%   candidate 68.2%
# flips 4 (18.2%): right->wrong 3, wrong->right 1
# paired difference -9.1% +/- 17.4% (95%)
# McNemar exact p = 0.625
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. It writes `bf16.jsonl` and `fp8.jsonl` in the current directory when run without arguments.*

The sample shows why size matters: a 9-point drop, and an interval of ±17 points
around it. Four discordant questions cannot tell a real loss from luck.

## How many questions?

> [!trap] A two-point drop on 200 questions is noise
> At an accuracy near 80%, the standard error of a 200-question evaluation is
> `√(0.8 × 0.2 ÷ 200) ≈ 2.8` points. A two-point difference is well inside it.

Pairing helps because only the discordant questions carry information: the
standard error of a paired difference is about `√(flips) ÷ n`, set by the flip
rate, not by the accuracy. The standard sample-size formula for McNemar's test
turns that into a number of questions:

```python
from statistics import NormalDist
z = NormalDist().inv_cdf
za, zb = z(1 - 0.05 / 2), z(0.80)   # 95% two-sided confidence, 80% power

def paired_n(delta, flips):  # McNemar sample size (Connor 1987): flips = share of discordant pairs
    return (za * flips ** 0.5 + zb * (flips - delta ** 2) ** 0.5) ** 2 / delta ** 2

def unpaired_n(delta, acc):  # two independent samples, per model
    return (za + zb) ** 2 * 2 * acc * (1 - acc) / delta ** 2

print(f"detect a 1-point drop near 80% accuracy:")
print(f"  independent samples:     {unpaired_n(0.01, 0.80):8,.0f} questions per model")
for f in (0.02, 0.05, 0.10):
    print(f"  paired, {f:4.0%} of answers flip: {paired_n(0.01, f):8,.0f} questions")
n, f = 1_500, 0.05
delta = (za + zb) * (f / n) ** 0.5
print(f"with {n:,} paired questions and {f:.0%} flips, the smallest reliable drop is ~{delta:.1%}")

# --- output of an actual run ---
# detect a 1-point drop near 80% accuracy:
#   independent samples:       25,116 questions per model
#   paired,   2% of answers flip:    1,567 questions
#   paired,   5% of answers flip:    3,922 questions
#   paired,  10% of answers flip:    7,847 questions
# with 1,500 paired questions and 5% flips, the smallest reliable drop is ~1.6%
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

Read the last line before you write a gate. "Within one point" cannot be
checked with 1,500 questions at a 5% flip rate; the evaluation can resolve about
1.6 points. Either collect ~4,000 questions or write the gate as a margin the
evaluation can test: the 95% interval of the paired difference must stay above
−2 points. [Lab: Bits, Bytes and Drafts](#/lab-squeezing) runs this harness in
miniature on your laptop.

> [!dashboard] Answer quality in production
> **Utilisation:** not applicable — quality has no capacity. **Saturation:**
> output-length drift, from the engine's `vllm:request_generation_tokens`
> histogram (`_sum ÷ _count` per day) against the BF16 baseline week.
> **Errors:** the share of `vllm:request_success_total{finished_reason="length"}`
> (answers cut by the cap); `finished_reason="repetition"` counts only requests
> that set `repetition_detection`. Everything else you must build: tool-call and
> JSON parse failures in the application, sampled shadow comparisons against a
> BF16 replica, user feedback.

> [!case] The case: the gate for FP8
> [Quantization](#/quantization) chose the pinned FP8 checkpoint, two TP=2
> replicas and an FP8 cache, conditional on this evaluation. Llama-3.3-70B is
> large and 8 bits is the safest row of the table, so the prior is good. The
> evaluation catches what the prior cannot: Halden's task, its kernels, its long
> documents.
>
> - **First screen:** top-1 agreement and KL on 200 real documents
>   (`prompt_logprobs`); a cluster of disagreements on numbers or German text
>   is investigated before anything else runs.
> - **Task set:** 1,500 real employee questions with answers checked by the
>   document owners, ~30% in German. Scored for answer and citation correctness,
>   flips, generated tokens and refusals.
> - **Floor:** BF16 against BF16 under production concurrency, same day, same
>   stack.
> - **Gate, per stage** (FP8 weights against BF16, then FP8 KV against FP8
>   weights): the 95% interval of the paired difference stays above −2 points;
>   flips at most twice the floor; generated tokens within 5%. The German slice
>   (~450 questions) has its own, wider interval (~±1.7 points at a ~3.5% flip
>   rate) and blocks only if it lies entirely below −2.
> - **Long context:** needle retrieval at 16K tokens, the deployment's
>   `--max-model-len`, on vLLM v0.34 with the attention backend named in the
>   startup log — and again at 20K before phase 2 raises the limit.
>
> **What this settles:** a pass/fail gate someone outside the team can check, and
> a BF16 configuration that stays deployable, because every engine upgrade
> re-runs this harness against it. If FP8 KV fails the needle test, Halden ships
> FP8 weights with a BF16 cache and loses phase 2's failover margin.

## Exercises

<div class="exercise">

**Exercise 1.** A 4-bit weight-only deployment makes each decode token 1.3×
cheaper than FP8 at your batch size. On your task set, accuracy is unchanged but
the average answer grows from 900 to 1,050 tokens. What is the net speedup per
answer, and at what length would you break even?

<details>
<summary>Reveal answer</summary>

Inflation = 1,050 / 900 ≈ 1.17, so net speedup = 1.3 / 1.17 ≈ **1.11×**: most of
the per-token gain is gone. Break-even is inflation equal to the per-token gain:
900 × 1.3 = **1,170 tokens**. Check the result again under your output cap,
since an accuracy that depends on longer answers may not survive it.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** Halden runs the harness twice on its 1,500
questions. A colleague reads only the second run: "FP8 flipped 54 answers and
lost half a point, and more went right→wrong than the reverse. Block it."

```plaintext
== run A: BF16 against BF16, production concurrency ==
questions 1500   baseline 81.2%   candidate 81.0%
flips 47 (3.1%): right->wrong 25, wrong->right 22
paired difference -0.2% +/- 0.9% (95%)
McNemar exact p = 0.771
== run B: BF16 against FP8 weights ==
questions 1500   baseline 81.2%   candidate 80.7%
flips 54 (3.6%): right->wrong 31, wrong->right 23
paired difference -0.5% +/- 1.0% (95%)
McNemar exact p = 0.341
```

*Real format, illustrative values — the output format of the harness script above; counts invented for the exercise.*

Is the conclusion supported? Does FP8 pass Halden's gate?

<details>
<summary>Reveal answer</summary>

Not supported. Run A is the floor: the unquantized model flips 47 answers
against itself, so 54 is 7 above the floor, well under twice it. The asymmetry,
31 against 23, has a McNemar p of 0.34: splits that lopsided are common when
nothing changed. And the interval, −1.5 to +0.5 points, stays above −2: FP8
passes the gate. What the data cannot say is whether FP8 costs half a point;
1,500 questions resolve ~1.6. If half a point matters, the answer is more
questions, not a stricter reading of these.

</details>

</div>

<div class="exercise">

**Exercise 3 — diagnosis.** A quantized reasoning model passed every accuracy
test in staging. In production, users complain about timeouts. One day's
metrics, before and after the switch:

```plaintext
sum by (finished_reason) (increase(vllm:request_success_total[1d]))
  {finished_reason="stop"}     11640  ->  10920
  {finished_reason="length"}     360  ->   1080
increase(vllm:request_generation_tokens_sum[1d]) / increase(vllm:request_generation_tokens_count[1d])
                                 910  ->   1350
```

*Real format, illustrative values — metric and label names from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`, queried in PromQL; numbers invented for the exercise.*

What happened, and what was missing from the evaluation?

<details>
<summary>Reveal answer</summary>

**Token inflation.** Mean output grew 48% (910 → 1,350 tokens), and the share of
answers ending at the cap tripled (3% → 9%). The model recovers accuracy by
reasoning longer; in staging, with no cap, the longer chains finished and scored
correctly. In production they hit the cap and are cut off. The evaluation lacked
two lines: generated-token counts against the baseline, and a run under the
production output cap. These two metrics are the production alarm for the same
failure.

</details>

</div>

<div class="exercise">

**Exercise 4 — transfer.** Another team wants to ship an 8B model at W4A4
(4-bit weights and activations) for a support bot that emits JSON tool calls,
serves five languages and accepts 32K-token contexts. Write their evaluation
plan: what to run, what gates the release, and what you expect to find.

<details>
<summary>Reveal answer</summary>

Expect damage: W4A4 on small models cost 10–12 points of average accuracy in
Liu et al.'s sweep, so the plan must be able to *find* it, not to confirm a
prior.

- **Screen:** KL and top-1 agreement on real tickets in each language, at
  short and 32K lengths.
- **Floor:** the 8B model in BF16 against itself under production concurrency.
- **Tasks:** real tickets with checked outcomes, stratified by language, with
  enough per language to resolve the drop that matters (from the sample-size
  script: thousands per slice at a 1-point resolution, hundreds at 3–4).
- **Exact strings:** tool-call validity — parses, schema-valid, right function
  and arguments — pass/fail, per language; one wrong character fails the call.
- **Long context:** needle retrieval at 32K on the deployed engine and GPU.
- **Tokens:** generated tokens per ticket, and every score re-run under the
  production output cap.
- **Gate:** per-language paired intervals above the agreed margin, tool-call
  validity within a point of BF16, tokens within 5%. If it fails, the fallbacks
  are W4A16 or FP8, both far safer at 8B.

</details>

</div>

## What to remember

- Quantization damage is silent and concentrates in close decisions; averages
  over easy text cannot see it, and chains of steps multiply small losses.
- 8 bits held within a point at every size in the largest sweep; small models,
  4-bit activations and 3-bit anything are fragile, most of all on hard tasks.
- Compare paired: flips and McNemar's test on the same questions, read against
  the BF16-against-BF16 flip floor, which exists because batching changes
  floating-point addition order.
- Size the evaluation from the flip rate: at 5% flips, ~3,900 paired questions
  detect a 1-point drop; 1,500 resolve ~1.6 points.
- Net speedup = per-token speedup ÷ token inflation; evaluate under the
  production output cap.
- Kernels can break what formats preserve: Hopper's narrow FP8 accumulator lost
  long sums until two-level accumulation. Evaluate the deployed stack.

```quiz
[
  {
    "q": "A team reruns its BF16 model against itself at temperature 0 under production load and sees 2.5% of answers flip. The FP8 candidate flips 2.8% against BF16. What does the 2.8% tell them?",
    "choices": [
      "FP8 changed about 2.8% of answers, which is the quantity the gate should cap",
      "Little by itself: most such flips happen with no quantization at all",
      "The BF16 server is misconfigured, since temperature 0 must be deterministic",
      "FP8 is more stable than BF16, because its flips are close to the floor"
    ],
    "answer": 1,
    "explain": "Batch composition changes the order of floating-point additions, so the unquantized model flips 2.5% against itself. FP8 adds ~0.3 points above that floor; whether that is systematic is a question for McNemar's test on the discordant pairs. Temperature 0 is not deterministic on a batching server unless a batch-invariant mode is on."
  },
  {
    "q": "In a pilot, 10% of answers flip between BF16 and a 4-bit candidate. Roughly how many paired questions are needed to detect a 1-point drop at 95% confidence and 80% power?",
    "choices": [
      "About 25,000, as for two independent samples near 80% accuracy",
      "About 400, since pairing removes nearly all of the variance",
      "About 7,800: only the discordant tenth carries information",
      "About 1,600, the same as at a 2% flip rate"
    ],
    "answer": 2,
    "explain": "The paired standard error grows with the flip rate: n ≈ (1.96 √0.10 + 0.84 √0.0999)² ÷ 0.01² ≈ 7,850. At 2% flips it would be ~1,600, and unpaired ~25,000 per model. Pairing helps most when few answers flip; it does not make a high-flip model cheap to evaluate."
  },
  {
    "q": "To screen an FP8 model with logprobs, a colleague generates 500 answers from each model and compares the log-probabilities of the generated tokens. Why is scoring prompt_logprobs on fixed documents better?",
    "choices": [
      "After the first differing token, the two models condition on different text",
      "Generated tokens never return log-probabilities in vLLM's OpenAI-compatible server",
      "Prompt log-probabilities are computed in FP32 even on quantized models",
      "Generation at temperature 0 always yields the same text from both models"
    ],
    "answer": 0,
    "explain": "KL and top-1 agreement compare two distributions over the same context. Once the generated texts diverge, later positions compare different questions. Scoring a fixed text with prompt_logprobs keeps every position's context identical. Generated tokens can return logprobs too; that is not the problem."
  },
  {
    "q": "The Hopper FP8-KV failure appeared at 128K tokens but not at 8K. Which property of the attention kernel explains the dependence on length?",
    "choices": [
      "Query × key sums over head_dim, which grows with the context length",
      "FP8 keys lose range at long contexts because RoPE angles grow larger",
      "The cache's FP8 scales are recalibrated per block and drift over time",
      "Softmax weights × values adds one term per cached token"
    ],
    "answer": 3,
    "explain": "The second multiply sums over the context: 131,072 terms at 128K, each tiny relative to the running sum, which a ~14-bit accumulator drops. Query × key sums over head_dim (128), which does not grow with context. The stored format and its scales were not the cause: two-level accumulation fixed it with the same cache."
  },
  {
    "q": "Quantization makes each token 1.6× cheaper. On your traffic, answers become 1.25× longer at equal accuracy. What is the net effect per answer?",
    "choices": [
      "2.0× faster, since the two gains combine",
      "1.28× faster, since inflation divides the gain",
      "1.35× faster, since 1.6 minus 0.25 remains",
      "No change, since longer answers cancel any gain"
    ],
    "answer": 1,
    "explain": "Cost per answer is tokens × cost per token: 1.25 × (1 ÷ 1.6) = 0.78 of the baseline, a net speedup of 1.6 ÷ 1.25 = 1.28×. Inflation divides the per-token gain; it does not subtract from it. Break-even would need 1.6× longer answers."
  }
]
```
