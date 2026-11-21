# Hardware & Economics

> **The question:** what does a token actually cost — on which silicon, at what
> utilisation — and when does running your own hardware beat paying per token?
>
> **You'll be able to:** derive from the step-time model why output tokens cost more
> than input tokens and what a cached token saves; compute a cost per token and a
> break-even for a fixed-price node from token counts, day-average utilisation and the
> lines of a minimal TCO; compare accelerators on the properties that matter for a
> workload's shape, reading each vendor claim for what it holds fixed.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="runner,fabric"></div>

You know how inference works. This chapter is about what it runs on and what it costs.
Two ground rules. Organise hardware by **strategy**, not by product name — chip names
rot in months, while the reason a vendor exists lasts. And every specific number sits
in a dated box or carries its source, so you can distrust it on schedule.

## A price list is physics

The large providers' price lists in November 2026 all charge more for output than for
input, and much less for cached input. Both follow from the step-time model of [Inference
Arithmetic](#/inference-arithmetic), `step ≈ max(t_w, t_c) + t_kv`.

> [!predict] Before you read on
> On one Ask Halden replica (Llama-3.3-70B in FP8 on two H100s), how many input tokens
> cost the same GPU time as one output token when 32 sequences decode together: about
> 1, about 6, or about 150?

An input token rides in a prefill chunk of hundreds of tokens. The weights are read
once for the whole chunk, so each token pays only its arithmetic, `t_c` ≈ 0.089 ms. An
output token rides in a decode step whose weight read is shared only by the sequences
decoding at that moment, and which also reads every one of their caches:

```python
# What an input and an output token cost on one Ask Halden replica:
# Llama-3.3-70B, FP8, TP=2 on two H100s at $2.50 per GPU-hour.
# Step-time model from case.md: step = max(t_w, t_c) + t_kv.
T_W = 14e-3          # weights read once per step (rung 3)
T_C = 0.0886e-3      # arithmetic per token in the step (40% MFU)
NS_KV = 28.8e-9      # KV read per context token per sequence
DOLLARS_PER_S = 2 * 2.50 / 3600
CTX = 3000           # context each decoding sequence carries

def step(tokens, ctx_tokens):
    return max(T_W, tokens * T_C) + ctx_tokens * NS_KV

def per_million(seconds_per_token):
    return seconds_per_token * DOLLARS_PER_S * 1e6

inp = step(512, 0) / 512                      # a full prefill chunk
print(f"input token          {inp*1e3:6.3f} ms  ${per_million(inp):5.2f}/M")
for batch in (1, 8, 32, 120):                 # 120 fills the 66 GB pool
    out = step(batch, batch * CTX) / batch
    print(f"output, batch {batch:>3}   {out*1e3:6.3f} ms  "
          f"${per_million(out):5.2f}/M  = {out/inp:5.1f} x input")

# input token           0.089 ms  $ 0.12/M
# output, batch   1   14.086 ms  $19.56/M  = 159.0 x input
# output, batch   8    1.836 ms  $ 2.55/M  =  20.7 x input
# output, batch  32    0.524 ms  $ 0.73/M  =   5.9 x input
# output, batch 120    0.203 ms  $ 0.28/M  =   2.3 x input
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

About six, at a batch of 32. The ratio is not a constant of nature: it is 159 at batch 1
and 2.3 when the pool is full, because the weight read is shared more widely as the
batch grows while the KV reads are not shared at all. A ~5× price ratio is a provider
quoting decode at an interactive batch, where users still see fast tokens. One
published measurement agrees: DeepSeek reported that an H800 node averaged ~73.7K input
tokens/s while prefilling and ~14.8K output tokens/s while decoding — five to one
([DeepSeek, open-source week day 6](https://github.com/deepseek-ai/open-infra-index),
data for 27–28 February 2025).

A cached input token skips its arithmetic entirely; what it costs is memory held between
requests — HBM, or a cheaper tier behind it ([The KV Fabric](#/the-kv-fabric)). That is
why it can be discounted so steeply.

> **State of play (November 2026)**, per million tokens, standard tier, from the
> providers' pricing pages (checked 21 November 2026):
>
> | Model | Input | Output | Cached input |
> |---|---|---|---|
> | Claude Opus 5.5 | $4 | $20 | $0.20 (0.05×) |
> | Claude Sonnet 5.5 | $2 | $10 | $0.10 (0.05×) |
> | gpt-6.2-sol | $2 | $10 | $0.10 (0.05×) |
> | Gemini 3.1 Pro (preview) | $2 | $12 | $0.20 (0.1×) |
>
> Output costs 5–6× input everywhere. Cached input is now 20–40× cheaper than fresh
> input at Anthropic and OpenAI (10× at Google); Anthropic bills a five-minute cache
> *write* at 1.25× the input price. Batch APIs are 50% off; OpenAI's background requests
> are 30% below standard with a two-hour window and 40% below with eight hours; Anthropic's
> fast mode sells up to 2.5× the output speed at twice the price — the throughput-versus-
> latency curve of [Continuous Batching](#/continuous-batching), sold as price tiers.
> And per-token prices do not compare across tokenizers: Anthropic notes that its newer
> tokenizer produces about 30% more tokens for the same text.

## One cost model

Cost per token from Inference Arithmetic, with the two corrections the case needs:

```text
   cost per request  =  $ per replica-second × work-seconds per request ÷ utilisation

   work-seconds      ≈  (uncached prompt tokens + output tokens) × 0.089 ms
                         — a saturated replica spends its time in compute-bound steps
   utilisation       =  work-seconds done ÷ replica-seconds paid, averaged over the day
```

First, input counts. Ask Halden sends 3,000 tokens in and receives 250: 92% of its
tokens are input, so an output-only cost per token prices the wrong thing. Second,
"utilisation" has one meaning in this chapter: the share of the hours you pay for that
the GPUs spend working, **averaged over the day**. The prefill load at the 10:00 peak
(15% for phase 1 in [Sizing a Deployment](#/sizing-a-deployment)) is a different number
that answers a latency question, not a cost one.

> [!predict] Before you read on
> In March 2025 DeepSeek published a 545% daily "cost profit margin" for serving V3 and
> R1: $87,072 of GPU cost against $562,027 of theoretical revenue. Does that make
> serving R1 a 545%-margin business?

No. The cost side was honest — it used the day's *average* node count, 226.75 nodes of
eight H800s at $2 an hour, because DeepSeek scales serving down at night. The revenue
side priced every token at R1's API rates, while web and app use was free, V3 is priced
below R1, and night-time discounts apply. A full fleet at list price makes a great deal
of money; the same fleet idling or giving tokens away does not. Batch discounts,
off-peak pricing and caching all exist to keep the fleet full of *paid* work.

<div class="inf-widget" data-widget="cost-calculator">
<p class="inf-widget-fallback">Interactive token cost and margin calculator — needs JavaScript enabled.</p>
</div>

## Accelerators, by strategy

**NVIDIA sells the rack.** NVL72 systems join 72 GPUs in one NVLink domain; from
[Serving MoE at Scale](#/moe-serving) you know why wide expert parallelism wants that,
and [Disaggregated Serving](#/disaggregation) why cheap KV transfer does. The advantage
is less any one chip's FLOPs than formats, fabric and software working together.

**AMD competes on silicon and closes the software gap release by release.** vLLM made
Model Runner V2 its ROCm default in v0.32 and ships ROCm 10 images; whether the gap is
closed depends on which kernels your model needs.

**Hyperscaler ASICs serve demand their owners already have.** Google's TPUs are the
mature example; the software is less of a moat than it was — SGLang v0.5.23 runs on
TPU7x through a PyTorch-native plugin.

**SRAM silicon has become the decode half of hybrid systems.** Groq, Cerebras and
SambaNova keep weights in on-chip SRAM, far faster than HBM and far smaller: a Groq 3
LPU holds 500 MB, a Cerebras WSE-3 wafer 44 GB, against 80 GB of HBM on one H100.

> [!predict] Before you read on
> An LPX rack holds 128 GB of SRAM at 40 PB/s; a Rubin GPU holds 288 GB of HBM at
> 19.2 TB/s. Why would a vendor sell the two together instead of replacing one with the
> other?

Because prefill and decode want different things, which is the argument of
[Disaggregated Serving](#/disaggregation) cast in silicon. Prefill is compute-bound: SRAM
bandwidth is wasted on it, and the KV of long contexts wants cheap capacity. Decode at
small batch is a weight read per token, which SRAM makes nearly free. So NVIDIA pairs
Rubin with Groq 3 LPX — the GPUs process long contexts, and in decode GPU and LPU
compute every layer together — and Cerebras now sells AMD GPUs for prompts with CS-3
systems generating responses, the KV cache moving between them over RDMA. The old
framing, "dataflow for latency, GPUs for throughput", has become one fleet.

> **State of play (November 2026)** — vendor figures, each as its vendor states it:
>
> | System | Claim | Source |
> |---|---|---|
> | Rubin GPU | 288 GB HBM4, 19.2 TB/s; BF16 4 PFLOPS dense, FP8 17.5 PFLOPS dense, NVFP4 50 PFLOPS *sparse* (inference) | nvidia.com, Vera Rubin NVL72 page |
> | Vera Rubin NVL72 | "production shipments … this fall" | NVIDIA press release, 31 May 2026 |
> | Groq 3 LPX | 256 LPUs, 128 GB SRAM, 12 TB DDR5 per rack; "in full production" | nvidia.com LPX page; NVIDIA blog, 24 Aug 2026 |
> | AMD Helios | 72 MI455X per rack; "up to 30% more tokens per dollar" than Vera Rubin NVL72 (AMD estimate) | AMD newsroom, 23 Jul 2026 |
> | Google TPU 8i | 288 GB HBM, 384 MB SRAM; "80% better performance-per-dollar" than Ironwood; GA "later this year" | Google blog, Cloud Next 2026 |
> | Cerebras disaggregated inference | 5× throughput per megawatt of a CS-3-only setup, on gpt-oss-120b | Cerebras blog, 17 Nov 2026 |
>
> Rubin's ridge in BF16 is 4,000 ÷ 19.2 ≈ 208 FLOP/byte, lower than H100's 295:
> memory-bound work stays memory-bound. For FP8 weights with FP8 arithmetic, the batch
> at which decode becomes compute-bound is 17.5 × 10¹⁵ ÷ (2 × 19.2 × 10¹²) ≈ 456.

Read every row for what it holds fixed. "Sparse" FLOPs assume 2:4 sparsity few
inference workloads use; "tokens per dollar" depends on the model, the engine version,
the batch and the latency point; "per megawatt" is a facility claim, not a per-user one.

| Property | What it buys | Ask the vendor |
|---|---|---|
| HBM capacity | KV for more concurrent sequences | per GPU, in GB, usable |
| HBM bandwidth | a lower decode floor | per GPU; achieved on a streaming read |
| Interconnect domain | parallelism without slow links | GPUs per NVLink-class domain |
| Low-precision FLOPs | prefill, and decode past the knee | dense, at the precision you will run |
| Watts | everything, now that power is scarce | per rack, at load |

## Benchmarks and energy

A cost per token is a point on the throughput-versus-interactivity curve: the same GPU
makes cheap tokens deep in the batch regime and dear ones at snappy per-user speeds.
SemiAnalysis's open benchmark, InferenceMAX until early 2026 and now InferenceX
(`github.com/SemiAnalysisAI/InferenceX`), sweeps that curve across vendors and adds an
agentic-traffic suite, AgentX. MLPerf is audited against accuracy targets but lags. Your
own number comes from a sweep with your traffic shape ([Load Testing](#/load-testing)).

Energy follows the same curve. An H100 is specified at up to 700 W; at that draw a
two-GPU replica spends 2 × 700 W × 14 ms ≈ 20 J on one batch-1 token and ~0.7 J per
token at batch 32 — an upper bound, measured properly with the DCGM exporter's
`DCGM_FI_DEV_GPU_ENERGY_JOULES_TOTAL` counter divided by tokens served. Google
reported a median Gemini text prompt at about 0.24 Wh (August 2025).

> [!bridge] From the Linux course
> CPU governors and C-states encode the same bargain: idle silicon still costs, so do
> the work in dense bursts. What differs is the fixed cost. A CPU's is wake-up latency;
> a GPU's is the weight read every step pays and every sequence in the batch shares —
> so "race to idle" becomes "race to a bigger batch".
> [→ Linux: Power Management](../#/power-management)

> [!case] The case: what Ask Halden costs, and why the answer flips
> The node costs $7,300 a month whatever it does (4 × $2.50 × 730 h). The API comparison
> uses $3 in / $15 out per million, with provider caching at 0.1× for the agent's
> repeated context. Phase-2 volume, ~4,000 agent requests a day, is phase 1's ratio of
> daily requests to planned peak (12,000 ↔ 1.5 req/s) applied to 0.5 agent req/s. Each
> request sends 17K fresh input tokens ($0.051) and 30K cached ($0.009), and receives
> ~850 output tokens — three tool calls and an answer ($0.013): ≈ $0.07, ~$8,600 a month.
>
> | | Phase 1 | Phase 2 |
> |---|---|---|
> | Requests per day | 12,000 Q&A | + 4,000 agent |
> | Tokens per month, in / out | 1,080M / 90M | 6,720M / 192M |
> | Work, replica-seconds per day | 12,000 × 2,450 × 0.089 ms ≈ 2,600 | + 4,000 × 17,850 × 0.089 ms ≈ 8,900 |
> | Day-average utilisation (÷ 172,800) | 1.5% | 5.2% |
> | Node, on-demand rent | $7,300 | $7,300 |
> | Node, per million tokens | $6.20 | $1.06 |
> | Hosted API | $4,600 | $13,200 |
> | Break-even utilisation `u*` | 2.4% | 2.9% |
>
> Phase 1 runs below its break-even: the API is ~1.6× cheaper, and self-hosting is
> justified by the data rule, not by price. Phase 2 flips it — the node is ~1.8× cheaper
> — not because utilisation crosses a threshold (5% of the day is still idle silicon)
> but because the API bill scales with tokens and the node is a fixed price. The node
> matches the API when agent traffic reaches (7,300 − 4,600) ÷ 8,600 ≈ **31% of its
> phase-2 volume** on top of full phase-1 traffic — about 1,250 agent requests a day —
> or, equivalently, at 55% of the total phase-2 token bill.
>
> **What the plan records against rent alone:** a second node for redundancy would cost
> $14,600, more than the phase-2 API bill; Halden accepts one failure domain
> ([Sizing a Deployment](#/sizing-a-deployment) priced what that risks). Each $1,000 a
> month of engineer and on-call time moves the break-even ~12 points of agent volume
> (1,000 ÷ 8,600). A reserved-capacity discount `d` cuts rent to 7,300 × (1 − d); ask
> for it once phase 2 is committed. And the API estimate omits cache writes: at 1.25×
> the input price, the agent's 17K fresh tokens add ~$0.013 a request, ~$1,500 a month,
> which only widens the phase-2 gap.

> [!dashboard] Paid GPU-hours
> **Utilisation:** none as a metric — compute work-seconds from the token counters,
> `(increase(vllm:prompt_tokens_total) − increase(vllm:prompt_tokens_cached_total) +
> increase(vllm:generation_tokens_total)) × 0.089 ms`, and divide by replica-seconds
> paid. **Cost per token:** none — no engine exports it; divide the invoice by the same
> counters. **Saturation:** `vllm:num_requests_waiting` at the daily peak — a fleet
> that never queues is cheap to run and expensive to own. **Errors:** none for cost;
> energy per token from `DCGM_FI_DEV_GPU_ENERGY_JOULES_TOTAL`.

## Exercises

<div class="exercise">

**Exercise 1.** You serve an open 70B model on one 8 × H100 replica at $1.40 per
GPU-hour. Traffic has a 20:1 input:output ratio and a 75% prefix-cache hit rate; you
sustain 12,000 output tokens/s, and the replica works 70% of the hours you pay for. You
list output at $0.60 per million tokens. (a) Cost per million output tokens and gross
margin? (b) A prompt-format change drops the hit rate to 0%. Price GPU work with this
chapter's ratios — an output token ≈ 5× a fresh input token at your batch, a cached
input token ≈ 0.1× (memory held and moved, an assumption). What happens to the margin?

<details>
<summary>Reveal answer</summary>

(a) `8 × $1.40 = $11.20` per hour. `12,000 × 3,600 × 0.70 ≈ 30.2M` output tokens per
rented hour: `$11.20 ÷ 30.2 ≈ $0.37` per million; margin `(0.60 − 0.37) ÷ 0.60 ≈ 38%`.

(b) GPU work per delivered output token, in output-token units: at 75%,
`1 + 20 × (0.25 × 0.2 + 0.75 × 0.02) = 2.30`; at 0%, `1 + 20 × 0.2 = 5.00`. Cost rises
`5.00 ÷ 2.30 ≈ 2.17×` to **~$0.81** per million: a margin of **about −34%**. Same
hardware, price and batch; one formatting change put the business under water.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team's autoscaled fleet, billed by the GPU-hour, cost
about 1.7× more in November than in October. Its replicas run near batch 32. You pull
the counters:

```plaintext
query: sum(increase(<metric>[30d]))            October        November
vllm:request_success_total                      360,412        358,977
vllm:prompt_tokens_total                    1,081,236,000  1,076,931,000
vllm:prompt_tokens_cached_total               276,796,000      8,615,000
vllm:generation_tokens_total                   90,103,000    194,860,000
```

*Real format, illustrative values — counter names from vLLM v0.34.0 `vllm/v1/metrics/loggers.py` (counters gain `_total` when scraped), PromQL `increase()` over 30 days; numbers invented for the exercise, not measured.*

Requests are flat. What changed — two things — and which one costs more GPU time?

<details>
<summary>Reveal answer</summary>

Cached prompt tokens fell from 26% to under 1%: something now varies before the shared
system prompt (a date, a name), and every request recomputes it. Generation tokens
more than doubled per request (250 → 543): a model or prompt change made answers
longer. In input-token units, with an output token ≈ 6 input tokens at batch 32:
uncached prefill rose by 264M (804M → 1,068M), output by 105M × 6 ≈ 630M. Work went from
804 + 540 ≈ 1,345M to 1,068 + 1,170 ≈ 2,238M, the 1.7× on the bill, and the longer
answers cost more than twice the broken cache. Fix the template first (an hour's work),
then ask who approved longer answers.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Re-price Ask Halden's API comparison at November 2026 list
prices for Claude Sonnet 5.5: $2 in, $10 out, cache hits $0.10, five-minute cache writes
$2.50 (every fresh agent token is written so the next call can read it). Phase 1 has no
cache on the API side. Does the phase-2 case for the node survive, and where is the new
break-even?

<details>
<summary>Reveal answer</summary>

Phase 1: `12,000 × (3,000 × 2 + 250 × 10) ÷ 10⁶ ≈ $102` a day, ~**$3,060** a month.
Agent request: 17K written at $2.50 ($0.0425) + 30K read at $0.10 ($0.003) + 850 out
($0.0085) ≈ $0.054; × 120,000 a month ≈ **$6,420**. Phase 2 in total ≈ $9,480 against the
$7,300 node: the node is now only ~1.3× cheaper. Break-even: (7,300 − 3,060) ÷ 6,420 ≈
**66%** of the agent volume, against 31% at the case's prices. One price cut more than
doubled the volume the node needs. Two caveats: the Llama and Claude tokenizers count
the same text differently (Anthropic's newer tokenizer emits ~30% more), and the data
rule still excludes the API — this decides how the plan is justified, not whether.

</details>

</div>

## What to remember

- An output token costs a decode step's weight read shared only by the batch, plus KV
  reads: ~6× an input token at batch 32 on the case's replica, 159× at batch 1. Price
  lists quote the interactive batch.
- Cached input skips arithmetic and costs only memory, which is why it is discounted
  20–40× at two providers in November 2026.
- Cost per request = $ per replica-second × work-seconds ÷ day-average utilisation, with
  input counted; peak load is a latency number, not a cost one.
- A fixed-price node beats an API when token volume grows, not when a utilisation
  threshold is crossed; redundancy, staff time and price cuts move the break-even.
- SRAM chips now serve as the decode half of hybrid systems; read every vendor figure
  for its precision, sparsity and the batch it assumes.

```quiz
[
  {
    "q": "DeepSeek reported an H800 node decoding ~14,800 output tokens/s. At $2 per GPU-hour and full utilisation, what is the GPU cost per million output tokens?",
    "choices": [
      "About $0.04, from one GPU's price",
      "About $0.30, from the node's eight GPUs",
      "About $2.19, the R1 list price for output",
      "About $1.08, at the day's average occupancy"
    ],
    "answer": 1,
    "explain": "8 × $2 = $16 per node-hour; 14,800 × 3,600 ≈ 53.3M tokens per hour; $16 ÷ 53.3 ≈ $0.30 per million. One GPU's price misses the other seven; $2.19 is the revenue side, which is why the theoretical margin looked so large."
  },
  {
    "q": "A provider's fast tier sells up to 2.5× the output speed at twice the price per token. What is it selling, in this course's terms?",
    "choices": [
      "A newer chip that it reserves for premium customers",
      "Smaller decode batches, each step shared by fewer users",
      "A quantized model that reads fewer bytes per token",
      "Priority in the prefill queue, which shortens time to first token only"
    ],
    "answer": 1,
    "explain": "Per-user speed rises when fewer sequences share each step, and the step's fixed cost is then split among fewer tokens — the throughput-versus-latency curve sold as a price tier. A quantized model would change answers, and queue priority moves TTFT, not output speed."
  },
  {
    "q": "Two APIs both charge $2 per million input tokens. One model's tokenizer produces 30% more tokens for the same documents. For a retrieval workload, what is the cost per answer of that one?",
    "choices": [
      "The same, since the per-token price is identical",
      "Lower, since smaller tokens compress better in the cache",
      "About 1.3× the other's for input-dominated requests",
      "About 0.7× the other's, since each token carries less text"
    ],
    "answer": 2,
    "explain": "Billing is per token, so 30% more tokens for the same text means ~30% more input cost per answer. Per-token prices compare only within one tokenizer; compare cost per answer on your own documents."
  },
  {
    "q": "On a Rubin GPU (FP8 17.5 PFLOPS dense, 19.2 TB/s), FP8 weights decoded with FP8 arithmetic: past roughly what batch does a decode step become compute-bound?",
    "choices": [
      "About 456 sequences",
      "About 208 sequences",
      "About 295 sequences",
      "About 1,300 sequences"
    ],
    "answer": 0,
    "explain": "Each sequence costs 2 FLOPs per parameter per step and each parameter is one byte read once: B ≈ 17.5e15 ÷ (2 × 19.2e12) ≈ 456. 208 is the BF16 ridge (4 PF ÷ 19.2 TB/s), 295 is the H100's, and 1,300 would use the sparse NVFP4 figure."
  },
  {
    "q": "A self-hosted node's day-average utilisation is 3% and its break-even utilisation against the API is 4%. Traffic will double next quarter, nothing else changes. What happens?",
    "choices": [
      "The node stays more expensive, since 3% is far from any efficient operating point",
      "The API becomes cheaper still, since its volume discounts grow with traffic",
      "Nothing, since cost per token on a fixed node does not depend on traffic",
      "The node becomes cheaper: utilisation reaches 6%, above the 4% break-even"
    ],
    "answer": 3,
    "explain": "The node's cost is fixed, so doubling the work doubles day-average utilisation to 6%, above the 4% at which it matches the API bill. Low utilisation in absolute terms does not matter; the comparison is against u*. Volume discounts were not part of the question."
  }
]
```
