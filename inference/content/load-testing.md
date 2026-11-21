# Load Testing: Producing a Number

> **The question:** the sizing chapter gave you estimates — how do you replace
> them with a measurement you would stake a launch on, and how do benchmarks lie
> even when nobody means them to?
>
> **You'll be able to:** choose an open-loop load generator and say what a closed
> loop hides; design a sweep that holds the request shape, arrivals, warm-up and
> cache state fixed while the rate moves; read throughput, goodput and latency
> curves to locate the knee, and check any report against Little's law; find the
> methodological errors in someone else's benchmark.

Two engineers benchmark the same server on the same afternoon, both at "3 requests
per second". One reports a p99 latency of 0.7 s, the other 2.0 s. Neither made an
arithmetic mistake and neither touched the server's configuration. One of their
tools waited for each answer before sending the next request; the other sent
requests on a clock. That difference — which you will reproduce in a moment — is
the first of several ways a careful benchmark produces the wrong number.

Every number in [Sizing a Deployment](#/sizing-a-deployment) is an estimate.
[How to Read a Number](#/how-to-read-a-number) taught you to question someone
else's figure; this chapter is about producing your own, and [Lab: Find the
Knee](#/lab-load-test) has you do it on a laptop.

## Two ways to make load

A **closed-loop** generator runs N virtual users. Each sends a request, waits for
the answer, perhaps pauses, and sends the next. An **open-loop** generator sends
requests on a schedule — a fixed or random clock — whatever the server is doing.

Six hundred employees do not stop typing because the server is slow: real users
are open-loop. A closed loop's users slow down with the server, so the offered
load falls exactly when it should be testing it.

> [!predict] Before you read on
> A server can complete 4 requests per second. You offer it 5 per second, once
> with a closed loop sized to send 5 per second when the server is fast, once on a
> clock. Will the two p99 latencies differ by about 2×, about 10×, or by more than
> 100×?

By more than 100×. Here is the smallest server that shows it: one queue, a fixed
service time of 0.25 s, driven both ways for half an hour.

```python
import random
random.seed(7)
S, T_END = 0.25, 1800.0   # one server, fixed 0.25 s per request: capacity 4 req/s

def pct(xs, p):
    xs = sorted(xs)
    return xs[round(p / 100 * (len(xs) - 1))]

def open_loop(rate):      # arrivals on a clock, whatever the server is doing
    t = free = 0.0; lat = []
    while t < T_END:
        t += random.expovariate(rate)
        start = max(t, free); free = start + S
        lat.append(free - t)
    return lat, free

def closed_loop(users, think=0.75):  # each user waits for its answer, thinks, sends again
    nxt = [random.uniform(0, think) for _ in range(users)]; free = 0.0; lat = []
    while min(nxt) < T_END:
        i = nxt.index(min(nxt)); t = nxt[i]
        start = max(t, free); free = start + S
        lat.append(free - t); nxt[i] = free + random.expovariate(1 / think)
    return lat, free

print("offered   generator   served      p50 (s)   p99 (s)")
for rate in (3, 5):
    for name, (lat, end) in (("open", open_loop(rate)), (f"closed x{rate}", closed_loop(rate))):
        print(f"{rate} req/s   {name:<11} {len(lat) / end:4.2f} req/s {pct(lat, 50):8.2f} {pct(lat, 99):9.2f}")
```

*Runnable — Python 3 standard library only; output shown is from an actual run.*

```plaintext
offered   generator   served      p50 (s)   p99 (s)
3 req/s   open        3.04 req/s     0.49      2.04
3 req/s   closed x3   2.73 req/s     0.28      0.70
5 req/s   open        4.00 req/s   237.63    449.24
5 req/s   closed x5   3.76 req/s     0.58      1.13
```

*Runnable — output of the program above, pasted from a real run with `python3`. A simulation of a toy server, not a measurement of an engine.*

Read the last row first. The closed loop, asked for 5 requests per second, reports
a healthy server serving 3.76 with a p99 of 1.1 s. The server is in fact
overloaded: on a clock, its queue grows for the whole run and the p99 is seven
and a half minutes. The closed loop *cannot* show overload — it never offers more
than the server takes. Even below capacity, the second row understates the tail
threefold: users who would have arrived during a slow patch were busy waiting, so
the slow patch was sampled less. This is **coordinated omission**, the name Gil
Tene gave it on the [mechanical-sympathy list in
2013](https://groups.google.com/g/mechanical-sympathy/c/icNZJejUHfE): the generator
coordinates with the server and omits the measurements that would have hurt.

The overloaded open-loop p50 — 238 s after thirty minutes — would be larger after
an hour: past capacity there is no steady state, only a number that grows with the
run. A sweep stops raising the rate there.

The tools encode the choice in their flags. `vllm bench serve` (vLLM v0.34) is
open-loop when you give it `--request-rate`, with Poisson arrivals by default and
gamma-distributed ones under `--burstiness` below 1; without `--request-rate` it
defaults to `inf` and sends every request at time zero. `--max-concurrency` adds a
client-side semaphore — part closed loop — and v0.34 then reports the time
requests waited for it as "Client-side Queueing" alongside TTFT, which is measured
from the moment of sending. GuideLLM's `synchronous` and `concurrent` profiles are
closed; `constant` and `poisson` are open. MLPerf Inference's Single Stream
scenario is a closed loop of one; its Server scenario is Poisson.

## What to hold fixed

A load test varies one thing — the offered rate — and holds everything else still.
Four things move numbers when nobody intends them to.

**The request shape.** Prompt and output lengths, as distributions. A sample of
your own logged requests beats any synthetic shape: it carries the real spread,
the real shared prefixes, the real tail of long answers. Synthetic defaults
flatter. vLLM's `random` dataset uses fixed lengths unless you set
`--random-range-ratio` (default 0.0), and for OpenAI-compatible backends it forces
`ignore_eos` so every answer runs exactly to `--random-output-len`. Identical
lengths remove the variance continuous batching exists to absorb, and
`ignore_eos` makes the model generate past the point where it would have stopped —
harmless for timing a step, wrong for anything that depends on content, such as a
speculative decoder's acceptance rate.

**The arrival pattern.** Poisson is the honest default for many independent users.
Real traffic is burstier — a meeting ends, forty people ask at once — and a server
that passes at Poisson 1.5 req/s can fail a gamma-distributed 1.5 with the same
mean. Run both.

**Duration and warm-up.** In vLLM v0.34 compilation and graph capture finish
before the server listens ([Kernels, Graphs & Compilation](#/kernels-and-compilation)),
but the first minute is still unrepresentative: the prefix cache is empty and the
batch has not reached its steady size. Discard a warm-up (`--num-warmups`, or
GuideLLM's `warmup=`), then run long enough for the tail: a p99 from 200 requests
rests on two of them.

**Cache state between runs.** The second run of the same prompts hits the prefix
cache, and its TTFT improves for reasons that will never happen in production.
`vllm bench serve` seeds its sampler and its arrival generator from `--seed`, which
defaults to 0, so running the same command twice sends the same prompts at the
same moments. GuideLLM's documentation says the same about its synthetic data:
more samples "decrease the likelihood of caching requests". Change the seed per
run, restart the server, or — on a test server started with
`VLLM_SERVER_DEV_MODE=1` — `POST /reset_prefix_cache`, which refuses while blocks
are still held by running requests. Then check what you got: the ratio of
`vllm:prefix_cache_hits` to `vllm:prefix_cache_queries` (both counted in tokens)
over the run should match production's, not 0% and not 98%.

> [!trap] "Warm cache" is not a cheat to avoid entirely
> Ask Halden's 800-token system prompt *should* hit in a test, because it hits in
> production. What must not hit is the 2,200 tokens that are unique to each
> request. The target is production's hit rate — about a quarter of prompt tokens
> in phase 1, the 800 shared ones rounded down to whole 64-token blocks — not
> zero.

## Reading the curve

A sweep runs the same test at a ladder of offered rates and plots, for each:

- **throughput** (completed requests per second) and **goodput** (requests that
  met every promise, per second) against the offered rate;
- latency percentiles — TTFT and TPOT at p50, p95, p99 — against the offered rate.

Below capacity, throughput tracks the offered rate and latency is flat. Then one
latency percentile starts to climb, goodput peels away from throughput, and soon
throughput itself stops following the offered rate. The **knee** is the highest
rate at which goodput still keeps up with throughput — nearly every request met
its promises.
The capacity you write down is the knee, not the throughput plateau beyond it.

**Little's law** — `L = λ × W`, the average number in the system equals the
throughput times the average time in it ([Continuous
Batching](#/continuous-batching)) — holds for any stable run, so it checks any
report. A report gives you request throughput and mean end-to-end latency; their
product is the average number in flight. If that disagrees with the concurrency
the report claims, something in it is not what it says.

> [!predict] Before you read on
> A report shows 1.50 req/s of throughput, a mean end-to-end latency of 4.9 s and
> "Peak concurrent requests: 22". Is 22 a contradiction?

No. Little's law gives the *average*: 1.50 × 4.9 ≈ 7.4 in flight. The count in
flight fluctuates, and under Poisson arrivals its peak sits well above its mean;
the report in the next section is such a run. A report that gave "concurrency 22"
*as the operating point* would be the contradiction: at 22 in flight on average,
each request would have to take ~15 s.

## The tools

**`vllm bench serve`** ships with the engine (vLLM v0.34.0, `vllm/benchmarks/serve.py`).
It reads a dataset — `random`, `sharegpt`, a `custom` JSONL file of logged prompts,
or a `timed_trace` replayed at its own timestamps — and sends it to any
OpenAI-compatible server. Ask Halden's test against one replica at the peak rate:

```bash
vllm bench serve \
  --backend openai-chat --endpoint /v1/chat/completions \
  --base-url http://ask-halden-llm-b:8000 \
  --model RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
  --dataset-name custom --dataset-path halden-sample-2026-11.jsonl \
  --custom-output-len -1 \
  --num-prompts 2700 --request-rate 1.5 --burstiness 1.0 \
  --num-warmups 50 --seed 11 \
  --percentile-metrics ttft,tpot,itl,e2el --metric-percentiles 50,95,99 \
  --goodput ttft:1400 tpot:60 \
  --save-result --result-dir results/ --metadata replica=b rate=1.5
```

*Real format, illustrative values — every flag from vLLM v0.34.0 `vllm/benchmarks/serve.py` and `vllm/benchmarks/datasets/datasets.py`; host name and file name invented.*

Each JSONL line is `{"prompt": …, "output_tokens": …}` from the gateway's logs;
`--custom-output-len -1` keeps the logged lengths instead of the default 256.
`--goodput` takes milliseconds and counts a request as good only if it met *both*
promises — stricter than two separate p95s.

```plaintext
============ Serving Benchmark Result ============
Successful requests:                     2700
Failed requests:                         0
Request rate configured (RPS):           1.50
Benchmark duration (s):                  1804.17
Total input tokens:                      8100000
Total generated tokens:                  675000
Request throughput (req/s):              1.50
Request goodput (req/s):                 1.50
Output token throughput (tok/s):         374.13
Peak output token throughput (tok/s):    1173.00
Peak concurrent requests:                22.00
Total token throughput (tok/s):          4863.74
---------------Time to First Token----------------
Mean TTFT (ms):                          258.25
Median TTFT (ms):                        218.37
P95 TTFT (ms):                           446.09
P99 TTFT (ms):                           581.55
-----Time per Output Token (excl. 1st token)------
Mean TPOT (ms):                          18.70
Median TPOT (ms):                        18.30
P95 TPOT (ms):                           23.18
P99 TPOT (ms):                           25.23
---------------Inter-token Latency----------------
Mean ITL (ms):                           18.70
Median ITL (ms):                         14.81
P95 ITL (ms):                            46.50
P99 ITL (ms):                            47.05
```

*Real format, illustrative values — labels and layout from vLLM v0.34.0 `vllm/benchmarks/serve.py`; values from running the step model of "Write the prediction down first" (below) on 2,700 Poisson arrivals at 1.5 req/s, every request 3,000 in / 250 out — computed, not measured. E2EL section trimmed.*

The line you might skip is the ITL median against its p95: 14.81 ms is a decode
step with nothing else in it, 46.5 ms is a step that also carried a 512-token
prefill chunk. TPOT averages the two; ITL shows the stutter.

**GuideLLM** (vllm-project/guidellm v0.8.1) runs whole sweeps. Its `sweep` profile
measures a `synchronous` baseline, then a `throughput` run with everything sent at
once, then interpolates rates between them — `constant` by default, Poisson only if
you ask:

```bash
guidellm run \
  --backend kind=openai_http,target=http://ask-halden-llm-b:8000 \
  --profile kind=sweep,sweep_size=10,strategy_type=poisson \
  --constraint kind=max_duration,seconds=600 \
  --data kind=synthetic_text,prompt_tokens=3000,output_tokens=250,output_tokens_stdev=150,output_tokens_min=20,output_tokens_max=1000,samples=5000
```

*Real format, illustrative values — command shape and options from the GuideLLM v0.8.1 README and `docs/en/guides/datasets.md`; the lengths are Ask Halden's.*

It writes `benchmarks.json` and `benchmarks.csv`. Its separate `knee` profile fits
output throughput against *concurrency* — a closed-loop knee, not the latency knee
an interactive promise needs.

**AIPerf** is what NVIDIA's GenAI-Perf became: the GenAI-Perf README now says it
"is being phased out" and points to [ai-dynamo/aiperf](https://github.com/ai-dynamo/aiperf)
(v0.14.0, 2026-11-20). With `--request-rate` its arrivals are Poisson by default;
with only `--concurrency` it runs a closed loop. Its README publishes its own
example run:

```plaintext
                                               NVIDIA AIPerf | LLM Metrics
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━┳━━━━━━━━━━┳━━━━━━━━━━━┳━━━━━━━━━━━┳━━━━━━━━━━━┳━━━━━━━━━━━┳━━━━━━━━━━┓
┃                               Metric ┃       avg ┃      min ┃       max ┃       p99 ┃       p90 ┃       p50 ┃      std ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━╇━━━━━━━━━━╇━━━━━━━━━━━╇━━━━━━━━━━━╇━━━━━━━━━━━╇━━━━━━━━━━━╇━━━━━━━━━━┩
│             Time to First Token (ms) │  7,463.28 │ 7,125.81 │  9,484.24 │  9,295.48 │  7,596.62 │  7,240.23 │   677.23 │
…
│ Output Token Throughput (tokens/sec) │      6.85 │      N/A │       N/A │       N/A │       N/A │       N/A │      N/A │
│    Request Throughput (requests/sec) │      0.07 │      N/A │       N/A │       N/A │       N/A │       N/A │      N/A │
```

*Verbatim — AIPerf v0.14.0 `README.md` (a CPU-only example run, "not an official benchmark"); rows trimmed.*

Notice the columns: p99, p90, p50 — and `vllm bench serve` prints only p99 by
default. Neither is Halden's p95; ask for the percentile your promise uses.

Two public benchmarks are worth reading for their method rather than their
rankings. **InferenceX** (SemiAnalysis, formerly InferenceMAX;
[github.com/SemiAnalysisAI/InferenceX](https://github.com/SemiAnalysisAI/InferenceX))
re-runs open-source engines on many accelerators continuously, so a result
follows the software as it changes instead of freezing at one release; its
**AgentX** benchmark ([inferencex.semianalysis.com/agentx](https://inferencex.semianalysis.com/agentx))
is an open (Apache 2.0) long-context, multi-turn agentic workload. **MLPerf
Inference** separates an Offline scenario, every sample sent at once, from a Server
scenario with Poisson arrivals and a tail-latency bound ([How to Read a
Number](#/how-to-read-a-number) reads both logs of one submission): Offline is a
ceiling; Server is a knee.

## Comparing numbers across systems

**Output and total tokens per second are different units.** The report above
shows 374 and 4,864 for the same run; "total" is mostly prefill.

**Tokens are not comparable across tokenizers.** Anthropic's [pricing
page](https://platform.claude.com/docs/en/about-claude/pricing) states that its
newer tokenizer "produces approximately 30% more tokens for the same text". A
model that streams 30% more tokens per second through such a tokenizer delivers
the same text per second. Compare models on time per answer, or per word.

**Two runs differ even when nothing changed.** Batch composition changes the
order of floating-point additions in the kernels, so the same prompt can yield a
different token, length and time. Batch-invariant modes trade speed for
repeatability ([Did Quantization Break Your
Model?](#/did-quantization-break-your-model)); for load tests, run each point
twice and report the spread.

## Write the prediction down first

Before the first real run, write down what the cost model expects — otherwise any
result looks plausible afterwards. Here is the case's step model (`step ≈ max(t_w,
t_c) + t_kv`, rung 3 of the ladder for `t_w`, rung 4 for the KV reads; see
[Inference Arithmetic](#/inference-arithmetic)) driving a chunked-prefill
scheduler with a 512-token budget, one FP8 TP=2 replica, Poisson arrivals and
Halden's shape: 800 cached tokens, 2,200 to prefill, 250 out.

```python
import random   # case.md step model, one FP8 TP=2 replica, Halden's request shape
T_C, T_KV, BUDGET, NEW, CACHED, OUT = 0.089, 29e-6, 512, 2200, 800, 250

def run(rate, t_w=14.0, secs=1200):
    rng = random.Random(1); t = nxt = area = 0.0; q, live, ttft, tpot, e2e = [], [], [], [], []
    while t < secs * 1000:
        while nxt <= t:
            q.append({"arr": nxt, "left": NEW, "out": 0}); nxt += rng.expovariate(rate) * 1000
        dec = [r for r in live if not r["left"]]; room = BUDGET - len(dec); pre = []
        for r in live + q:                                  # FCFS chunked prefill
            if r["left"] and room > 0:
                c = min(r["left"], room); room -= c; pre.append((r, c))
        live += [r for r, _ in pre if r in q]; q = [r for r in q if r not in live]
        ctx = sum(CACHED + NEW - r["left"] + r["out"] for r in live)
        dt = max(t_w, (len(dec) + sum(c for _, c in pre)) * T_C) + ctx * T_KV
        t += dt; area += dt * (len(live) + len(q))          # for Little's law
        for r, c in pre:
            r["left"] -= c
            if not r["left"]: r["first"], r["out"] = t, 1; ttft.append(t - r["arr"])
        for r in dec:
            r["out"] += 1
            if r["out"] == OUT:
                live.remove(r); tpot.append((t - r["first"]) / (OUT - 1)); e2e.append(t - r["arr"])
    p95 = lambda x: sorted(x)[int(0.95 * len(x))]
    return p95(ttft) / 1e3, p95(tpot), area / t, rate * sum(e2e) / len(e2e) / 1e3

print("req/s  TTFT p95  TPOT p95   L   rate x W  | t_w 20 ms: TTFT p95  TPOT p95")
for rate in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0):
    (a, b, L, lw), (c, d, _, _) = run(rate), run(rate, 20.0)
    print(f"{rate:5.1f} {a:7.2f} s {b:5.1f} ms {L:5.1f} {lw:6.1f}    | {c:16.2f} s {d:5.1f} ms")
```

*Runnable — Python 3 standard library only; output shown is from an actual run.*

```plaintext
req/s  TTFT p95  TPOT p95   L   rate x W  | t_w 20 ms: TTFT p95  TPOT p95
  0.5    0.35 s  17.0 ms   2.0    2.0    |             0.35 s  23.0 ms
  1.0    0.39 s  19.8 ms   4.3    4.4    |             0.40 s  25.8 ms
  1.5    0.46 s  22.8 ms   7.3    7.4    |             0.47 s  28.9 ms
  2.0    0.58 s  26.4 ms  10.9   11.0    |             0.59 s  32.2 ms
  2.5    0.75 s  31.5 ms  15.6   15.8    |             0.78 s  37.1 ms
  3.0    1.04 s  39.6 ms  22.4   22.6    |             1.10 s  43.0 ms
  3.5    1.80 s  49.7 ms  32.2   32.8    |             1.89 s  49.9 ms
  4.0    5.71 s  50.3 ms  53.7   54.3    |             5.81 s  50.4 ms
```

*Runnable — output of the program above, pasted from a real run with `python3`. A model of the engine, not a measurement of one.*

The TPOT column never reaches 60 ms: with a 512-token budget no step can exceed
~50 ms. TTFT is what breaks, between 3.0 and 3.5 req/s, as queueing for prefill
takes over. The `L` and `rate x W` columns agree, as Little's law says they must;
at 1.5 req/s about seven requests are in the system, as [Continuous
Batching](#/continuous-batching) estimated.

> [!case] The case: the acceptance test
> **Written down before the run.** Per FP8 replica, the step model puts the knee
> near **3.3 req/s**, limited by TTFT; TPOT stays under ~50 ms to the end. At the
> 1.5 req/s peak, *one* replica alone should show TTFT p95 ≈ 0.46 s and TPOT p95
> ≈ 23 ms. One replica is the test that matters: the node has two, and the plan in
> [When It Breaks](#/when-it-breaks) is that either can carry the peak alone.
>
> **The test.** `vllm bench serve` as above against replica B, then A (whose GPU 0
> also hosts the retrieval models), router bypassed: 2,700 logged prompts, Poisson
> then `--burstiness 0.5`, from 0.5 to 4 req/s; a fresh `--seed` per point; hit
> rate checked (about a quarter); client numbers cross-checked against the
> server's histograms at [Operating It](#/operating-it)'s bucket edges (1.5 s
> TTFT, 0.06 s inter-token). Then the ladder through the router. **Pass:** at
> 1.5 req/s on one replica, both patterns, goodput ≥ 95% of throughput. The
> engine's TTFT excludes retrieval (~0.1 s for the reranker), so the budget it
> must meet is ~1.4 s, not 1.5. The measured knee is recorded next to 3.3. The
> sweep runs with speculation off; [Speculative Decoding](#/speculative-decoding)'s
> A/B — the same command at `--max-concurrency 20`, head on and off — follows it.
>
> **The stake.** The first measurement is the batch-1 step (`vllm bench serve`
> at `--max-concurrency 1`). Suppose it is 20 ms, not the 14 ms planning figure —
> the Databricks range from Inference Arithmetic. The right-hand columns answer
> it: TTFT, which is prefill and compute-bound, barely moves; TPOT p95 at 1.5
> req/s rises from 23 to 29 ms against a 60 ms promise; the knee stays near 3.3.
> **No phase-1 decision changes.** Phase 2 is where it starts to count, and only
> partly. Its decode steps, ≈ 16 ms (≤ 21 ms) in the capstone's budget, become
> ≈ 22 ms (≤ 27 ms): still far from 60. Its worst token gaps come from prefill
> chunks at 17K-token contexts, ≈ 63 ms with attention's extra arithmetic, and
> those are compute-bound — `t_w` does not enter them. So a 20 ms measurement
> changes no decision; what could is the hybrid step at phase-2 contexts, and the
> test that settles it is a one-replica run with the agent trace.

## Exercises

<div class="exercise">

**Exercise 1 — a report that does not add up.** A colleague's run against a
single replica prints, among other lines:

```plaintext
Maximum request concurrency:             8
Request rate configured (RPS):           2.00
Request throughput (req/s):              1.31
Mean E2EL (ms):                          6104.37
Mean Client Queue Time (ms):             212488.51
```

*Real format, illustrative values — labels from vLLM v0.34.0 `vllm/benchmarks/serve.py`; numbers invented for the exercise.*

The colleague concludes "the replica serves 2 req/s at a 6 s end-to-end latency".
Check it with Little's law. What can you actually conclude?

<details>
<summary>Reveal answer</summary>

In flight at the server: 1.31 × 6.1 ≈ 8.0 — exactly the `--max-concurrency` cap.
The other arrivals waited in the client, 212 s on average, outside the E2EL. The
run measured a closed loop of eight serving 1.31 req/s; it says nothing about
2 req/s. Rerun without the cap; the honest latency at 2 req/s offered is the
queue-inclusive one, and here it is minutes.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** Someone ran the same command twice, ten minutes
apart, against a server nobody else was using, and scraped `/metrics` before and
after each run:

```plaintext
run   P95 TTFT (ms)   Δ vllm:prefix_cache_queries_total   Δ vllm:prefix_cache_hits_total
1          612.4                           3,000,000                        768,000
2          141.9                           3,000,000                      2,944,000
```

*Real format, illustrative values — counter names from vLLM v0.34.0 `vllm/v1/metrics/loggers.py` (both counted in tokens); numbers invented for the exercise.*

Which run represents production, and what produced the other?

<details>
<summary>Reveal answer</summary>

Hit rates: run 1, 768,000 ÷ 3,000,000 ≈ 26% — 768 tokens per request, the shared
system prompt in whole 64-token blocks, as in production. Run 2, ≈ 98%: 2,944 of
each request's 3,000 tokens were already cached. The command
used the default `--seed`, so run 2 sent the same prompts, whose blocks were still
in the pool. Run 1 is the measurement; run 2 measured the cache. Use a new seed per
run, or restart (or reset the prefix cache) between runs, and always report the
hit rate next to TTFT.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** A code-completion product: an IDE sends a request when
the user pauses typing — ~6,000 tokens of the open file, ~20 tokens out — and
cancels the previous request if a new one fires before it returns. Users press
on regardless of latency. Design the load test: loop type, the metric that matters,
the dataset, and one thing `vllm bench serve` as shown above would get wrong.

<details>
<summary>Reveal answer</summary>

Open loop: keystrokes do not wait for the server. With 20 tokens out, TPOT barely
matters; the promise is end-to-end latency, mostly TTFT. The dataset must keep the
structure: consecutive requests from one user share most of the file, so random
6,000-token prompts would understate the hit rate badly. What the plain run gets
wrong is cancellation: it lets every request finish. vLLM aborts a request when
its client disconnects, so the generator must cancel as the IDE does, or it
measures a heavier service than the real one.

</details>

</div>

<div class="exercise">

**Exercise 4 — find the flaw.** A vendor's report on their engine for a
chat product with 3,000-token prompts:

```plaintext
Setup:   64 virtual users, each sends its next request when the previous returns.
         The 500 prompts were run once as warm-up, then the same 500 measured.
Shape:   --random-input-len 3000 --random-output-len 64 --ignore-eos
Result:  9.6 req/s sustained = capacity of one replica.
         Mean TTFT 180 ms, mean TPOT 11 ms.
```

*Real format, illustrative values — flags from vLLM v0.34.0 `vllm/benchmarks/datasets/datasets.py`; the report is invented for the exercise.*

Find four errors of method before you open the answer.

<details>
<summary>Reveal answer</summary>

1. **A closed loop presented as capacity.** Sixty-four users who wait offer
   whatever the server takes; 9.6 req/s is how fast 64 polite users were served.
2. **Warm cache.** The measured prompts are the warm-up prompts, still cached: the
   180 ms TTFT is mostly hits.
3. **Fixed, short outputs.** Exactly 64 tokens by `ignore_eos`, where a chat answer
   is hundreds with a long tail: each request holds a slot for a fraction of its
   real time, and the variance that strains batching is gone.
4. **Means only.** No p95 or p99, no goodput: the tail is where promises live.

</details>

</div>

## What to remember

- A closed-loop generator slows down with the server, so it cannot show overload
  and understates the tail even below capacity (coordinated omission). Test an
  interactive service open-loop, on a clock.
- Hold the request shape, the arrival pattern, the warm-up and the cache state
  fixed; vary the rate. A logged sample beats synthetic lengths; check the hit rate
  against production's on every run.
- The capacity you write down is the knee — the highest rate where goodput still
  keeps up with throughput — not the throughput plateau.
- Little's law (`L = λ × W`) checks any report: throughput times mean latency is
  the average in flight.
- Output and total tokens per second are different units, and tokens are not
  comparable across tokenizers.
- Write the cost model's prediction down before the run; the gap is the finding.

```quiz
[
  {
    "q": "A team load-tests an internal chatbot with 32 virtual users who each wait for their answer and pause 5 s before the next question. Latency stays flat as they raise the user count to 32. What can they conclude about a morning burst of 3× their usual arrival rate?",
    "choices": [
      "It will be absorbed, because flat latency at 32 users proves the server has headroom left",
      "Nothing: this loop never offers more than the server completes, so overload cannot appear",
      "It will fail, since flat latency in a closed loop means the server was already at capacity",
      "It will be absorbed if the burst lasts under 5 s, the users' pause between questions"
    ],
    "answer": 1,
    "explain": "A closed loop's offered rate is set by the server's speed: slower answers mean fewer requests. Flat latency at 32 users says the server served 32 cooperative users; a burst of arrivals that do not wait is a different test, open-loop. The 'already at capacity' choice reads too much into flat latency — it is equally consistent with a lightly loaded server."
  },
  {
    "q": "A published run reports 4.0 req/s of request throughput and a mean end-to-end latency of 12 s, and describes itself as 'tested at 16 concurrent users'. What does Little's law say?",
    "choices": [
      "It is consistent: 16 users at 4 req/s is about 4 s between each user's requests",
      "Nothing, because Little's law only applies to Poisson arrivals, not to user loops",
      "It is consistent if the peak concurrency was 48, since peaks are three times means",
      "It is inconsistent: 4.0 × 12 means 48 in flight on average, three times 16"
    ],
    "answer": 3,
    "explain": "L = λ × W = 4.0 × 12 = 48 requests in the system on average. Sixteen users cannot have 48 requests outstanding; either the latency includes time queued somewhere else, or the throughput or user count is wrong. Little's law holds for any stable system whatever the arrival pattern, which is why it works as a check."
  },
  {
    "q": "Model A streams 1,000 output tokens/s through a tokenizer that produces 30% more tokens for the same text than Model B's. Model B streams 800 tokens/s. Which delivers text faster?",
    "choices": [
      "Model B, by about 4%: A's 1,000 tokens/s are worth about 770 of B's tokens",
      "Model A, by 25%, since tokens per second is the standard unit across engines",
      "They are equal, because the 30% difference exactly cancels the 25% speed gap",
      "It cannot be compared until both are measured at the same batch size and precision"
    ],
    "answer": 0,
    "explain": "Convert to B's units: 1,000 ÷ 1.3 ≈ 769 B-tokens of text per second, against B's 800 — B is about 4% faster at delivering the same text. Batch size and precision matter for a fair test, but they do not change this unit conversion, and the 'equal' choice compares a 30% ratio with a 25% one."
  },
  {
    "q": "An accelerator vendor quotes its MLPerf Inference Offline result for Llama-2-70B and says your interactive service will reach the same throughput. Why is that not the number to plan with?",
    "choices": [
      "Offline results are measured on a smaller model, so they overstate throughput for a 70B one",
      "Offline uses Poisson arrivals with a tail limit, which is stricter than an interactive service",
      "Offline sends all samples at once with no latency limit; plan with Server's tail-bounded rate",
      "Offline throughput is reported per GPU, while an interactive service needs it per node"
    ],
    "answer": 2,
    "explain": "In the Offline scenario LoadGen sends all samples in one query and measures throughput with no latency constraint — a ceiling. The Server scenario uses Poisson arrivals and reports the highest rate that still meets TTFT and TPOT limits: a knee. An interactive service lives at its knee. The Poisson-with-tail-limit description belongs to Server, not Offline."
  }
]
```
