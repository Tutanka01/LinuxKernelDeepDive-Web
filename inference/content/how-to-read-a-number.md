# How to Read a Number in This Field

> **Goal of this chapter:** inoculate you, before the course starts, against the
> performance claims you are about to meet everywhere — in vendor decks, in
> launch posts, in your own dashboards. Six rules. Each one is a question you
> learn to ask, and each one is enough to defuse a claim that would otherwise
> have looked impressive.

Inference is a field with unusually good physics and unusually bad numbers. The
physics is the reason: throughput, latency, cost and quality trade against each
other along hard constraints, so almost any figure can be made to look
spectacular by choosing where on those trade-offs to stand and then not
mentioning that you chose. Nothing here requires dishonesty. It only requires
omission.

You do not yet have the machinery to derive these rules; that is the rest of the
course. Take them now as a reading protocol, and by [Inference
Arithmetic](#/inference-arithmetic) you will be able to prove each one.

## 1. The Pareto-curve rule

**"Tokens per second" is not a number. It is a point on a curve.**

Serving trades total throughput against per-user speed. Add more concurrent
requests and the GPU produces more tokens in aggregate while each individual user
waits longer between them. Take requests away and every user is fast while the
hardware idles. The system's real behavior is that whole curve, and any single
point on it can be reached by choosing a batch size.

So a bare "we serve 12,000 tokens/second" is unfalsifiable. It is compatible with
a wonderful interactive service and with one where each user gets a token every
two seconds. The claim only becomes a claim when it names its latency point.

*Ask: at what per-user tokens per second? Show me the curve, not the peak.*

> [!bridge] You already know this — from the distributed course
> There you learned to distrust an average latency because your users live at
> the tail, and to quote p99 and p999 instead. This is the same refusal to let a
> single scalar stand in for a distribution — except the thing being collapsed
> is not a spread of samples but a *trade-off*, so the missing coordinate is not
> a percentile, it is the latency point the throughput was measured at.
> [→ Distributed: The Network Is Hostile](../distributed/#/the-network-is-hostile)

## 2. The batch-size question

**Almost every inference number changes by an order of magnitude between batch 1
and batch 256 — and latency and throughput move in opposite directions.**

This is the same fact as rule 1, seen from the knob rather than the curve. At
batch 1 a GPU re-reads the entire model from memory to produce a single token, so
per-user latency is at its best and hardware efficiency at its worst. At batch
256 that same memory read is amortized across 256 tokens: throughput up by a
large factor, per-token latency up too.

Both configurations are honest. They are not comparable. A benchmark quoting
throughput from a large batch and latency from a small one has reported two
different machines.

*Ask: what batch size, and was it the same batch size for both numbers?*

## 3. Peak versus sustained

**Vendor FLOP/s and GB/s are ceilings under ideal conditions. Nothing achieves
them.**

Real achievable memory bandwidth runs about **80–90%** of the peak figure, before
your kernels have done anything wrong. Real dense prefill runs at **35–55%** of
peak FLOP/s. These gaps are structural — refresh overhead, access patterns,
kernel launch gaps, imperfect tiling — not signs of a broken setup.

The failure this defuses is subtle and extremely common: someone compares *their
measured* number against *someone else's peak* and concludes they are 50% behind.
They are comparing two different quantities. A 45% MFU is not half of a
competitor's 90%; it may be better than a competitor who never published theirs.

*Ask: is this measured or is this the spec sheet? Measured against what baseline?*

> [!bridge] You already know this — from the Linux course
> The USE method already taught you that a resource at 100% utilization may be
> perfectly healthy and a resource at 10% may be the bottleneck — the reading
> only means something once you know what the ceiling represents and how much
> work is queued behind it. Same discipline, one extra wrinkle: on a GPU the
> published ceiling is itself unreachable, so a percentage-of-peak figure is
> being measured against a denominator nobody ever hits.
> [→ Linux: Performance Analysis Methodology](../#/perf-methodology)

## 4. Sparse versus dense FLOPs

**The headline FLOP number on the slide usually includes 2:4 structured
sparsity — a factor of two that dense inference does not get.**

Modern tensor cores can skip half the multiplications in a weight matrix if it
has been pruned so that two of every four values are zero. Marketing quotes the
sparse rate because it is the larger number. Dense inference — which is what you
are running — gets exactly half of it.

The damage is not just an overstated headline. That figure feeds the ridge point
that tells you when you are compute-bound versus memory-bound, and it is the
denominator of every utilization number you report. Use the sparse figure and
your ridge point and your MFU are both wrong by 2×, in the direction that makes
you think you have compute headroom you do not have.

*Ask: dense or sparse? At what precision?*

## 5. Logical versus physical cache hit rate

**A prefix "hit" on a block that had already been evicted is a miss that cost you
a lookup.**

Prefix caching lets a repeated prompt skip its prefill. Systems report a hit rate
for it, and there are two entirely different things that name can mean. *Logical*
hit rate: a reusable prefix existed somewhere. *Physical* hit rate: the bytes
were actually still resident and were actually reused.

Under memory pressure these diverge enormously, because the pool evicts blocks to
make room for live requests. A 99% logical hit rate alongside unchanged
time-to-first-token is the signature: every "hit" ended in a recompute. Logical
hit rate flatters; physical hit rate is what appears on the bill.

*Ask: hits that found a match, or hits that saved a prefill?*

## 6. Theoretical versus blended margin

**A cost per token computed at 100% utilization is a physics result, not a
business one.**

Divide GPU dollars per hour by tokens per hour and you get a number that assumes
the GPU never idles. Real fleets run at **30–60%** utilization — traffic has
peaks and troughs, capacity is provisioned for the peak, and models must stay
resident to be warm. Dividing by that:

```text
   1 / 0.60 ≈ 1.7×        1 / 0.30 ≈ 3.3×
```

So the blended cost is **1.7–3.3× the theoretical one**. That multiplier is not a
rounding error on the analysis; it is roughly the entire margin structure of the
inference industry. Every "we can serve this for $0.20 per million tokens"
estimate you will read is a theoretical number, and the gap between it and the
posted price is mostly this factor rather than profit.

*Ask: at what utilization? Averaged over what period?*

## The questions to ask

Carry these into any vendor conversation, any benchmark blog, any internal
dashboard review. They fit on one card.

1. **At what per-user tokens/second?** — otherwise the throughput is a point with
   no coordinates.
2. **At what batch size, and the same one for every number quoted?**
3. **Measured or peak?** And if measured, at what MFU or MBU?
4. **Dense or sparse FLOPs? At what precision?**
5. **What context length, and what input:output token ratio?** — the shape of the
   traffic changes every number above.
6. **Cache hit rate: logical or physical?**
7. **At what fleet utilization is that cost computed?**
8. **What quality did it come with?** — every number in this chapter can be
   improved by making the model worse, and
   [Did Quantization Break Your Model?](#/did-quantization-break-your-model) is
   about how invisible that can be.

A claim that survives all eight is probably real. Very few are asked even two.

## What to remember

- **Throughput without a latency point is unfalsifiable.** Serving is a Pareto
  curve; any single figure on it was chosen.
- **Batch size is the hidden variable.** It moves latency and throughput in
  opposite directions by an order of magnitude, so both numbers must come from
  the same run.
- **Peak is not achievable.** ~80–90% of peak bandwidth, 35–55% MFU on dense
  prefill. Never compare your measurement to someone else's spec sheet.
- **Marketing FLOPs are sparse FLOPs** — a 2× overstatement for dense inference
  that corrupts your ridge point and your MFU together.
- **Logical hit rate flatters; physical hit rate bills.** An evicted hit is a miss
  with extra steps.
- **Cost at 100% utilization is fiction.** Real fleets run 30–60%, so blended cost
  is 1.7–3.3× theoretical — which is most of the industry's margin structure.

## Frequently asked

<div class="faq">

<details>
<summary>Is anyone actually being dishonest here?</summary>

Rarely, and it does not matter. Every number in this chapter can be produced by
an honest engineer running a real measurement and reporting it without its
conditions. The conditions are the claim. That is why the remedy is a list of
questions rather than a list of villains — and why you should apply all eight to
your own dashboards first, where the incentive to omit is just as strong and the
consequences land on you.

</details>

<details>
<summary>Which single question catches the most bad numbers?</summary>

"At what batch size?" It subsumes most of rule 1, exposes mismatched
latency-and-throughput pairs, and is specific enough that there is no graceful
way to avoid answering. If you only ever ask one, ask that one. If you get to ask
two, add "measured or peak?"

</details>

<details>
<summary>Does this mean published benchmarks are useless?</summary>

No — it means they are useful for the comparison they actually make and nothing
else. A benchmark that fixes batch size, context length, precision and hardware,
then varies one thing, is a real experiment and worth reading closely. What is
useless is a single headline figure lifted out of such a run and quoted against a
figure from a different one. Read the configuration table; it is usually more
informative than the chart.

</details>

</div>

```quiz
[
  {
    "q": "A vendor claims their stack serves 12,000 tokens/second on eight H100s. What is the first thing you need before that number means anything?",
    "choices": [
      "The model's parameter count",
      "The per-user tokens/second it was achieved at — throughput and per-user speed trade against each other along a Pareto curve, so any single point on it was chosen",
      "The price per GPU-hour",
      "Whether the GPUs were SXM or PCIe"
    ],
    "answer": 1,
    "explain": "Aggregate throughput and per-user latency are two coordinates of one point on a trade-off curve, and you can slide along that curve just by changing the batch size. Twelve thousand tokens/second is compatible with a snappy interactive service and with one where each user waits seconds between tokens. Without the latency coordinate the claim cannot be falsified."
  },
  {
    "q": "Your prefill achieves 42% MFU. A competitor's datasheet says their accelerator does 2 PFLOP/s. What is wrong with concluding you are far behind?",
    "choices": [
      "Nothing — 42% is genuinely poor and should be near 100%",
      "You are comparing a measured number to a peak number: real dense prefill runs at 35–55% of peak, and the 2 PFLOP/s figure is a ceiling nobody achieves, so the two quantities are not comparable",
      "MFU only applies to decode, not prefill",
      "The competitor's number is in FP8 and yours is in FP4"
    ],
    "answer": 1,
    "explain": "Peak FLOP/s is an ideal-conditions ceiling; achievable dense prefill is 35–55% of it and achievable bandwidth is 80–90% of peak, before anything is misconfigured. Comparing your achieved figure against someone else's spec sheet compares two different quantities — and 42% MFU may well be better than a competitor who simply never published theirs."
  },
  {
    "q": "Why does using the marketing FLOP number make both your ridge point and your MFU wrong, and by how much?",
    "choices": [
      "By 10×, because marketing numbers are quoted in FP4",
      "By 2×, because the headline usually includes 2:4 structured sparsity — a rate dense inference does not get — and that figure is both the numerator of the ridge point and the denominator of MFU",
      "By 4×, because it assumes perfect memory bandwidth as well",
      "It does not affect the ridge point, only MFU"
    ],
    "answer": 1,
    "explain": "2:4 structured sparsity lets tensor cores skip half the multiplies in a suitably pruned matrix, and vendors quote that larger rate. Dense inference gets half of it. Since the ridge point is peak FLOP/s ÷ peak byte/s and MFU is achieved ÷ peak FLOP/s, a 2× overstatement corrupts both — and in the direction that makes you believe you have compute headroom you do not have."
  },
  {
    "q": "An analysis computes $0.30 per million tokens for a self-hosted deployment. What correction does the sixth rule demand, and why does it matter so much?",
    "choices": [
      "Multiply by 1.1 to cover networking overhead",
      "Divide by real fleet utilization of 30–60%, giving 1.7–3.3× the theoretical cost — a factor that accounts for roughly the whole margin structure of the industry",
      "Nothing, provided the GPU hourly rate was accurate",
      "Add the cost of the KV cache memory separately"
    ],
    "answer": 1,
    "explain": "A cost derived by dividing GPU dollars per hour by tokens per hour assumes the hardware never idles. Real fleets run at 30–60% because capacity is provisioned for peak traffic and models must stay resident to stay warm. 1/0.6 ≈ 1.7 and 1/0.3 ≈ 3.3, so blended cost is 1.7–3.3× theoretical — and most of the gap between a theoretical estimate and a posted API price is that factor rather than profit."
  }
]
```
