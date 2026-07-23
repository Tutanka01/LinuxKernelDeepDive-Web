# Disaggregated Serving & the KV Fabric

> **Goal of this chapter:** see the moment the KV cache stopped being a
> per-GPU buffer and became the field's central *distributed object*. You
> will understand why serious 2026 deployments run prefill and decode on
> separate GPU pools, what it costs to ship KV between them, and how the
> whole datacenter — routers, tiered memory, transfer libraries — reorganizes
> itself around cache placement. After this chapter, "the KV cache is the
> center of gravity of modern serving" is not a slogan; it is an architecture
> you can draw.

Two chapters set up this one. [Inference Arithmetic](#/inference-arithmetic)
proved the field's founding asymmetry: **prefill is compute-bound** (it crunches
the whole prompt through dense matmuls) while **decode is memory-bound** (each
token is a skinny operation dominated by streaming weights and KV out of HBM).
[Continuous Batching](#/continuous-batching) gave you **chunked prefill** —
slicing a prompt into pieces so it shares a batch with decodes instead of
stalling them. That *tames* interference but does not remove it: every prefill
chunk you fold in still burns HBM bandwidth and SM cycles a decode token wanted.
On one GPU, prefill and decode are roommates fighting over the same sink.

This chapter is the radical alternative. **Give each phase its own GPU
pool** — its own count, its own parallelism, even its own hardware tier — so
prefill machines never steal a decode machine's bandwidth. The catch is the
whole rest of the chapter: the prefill pool computes a prompt's KV cache, but
the *decode* pool is the one that needs it. Somebody has to **ship the KV cache
across the network**. The instant you say that sentence, your distributed-systems
instincts should light up: a local buffer just became a piece of state that must
be transferred, placed, and located. That is exactly what happened to the field.

## Disaggregation: the core trade

Splitting the phases is called **prefill/decode disaggregation** (PD
disaggregation). The picture:

```text
   COLOCATED (chunked prefill)          DISAGGREGATED (PD)
   ─────────────────────────            ──────────────────
   ┌───────────────────────┐            ┌──────────┐   KV    ┌──────────┐
   │  one GPU pool          │           │ PREFILL  │ ──────► │  DECODE  │
   │  prefill chunks +      │           │  pool    │  over   │  pool    │
   │  decode tokens share   │           │ (compute)│  RDMA   │ (memory) │
   │  every batch → they    │           └──────────┘         └──────────┘
   │  fight for bandwidth   │            few big-batch        many latency-
   └───────────────────────┘            GPUs, high TP         sensitive GPUs
```

Each pool is now free to be *itself*. Prefill wants throughput: large batches,
aggressive tensor parallelism, the newest compute-dense silicon. Decode wants
low, steady latency: modest batches, parallelism tuned for tokens-per-second,
enough GPUs that no single long request wrecks everyone's inter-token latency.
You already saw the production shape in [Serving MoE at Scale](#/moe-serving):
DeepSeek runs prefill as EP32 across 4 nodes and decode as EP144 across 18 —
two differently-shaped machines for two differently-shaped jobs, wired together.

The foundational research made the case twice, from two angles:

- **DistServe** (OSDI 2024) optimized for **goodput** — not raw throughput,
  but *throughput that actually meets your latency SLOs* (a time-to-first-token
  target for prefill, an inter-token-latency target for decode). Its insight:
  once you stop forcing both phases through one pool, you can **provision each
  independently** to hit its own SLO — pick the prefill:decode GPU ratio,
  parallelism, and batch size that maximize served-within-SLO requests per
  dollar. That is *goodput-driven provisioning*, and it is the reason to
  disaggregate at all.
- **Splitwise** (Microsoft, ISCA 2024) leaned into **heterogeneous hardware**:
  put prefill on compute-rich GPUs and decode on cheaper, memory-rich ones,
  because each phase is bottlenecked on a *different* resource so paying for
  both on every GPU is waste. Combined, these lines of work reported 2–7×
  throughput at fixed latency.

### The transfer-cost math — when it actually wins

Disaggregation is not free, and the price is one number: **the cost of moving
the KV.** Every request pays it. The decision is a comparison:

```text
  disaggregate when:   interference_saved  >  KV_size / link_bandwidth
```

Work the right-hand side with real numbers. A 70B model in fp16 (GQA, 8 KV
heads, 80 layers) holds **320 KiB of KV per token** — the same per-token math
you did for 8B in [PagedAttention](#/paged-kv-cache), scaled up. A 4,000-token
prompt therefore leaves behind ≈ **1.3 GB** of KV. Ship it over an
InfiniBand/RoCE RDMA link at ~50 GB/s:

```text
  1.3 GB ÷ 50 GB/s ≈ 26 ms
```

26 ms of one-time transfer, overlapped with work, to buy a decode pool that
never again hitches on this request's prefill — for interactive prompts, an
easy win. Now the *other* end of the regime: a 128K-token context on that same
70B model is ≈ **43 GB** of KV, and over a slow or oversubscribed fabric its
transfer can rival the decode time it was meant to protect. **Transfer cost
scales with prompt length; the benefit scales with how much interference you
were suffering.** When those cross, disaggregation stops paying.

> **Common trap:** "disaggregation is strictly better, always turn it on." It
> is a *regime*, not a religion. At **low load** there is little interference
> to eliminate, so you pay the transfer tax for nothing — plain colocation
> wins. And **reasoning models break the naive setup**: long chain-of-thought
> requests emit thousands of decode tokens per short prompt, so the workload is
> overwhelmingly decode-bound. A symmetric 1-prefill-1-decode split leaves the
> prefill GPUs *idle* most of the time. The fix is asymmetric ratios — **1P3D**,
> 1P4D — or, at low enough load, not disaggregating at all. Match the pool
> ratio to your actual prompt:generation shape, or you are buying idle silicon.

## Mooncake: the KV cache as fleet-wide storage

Once KV is a movable object, a bigger idea appears. Look across your whole
serving fleet: every node has **spare CPU DRAM and idle SSD** sitting next to
its GPUs. Individually trivial; summed over hundreds of nodes, it is a
*enormous* pool of memory that could hold KV — far more than all your HBM
combined. **Mooncake** (Moonshot AI, the system behind the Kimi assistant)
took that literally and built a **KVCache-centric** architecture:

```text
   ┌─────────────┐     ┌──────────────────────────────┐     ┌─────────────┐
   │  PREFILL    │ ──► │   DISAGGREGATED KVCACHE POOL  │ ──► │   DECODE    │
   │  cluster    │     │  (spare CPU DRAM + SSD, fleet │     │  cluster    │
   └─────────────┘     │   wide, RDMA-addressable)     │     └─────────────┘
                       └──────────────────────────────┘
                       a KVCache-centric scheduler places,
                       reuses, and locates every block
```

The scheduler's job is no longer "which GPU is free" but "**where is the KV
this request needs, and where should its new KV live**." Prefill writes blocks
into the pool; decode reads them; a hot prefix computed for one user is a cache
hit for the next, served from pooled DRAM instead of recomputed. Under overload
Mooncake adds a distinctly systems-flavored move: **prediction-based early
rejection** — estimate whether an incoming request can still hit its SLO given
current queue and cache state, and shed it *early* rather than admit it, thrash,
and miss everyone's latency. Mooncake reported large gains (a simulated 525%
ceiling; ~75% more real requests served) and won the **FAST 2025 Best Paper**.
Its **Transfer Engine** and **Mooncake Store** were open-sourced in March 2025
and now ship as a KV connector inside vLLM and TensorRT-LLM — the fleet-wide KV
pool is in the standard stack.

## NVIDIA Dynamo: an "inference OS" above the engines

vLLM and SGLang ([Anatomy of a Serving Engine](#/anatomy-of-an-engine)) each
run *one* replica well; nobody was orchestrating a *fleet* of them with KV in
mind. **NVIDIA Dynamo** (1.0 GA, March 2026) is that missing layer — an
orchestrator *above* vLLM/SGLang/TensorRT-LLM, treating each as a worker. Three
pillars matter here:

- **Smart Router — KV-aware routing.** Instead of round-robin, it scores every
  candidate replica by roughly `cache_overlap(prefix) − load`, and sends your
  request to the worker that **already holds your prefix**. Routing *is* cache
  management now (more below).
- **KV Block Manager (KVBM).** Fleet-wide tracking of KV blocks — who holds
  what, what can be reused — plus **tiered offload** of cold blocks down the
  memory hierarchy. It is the paged block table of [chapter 5](#/paged-kv-cache),
  lifted from one GPU to the datacenter.
- **NIXL** (NVIDIA Inference Xfer Library) — the plumbing. A uniform transfer
  API over **RDMA/RoCE, NVMe-oF, and TCP**, doing **non-blocking VRAM→VRAM**
  moves so a GPU ships KV without stalling its compute stream. NIXL is what
  makes "ship the KV" a line of code instead of a research project.

> **State of play (mid-2026):** Dynamo 1.0 went GA in March 2026 (NVIDIA quotes
> up to 7× on Blackwell for disaggregated MoE — a vendor figure, treat as a
> ceiling). Named adopters include Cursor, Perplexity, Baseten, Deep Infra,
> Fireworks, ByteDance, and Meituan, with the major clouds and neoclouds
> (CoreWeave, Together, Nebius) offering it. **llm-d** is the Kubernetes-native
> counterpart (Red Hat–led, Google/NVIDIA/IBM/CoreWeave): vLLM workers behind
> the official K8s **Inference Gateway** — model-aware, KV-cache-aware routing
> and PD disaggregation expressed as Gateway-API extensions rather than a
> bespoke control plane. Same ideas, two front doors.

## KV tiering: the memory hierarchy, one level up

You have internalized memory hierarchies since the kernel course — each tier
slower and larger than the last. The KV fabric is that hierarchy rebuilt for
cache blocks:

```text
   HBM        hot   — active KV, last ~30 s of a live request   (fastest, tiny)
   CPU DRAM   warm  — reusable prefixes, ~30 s to minutes        (PCIe hop away)
   NVMe SSD   cold  — long-tail prefixes, minutes+               (big, cheap)
   recompute  gone  — not stored; pay prefill FLOPs to rebuild   (last resort)
```

**LMCache** is the standard open layer that implements this for vLLM
(HBM → CPU DRAM → SSD → remote, with cross-node P2P sharing). The key question
at every boundary: **is restoring a block cheaper than recomputing it?** Do the
arithmetic. Our 70B/128K KV is ≈ 43 GB; PCIe Gen5 moves ~64 GB/s, so restoring
it from CPU DRAM to HBM costs:

```text
  43 GB ÷ 64 GB/s ≈ 670 ms  (restore)
```

Recomputing that same 128K prefill from scratch is a **compute-bound pass over
128K tokens** — seconds of GPU time on a large model, and it burns a prefill
slot you could have given a new request. Hundreds of milliseconds of PCIe
traffic to skip seconds of compute is a trade you take. That is the whole case
for tiering: **KV is expensive to make and cheap to move**, so keep it and
haul it rather than rebuild it.

> **Common trap: the physical-vs-logical hit-rate gap.** A router can report a
> "99% logical hit rate" — 99% of requests *had* a reusable prefix somewhere —
> while delivering nothing, because HBM was full and the block had already been
> **evicted**, forcing a recompute. A logical hit that isn't physically
> resident is a miss with extra steps. Tiering exists precisely to turn logical
> hits into physical ones: catch the evicted block in DRAM or NVMe instead of
> recomputing it. Measure the hit rate that ends in *restored bytes*, not the
> one that ends in *found a match*.

## Routing and autoscaling: why the old playbook breaks

A classic HTTP load balancer treats replicas as interchangeable and spreads
requests evenly. For LLM serving that is actively harmful: **round-robin throws
away prefix caches.** Send a request whose 800-token system prompt is cached on
replica A over to replica B, and B re-runs the entire prefill — you paid for the
cache and routed around it. So the modern router is **cache-aware** (SGLang's
`sgl-router`, Dynamo's Smart Router, the Inference Gateway): it tracks which
replica holds which prefix and sends matches home. **Routing has become cache
management.**

That creates a tension you must name: **affinity vs balance.** Pure affinity —
always route to the best-cached replica — overloads whichever one owns the
popular system prompt; pure balance kills the cache. Production routers split
the difference with that `overlap − load` score and **spill** to a colder
replica when the hot one saturates.

Autoscaling is where LLM serving diverges hardest from ordinary services, for
three reasons that are each a trap:

- **GPU utilization is a useless scaling signal.** Continuous batching pins it
  near 100% whenever *anything* is running, busy or starving. Scale on **queue
  depth, TTFT, and achieved throughput** instead — signals that reflect whether
  you are meeting SLOs, not whether the silicon is warm.
- **Scaling *down* is dangerous.** Retiring a replica does not just drop
  capacity; it **destroys that replica's warm KV cache** and kills its
  in-flight sequences — a cache flush plus a batch of dropped requests,
  reversible only by expensive recompute elsewhere.
- **Cold starts are measured in minutes.** A new replica must load tens to
  hundreds of GB of weights before it serves a single token. You cannot meet a
  traffic spike by booting GPUs; you keep **pre-warmed pools**, because
  scale-to-zero is a fantasy when zero-to-one is a multi-minute weight load.

## Closing the module's arc

Step back and look at what just happened, because it is the same story you
already know — told one level up.

In [PagedAttention](#/paged-kv-cache), the problem was **fragmentation inside a
single GPU**: contiguous KV reservations wasted 60–80% of HBM, and the fix was
the operating system's own move — paging, a block table, a shared pool. Kernel
memory management, rediscovered in one GPU.

This chapter is that identical story at **datacenter scale**. The block table
became fleet-wide block tracking (KVBM, Mooncake's scheduler). The free-page
pool became a tiered hierarchy across HBM, DRAM, and NVMe (LMCache). Demand
paging between tiers became KV *transfer* over RDMA (NIXL, Transfer Engine).
Cache-affine process scheduling became cache-aware *request* routing. The
kernel virtualized memory over scattered frames; the KV fabric virtualizes KV
over scattered *machines*. Fragmentation → paging → tiering → transfer →
routing is one continuous idea, and the object it all orbits is the KV cache.

That is the payoff of the whole course's central asymmetry. Because prefill and
decode want different things, the KV cache had to leave the GPU — and once it
left, it became the distributed object the entire serving stack is built
around. Everything the [next chapter](#/agentic-serving) says about agent
economics is downstream of this: when the cache is the center of gravity, cache
hit rate is the metric that turns architecture into dollars.

## What to remember

- **PD disaggregation** gives prefill (compute-bound) and decode
  (memory-bound) their own GPU pools, parallelism, and hardware — at the cost
  of **shipping KV** between pools. **The decision is arithmetic:**
  disaggregate when interference saved > `KV_size / link_bandwidth`. A 4K-token
  70B prompt ships in ~26 ms over RDMA (easy); a 128K context is ~43 GB and can
  rival decode time. A **regime, not a religion** — low load and decode-heavy
  reasoning models often want colocation or asymmetric (1P3D) ratios.
- **DistServe** = goodput-driven independent provisioning; **Splitwise** =
  heterogeneous hardware per phase; **Mooncake** = a fleet-wide KV pool from
  spare DRAM/SSD, KVCache-centric scheduling, early rejection under overload.
- **Dynamo** is an inference OS above the engines: **Smart Router**
  (`overlap − load`), **KV Block Manager** (fleet-wide + tiered offload),
  **NIXL** (non-blocking VRAM→VRAM over RDMA/RoCE/NVMe-oF). **llm-d** is the
  K8s-native equivalent via the Inference Gateway.
- **KV tiering** is the memory hierarchy one level up: HBM → DRAM → NVMe →
  recompute. **LMCache** is the standard open layer; restoring often beats
  recompute. Beware the **physical-vs-logical hit-rate gap** — an evicted "hit"
  is a miss. **Routing is cache management** (round-robin destroys prefix
  caches); autoscaling is hard because GPU util is useless, scale-down flushes
  warm cache, and cold starts are minutes of weight loading.
- The module's arc: **fragmentation → paging** was kernel memory inside one
  GPU; **tiering → transfer → routing** is the same story at datacenter scale.
  The KV cache is the center of gravity of modern serving.

```quiz
[
  {
    "q": "Chunked prefill already shares a batch between prefill and decode. What does prefill/decode disaggregation do that chunked prefill does not?",
    "choices": [
      "It compresses the KV cache so it fits in less HBM",
      "It puts prefill and decode on separate GPU pools with independent parallelism and hardware, at the cost of transferring KV between them over the network",
      "It eliminates the KV cache entirely by recomputing attention each step",
      "It runs prefill and decode on the same GPU but in separate CUDA streams"
    ],
    "answer": 1,
    "explain": "Chunked prefill interleaves the phases on one pool, so every prefill chunk still steals bandwidth from decodes. Disaggregation gives each phase its own pool, count, parallelism, and hardware tier — which forces the prefill pool to ship each request's computed KV cache to the decode pool over RDMA."
  },
  {
    "q": "A 70B model in fp16 holds ~320 KiB of KV per token. Why is disaggregation an easy win for a 4,000-token prompt but questionable for a 128,000-token one?",
    "choices": [
      "Long prompts can't be tensor-parallelized",
      "The 4K KV is ~1.3 GB (ships in ~26 ms over RDMA), while the 128K KV is ~43 GB and its transfer time can rival the decode work it was meant to protect",
      "Decode is compute-bound for long prompts and memory-bound for short ones",
      "The KV cache for long prompts must be recomputed, not transferred"
    ],
    "answer": 1,
    "explain": "Transfer cost is KV_size / link_bandwidth, and KV size scales with prompt length. A 1.3 GB transfer over ~50 GB/s RDMA is ~26 ms — trivial next to the interference it removes. A 43 GB transfer is tens-to-hundreds of ms and, on a slow fabric, can approach the decode time itself, so the trade stops paying."
  },
  {
    "q": "Why does a naive 1-prefill-1-decode (1P1D) split waste GPUs on long chain-of-thought reasoning workloads?",
    "choices": [
      "Reasoning models have larger weights that don't fit on decode GPUs",
      "Long-CoT requests are decode-dominated (thousands of output tokens per short prompt), so a symmetric split leaves prefill GPUs mostly idle — asymmetric ratios like 1P3D or plain colocation fit better",
      "Reasoning models cannot use RDMA to transfer KV",
      "The KV cache for reasoning outputs cannot be paged"
    ],
    "answer": 1,
    "explain": "Disaggregation is a regime, not a religion. When generation vastly outweighs prompt length, the workload is overwhelmingly decode, so a 1:1 pool ratio starves the prefill pool. Matching the ratio to the real prompt:generation shape (1P3D, 1P4D) or colocating at low load recovers the wasted silicon."
  },
  {
    "q": "Mooncake's KVCache-centric architecture builds a fleet-wide KV pool. Out of what?",
    "choices": [
      "Extra HBM added to every decode GPU",
      "The spare CPU DRAM and idle SSD sitting next to GPUs across the whole fleet, made RDMA-addressable as one pooled KV store",
      "A single dedicated storage server with terabytes of RAM",
      "Compressed KV blocks kept only in each GPU's local HBM"
    ],
    "answer": 1,
    "explain": "Mooncake's insight is that summed across hundreds of nodes, spare DRAM and SSD dwarf total HBM. Pooling it into an RDMA-addressable KVCache store lets a prefix computed for one request be reused by another, with a KVCache-centric scheduler placing and locating blocks and rejecting requests early under overload."
  },
  {
    "q": "Why is round-robin load balancing actively harmful for LLM serving, and why is GPU utilization a bad autoscaling signal?",
    "choices": [
      "Round-robin is too slow; GPU utilization updates too infrequently",
      "Round-robin ignores which replica already holds a request's prefix (re-running prefills it could have reused), and continuous batching pins GPU utilization near 100% whenever anything runs, so it never signals SLO pressure",
      "Round-robin overloads the network; GPU utilization double-counts KV transfers",
      "Both are fine; the real problem is only cold starts"
    ],
    "answer": 1,
    "explain": "Prefix caches make replicas non-interchangeable, so routing must be cache-aware (score cache overlap minus load) — round-robin throws the cache away. And because batching keeps the GPU busy whether it is meeting SLOs or starving, you must scale on queue depth, TTFT, and throughput, not utilization."
  }
]
```
