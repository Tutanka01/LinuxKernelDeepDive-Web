# Disaggregated Serving

> **The question:** prefill and decode want different machines and interfere when
> they share one — when is it worth running them on separate GPU pools and
> shipping each request's KV cache between them?
>
> **You'll be able to:** compute the cost of moving a KV cache over a given link and
> compare it with recomputing it and with not moving it; compare colocated and
> disaggregated layouts by goodput and set a prefill-to-decode ratio from traffic;
> read a disaggregated deployment's launch lines and metrics and say where a slow
> first token spent its time.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="router,scheduler,kv"></div>

[Continuous Batching](#/continuous-batching) tamed prefill interference with chunked
prefill: a long prompt is sliced into pieces that ride along with decodes instead of
freezing them. That bounds the damage without removing it — every prefill chunk in a
step still makes that step longer for every decoding user.

The radical alternative is to give each phase **its own pool of GPUs**. Prefill
machines never slow a decode step again. The catch: the prefill pool computes a
prompt's KV cache, and the decode pool needs it. The cache must cross a link, and
whether that trade pays is a question with a numerical answer.

## Two phases, two shopping lists

From [Inference Arithmetic](#/inference-arithmetic): prefill runs at an intensity of
roughly the prompt length — compute-bound — and decode at roughly the batch size —
memory-bound.

- **Prefill wants FLOP/s**: compute-dense silicon, low precision, large batches,
  aggressive tensor parallelism to cut one large prompt's latency. It needs little
  memory capacity — a prompt's KV is written once and handed off.
- **Decode wants bytes per second and bytes of capacity**: high bandwidth for each
  step's weight read, and enough memory to hold every live sequence's cache. Its
  FLOP/s mostly go unused.

A GPU that serves both pays for one of them twice. The two also scale on unrelated
curves: prefill with tokens *in*, which can be batched or queued; decode with the
number of live sequences and how long each one writes, a heartbeat that must tick
every TPOT. Sizing one pool for both means sizing for the worse of two curves.

## Disaggregation, and the metric that justifies it

**Prefill/decode (PD) disaggregation** splits the fleet:

```text
   COLOCATED (chunked prefill)            DISAGGREGATED
   ┌────────────────────────┐             ┌──────────┐   KV    ┌──────────┐
   │ one pool: prefill      │             │ PREFILL  │ ──────► │  DECODE  │
   │ chunks and decode      │             │  pool    │  over   │  pool    │
   │ tokens share each step │             │ (compute)│  RDMA   │ (memory) │
   └────────────────────────┘             └──────────┘         └──────────┘
```

Each pool can then be itself: large batches and high tensor parallelism for prefill,
latency-tuned batches for decode, different counts, even different silicon. You saw
the production shape in [Serving MoE at Scale](#/moe-serving): DeepSeek runs prefill
as EP32 on 4 nodes and decode as EP144 on 18.

Two research systems made the case. **DistServe** (OSDI 2024) optimised **goodput** —
requests served *within* their latency targets, per GPU — and reports serving "7.4x
more requests or 12.6x tighter SLO" than colocated systems
([arXiv 2401.09670](https://arxiv.org/abs/2401.09670)). **Splitwise** (ISCA 2024) ran
each phase on hardware suited to it: "1.4x higher throughput at 20% lower cost", or
"2.35x more throughput with the same cost and power budgets"
([arXiv 2311.18677](https://arxiv.org/abs/2311.18677)).

Goodput is what makes the argument legible. Raw throughput rewards letting TTFT drift
to several seconds; goodput counts a late request as nothing. Under goodput, the
colocated pool's problem is visible: **one knob** — the token budget per step —
controls **two opposed promises**. On the case's replica a 512-token chunk riding
with 20 decodes makes a ~50 ms step, against ~16 ms for decodes alone; a 1,024-token
budget makes it ~95 ms. Larger chunks help TTFT and stretch every decoding user's
gaps. Disaggregation turns one knob into two pools, each sized for its own promise,
plus a ratio between them that absorbs the traffic mix. vLLM's own docs are blunt
about what it is not: "Disaggregated prefill DOES NOT improve throughput"
([v0.34.0 docs](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/features/disagg_prefill.md)).
It is an argument about provisioning, not about doing less work.

> [!bridge] From the Distributed Systems course
> This is the familiar split of a service into tiers that scale independently. What
> differs is the state that crosses the boundary: not a dataset replicated once and
> read many times, but one request's KV cache, useful to exactly one consumer, which
> must arrive before that consumer's first token.
> [→ Distributed: Real-World Architectures](../distributed/#/real-world-architectures)

## Goodput, computed

Take long-document traffic — 8,000 tokens in, 400 out — with targets of TTFT ≤ 2 s
and TPOT ≤ 30 ms, and eight GPUs as four FP8 TP=2 replicas. Price every step with the
case's model, `max(t_w, t_c) + t_kv`, and find the highest request rate each layout
sustains while meeting both targets:

```python
# Goodput on 8 GPUs = four FP8 TP=2 replicas; the case's step model, times in ms
T_IN, T_OUT, CHUNK, TTFT_MAX = 8000, 400, 512, 2000    # long-document traffic
def step(tokens, seqs):                 # max(t_w, t_c) + t_kv at ~8.4K contexts
    return max(14, 0.089 * tokens) + 0.244 * seqs
def colocated(lam):                     # one replica, chunked prefill: (TTFT, TPOT)
    B = 1.0
    for _ in range(100):                # Little's law: B = lam * T_OUT * TPOT
        n_c = lam * T_IN / CHUNK        # steps per second that carry a chunk
        busy = n_c * step(CHUNK + B, B)
        if busy >= 1000: return 1e9, 1e9
        tpot = 1000 / (n_c + (1000 - busy) / step(B, B))
        B = lam * T_OUT * tpot / 1000
    return T_IN / CHUNK * step(CHUNK + B, B) / (1 - busy / 1000), tpot
def prefill_ttft(lam):                  # prefill-only replica, M/D/1 queue,
    s = step(T_IN, 0); rho = lam * s / 1000      # + one decode step for token 1
    return s + rho * s / (2 * (1 - rho)) + 14 if rho < 1 else 1e9
def decode_tpot(lam):                   # decode-only replica
    B = 1.0
    for _ in range(100):
        tpot = step(B, B); B = lam * T_OUT * tpot / 1000
    return tpot
def goodput(ok):                        # highest total req/s meeting both targets
    lam = 0.0
    while ok(lam + 0.01): lam += 0.01
    return lam
for tpot_max in (20, 30):
    co = goodput(lambda l: colocated(l / 4)[0] <= TTFT_MAX and colocated(l / 4)[1] <= tpot_max)
    pd = [goodput(lambda l: prefill_ttft(l / p) <= TTFT_MAX and decode_tpot(l / (4 - p)) <= tpot_max) for p in (2, 3)]
    print(f"TPOT <= {tpot_max} ms: 4 colocated {co:.2f}  2P2D {pd[0]:.2f}  3P1D {pd[1]:.2f} req/s")
# --- output of an actual run ---
# TPOT <= 20 ms: 4 colocated 2.01  2P2D 2.19  3P1D 3.07 req/s
# TPOT <= 30 ms: 4 colocated 3.27  2P2D 2.19  3P1D 3.29 req/s
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. An estimate from mean-value queueing approximations, not a measurement; transfer time inside one node (~1 ms) is ignored.*

Read the two lines together. At TPOT ≤ 30 ms, colocation and the right split (3P1D)
tie at ~3.3 requests/s, and the wrong split (2P2D) loses a third — its prefill pool
saturates while its decode pool idles. Tighten TPOT to 20 ms and colocation falls to
2.0: its ~50 ms chunk steps now break the promise, while 3P1D's decode pool never
sees a chunk. That is goodput-driven provisioning: the layout follows from the
targets and the traffic, and the ratio matters as much as the split. Replace the
model with measurements — `vllm bench serve` at a fixed `--request-rate`, sweeping,
reading TTFT and TPOT percentiles — before you buy anything.

## What moving the cache costs

> [!predict] Before you read on
> A 4,000-token prompt to Llama-3.3-70B leaves ~1.3 GB of BF16 KV cache. How long does
> shipping it through one 400 Gb/s (50 GB/s) NIC take — about 3 ms, 30 ms, or 300 ms?

About **26 ms**: `1.3 GB ÷ 50 GB/s`. Under TP=4 each rank holds a quarter of the cache
(its own KV heads), and on a node with one NIC per GPU the four quarters travel in
parallel: ~6.6 ms. Either way, small against a sub-second TTFT target. At the other
extreme, a 128K-token context is ~43 GB, ~0.86 s through one NIC — a quarter of a
250-token answer's entire decode. Transfer cost grows with prompt length.

Two comparisons hide in the decision, and mixing them up is the commonest error.

**Transfer versus recomputing.** If shipping the cache cost more than rebuilding it,
the decode pool could simply prefill again.

> [!predict] Before you read on
> Recomputing that 4,000-token prefill on the case's four-GPU node at 40% MFU: faster
> or slower than the transfer, and by how much?

Much slower: `2 × 70e9 × 4,000 = 5.6 × 10¹⁴` FLOPs at 1.58 × 10¹⁵ FLOP/s is about
**0.35 s** — 13× the single-NIC transfer, 50× the four-NIC one. A KV cache is
expensive to make and cheap to move.

**Transfer versus never moving it.** This is the comparison that decides anything.
The alternative to shipping the cache is running decode on the GPUs that already hold
it. Against that baseline the transfer is pure added cost, which pays only if the
interference it removes was worth more. The real question is never "is transfer
cheap?" — it is — but "**was colocation actually hurting me?**"

The fabric is a first-order input. Per direction, for the same 1.3 GB:

```text
   NVLink 4, one GPU pair        ~450 GB/s  →    ~2.9 ms   (four pairs at once: ~0.7 ms)
   InfiniBand NDR, one NIC        ~50 GB/s  →     ~26 ms   (one NIC per rank:   ~6.6 ms)
   25 GbE                        ~3.1 GB/s  →    ~420 ms

   disaggregate when:   interference removed  >  KV size ÷ link bandwidth
                        (and the transfer fits inside the TTFT budget)
```

The ~10× drop per GPU at the node boundary ([Parallelism for
Inference](#/parallelism-for-inference)) decides where a pool boundary may go. Across
commodity Ethernet, it should not go at all.

## The real thing, in vLLM v0.34

vLLM moves the cache through a **KV connector**; the production one is
`NixlConnector`, built on NVIDIA's NIXL transfer library over UCX (RDMA between
hosts, NVLink inside one). A minimal split is two servers and a proxy:

```bash
# 1st GPU as prefiller
CUDA_VISIBLE_DEVICES=0 \
UCX_NET_DEVICES=all \
VLLM_NIXL_SIDE_CHANNEL_PORT=5600 \
vllm serve Qwen/Qwen3-0.6B \
  --port 8100 \
  --enforce-eager \
  --kv-transfer-config '{"kv_connector":"NixlConnector","kv_role":"kv_producer","kv_load_failure_policy":"fail"}'

# 2nd GPU as decoder
CUDA_VISIBLE_DEVICES=1 \
UCX_NET_DEVICES=all \
VLLM_NIXL_SIDE_CHANNEL_PORT=5601 \
vllm serve Qwen/Qwen3-0.6B \
  --port 8200 \
  --enforce-eager \
  --kv-transfer-config '{"kv_connector":"NixlConnector","kv_role":"kv_consumer","kv_load_failure_policy":"fail"}'

python tests/v1/kv_connector/nixl_integration/toy_proxy_server.py \
  --port 8192 \
  --prefiller-hosts localhost \
  --prefiller-ports 8100 \
  --decoder-hosts localhost \
  --decoder-ports 8200
```

*Verbatim — vLLM v0.34.0, `docs/features/nixl_connector_usage.md` ("Basic Usage (on the same host)"), the three commands concatenated.*

What the proxy does decides what TTFT measures. It sends the request to the prefiller
with `"max_tokens": 1` and `"stream": false`, keeps only the `kv_transfer_params` in
the reply, and then streams the client's answer from the decoder
([`toy_proxy_server.py`](https://github.com/vllm-project/vllm/blob/v0.34.0/tests/v1/kv_connector/nixl_integration/toy_proxy_server.py)).
So the client's **first token comes from the decode instance**: TTFT = prefill + the
transfer + the decoder's first step, and the transfer sits inside it. The default
connector *pulls* — the decoder reads the blocks "via NIXL READ after prefill
completes"; v0.34 added an opt-in *push* mode (`"transfer_mode": "push"`) in which the
prefiller writes into the decoder's pre-allocated blocks
([push design](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/design/nixl_kv_push_connector.md)).
Neither streams layer by layer, although the connector API has per-layer hooks
(`save_kv_layer`, "useful for layer-by-layer pipelining") that other connectors use to
hide the transfer under the remaining layers' prefill.

Two more details are the operational ones. A finished prefill holds its blocks under a
**lease** (`kv_lease_duration`, default 30 s, renewed by heartbeats while the request
waits on the decoder): when the decode pool is full, prefills pile up holding memory,
and TTFT degrades from *decode-side* pressure. And a decode instance never runs a
real prefill, so it can capture CUDA graphs for decode only —
`--compilation-config '{"cudagraph_mode": "FULL_DECODE_ONLY"}'`, which the source
describes as "good for decode instances in a P/D setup where prefill is not as
important so we can save some memory". NVIDIA Dynamo (v1.6) and llm-d (v1.0) wrap
the same connectors with KV-aware routing and manage a P/D pair as one unit.

The connector reports itself in the log every interval:

```plaintext
KV Transfer metrics: Num successful transfers=4, Avg xfer time (ms)=1.381,
P90 xfer time (ms)=2.601, Avg post time (ms)=0.672, P90 post time (ms)=0.801,
Avg MB per transfer=2.25, Throughput (MB/s)=1629.549, Avg number of descriptors=72.0,
Num failed transfers=0, Num KV expired reqs=0
```

*Verbatim — the example output in vLLM v0.34.0 `docs/features/nixl_connector_usage.md` ("Metrics Reference").*

`Avg MB per transfer` is a request's cache — check it against tokens × KV bytes per
token. `Num KV expired reqs` counts prefills whose blocks timed out before the
decoder read them: the lease, or a decode pool that cannot keep up.

> [!dashboard] The prefill→decode link
> **Utilisation:** `vllm:nixl_bytes_transferred` (histogram: its `_sum` rate is bytes
> per second through the connector) against the link's per-direction bandwidth.
> **Saturation:** `vllm:nixl_xfer_time_seconds` p90 rising while bytes per transfer
> holds steady; on the decoder, `vllm:kv_cache_usage_perc` near 1 means finished
> prefills are waiting for room. **Errors:** `vllm:nixl_num_failed_transfers` and
> `vllm:nixl_num_kv_expired_reqs`.

## When it does not pay, and setting the ratio

> [!predict] Before you read on
> A reasoning model answers 300-token prompts with 6,000-token chains of thought. You
> deploy one prefill GPU per decode GPU. What do the prefill GPUs do most of the time?

They idle. Prefill work per request is tiny next to decode work, so a 1:1 split wastes
half the fleet; such traffic needs one prefill GPU per several decode GPUs (**1P3D**,
**1P4D**) — and the long-document traffic above needed the reverse, **3P1D**. The
ratio comes from measured GPU-seconds per phase: prefill per request is about
`2·P·T_in` FLOPs over your achieved prefill rate; decode is `T_out` steps at your
measured TPOT, shared across the batch. Tune from there against goodput, and expect
it to move when the product does — turning on longer reasoning can shift a workload
from 1P1D to 1P4D without a line of serving code changing.

The split does not pay for short prompts (little interference to remove), small
models (a pool of one GPU each side moves only in whole machines), slow fabrics, or
light load. Low load deserves precision: a chunk lengthens whatever step it rides in
at any load; low load only means fewer steps carry one.

> **State of play (November 2026):** disaggregation now crosses silicon types, as
> vendor products — claims, not independent measurements. NVIDIA (24 August 2026):
> in Vera Rubin systems, "NVIDIA Rubin GPUs handle large-scale context processing
> while LPX accelerates latency-sensitive decode workloads", and the two "jointly
> compute every layer of an AI model"; a Groq 3 LPX rack "can include 256 LP30
> accelerators" ([NVIDIA](https://blogs.nvidia.com/blog/vera-rubin-lpx-spectrum-x-nvlink-fusion/));
> Dynamo v1.6.0 added LPX components. NVIDIA does not say what crosses between them.
> Cerebras (17 November 2026): "AMD Instinct GPUs process prompts, and Cerebras CS-3
> systems generate responses", with KV caches moved "between prefill and decode
> engines over RDMA", for "5X the throughput per megawatt of a CS-3-only
> configuration" on a shared gpt-oss-120b endpoint
> ([Cerebras](https://cerebras.ai/blog/cerebras-launches-disaggregated-inference)).
> Multimodal models add a third stage — encode, prefill, decode — covered in
> [Beyond Chat](#/beyond-chat).

> [!case] The case: no — and the number that says no
> Ask Halden: two FP8 TP=2 replicas on one four-GPU node; at peak ~0.75 requests/s
> per replica, 2,200 uncached prompt tokens each, ~20 decoding sequences in total.
>
> - **Interference, priced.** Each replica prefills ~1,650 tokens/s: ~3 chunk steps a
>   second at ~46–50 ms, the rest decode steps at ~16 ms. About 5.5% of steps are slow,
>   and the mean TPOT is ~17 ms against ~16 ms with no prefill at all. A split would
>   buy ~1 ms against a 60 ms target.
> - **The ceiling.** With a 512-token budget, 3K-token contexts and ~20 sequences
>   decoding, the worst step is ~50 ms — under 60 ms however much prefill arrives.
>   Interference cannot break the phase-1 promise; only running out of prefill compute
>   can, and a split adds none.
> - **Granularity.** Four GPUs split into one prefill and one decode replica: no
>   redundancy, and the decode pool alone must hold phase 2's FP8 KV in 66 GB: ~61 GB
>   on average, ~75 GB at a p95 count of sessions.
> - **Fabric.** Not the obstacle: a 3,000-token FP8 cache is ~0.5 GB, ~0.25 GB per rank
>   over NVLink, well under a millisecond.
>
> **What this settles:** colocated serving with chunked prefill. Phase 2 makes the
> traffic *prefill*-heavy — 47K prompt tokens per agent request uncached, ~17K with
> caching, ~10.7K tokens/s at the peak against ~11.3K of prefill capacity per replica
> — and makes ~27% of steps hybrid. Mean TPOT stays ~25 ms, but a chunk at 17K
> context takes ~63 ms: the worst token gaps sit right at the 60 ms line. That is
> where a split would start to pay — if Halden ever holds a per-token gap target, or
> grows past one node, the answer is a prefill-heavy split like the 3P1D above, not
> 1:1 and never decode-heavy. What threatens phase 2 first is TTFT on cache misses,
> which is compute.

## Exercises

<div class="exercise">

**Exercise 1.** A service averages 2,000 input and 500 output tokens per request on a
70B model. Achieved prefill is ~1.6 × 10¹⁵ FLOP/s per 4-GPU unit; decode runs at a
TPOT of 30 ms with batches of 40 per 4-GPU unit. Estimate the GPU-seconds per request
for each phase and a starting prefill:decode ratio.

<details>
<summary>Reveal answer</summary>

Prefill: `2 × 70e9 × 2,000 = 2.8 × 10¹⁴` FLOPs ÷ 1.6 × 10¹⁵ ≈ 0.175 s of a 4-GPU unit.
Decode: 500 steps × 30 ms = 15 s of a unit's time, shared by 40 sequences → 0.375 s per
request. Ratio ≈ 0.175 : 0.375 ≈ **1 : 2** — start near 1P2D (in units) and tune
against goodput. Doubling output length would push it toward 1P4D.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team splits a 70B deployment (BF16 KV) across two
servers joined by 25 GbE, serving ~6,000-token prompts. TTFT p95 goes from 0.9 s to
1.5 s and inter-token latency barely improves. The prefiller's log shows:

```plaintext
KV Transfer metrics: Num successful transfers=37, Avg xfer time (ms)=641.207,
P90 xfer time (ms)=702.884, Avg post time (ms)=0.913, P90 post time (ms)=1.204,
Avg MB per transfer=1966.08, Throughput (MB/s)=3066.233, Avg number of descriptors=96.0,
Num failed transfers=0, Num KV expired reqs=0
```

*Real format, illustrative values — the log line format from vLLM v0.34.0 `docs/features/nixl_connector_usage.md`; the numbers are computed for this exercise (6,000 tokens × 328 KB over ~3.1 GB/s), not measured.*

Explain both symptoms.

<details>
<summary>Reveal answer</summary>

Each request ships ~1,966 MB at ~3,070 MB/s: ~0.64 s per transfer, and because the
client's first token comes from the decoder, all of it lands in TTFT — the 0.6 s
regression. `post time` is under a millisecond, so this is the wire, not the software.
ITL barely improves because chunked prefill had already contained most of the
interference. Return to colocated serving, or split only where pools share an RDMA
fabric (at 50 GB/s the same transfer is ~40 ms).

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Take Cerebras's split at its word: GPUs prefill gpt-oss-120b
and decode runs elsewhere, the cache crossing over RDMA. From [Serving MoE at
Scale](#/moe-serving), its BF16 KV is ~37 KB per token plus ~4.7 MB per sequence for
the sliding-window layers. For a 10,000-token prompt, how long does the cache take over
one 400 Gb/s link, and over 100 Gb/s? Compare with Llama-3.3-70B's cache for the same
prompt. What does that say about which models suit cross-silicon splits?

<details>
<summary>Reveal answer</summary>

gpt-oss: 10,000 × 37 KB + 4.7 MB ≈ **0.37 GB** → ~7.5 ms at 50 GB/s, ~30 ms at
12.5 GB/s. Llama-3.3-70B: 10,000 × 328 KB ≈ 3.3 GB → ~66 ms at 50 GB/s, ~260 ms at
12.5 GB/s. The same link is nine times cheaper for the MoE because its KV is small
(GQA with 8 heads of 64, half the layers windowed). Cross-silicon splits favour models
with small caches; for large-KV models the link has to be NVLink-class or the transfer
eats the TTFT budget.

</details>

</div>

<div class="exercise">

**Exercise 4.** The goodput script above uses TPOT ≤ 20 or 30 ms. Halden's own target
is 60 ms. Without rerunning it, which layout would you expect to win at 60 ms on that
long-document traffic, and why? Then change `tpot_max` to 60 and run it.

<details>
<summary>Reveal answer</summary>

At 30 ms colocation already tied 3P1D; loosening TPOT further cannot hurt colocation,
whose chunk steps (~50 ms) now fit inside the promise, while 3P1D stays capped by its
prefill pool's TTFT. Expect a tie. Running it gives the same 3.27 and 3.29 req/s:
once neither TPOT target binds, both layouts are limited by TTFT on prefill compute,
and only more prefill FLOP/s would raise goodput.

</details>

</div>

<div class="exercise">

**Exercise 5 — find the flaw.** A proposal for Halden: "Split the node into a prefill
pair and a decode pair. Transfer is 50× cheaper than recompute, so disaggregation is
nearly free. Phase 2 is decode-heavy, so we will move to 1P3D on the next node. The
prefill GPUs emit the first token, so TTFT is unaffected by the transfer." Find the
errors.

<details>
<summary>Reveal answer</summary>

(1) The baseline is wrong: the alternative to moving the cache is not moving it, so
the transfer is pure cost against colocation, which loses ~1 ms of TPOT today.
(2) Phase 2 is prefill-heavy (47K / ~17K prompt tokens per agent request); a ratio
would lean toward prefill. (3) In vLLM's proxy pattern the decoder emits the first
token, so the transfer is inside TTFT. (4) Unstated: splitting four GPUs leaves one
replica per role and no redundancy.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>Do both pools need the same GPU?</summary>

No — that is part of the appeal, and the State-of-play box shows vendors going further.
The pools must agree on how the cache is laid out, or pay to convert it. Mismatched
tensor-parallel degrees mean each decode rank needs heads from several prefill ranks;
vLLM's NIXL connector documents which combinations it supports in a compatibility
matrix.

</details>

</div>

## What to remember

- Prefill wants FLOP/s; decode wants bandwidth and capacity. Colocation lets one token
  budget trade TTFT against inter-token latency.
- Goodput — requests within both targets, per GPU — decides the layout; the right
  ratio matters as much as the split, and the targets move the answer.
- Moving a cache is cheap against recomputing it (0.35 s on the case's node for 4K
  tokens) but pure cost against not moving it.
- In vLLM's proxy pattern the decoder emits the first token: the transfer is inside
  TTFT, and a full decode pool shows up as expired leases and slow first tokens.
- Halden stays colocated: in phase 1 a 512-token budget's worst step (~50 ms) cannot
  break the 60 ms TPOT target; in phase 2 the worst gaps reach it.

```quiz
[
  {
    "q": "Qwen3-30B-A3B keeps 98 KB of BF16 KV per token. A 16,000-token prompt's cache crosses one 200 Gb/s link. About how long does the transfer take?",
    "choices": [
      "About 8 ms, because the link carries 200 GB/s",
      "About 0.6 s, because MoE caches are as large as dense ones",
      "About 63 ms: 1.6 GB at 25 GB/s",
      "About 16 ms: one millisecond per thousand tokens"
    ],
    "answer": 2,
    "explain": "16,000 × 98 KB ≈ 1.57 GB; 200 Gb/s is 25 GB/s per direction, so ~63 ms. Reading the line rate as gigabytes per second gives the 8 ms answer — the bits-for-bytes slip."
  },
  {
    "q": "A disaggregated deployment shows TTFT p95 rising and vllm:nixl_num_kv_expired_reqs climbing. The prefill GPUs are half idle; the decoders report vllm:kv_cache_usage_perc around 0.98. What is binding?",
    "choices": [
      "Decode-side memory: finished prefills wait for room and their leases expire",
      "The network: the link is too slow, so transfers time out before they finish",
      "Prefill compute: the prefill pool cannot produce caches fast enough for the load",
      "The proxy: it sends requests to the prefiller and decoder in the wrong order"
    ],
    "answer": 0,
    "explain": "A full decode cache means new requests cannot be admitted to decode, so prefilled blocks sit under their lease until it expires; TTFT grows from decode-side pressure. Idle prefill GPUs rule out prefill compute; a slow link would show in transfer time, not in decoder KV usage."
  },
  {
    "q": "A team moves from colocated serving to vLLM's NIXL prefill/decode split with the toy proxy, on a slow link. Which latency absorbs the KV transfer time?",
    "choices": [
      "The inter-token latency of every generated token",
      "None: the transfer overlaps the prefill layer by layer",
      "Only the end-to-end latency, after the last token",
      "The time to first token, since the decoder emits it"
    ],
    "answer": 3,
    "explain": "The proxy asks the prefiller for one token, discards it, and streams the answer from the decoder, which pulls the cache after the prefill completes. The client's first token therefore waits for prefill, transfer and the decoder's first step. The cache moves once per request, not per token."
  },
  {
    "q": "On the case's TP=2 FP8 replica, an operator raises the token budget from 512 to 1,024 to cut TTFT. With 20 sequences decoding, about how long is a step that carries a full chunk?",
    "choices": [
      "About 50 ms, since the step is bound by the weight read",
      "About 95 ms: 1,044 tokens × 0.089 ms plus KV reads",
      "About 65 ms: the 50 ms step plus one extra 14 ms read",
      "About 190 ms: twice the arithmetic of a 1,024-token step"
    ],
    "answer": 1,
    "explain": "1,044 tokens × 0.089 ms ≈ 93 ms of arithmetic, above the 14 ms weight read, plus ~2 ms of KV reads ≈ 95 ms. The step is compute-bound once a chunk rides in it, so doubling the chunk nearly doubles the step — every decoding user's gap — and adding a second weight read misreads the max() in the model."
  },
  {
    "q": "Two models are candidates for a GPU-prefill, SRAM-decode split over RDMA: a dense 70B with 328 KB of KV per token, and an MoE with 37 KB per token. Which is cheaper to feed across the link, and by how much?",
    "choices": [
      "The dense model, because its active parameters are fewer",
      "Neither: transfer depends on the link, not the model",
      "The MoE, by about nine times per prompt token",
      "The MoE, by about thirty times its active parameter count"
    ],
    "answer": 2,
    "explain": "What crosses is the KV cache, so the cost scales with KV bytes per token: 328 ÷ 37 ≈ 9×. Parameter counts, total or active, do not move between the pools; the link speed scales both models equally."
  }
]
```
