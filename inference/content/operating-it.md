# Operating It

> **Goal of this chapter:** run an inference fleet without your existing
> distributed-systems instincts betraying you. By the end you can name the
> handful of metrics that are physically meaningful, read a pair of latency
> curves and say which resource is binding, choose an autoscaling signal that
> is not a lie, and roll out a new model on machines whose warmup is minutes
> and whose drain is minutes more.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="router,api,scheduler"></div>

If you have run distributed systems, you arrive here with a large and mostly
correct toolkit. Queueing theory, tail latency, admission control, backpressure,
canaries, graceful drain — all of it is relevant. The problem is that a
minority of it is *wrong* in ways that are silent, and the wrong parts are the
ones you reach for first. This chapter is about sorting them.

> [!bridge] You already know most of this — from distributed systems
> **Transfers unchanged.** Little's law (`L = λW`) is exactly as true here and
> more useful than usual. Tail-at-scale reasoning — that a p99 on one replica
> becomes a p50 experience for a fan-out — is unchanged. Admission control,
> backpressure, shedding early rather than thrashing, and the discipline of
> alerting on percentiles instead of means all carry over verbatim.
>
> **Does not transfer.** *Utilisation as a load signal*: continuous batching
> pins GPU utilisation near 100% whenever anything is running, so a starved
> GPU and a saturated one report the same number. *Request count as a unit of
> work*: a 100K-token prompt and a 200-token prompt differ by 500× in cost, so
> requests-per-second measures almost nothing. *Stateless replicas*: the prefix
> cache makes replicas non-interchangeable, so round-robin is not neutral, it
> is destructive. *Fast replacement*: a new replica is minutes away, and a
> draining one is minutes from finishing.

## The metrics that matter are physical

The instrumentation an ordinary service ships with — RPS, error rate, CPU,
p99 request latency — describes almost nothing about an inference fleet.
Replace it with meters pointed at the actual bottlenecks.

**Queue depth, in tokens.** This is the single most important reframing.
Requests are not units of work. A queued 100K-token prompt is, under a 2,048-
token chunk budget, about fifty scheduler steps of work; a queued 200-token
prompt is one. Measuring `queue_length = 4` tells you nothing about whether
you are two seconds or two minutes from draining it. Sum the *pending prefill
tokens* instead, and divide by your measured prefill token rate to get an
estimated queue wait — which is the number you actually want, and the one you
should scale on.

**TTFT p50/p99.** Queue time plus prefill. Compute-bound, grows with prompt
length, and — critically — its p99 is dominated by queueing, not by model
speed.

**TPOT and ITL, p50/p99.** TPOT is the average steady-state gap; ITL is the
instantaneous one. Track both. They diverge exactly when the scheduler is
reshuffling the batch, and that divergence is a diagnosis in itself.

**KV pool utilisation.** The fraction of the block pool in use. Healthy is a
band, not a maximum: **60–85%**. Sustained above ~95% and you are one long
sequence away from preemption; persistently under ~30% and you have bought HBM
you are not using — raise the batch limit or lengthen the working context you
admit.

**Preemption / recompute rate.** From
[Continuous Batching](#/continuous-batching): when the pool empties, vLLM V1
drops a running sequence's KV and rebuilds it later. Healthy is **zero, or a
rare spike**. Any *sustained* nonzero rate means the pool is undersized for the
admitted batch, and it is uniquely vicious — every preemption creates prefill
work, which consumes the resource that was already scarce. This is a thrashing
metric and it should page someone.

**Prefix cache hit rate — physical, not logical.** A router reporting a 99%
logical hit rate can be delivering nothing, because the matched block was
evicted from the pool before the request arrived. A logical hit that is not
physically resident is a miss with extra steps. Instrument the hit rate that
ends in *restored or reused bytes*, and alert on the gap between the two
numbers, because that gap is exactly the recompute you are paying for.

**Running batch size distribution over time.** Not the mean — the histogram.
Compare it against `B_crit` (~295 on an H100 in BF16, ~148 with FP8 weights).
A distribution clustered well below the ridge says you are KV-bound or
admission-limited; one pinned at your configured maximum says you are
admission-limited by your own config; a **bimodal** distribution at 1 and max
usually means bursty arrivals your scheduler is not smoothing.

**MBU for decode, MFU for prefill.** Report the utilisation whose ceiling is
truly 100% for the binding resource, per
[Inference Arithmetic](#/inference-arithmetic). Healthy decode MBU is
**~50–60%**; healthy dense prefill MFU is **35–55%**. A decode MFU of 9% is not
an incident; it is the expected signature of the memory-bound regime, and
alerting on it will teach your team to ignore alerts.

**Goodput.** Throughput counting only requests that met their SLO — say
`TTFT < 1 s` and `TPOT < 50 ms`. This is the one number that ties to the
promise you made, and it is the only one worth putting on the top of the
dashboard. Raw throughput can rise while goodput falls, and when it does, your
system is optimizing against your users.

## Reading the symptoms

The diagnostic value is in the *pairs*. Any one curve moving is ambiguous;
two curves moving together name the resource.

| Symptom | What it means | Confirm with | What to change |
|---|---|---|---|
| **TTFT rising, TPOT flat** | Queueing and admission, not model speed. Requests wait; once running they run fine. | Pending prefill tokens climbing; running batch *not* at max | Add replicas, or shed/queue earlier. Do **not** tune the model. |
| **TPOT rising, batch size flat** | KV per sequence grew — contexts got longer. Attention's KV reads do not amortize across the batch, so more tokens per sequence means more bytes per step. | Mean live context length; KV pool utilisation up at constant batch | Shorter working context, FP8 KV, or accept fewer concurrent sequences |
| **Both rising together** | You are past `B_crit` (compute-bound, latency now scales with batch) **or** the pool is thrashing. Two very different causes. | Preemption rate: ~0 → past `B_crit`; nonzero → thrashing | Past `B_crit`: cap the running batch at the ridge. Thrashing: shrink the batch limit until preemptions stop, then fix the pool. |
| **ITL spiky, TPOT fine** | Scheduler reshuffling and prefill interference. The average is fine; individual gaps are not, and users feel gaps. | Correlate ITL spikes with prefill chunk admissions | Reduce the chunk size (`max_num_batched_tokens`) — smoother ITL, slower prefill. That is the dial. |
| **Throughput fine, goodput collapsing** | You are trading the tail for the mean. The scheduler is packing more work per step and a growing minority misses its SLO. | The p99/p50 ratio for both TTFT and TPOT | Lower the batch or chunk limit, add admission control with an SLO estimate, or [disaggregate](#/disaggregation) |
| **TTFT high on some replicas only** | Cache-affinity hotspot: one replica owns the popular prefix and is drowning while others idle. | Per-replica prefix hit rate vs per-replica load | Tune the router's `overlap − load` weighting so it spills sooner |
| **TTFT fine, TPOT terrible, pool nearly empty** | Batch too small — you are memory-bound with nobody to share weight reads with. | Batch histogram far below `B_crit` | Raise the concurrency limit; below the ridge, extra sequences are nearly free |

The one to internalize is row one. **TTFT rising while TPOT is flat is a
capacity problem, not a performance problem**, and the instinct to go tune the
model, the kernels, or the quantization is exactly wrong. The requests that are
running are running at full speed; the ones that are slow have not started.

## Autoscaling, and why the obvious signals lie

**The load signal is not request count.** A request is not a unit of work — it
is a variable amount of prefill plus an unknown amount of decode. Two services
at identical RPS can differ 100× in GPU demand. If your HPA is on RPS, it is
measuring something uncorrelated with the thing you are scaling.

**GPU utilisation is close to meaningless.** This is the trap that catches
every SRE exactly once. Continuous batching runs the loop every 10–50 ms
forever; if a single sequence is decoding, kernels are launching and the device
reports busy. But decode at batch 1 runs at ~1 FLOP/byte, roughly 300× below
the ridge — the GPU is 99% idle in every sense that matters and 100% busy on the
meter. **A starved GPU reports busy.** Scaling up on 90% GPU utilisation, or
refusing to scale on it, are both coin flips.

> [!bridge] You already know this — from the Linux course
> The USE method separates **utilization** (is the resource busy?) from
> **saturation** (how much work is queued behind it?) and tells you the second
> is almost always the one that matters — a road at 100% utilisation with no
> queue is fine. That distinction is doing all the work here. What differs is
> that on a GPU the utilisation half is not merely less useful, it is
> *degenerate*: continuous batching pins it near 100% no matter what, so the
> only readings with information are the saturation ones — pending prefill
> tokens and KV pool pressure.
> [→ Linux: Performance Analysis Methodology](../#/perf-methodology)

**Scale on queue wait and KV pool pressure.** Two signals, both physical:

- **Estimated queue wait** = pending prefill tokens ÷ measured prefill token
  rate. This is directly comparable to your TTFT SLO, which makes the scaling
  threshold something you can *derive* rather than tune.
- **KV pool utilisation and preemption rate.** These say you are out of the
  capacity that limits concurrency, which is a different exhaustion from being
  out of compute and needs a different response.

Little's law tells you how much to add, and it transfers unchanged. Required
concurrency `N = λ × W`, where `W` is a request's holding time, which for
generation is `output_tokens × TPOT`. So a reasoning model emitting 10× more
tokens per request needs 10× the concurrent slots at the *same* request rate —
which is why a model swap that changed nothing about your traffic can require a
fleet twice as large.

**The cold-start problem makes reactive scaling structurally late.** A new
replica must load tens to hundreds of gigabytes of weights before it serves one
token. If that takes three minutes and your traffic spike lasts four, the
replica arrives in time to serve the last minute and then be scaled back down.
Reactive autoscaling on a fleet with multi-minute cold starts does not
"respond slowly" — it responds *to the wrong event*. The working answers are
**pre-warmed pools** you scale between (keep N+k loaded and idle), predictive
scaling on known traffic shape, and admission control to protect the fleet you
already have. **Scale-to-zero is a lie for large models**: zero-to-one is the
expensive direction, and offering it means offering a multi-minute first
request.

**And the disaggregation trap.** If you run
[prefill/decode disaggregation](#/disaggregation), the two pools have
*different* load signals — the prefill pool scales on pending prefill tokens,
the decode pool on live concurrency and KV pressure — and they respond on
different timescales. A single autoscaler driving both from one aggregate
metric oscillates: it adds prefill capacity in response to decode pressure,
which admits more requests, which adds more decode pressure, which adds more
prefill capacity. Scale them independently, with the pool ratio (1P2D, 1P3D) as
a slow-moving parameter you revisit when your prompt:generation shape changes,
not a fast control loop.

## Where the cold-start minutes actually go

Weight loading is a four-hop pipeline, and knowing which hop dominates tells
you which fix is worth building. Take a 70B in BF16 — 140 GB.

```text
  object store → host page cache   140 GB ÷ ~1.5 GB/s   ≈  93 s   ← usually dominant
  local NVMe   → host page cache   140 GB ÷ ~5   GB/s   ≈  28 s
  page cache   → HBM (PCIe Gen5)   140 GB ÷ ~55  GB/s   ≈   2.5 s  ← nearly free
  CUDA context + graph capture / compile               ≈  20–60 s  [directional]
```

Read the shape. **The PCIe hop is a rounding error**; the network hop is the
whole problem. That single fact reorders your options:

- **A warm page cache changes everything.** If the weights are already in host
  RAM from a previous process on that node, you skip the 93 seconds entirely
  and cold start collapses to the PCIe copy plus graph capture — under a
  minute. Restarting a crashed replica *on the same node* is a fundamentally
  cheaper operation than starting one on a fresh node, and your scheduler
  should know that.
- **Local NVMe caching** turns a 93-second pull into a 28-second read for every
  restart after the first on that node. Cheap to build, large payoff.
- **Streaming loads** overlap the network fetch with the host→HBM copy and the
  dtype conversion rather than doing them in sequence, which is worth roughly
  the smallest of the three rather than their sum.
- **Pre-pulled container images.** A serving image with CUDA, PyTorch and the
  engine is many gigabytes on its own; pulling it on the critical path adds a
  second network transfer to the one you were already worried about.
- **Snapshotting a warm process** — checkpointing after weights are resident
  and graphs are captured, then restoring — is the most aggressive fix and
  bypasses both the load and the capture. It is also the most operationally
  fragile [directional].

> [!bridge] You already know this — from the Linux course
> You have watched a second read of a file return roughly 100× faster than the
> first, with the major-fault count dropping to zero, purely because the bytes
> were still in the page cache. A replica restart is that experiment at 140 GB:
> same node, warm cache, no major faults, no 93-second pull. The difference is
> that here nobody usually *tells* the scheduler this — placement is decided on
> free capacity, so the one input that would turn a three-minute cold start into
> a forty-second one is the input it is not looking at.
> [→ Linux: Lab: Watch the Page Cache Work](../#/lab-page-cache)

One more thing that is *not* on the list but should be on your dashboard: a
freshly started replica has an **empty prefix cache**. It is "ready" by any
health check and will still show elevated TTFT for minutes while its block pool
warms. Ramp traffic into a new replica with a weight rather than switching it
on, or your rollout will look like a latency regression that mysteriously heals.

## Rollouts

Blue/green means running two full fleets at once. For a service whose fleet is
its dominant cost, and where a single replica is two H100s, that is the most
expensive deployment strategy ever devised. In practice you roll, with a surge
of one or two replicas, and you accept that a rollout takes hours.

**Canary on quality, not only on latency.** This is the inference-specific
failure and it is nasty, because it does not look like a failure. A newly
quantized model, a recompiled TensorRT engine, or an upgraded kernel can be
measurably *faster* and quietly *worse* — the latency dashboard goes green and
the output degrades in ways no infrastructure metric can see. Your canary needs
an evaluation gate alongside the latency gate: a fixed prompt set scored on the
canary and compared against the incumbent, and a refusal to promote on a
quality regression regardless of how good the p99 looks. The failure modes and
how to detect them are
[Did Quantization Break Your Model?](#/did-quantization-break-your-model); here
the point is only that **the deploy pipeline must have a quality gate or the
speed gate will happily ship a regression.**

**Draining is the operation nobody plans for.** A request generating 8,000
tokens at a 40 ms TPOT occupies its slot for **320 seconds** — over five
minutes. Killing the pod at the end of a 30-second grace period drops that
generation on the floor, mid-stream, after the user has already read half of it.

So drain by **refusing admission, not by killing**: fail the readiness probe so
the router stops sending new requests, keep serving the in-flight batch, and
terminate only when the batch empties or a hard deadline expires. That makes
`max_tokens` an *operational* parameter — it is the upper bound on your drain
time, and therefore on your rollout duration and your incident response.
A service that allows 128K-token generations has committed to drains measured
in tens of minutes, and should know it.

The same logic makes **scale-down dangerous** in a way scale-up is not. Retiring
a replica destroys its warm prefix cache and, if you get the drain wrong, its
in-flight sequences. The cache loss is invisible on the capacity dashboard and
shows up as a TTFT rise on the survivors, who now have to recompute prefixes
the retired replica was holding.

## Frequently asked

<div class="faq">

<details>
<summary>What single dashboard would you build first?</summary>

Four panels. **Goodput** (throughput within SLO) as the headline, because it is
the only number that means what you promised. **TTFT p50/p99 and TPOT p50/p99**
on one time axis, because the diagnostic value is in how the pair moves.
**KV pool utilisation and preemption rate** together, because the second is
what the first turns into when it saturates. And the **running batch size
histogram** with `B_crit` drawn on it, because that single line tells you which
regime you are in. Everything else is drill-down.

</details>

<details>
<summary>Our GPU utilisation is 100% and latency is fine. Are we well-utilised?</summary>

You have learned nothing from that metric. Continuous batching keeps kernels
launching whenever any sequence is live, so 100% is the reading for both a
saturated fleet and one serving a single user. Look at MBU for decode instead —
50–60% is healthy — and at the batch size histogram against `B_crit`. If your
batch sits at 12 against a ridge of 148, you are paying for compute you are
structurally unable to reach, and the fix is capacity, not efficiency.

</details>

<details>
<summary>Can we use spot or preemptible instances?</summary>

With care, and mostly for prefill. A preemption notice gives you seconds to
minutes; a decode replica mid-generation needs minutes to drain and loses its
warm cache when it goes. Prefill work is shorter-lived and more restartable,
which is one of the underrated benefits of disaggregation: it creates a pool
whose unit of work is small enough to be interruptible. Keep the decode pool
and any replica holding hot prefixes on stable capacity.

</details>

</div>

## What to remember

- **Measure the queue in tokens, not requests.** A request is not a unit of
  work; a 100K prompt is ~500× a 200-token one. Pending prefill tokens ÷
  prefill token rate is an estimated queue wait you can compare to your SLO.
- **The metric set:** TTFT and TPOT/ITL at p50/p99, KV pool utilisation
  (healthy 60–85%), preemption rate (healthy zero), **physical** prefix hit
  rate, batch size histogram against `B_crit`, MBU for decode (~50–60%) and MFU
  for prefill (35–55%), and **goodput** as the headline.
- **Read symptoms in pairs.** TTFT up with TPOT flat is queueing — do not tune
  the model. TPOT up at flat batch is context growth. Both up is past `B_crit`
  (preemptions ~0) or thrashing (preemptions nonzero). Spiky ITL at good TPOT
  is prefill interference — look at chunk size. Throughput up with goodput down
  means you are trading the tail for the mean.
- **GPU utilisation is not a load signal**: batching pins it near 100% and a
  starved GPU reports busy. Scale on **queue wait** and **KV pool pressure**.
- **Little's law transfers:** required concurrency = arrival rate × output
  tokens × TPOT. A reasoning model at the same RPS can need 10× the slots.
- **Cold start is the network hop**, not PCIe: ~93 s to pull 140 GB from object
  store, ~2.5 s to move it into HBM. Warm page cache, local NVMe, pre-pulled
  images, streaming loads, warm snapshots — and a pre-warmed pool, because
  scale-to-zero is a lie for large models.
- **Prefill and decode pools scale on different signals.** One autoscaler over
  both oscillates.
- **Rollouts:** no blue/green at these prices; canary on **quality as well as
  latency**, because a quantized or recompiled model can be faster and worse;
  and **drain by refusing admission**, since an in-flight 8K generation holds
  its slot for over five minutes — which makes `max_tokens` an operational
  parameter.

```quiz
[
  {
    "q": "TTFT p99 has doubled over an hour while TPOT p50 and p99 are unchanged. What is happening, and what should you not do?",
    "choices": [
      "The model got slower; profile and optimize the kernels",
      "Requests are queueing before admission — capacity or admission control is the problem, not model speed, so tuning the model, kernels or quantization is exactly the wrong response",
      "The KV cache is fragmenting; restart the replicas",
      "The tokenizer is the bottleneck; move it to a separate process"
    ],
    "answer": 1,
    "explain": "TTFT is queue time plus prefill; TPOT is steady-state decode. Flat TPOT means every request that is running is running at full speed, so the extra latency is accumulated before the request starts. That is a capacity or admission problem — add replicas or shed earlier. The instinct to optimize the model is misdirected because the model is already fast enough for the work it is doing."
  },
  {
    "q": "Why is GPU utilisation a poor autoscaling signal for an LLM serving fleet?",
    "choices": [
      "It is sampled too infrequently by most monitoring agents",
      "Continuous batching launches kernels every 10–50 ms whenever any sequence is live, so a batch-1 decode running ~300× below the ridge reports the same near-100% utilisation as a saturated fleet — a starved GPU reports busy",
      "GPU utilisation counts memory transfers as compute, inflating the number",
      "It only reflects the prefill phase and ignores decode entirely"
    ],
    "answer": 1,
    "explain": "The meter measures whether kernels are resident, not whether work is being accomplished. Decode at batch 1 keeps the device nominally busy while using under 1% of its FLOPs, so the reading is identical for a fleet in trouble and one that is idle-but-live. Scale instead on estimated queue wait (pending prefill tokens ÷ prefill token rate) and KV pool pressure, both of which are physically tied to your SLO."
  },
  {
    "q": "TTFT and TPOT are both rising. What single additional metric distinguishes the two very different causes?",
    "choices": [
      "GPU temperature",
      "The preemption/recompute rate: near zero means you have pushed past B_crit into the compute-bound regime; sustained nonzero means the KV pool is thrashing",
      "The tokenizer throughput",
      "Network bandwidth between replicas"
    ],
    "answer": 1,
    "explain": "Both causes raise both curves, but the remedies are opposite. Past B_crit, per-token latency simply scales with batch and you cap the running batch at the ridge. Thrashing means the pool cannot hold the admitted batch, so every preemption creates fresh prefill work and consumes the resource already exhausted — you must shrink the batch limit or enlarge the pool. Preemption rate is what tells them apart."
  },
  {
    "q": "A replica must load a 140 GB model. Which hop dominates cold start, and what does that imply?",
    "choices": [
      "The host RAM → HBM copy over PCIe, so faster PCIe generations are the main fix",
      "The object store → host page cache pull (~93 s at ~1.5 GB/s), which dwarfs the ~2.5 s PCIe copy — so local NVMe caching, warm page cache and pre-pulled images matter far more than bus speed",
      "CUDA context creation, which is fixed and cannot be avoided",
      "Tokenizer initialization, which must parse the full vocabulary"
    ],
    "answer": 1,
    "explain": "At ~55 GB/s, PCIe moves 140 GB in about 2.5 seconds — a rounding error. The network pull is roughly 93 seconds and is the whole problem, which is why a warm page cache turns a multi-minute cold start into a sub-minute one, and why restarting on the same node is a categorically cheaper operation than starting on a fresh one. Reactive autoscaling cannot outrun this; pre-warmed pools can."
  },
  {
    "q": "Why must a draining inference replica refuse admission rather than be killed after a short grace period?",
    "choices": [
      "Because the KV cache must be flushed to disk before shutdown",
      "Because an in-flight generation of 8,000 tokens at 40 ms TPOT holds its slot for over five minutes, so a 30-second grace period drops live streams mid-answer — which also makes max_tokens an operational bound on drain and rollout time",
      "Because CUDA graphs cannot be destroyed while the process is serving",
      "Because the router cannot detect a terminated replica for several minutes"
    ],
    "answer": 1,
    "explain": "Decode is sequential and slow, so a request's residence time is output_tokens × TPOT — minutes for a long generation. Failing readiness stops new admissions while the existing batch finishes, which is the only drain that does not truncate users mid-answer. The consequence people miss is that the max_tokens you allow is the upper bound on how long a drain, and therefore a rollout or an incident evacuation, can take."
  }
]
```
