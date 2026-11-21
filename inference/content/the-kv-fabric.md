# The KV Fabric

> **The question:** once KV caches can leave the GPU, where should they live, how
> are they found and moved, and which machine should serve a request whose cache
> is already somewhere?
>
> **You'll be able to:** decide with one inequality whether restoring a cache from
> a slower tier beats recomputing it, and size that tier; configure a host-memory
> KV tier in vLLM and tell its hits from local ones in the metrics; predict how a
> cache-aware router behaves when its picture of the replicas is stale or the
> traffic shares one prefix; choose the signals a fleet scales and sheds load on.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="router,kv,fabric"></div>

An Ask Halden agent files a ticket in four model calls. Between the second and
the third it waits about twenty seconds for the ticketing system; the third call's
first 9,000 tokens are the second call's prompt. If their keys and values are still
in HBM, the engine prefills only the new tool result. If they were evicted, a 70B on
two GPUs spends ~0.5 s recomputing the 6,000 that are not the shared preamble. If
they were copied to host memory first, PCIe brings them back in 10–20 ms. This chapter is about those three
outcomes, on one node and across a fleet.

## What a "parked session" really is

An engine has no notion of a session. When an agent's model call ends with a tool
call, that request is *finished*. Its blocks go back to the free queue, still
carrying their prefix hashes; they are reusable until something needs the space,
and [PagedAttention](#/paged-kv-cache) evicts them least-recently-released first.
The agent's next call is a new request. It hits the prefix cache for as many
blocks as survived from the start of the chain, and since a request's blocks are
freed tail-first, eviction eats a session's history from its newest end.

So "keeping a session warm" is a statement about eviction pressure. Under
pressure, a session parked in a 20 s tool wait holds some of the oldest released
blocks, and they go first.

> [!bridge] From the Linux course
> Finished-but-cached KV blocks are clean pages on the inactive list: reclaimable,
> reusable until reclaimed. What differs is the cost of reclaim. A clean page is read
> back from its file; a KV block has no backing file unless you add a tier, and
> without one the way back is recomputation, which has no analogue for a page. The
> tiers below HBM are an optional swap; "recompute" is the floor under all of them.
> [→ Linux: Virtual Memory](../#/memory)

## Tiering, and the crossover rule

```text
   HBM        hot    running sequences, fresh prefixes        fastest, smallest
   CPU DRAM   warm   evicted prefixes, parked sessions        one PCIe hop
   NVMe SSD   cold   long-tail prefixes                       large, cheap
   recompute  gone   not stored: pay prefill again            last resort
```

> [!predict] Before you read on
> A 128K-token Llama-3.3-70B context (43 GB of BF16 KV) sits in host memory on the
> case's four-GPU node. Each GPU pulls its quarter over its own PCIe Gen5 link at
> ~50 GB/s achieved; prefill runs at the case's 1.58 × 10¹⁵ FLOP/s. Restore or
> recompute — which wins, and by roughly how much: 2×, 10× or 100×?

Restore, by about a hundred. Each GPU moves 10.7 GB at ~50 GB/s: **~0.2 s**
(x16 Gen5 is ~63 GB/s per direction on paper; check for shared uplinks with
`nvidia-smi topo -m` and measure with `nvbandwidth`).
Recompute pays the linear work, `2 × 70e9 × 131,072 ≈ 1.8 × 10¹⁶` FLOPs, *and*
attention's quadratic work, which at 128K is larger: `2 × T² × d × layers =
2 × 131,072² × 8,192 × 80 ≈ 2.3 × 10¹⁶`. Together ≈ 4.1 × 10¹⁶ FLOPs ≈ **26 s** —
during which the node prefills nothing else.

Drop attention's term and both costs grow linearly with tokens, so **context length
cancels** and a rule falls out, per token and for the same set of GPUs:

```text
   restore wins  ⟺  kv_bytes_per_token ÷ tier_bandwidth  <  2·P ÷ achieved FLOP/s
```

A 70B token costs 140 GFLOP, which the four GPUs share at 396 TFLOP/s each (the
case's 40% MFU): 88 µs. In that time each GPU must restore its quarter of the
token's 328 KB, 82 KB: the tie is **~0.93 GB/s per GPU**. Host memory over PCIe
beats recomputing by ~50×; a Gen4 NVMe drive (~7 GB/s sequential on its spec sheet)
by ~7× if each GPU has its own, ~2× if four share one; a 10 Gb/s network link
shared by four GPUs (0.3 GB/s each) loses. For Llama-3-8B on one H100 —
`2 × 32 × 8 × 128 × 2 = 131 KB` per token against `2 × 8.03e9 ÷ 396e12 ≈ 41 µs` —
the tie is **~3.2 GB/s**: NVMe wins by ~2×, a network tier loses. Small models are
cheap to recompute; tiers pay most for large ones. The rule is conservative:
attention's extra work only favours restoring, and vLLM's connector copies by DMA
alongside computation, so part of a transfer hides. What works against restore is
a shared link — offload writes, other restores and NIC traffic on the same PCIe.

> [!trap] A prefix the router believes is cached may be gone
> A router can report that 99% of requests had a reusable prefix somewhere while
> delivering little: it believed the prefixes were cached, but the replica had
> evicted the blocks and recomputed them. A lower tier keeps some of them. Count
> prefill tokens actually skipped, per token; the metrics below count them by source.

In the simulator, choose the agent workload with prefix caching on and drag the KV
pool down: the prefix is as shared as before, but once blocks are evicted, TTFT
climbs back toward its uncached value.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

## A host-memory tier in vLLM

In vLLM v0.34 the second tier is two flags. `--kv-offloading-size` is the host
buffer in GiB, **summed across the tensor-parallel ranks**; `--kv-offloading-backend`
is `native` (vLLM's own CPU offloading, the default) or `lmcache`:

```bash
vllm serve RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
  --tensor-parallel-size 2  --kv-cache-dtype fp8 \
  --gpu-memory-utilization 0.90  --max-num-batched-tokens 512 \
  --kv-offloading-size 128  --kv-offloading-backend native \
  --kv-cache-metrics
```

*Real format, illustrative values — flags from vLLM v0.34.0 `vllm/engine/arg_utils.py`
and `vllm/config/cache.py`; the size is the case's choice (below), not a tested
configuration.*

The flags are shorthand. With `native`, vLLM writes `--kv-transfer-config` for
you: the `OffloadingConnector`, role `kv_both`, `cpu_bytes_to_use = size × 2³⁰`
(`vllm/config/vllm.py`). With `lmcache` it selects the LMCache connector and does
*not* pass the size on; the LMCache server sets capacity. The connector copies each
completed block to pinned host memory as soon as it exists and promotes host hits
back to the GPU on demand.

Hence the sizing rule vLLM's offloading guide states outright: make the host tier
**larger than the GPU pool**. Copies are immediate, so a smaller host tier holds
only blocks HBM still has and adds no hits. Halden's FP8 replica has a 66 GB pool;
128 GiB (~137 GB) is about twice it.

Below host memory, v0.26–v0.28 added secondary tiers: `"spec_name":
"TieringOffloadingSpec"` with a `secondary_tiers` list of `fs` (local NVMe or a
shared mount), `obj` (an S3-compatible store, through NIXL) or `p2p` (other vLLM
instances' host tiers over RDMA). Everything below the CPU tier is staged through
it, and each tier is one more row of the inequality.

The metrics separate the tiers. One replica, restarted at 09:00 and scraped at
09:05 at the phase-2 peak, so each counter covers five minutes; the three
`prompt_tokens_by_source` lines sum to every prompt token it received:

```plaintext
vllm:prefix_cache_queries_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 3.975e+06
vllm:prefix_cache_hits_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 2.25e+06
vllm:external_prefix_cache_queries_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 1.725e+06
vllm:external_prefix_cache_hits_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0"} 120000.0
vllm:prompt_tokens_by_source_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",source="local_compute"} 1.605e+06
vllm:prompt_tokens_by_source_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",source="local_cache_hit"} 2.25e+06
vllm:prompt_tokens_by_source_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",source="external_kv_transfer"} 120000.0
vllm:prompt_tokens_cached_by_source_total{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic",engine="0",source="host"} 120000.0
```

*Real format, illustrative values — names and labels from vLLM v0.34.0
`vllm/v1/metrics/loggers.py`, `stats.py` and `cache_hit_source.py`; values computed
from the case's phase-2 peak (13,250 prompt tokens/s per replica, 5,350 prefilled,
over 300 s), with an assumed device/host split; not measured.*

Prefill skipped: `(2.25M + 0.12M) ÷ 3.975M` ≈ 60%, the case's cached regime. The
line you would misread is the external hit rate, `120,000 ÷ 1.725M` ≈ 7%. External
queries ask only for tokens HBM lacked, mostly new tool results no tier has seen;
at 46% occupancy little is evicted, so the host tier supplies 3%. It earns its keep
under pressure, and `vllm:kv_block_idle_before_evict_seconds` (with
`--kv-cache-metrics`) shows when: blocks evicted after less idle time than your
tool waits mean sessions are losing their history.

## A fleet-wide KV pool

Across a fleet, the spare DRAM and SSD next to every GPU add up to far more than
all the HBM. **Mooncake**, behind Moonshot AI's Kimi, is built around that pool: a
KV store over the fleet's DRAM and SSD, reachable by RDMA, and a scheduler that
rejects a request early when it predicts a missed latency target. Its FAST 2025
paper (best paper award) reports 59–498% more request capacity than baselines on
real traces within SLOs.

The general form is a **global KV store** keyed by chained prefix hash: any replica
can ask "does anyone hold this prefix?", decoupling who computes, stores and serves
it. A *missing* block is never a correctness problem; a *wrong* one is, so the key
must cover everything that shapes the KV — vLLM's block hash includes the LoRA
adapter and `cache_salt`; stores namespace by model, dtype and layout. KV is
layout-specific: an FP8 block is useless to a BF16 replica, and a TP=2 block is laid
out differently from a TP=4 one (vLLM's opt-in `canonical_layout` lets different TP
sizes share).

Moving blocks is its own problem: GPU to GPU without staging through host RAM,
without stalling compute, as a gather/scatter of many small blocks, over RDMA,
NVLink, NVMe-oF (NVMe commands over a network fabric) or TCP. **NIXL** (NVIDIA's
inference transfer library) and Mooncake's open-source Transfer Engine give one
non-blocking, zero-copy API over all of them — the NIC reads and writes GPU memory
directly.

## Routing is cache management

A classic load balancer treats replicas as interchangeable. For LLM serving that
throws caches away: send a request whose prefix is cached on replica A to replica
B, and B recomputes it.

> [!predict] Before you read on
> A router always sends each request to the replica holding the longest matching
> prefix. Every request starts with the same 2,000-token system prompt. What happens
> to load across replicas?

It concentrates on whichever replica first cached the shared prompt — the popular
prefix is popular for everyone. Least-connections, power-of-two choices and
consistent hashing all assume interchangeable replicas; affinity breaks that. Real
routers blend the two, as SGLang's model gateway does:

```text
select_worker(request_text):
    loads = in-flight requests per healthy worker
    if max(loads) - min(loads) > balance_abs_threshold        # default 32
       and max(loads) > min(loads) * balance_rel_threshold:   # default 1.1
        w = random choice among least-loaded workers          # imbalanced
    else:
        m = tree.prefix_match(request_text)   # approximate radix tree, characters
        if m.matched_chars / len(request_text) > cache_threshold:   # default 0.5
            w = m.worker                                       # cache hit path
        else:
            w = random choice among least-loaded workers
    tree.insert(request_text, w)          # assume w now caches this text
    return w
```

*Pseudocode condensed from SGLang v0.5.23, `sgl-model-gateway/src/policies/cache_aware.rs`
(`select_worker`; defaults in `policies/mod.rs`). The file's header comment says a low
match goes to the smallest tree; the code picks the least loaded.*

Affinity holds only while the fleet is balanced: the prediction's hotspot is capped
at about 32 requests of imbalance, after which requests spill to idle replicas,
which then cache the prompt themselves. And the tree is **the router's guess**,
built from its own decisions, never told what engines evicted, trimmed by its own
LRU (every 30 s, 10,000 nodes per tree). After a replica evicts a prefix or
restarts empty, the router keeps sending that prefix there, believing it cached,
and the replica recomputes it.

The alternative is to be told. vLLM publishes `BlockStored` and `BlockRemoved`
events over ZeroMQ (`--kv-events-config`); an indexer subscribed to every replica
knows what each holds — llm-d's *precise* prefix-cache routing, and Dynamo's
router. Exact is not instantaneous: until the first request's events arrive, an
identical second one sees nothing (llm-d adds a speculative index entry at routing
time), and a publisher past its high-water mark (100,000 events) drops events.
Either way a stale view costs a recompute, never a wrong answer.

## The gateway: one queue for the fleet

On Kubernetes the routing layer has a standard shape. The **Gateway API
Inference Extension** (GAIE) defines an `InferencePool` — the model-server pods of
one model — and an **Endpoint Picker** (EPP) that the gateway's Envoy proxy
consults for every request through its external-processing hook. The EPP scores
pods on what it scrapes from them (queue, KV usage, prefix affinity) and returns
one. Since GAIE v1.6.0 (August 2026) the project keeps the CRDs and conformance
tests; the full EPP lives in llm-d.

The gateway is also where multi-tenancy belongs. An engine sees one replica, and its
`priority` knows nothing about tenants ([Continuous Batching](#/continuous-batching)).
A request dispatched to an engine is committed to that replica; a request held at
the gateway costs nothing and can still go anywhere. llm-d v1.0.0 (October 2026)
builds on that: when its saturation detector (queue depth, KV use across the pool)
says the pool is full, the EPP stops dispatching and queues by priority band, then
by tenant within a band, then by an ordering policy such as earliest deadline.
Negative priorities are sheddable: their bands are capped and overflow gets HTTP 429
instead of slowing everyone. Dynamo v1.6's deadline-ordered policy queue is the same
idea. The tenant header must come from your auth layer, never from the client.

A prefix cache shared across tenants is also a timing side channel: a hit is
measurably faster, so one tenant can probe what another sent. The mitigation is
per-tenant `cache_salt` ([PagedAttention & Prefix Caching](#/paged-kv-cache));
salted prefixes never match, so cache-aware routing does not undo it.

## Autoscaling a stateful fleet

Four instincts from stateless services fail here.

- **GPU utilisation is not a signal.** Continuous batching keeps kernels launching
  whenever anything runs, so a comfortable replica and a drowning one both read near
  100%. Scale on demand: requests running and waiting, TTFT.
- **Scaling down destroys state:** a retired replica takes its warm cache with it.
- **Cold starts take minutes** ([Operating It](#/operating-it)); keep headroom.
- **Disaggregated pools scale separately:** longer outputs add decode load only.

A queue-demand rule, as a KEDA object over replicas of one model:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: llama70b-replicas
spec:
  scaleTargetRef:
    name: llama70b-vllm               # a Deployment, one replica per pod
  minReplicaCount: 2
  maxReplicaCount: 8
  cooldownPeriod: 600
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 900
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      query: >-
        sum(vllm:num_requests_running{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic"})
        + sum(vllm:num_requests_waiting{model_name="RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic"})
      threshold: '20'
```

*Real format, illustrative values — fields from the KEDA 2.21 ScaledObject
specification and Prometheus scaler docs (KEDA v2.21.1); metric names from vLLM
v0.34.0 `loggers.py`; thresholds from the case, not tuned.*

The default metric type, `AverageValue`, divides the query by the threshold: 70
requests running or waiting → `ceil(70 ÷ 20)` = 4 replicas. The threshold is what
one replica serves within its SLOs — the case's plan of 20, until a load test
replaces it. Scaling on `num_requests_waiting` alone flaps: the queue is zero
whenever replicas keep up, so the desired count collapses to the minimum the moment
it drains. The long scale-down window is the stateful part: every pod removed is a
cache thrown away.

> **State of play (November 2026):** NVIDIA Dynamo is at v1.6.2 (1.0 shipped in
> March 2026); v1.5 deprecated its KV block manager (removal targeted for v1.7) in
> favour of the engines' own offloading, with KV indexing moving into Dynamo Router.
> llm-d reached v1.0.0 on 20 October 2026, on vLLM v0.31; GAIE is at v1.6.2. Vendor
> speedups for these stacks are ceilings; the inequality tells you what your
> hardware can do.

> [!dashboard] The KV tiers
> **Utilisation:** `vllm:kv_cache_usage_perc` (HBM); host tier size in the labels of
> `vllm:kv_offload_config_info`. **Saturation:** `vllm:kv_block_idle_before_evict_seconds`
> (with `--kv-cache-metrics`) below your tool-wait times;
> `vllm:prompt_tokens_by_source_total{source="local_compute"}` rising as a share.
> **Errors:** none — a lost block is silently recomputed; derive it from
> `vllm:prompt_tokens_cached_by_source_total` by `source` against the share you expect.

> [!case] The case: phase 2 gets a second tier
> Phase 2 ([The Agentic Era](#/agentic-serving) counts its tokens) adds 0.5 agent requests/s at the peak, each a
> session of four calls and three tool waits, ~80 s end to end: by Little's law
> **~40 sessions** open at once, contexts averaging ~11K tokens of which 3K is the
> shared preamble, stored once per replica. A session's ~8K unique tokens are 1.3 GB
> in FP8 KV; with the Q&A traffic, the node holds **~61 GB of its 132 GB** (46%).
> Between calls, those 1.3 GB are evictable prefix-cache blocks, nothing more.
>
> - **Steady state:** at 46% little is evicted, so a host tier would supply almost
>   nothing. On this evidence alone, offload is not needed.
> - **One replica down:** the survivor holds ~61 GB against its 66 GB pool. The
>   oldest released blocks — sessions in a tool wait — go first, and each resumed
>   call recomputes ~8K tokens (`8,000 × 0.089 ms` ≈ **0.7 s**) instead of
>   restoring 1.3 GB over PCIe (**~13–26 ms**, two links or one). The survivor
>   prefills ~11K tokens/s (`1.58e15 ÷ 1.4e11`); if every parked session is
>   evicted, demand is `0.5 × (47K − 4 × 3K) + 2.2K` ≈ 20K.
>
> **What this settles:** each replica runs with `--kv-offloading-size 128`: 256 GiB
> of pinned host memory on the node, each tier larger than its 66 GB pool. Check
> the RAM first (`free -g`; GCP's 4-GPU a3-highgpu-4g has 936 GB) and leave room for
> the OS and the weights' page cache. It is insurance bought with memory the node
> already pays for. Session routing, already in place, keeps restores local; a
> fleet-wide pool and a gateway solve problems two replicas do not have.

## Exercises

<div class="exercise">

**Exercise 1.** A 30B dense model has 196 KB of KV per token in BF16 and achieves
~500 TFLOP/s in prefill on one GPU. At what tier bandwidth do restore and recompute
tie? Should a remote object store at ~1 GB/s be used as a tier? And if the same
model ran with an FP8 KV cache, how would the answer move?

<details>
<summary>Reveal answer</summary>

Recompute per token: `2 × 30e9 ÷ 5 × 10¹⁴ = 0.12 ms`. Tie: `196 KB ÷ 0.12 ms ≈
1.6 GB/s`. A 1 GB/s store loses to recomputing — skip it. With FP8 KV the bytes per
token halve (98 KB) and so does the tie (~0.8 GB/s): the same store now wins,
narrowly. Smaller KV makes every tier more useful.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team enables offloading on a 70B replica whose
startup log reported a 130 GB KV pool (BF16, TP=4) and launches with
`--kv-offloading-size 64`. A week later, during a peak with heavy eviction, they
compare two scrapes ten minutes apart:

```plaintext
# 14:00
vllm:prompt_tokens_by_source_total{model_name="m",engine="0",source="local_compute"} 9.12e+08
vllm:prompt_tokens_by_source_total{model_name="m",engine="0",source="local_cache_hit"} 1.371e+09
vllm:prompt_tokens_by_source_total{model_name="m",engine="0",source="external_kv_transfer"} 2.1e+06
# 14:10
vllm:prompt_tokens_by_source_total{model_name="m",engine="0",source="local_compute"} 9.33e+08
vllm:prompt_tokens_by_source_total{model_name="m",engine="0",source="local_cache_hit"} 1.3814e+09
vllm:prompt_tokens_by_source_total{model_name="m",engine="0",source="external_kv_transfer"} 2.1e+06
```

*Real format, illustrative values — metric name and `source` labels from vLLM v0.34.0
`loggers.py` and `stats.py`; model label shortened; values invented for the exercise.*

What fraction of prompt tokens did the host tier supply in those ten minutes, why,
and what do you change?

<details>
<summary>Reveal answer</summary>

Deltas: computed 21M, local hits 10.4M, external 0. The host tier supplied nothing
during the peak it was bought for, while 67% of prompt tokens were recomputed.
64 GiB is about half the 130 GB pool, and since the connector copies blocks as soon
as they complete, a host tier smaller than HBM holds only blocks the GPU still has.
Set it well above the pool (256–384 GiB if the host has the RAM), then check that
`external_kv_transfer` grows when `local_compute` does.

</details>

</div>

<div class="exercise">

**Exercise 3 — diagnosis.** A team autoscales LLM replicas on average GPU utilisation
with a target of 70%. During a traffic surge the autoscaler never adds replicas,
while TTFT p95 climbs from 0.6 s to 9 s and `vllm:num_requests_waiting` goes from 0
to 140 summed over six replicas. Explain, and say what the trigger should be and
how many replicas it would ask for at the peak if one replica serves 20 requests in
flight.

<details>
<summary>Reveal answer</summary>

Continuous batching keeps utilisation near 100% whether the server is comfortable
or drowning; the metric saturated before the surge and says nothing about it.
Demand does: running plus waiting. Six replicas at 20 running (120) plus 140
waiting is 260 → `ceil(260 ÷ 20)` = 13 replicas. Start earlier than for a
stateless service; a new replica takes minutes.

</details>

</div>

<div class="exercise">

**Exercise 4 — transfer: find the flaws.** A memo for a service on single-GPU H100
replicas of an 8B model (131 KB of KV per token, a 40 GB KV pool each):

> "Restore beats recompute above ~1 GB/s, so we will put the KV tier on the shared
> NFS mount (~1 GB/s per client). Each replica gets a 20 GiB host tier for parked
> sessions. Routing uses the SGLang gateway in cache-aware mode, so a replica restart
> costs nothing: the router knows where every prefix is."

Find three errors.

<details>
<summary>Reveal answer</summary>

1. The ~1 GB/s tie is the 70B's. For an 8B on one H100 it is
   `131 KB ÷ (2 × 8e9 ÷ 396e12)` ≈ 3.2 GB/s: the NFS tier is three times too slow
   and loses to recomputing.
2. A 20 GiB host tier is smaller than the 40 GB pool; vLLM's offload copies blocks
   as they complete, so such a tier mirrors what HBM already has and adds no hits.
3. The gateway's tree is approximate, built from its own decisions and never told
   about evictions or restarts. After a restart it keeps sending prefixes to a
   replica that holds none of them until the tree ages out. Exact KV events fix it.

</details>

</div>

## What to remember

- Between calls, a "session" is evictable prefix-cache blocks, the oldest released
  going first under pressure.
- Restore beats recompute when `kv_bytes_per_token ÷ bandwidth < 2·P ÷ achieved
  FLOP/s` on the same GPUs: ~0.9 GB/s per GPU for a 70B, ~3.2 GB/s for an 8B.
- In vLLM v0.34, `--kv-offloading-size` (GiB, summed over TP ranks) adds a host
  tier that must exceed the GPU pool; `prompt_tokens_by_source` shows what each
  tier supplied.
- Cache-aware routers trade affinity against load; an approximate tree goes stale
  on eviction and restart, exact KV events lag by one decision.
- Fairness and shedding belong at the gateway, before a request is committed to a
  replica. Scale on demand, never on GPU utilisation.

```quiz
[
  {
    "q": "A 405B dense model has 258 KB of KV per token (FP8, summed over its node) and prefills at 3.2 × 10¹⁵ FLOP/s achieved on that 8-GPU node. Using restore wins ⟺ kv_bytes_per_token ÷ bandwidth < 2·P ÷ achieved FLOP/s, what aggregate tier bandwidth is the tie?",
    "choices": [
      "About 1.0 GB/s: 258 KB in the 0.25 ms one token takes to recompute",
      "About 2.0 GB/s: 258 KB against 0.13 ms, one FLOP per parameter per token",
      "About 0.13 GB/s: one GPU's 32 KB share against the whole node's 0.25 ms",
      "About 3.2 GB/s: the tie equals the node's achieved PFLOP/s, read in GB/s"
    ],
    "answer": 0,
    "explain": "Recompute per token: 2 × 405e9 ÷ 3.2e15 ≈ 0.25 ms. Tie: 258 KB ÷ 0.25 ms ≈ 1.0 GB/s for the node (~0.13 GB/s per GPU, if each has its own link). The 2.0 GB/s choice forgets the factor 2 in 2·P; the 0.13 GB/s one compares one GPU's bytes with the whole node's time without saying it is per GPU."
  },
  {
    "q": "Over an hour, a replica's /metrics give external_prefix_cache_hits ÷ external_prefix_cache_queries = 6%, while prompt_tokens_by_source splits 58% local_cache_hit, 2.5% external_kv_transfer, 39.5% local_compute. KV usage stays near 50%. What do you conclude about its host tier?",
    "choices": [
      "It is failing: a 6% external hit rate means most offloaded blocks were lost",
      "It is quiet by design: little is evicted, and most misses are new tokens",
      "It is too small: the 39.5% computed share shows blocks dropped from host",
      "It is miswired: external queries should match local hits, not local misses"
    ],
    "answer": 1,
    "explain": "External queries are asked only for tokens HBM lacked, and most of those are tokens no tier ever saw (new tool results, new questions), so the external hit rate is low on a healthy day. At 50% KV usage little is evicted; the tier earns its keep under pressure. 'Too small' would need evidence of eviction (falling idle-before-evict times) and a size below the GPU pool."
  },
  {
    "q": "A gateway routes on exact KV events from its vLLM replicas, with no speculative indexing. Two identical 30,000-token requests arrive 5 ms apart at an idle, balanced fleet. What most likely happens?",
    "choices": [
      "Both go to the same replica, since KV events arrive within a microsecond",
      "The second is held at the gateway until the first one's prefill completes",
      "The second is rejected as a duplicate by the engine's prefix-hash check",
      "They may land on two replicas, and both prefill all 30,000 tokens"
    ],
    "answer": 3,
    "explain": "Exact events report blocks only once they are stored. 5 ms after the first decision, its 30,000-token prefill is far from done, the index shows nothing, and the second request is scored on load alone. That gap is why llm-d inserts a speculative index entry at routing time. Nothing in the stack holds or rejects identical prompts."
  },
  {
    "q": "Two tenants share a fleet. Tenant B runs a nightly batch at priority −1 while tenant A's interactive traffic peaks. With llm-d v1.0 flow control on and the pool saturated, what happens to B's requests?",
    "choices": [
      "They are dispatched first, because the batch arrived before A's peak",
      "They wait in a capped band at the gateway; overflow gets an HTTP 429",
      "They are preempted inside the engines, which reorder work by tenant",
      "They interleave evenly with A's, because the fairness policy is per tenant"
    ],
    "answer": 1,
    "explain": "Flow control holds requests at the gateway while the saturation detector says the pool is full, serves the highest priority band first, and treats negative priorities as sheddable: their band is bounded and overflow is rejected with 429. Fairness applies between flows within one band, not across bands, and the engines know nothing about tenants."
  },
  {
    "q": "A KEDA ScaledObject scales on sum(vllm:num_requests_waiting) with threshold 5 and minReplicaCount 2. Traffic is steady; every replica runs a full batch and the queue stays empty. What does the autoscaler do?",
    "choices": [
      "Holds the current count, since the replicas are exactly at capacity",
      "Adds one replica, since a full batch is reported as one waiting request",
      "Scales down toward 2, since zero waiting asks for zero replicas",
      "Pauses scaling, since KEDA skips a query whose result is exactly zero"
    ],
    "answer": 2,
    "explain": "With the default AverageValue metric type, desired = ceil(metric ÷ threshold) = ceil(0 ÷ 5) = 0, clamped to the minimum. Replicas that are fully busy but keeping up get scaled away, the queue then grows, and the fleet flaps. Scale on running + waiting against what one replica serves."
  }
]
```
