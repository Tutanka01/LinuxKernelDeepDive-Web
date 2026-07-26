# Hardware & Economics

> **Goal of this chapter:** stop being fooled. After this chapter you can
> walk into any accelerator pitch and ask the five questions that matter,
> read a token price and name exactly which physics each dollar pays for,
> and look at a "3,000 tokens/sec!" headline and know precisely what it
> conveniently left out. You have the whole technical stack now; this is
> what you run it *on*, what it *costs*, and how not to get sold.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,fabric"></div>

You know how inference works. You do not yet know what it costs, or why a
GPU that is "4× faster on paper" can serve tokens more *expensively* than
the one it replaced. Those answers do not live in a spec sheet — they live
at the intersection of memory bandwidth, interconnect topology, and fleet
utilization, three things this course already taught you to reason about.

Two ground rules. **Organize by strategy, not by SKU** — chip names rot in
months; the *reason* a vendor exists is stable. And **every number here is
radioactive**, quarantined in a dated box so you can distrust it on
schedule. The frames outlive the figures.

## The landscape, by strategy

### NVIDIA: the unit of purchase became the rack

For a decade you bought a GPU. NVIDIA's real 2026 product is a **rack**.
The GB200/GB300 NVL72 wires 72 GPUs into a *single NVLink domain* — one
coherent, ~900 GB/s-per-GPU fabric that presents to your scheduler as one
enormous accelerator. Recall from [Serving MoE at Scale](#/moe-serving) why
this is the whole game: wide expert parallelism (EP64 and beyond) needs
every expert one low-latency hop away, and a 72-GPU coherent domain gives
you exactly that. The same fabric hosts a shared high-bandwidth KV pool and
lets [prefill/decode disaggregation](#/disaggregation) happen *inside* one
box instead of across a slow datacenter network.

That is the moat, and it is not FLOPs. It is **composability**: FP4
arithmetic, disaggregation, and wide-EP all working *at once*. SemiAnalysis
measured Hopper→Blackwell gains of 9.7× to 65× tokens-per-dollar and traced
most of it to the fabric, not the raw math. A serving system is a network
of chips, and NVIDIA sells the network.

> [!bridge] You already know this — from the Linux course
> A NUMA machine is one address space with a cliff in it: local memory is fast,
> the far node is not, and *placement* is what decides which one you get. An
> NVL72 is that idea one level up — 72 GPUs presented to the scheduler as a
> single accelerator, with the cliff pushed out to the rack boundary instead of
> the socket boundary. What differs is that you cannot fix a bad placement here
> by migrating a page; the expert or the KV block is where the topology put it.
> [→ Linux: NUMA Deep Dive](../#/numa-deep-dive)

> **State of play (mid-2026):** **B200** (Blackwell): 192 GB HBM3e,
> ~8 TB/s, ~9,000 FP4 TFLOPS, 1 kW — roughly 4× H100 for inference.
> **B300** (Blackwell Ultra): 288 GB, ~15,000 FP4 TFLOPS, 1.4 kW — the
> extra memory aimed at KV-heavy long-reasoning decode. A **GB300 NVL72**
> rack is ~1.1 FP4 ExaFLOPS at roughly $3.3M. On the horizon: **Vera Rubin
> (VR200)**, shipping fall 2026 — 288 GB *HBM4* at ~22 TB/s (2.8×
> Blackwell), ~50 PFLOPS FP4, marketed at "~10× lower token cost." NVIDIA
> still holds ~80–90% of merchant inference silicon.

### AMD: the chip is fine; the software is the gap

The honest read on AMD is more interesting than "cheaper alternative."
Their silicon is genuinely competitive — on paper the **MI355X** carries
*more* HBM than a B200, and on a *single* technique (FP4 alone, or
disaggregation alone) it matches Blackwell. The gap opens precisely when
techniques **compose**: FP4 *and* disaggregation *and* wide-EP running
together, which is exactly the frontier production configuration. That is
not a transistor problem — it is a **ROCm software-maturity** problem, the
kernels and collective libraries and scheduler integrations that took
NVIDIA's CUDA ecosystem fifteen years to harden. The chip is not the moat,
and it is not the bottleneck either.

> **State of play (mid-2026):** **MI355X** (CDNA4): 288 GB HBM3e, 8 TB/s,
> native FP4/FP6, 1.4 kW liquid-cooled. **MI325X:** 256 GB, 6 TB/s. Treat
> AMD's "35× inference" headline with suspicion — it stacks MI355X FP4
> against MI300X FP8, two changes at once. The load-bearing fact:
> single-technique parity with B200, composed-technique deficit, closing as
> ROCm matures.

### Google TPU & AWS Trainium: silicon aimed at captive demand

The hyperscalers play a different game. They do not need to *sell* chips;
they need to *serve their own inference*, and a merchant margin on NVIDIA is
pure cost. So they build custom ASICs pointed at demand they already own.
Google's **Ironwood (TPU v7)** is an explicit "age of inference" pivot — the
first TPU line to split training and inference parts. AWS's **Trainium**
does the same for Amazon and its anchor tenant, Anthropic. The pattern is
the story: **vertical integration against captive inference demand**, where
you co-design model, compiler, and silicon and never pay a reseller.

> **State of play (mid-2026):** **Ironwood** (GA Apr 2026): 192 GB HBM3e,
> 7.37 TB/s, 4,614 FP8 TFLOPS (first TPU with native FP8); pods scale to
> **9,216 chips** = 42.5 FP8 ExaFLOPS. **Trainium2** claims ~54% lower
> cost-per-token vs comparable GPUs; **Trainium3** hits 2.52 PFLOPS FP8.
> **Project Rainier** put ~400–500k Trainium2 behind Anthropic (Anthropic
> cites ~1M chips training and serving Claude); Apple moved Siri-tier
> inference onto Trainium2 in Feb 2026.

### SRAM dataflow silicon: buying latency with the HBM wall

This is the one worth teaching as *physics*. Every GPU decode step is
throttled by the [HBM wall](#/inference-arithmetic): to emit one token you
must stream the model's weights out of high-bandwidth memory, and bandwidth
— not arithmetic — sets the ceiling. Groq, Cerebras, and SambaNova make a
radical bet: **skip HBM entirely.** Keep everything in on-chip **SRAM**,
which is orders of magnitude faster, and stream a dataflow through it. The
payoff is spectacular single-stream speed — Cerebras clocks ~3,000 tokens/s
on a 120B model where an H100 does ~100–150.

But SRAM is *tiny*. A single chip holds megabytes where HBM holds hundreds
of gigabytes, so a whole model's weights plus KV need **many chips** wired
together — huge counts, huge capital, mostly idle at low load. At *batch*,
GPUs amortize weight-streaming across many concurrent sequences and win
decisively on **throughput-per-dollar**. So the dataflow crowd owns the
**latency-critical niche** — voice, interactive agents, reasoning loops
where a human waits on every token — and cedes the batch fleet. This is the
**latency-versus-throughput tension** from continuous batching, cast in
silicon: one architecture optimizes the single stream, the other the fleet,
and no chip does both.

> **State of play (mid-2026):** single-stream on ~120B open models —
> Cerebras ~3,000 tok/s, SambaNova >600 tok/s, Groq ~476 tok/s, versus
> ~100–150 on an H100. SambaNova serves full DeepSeek-R1 671B at ~198 tok/s
> on 16 chips. Fast; economics contested at batch.

## The buyer's checklist (this part is timeless)

Strip away branding and only five numbers decide whether a chip serves
*your* workload well:

| Spec | What it buys | Bound it relieves |
|---|---|---|
| **HBM capacity** (GB) | concurrency — how much KV fits | users per GPU |
| **HBM bandwidth** (TB/s) | decode speed per stream | the decode wall |
| **Interconnect domain** (GPUs/fabric) | parallelism reach | MoE + disaggregation |
| **Low-precision throughput** (FP8/FP4) | prefill + quantized decode | the prefill wall |
| **Watts** | everything, now power is the scarce input | your electricity bill |

A chip is not "fast" or "slow" — it is fast *at a workload shape*. A
KV-heavy long-reasoning service is starved by capacity and bandwidth; a
short-prompt classifier is starved by FP8 compute. Match the bottleneck,
not the headline.

## Economics I: the price collapse and its S-curve

The single most dramatic fact in the field: frontier output tokens fell
from **$60/M** at GPT-4's 2023 launch to roughly **$10/M** for a 2026
frontier model, and **~$0.19/M** for a strong open-weight model on a
commodity host. That is ~95% deflation in three years — some
quality-adjusted indices put it near 300×.

Now the honest part, because "exponential forever" is a lie the graph tells
at a distance. **The deflation has slowed to roughly 6% year-to-date by
mid-2026.** The easy wins — quantization, better kernels, the jump to
Blackwell — have been *harvested*; further drops now wait on new silicon.
And demand did not sit still: **test-time compute** (reasoning models that
emit 10–100× more tokens per request) reloaded the meter, shoving the fleet
toward memory-bound decode. Read it as an **S-curve**, not a permanent
exponential: a steep collapse flattening as the cheap tricks run out.

> **State of play (mid-2026), output $/1M:** GPT-4 launch (Mar 2023) $60 →
> GPT-4o (2024) $10 → GPT-5 (2026) $10 → Gemini 3.1 Flash (Apr 2026) $0.40
> → gpt-oss-120B on DeepInfra ~$0.19. H100 rental: ~$1.40/GPU-hr on
> neoclouds, up to ~$11/hr hyperscaler on-demand.

## Economics II: where the margins actually live

A price list is a physics readout if you know how to read it. Everything
you learned about *why* inference costs what it does shows up as a line
item:

- **Input vs output.** Input tokens are cheaper than output because
  **prefill is compute-bound and parallel** while **decode is memory-bound
  and serial** — the exact split from [Inference
  Arithmetic](#/inference-arithmetic). You pay more per output token because
  each one drags the whole model out of HBM again.
- **Cached input ~10× cheaper.** Anthropic reads cached context at 0.1×;
  the KV for a shared prefix was computed *once* and reused, so you skip the
  prefill entirely — the [prefix cache](#/paged-kv-cache) and
  [KV fabric](#/disaggregation), billed. For agents and RAG, **cache-hit
  rate dominates the bill** more than sticker price does.
- **Batch APIs −50%.** A flat half-off for a 24-hour SLA, because the
  provider uses your patient work to **backfill fleet troughs**, turning
  idle off-peak GPUs into revenue.

### The DeepSeek "545%" case study — read it correctly

In March 2025 DeepSeek disclosed a **545% daily cost-profit ratio**:
~$87,000/day in GPU cost against ~$562,000/day of *theoretical* revenue,
which annualizes to a startling ~$200M. The internet read "AI inference is
wildly profitable." That is the wrong lesson. The 545% assumes **every GPU
billed at peak rates, fully utilized, around the clock.** Reality: R1 costs
more to serve than V3, *most* traffic was free-tier, and heavy off-peak
discounts pulled the blended price far below the headline. The number is a
*theoretical ceiling*, not a P&L.

That gap — **enormous peak-utilization margin, modest blended reality** —
is the single best lesson in inference unit economics. A GPU serving a full
batch at peak prices mints money; the same GPU idling through a demand
trough burns it. The whole business is the fight to keep the fleet full,
which is why batch discounts, off-peak pricing, and caching exist at all.

> **State of play (mid-2026):** open-weight serving is a **commodity,
> capital-intensive, ~50%-gross-margin** business — GPU cost dominates
> COGS. Fireworks AI ~$800M ARR at ~50% margin; Together AI ~$1B ARR;
> DeepInfra ~5T tokens/week at the floor. Identical models price to the
> floor; providers differentiate on latency SLAs, fine-tuning, compliance,
> and catalog — *not* the tokens.

Both halves of that lesson are dials you can turn. Set the GPU-hour price and
the tokens/sec to your own hardware, then move only two things — **fleet
utilisation** and **prefix-cache hit rate** — and watch how much further they
push the cost per million tokens than any plausible change in the sticker price
of the silicon does.

<div class="inf-widget" data-widget="cost-calculator">
<p class="inf-widget-fallback">Interactive token cost and margin calculator — needs JavaScript enabled.</p>
</div>

## Benchmarks: how not to be fooled

This section should sting, because the numbers you see marketed are
engineered to mislead — usually not by lying, but by omission.

**A throughput number without its latency point is meaningless.** This is
the big one. "60,000 tokens/sec/GPU!" is *half* of a fact. Throughput and
per-user speed trade off continuously along a **Pareto curve** —
tokens/sec/GPU (fleet efficiency) against tokens/sec/user (interactivity).
The *same* B200 serves tokens at **~$0.06/M** deep in the batch regime or
**~$4/M** at snappy interactive speed. Both are true; neither compares to a
rival's single cherry-picked dot. The honest unit is the whole curve —
exactly what SemiAnalysis's **InferenceX** contributed: TCO-normalized
$/M-tokens and tokens/megawatt swept across the full frontier.

Three more traps:

- **Silent quantization.** A provider serves an FP4 model at
  full-precision prices and quotes full-precision quality. Independent
  accuracy trackers exist precisely because you cannot assume the weights on
  the wire are the weights on the box.
- **Peak vs sustained, cherry-picked lengths.** TTFT idle looks nothing
  like TTFT under load. *Short* sequences flatter compute-bound configs;
  *long* sequences expose the KV-capacity limits the vendor would rather you
  not test.
- **Know your source.** **MLPerf** is *audited* against identical accuracy
  targets — trustworthy, but lags ~6 months and lets vendors pick favorable
  divisions. **Artificial Analysis** is the practical cross-provider
  scoreboard (intelligence index plus real price/speed).

**How to benchmark yourself:** run `vllm bench serve` or `guidellm` against
*your* traffic shape, and always report **P50 and P99 for both TTFT and
TPOT at a fixed request rate** — never averages, which hide the tail your
users actually feel. A mean latency is a benchmark for the vendor; the P99
is a benchmark for you.

## Energy: the 2026 binding constraint

The last few years the scarce input was GPUs. Now it is **power**. A
frontier query costs a median ~0.3 Wh — individually trivial, but AI racks
now draw **100+ kW** (a GB300 NVL72 pushes ~120–140 kW) against ~10 kW for
legacy gear, dense enough that **liquid cooling is no longer optional**.
**Inference has overtaken training at ~60% of AI energy**: you train once
and serve forever.

Here is the throughline back to the roofline: **joules-per-token falls with
batch size.** Streaming weights out of HBM costs the same energy whether one
sequence or a hundred ride along, so bigger batches amortize that fixed cost
across more tokens. The latency-versus-throughput dial is *also* an energy
dial — which is why planners have stopped counting GPUs and started counting
**tokens per megawatt**. When the grid connection is the wall, that is the
only number that scales.

> [!bridge] You already know this — from the Linux course
> Governors and C-states encode the same bargain at a smaller scale: idle
> silicon still costs, so the win comes from doing the work in fewer, denser
> bursts and sleeping properly in between rather than trickling it out. What
> differs is where the fixed cost sits. A CPU's is the wake-up latency; a GPU's
> is the weight sweep out of HBM, which one step pays for and every sequence in
> the batch shares — so on a GPU the "race to idle" instinct is really a race to
> a bigger batch.
> [→ Linux: Power Management](../#/power-management)

## What to remember

- **Buy the rack, not the chip.** NVIDIA's moat is composability — FP4,
  disaggregation, and wide-EP working together across one NVLink domain.
  AMD's silicon matches on single techniques; the gap is ROCm, not
  transistors.
- **Five specs decide everything:** HBM capacity (concurrency), HBM
  bandwidth (decode), interconnect domain (parallelism reach), FP8/FP4
  throughput (prefill), watts. Match the bottleneck to your workload shape.
- **SRAM dataflow silicon** buys single-stream latency by skipping the HBM
  wall, and pays in chip count; GPUs win throughput-per-dollar at batch.
  The latency/throughput tension, cast in hardware.
- **Prices fell ~95% in three years, then slowed to ~6%/yr** — an S-curve.
  Cheap software wins are spent; reasoning reloaded demand.
- **Read a price list as physics:** input<output (prefill vs decode),
  cached ~10× cheaper (reused KV), batch −50% (troughs). DeepSeek's "545%"
  is a peak-utilization ceiling, not a real margin — utilization is the
  whole game.
- **A throughput number without its latency point is a lie of omission.**
  The Pareto curve is the only honest comparison; report P50/P99 TTFT and
  TPOT at a fixed rate. And power — tokens per megawatt — is the constraint
  everything now bends around.

## Exercises

<div class="exercise">

**Exercise 1.** You serve an open-weight 70B on one replica of **8×H100**,
rented from a neocloud at **$1.40 per GPU-hour**. Under production traffic —
input:output ratio **20:1**, prefix-cache hit rate **75%** — you measure
**12,000 output tokens/sec** sustained at batch size 256. Averaged over the
month the replica is actually serving **70%** of the hours you pay for. You list
output at **$0.60 per million tokens**.

(a) What does a million output tokens cost you to serve, and what is your gross
margin? (b) Your cache hit rate collapses to **0%** after a prompt-format change
breaks prefix stability. What happens to the margin? Use the course's work model:
an output token costs ~5× a fresh input token, and a cached input token costs
0.1× a fresh one.

<details>
<summary>Reveal answer</summary>

**(a) Cost and margin at 75% hit rate.**

What you rent: `8 × $1.40 = $11.20 per replica-hour`. What the replica produces
while it is actually serving: `12,000 × 3,600 = 43.2M` output tokens per
serving-hour. But you pay for hours, not serving-hours, and only 70% of them are
serving: `43.2M × 0.70 = 30.24M` output tokens per *rented* hour.

So the cost is `$11.20 ÷ 30.24 = $0.370 per 1M output tokens`, and against the
$0.60 list price the margin is `($0.60 − $0.370) ÷ $0.60 = 38%`.

**A 38% gross margin** — thin, capital-intensive, and entirely in line with the
~50% the section quotes for commodity open-weight serving.

**(b) The same replica at a 0% hit rate.**

Count the GPU work behind one delivered output token, in units of one output
token. The decode itself is 1. The 20 input tokens that came with it are worth
0.2 each (an output token is 5× a fresh input token), and a cached one is worth
0.02. At 75%: `1 + 20 × (0.25 × 0.2 + 0.75 × 0.02) = 1 + 1.30 = 2.30` units. At
0%: `1 + 20 × 0.2 = 1 + 4.00 = 5.00` units.

The same GPU-hour now buys `2.30 ÷ 5.00 = 0.46×` as many delivered output
tokens, so the cost per million rises by `5.00 ÷ 2.30 ≈ 2.17×`, to
`$0.370 × 2.17 = $0.805 per 1M output tokens` — a margin of
`($0.60 − $0.805) ÷ $0.60 = −34%`.

**You now lose about 34 cents on every dollar of revenue.** Note what did *not*
change: the hardware, the rental rate, the batch size, the utilisation, and the
list price. One client-side formatting change moved the business from a 38%
margin to underwater, which is the concrete version of the claim that
**cache-hit rate dominates the bill more than sticker price does**.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>A neocloud quotes $1.40/GPU-hour and my hyperscaler quotes $11. Is the neocloud really eight times cheaper?</summary>

On the line item, yes; on the bill, usually not by that much. The hyperscaler
price bundles committed capacity, a support path, and a network you have already
qualified, while the cheap rate is typically spot-ish, on a fabric you have to
verify before you can plan any of the disaggregation in this course. And the
exercise above shows the term that actually dominates: a fleet you can only keep
70% full at $1.40 loses to a fleet you can keep 95% full at $2.20. Price the
GPU-hours you will *use*, not the ones you can rent.

</details>

<details>
<summary>Deflation slowed to ~6%. Should I wait for prices to fall before committing to a model?</summary>

Waiting was a good strategy when prices halved twice a year; on an S-curve's
flat section it is just delay. The remaining drops are gated on new silicon
rather than on software you get for free with an engine upgrade, which means
they arrive on a hardware cadence — years, not months. The better move is to
build so the volatile layer is swappable: keep the model behind an interface,
keep your evals runnable against any provider, and re-price quarterly.

</details>

<details>
<summary>Does a chip with more HBM always serve more users?</summary>

More capacity buys more concurrent KV, so it raises the *ceiling* on
concurrency — but whether you reach it depends on bandwidth. Filling 288 GB with
KV and then discovering each decode step must sweep the weights and all of that
KV out of HBM at a fixed TB/s means you have bought users you cannot serve at
your inter-token-latency target. Capacity and bandwidth are two different rows
in the buyer's checklist for exactly this reason: one sets how many sequences
fit, the other sets how fast each of them advances.

</details>

</div>

[The Frontier](#/frontier) closes the course: where all of this is heading.

```quiz
[
  {
    "q": "A vendor advertises '60,000 tokens/sec/GPU' for their serving stack. Why is this, on its own, not a meaningful comparison?",
    "choices": [
      "Tokens/sec/GPU can never be measured accurately",
      "Throughput trades off against per-user speed along a Pareto curve; without the tokens/sec/user it was achieved at, the number could be a deep-batch figure no interactive user would tolerate",
      "The number is meaningless unless the GPU model is FP4-capable",
      "Only tokens/sec/user matters; aggregate throughput is irrelevant"
    ],
    "answer": 1,
    "explain": "Throughput and interactivity trade off continuously. The same B200 serves ~$0.06/M tokens deep in batch or ~$4/M at snappy speed — both true. A single throughput dot hides which end of that curve it came from, so the honest unit of comparison is the whole tok/s/GPU vs tok/s/user frontier."
  },
  {
    "q": "AMD's MI355X carries more HBM than an NVIDIA B200 and matches it on single-technique benchmarks, yet trails on real frontier production configs. Why?",
    "choices": [
      "The MI355X silicon is fundamentally slower per transistor",
      "AMD chips cannot do FP4 arithmetic",
      "The gap appears when techniques compose (FP4 + disaggregation + wide-EP at once), and it is ROCm software maturity — not the chip — that lags",
      "NVIDIA's HBM is a faster generation"
    ],
    "answer": 2,
    "explain": "On any single technique the MI355X matches B200. The deficit opens only when FP4, disaggregation, and wide expert parallelism run together — the frontier config — because the composed software stack (ROCm kernels, collectives, scheduler integration) is less mature. The chip is competitive; the ecosystem is the bottleneck."
  },
  {
    "q": "DeepSeek disclosed a '545% daily cost-profit ratio.' What is the correct lesson?",
    "choices": [
      "Inference serving reliably earns ~5x its costs",
      "The 545% is a theoretical peak-utilization ceiling; blended reality (free traffic, off-peak discounts, costlier reasoning models) makes real margins far more modest — utilization is everything",
      "DeepSeek fabricated the numbers",
      "Open-weight models are more profitable than closed ones"
    ],
    "answer": 1,
    "explain": "The 545% assumes every GPU billed at peak rates, fully utilized, 24/7. In practice most traffic was free-tier, R1 costs more than V3, and off-peak discounts dragged the blended price down. Peak-utilization margins are enormous; blended real-world margins are modest. The whole business is keeping the fleet full."
  },
  {
    "q": "Cerebras serves ~3,000 tok/s single-stream where an H100 does ~100–150, yet GPUs still dominate batch serving economics. What is the tradeoff?",
    "choices": [
      "Cerebras chips are less accurate",
      "SRAM dataflow skips the HBM bandwidth wall for blazing single-stream speed, but tiny on-chip memory forces huge chip counts, so GPUs win throughput-per-dollar by amortizing weight-streaming across a large batch",
      "H100s have faster interconnect",
      "Cerebras cannot run models larger than 120B parameters"
    ],
    "answer": 1,
    "explain": "SRAM is orders of magnitude faster than HBM but holds only megabytes, so a full model plus KV needs many chips. That wins the latency-critical single stream (voice, interactive reasoning) but is capital-heavy and mostly idle at low load. GPUs amortize weight-streaming across a batch and win throughput-per-dollar — the latency-vs-throughput tension in silicon."
  },
  {
    "q": "Why does cached input on an LLM API cost roughly 10× less than fresh input, and why do datacenter planners now track 'tokens per megawatt'?",
    "choices": [
      "Caching compresses the tokens; power is tracked for billing convenience",
      "A cached prefix reuses KV computed once (skipping prefill), so you pay only storage/read; and joules-per-token falls with batch size while racks now draw 100+ kW, making power — not GPU count — the scarce input",
      "Cached tokens are lower quality; megawatts are a marketing metric",
      "Caching only helps decode, not prefill; power is irrelevant to token cost"
    ],
    "answer": 1,
    "explain": "A cache hit means the prefix's KV was already computed, so the expensive compute-bound prefill is skipped and you pay only for reuse. On energy: weight-streaming costs fixed joules regardless of batch, so energy/token drops as batches grow — and with racks at 100+ kW and inference at ~60% of AI energy, tokens-per-megawatt is the metric that actually scales."
  }
]
```
