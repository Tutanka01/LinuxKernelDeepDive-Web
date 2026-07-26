# The KV Fabric

> **Goal of this chapter:** see the moment the KV cache stopped being a per-GPU
> buffer and became the field's central *distributed object*. By the end you will
> know how a fleet-wide KV pool is built and out of what, what a transfer layer
> has to do, the arithmetic that decides at every tier whether to restore a block
> or rebuild it, why routing became cache management, and why every autoscaling
> instinct you brought from ordinary services is wrong here. "The KV cache is the
> center of gravity of modern serving" should stop being a slogan and become an
> architecture you can draw.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="router,kv,fabric"></div>

[Disaggregated Serving](#/disaggregation) ended with a decision: split prefill
from decode, and accept that the KV cache must cross a network. This chapter is
everything that follows from having said yes.

The consequence is larger than it sounds. A local buffer has no interesting
questions attached to it — it is allocated, used, freed. A piece of state that
*travels* has all of them at once. Where does it live? Who else has a copy? How
do you find it? What happens when memory pressure evicts it? And, the question
that reorganizes the whole datacenter: given that this request's bytes are
already somewhere, **which machine should serve it?** Your distributed-systems
instincts should be lighting up. They should be; that is exactly what happened to
the field.

## Mooncake: the KV cache as fleet-wide storage

Once KV is a movable object, a bigger idea appears. Look across your whole
serving fleet: every node has **spare CPU DRAM and idle SSD** sitting next to
its GPUs. Individually trivial; summed over hundreds of nodes, it is an
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

Take the general form of the idea seriously, because it is where the field is
heading. A **global KV store** is a fleet-scoped, content-addressed cache: blocks
keyed by the hash of the token prefix that produced them, so any replica can ask
"does anyone hold the KV for this prefix?" and get an answer that does not depend
on which machine originally computed it. That single change decouples three
things that used to be welded together — *who computed a prefix*, *who stores
it*, and *who serves the request that needs it*. Prefix reuse stops being a
per-replica accident and becomes a fleet-wide property, which for workloads with
shared system prompts or shared documents is worth more than any other
optimization in this module.

It is not free, and the costs are the ordinary costs of a distributed cache:
metadata for hundreds of millions of blocks, an eviction policy across tiers that
does not thrash, and a lookup that has to complete inside your TTFT budget — a
cache index you must cross the network to consult has bought you a network round
trip whether or not you hit. The systems above all make the same bet: at frontier
scale, a fleet-wide hit rate is worth those costs.

> [!bridge] You already know this — from the distributed systems course
> A pool where any node may hold a copy of a block raises the replication
> questions verbatim: how many copies, who owns them, how a reader finds one,
> and what happens when the copy it wanted is gone. What differs is the stakes.
> A missing or stale KV block is never a correctness bug, because the fallback
> is always to recompute it — so this cache is tuned entirely for latency and
> hit rate, and every consistency argument you would normally have simply does
> not arise.
> [→ Distributed: Replication](../distributed/#/replication)

## The transfer layer

A pooled cache is only as good as the thing that moves bytes into and out of it,
and "move bytes" is doing a lot of work in that sentence. The transfer layer for
KV has an awkward job specification:

- **Source and destination are usually GPU memory**, so a naive path stages
  through host RAM twice and doubles the cost. You want VRAM→VRAM.
- **It must not block the compute stream.** A GPU that stalls its matmuls to
  service a network transfer has converted a bandwidth problem into a latency
  problem for every other request in its batch.
- **It must span several transports** — RDMA over InfiniBand or RoCE between
  nodes, NVLink inside one, NVMe-oF down to storage, plain TCP where nothing
  better exists — behind one API, because the placement decision above it should
  not have to know which.
- **It moves scattered blocks, not contiguous buffers.** After
  [PagedAttention](#/paged-kv-cache), a sequence's KV is a list of blocks
  anywhere in a pool, so a transfer is a gather/scatter over many small regions,
  and small-message efficiency matters as much as peak bandwidth.

**NIXL** (NVIDIA Inference Xfer Library) is the current standard answer to that
specification, and **Mooncake's Transfer Engine** is the other. Both present a
uniform API over the transports, do non-blocking zero-copy VRAM→VRAM movement,
and handle the scatter/gather. The reason to name them at all is that this is the
component whose absence made KV transfer a research project rather than a
configuration flag — and its presence is why "ship the KV" is now a line in a
config file.

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
  memory hierarchy. It is the paged block table of
  [PagedAttention](#/paged-kv-cache), lifted from one GPU to the datacenter.
- **NIXL** — the plumbing described above, doing **non-blocking VRAM→VRAM**
  moves so a GPU ships KV without stalling its compute stream.

> **State of play (mid-2026):** Dynamo 1.0 went GA in March 2026 (NVIDIA quotes
> up to 7× on Blackwell for disaggregated MoE — a vendor figure, treat as a
> ceiling). Named adopters include Cursor, Perplexity, Baseten, Deep Infra,
> Fireworks, ByteDance, and Meituan, with the major clouds and neoclouds
> (CoreWeave, Together, Nebius) offering it. **llm-d** is the Kubernetes-native
> counterpart (Red Hat–led, Google/NVIDIA/IBM/CoreWeave): vLLM workers behind
> the official K8s **Inference Gateway** — model-aware, KV-cache-aware routing
> and PD disaggregation expressed as Gateway-API extensions rather than a
> bespoke control plane. Same ideas, two front doors.

## KV tiering, and the crossover rule

You have internalized memory hierarchies since the kernel course — each tier
slower and larger than the last. The KV fabric is that hierarchy rebuilt for
cache blocks:

```text
   HBM        hot   — active KV, last ~30 s of a live request   (fastest, tiny)
   CPU DRAM   warm  — reusable prefixes, ~30 s to minutes        (PCIe hop away)
   NVMe SSD   cold  — long-tail prefixes, minutes+               (big, cheap)
   recompute  gone  — not stored; pay prefill FLOPs to rebuild   (last resort)
```

> [!bridge] You already know this — from the Linux course
> This is the page cache with different nouns: a small fast tier, a large slow
> one, and a reclaim policy deciding what gets demoted as pressure rises. What
> differs is the bottom of the stack. A reclaimed page can always be read back
> from the file it came from, so eviction is cheap by construction; an evicted
> KV block has no backing file, and the only way to get it back is a prefill you
> pay for again. That is why the tier below the last real tier is labelled
> "recompute" rather than "disk".
> [→ Linux: Virtual Memory](../#/memory)

**LMCache** is the standard open layer that implements this for vLLM
(HBM → CPU DRAM → SSD → remote, with cross-node P2P sharing). The key question
at every boundary: **is restoring a block cheaper than recomputing it?** Do the
arithmetic. Our 70B/128K KV is ≈ 43 GB; PCIe Gen5 moves ~64 GB/s, so restoring
it from CPU DRAM to HBM costs:

```text
  43 GB ÷ 64 GB/s ≈ 670 ms  (restore)
```

Recomputing that same 128K prefill from scratch is a **compute-bound pass over
128K tokens** — `2 × 70e9 × 131,072 ≈ 1.8 × 10^16` FLOPs, or ~18,400 TFLOP,
which at a realistic 400 TFLOP/s of achieved prefill throughput is tens of
seconds of GPU time on one device, and it burns a prefill slot you could have
given a new request. Hundreds of milliseconds of PCIe traffic to skip that is a
trade you take. That is the whole case for tiering: **KV is expensive to make and
cheap to move**, so keep it and haul it rather than rebuild it.

Now generalize it, because the general form is more useful than the example.
Both sides of the comparison scale linearly with the number of tokens, so the
context length **cancels**, and the crossover is a property of the model and the
tier alone:

```text
  restore wins  ⟺   kv_bytes_per_token / tier_bandwidth  <  2·P / achieved_FLOP/s
```

Put the 70B in: `2·P / achieved` is `140 GFLOP ÷ 400 TFLOP/s ≈ 0.35 ms` of
recompute per token, against `320 KiB ÷ tier_bandwidth` of restore per token.
Solve for the bandwidth at which they tie:

```text
  crossover bandwidth  =  0.328 MB ÷ 0.35 ms  ≈  0.94 GB/s
```

**Any tier faster than about 1 GB/s beats recomputing a 70B's KV.** CPU DRAM over
PCIe (~64 GB/s) wins by ~68×. NVMe (~7 GB/s) wins by ~7×. Even a remote object
store over a 10 Gb/s link (~1.2 GB/s) barely wins. That is why the tiering stack
goes as deep as it does: there is almost no storage medium slow enough to lose to
recompute for a large model.

Two consequences worth holding. First, **small models flip the sign much more
easily.** An 8B model recomputes at `16 GFLOP ÷ ~300 TFLOP/s ≈ 0.053 ms/token`
against 131 KB/token of KV, giving a crossover near **2.5 GB/s** — NVMe still
wins, but the margin has collapsed, and anything remote loses. Tiering is a
large-model technique for the same reason disaggregation is. Second, the
comparison above ignores what else the recompute would have displaced: rebuilding
a prefix does not merely cost its own FLOPs, it occupies a prefill slot and delays
somebody's TTFT. Include that and restore wins by more than the arithmetic says.

> **Common trap: the physical-vs-logical hit-rate gap.** A router can report a
> "99% logical hit rate" — 99% of requests *had* a reusable prefix somewhere —
> while delivering nothing, because HBM was full and the block had already been
> **evicted**, forcing a recompute. A logical hit that isn't physically
> resident is a miss with extra steps. Tiering exists precisely to turn logical
> hits into physical ones: catch the evicted block in DRAM or NVMe instead of
> recomputing it. Measure the hit rate that ends in *restored bytes*, not the
> one that ends in *found a match*.

That gap is easier to believe once you have caused it. Pick the RAG or agent
workload below, leave prefix caching on, and then drag the KV pool down: the
prefix is exactly as shared as it was a moment ago, but once blocks start
getting evicted to make room for live sequences, TTFT climbs back toward its
uncached value. Nothing about the *logical* hit rate changed.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

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

Sit with what the tension actually is, because it is not a tuning detail. Cache
affinity makes replicas **non-interchangeable**, and load balancing is an
algorithm that assumes they are interchangeable. Every load-balancing result you
know — least-connections, power-of-two-choices, consistent hashing — was derived
under an assumption this workload violates. The popular prefix is popular *for
everyone*, so affinity concentrates load exactly where load is already highest,
and a naive affinity router produces a hotspot as reliably as a hash collision.
The `overlap − load` score is the field's practical answer: a soft affinity that
degrades to balance under pressure. And a pooled KV store weakens the tension
from the other side — if any replica can *fetch* a prefix from the pool cheaply,
then routing away from the cached replica costs a restore rather than a
recompute, which by the crossover rule above is a much smaller penalty.

> [!bridge] You already know this — from the distributed systems course
> Consistent hashing exists for exactly this reason: keep a key on the node that
> already caches it, and bound the reshuffle when membership changes. The
> `overlap − load` score is a softened version of the same instinct. What
> differs is the key. A prefix is variable-length and matches *partially* — two
> requests can share 800 tokens and diverge after — so there is no single node a
> request hashes to, only a ranking of replicas by how much of it they already
> hold.
> [→ Distributed: Partitioning & Sharding](../distributed/#/partitioning)

Autoscaling is where LLM serving diverges hardest from ordinary services, for
three reasons that are each a trap:

- **GPU utilization is a useless scaling signal.** Continuous batching pins it
  near 100% whenever *anything* is running, busy or starving. Scale on **queue
  depth, TTFT, and achieved throughput** instead — signals that reflect whether
  you are meeting SLOs, not whether the silicon is warm.
- **Scaling *down* is dangerous.** Retiring a replica does not just drop
  capacity; it **destroys that replica's warm KV cache** and kills its
  in-flight sequences — a cache flush plus a batch of dropped requests,
  reversible only by expensive recompute elsewhere. A pooled KV store softens
  this considerably: if the replica's blocks were also written to the fleet pool,
  retiring it loses a copy rather than the only copy.
- **Cold starts are measured in minutes.** A new replica must load tens to
  hundreds of GB of weights before it serves a single token. You cannot meet a
  traffic spike by booting GPUs; you keep **pre-warmed pools**, because
  scale-to-zero is a fantasy when zero-to-one is a multi-minute weight load.

A fourth trap belongs with them, and it is specific to disaggregation: **the two
pools scale independently, and a change in traffic shape moves the ratio without
moving the volume.** A product change that lengthens outputs adds decode load and
no prefill load at all. An autoscaler watching aggregate request rate sees a flat
line while your decode pool saturates and your prefill pool idles. Scale the
pools on their own signals — prefill on queue depth and TTFT, decode on batch
occupancy and ITL — or you will scale the wrong half.

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

- **Mooncake** builds a fleet-wide KV pool out of the spare CPU DRAM and idle SSD
  next to every node's GPUs — RDMA-addressable, KVCache-centric scheduling,
  prediction-based early rejection under overload. Generalized, that is a
  **global KV store**: content-addressed by prefix hash, decoupling who computed
  a prefix from who stores it and who serves it.
- **The transfer layer** (NIXL, Mooncake's Transfer Engine) must be VRAM→VRAM,
  non-blocking, multi-transport (RDMA/RoCE, NVLink, NVMe-oF, TCP), and good at
  scatter/gather over paged blocks. Its existence is why KV transfer is a config
  flag rather than a research project.
- **Dynamo** is an inference OS above the engines: **Smart Router**
  (`overlap − load`), **KV Block Manager** (fleet-wide tracking + tiered offload),
  **NIXL** (the plumbing). **llm-d** is the K8s-native equivalent via the
  Inference Gateway.
- **KV tiering** is the memory hierarchy one level up: HBM → DRAM → NVMe →
  recompute, with **LMCache** the standard open layer. The **crossover rule** —
  restore wins when `kv_bytes_per_token / tier_bandwidth < 2·P / achieved_FLOP/s`
  — has the context length cancel out, so it is a property of the model and tier.
  For a 70B that threshold is ~1 GB/s, so essentially every tier beats recompute;
  for an 8B it is ~2.5 GB/s and remote tiers lose.
- Beware the **physical-vs-logical hit-rate gap**: an evicted "hit" is a miss with
  extra steps. Measure restored bytes, not matches found.
- **Routing is cache management.** Round-robin destroys prefix caches; affinity
  creates hotspots, because the popular prefix is popular for everyone. Every
  load-balancing result you know assumes replicas are interchangeable, and cache
  affinity makes them not. `overlap − load` with spill is the practical answer,
  and a pooled store softens the tension by making a routing miss a restore
  rather than a recompute.
- **Autoscaling traps:** GPU utilization is pinned near 100% by continuous
  batching and signals nothing; scaling down flushes warm cache and kills
  in-flight sequences; cold starts are minutes of weight loading, so pre-warmed
  pools are mandatory; and the two disaggregated pools must be scaled on separate
  signals, because traffic shape can shift the ratio without changing the volume.
- The module's arc: **fragmentation → paging** was kernel memory inside one GPU;
  **tiering → transfer → routing** is the same story at datacenter scale. The KV
  cache is the center of gravity of modern serving.

## Frequently asked

<div class="faq">

<details>
<summary>If a fleet-wide KV pool is so much larger than HBM, why not keep everything forever?</summary>

Two limits. The first is metadata and lookup: hundreds of millions of blocks need
an index, and that index has to answer inside your TTFT budget — a cache you must
cross the network to consult has cost you a round trip whether you hit or miss.
The second is that value decays. A prefix nobody has touched in an hour is
occupying space a live prefix wants, and the hit rate of the long tail is low
enough that eviction costs almost nothing. Tiering is the compromise: demote
rather than delete, until the tier is slow enough that recompute wins.

</details>

<details>
<summary>Is a KV block from one replica usable on another?</summary>

Only if the two agree on everything that produced it: the same model weights, the
same quantization and KV dtype, the same tensor-parallel rank layout, and the same
block size. KV is a function of the model and the tokens, so identical tokens on
an identical deployment give identical blocks — which is exactly what makes
content-addressing by prefix hash work. It also means a rolling upgrade
invalidates the entire pool, and that a heterogeneous fleet has as many disjoint
cache namespaces as it has configurations.

</details>

<details>
<summary>Do I need any of this if I run one replica?</summary>

No, and that is the honest scope of this chapter. One replica has no routing
problem, no placement problem, and no fabric. What does carry down is the tiering
arithmetic: offloading cold prefix blocks from HBM to host DRAM is worth it on a
single machine for the same reason it is worth it across a fleet, and LMCache
will do it for you. Everything else here is a frontier-scale answer to a
frontier-scale problem.

</details>

</div>

```quiz
[
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
  },
  {
    "q": "The crossover rule for KV tiering is: restore wins when kv_bytes_per_token / tier_bandwidth < 2·P / achieved_FLOP/s. Why does the request's context length not appear in it?",
    "choices": [
      "Because restore time is constant regardless of how much KV there is",
      "Because both restore time and recompute time scale linearly with the number of tokens, so the length cancels — the crossover is a property of the model and the tier alone",
      "Because prefill FLOPs scale quadratically with length while restore scales linearly",
      "Because only the last block of a sequence is ever restored"
    ],
    "answer": 1,
    "explain": "Restoring T tokens costs T × kv_bytes_per_token / bandwidth; recomputing them costs T × 2·P / achieved FLOP/s. T divides out. For a 70B at ~400 TFLOP/s achieved, the tie-point bandwidth is ~0.94 GB/s, so essentially every tier — DRAM at ~64 GB/s, NVMe at ~7 GB/s — beats recompute. For an 8B the threshold is ~2.5 GB/s and remote tiers stop winning, which is why tiering is a large-model technique."
  },
  {
    "q": "A router reports a 99% prefix cache hit rate, yet TTFT is no better than with round-robin. What is the most likely explanation?",
    "choices": [
      "The router is measuring hit rate on the wrong model",
      "It is reporting the logical hit rate — a reusable prefix existed somewhere — while the blocks had been evicted from HBM and were never physically restored, so each 'hit' ended in a recompute",
      "Prefix caching only helps decode, not TTFT",
      "The RDMA fabric is saturated by weight loading"
    ],
    "answer": 1,
    "explain": "The physical-vs-logical hit-rate gap. A logical hit means a match was found; a physical hit means bytes were actually restored into HBM in time to skip the prefill. Under memory pressure the block pool evicts, and a logical hit becomes a miss with an extra lookup. Tiering exists to convert logical hits into physical ones by catching evicted blocks in DRAM or NVMe. Measure restored bytes."
  },
  {
    "q": "What problem does a transfer library like NIXL or Mooncake's Transfer Engine actually solve?",
    "choices": [
      "It compresses KV blocks so fewer bytes cross the network",
      "It provides non-blocking, zero-copy VRAM→VRAM movement over a single API spanning RDMA/RoCE, NVLink, NVMe-oF and TCP, with scatter/gather over paged blocks — so shipping KV neither stages through host RAM nor stalls the compute stream",
      "It decides which replica should serve each request",
      "It replaces the block table with a flat contiguous allocation"
    ],
    "answer": 1,
    "explain": "The job specification is awkward: source and destination are GPU memory (so staging through host RAM doubles the cost), the compute stream must not stall, several transports must hide behind one API, and after PagedAttention a sequence's KV is scattered across many small blocks rather than one buffer. NIXL and the Transfer Engine handle exactly that, which is why 'ship the KV' became a config flag. Placement and routing are separate layers above it."
  }
]
```
