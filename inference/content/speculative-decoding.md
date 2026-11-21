# Speculative Decoding

> **The question:** decode reads the whole model to produce one token while the
> arithmetic units sit idle — can you get several tokens out of one read without
> changing the output distribution, and at what batch does trying make things worse?
>
> **You'll be able to:** run the accept/reject rule on any pair of distributions
> and check that it leaves the target's distribution unchanged; compute tokens
> per verification and the batch at which speculation stops paying, from the
> course's one cost model; choose a drafter and a draft length from per-position
> acceptance counters.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,batch"></div>

At small batch, a decode step reads every weight from memory to produce one token
per sequence, and the tensor cores are mostly idle ([Inference
Arithmetic](#/inference-arithmetic)). You pay for the weight read whether the step
produces one token or five. If a single pass could produce several tokens, the
idle arithmetic would turn into speed.

The obstacle is that generation is sequential: token 11 is chosen by a pass whose
input includes token 10. But *checking* a guess is different from *generating*
it. If someone hands you five candidate tokens, the model can score all five
positions in one pass, exactly as prefill scores a whole prompt. Generation is
serial; verification is parallel. **Speculative decoding** is built on that gap.
(CPUs exploit the same gap with branch prediction.)

## Guess cheaply, check in bulk

Two models. The **target** is the large model whose output you want. The **draft**
is something much cheaper that guesses what the target will say. Each round:

```text
  draft proposes γ tokens, one at a time (cheap):
        "the"  "cat"  "sat"  "on"                    γ = 4

  target runs ONE pass over γ + 1 = 5 positions (one weight read):
     input   [last] "the"  "cat"  "sat"  "on"
     output    p₁     p₂     p₃     p₄     p₅      ← five next-token distributions
        ✓ "the"   ✓ "cat"   ✗ "sat" → resample from the residual at p₃: "ran"

  emitted: "the" "cat" "ran" — three tokens for one target pass
  had all four survived: "the" "cat" "sat" "on" + a bonus token drawn from p₅
```

Proposals are checked left to right. At the first rejection, the rest are
discarded — they were conditioned on a token that did not survive — and a
replacement is drawn for that position. If none is rejected, the pass has already
computed the distribution after the last draft, so one more token comes free: the
**bonus token**. A round emits between 1 and γ + 1 tokens.

![Two timelines: ordinary decode spends five target passes on five tokens; speculative decoding runs four cheap draft steps, then one target pass that accepts "the" and "cat", rejects "sat" for the target's "ran" and discards "on" — three tokens for one target pass](assets/diagrams/spec-decode-timeline.svg)

> [!predict] Before you read on
> The draft is a much smaller, worse model. When the target samples with a
> temperature, does the output follow the target's distribution exactly,
> approximately, or only for greedy decoding?

Exactly — for any temperature and any draft, if the accept/reject rule is the
right one.

## The rule, and why it is lossless

Let `p(x)` be the target's probability for token `x` at this position and `q(x)`
the draft's. The draft samples `x` from `q`. The rule
([Leviathan et al. 2023](https://arxiv.org/abs/2211.17192);
[Chen et al. 2023](https://arxiv.org/abs/2302.01318)):

- **accept** `x` with probability `min(1, p(x) / q(x))`;
- if rejected, sample a replacement from the **residual** distribution
  `r(x) ∝ max(p(x) − q(x), 0)`.

The probability of emitting `x` is the probability of proposing and accepting it,
plus the probability of a rejection followed by the residual choosing it:

```text
  P(propose x, accept)   = q(x) · min(1, p(x)/q(x))  =  min(q(x), p(x))
  P(any rejection)       = 1 − Σ min(q, p)            =  Σ max(p − q, 0)  ≡ β
  P(reject, residual→x)  = β · max(p(x) − q(x), 0) / β  =  max(p(x) − q(x), 0)

  P(emit x)  =  min(q(x), p(x)) + max(p(x) − q(x), 0)  =  p(x)
```

The last line is a case split: if `p(x) ≥ q(x)` it reads `q(x) + (p(x) − q(x))`;
otherwise `p(x) + 0`. Either way, `p(x)`. The draft's errors are corrected exactly
by the residual: this is another way to sample from the same distribution, not an
approximation of it. The second line also names the number the rest of the chapter
runs on: the **acceptance rate** at a position, `α = Σ min(p, q) = 1 − β`, the
overlap of the two distributions. It falls as temperature spreads both over more
tokens.

The program below tests the claim: it runs the rule 200,000 times with a draft wrong in both directions: it never proposes C, which the
target wants 20% of the time, and it proposes D, which the target never wants.

```python
import random
random.seed(1)
p = {"A": 0.50, "B": 0.30, "C": 0.20, "D": 0.00}   # target
q = {"A": 0.40, "B": 0.40, "C": 0.00, "D": 0.20}   # draft: never says C, sometimes says D

def draw(dist):
    return random.choices(list(dist), weights=list(dist.values()))[0]

resid = {x: max(p[x] - q[x], 0) for x in p}         # max(p - q, 0), unnormalised

def verify_one():
    x = draw(q)                                      # draft proposes
    if random.random() < min(1, p[x] / q[x]):        # accept with min(1, p/q)
        return x, True
    return draw(resid), False                        # else resample from residual

N = 200_000
counts, accepted = dict.fromkeys(p, 0), 0
for _ in range(N):
    x, ok = verify_one()
    counts[x] += 1
    accepted += ok
print("token  target p  emitted")
for x in p:
    print(f"  {x}      {p[x]:.3f}    {counts[x] / N:.3f}")
print(f"acceptance {accepted / N:.3f}  vs  sum min(p,q) = {sum(min(p[x], q[x]) for x in p):.3f}")

# token  target p  emitted
#   A      0.500    0.499
#   B      0.300    0.300
#   C      0.200    0.201
#   D      0.000    0.000
# acceptance 0.699  vs  sum min(p,q) = 0.700
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

Every proposed D is rejected (`p(D)/q(D) = 0`), and C, which the draft never
proposes, still comes out 20% of the time — entirely through the residual. The
measured acceptance matches `Σ min(p, q)`.

> [!trap] "It trades quality for speed, like quantization"
> Under the standard rule it does not: [quantization](#/quantization) changes the
> numbers the model computes with; exact verification leaves the output
> distribution alone, so a bad draft costs speed, never accuracy. Two
> qualifications. *Exact* is distributional, not bitwise: verification runs at a
> different batch shape, so the last bits of the logits move and a greedy output
> can diverge at a near-tie, as vLLM's documentation warns. And vLLM v0.33 added
> FLy, an opt-in verifier that sometimes keeps a draft the rule would reject —
> "intentionally lossy", says its documentation. A config with
> `"rejection_sample_method": "fly"` must pass [an
> evaluation](#/did-quantization-break-your-model) like any change to the output.

## The speedup arithmetic

Let **γ** be the number of tokens drafted per round, and treat each draft token
as surviving with the same probability α, independently. The first k drafts all
survive with probability αᵏ. A round emits the surviving drafts plus exactly one
token from the target (the correction at the first rejection, or the bonus), so

```text
   E[tokens per round]  =  1 + α + α² + … + α^γ  =  (1 − α^(γ+1)) ÷ (1 − α)
```

The leading 1 is the target's own token; without the bonus, a fully accepted round
would yield γ, not γ + 1.

> [!predict] Before you read on
> With α = 0.8 and γ = 4, how many tokens does one target pass yield on average?
> And what is the most it could ever yield at α = 0.8, however long you draft?

`1 + 0.8 + 0.64 + 0.512 + 0.41 = 3.36` tokens. As γ grows, the series approaches
`1 ÷ (1 − α)` = **5** and never exceeds it. In practice the ceiling arrives sooner:
acceptance decays with position, which is why production drafts are short.

The draft is not free. If a draft pass costs a fraction `c` of a target step, then at
low batch, where verification rides on idle arithmetic, the speedup is roughly

```text
   speedup  ≈  E[tokens per round] ÷ (1 + c·γ)
```

Estimate `c` from bytes, then add what does not shrink. At low batch both models
are bandwidth-bound, so start from weight bytes: the EAGLE-3 head for
Llama-3.3-70B used below is one decoder layer plus a small output layer, a 4.9 GB
file against 141 GB, 3.5%. Each draft pass also pays fixed costs — launches,
sampling ([Kernels, Graphs & Compilation](#/kernels-and-compilation)) — that do
not shrink with the model. This chapter uses `c = 0.05`, a parameter to measure.
Acceptance enters through a series with a ceiling, draft cost linearly: a cheap,
slightly worse draft usually beats an accurate, heavy one.

## What verification costs: B·(γ+1) tokens

Everything above assumed idle arithmetic. Price the verification step with the
course's one cost model ([Inference Arithmetic](#/inference-arithmetic)):
`step ≈ max(t_w, t_c) + t_kv`, with `t_w ≈ 14 ms` to read the weights, 0.089 ms of
arithmetic per token in the step, and ~29 ns per context token per sequence of KV
reads.

In a verification pass, each of the B sequences feeds γ + 1 positions through the
target — its last accepted token and γ drafts — like a small prefill, and every
position costs a full token of matrix multiplies, accepted or not. The step
carries **B·(γ+1) tokens** where plain decode carried B. Below the knee that is
free: `t_c` hides under `t_w`. On this node the knee is `14 ÷ 0.089` ≈ 160 tokens
per step (nameplate ~295; measure yours).

> [!predict] Before you read on
> Ask Halden at peak runs ~20 concurrent sequences with 3,000-token contexts. With
> γ = 3, how many tokens does each verification step carry — below or above the
> knee? And above roughly what batch would γ = 3 put the step past it?

`20 × 4 = 80` tokens, half the knee: verification costs Halden nothing but the
draft passes. The knee arrives at `160 ÷ 4 = 40` sequences; past it, each extra
sequence adds four tokens of arithmetic to the speculative step and none to the
plain one. The program compares the two.

```python
# One cost model (case.md): step = max(t_w, t_c) + t_kv, all in ms
T_W, MS_PER_TOKEN, KV_MS_PER_CTX_TOKEN = 14.0, 0.089, 29e-6
CTX, GAMMA, C = 3000, 3, 0.05        # context per sequence; draft length; draft pass / target step

def step(tokens, seqs):
    return max(T_W, tokens * MS_PER_TOKEN) + seqs * CTX * KV_MS_PER_CTX_TOKEN

def tokens_per_round(a, g):           # 1 + a + a^2 + ... + a^g
    return sum(a ** k for k in range(g + 1))

def speedup(B, a):
    plain = step(B, B)                              # B tokens in the step
    spec = step(B * (GAMMA + 1), B) + GAMMA * C * plain   # verify B(γ+1) tokens, plus γ draft passes
    return tokens_per_round(a, GAMMA) * plain / spec

print("batch  B(γ+1)   plain ms   α=0.5   α=0.6   α=0.7")
for B in (1, 20, 40, 80, 120, 160):
    print(f"{B:5}  {B * (GAMMA + 1):6}   {step(B, B):8.1f}" +
          "".join(f"   {speedup(B, a):4.2f}×" for a in (0.5, 0.6, 0.7)))
for a in (0.5, 0.6, 0.7):
    B = next(b for b in range(1, 1000) if speedup(b, a) < 1)
    print(f"α={a}: speculation stops paying at batch ~{B}")

# batch  B(γ+1)   plain ms   α=0.5   α=0.6   α=0.7
#     1       4       14.1   1.63×   1.89×   2.20×
#    20      80       15.7   1.63×   1.89×   2.20×
#    40     160       17.5   1.61×   1.87×   2.18×
#    80     320       21.0   1.02×   1.18×   1.38×
#   120     480       24.4   0.81×   0.94×   1.09×
#   160     640       28.2   0.70×   0.82×   0.95×
# α=0.5: speculation stops paying at batch ~83
# α=0.6: speculation stops paying at batch ~107
# α=0.7: speculation stops paying at batch ~142
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

The 15.7 ms at batch 20 is the case's decode
step at rung 4 of the ladder (~16 ms); its speedup equals batch 1's because nothing
has reached the knee. Then notice what holds the crossover up: the KV reads. Each
sequence's cache is read once per step whether one query or γ + 1 attend to it, so
verification shares that cost. Remove the KV term and the α = 0.7 crossover falls
from ~142 to ~94. This is why speculation helps again at very long context even at
large batch ([MagicDec](https://infini-ai-lab.github.io/MagicDec-part2/)): long KV
reads restore idle arithmetic.

![Speedup against batch from the cost model, γ = 3: flat at 2.2× (α 0.7) and 1.6× (α 0.5) up to batch 40, where 160 verification tokens reach the knee, then falling; with 3K-token contexts they cross 1.0× near 142 and 83, without KV reads near 94. Markers at Halden's 20 and the pool's ~123 requests](assets/diagrams/spec-speedup-case-model.svg)

The model omits the rejection sampler, draft scheduling and small odd shapes, so
measured crossovers sit lower. vLLM's
documentation makes the same argument ("when this BS\*K goes beyond a critical BS
then SD negatively impacts the decode speed") and ships the knob:
`num_speculative_tokens_per_batch_size`, `[from, to, γ]` ranges that shorten the
draft as concurrency rises.

> [!bridge] From the Linux course
> Speculation is `SCHED_IDLE` for FLOPs: free when the machine is quiet, a tax on
> everyone else when it is not. What differs is enforcement: the kernel enforces
> `SCHED_IDLE`, while nothing in the GPU knows the draft's work is optional — past
> the knee it competes at full priority.
> [→ Linux: CPU Scheduling](../#/scheduling)

The simulator prices every step both ways with the same model. Turn speculative
decoding on at a low arrival rate and the spec-versus-no-spec readout goes
positive; preset 6 (a what-if knee of 120 tokens, under load) drives it negative.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

## The drafters

All use the same verification; they differ in how they guess.

- **Independent draft model**: a small model of the same family, with its own
  weights and KV cache. The plain rule needs a shared vocabulary (vLLM v0.25 added
  a cross-vocabulary variant).
- **EAGLE-3** ([paper](https://arxiv.org/abs/2503.01840)): a light head drafts from
  the target's own hidden states, fused from several layers. The paper reports "a
  speedup ratio up to 6.5x" and "a 1.38x throughput improvement at a batch size of
  64" in SGLang — a latency ratio and a throughput ratio, not one metric.
- **MTP**: draft heads trained *with* the base model. DeepSeek-V3 reports
  second-token acceptance "between 85% and 90%" and 1.8× the tokens per second
  ([DeepSeek-V3](https://arxiv.org/abs/2412.19437)).
- **DFlash, DSpark**: block-diffusion drafters that propose a whole block in one
  parallel pass, so draft cost stops growing with γ (in vLLM since v0.25).
- **N-gram, suffix**: no model — if recent tokens appeared earlier, in the prompt or
  in earlier responses, guess that what followed then follows now. Free when output
  copies input: quoted documents, code edits, agent loops.
- **Trees**: several branches verified in one pass, with an attention mask that
  lets each position see only its own ancestors.

Medusa was removed from vLLM in v0.33. Any drafter is coupled to its target: a head trained on
one checkpoint and chat template loses acceptance on a fine-tune or another
template. Rolling back rejected tokens is cheap with a paged cache: the engine
shortens the sequence, the slots past it are overwritten next round, and a block is
freed only if the cut crosses a block boundary ([PagedAttention](#/paged-kv-cache)).

## Turning it on, and reading it

Red Hat publishes an EAGLE-3 head for the case's model, with this launch line:

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct \
  -tp 4 \
  --speculative-config '{
    "model": "RedHatAI/Llama-3.3-70B-Instruct-speculator.eagle3",
    "num_speculative_tokens": 3,
    "method": "eagle3"
  }'
```

*Verbatim — model card of RedHatAI/Llama-3.3-70B-Instruct-speculator.eagle3 on Hugging Face (checked 2026-11-21); keys checked against vLLM v0.34.0 `vllm/config/speculative.py`.*

The same card reports mean acceptance lengths (tokens per round, bonus included)
per draft length k:

```plaintext
Use Case            k=1   k=2   k=3   k=4   k=5   k=6   k=7
Coding              1.84  2.53  3.07  3.42  3.71  3.89  4.00
Math Reasoning      1.81  2.43  2.88  3.17  3.30  3.42  3.53
Text Summarization  1.71  2.21  2.52  2.74  2.83  2.87  2.89
```

*Verbatim — "Acceptance lengths" table of the same model card (HumanEval, gsm8k, CNN/Daily Mail; temperature 0; vLLM 0.11.0), reformatted from HTML.*

Read across a row. Each step right buys one more draft pass and returns the
difference: for summarization, +0.71, +0.50, +0.31, +0.22, +0.09 tokens per round.
At `c = 0.05` the fifth position barely pays and the sixth does not. Summarization,
copying from a document, is the row closest to Ask Halden's answers. On your own
traffic, vLLM v0.34 logs the same quantities every few seconds:

```plaintext
INFO … SpecDecoding metrics: Mean acceptance length: 2.52, Accepted throughput: 461.20 tokens/s, Drafted throughput: 910.20 tokens/s, Accepted: 4612 tokens, Drafted: 9102 tokens, Per-position acceptance rate: 0.710, 0.500, 0.310, Avg Draft acceptance rate: 50.7%
```

*Real format, illustrative values — message from vLLM v0.34.0 `vllm/v1/spec_decode/metrics.py` (`SpecDecodingLogging.log`), logger prefix trimmed; the per-position rates are the summarization increments above, and the counts are made up for a 10-second window of 3,034 rounds to match them — not measured.*

The per-position rate at position i is accepted-at-i ÷ rounds: the share of rounds
in which the first i drafts *all* survived. So the rates must fall, one plus their
sum is the mean acceptance length (1 + 0.71 + 0.50 + 0.31 = 2.52), and the
conditional acceptance of a position is the ratio of neighbours (0.50 ÷ 0.71 =
0.70; 0.31 ÷ 0.50 = 0.62). "Avg Draft acceptance rate" (accepted ÷ drafted) is not
α: it averages in the late positions. Prometheus exposes the counters, and
llama.cpp's server the same four under `llamacpp:`; the lab [Bits, Bytes and
Drafts](#/lab-squeezing) reads them on a laptop.

> [!dashboard] The drafter
> **Utilisation:** acceptance,
> `rate(vllm:spec_decode_num_accepted_tokens_total) / rate(vllm:spec_decode_num_draft_tokens_total)`,
> and per position `vllm:spec_decode_num_accepted_tokens_per_pos_total` ÷
> `vllm:spec_decode_num_drafts_total`. **Saturation:** none — derive verify tokens
> per step as `vllm:num_requests_running × (1 + γ)` against the knee (~160).
> **Errors:** none — wasted work is drafted minus accepted; judge the outcome on
> `vllm:request_time_per_output_token_seconds`, on against off
> (`vllm:inter_token_latency_seconds` counts a bundle of tokens as one gap).

> [!case] The case: on, as a measured bet
> At the phase-1 peak Halden decodes ~20 sequences of ~3,000 tokens in a ~16 ms
> step (rung 4). With the EAGLE-3 head at γ = 3 the verify step carries 80 tokens,
> under the knee, and costs only the draft passes: ~18.1 ms per round. At α = 0.7 a
> round emits 2.53 tokens: TPOT falls from ~16 to ~7 ms, and a 250-token answer
> decodes in ~1.8 s instead of ~3.9 s. The 60 ms SLO did not need it; users
> waiting for an answer will notice.
>
> The stake is acceptance, not batch. Break-even at batch 20 is 18.1 ÷ 15.7 = 1.15
> tokens per round (α ≈ 0.13), but the model omits the sampler and draft
> scheduling, and the head was trained on ShareGPT and UltraChat conversations,
> scored at temperature 0; Halden samples at 0.6 over its own documents. The head's
> 4.9 GB costs the 132 GB pool about four full-length requests.
>
> **What this settles:** EAGLE-3 at γ = 3, *if* a shadow replay of a day of Halden
> prompts at production sampling shows a mean acceptance length of at least 1.5 and
> `vllm bench serve` at concurrency 20 ([Load Testing](#/load-testing)) shows
> lower p95 TPOT with it; otherwise off.
> Phase 2 does not reverse this. Each FP8 TP=2 replica has the same per-GPU bytes
> and FLOPs, so the same model applies: ~30 sequences per replica put 120 tokens in
> the step, and even one replica carrying all ~60 sequences of ~11K tokens is held
> up by its KV reads (~1.8× at α = 0.7). What phase 2 can change is acceptance on
> tool-call JSON.

## Exercises

<div class="exercise">

**Exercise 1.** Target `p = [0.6, 0.1, 0.3, 0]` over `{A, B, C, D}`; draft
`q = [0.3, 0.3, 0, 0.4]`. (a) What is α at this position? (b) What is the residual
distribution, normalised? (c) Verify that A, B, C and D are emitted with the
target's probabilities. (d) A drafter with α = 0.6 at every position drafts γ = 2:
what fraction of rounds end with a bonus token, and how many tokens does a round
yield on average?

<details>
<summary>Reveal answer</summary>

(a) `α = Σ min(p, q) = 0.3 + 0.1 + 0 + 0 = 0.4`.

(b) `max(p − q, 0) = [0.3, 0, 0.3, 0]`, which sums to β = 0.6; normalised
`[0.5, 0, 0.5, 0]`.

(c) A: proposed 0.3, always accepted (0.6/0.3 > 1), plus residual 0.6 × 0.5 = 0.3
→ 0.6. B: proposed 0.3, accepted with 0.1/0.3 → 0.1. C: only via the residual,
0.6 × 0.5 → 0.3. D: accepted with 0/0.4 → 0. Exactly `p`.

(d) A bonus needs both drafts accepted: 0.6² = 36% of rounds. Tokens per round:
`1 + 0.6 + 0.36 = 1.96`.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team serves a code assistant with an EAGLE-3 head
and `num_speculative_tokens: 5`. Peak concurrency is ~25. Their dashboard shows:

```plaintext
vllm:spec_decode_num_drafts_total                                  1000000
vllm:spec_decode_num_draft_tokens_total                            5000000
vllm:spec_decode_num_accepted_tokens_total                         1870000
vllm:spec_decode_num_accepted_tokens_per_pos_total{position="0"}    700000
vllm:spec_decode_num_accepted_tokens_per_pos_total{position="1"}    480000
vllm:spec_decode_num_accepted_tokens_per_pos_total{position="2"}    330000
vllm:spec_decode_num_accepted_tokens_per_pos_total{position="3"}    220000
vllm:spec_decode_num_accepted_tokens_per_pos_total{position="4"}    140000
```

*Real format, illustrative values — counter names and the `position` label from vLLM v0.34.0 `vllm/v1/spec_decode/metrics.py` (labels other than `position` trimmed); values invented, internally consistent, not measured.*

What are the mean acceptance length and the conditional acceptance by position?
Is γ = 5 well chosen at c = 0.05, and is it safe at their peak?

<details>
<summary>Reveal answer</summary>

Mean acceptance length = 1 + 1,870,000 ÷ 1,000,000 = 2.87 (the per-position sum,
1.87, agrees). Conditional acceptance: 0.70, 0.69, 0.69, 0.67, 0.64 — nearly flat,
so the independence model fits here.

Choosing γ: speedup ≈ E ÷ (1 + 0.05γ): γ = 3 → 2.51 ÷ 1.15 = 2.18; γ = 4 →
2.73 ÷ 1.20 = 2.28; γ = 5 → 2.87 ÷ 1.25 = 2.30. The fifth position barely pays.

Safety: at 25 concurrent, γ = 5 puts 25 × 6 = 150 tokens in the verify step, just
under a ~160 knee; a burst to 30 crosses it, where γ = 4 would not (30 × 5 = 150).
Drop to γ = 4, or step γ down above ~25 with `num_speculative_tokens_per_batch_size`,
and compare TPOT on and off at peak.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Llama-3.1-8B on one H100 in BF16 (16 GB of weights; 32
layers, 8 KV heads, head_dim 128) serves 12 concurrent coding sessions with
32,000-token contexts. An EAGLE-3 head drafts γ = 4 at α ≈ 0.8, c = 0.05. Use the
cost model with this model's own numbers: weights at ~2.85 TB/s, 40% MFU on 989
TFLOP/s. Does speculation pay, and what holds it up?

<details>
<summary>Reveal answer</summary>

`t_w` = 16 GB ÷ 2.85 TB/s ≈ 5.6 ms; arithmetic per token = 2 × 8e9 ÷ (0.4 ×
989e12) ≈ 0.040 ms, so the knee is ~140 tokens. KV per token = 2 × 32 × 8 × 128 ×
2 B = 131 KB, ~46 ns per context token: 12 × 32,000 × 46 ns ≈ 17.7 ms per step.
(That is 50 GB of KV; with 16 GB of weights it fits the card, 24 sessions would not.)

Plain step: max(5.6, 0.5) + 17.7 ≈ 23.3 ms. Speculative: 12 × 5 = 60 tokens, under
the knee → 5.6 + 17.7 + 4 × 0.05 × 23.3 ≈ 28.0 ms per round for
`1 + 0.8 + 0.64 + 0.51 + 0.41 = 3.36` tokens → ~8.3 ms per token, ~2.8×. The KV
reads carry it: three quarters of the plain step, shared by the five verified
positions of each sequence.

</details>

</div>

<div class="exercise">

**Exercise 4 — find the flaw.** A capacity memo: *"EAGLE-3 reports up to 6.5×.
Our 70B runs at batch 64 on one node; with speculation at γ = 5 we can serve 6.5×
the users and return two of our three nodes. Speculation is lossless, so no
evaluation is needed, and we will use the faster FLy verifier."* Find the errors.

<details>
<summary>Reveal answer</summary>

1. Wrong metric: 6.5× is a latency ratio at low batch; the same paper reports
   1.38× *throughput* at batch 64.
2. Past the knee: batch 64 at γ = 5 puts 384 tokens in the verify step. On the
   case's cost model (3K contexts) that is ~1.3× at α = 0.7 and ~2× at α = 0.9 —
   not the 3× needed to return two nodes of three.
3. Borrowed acceptance: published numbers come from benchmark prompts, often at
   temperature 0; the memo measured none of its own.
4. "Lossless" with FLy: FLy is lossy by design, so the skipped evaluation is
   required.

</details>

</div>

## What to remember

- Generation is serial; verification is parallel. One target pass scores γ + 1
  positions and emits between 1 and γ + 1 tokens: the bonus token is free.
- Accept with `min(1, p/q)`, resample rejections from `max(p − q, 0)`: the output
  distribution is exactly the target's, for any draft — under the standard rule
  (not FLy), and up to floating-point order.
- Tokens per round = `1 + α + … + α^γ`, capped at `1 ÷ (1 − α)`; divide by
  `1 + c·γ` for the draft. α = Σ min(p, q), and it decays by position — read it per
  position before choosing γ.
- Verification puts B·(γ+1) tokens in the step. Free until that reaches the knee
  (~160 on the case's node), paid for after; long KV reads push the crossover out.

```quiz
[
  {
    "q": "A drafter proposes, at one position, q = [0.5, 0.5, 0] over {X, Y, Z}; the target has p = [0.2, 0.5, 0.3]. What is the probability that the proposal is accepted?",
    "choices": [
      "1.0, because Y is proposed half the time and always accepted",
      "0.5, the probability mass the draft puts on the target's favourite token",
      "0.7, the overlap Σ min(p, q) = 0.2 + 0.5 + 0",
      "0.4, because X is accepted with probability 0.2 ÷ 0.5"
    ],
    "answer": 2,
    "explain": "Acceptance at a position is Σ min(p, q): X contributes min(0.2, 0.5) = 0.2, Y min(0.5, 0.5) = 0.5, Z nothing, so 0.7. The 0.4 is only X's conditional acceptance ratio; Z, which the draft never proposes, reaches the output only through the residual."
  },
  {
    "q": "vLLM logs 'Per-position acceptance rate: 0.800, 0.560, 0.336' for a γ = 3 drafter. What is the mean acceptance length, and how do later positions compare?",
    "choices": [
      "1.70 tokens, the sum of the three per-position rates on their own",
      "2.70 tokens; conditional acceptance falls from 0.80 to 0.70 to 0.60",
      "3.70 tokens, since every round emits a bonus token on top of them",
      "2.70 tokens; every position is accepted with the same probability, 0.80"
    ],
    "answer": 1,
    "explain": "Mean length = 1 + 0.800 + 0.560 + 0.336 = 2.70. The logged rates are cumulative (all earlier drafts survived), so the conditional rates are 0.800, 0.560/0.800 = 0.70 and 0.336/0.560 = 0.60. The bonus token is the leading 1 when all three survive, not an extra token on every round."
  },
  {
    "q": "A node with an effective knee of ~200 tokens per step runs short-context chat at 60 concurrent sequences. You enable a drafter with γ = 4. What happens to the verification step, before acceptance is even known?",
    "choices": [
      "Nothing changes: verification reuses the draft's own work, so the step keeps 60 tokens",
      "It carries 64 tokens, since only one row of drafts is added to the batch of 60",
      "It carries 240 tokens, but the KV reads keep the step bandwidth-bound regardless",
      "It carries 300 tokens, past the knee, so every rejected position costs real time"
    ],
    "answer": 3,
    "explain": "Each sequence feeds γ + 1 = 5 positions: 60 × 5 = 300 tokens, past a 200-token knee. With short contexts there are few KV reads to hide the added arithmetic, so rejected positions now cost wall time and speculation may lose. 240 forgets the position that carries the last accepted token."
  },
  {
    "q": "Your team serves an agent that re-emits large parts of earlier tool outputs and of its own previous answers. Which drafter is the natural first try, at no model cost?",
    "choices": [
      "Suffix decoding, which matches against the prompt and earlier responses",
      "A larger independent draft model, to raise acceptance on the agent's traffic",
      "FLy verification, which accepts more of whatever the draft proposes",
      "Medusa heads, retrained on the agent's own transcripts and tool outputs"
    ],
    "answer": 0,
    "explain": "Suffix decoding (and n-gram lookup) guess continuations from text already seen, in the prompt or in earlier responses — free and strong when output copies input. A bigger draft costs memory and draft time; FLy changes the output distribution; Medusa was removed from vLLM in v0.33."
  },
  {
    "q": "A long-context deployment's plain decode step at 60 sequences is 14 ms of weight reads plus 40 ms of KV reads. With γ = 3 the verify step carries 240 tokens, 21 ms of arithmetic at 0.089 ms per token; a draft pass costs 5% of a step and α = 0.6 (2.18 tokens per round). Does speculation pay?",
    "choices": [
      "No: 240 tokens is past the 160-token knee, so the round costs more than it emits",
      "Barely: about 1.05×, because the three draft passes eat almost all of the gain",
      "Yes, about 2.2×, the full tokens per round, since KV reads hide everything",
      "Yes, about 1.7×: ~69.5 ms per round for 2.18 tokens against 54 ms per token"
    ],
    "answer": 3,
    "explain": "Plain: max(14, 60 × 0.089) + 40 = 54 ms per token. Speculative round: max(14, 21) + 40 + 3 × 0.05 × 54 ≈ 69.5 ms for 2.18 tokens ≈ 31.9 ms per token, about 1.7×. Being past the knee costs the 7 ms by which arithmetic exceeds the weight read, small next to the 40 ms of KV reads that verification shares; it does not cancel the gain, and it does not vanish either."
  }
]
```
