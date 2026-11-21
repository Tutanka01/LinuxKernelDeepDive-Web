# When It Breaks

> **The question:** at 3 a.m. the service is slow, wrong or down — how do you get
> from a symptom to a cause on a GPU serving stack, and what should already be
> written down before it happens?
>
> **You'll be able to:** place a symptom in a layer — hardware, runtime, engine,
> model output, client — from the USE row that moved; read the real telemetry of
> each layer (`dmesg` Xid lines, `nvidia-smi -q`, DCGM fields, vLLM's log and
> `/metrics`) and tell an alarming normal from a cause; write the runbook entry
> and the five-line postmortem for a failure on a single-node deployment.

The page says goodput fell to 52%. The router reports both replicas healthy. The
GPU dashboard shows four GPUs at 100% utilisation. All three are true; none says
what is wrong.

[Operating It](#/operating-it) built the steady-state view. This chapter is the
minutes after an alert fires, on a node with no spare.

## Method before catalogue

Start from what the user feels — slow first token, slow stream, wrong answers,
errors — and ask which row of the USE grid moved. Saturation (queue, KV pool)
points at load or at a component doing less work than before; errors point at a
layer; utilisation alone points nowhere — on a GPU it is the signal that lies.
Name the layer, then open its tools. Compare the gateway's TTFT with the
engine's: in phase 2 retrieval runs off the node, inside the user's TTFT and
outside `vllm:time_to_first_token_seconds`.

Two anti-methods prolong more incidents than any bug. **Looking where the
dashboard is**: a GPU panel exists, so the GPU is suspected, while the cause sits
in a prompt template with no panel. **Restarting first**: a restart clears the
stuck process, the frozen counters and the prefix cache — the evidence — and the
failure often returns an hour later. Capturing takes two minutes:

```bash
ts=$(date +%Y%m%dT%H%M%S); mkdir -p /var/tmp/incident-$ts && cd /var/tmp/incident-$ts
dmesg -T | grep -i nvrm         > dmesg-nvrm.txt
nvidia-smi -q                   > nvidia-smi-q.txt
for r in a b; do curl -s http://ask-halden-llm-$r:8000/metrics > metrics-$r-1.txt; done
sleep 30
for r in a b; do curl -s http://ask-halden-llm-$r:8000/metrics > metrics-$r-2.txt; done
journalctl -u vllm-a -u vllm-b --since "-30 min" > engine-logs.txt
```

*Real format, illustrative values — standard Linux and NVIDIA commands; the hosts, unit names and paths are Ask Halden's, invented.*

Two scrapes: a frozen counter is a finding.

## Failures by layer

| Layer | Failure | Signature | First action |
|---|---|---|---|
| Hardware | GPU fault (Xid), uncorrectable ECC, thermal throttling | `NVRM: Xid` in `dmesg`; DCGM error fields; clocks event reasons | read the Xid catalog entry; drain the replica |
| Runtime | collective stall under tensor parallelism | counters frozen while `/health` answers 200 | remove from the router, capture, restart |
| Runtime | out of memory | at startup: the engine never serves; at runtime: one process dies | read the startup memory lines |
| Engine | preemption thrash, a queue that never drains | `Preemptions:` in the log; `Waiting` climbing | shed load; see [Continuous Batching](#/continuous-batching) |
| Model output | NaN or garbage, runs to `max_tokens`, raw tool-call text | `finished_reason="length"` share; parse failures at the client | diff the release: model, template, generation config, parser |
| Client | retry storms, cache-killing prompt changes | arrivals above organic traffic; prefix hit rate collapsing | cap retries; diff the rendered prompt |

**Hardware.** NVIDIA GPUs report faults as **Xid** events, kernel-log lines of the
form `NVRM: Xid (PCI:0000:5a:00): 79, GPU has fallen off the bus.` — the PCI
address identifies the GPU, the number the event. NVIDIA's [Xid
catalog](https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html)
gives each code a meaning and a tenant action. For Hopper, the ones that matter
for inference:

| Xid | Catalog meaning | Catalog action |
|---|---|---|
| 13, 31 | application fault; GPU memory page fault | restart the application |
| 43 | the application hit a software-induced fault; "the GPU remains in a healthy state" | ignore |
| 45 | preemptive cleanup: logged when an application is killed (Ctrl-C, SIGKILL, reset) | usually a user or system action |
| 48 | double-bit (uncorrectable) ECC error | reset the GPU; DRAM: contact support |
| 63 / 64 | row remapping event / row remapping failure | reset at the next opportunity / reset and contact support |
| 74 | NVLink error — possibly a symptom of a fault at the other end | follow the register decode |
| 79 | the driver cannot reach the GPU over PCIe | contact support |
| 94 / 95 | contained / uncontained memory error | restart the application / reset the GPU |
| 119 / 120 | GSP firmware RPC timeout / GSP error | reset the GPU |

Two are routine: 45 appears whenever an engine is killed; 43 says the GPU is fine. A GPU whose memory degrades **remaps rows** — swaps a failing row for a
spare — effective only after a reset. `nvidia-smi -q` shows it:

```plaintext
==============NVSMI LOG==============
Driver Version                                         : 595.58.03
Attached GPUs                                          : 4
GPU 00000000:5A:00.0
    Product Name                                       : NVIDIA H100 80GB HBM3
    GPU Recovery Action                                : None
    Clocks Event Reasons
        SW Power Cap                                   : Not Active
        HW Slowdown                                    : Not Active
            HW Thermal Slowdown                        : Not Active
        SW Thermal Slowdown                            : Not Active
    ECC Errors
        Volatile
            DRAM Correctable                           : 112
            DRAM Uncorrectable                         : 0
    Remapped Rows
        Correctable Error                              : 3
        Uncorrectable Error                            : 0
        Pending                                        : Yes
        Remapping Failure Occurred                     : No
```

*Real format, illustrative values — section and field names from a published `nvidia-smi -q` log (driver 595.58.03, [local-inference-lab/rtx6kpro](https://github.com/local-inference-lab/rtx6kpro/blob/main/logs/asus-report/nvidia_smi_full.log)) and NVIDIA's [nvidia-smi documentation](https://docs.nvidia.com/deploy/nvidia-smi/index.html); values invented, other fields trimmed.*

Read `Pending : Yes`: a remap waits for a reset. The GPU still works; the
catalog's action for the accompanying Xid 63 is "reset the GPU at the next
available opportunity" — off-peak, replica drained. `Clocks Event Reasons` is
where throttling shows: an active `HW Thermal Slowdown` cuts clocks by half or
more and makes one replica slow while its twin is not.

DCGM exports the same to Prometheus. DCGM renamed its fields in 2026, keeping the
old names as aliases, and dcgm-exporter 4.9.0 (November 2026) exports the new
ones: the Xid field (230) is now `DCGM_FI_DEV_XID_ERROR`, formerly
`DCGM_FI_DEV_XID_ERRORS`. Either way it is a **gauge holding the last Xid seen** —
a single Xid 45 from last week's rollout keeps reading 45. Counting needs the
optional `DCGM_EXP_XID_ERRORS_TOTAL`.

> [!bridge] From the Linux course
> Out of memory, Linux's OOM killer takes one victim and the rest run on; an
> uncorrectable RAM error can kill just the processes mapping the bad page. A GPU
> engine differs on both counts. Its KV pool is allocated at startup, so a
> correctly sized engine does not run out at runtime — a runtime CUDA OOM means
> memory the startup profile never saw, such as another process on the GPU. And
> there is no partial victim: a GPU fault ends the CUDA context, which is the
> engine — under tensor parallelism, every GPU of the replica.
> [→ Linux: Trigger & Autopsy the OOM Killer](../#/lab-oom-killer)

> [!predict] Before you read on
> One GPU of a tensor-parallel replica dies; its partner is healthy and inside
> an all-reduce, waiting for it. What does the replica's `/health` endpoint
> return: 200, 503, or nothing at all?

**Runtime: the hung replica.** 200 — for a while. In vLLM v0.34, `/health` returns
503 only once the engine has been marked dead; it sends nothing through the GPUs.
How the engine finds out depends on how the faulty rank fails. If its worker
process dies, a monitor thread sees it at once and logs `Worker proc … died
unexpectedly`. If the process stays alive, the engine waits for the
`execute_model` call, which times out after `VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS`
— 300 s by default, applied when TP > 1. Then `EngineCore encountered a fatal
error.`, `/health` turns 503, and the API server exits unless
`VLLM_KEEP_ALIVE_ON_ENGINE_DEATH=1`. For five minutes the router feeds a replica
that generates nothing. Set up in advance: `--watchdog-config '{"dump_dir":
"/var/log/vllm/stacks"}'` (off by default), so a stuck process dumps its stacks
after 300 s, and a liveness check that measures progress — below.

**Engine.** Preemption thrash and a queue past capacity were diagnosed in
[Continuous Batching](#/continuous-batching). A dead engine is fatal for its
replica; only data- and expert-parallel deployments do better, with v0.34's
`--enable-fault-tolerance`, which removes dead ranks and redistributes their
experts without a restart.

**Model output.** These leave the latency panels green. A wrong stop token or
template makes answers run to `max_tokens`: watch the share of
`vllm:request_success_total{finished_reason="length"}` (other values: `stop`,
`abort`, `error`, `repetition`). `VLLM_COMPUTE_NANS_IN_LOGITS=1` counts NaN logits
in `vllm:corrupted_requests`, at some compute cost. A mismatched tool-call parser
returns the call as plain text; since v0.32 vLLM checks parser compatibility at
startup.

**Client and system.** A client that times out and retries three times can
quadruple the offered load just when the server can least absorb it. vLLM aborts
a request whose client disconnects, so the abandoned attempt stops decoding — but
its prefill is spent. A prompt change upstream can zero the prefix hit rate
without a single error.

> [!dashboard] GPU health and engine liveness
> **Utilisation:** `DCGM_FI_PROF_DRAM_UTIL_RATIO` (decode) and
> `DCGM_FI_PROF_TENSOR_UTIL_RATIO` (prefill) — never `DCGM_FI_DEV_GPU_UTIL_RATIO`,
> which is 1 whenever any kernel runs ([→ Linux: GPU
> observability](../#/gpu-observability)).
> **Saturation:** none for a GPU's health — derive it from thermal and power clock
> events (`DCGM_EXP_CLOCK_EVENTS_COUNT`, optional in dcgm-exporter).
> **Errors:** `DCGM_FI_DEV_XID_ERROR` (last Xid; enable `DCGM_EXP_XID_ERRORS_TOTAL`),
> `DCGM_FI_DEV_ROW_REMAP_FAILED`. Engine liveness: none — derive it:
> `vllm:num_requests_running > 0` while `rate(vllm:generation_tokens_total[1m]) == 0`.

## Three incidents

Open the clues one at a time; rank your hypotheses before the reveal. Ask
Halden runs two FP8 TP=2 replicas, A on GPUs 0–1 and B on GPUs 2–3.

<div class="exercise">

**Incident 1 — the replica that says it is fine.** Tuesday 10:12, morning peak.
Goodput is 52%; about half the requests time out at the client after 60 s. The
router shows both replicas healthy.

<details>
<summary>Clue — two scrapes of replica B's /metrics, 60 s apart</summary>

```plaintext
# 10:11:00
vllm:num_requests_running{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 10.0
vllm:num_requests_waiting{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 0.0
vllm:generation_tokens_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 1.8734112e+07
vllm:kv_cache_usage_perc{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 0.09
# 10:12:00
vllm:num_requests_running{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 10.0
vllm:num_requests_waiting{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 0.0
vllm:generation_tokens_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 1.8734112e+07
vllm:kv_cache_usage_perc{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 0.09
```

*Real format, illustrative values — metric names and labels from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`.*

</details>

<details>
<summary>Clue — replica B's engine log</summary>

```plaintext
(APIServer pid=2817) INFO 11-17 10:09:40 [loggers.py:335] Engine 000: Avg prompt throughput: 1650.2 tokens/s, Avg generation throughput: 187.4 tokens/s, Running: 9 reqs, Waiting: 0 reqs, GPU KV cache usage: 8.2%, Prefix cache hit rate: 25.8%
(APIServer pid=2817) INFO 11-17 10:09:50 [loggers.py:335] Engine 000: Avg prompt throughput: 220.0 tokens/s, Avg generation throughput: 19.6 tokens/s, Running: 10 reqs, Waiting: 0 reqs, GPU KV cache usage: 9.1%, Prefix cache hit rate: 25.7%
(APIServer pid=2817) INFO 11-17 10:10:00 [loggers.py:335] Engine 000: Avg prompt throughput: 0.0 tokens/s, Avg generation throughput: 0.0 tokens/s, Running: 10 reqs, Waiting: 0 reqs, GPU KV cache usage: 9.1%, Prefix cache hit rate: 25.7%
```

*Real format, illustrative values — line format from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`; nothing follows the last line.*

</details>

<details>
<summary>Clue — GPU telemetry (dcgm-exporter)</summary>

```plaintext
DCGM_FI_DEV_GPU_UTIL_RATIO{gpu="0",modelName="NVIDIA H100 80GB HBM3",Hostname="halden-gpu-01"} 1
DCGM_FI_DEV_GPU_UTIL_RATIO{gpu="1",modelName="NVIDIA H100 80GB HBM3",Hostname="halden-gpu-01"} 1
DCGM_FI_DEV_GPU_UTIL_RATIO{gpu="2",modelName="NVIDIA H100 80GB HBM3",Hostname="halden-gpu-01"} 1
DCGM_FI_PROF_TENSOR_UTIL_RATIO{gpu="0",…} 0.11
DCGM_FI_PROF_TENSOR_UTIL_RATIO{gpu="1",…} 0.11
DCGM_FI_PROF_TENSOR_UTIL_RATIO{gpu="2",…} 0
DCGM_FI_PROF_DRAM_UTIL_RATIO{gpu="0",…} 0.58
DCGM_FI_PROF_DRAM_UTIL_RATIO{gpu="1",…} 0.57
DCGM_FI_PROF_DRAM_UTIL_RATIO{gpu="2",…} 0
DCGM_FI_DEV_XID_ERROR{gpu="0",…} 45
DCGM_FI_DEV_XID_ERROR{gpu="1",…} 0
DCGM_FI_DEV_XID_ERROR{gpu="2",…} 0
```

*Real format, illustrative values — field names and types from dcgm-exporter 4.9.0 `etc/default-counters.csv`; labels trimmed.*

</details>

<details>
<summary>Clue — the kernel log</summary>

```plaintext
$ dmesg -T | grep -i xid
[Thu Nov 12 16:02:17 2026] NVRM: Xid (PCI:0000:18:00): 45, pid=…, …
[Tue Nov 17 10:09:41 2026] NVRM: Xid (PCI:0000:5a:00): 79, GPU has fallen off the bus.
```

*Real format, illustrative values — the Xid 79 line is NVIDIA's own example from its Xid catalog page; the Xid 45 line's fields are elided; GPU 0 is at 18:00, GPU 3 at 5a:00.*

</details>

<details>
<summary>Reveal answer</summary>

The scrapes say it first: 10 requests running, nothing generated in a minute. Not
overload — an overloaded engine produces tokens, slowly. The log agrees, with a
detail easy to misread: after one interval of zeros vLLM drops the stats line to
DEBUG, so the log goes *quiet*, like an idle engine. The kernel log names the cause: at 10:09:41, Xid
79 on 0000:5a:00 — GPU 3, rank 1 of replica B, fell off the bus. GPU 2, its
partner, reads 100% "utilisation" with no tensor or memory activity: a kernel
spinning in the all-reduce, waiting for a peer that will never answer. The Xid
45 on GPU 0 is last Thursday's rollout killing the old engine; the gauge has
held it since.

The expert's ranking: frozen counters → stuck engine, not load; stuck under TP →
a rank or the link between ranks; the kernel log → which. The 100% on GPU 2 and
the 45 on GPU 0 are the things *not* to chase; `Waiting: 0` only means new
requests never reached the scheduler. Pull B from the router now — waiting out the
300 s timeout costs ~225 more requests at 0.75 req/s — capture, and follow the
catalog: Xid 79 is "contact support". Rare on one node, routine across a fleet
([Kokolis et al., 2024](https://arxiv.org/abs/2410.21680) model failure rates at
cluster scale).

</details>

</div>

<div class="exercise">

**Incident 2 — Monday's slow first token.** Phase 2 is live. Monday 09:40:
TTFT p95 is 9 s and rising; TPOT is normal. No errors. Friday's peak was fine.

<details>
<summary>Clue — GPU telemetry</summary>

```plaintext
DCGM_FI_DEV_XID_ERROR{gpu="0",…} 0          (gpus 1-3: 0)
DCGM_FI_PROF_TENSOR_UTIL_RATIO{gpu="0",…} 0.41   (Friday 09:40: 0.19)
DCGM_FI_PROF_DRAM_UTIL_RATIO{gpu="0",…} 0.33     (Friday 09:40: 0.52)
DCGM_FI_DEV_GPU_TEMP_CELSIUS{gpu="0",…} 61
```

*Real format, illustrative values — field names from dcgm-exporter 4.9.0 `etc/default-counters.csv`; GPUs 1–3 alike.*

</details>

<details>
<summary>Clue — the change calendar</summary>

```plaintext
Fri 17:40  ask-halden-agent 2.4.0 deployed   "the model now sees the user's open tickets"
Sat 03:00  node kernel security update; reboot; both replicas restarted 03:06
```

*Real format, illustrative values — Ask Halden's deploy log, invented.*

</details>

<details>
<summary>Clue — replica A's engine log, Friday and Monday at 09:40</summary>

```plaintext
(APIServer pid=4410) INFO 11-13 09:40:10 [loggers.py:335] Engine 000: Avg prompt throughput: 5362.9 tokens/s, Avg generation throughput: 336.8 tokens/s, Running: 8 reqs, Waiting: 0 reqs, GPU KV cache usage: 14.2%, Prefix cache hit rate: 59.7%
(APIServer pid=1093) INFO 11-16 09:40:10 [loggers.py:335] Engine 000: Avg prompt throughput: 11183.6 tokens/s, Avg generation throughput: 171.2 tokens/s, Running: 21 reqs, Waiting: 52 reqs, GPU KV cache usage: 41.5%, Prefix cache hit rate: 3.2%
```

*Real format, illustrative values — line format from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`; prompt throughput counts computed (not cached) tokens.*

</details>

<details>
<summary>Clue — two consecutive calls of one agent session, as rendered</summary>

```plaintext
call 1: <|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nCutting Knowledge Date: December 2023\nToday Date: 26 Jul 2024\n\nUser j.berg (Warehouse Ops). Open tickets: WH-4411, WH-4418.\nYou are Ask Halden, …
call 2: <|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nCutting Knowledge Date: December 2023\nToday Date: 26 Jul 2024\n\nUser j.berg (Warehouse Ops). Open tickets: WH-4411, WH-4418, WH-4420.\nYou are Ask Halden, …
```

*Real format, illustrative values — header structure from Llama-3.3-70B-Instruct's chat template; content invented.*

</details>

<details>
<summary>Reveal answer</summary>

TTFT up, TPOT flat, no errors: saturation — requests wait for prefill. Prompt
throughput sits near ~11.3K tokens/s, the replica's prefill ceiling, with 52
waiting. Same traffic as Friday, twice the prefill: the hit rate fell from ~60% to
3%. The GPUs are healthy and *busier* — a consequence. The Saturday reboot emptied the
caches, which refill in minutes: the red herring. The cause
is in the rendered calls: release 2.4 put the user's ticket list at the top of the
system message. It differs between users, so the 3,000-token shared preamble never
matches, and it changes after every tool call that files a ticket, so each
session's own history misses too ([The Agentic Era](#/agentic-serving)'s Exercise 2
breaks the same cache with a timestamp and a `set`). From the case: uncached,
the agent and Q&A traffic need ~25.7K computed tokens/s against ~22.6K the two
replicas can do — 114%, a queue that grows all morning. It waited for Monday
because the weekend had no peak. Roll back 2.4, or move the ticket list after the
preamble and history; the hit rate recovers within minutes.

</details>

</div>

<div class="exercise">

**Incident 3 — answers that stop mid-sentence.** Phase 2, Thursday, after
Wednesday evening's upgrade to vLLM v0.34.0. Q&A users report long, wandering
answers, some cut off mid-word. The client sends `max_tokens: 400` and no sampling parameters. TTFT
p95 0.41 s, TPOT p95 25 ms, goodput 99%.

<details>
<summary>Clue — the launch line, before and after</summary>

```diff
 vllm serve RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
   --tensor-parallel-size 2 --kv-cache-dtype fp8 \
-  --gpu-memory-utilization 0.90 \
+  --generation-config vllm \
   --max-num-batched-tokens 512
```

*Real format, illustrative values — flags from vLLM v0.34.0 `vllm/engine/arg_utils.py`; the "after" line was copied from a recipe.*

</details>

<details>
<summary>Clue — one hour of /metrics, before and after</summary>

```plaintext
                                                          Wed 10-11   Thu 10-11
Δ vllm:request_success_total{finished_reason="stop"}         2690        2512
Δ vllm:request_success_total{finished_reason="length"}         14         188
Δ vllm:request_generation_tokens_sum / _count                 252         318
```

*Real format, illustrative values — metric names and the `finished_reason` label from vLLM v0.34.0 `vllm/v1/metrics/loggers.py`.*

</details>

<details>
<summary>Clue — the startup logs</summary>

```plaintext
v0.33 (Wed): WARNING … [model.py:1931] Default vLLM sampling parameters have been overridden by the model's `generation_config.json`: `{'temperature': 0.6, 'top_p': 0.9}`. If this is not intended, please relaunch vLLM instance with `--generation-config vllm`.
v0.33 (Wed): INFO … Available KV cache memory: 30.73 GiB
v0.34 (Thu): INFO … Available KV cache memory: 37.95 GiB
```

*Real format, illustrative values — message texts from vLLM v0.34.0 `vllm/config/model.py` and `vllm/v1/worker/gpu_worker.py`; the v0.34 log has no sampling warning.*

</details>

<details>
<summary>Reveal answer</summary>

Latency is fine, so the layer is model output. Length-limited finishes went from
0.5% to 7%; mean output from 252 to 318 tokens. Is the stop token broken? No —
93% of answers still end on `stop`, and even with `--generation-config vllm`, vLLM
still reads the model's end-of-sequence IDs. What that flag drops is the sampling
defaults: the v0.33 log shows them in force (temperature 0.6, top-p 0.9); the
v0.34 log does not. A client that sends no sampling parameters now samples at
temperature 1 with the whole tail — more wandering, more answers that hit the 400
cap mid-sentence. The bigger KV pool is the other line of the diff: the explicit
0.90 is gone, so v0.34's extensible KV cache sizes the pool from free memory. That
change is real and harmless here — a red herring. Fix: restore the line, or set
sampling parameters in the client; treat launch line, engine, model revision,
template and generation config as one release.

</details>

</div>

## What should exist before

> [!predict] Before you read on
> One of the node's four GPUs dies for good. With FP8 on two TP=2 replicas, how
> many GPUs keep serving: three, two or none? Under the BF16 fallback on one TP=4
> replica?

> [!case] The case: one node, no spare
> Two, and none. Ask Halden runs on one node, so there is no hardware redundancy —
> the stake — and what survives depends on [Quantization](#/quantization)'s
> decision. With FP8, a GPU fault takes down its replica and the other
> carries the load: in phase 1 that is fine — one replica holds 1.5 req/s at TTFT
> p95 ≈ 0.46 s ([Load Testing](#/load-testing)). The orphaned healthy GPU cannot
> help: 70 GB of FP8 weights do not fit a 72 GB budget with any overhead. Under the
> BF16 fallback (one TP=4 replica) *any* GPU fault is a full outage — BF16 does not
> fit two GPUs, and TP=3 is impossible (64 heads are not divisible by 3).
>
> **Runbook, GPU fault.** Capture; remove the replica from the router; look up
> the Xid's catalog action. Phase 1: serve on the survivor. Phase 2: the survivor
> needs ~75 GB of KV at a p95 peak against a 66 GB pool (the host tier,
> `--kv-offloading-size 128`, holds the rest) and, with parked sessions evicted,
> ~19.7K tokens/s of prefill against ~11.3K — degraded mode: queue agent requests at the gateway before Q&A is shed.
> Book the repair outside 09:00–11:00: it takes the whole node.
>
> **Hung replica.** Alert on liveness (running > 0, zero generation for 60 s), not
> `/health`. Pull it, capture, restart — a cold start of minutes with one replica
> serving; read the watchdog's stack dumps.
>
> **Bad rollout.** Roll back the whole release unit, and diff the startup logs.
>
> **The postmortem**, five lines, incident 2 filled in:
>
> ```plaintext
> Impact     Mon 09:05-10:31: TTFT p95 above 1.5 s for most requests; goodput 98% -> 61%. No errors, no data loss.
> Trigger    ask-halden-agent 2.4.0 (Fri 17:40) put the user's open-ticket list at the top of the system message.
> Cause      Prefix hit rate 60% -> 3%; prefill demand ~25.7K tok/s vs ~22.6K capacity (114%); queue grew all morning.
> Detection  Hit-rate alert at 09:21; template diff found at 10:05; rolled back 10:31. Nothing tested the prompt.
> Actions    CI renders the preamble twice and asserts identical bytes; prompt-changing releases canaried through a peak.
> ```
>
> *Real format, illustrative values — a five-line postmortem for an invented incident.*

**Security.** `vllm serve` authenticates
nobody unless started with `--api-key` (or `VLLM_API_KEY`), and even then its
middleware guards only paths under `/v1`, `/v2`, `/inference` and `/cohere` —
`/metrics`, `/health` and any development endpoints stay open (v0.34.0,
`vllm/entrypoints/serve/middleware/authenticate.py`). Keep the port behind the gateway. The prefix cache is also a timing
channel: a hit returns the first token faster, so a request can test whether
someone recently sent the same prefix. Gu et al. [detected global cache
sharing across users in seven API providers](https://arxiv.org/abs/2502.07776) by
timing alone. vLLM's per-request `cache_salt` separates caches between groups that
must not share ([PagedAttention & Prefix Caching](#/paged-kv-cache)); for Ask
Halden, departments whose documents have different readers.

## Exercises

<div class="exercise">

**Exercise 4 — transfer.** An 8-GPU node serves a large MoE model with data and
expert parallelism in vLLM v0.34, `--enable-fault-tolerance` on. GPU 5 logs Xid 94.
What does the catalog say, what can the engine do that Ask Halden's TP replicas
cannot, and what do you still owe the GPU?

<details>
<summary>Reveal answer</summary>

Xid 94 is a contained memory error: the application that hit it must restart;
other applications are unaffected; reset the GPU "when convenient". With fault
tolerance on, v0.34 removes the dead data-parallel rank and redistributes its
experts without a restart, so the node serves on seven GPUs; Ask Halden's TP
replica simply dies. You still owe the GPU an off-peak reset and a row-remap check
before it rejoins.

</details>

</div>

<div class="exercise">

**Exercise 5 — find the flaw.** A postmortem, with its own appendix:

```plaintext
Impact     Thu 10:00-12:00: TPOT p95 41 ms -> 58 ms on replica B; near the 60 ms promise.
Trigger    vLLM v0.33 -> v0.34 upgrade on both replicas, Wed evening.
Cause      v0.34 regression: release notes report "TPOT +6–18% on some H200 models at concurrency 128".
Detection  User complaints at 10:40.
Actions    Rolled back to v0.33 on both replicas (12:10). Pin v0.33 until upstream fix.

Appendix   replica A TPOT p95 (v0.34): 40 ms all morning
           replica B nvidia-smi -q, GPU 2:  HW Thermal Slowdown : Active   GPU Current Temp : 87 C
           launch line, both replicas: --gpu-memory-utilization 0.90 (unchanged)
           rollback at 12:10; replica B TPOT p95 after rollback: 57 ms
```

*Real format, illustrative values — the release-note quote is verbatim from vLLM v0.34.0's release notes; the rest is invented.*

Which layer did the authors blame, which layer was it, and which three appendix
lines prove it?

<details>
<summary>Reveal answer</summary>

They blamed the engine; it was hardware. Replica A runs the same v0.34 and is
unchanged at 40 ms — a version regression would hit both. GPU 2 on replica B is in
`HW Thermal Slowdown` at 87 °C, which cuts clocks by half or more, and one slow
rank sets the pace of every all-reduce. The rollback did not help (57 ms). The
quoted regression does not apply either: the release notes tie it to v0.34's
extensible KV cache and give `--gpu-memory-utilization 0.9` as the opt-out —
which both replicas set. Action: drain B, have the cooling checked.

</details>

</div>

## What to remember

- Go from the symptom to the USE row that moved, then to the layer; open the
  layer's tools last. Capture before restarting — two scrapes, the kernel log,
  `nvidia-smi -q`, the engine log.
- An Xid line names the GPU by PCI address and the event by number; NVIDIA's
  catalog gives the action. 43 and 45 are routine; 79, 48, 95 and 119/120 are
  not; a pending row remap is a reset to schedule.
- `/health` in vLLM v0.34 reports a dead engine, not a stuck one: a TP replica
  stalled in an all-reduce answers 200 until a 300 s timeout. Alert on progress.
- GPU "utilisation" of 100% fits a spinning kernel; DCGM's Xid gauge holds the
  last Xid forever.
- Output failures — wrong stop tokens, lost sampling defaults, parser mismatches —
  leave latency green; watch `finished_reason` shares and diff the release unit.
- One node is one failure domain: FP8 on two replicas survives a GPU fault in
  phase 1; the BF16 fallback does not survive any.

```quiz
[
  {
    "q": "A node's dcgm-exporter shows DCGM_FI_DEV_XID_ERROR = 63 on one GPU for a week, and nvidia-smi -q reports Remapped Rows → Pending: Yes. The engine is serving normally. What does NVIDIA's catalog say to do?",
    "choices": [
      "Nothing, since the GPU is still serving and Xid 63 only reports a corrected error",
      "Reset the GPU at the next opportunity, so the pending row remapping takes effect",
      "Stop the engine at once and contact support, because remapping has failed",
      "Restart the application now; the remap applies when a new CUDA context opens"
    ],
    "answer": 1,
    "explain": "Xid 63 is a row-remapping event and its catalog action is RESET_GPU_DEFERRED: reset when the workload allows. A pending remap only takes effect after a GPU reset, so restarting the application is not enough. Remapping failure is Xid 64 and 'Remapping Failure Occurred: Yes', which this GPU does not show."
  },
  {
    "q": "A TP=8 replica on vLLM v0.34 with default settings stops producing tokens; all eight worker processes are still alive. How long until vLLM itself declares the engine dead and /health returns 503?",
    "choices": [
      "Immediately, since /health runs a test forward pass through all eight GPUs",
      "About 10 s, the default interval of the periodic stats logger",
      "About 300 s, when the execute_model call reaches its default timeout",
      "Never, because only a worker process exiting can mark the engine dead"
    ],
    "answer": 2,
    "explain": "The /health route only checks whether the engine has been marked dead. With processes alive the worker monitor sees nothing; the executor waits for execute_model, whose timeout VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS defaults to 300 s when TP > 1. The 10 s interval governs the stats line, which in fact goes quiet after one idle interval."
  },
  {
    "q": "A gateway retries any request that has not completed in 20 s, up to three times. During a slowdown at 1.2 req/s of organic traffic, every request exceeds 20 s. Roughly what arrival rate does the engine now see, and what limits the damage?",
    "choices": [
      "1.2 req/s, since retries replace the original attempts rather than adding to them",
      "Up to 4.8 req/s; disconnects abort abandoned attempts, but their prefill is spent",
      "Up to 3.6 req/s, as the first attempt is always discarded before the retries begin",
      "Up to 4.8 req/s, and nothing limits it, as the engine finishes every attempt"
    ],
    "answer": 1,
    "explain": "Each request can arrive four times (one try plus three retries): 1.2 × 4 = 4.8 req/s offered. vLLM aborts a request whose client disconnects, so abandoned attempts stop decoding — but their prefill has already been paid, at the moment prefill is the scarce resource. The fix is a retry budget with backoff."
  },
  {
    "q": "After switching Ask Halden to a different model family, 40% of answers end with finish_reason=\"length\" at max_tokens, and their last tokens repeat the chat template's assistant header. Latency is normal. Which layer and which first check?",
    "choices": [
      "Hardware: run nvidia-smi -q on every GPU and look for ECC errors",
      "Engine: the KV pool is too small, so answers are truncated by preemption",
      "Client: max_tokens is too low for the new model's longer answers",
      "Model output: the stop tokens or template do not match the new model"
    ],
    "answer": 3,
    "explain": "Answers that run past their natural end and print template text are the model continuing after the point where it would have stopped: the engine is not recognising the new model's end-of-turn token, or the template does not match. Check the model's generation_config eos_token_id and the chat template the engine uses. A low max_tokens would cut answers without template text appearing; preemption delays requests, it does not truncate them."
  }
]
```
