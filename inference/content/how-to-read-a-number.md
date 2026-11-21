# How to Read a Number in This Field

> **The question:** when someone shows you an inference performance figure —
> in a vendor deck, a launch post, your own dashboard — what must you ask
> before you believe it?
>
> **You'll be able to:** recover the missing coordinate behind a throughput,
> latency or cost claim and check it against the bandwidth floor; tell an
> Offline result from a Server one and output tokens from total tokens; say what
> a cache hit rate counts; take a real benchmark claim or a vendor pitch through
> the seven questions and say what it means for your own deployment.

Inference has unusually reliable physics and unusually unreliable numbers. The
two facts are connected. Throughput, latency, cost and quality trade against each
other along hard constraints, so almost any figure can be made to look impressive
by choosing where on those trade-offs to stand — and not mentioning the choice.
No dishonesty is needed. Omission is enough.

The previous chapters gave you the machinery to see where each omission hides.
This chapter turns it into a reading protocol: seven questions, each traceable to
something you have derived, each shown on a real published number. It is about
*reading* someone else's figure. Producing your own — load generators, sweeps,
warm-up — is [Load Testing](#/load-testing).

## 1. At what per-user speed?

> [!predict] Before you read on
> Two engines serve Llama-3-8B on one H100. Engine A's blog post says "12,000
> tokens/s". Engine B's says "85 tokens/s per user". Which is faster — and is
> either GPU nearly idle?

You cannot tell which is faster, and neither post lets you. From [Inference
Arithmetic](#/inference-arithmetic): raising the batch raises total throughput
almost linearly while each user's speed barely changes — until the batch
approaches the knee, after which total throughput flattens and every user slows
down. A serving system's real behaviour is that whole curve of total throughput
against per-user speed, and a single point on it can be reached by choosing a
batch size.

But you *can* check each claim against the bandwidth floor, and the expert does so
before reading on. Llama-3-8B is 16 GB of BF16 weights; at ~85% of 3.35 TB/s one
decode step takes at least ~5.6 ms, so a lone user gets at most ~180 tokens/s.
"85 tokens/s per user" is 11.8 ms per token: twice the floor. That is a GPU
working hard — a large batch, long contexts, or both — not an idle one. "12,000
tokens/s" at 85 per user would be ~140 concurrent streams; at 20 per user, 600.

On the case's node the step-time model gives the shape of the curve: from batch 1
to batch 256 (1,000-token contexts), per-token latency goes from 14 to 30 ms —
about 2× — while total throughput goes from 71 to ~8,500 tokens/s, 120×. The two
coordinates do not move by the same factor, which is exactly why one of them
alone tells you so little.

The specific failure to watch for is a report that quotes **throughput from a
large batch and latency from a small one**. Each number is true. Together they
describe a machine that does not exist.

> [!bridge] From the Linux course
> You would not accept "1.2 M IOPS" from a storage vendor without the queue depth
> and the block size: fio at `iodepth=1` and `iodepth=256` measures two different
> machines. Same refusal here. What differs: in fio the queue depth is a knob you
> set; in a serving engine the batch is an *outcome* of arrival rate and service
> time, and the cost of raising it lands on every user's latency.
> [→ Linux: Modern I/O & io_uring](../#/modern-io)

## 2. Which tokens, under what load?

Here is a real launch claim, from NVIDIA's blog on 27 March 2024:

```plaintext
The memory-enhanced H200 GPUs, in their MLPerf debut, used TensorRT-LLM to
produce up to 31,000 tokens/second, a record on MLPerf's Llama 2 benchmark.
The H200 GPU results include up to 14% gains from a custom thermal solution.
```

*Verbatim — blogs.nvidia.com/blog/tensorrt-llm-inference-mlperf/ (fetched 2026-11-21).*

MLPerf publishes every submission's logs, so you can find the run behind "up to".
**MLPerf Inference** runs the same model under fixed rules in named scenarios.
Its rules define two that matter here: **Offline**, where the load generator
"sends all samples to the SUT at start in a single query" (SUT: the system under
test), and **Server**, where it "sends new queries to the SUT according to a
Poisson distribution" and a 99th-percentile latency bound must hold — for Llama 2
70B, 2,000 ms to the first token and 200 ms per output token. Here are the two
logs for the system behind the claim:

```plaintext
Scenario : Offline
Mode     : PerformanceOnly
Samples per second: 108.185
Tokens per second: 31712
Result is : VALID
…
Mean latency (ns)               : 1334525853379
…
samples_per_query : 285120

Scenario : Server
Mode     : PerformanceOnly
Completed samples per second    : 100.73
Result is : VALID
  Performance constraints satisfied : Yes
…
Completed tokens per second                 : 29526.33
…
99.00 percentile first token latency (ns)   : 695376424
…
99.00 percentile time to output token (ns)   : 187187815
```

*Verbatim — trimmed; `mlperf_log_summary.txt` of the Offline and Server performance runs in `closed/NVIDIA/results/H200-SXM-141GB-CTSx8_TRT/llama2-70b-99.9/`, repository mlcommons/inference_results_v4.0. The system description lists 8 accelerators and status "preview".*

"Up to 31,000" is the Offline figure: 285,120 requests handed over at once, so
the engine can batch as deeply as memory allows. The mean latency of 1,334 s is
22 minutes; nobody was waiting for an answer. It is also eight GPUs, ~3,960 tokens/s
each, on a custom-cooled "preview" system whose cooling the post credits with "up
to 14%". The
Server run, with arrivals and a latency bound, gives 29,526 — only 7% less — but
read its last line: a p99 time per output token of 187 ms, about 5 tokens/s per
user. Against Ask Halden's 60 ms promise, neither number describes a service you
could run. MLPerf's current rules add an Interactive category for this model with
a 40 ms bound, which is the one to look for.

Two more load questions hide in "tokens/second". **Which tokens:** the log above
counts generated tokens, but `vllm bench serve` in vLLM v0.34 prints both "Output
token throughput" and "Total token throughput", the latter dividing *input plus
output* by the run time. For Halden's 3,000 in / 250 out, total is 13× output.
**Which load:** a fixed concurrency (a closed loop, the next request sent when one
finishes) or an arrival rate (an open loop, like users)? The same tool's default
`--request-rate` is `inf`: every request sent at time zero, an Offline run by
another name.

## 3. What traffic shape?

Every number above depends on the request's **context length** and its
**input:output ratio**, because they decide which term of the step-time model
binds. Halden's requests are 3,000 tokens in, 250 out: 12 input tokens per output
token, and at the morning peak prefill takes ~40% of the node's arithmetic. A
popular benchmark shape, 128 in / 2,048 out, has 0.06 input tokens per output
token: almost pure decode, contexts that grow during the answer, and an engine
that wins it may simply batch decodes well. Different bottleneck, different
winner. Random token prompts also defeat prefix caching, which flatters nobody
and misleads the reader whose traffic shares a prefix.

*Ask: what were the input and output lengths, and how do they compare with mine?*

## 4. Measured or spec sheet — and which flags?

[The GPU Mental Model](#/gpu-mental-model) showed the H100's own spec sheet: every
tensor-core figure marked "* With sparsity", and the same 1,979 meaning BF16
sparse or FP8 dense. A headline FLOP figure has two flags, and a comparison that
reads neither is off by 2× or more. The other half of the question is *measured
against what*: streaming kernels reach 85–90% of nameplate bandwidth, whole decode
steps 50–75%, dense prefill 35–55% of nameplate FLOP/s. A measured 45% MFU is not
half of a spec sheet's 100%; it is a normal result. Compare measurements with
measurements, and say which utilisation — MFU or MBU — and against which peak.

*Ask: measured or peak? Dense or sparse, at what precision?*

## 5. What does the hit rate count?

Prefix caching ([PagedAttention & Prefix Caching](#/paged-kv-cache)) lets a
request skip prefill for the tokens at the start of its prompt that the server
has already processed. Systems report a hit rate for it, and the word hides the
denominator.

> [!predict] Before you read on
> An application team's dashboard says 99% of Ask Halden's requests hit the
> prefix cache. Prefill time per request fell by about a quarter, not 99%. Is
> caching broken?

Probably not. The dashboard counts requests that reused *any* cached tokens;
what TTFT feels is the share of tokens reused. Every Ask Halden request
begins with the same 800-token system prompt and then diverges, so at best
800 ÷ 3,000 ≈ 27% of its prefill tokens can hit — a quarter of the work, exactly
what TTFT showed. vLLM counts tokens, and says so in the metric definitions:

```python
        counter_prefix_cache_queries = self._counter_cls(
            name="vllm:prefix_cache_queries",
            documentation=(
                "Prefix cache queries, in terms of number of queried tokens."
            ),
…
        counter_prefix_cache_hits = self._counter_cls(
            name="vllm:prefix_cache_hits",
            documentation=("Prefix cache hits, in terms of number of cached tokens."),
```

*Verbatim — trimmed; vLLM v0.34.0, `vllm/v1/metrics/loggers.py`.*

Two details from the same source shape the number. Hits come in whole blocks, and
the last prompt token is always recomputed to produce logits, so even an identical
prompt never reaches 100%. And the "Prefix cache hit rate" in the periodic log line
covers only the most recent 1,000 requests (`CachingMetrics` in
`vllm/v1/metrics/stats.py`), while the counters cover everything since start: graph
`rate(vllm:prefix_cache_hits_total) / rate(vllm:prefix_cache_queries_total)`.

*Ask: hits per request or per token, over what window?*

## 6. Cost per which token, at what occupancy?

A cost per million tokens is `$/hour ÷ (tokens/s × 3,600 × occupancy)`, and each
factor is a choice. Which tokens — output, input, or both summed, which as rule
2 showed can differ 13× for one workload. At what operating point — the same
node prices an output token from $39 per million at batch 1 to $0.33 near the
knee. At what occupancy — the fraction of paid hours the GPU spends working;
a figure "at full utilisation" assumes no night, no weekend and no headroom. And
which tokenizer: the same text is a different number of tokens for different
models, so per-token prices compare only within one tokenizer.

*Ask: per which tokens, at what per-user speed, at what occupancy?*

## 7. At what quality?

Every number in this chapter can be improved by making the model worse, sometimes
invisibly: weights or KV cache in fewer bits, a smaller draft model whose guesses
are accepted loosely, a shortened context, a different sampling setting. MLPerf
pins this down — the Llama 2 70B result above had to reach 99.9% of a full-precision
reference's ROUGE score, and the submission lists "quantization" among its weight
transformations. A vendor post rarely says. [Did Quantization Break Your
Model?](#/did-quantization-break-your-model) is about how to check.

*Ask: same weights, same precision, same outputs — and how was that verified?*

## The card

Carry these into any vendor conversation, benchmark post or dashboard review:

1. At what per-user speed — and were all the numbers from the same run?
2. Which tokens, under what load — output or total; Offline, fixed
   concurrency or an arrival rate?
3. What traffic shape — context length and input:output ratio?
4. Measured or peak — dense or sparse, at what precision?
5. A hit rate per request or per token, over what window?
6. A cost per which token, at what operating point and occupancy?
7. At what quality, verified how?

> [!dashboard] The numbers you will be quoted
> **Utilisation:** `rate(vllm:generation_tokens_total)` and
> `rate(vllm:prompt_tokens_total)`, graphed apart, never summed into one
> "throughput". **Saturation:** `vllm:request_queue_time_seconds` — time a request
> waited before any work, which client-side benchmarks fold into TTFT.
> **Errors:** none as a metric — goodput must be derived from the buckets of
> `vllm:time_to_first_token_seconds` and `vllm:request_time_per_output_token_seconds`
> above the promises.

> [!case] The case: the vendor pitch
> A vendor emails Halden: *"Our optimized engine delivers 3× the throughput of
> open-source vLLM for Llama-3.3-70B on 4×H100 — cut your serving costs by
> two-thirds."*
>
> Run the card. At what per-user speed? Ask Halden promises TPOT ≤ 60 ms; a 3× gain
> measured at 200 ms per token is irrelevant. At what load? Little's law (requests
> in flight = arrival rate × time in system; [Continuous
> Batching](#/continuous-batching) derives it) puts Ask Halden at 1.5 req/s ×
> ~4.3 s ≈ 6–7 in flight on average, planned at 20 — far below the knee, where
> every engine reads the same 35 GB per GPU per step. A 3× gain there needs fewer
> bytes (FP8 weights) or fewer steps (speculative decoding); ask which, because
> each touches quality. What shape? Halden sends 3,000 in / 250 out behind a shared
> 800-token prefix; a 128-in / 2,048-out benchmark tests another bottleneck.
>
> **Decision recorded:** the reply asks for the throughput–TPOT curve at Halden's
> shape and precision, measured with an arrival rate, plus the quality check if
> the weights changed. And "cut costs by two-thirds" holds only if the engine lets
> Halden rent fewer GPUs: the node costs $7,300 a month whatever its throughput,
> and phase 1 does not fill it. Quantization is the chapter where that question
> becomes real.

## Exercises

<div class="exercise">

**Exercise 1 — diagnosis.** After a week of Ask Halden in production, someone
pastes two scrapes of one engine taken ten minutes apart at the morning peak and
asks why the cache "only" hits a quarter of the time when the team's dashboard says
99%:

```plaintext
# 09:30:00
vllm:prefix_cache_queries_total{…} 41940000
vllm:prefix_cache_hits_total{…} 10735872
# 09:40:00
vllm:prefix_cache_queries_total{…} 44640000
vllm:prefix_cache_hits_total{…} 11427072
```

*Real format, illustrative values — metric names from vLLM v0.34.0 `vllm/v1/metrics/loggers.py` (counters exported with `_total`), labels trimmed; numbers computed from the case at 1.5 requests/s, not measured.*

How many requests arrived in the window? What is the token hit rate, how many
tokens did each request reuse, and how much TTFT should that save? Is anything
wrong?

<details>
<summary>Reveal answer</summary>

Queried tokens rose by 2,700,000 — each new request queries its whole prompt — so
at 3,000 per request, 900 requests, 1.5 per second. Hits rose by 691,200, so the token hit rate is 691,200 ÷
2,700,000 ≈ 25.6%, and each request reused 691,200 ÷ 900 = 768 tokens —
the 800-token system prompt rounded down to whole 64-token blocks (vLLM v0.34's
default). At 0.0885 ms of prefill arithmetic per token that saves ~68 ms of the
~0.27 s prefill. Nothing is wrong: the dashboard's 99% counts requests with any
hit, the engine counts tokens, and only the second predicts TTFT. The number to
alert on is the token rate falling well below ~26%.

</details>

</div>

<div class="exercise">

**Exercise 2 — transfer.** NVIDIA's H100 product page answers a question about
cost per token like this:

```plaintext
According to SemiAnalysis InferenceX benchmarks as of April 2026, NVIDIA B200
delivers inference at approximately $0.02 per million tokens at 55 TPS/user for
GPT-OSS-120B using NVIDIA TensorRT™-LLM—roughly 4.5x cheaper than H100 at $0.09
per million tokens with vLLM.
```

*Verbatim — FAQ at nvidia.com/en-us/data-center/h100/ (fetched 2026-11-21).*

Run the card on it. Which questions does the sentence answer, and which does it
leave open? At Halden's $2.50 per GPU-hour, what H100 throughput would $0.09 per
million imply, and how many 66-tokens/s streams is that? (gpt-oss-120b's
`config.json` lists 128 experts with 4 active per token, weights in MXFP4.) Does
the 4.5× carry over to Ask Halden?

<details>
<summary>Reveal answer</summary>

Answered: per-user speed, though not the same one (55 vs 66 tokens/s — the B200
is quoted at a slower, cheaper point on its curve); the model; the engines; a date.
Open: which tokens are counted (the benchmark's glossary defines cost per
million as "the estimated infrastructure bill for producing one million tokens,
the chunks of text an AI model reads and writes"), the input and output lengths,
the load, the cost per GPU-hour and occupancy behind "estimated", and quality.
Two variables change at once — chip and engine — so the 4.5× belongs to neither.

Implied H100 throughput at $2.50/hour and full occupancy:
2.50 ÷ (0.09 × 10⁻⁶ × 3,600) ≈ 7,700 tokens/s per GPU, about 117 streams
at 66 tokens/s. That is plausible only because each token touches 4 of 128 experts
and the weights are 4-bit: far fewer bytes per step than Halden's dense 70B in
BF16, which the case node serves at ~1,270 tokens/s across four GPUs at 20
streams. The ratio does not transfer; the method does.

</details>

</div>

<div class="exercise">

**Exercise 3 — find the flaw.** The vendor from the case box attaches its evidence:

```plaintext
Llama-3.3-70B-Instruct, 4×H100 SXM, our engine (FP8) vs vLLM (BF16)
command: --dataset-name random --random-input-len 128 --random-output-len 2048
         --num-prompts 2000 --ignore-eos            (no --max-concurrency)

                         ours        vLLM
Total token throughput (tok/s):     12950.40    4310.22
Mean TPOT (ms):                     18.40       41.73      # measured at concurrency 8
Prefix cache hit rate:              94.0%       0.0%
```

*Real format, illustrative values — flag and field names from vLLM v0.34.0 `vllm/benchmarks/serve.py` and `datasets.py` and the engine's stats log line; the vendor and every number are invented for the exercise.*

Find at least five problems before opening the answer.

<details>
<summary>Reveal answer</summary>

1. Two variables at once: FP8 against BF16. Half the bytes per step explains
   up to 2× by itself (rule 4, rule 7) — and says nothing about quality.
2. Total tokens: 128 in / 2,048 out, so total is ~1.06× output here — small,
   but on Halden's 3,000 / 250 shape the same label would mean 13× (rule 2).
3. Burst load: no `--max-concurrency` and the default `--request-rate inf`:
   2,000 requests at time zero, an Offline run. Throughput was measured at the
   deepest batch memory allowed; the TPOT line admits it came from concurrency 8 —
   a different run (rule 1).
4. Wrong shape: 128-in / 2,048-out is almost pure decode; Halden's 3,000-in
   prompts put ~40% of peak arithmetic into prefill (rule 3).
5. Impossible hit rate: random prompts share no prefix. A 94% hit rate means
   repeated prompts or a counter that is not vLLM's token rate — and vLLM's 0.0%
   suggests prefix caching was off for the baseline (rule 5).
6. Missing: per-user speed under the throughput, quality, and cost per GPU.

</details>

</div>

## What to remember

- A throughput figure without the per-user speed from the same run is
  unfalsifiable; check per-user claims against the bandwidth floor.
- "Up to" usually means Offline: all requests at once, nobody waiting. Look for
  the Server or arrival-rate number and its latency bound.
- Output tokens and total tokens differ by the input:output ratio — 13× for
  Halden's shape.
- Traffic shape decides which term binds; a benchmark on another shape tests
  another bottleneck.
- vLLM's prefix-cache hit rate counts tokens; a per-request rate can read 99% while
  TTFT moves by a quarter.
- Every number can be bought with quality. Ask what changed besides the engine.

```quiz
[
  {
    "q": "A post reports 9,600 output tokens/s for a 70B model on 8×H100 at 256 concurrent requests, and elsewhere 'TPOT as low as 12 ms'. What can you say about TPOT in the throughput run?",
    "choices": [
      "It was 12 ms, since both figures come from the same hardware and engine",
      "It was about 37.5 ms, since 9,600 ÷ 256 gives each user's time per token directly",
      "It was at most ~27 ms: 9,600 ÷ 256 = 37.5 tokens/s per stream, TTFT included",
      "It cannot be bounded at all without knowing the GPUs' memory bandwidth"
    ],
    "answer": 2,
    "explain": "9,600 ÷ 256 = 37.5 tokens/s per stream, i.e. ~27 ms per token on average — and that average includes each request's queueing and TTFT, so the decode gap itself is at most ~27 ms. The 12 ms figure comes from a lighter run. Inverting tokens/s gives ms per token, not 37.5 ms."
  },
  {
    "q": "An MLPerf Llama 2 70B submission lists 31,712 tokens/s Offline and 29,526 tokens/s Server on the same system. Your service promises 60 ms per output token. Which statement holds?",
    "choices": [
      "The Server figure applies to you, since it was measured under a latency bound",
      "Neither applies directly: the Server bound was 200 ms per token, not 60 ms",
      "The Offline figure applies, since it is the system's true maximum capacity",
      "Both apply, because the two figures differ by only about 7% from each other"
    ],
    "answer": 1,
    "explain": "Offline sends every sample at once with no latency bound. Server adds Poisson arrivals and a p99 bound, but for this benchmark that bound was 2 s TTFT and 200 ms TPOT — this run's p99 TPOT was 187 ms. At 60 ms the batch must be smaller and throughput lower; a bound looser than yours makes the number an upper limit, not your capacity."
  },
  {
    "q": "A team serves a chatbot whose prompts are 400 tokens with no shared system prompt, and 300-token answers. vLLM's token hit rate reads 2%. A colleague says the cache is broken. What do you check first?",
    "choices": [
      "Nothing: the KV pool is too small, so blocks are evicted before any reuse",
      "Whether --enable-prefix-caching was set, since 2% means it is effectively off",
      "Whether requests share any prefix at all: with none, a low rate is correct",
      "Whether the counter is per request, since vLLM's per-token rate is always higher"
    ],
    "answer": 2,
    "explain": "A token hit rate measures shared prefixes. With no common system prompt, only coincidental repeats (a retried request, a follow-up turn) can hit, so ~2% is what a healthy cache shows. Eviction or a disabled cache are possible, but only after you know a sharable prefix exists; and vLLM's counters are already per token."
  },
  {
    "q": "Vendor A quotes $0.30 per million tokens counting input plus output; vendor B quotes $1.20 per million output tokens. Your workload sends 3,000 tokens in for 250 out. Per request, which is cheaper?",
    "choices": [
      "Vendor A: input tokens are cheap to serve, so a total-token price is the fair one",
      "Vendor A: its price per million tokens is four times lower than vendor B's",
      "They cost the same: the 4× price gap matches the tokens each vendor counts",
      "Vendor B: 250 × $1.20/M ≈ $0.0003, against A's 3,250 × $0.30/M ≈ $0.001"
    ],
    "answer": 3,
    "explain": "Price each on the tokens it counts: A charges 3,250 tokens × $0.30/M ≈ $0.00098; B charges 250 × $1.20/M = $0.00030. B is ~3× cheaper for this shape although its headline is 4× higher. The tempting answer compares headline prices without asking which tokens they count."
  },
  {
    "q": "A launch post claims 2.5× lower TPOT at batch 1 for Llama-3.3-70B on the same four H100s, same BF16 weights. Which explanation is physically plausible?",
    "choices": [
      "Speculative decoding: several tokens accepted per weight read, fewer steps",
      "Better kernels pushing a single BF16 weight read 2.5× past the bandwidth floor",
      "A faster scheduler, since batch-1 decode time is dominated by scheduling",
      "Higher GPU clocks, since decode at batch 1 is limited by tensor-core speed"
    ],
    "answer": 0,
    "explain": "At batch 1 the step is bounded by reading 35 GB per GPU (10.4 ms floor). No kernel beats the floor with the same bytes, and the tensor cores are mostly idle. Only fewer bytes (quantization — excluded here) or fewer steps per token (speculation) can deliver 2.5×; ask about the acceptance rate and whether outputs were checked."
  }
]
```
