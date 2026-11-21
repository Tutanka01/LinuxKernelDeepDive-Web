# Operating It

> **The question:** once the fleet is live, which numbers tell you what is binding,
> which ones should wake someone, and how do you change a fleet whose machines take
> minutes to start and minutes to drain?
>
> **You'll be able to:** read an engine's `/metrics` scrape into the USE grid and name
> the binding resource; write alerts that fire on the promise and stay quiet on noise;
> choose autoscaling signals that do not lie; plan a rollout around cold start, drain
> and the peak.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="router,api,scheduler"></div>

Most of a distributed-systems toolkit transfers here. The parts that are silently
wrong are the ones you reach for first: utilisation as a load signal, requests as a
unit of work, replacement as fast. This chapter is the ordinary day — what to watch,
what to page on, how to change the fleet. A GPU fault, a hung replica or a template
that empties the cache belongs to [When It Breaks](#/when-it-breaks).

## What the engine tells you

Every five seconds a vLLM replica prints one line — what the on-call reads before any
dashboard has loaded. Replica A of Ask Halden at 10:15 on a phase-2 morning:

```plaintext
(APIServer pid=2817) INFO 11-21 10:15:02 [loggers.py:328] Engine 000: Avg prompt throughput: 5350.0 tokens/s, Avg generation throughput: 337.5 tokens/s, Running: 8 reqs, Waiting: 0 reqs, GPU KV cache usage: 14.2%, Prefix cache hit rate: 59.6%
```

*Real format, illustrative values — message parts from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`, line number illustrative; values computed from the case's phase-2 peak for one of two replicas (0.5 Q&A requests/s × 250 output tokens, 0.25 agent requests/s × ~850, ~2 Q&A requests and ~6 agent sessions running), not measured.*

Two fields mislead. *Avg prompt throughput* counts only computed tokens (the source:
"excludes cached/transferred"): 5,350 is half the node's 10.7K fresh tokens/s, not
the 13K it was asked to read. *GPU KV cache usage* is 14.2% although phase 2 needs
~61 GB of the node's 132: the gauge is `1 − free blocks ÷ total blocks`, and a cached
block no running request references is on the free list, so this replica's ~14
parked sessions (1.3 GB each) read as free. It measures live sequences, not whether
the cache is about to lose what phase 2 depends on.

The `/metrics` scrape carries the same numbers with history. Read the suffixes first:
a gauge is a current value, a counter gets `_total` and only grows, a histogram is
`_bucket`, `_sum` and `_count`:

```plaintext
# HELP vllm:num_requests_waiting Number of requests waiting to be processed.
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 0.0
vllm:kv_cache_usage_perc{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 0.142
# TYPE vllm:num_preemptions_total counter
vllm:num_preemptions_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 0.0
vllm:prompt_tokens_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 5.0412e+07
vllm:prompt_tokens_cached_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 3.0045e+07
vllm:prompt_tokens_by_source_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",source="local_compute"} 2.0367e+07
vllm:prefix_cache_queries_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 5.0398e+07
vllm:prefix_cache_hits_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 3.0041e+07
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",le="0.5"} 5871.0
vllm:time_to_first_token_seconds_bucket{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",le="1.0"} 6214.0
vllm:time_to_first_token_seconds_bucket{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",le="1.5"} 6266.0
vllm:time_to_first_token_seconds_bucket{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",le="2.5"} 6280.0
vllm:time_to_first_token_seconds_bucket{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",le="+Inf"} 6290.0
vllm:time_to_first_token_seconds_count{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 6290.0
vllm:request_success_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",finished_reason="stop"} 6254.0
vllm:request_success_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",finished_reason="length"} 21.0
…
```

*Real format, illustrative values — names, types, labels and the `finished_reason` and `source` label values from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`, `stats.py` and `vllm/v1/engine/__init__.py`; the `le="1.5"` bucket exists only with the launch flag shown below; counts are cumulative since a 06:00 start, invented to match the case's ~60% hit rate, not measured.*

Counters are totals since 06:00: rates need two scrapes (Prometheus's `rate()`, or
you by hand in Exercise 1). Two ratios look alike. `prefix_cache_hits ÷
prefix_cache_queries` counts tokens found in the GPU cache at admission;
`prompt_tokens_cached ÷ prompt_tokens` counts every prompt token not computed,
host-memory reloads included — the one that predicts Halden's prefill load. Both are
token-weighted; a hit rate counted in requests predicts nothing.

## The USE grid for the serving stack

The USE method ([Performance Analysis Methodology](../#/perf-methodology)) carries
over with one change: GPU utilisation is degenerate. `DCGM_FI_DEV_GPU_UTIL_RATIO` is
the fraction of time *any* kernel ran, and continuous batching keeps one running
whenever a sequence is alive. Each chapter recorded one row; here they are together.

> [!dashboard] The serving stack, assembled
> | resource | utilisation | saturation | errors |
> |---|---|---|---|
> | queue and scheduler | `vllm:num_requests_running` vs `--max-num-seqs`; `vllm:iteration_tokens_total` vs the token budget | `vllm:num_requests_waiting_by_reason{reason="capacity"}`; `vllm:request_queue_time_seconds` (lags) | `vllm:admission_rejections_total`; `finished_reason="error"`; liveness: running > 0, `rate(vllm:generation_tokens_total[1m])` = 0 |
> | token throughput | `rate(vllm:generation_tokens_total)` and `rate(vllm:prompt_tokens_total)`, graphed apart | `vllm:request_queue_time_seconds` | none — derive goodput from the TTFT and TPOT buckets |
> | KV pool | `vllm:kv_cache_usage_perc` (referenced blocks only) | `rate(vllm:num_preemptions_total)` | `vllm:request_num_preemptions` (repeat victims) |
> | KV read per step (attention) | none — derive: KV usage × pool, against the weight bytes | `vllm:inter_token_latency_seconds` rising with `vllm:request_prompt_tokens` | none — `GPU KV cache size` against your arithmetic |
> | prefix cache | token-weighted hit rate: `vllm:prompt_tokens_cached_total` ÷ `vllm:prompt_tokens_total` | `vllm:kv_block_idle_before_evict_seconds` under the tool wait; `local_compute` share rising | none — derive from each call's `cached_tokens` |
> | GPU compute (prefill) | `DCGM_FI_PROF_TENSOR_UTIL_RATIO`; `rate(vllm:estimated_flops_per_gpu_total)` ÷ peak | none — derive: `local_compute` prompt tokens/s against your measured prefill rate | `DCGM_FI_DEV_XID_ERROR` |
> | GPU memory bandwidth (decode) | `DCGM_FI_PROF_DRAM_UTIL_RATIO`; `rate(vllm:estimated_read_bytes_per_gpu_total)` ÷ 3.35 TB/s = MBU | none — derive: TPOT against the ladder rung you planned on | `DCGM_FI_DEV_ROW_REMAP_UNCORRECTABLE_TOTAL`, `DCGM_FI_DEV_ROW_REMAP_FAILED` |
> | interconnect (TP all-reduce) | `DCGM_FI_DEV_NVLINK_THROUGHPUT_BYTES_PER_SECOND` | none — derive: step time minus the rung-2 weight read | `DCGM_FI_DEV_NVLINK_CRC_ERROR_TOTAL`, `DCGM_FI_DEV_NVLINK_REPLAY_TOTAL` (optional) |
> | CPU side of the engine | `process_cpu_seconds_total` (API server only); `pidstat` on `VLLM::EngineCore` | none — derive: TTFT minus queue minus prefill time | HTTP 4xx/5xx in the access log |
> | host memory / offload tier | `vllm:kv_offload_config_info` labels; `node_memory_MemAvailable_bytes` | none — derive: `DCGM_FI_PROF_PCIE_RX_BYTES` during reloads | none — `vllm:prompt_tokens_cached_by_source_total{source="host"}` against the share you expect |
> | drafter (if on) | `rate(vllm:spec_decode_num_accepted_tokens_total)` ÷ `rate(vllm:spec_decode_num_draft_tokens_total)` | none — derive: running × (1 + γ) against the ~160 knee | none — TPOT on against off |
> | answer quality | not applicable | output-length drift: `vllm:request_generation_tokens` `_sum ÷ _count` | `finished_reason="length"` share |

DCGM names are dcgm-exporter 4.9.0's (November 2026, DCGM 4.7 names and units);
dashboards built on 4.8.4 read `DCGM_FI_DEV_GPU_UTIL` (percent),
`DCGM_FI_PROF_DRAM_ACTIVE`, `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`, `DCGM_FI_DEV_FB_USED`
(MiB) and `DCGM_FI_DEV_XID_ERRORS`. Pin the exporter with the dashboard. Engine-side
FLOP and byte counters need `--enable-mfu-metrics`; residency histograms need
`--kv-cache-metrics`.

Rows for [experts](#/moe-serving), the [prefill→decode link](#/disaggregation) and
[adapter slots](#/beyond-chat) join when the deployment does.

Six of twelve saturation cells say "none". No engine exports pending prefill tokens,
which predict TTFT; derive them as requests waiting × mean uncached prompt (`rate` of
`local_compute` tokens ÷ `rate` of `vllm:request_success_total`). Divided by your
measured prefill rate, that is an estimated queue wait comparable to the 1.5 s promise. `DCGM_FI_DEV_FB_USED_BYTES` is missing on purpose: it reads ~90%
from the moment the engine allocates its pool. In phase 2 retrieval runs off the node:
its time is inside the user's TTFT but outside `vllm:time_to_first_token_seconds` —
measure it at the application.

Healthy MBU? The case plans on ~14 ms per step (MBU ~74%); Databricks' published
batch-1 figure, 50–60%, means 17–21 ms. Both fit the promise; Halden runs
`vllm bench serve --max-concurrency 1` and reads this row.

## Reading symptoms in pairs

> [!predict] Before you read on
> TTFT p95 has tripled over a week. TPOT is unchanged. The model team proposes
> quantizing to make the model faster. Is that the right fix — yes or no?

No. Running requests run at full speed — TPOT says so. The time goes before they
start: queueing, a capacity problem. Each curve alone is ambiguous; the pair names the
resource:

| Symptom | Meaning | Confirm with | Change |
|---|---|---|---|
| TTFT up, TPOT flat | queueing for prefill | estimated queue wait rising; `local_compute` rate near your prefill rate | add capacity, shed or queue earlier |
| TPOT up, batch flat | longer contexts: more KV read per step | `vllm:request_prompt_tokens` shifting right | FP8 KV, shorter admitted context |
| Both up, preemptions zero | prefill chunks ride every step: hybrid ~50 ms steps | `vllm:iteration_tokens_total` pinned at the token budget | more prefill capacity, a better hit rate |
| Both up, preemptions rising | KV pool thrashing | `rate(vllm:num_preemptions_total)` > 0 | admit less until preemption stops |
| ITL spiky, TPOT fine | prefill interference | ITL spikes align with long prompts | a smaller token budget |
| TTFT high on some replicas | affinity hotspot | per-replica hit rate versus load | let the router spill sooner |

A Halden decode batch never reaches B_crit: ~160 sequences × 11K tokens × 164 KB ≈
290 GB of KV against a 66 GB pool. The reachable walls are the KV pool and prefill;
the ~160-token knee *is* crossed whenever a 512-token chunk joins a step: the third
row.

## Alerts that page on the promise

The previous edition alerted on "goodput below 98% for 10 minutes". Off-peak, Ask
Halden serves ~0.1 requests per second — 60 in ten minutes — so two slow requests page
someone at 03:00. The repair is **burn-rate alerting**. State the promise as an error
budget: "95% of first tokens within 1.5 s" allows 5% bad requests. The burn rate is the
bad fraction divided by the budget: 1 spends it exactly as it accrues, 6 means 30% of
requests are bad. Page when the burn rate is high over a long window (it is real)
*and* a short one (it is still happening); ticket when it is moderate over hours.

> [!predict] Before you read on
> vLLM's default TTFT buckets include 1.0 s and 2.5 s, nothing between. If 95% of
> requests really finish within 1.4 s, will `histogram_quantile(0.95, …)` over the
> default buckets report a value below or above the 1.5 s promise?

Quite possibly above. Prometheus interpolates linearly inside the bucket holding the
quantile; if the 95th request sits past a third of the (1.0, 2.5] bucket's population,
the query reports a breach that did not happen. The fix is a boundary at the promise —
for TPOT too, whose buckets jump from 0.05 to 0.075. Halden adds both at launch:

```diff
 vllm serve RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
   --device-ids 0,1 --port 8001 \
   --tensor-parallel-size 2 --kv-cache-dtype fp8 \
   --gpu-memory-utilization 0.90 --max-model-len 24576 \
   --max-num-seqs 64 --max-num-batched-tokens 512 \
   --kv-offloading-size 128 --kv-offloading-backend native \
-  --enable-auto-tool-choice --tool-call-parser llama3_json
+  --enable-auto-tool-choice --tool-call-parser llama3_json \
+  --kv-cache-metrics --enable-mfu-metrics \
+  --custom-histogram-buckets '{"time_to_first_token": [0.25, 0.5, 1.0, 1.5, 2.5, 5.0, 10.0],
+                               "inter_token_latency": [0.02, 0.03, 0.045, 0.06, 0.1, 0.25]}'
```

*Real format, illustrative values — flags from vLLM v0.34.0 `vllm/engine/arg_utils.py` and `vllm/config/observability.py`, bucket families from `vllm/v1/metrics/buckets.py`; the base launch line is [the capstone](#/sizing-a-deployment)'s replica A, the bucket lists are Halden's choice.*

The `inter_token_latency` family also sets the per-request TPOT histogram's buckets.
With boundaries at the promises, "good" is a bucket count, and the case's three alerts
compile to:

```yaml
groups:
- name: ask-halden
  rules:
  - record: halden:ttft_bad:ratio_rate5m
    expr: |
      1 - sum(rate(vllm:time_to_first_token_seconds_bucket{le="1.5"}[5m]))
        / sum(rate(vllm:time_to_first_token_seconds_count[5m]))
  - record: halden:ttft_bad:ratio_rate30m
    expr: |
      1 - sum(rate(vllm:time_to_first_token_seconds_bucket{le="1.5"}[30m]))
        / sum(rate(vllm:time_to_first_token_seconds_count[30m]))
  - record: halden:ttft_p95:5m          # the dashboard panel, not an alert
    expr: histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[5m])))

  - alert: TTFTBudgetFastBurn           # 6 x a 5% budget = 30% of requests late
    expr: |
      halden:ttft_bad:ratio_rate30m > 6 * 0.05
      and halden:ttft_bad:ratio_rate5m > 6 * 0.05
      and sum(rate(vllm:time_to_first_token_seconds_count[30m])) > 0.05
    labels: {severity: page}
  # TPOTBudgetFastBurn: same shape on vllm:request_time_per_output_token_seconds_bucket{le="0.06"}
  # and a ticket-severity pair at 2 x budget over 6h and 30m

  - alert: PrefixHitRateLow             # 50%: prefill at 59% of node capacity; 40% would be 70%
    expr: |
      sum(rate(vllm:prompt_tokens_cached_total[10m])) / sum(rate(vllm:prompt_tokens_total[10m])) < 0.50
      and sum(rate(vllm:prompt_tokens_total[10m])) > 2000
    for: 5m
    labels: {severity: page}

  - alert: KVPreemptionsSustained
    expr: sum by (instance) (rate(vllm:num_preemptions_total[5m])) > 0
    for: 10m
    labels: {severity: ticket}
```

*Real format, illustrative values — Prometheus alerting-rule syntax; metric names and the `le` label from vLLM v0.34.0 `loggers.py`; thresholds derived in this chapter from the case, not tuned on traffic.*

The guard: below 0.05 requests per second (fewer than 90 in 30 minutes) nothing
pages. The cost: if every request turns bad, the 30-minute window crosses 30% after
nine minutes. That delay is why the hit-rate alert exists — the hit rate falls the
moment a template change ships, before any request is late.

Its 50% threshold is derived. Agent traffic alone hits at ~64%; the counters mix in
Q&A, whose 768 cached tokens out of 3,000 hit at ~26%, and a broken agent preamble
leaves only those:

```python
# Ask Halden, phase-2 peak, whole node (numbers from the running case)
queried = 1.0 * 3_000 + 0.5 * 47_000      # prompt tokens/s arriving (Q&A + agent, uncached)
fresh = 1.0 * 2_200 + 0.5 * 17_000        # prompt tokens/s actually computed, caches warm
capacity = 2 * 1.58e15 / (2 * 70e9)       # tokens/s: two FP8 TP=2 replicas at 40% MFU
print(f"queried {queried:,.0f} tok/s, capacity {capacity:,.0f} tok/s")
print(f"normal hit rate {1 - fresh / queried:.0%}, prefill load {fresh / capacity:.0%}")
for hit in (0.50, 0.40, 0.25, 0.03):        # 3%: agent preamble broken
    print(f"hit rate {hit:.0%} -> prefill load {queried * (1 - hit) / capacity:.0%}")
for load in (0.70, 1.00):
    print(f"load {load:.0%} is reached at hit rate {1 - load * capacity / queried:.0%}")
# queried 26,500 tok/s, capacity 22,571 tok/s
# normal hit rate 60%, prefill load 47%
# hit rate 50% -> prefill load 59%
# hit rate 40% -> prefill load 70%
# hit rate 25% -> prefill load 88%
# hit rate 3% -> prefill load 114%
# load 70% is reached at hit rate 40%
# load 100% is reached at hit rate 15%
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

Normal is 60%; a broken preamble means ~3% and 114% of the node's prefill. Queueing
starts costing TTFT past ~70% load, reached at 40%. 50% sits ten points under normal,
ten above that, and a template break crosses it in the first window.

## Autoscaling

[The KV Fabric](#/the-kv-fabric) shows the scaling object — a trigger on requests
running and waiting — and why utilisation is not a signal. Requests per second is no
better: two services at the same RPS can differ a hundredfold in GPU demand. And
reactive scaling is late when a replica takes minutes to start: keep pre-warmed
headroom and scale predictively on the daily shape. Halden, on one rented node,
does not autoscale; its version of the question is the rollout.

## Where cold-start minutes go

> [!predict] Before you read on
> A replica starts on a fresh node and loads Halden's pinned 72.7 GB FP8 checkpoint.
> Which step dominates: pulling the weights over the
> network, copying them over PCIe into HBM, or compiling and capturing CUDA graphs?

Usually the pull, and the loader matters more than the storage. A 100 Gb/s link
caps the fetch at 12.5 GB/s: ~6 s at best. One stream at 1.5 GB/s — the previous
edition's figure, pessimistic for the parallel ranged reads AWS recommends — takes
~48 s. SGLang's v0.5.22 notes report DeepSeek-R1 on 8 × H200
loading "in 15.3 s instead of 160 s from 50 GB/s storage" with its InstantTensor
loader. From the page cache, the copy into HBM over
each GPU's own PCIe Gen5 link takes seconds. Then come profiling, KV allocation,
`torch.compile` and graph capture, which a comment in the vLLM source puts at "5~20
seconds". The log says where your minutes went:

```plaintext
(Worker_TP0 pid=3311) INFO 11-21 06:00:31 [default_loader.py:543] Loading weights took 15.20 seconds
(Worker_TP0 pid=3311) INFO 11-21 06:00:33 [model_runner.py:441] Model loading took 32.6 GiB memory and 17.402116 seconds
(Worker_TP0 pid=3311) INFO 11-21 06:00:52 [gpu_worker.py:796] Available KV cache memory: 30.7 GiB
(EngineCore_DP0 pid=3190) INFO 11-21 06:00:52 [kv_cache_utils.py:1168] GPU KV cache size: 402,816 tokens, Maximum concurrency for 24,576 tokens per request: 16.39x
(Worker_TP0 pid=3311) INFO 11-21 06:01:04 [model_runner.py:1216] Graph capturing finished in 12 secs, took 0.84 GiB
(EngineCore_DP0 pid=3190) INFO 11-21 06:01:05 [core.py:459] init engine (profile, create kv cache, warmup model) took 34.10 s (compilation: 14.80 s)
```

*Real format, illustrative values — message formats from vLLM v0.34.0 (`default_loader.py`, `vllm/v1/worker/gpu/model_runner.py`, `gpu_worker.py`, `kv_cache_utils.py`, `vllm/v1/engine/core.py`), line numbers illustrative; memory and token figures computed from the case (35 GB of FP8 weights and a 33 GB pool per GPU, 164 KB per token); times assume each TP worker's ~36 GB half of the 72.7 GB FP8 checkpoint arrives at ~2.4 GB/s (~4.8 GB/s for the pair, under a 100 Gb/s link); graph memory and compile time are invented within the source's own estimate; nothing here is measured.*

Check line four after every change: 402,816 tokens = the 66 GB pool ÷ 164 KB per
token. The last line is what snapshots attack.

> **State of play (November 2026):** vLLM v0.30 added Fast Start, "a persistent
> per-GPU weight-cache daemon" (`--load-format ipc_cache`); v0.31 added experimental
> snapshots that "use CRIU to restore a fully initialized TP1 engine"; v0.34 added
> "Checkpoint/restore (CRIU + `cuda-checkpoint`)" through `/checkpoint/*` endpoints.
> Dynamo v1.6.0 backs engine failover with snapshots. The daemon makes a flag change cheap, not an upgrade (it
> holds the *same* weights); v0.31 snapshots are TP=1 and Halden runs TP=2; the v0.34
> notes do not say which layouts restore.

> [!bridge] From the Linux course
> In the lab, `cuda-checkpoint` moved one process's device memory to host RAM and
> CRIU dumped the now-ordinary process. An engine checkpoint differs three ways. A TP=2
> replica is several processes and two GPUs that must be frozen as one. The image still holds ~35 GB of
> weights per GPU, so a restore moves the same bytes a page-cache load moves; what it
> saves is everything after the copy — profiling, KV sizing, compilation, graph
> capture. And the lab's topology contract — compatible GPUs, the same number of them —
> means a TP=2 image restores onto two GPUs of the same kind, not onto whatever node
> the scheduler offers.
> [→ Linux: Lab: Checkpoint a CUDA Process](../#/lab-gpu-checkpoint)

However it starts, a new replica has an **empty prefix cache**: warm it with the
shared preambles or ramp traffic in, or the rollout looks like a latency regression
that mysteriously heals.

## Rollouts

Blue/green doubles the most expensive part of the system, so you roll a replica at a
time. **Gate on quality:** an upgraded kernel can be faster and quietly worse, so the
evaluation harness from [Did Quantization Break
Your Model?](#/did-quantization-break-your-model) blocks promotion however good the
p99 looks. Two more checks run before any replica moves: a diff of the rendered chat
template and tokenizer files, and the preamble-stability test from [The Agentic
Era](#/agentic-serving). A release is one unit — engine, model revision, tokenizer and
template, launch flags, driver — and rollback restores all of them.

> [!predict] Before you read on
> A generation of 8,000 tokens runs at 40 ms per token. How long does that request hold
> its slot — and what happens if the pod is killed after a 30-second grace period?

320 seconds; killing the pod at 30 s drops the answer mid-stream. **Drain by refusing
admission**: take the replica out of the router, wait for `vllm:num_requests_running`
to reach 0 or a deadline sized at the promised TPOT. `max_tokens` thus bounds drain
time, and so rollout time.

Then canary. With two replicas the canary is half the traffic, so compare replica
with replica: hit rate, bad ratios, and the `finished_reason="length"` and `"error"`
shares, where runaway generations and parser changes show first. Write the abort
criteria first; keep the previous image and weights on local disk.

A trap hides in "tune": `--max-num-seqs`, `--max-num-batched-tokens` and
`--gpu-memory-utilization` are launch flags. Changing one restarts the replica, cold
cache and all. Runtime levers live outside the engine: router weights, gateway
admission and shedding, client concurrency.

> [!case] The case: the dashboard, the alerts and the rollout plan
> **Panels:** TTFT and TPOT bad ratios and p95s; hit rate per replica with its host
> share; `local_compute` tokens/s against prefill capacity; KV usage with preemptions;
> `finished_reason` shares.
>
> **Alerts:** TTFT and TPOT fast burn (page); hit rate below 50% (page — it fires
> before the queue does); sustained preemptions (ticket).
>
> **The rollout is a scheduled risk.** At the phase-2 peak, the replica left serving
> needs ~61 of its 66 GB of KV and faces ~19.7K tokens/s of prefill demand against
> 11.3K: a rollout between 09:00 and 11:00 is a failure you induce. Halden rolls B at 14:00 with a 150 s drain
> (a 2,048-token answer at the 60 ms promise takes 123 s), warms the preambles, and
> canaries B through the next morning's peak, when both replicas are up and the
> busiest window is also the safest comparison. Abort if B's hit rate sits ten points
> under A's after warm-up, or its bad ratios or `length` share exceed A's by half over
> 30 minutes with ≥ 500 requests each. A follows the next afternoon.
>
> **What could have gone the other way:** a change window at 09:00 "when everybody is
> in" — Exercise 1 is that morning.

## Exercises

<div class="exercise">

**Exercise 1 — diagnosis.** At 10:19 someone restarted replica B to change a flag;
A carries everything. Two scrapes of A, 60 s apart:

```plaintext
# 10:20:00                                          # 10:21:00
vllm:num_requests_running 33.0                      vllm:num_requests_running 33.0
vllm:num_requests_waiting 7.0                       vllm:num_requests_waiting 51.0
vllm:kv_cache_usage_perc 0.64                       vllm:kv_cache_usage_perc 0.66
vllm:num_preemptions_total 0.0                      vllm:num_preemptions_total 0.0
vllm:prompt_tokens_total 5.4812e+07                 vllm:prompt_tokens_total 5.6014e+07
vllm:prompt_tokens_cached_total 3.2685e+07          vllm:prompt_tokens_cached_total 3.3346e+07
vllm:prompt_tokens_by_source_total{source="local_compute"} 2.2127e+07
                                                    vllm:prompt_tokens_by_source_total{source="local_compute"} 2.2668e+07
vllm:generation_tokens_total 1.40112e+06            vllm:generation_tokens_total 1.43841e+06
vllm:iteration_tokens_total_count 497210.0          vllm:iteration_tokens_total_count 498340.0
vllm:iteration_tokens_total_bucket{le="256.0"} 381402.0   …{le="256.0"} 381414.0
vllm:time_to_first_token_seconds_count 6830.0       vllm:time_to_first_token_seconds_count 6966.0
vllm:time_to_first_token_seconds_bucket{le="1.5"} 6786.0  …{le="1.5"} 6804.0
vllm:request_time_per_output_token_seconds_count 6812.0   …_count 6984.0
vllm:request_time_per_output_token_seconds_bucket{le="0.06"} 6777.0  …{le="0.06"} 6918.0
```

*Real format, illustrative values — metric names from vLLM v0.34.0 `loggers.py`, layout trimmed to two columns; deltas computed from the case's step-time model for one replica carrying the node's phase-2 peak, not measured.*

Compute, per second: steps, prompt tokens computed, generation tokens, the
token-weighted hit rate, and the TTFT and TPOT bad ratios over the minute. What is
binding? What do you do in the next five minutes, and what must you not do?

<details>
<summary>Reveal answer</summary>

Per second: 18.8 steps (~53 ms each); 9.0K tokens computed; 622 generated (33 per
step — every running sequence decodes every step); hit rate 661K ÷ 1,202K = 55%. Only
12 of 1,130 steps carried ≤ 256 tokens: every step is full at the 512-token budget.
TTFT 87% bad (burn rate 17); TPOT 18% bad, because a full hybrid step (the case's
~50 ms, plus KV reads) nears the 60 ms promise.

Binding: prefill. At 55% the node's traffic needs ~11.9K fresh tokens/s (the case's
~19.7K once every parked session is evicted); a step clears ~479 prompt tokens per
~53 ms, ~9K/s. The queue grows ~44 requests a minute. KV is next: slower decodes hold
66% of the pool, parked sessions are evicted, the hit rate slips from 60% to 55% —
more prefill. Zero preemptions: not thrashing.

Now: return B to the router once ready; shed at the gateway meanwhile (agents queue
ahead of shedding chat). Do not restart A with a larger `--max-num-batched-tokens`: a
launch flag, on the only replica serving.

</details>

</div>

<div class="exercise">

**Exercise 2 — write the plan.** The next release upgrades vLLM past v0.34.0. Write
the rollout: checks before any replica moves, timing, the drain deadline (all calls are
capped at 2,048 output tokens), the canary comparison and window, abort criteria,
rollback — and what changes if the release also brings a newer checkpoint with a
different chat template.

<details>
<summary>Reveal answer</summary>

Before: the evaluation harness (kernels change numerics), the template diff
(expected empty), the preamble test, an acceptance sweep from [Load
Testing](#/load-testing). B at 14:00, A the next afternoon; drain deadline 150 s
(2,048 × 60 ms ≈ 123 s). Canary through the next peak on hit rate, bad ratios,
`finished_reason` shares and the `GPU KV cache size` log line; abort on the case's
criteria; roll back from local disk. A new checkpoint changes the release in kind: the
template diff is *expected* non-empty, so the preamble test is rewritten and B's hit
rate starts from zero; KV per token and every KV threshold are recomputed; and half
the traffic is too big a canary — route a fraction of sessions to B.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Halden's embedding model serves ~300-token requests, one
vector each, no generation. Redo the USE grid: which rows disappear, what becomes the
saturation signal, what does the alert look like?

<details>
<summary>Reveal answer</summary>

No decode: TPOT, ITL and the bandwidth row go; KV lives for one forward pass, so KV
usage stays near zero and preemption cannot happen; the prefix row goes unless
documents repeat. What remains is a prefill service — compute and queue rows, with
saturation = requests waiting × ~300 tokens ÷ measured token rate — and short prompts
make the CPU row matter more. Alert on `vllm:e2e_request_latency_seconds` with the
same burn-rate shape and a bucket at the promise.

</details>

</div>

## What to remember

- KV usage counts referenced blocks; prompt throughput counts computed tokens.
- Half the saturation cells have no metric; queue wait = requests waiting ×
  uncached prompt ÷ measured prefill rate.
- Hit rates are token-weighted; Halden's normal is ~60%, and 50% pages.
- Alert on budget burn over two windows with a volume guard, with a bucket boundary at
  every promise.
- Cold start is set by the loader and what is warm; nothing restores the prefix cache.
- A rollout at the peak is a failure you schedule; launch-flag changes are rollouts.

```quiz
[
  {
    "q": "A team's dashboard shows rate(vllm:prefix_cache_hits_total) / rate(vllm:prefix_cache_queries_total) = 0.25 on a RAG service, while their router reports that 92% of requests hit the cache. What fraction of prompt tokens does the replica still compute?",
    "choices": [
      "About 8%, because 92% of the requests found their prefix already in the cache",
      "About 75%, because the counters are weighted by tokens, not by requests",
      "About 25%, because the counter ratio is the share of tokens computed",
      "Impossible to say without the request-weighted rate of the engine"
    ],
    "answer": 1,
    "explain": "Both vLLM counters count tokens: queries is tokens looked up, hits is tokens found. 25% found means 75% computed. Most requests hitting something — a short shared system prompt in front of long retrieved text — is compatible with a low token-weighted rate, and only the token-weighted rate predicts prefill load."
  },
  {
    "q": "A chat service promises TTFT p99 ≤ 0.8 s. Its engine uses vLLM's default TTFT buckets (… 0.5, 0.75, 1.0 …). Over the last hour 2% of requests took longer than 0.8 s. What is the burn rate, and what must change before you can alert on it reliably?",
    "choices": [
      "Burn rate 0.02; the default buckets are already fine for a 1% budget",
      "Burn rate 2; add a 0.8 s bucket boundary with --custom-histogram-buckets",
      "Burn rate 2; switch the alert to histogram_quantile on the default buckets",
      "Burn rate 20; the service has already exhausted its monthly budget"
    ],
    "answer": 1,
    "explain": "A p99 promise is a 1% budget; 2% bad is twice the budget, a burn rate of 2. 0.8 s falls between the 0.75 and 1.0 boundaries, so neither a bucket count nor histogram_quantile can say which requests crossed 0.8 s; a boundary at the promise fixes both. 0.02 is the bad fraction, not the burn rate."
  },
  {
    "q": "A small chatbot replica shows DCGM_FI_DEV_GPU_UTIL_RATIO 0.97, DCGM_FI_PROF_TENSOR_UTIL_RATIO 0.04, vllm:num_requests_waiting at 0 and steady TPOT. Should the autoscaler add a replica?",
    "choices": [
      "Yes: 97% utilisation means the GPU is saturated and new requests will queue",
      "Yes: a 4% tensor pipe means decode is starved and needs another replica",
      "No: nothing waits, and kernels running all the time is what batching does",
      "No: the replica should instead be restarted with a larger --max-num-seqs"
    ],
    "answer": 2,
    "explain": "GPU_UTIL counts time any kernel runs, which continuous batching keeps near 1 whenever one sequence is alive. The saturation signals — waiting requests, TPOT — say there is no queue. A low tensor pipe at decode is normal (decode is memory-bound), not a reason to scale; and restarting to change a launch flag is a rollout, not a scaling action."
  },
  {
    "q": "Halden's engine is restarted with vLLM's weight-cache daemon holding the FP8 weights in GPU memory (--load-format ipc_cache). Which cost of a normal restart does the first agent request after the restart still pay?",
    "choices": [
      "Reading the 70 GB of FP8 weights again from the node's local NVMe disk",
      "Quantizing the BF16 checkpoint to FP8 on the GPU a second time",
      "Re-downloading the serving container image and the tokenizer files",
      "Prefilling the 3,000-token shared preamble into an empty cache"
    ],
    "answer": 3,
    "explain": "The daemon keeps post-quantized weights resident, so neither the load nor the quantization repeats, and nothing is re-downloaded. The KV pool, and the prefix cache in it, belong to the engine that was stopped: the new engine starts with no cached blocks, so the preamble is prefilled again."
  },
  {
    "q": "During a disaggregated deployment's peak, the decode pool's TPOT p95 rises from 30 to 48 ms while its vllm:num_requests_waiting stays at 0 and preemptions are zero; vllm:request_prompt_tokens has shifted towards longer prompts. What is binding?",
    "choices": [
      "Prefill interference: long prompts are being chunked into decode steps",
      "KV bandwidth: longer contexts mean more KV read in every decode step",
      "Pool thrashing: sequences are evicted and recomputed on every step",
      "Admission: the scheduler holds new requests back at the token budget"
    ],
    "answer": 1,
    "explain": "A decode-only pool runs no prefill, so interference is ruled out; zero preemptions rule out thrashing; nothing waits, so admission is not binding. Longer contexts mean each step reads more KV per sequence — the 'TPOT up, batch flat' row. The fix is cheaper KV (FP8, a model with less KV per token) or a cap on admitted context."
  }
]
```
