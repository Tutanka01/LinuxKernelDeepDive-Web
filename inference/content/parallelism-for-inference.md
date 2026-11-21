# Parallelism for Inference

> **The question:** when one GPU is not enough — for the weights, for the cache,
> or for speed — how do you split a model across several, and how do the wires
> between them decide which split works?
>
> **You'll be able to:** name which of three limits a split relieves; derive why
> tensor parallelism costs two all-reduces per layer and price them for decode
> and for prefill on a given link; read a node's topology and choose between one
> large replica and several small ones.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="fabric,runner"></div>

So far the course has mostly lived on one GPU. A single GPU runs out in three
different ways, and it is worth keeping them apart because they have different
answers:

1. **The weights do not fit.** Llama-3.3-70B in BF16 is 141 GB; an H100 holds 80 GB.
2. **The weights fit, but the cache does not.** A model that fits with 20 GB to
   spare can hold only a few long conversations' KV.
3. **It is too slow.** Decode time is weight bytes ÷ bandwidth. Two GPUs each
   reading half the weights have twice the bandwidth.

Every way of splitting a model is a pattern of communication between GPUs, so the
wires come first.

## Islands and sea

Vendors quote links in two conventions, and mixing them is the commonest error in
this arithmetic. NVIDIA's "900 GB/s" for H100 NVLink counts both directions, as does
its "128 GB/s" for PCIe Gen5 ([H100](https://www.nvidia.com/en-us/data-center/h100/));
its NVLink page calls the Rubin figure "3 TB/s bidirectional"
([NVLink](https://www.nvidia.com/en-us/data-center/nvlink/)). A network port is
quoted per direction: 400 Gb/s is 50 GB/s each way. Put everything per direction,
per GPU:

```text
  Link                       Where                          Per GPU, each way
  ─────────────────────────  ─────────────────────────────  ────────────────────────────
  NVLink 4 (H100)            GPU ↔ GPU inside the node      ~450 GB/s  (quoted 900)
  NVLink 5 (Blackwell)       GPU ↔ GPU inside the domain    ~900 GB/s  (quoted 1.8 TB/s)
  PCIe Gen5 x16              GPU ↔ host, or GPU ↔ GPU       ~64 GB/s   (quoted 128)
  InfiniBand NDR / 400 GbE   node ↔ node, one NIC per GPU   ~50 GB/s
```

A DGX H100 has one 400 Gb/s ConnectX-7 card per GPU for its compute fabric
([DGX H100 user guide](https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html)).
Like for like, leaving the node divides each GPU's bandwidth by about **9** — by 18 or
more on instances with slower or fewer cards — and each message pays several times
the latency. The topology is a fast **island** (8 GPUs on Hopper, a whole rack on
Blackwell NVL72) in a slow sea. Chatty communication must stay on the island.

![Two eight-GPU NVLink islands at about 450 GB/s per GPU in each direction, joined by InfiniBand or RoCE at about 50 GB/s per GPU in each direction through one NIC per GPU — roughly a tenfold bandwidth cliff at the node boundary](assets/diagrams/interconnect-islands-v3.svg)

You do not have to take a node's topology on trust. `nvidia-smi topo -m` prints it
as a matrix; this is a DGX H100:

```plaintext
        GPU0  GPU1  GPU2  GPU3  GPU4  GPU5  GPU6  GPU7  NIC0  NIC1  NIC2  NIC3  …  CPU Affinity    NUMA Affinity
GPU0     X    NV18  NV18  NV18  NV18  NV18  NV18  NV18  PXB   NODE  NODE  NODE  …  0-55,112-167    0
GPU1    NV18   X    NV18  NV18  NV18  NV18  NV18  NV18  NODE  NODE  NODE  PXB   …  0-55,112-167    0
…
GPU4    NV18  NV18  NV18  NV18   X    NV18  NV18  NV18  SYS   SYS   SYS   SYS   …  56-111,168-223  1
…
```

*Verbatim — trimmed (rows GPU2–3 and GPU5–7, NIC columns 4–55 and the `GPU NUMA ID` column omitted, spacing normalised); `nvidia-smi topo -m` on DGX H100 nodes in NVIDIA's [DGX BasePOD deployment guide](https://docs.nvidia.com/dgx-basepod/deployment-guide-dgx-basepod/latest/nvlink.html), checked 2026-11-21.*

`NV18` means a bonded set of 18 NVLinks: every pair talks at full NVLink speed. On
other machines look for the slower codes: `PIX`/`PXB` (one or several PCIe bridges),
`NODE` (PCIe across one socket's host bridges), `SYS` (PCIe plus the inter-socket
link). Read the row for GPU4: its path to NIC0–NIC3 is `SYS`, so its traffic should
leave through a NIC on its own socket, and the last columns say which cores to pin
its process to. Instance types with the same name can differ; run it once per type.

> [!bridge] From the Linux course
> NUMA taught you that memory is not uniform: reaching across a socket costs, so you
> pin threads and allocate locally. The same reasoning applies here with a larger
> penalty — remote NUMA might cost 1.5–2× in latency; leaving the NVLink island costs
> about 10× in bandwidth per GPU and several times the latency. Pinning is optional
> tuning on a server; keeping a tensor-parallel group on one island is not optional.
> [→ Linux: NUMA Deep Dive](../#/numa-deep-dive)

## Tensor parallelism: every layer, split twice

**Tensor parallelism (TP)** cuts inside each layer, and the way it cuts decides what
it must communicate. Take the MLP from [Inside a Forward
Pass](#/inside-a-forward-pass): an "up" matrix that widens each token from 8,192 to
28,672 numbers, an elementwise activation, and a "down" matrix that narrows it back.

- Split **up** by **columns**: GPU `r` gets a quarter of the 28,672 outputs, and its
  quarter of the hidden values is *finished*; the elementwise activation applies
  without asking anyone. No communication.
- Split **down** by the matching **rows**: GPU `r` consumes exactly the hidden values
  it owns and produces a full-width vector that is only a *partial sum*.

Adding the partial sums is the **all-reduce**: every GPU starts with an array and
ends holding the element-wise sum of all of them. Nobody proceeds until everyone has
contributed, so it moves at the pace of the slowest member. Columns-then-rows is what
makes it *one* all-reduce per block, not one per matrix:

```python
import math, random
random.seed(1)
d, f, N = 8, 32, 4               # model width, MLP width, GPUs in the group
x  = [random.gauss(0, 1) for _ in range(d)]                      # one token
W1 = [[random.gauss(0, 1) for _ in range(f)] for _ in range(d)]  # d x f, "up"
W2 = [[random.gauss(0, 1) for _ in range(d)] for _ in range(f)]  # f x d, "down"
act = lambda v: [a / (1 + math.exp(-a)) for a in v]              # SiLU

def vecmat(v, W, cols):          # v @ W, only the listed output columns
    return [sum(v[i] * W[i][j] for i in range(len(v))) for j in cols]

y_one_gpu = vecmat(act(vecmat(x, W1, range(f))), W2, range(d))

partials = []
for r in range(N):               # GPU r, talking to nobody
    cols = range(r * f // N, (r + 1) * f // N)  # its columns of W1 ...
    h_r = act(vecmat(x, W1, cols))              # ... give finished h values
    W2_r = [W2[j] for j in cols]                # the matching rows of W2
    partials.append(vecmat(h_r, W2_r, range(d)))  # a full-width partial sum

y_tp = [sum(p[k] for p in partials) for k in range(d)]  # the one all-reduce
print("max |y_tp - y_one_gpu| =", max(abs(a - b) for a, b in zip(y_tp, y_one_gpu)))
print("GPU 0 partial:", [round(v, 2) for v in partials[0][:4]], "...")
print("after the sum:", [round(v, 2) for v in y_tp[:4]], "...")

# --- output of an actual run ---
# max |y_tp - y_one_gpu| = 1.7763568394002505e-15
# GPU 0 partial: [2.06, 0.52, 2.1, 0.51] ...
# after the sum: [6.35, -5.47, 11.62, 3.45] ...
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

Notice GPU 0's partial sum: it looks like an answer and is nowhere near it. The
2 × 10⁻¹⁵ difference from one GPU is rounding — the split reorders additions, nothing
else. vLLM's layers carry these names, `ColumnParallelLinear` and `RowParallelLinear`,
the latter calling the all-reduce
([v0.34.0 `linear.py`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/model_executor/layers/linear.py)).

Attention splits the same way, by heads. The Q, K, V projections are column-parallel,
so each GPU computes whole heads — at TP=4, 16 of Llama's 64 query heads and **2 of
its 8 KV heads** — and the output projection is row-parallel: the second all-reduce.
The KV cache is sharded by KV head as a side effect: 2 × 80 layers × 2 heads × 128 ×
2 bytes = **82 KB per token per GPU**, a quarter of the 328 KB.

> [!predict] Before you read on
> What happens at TP=16 to a model with 8 KV heads — does each GPU store half a head?

It cannot: a head is the unit attention works on. vLLM's QKV layer handles the case
in four lines:

```python
        if tp_size >= self.total_num_kv_heads:
            self.num_kv_heads = 1
            self.num_kv_head_replicas = divide(tp_size, self.total_num_kv_heads)
        else:
            self.num_kv_heads = divide(self.total_num_kv_heads, tp_size)
            self.num_kv_head_replicas = 1
```

*Verbatim — vLLM v0.34.0, `vllm/model_executor/layers/linear.py`, `QKVParallelLinear.__init__`.*

At TP=16 each GPU holds one KV head and every head is stored twice: 41 KB per token
per GPU instead of 20.5, half the capacity the division suggests. The engine's
config makes the same decision in `ModelConfig.get_num_kv_heads`, shown in
[Attention for Serving](#/attention-for-serving), whose first branch covers MLA: a
model that caches one latent per token counts as a single KV head, so *every* rank
stores the whole cache — the reason MLA models run attention data-parallel
([Serving MoE at Scale](#/moe-serving)). Check `num_key_value_heads` in
`config.json` before you pick a TP degree.

## What an all-reduce costs

> [!predict] Before you read on
> Llama-3.3-70B has 80 layers. How many all-reduces does one decode step require under
> TP=4? And at batch 20, how large is each one?

**160 per step**, whatever the batch. Each carries the layer's output activations:
20 sequences × 8,192 numbers × 2 bytes ≈ 330 KB. To price it you need the model
NCCL's own tests are built on ([PERFORMANCE.md](https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md)):
an all-reduce over `n` GPUs moves `2(n−1)/n` times the array across each GPU's link,
plus a fixed cost per operation.

```text
   t  ≈  α  +  2(n−1)/n × S / B        α: latency per operation
                                       S: bytes in the array
                                       B: per-GPU bandwidth, one way ("busbw")
```

Small messages live in α; large ones in the second term. Here is what
`all_reduce_perf` prints for four GPUs on NVLink if α is 8 µs and the achievable
bandwidth is 360 GB/s (80% of the 450 GB/s nameplate):

```shell
$ ./build/all_reduce_perf -b 8 -e 128M -f 8 -g 4
…
#                                                              out-of-place                       in-place
#       size         count      type   redop    root     time   algbw   busbw  #wrong     time   algbw   busbw  #wrong
#        (B)    (elements)                               (us)  (GB/s)  (GB/s)             (us)  (GB/s)  (GB/s)
           8             2     float     sum      -1     8.00    0.00    0.00       0     8.00    0.00    0.00       0
        4096          1024     float     sum      -1     8.02    0.51    0.77       0     8.02    0.51    0.77       0
      262144         65536     float     sum      -1     9.09   28.83   43.25       0     9.09   28.83   43.25       0
     2097152        524288     float     sum      -1    16.74  125.29  187.94       0    16.74  125.29  187.94       0
    16777216       4194304     float     sum      -1    77.91  215.35  323.03       0    77.91  215.35  323.03       0
   134217728      33554432     float     sum      -1   567.24  236.62  354.92       0   567.24  236.62  354.92       0
# Out of bounds values : 0 OK
…
```

*Real format, illustrative values — command from the nccl-tests README and column layout from `src/util.cu` (NVIDIA/nccl-tests, commit b52f9a1efb); rows for 64 B, 512 B and 32 KB trimmed; times computed from t = 8 µs + 1.5 × S / 360 GB/s, not measured.*

The `time` column barely moves from 8 bytes to 256 KB — that is α — and grows with
size only above a few megabytes. Measure your own node before trusting any α here. A
tuned 8-byte all-reduce on eight Hopper GPUs has been reported at ~2.3 µs
([NVIDIA forum, Nov 2025](https://forums.developer.nvidia.com/t/inter-gpu-latency-on-b200-higher-than-on-hopper/352473));
inside a real step, with launch overhead and ranks arriving at different moments,
several microseconds is the honest planning range.

**Decode.** 330 KB sits on the flat part: 8 + 1.5 × 330 KB ÷ 360 GB/s ≈ 9.4 µs, × 160
≈ 1.5 ms per step — most of the gap between rungs 2 and 3 of the case's decode ladder
(12.3 → ~14 ms). Meta reports all-reduce at "up to 30% of end-to-end latency" in its
TP serving ([Meta Engineering, Oct 2025](https://engineering.fb.com/2025/10/17/ai-research/scaling-llm-inference-innovations-tensor-parallelism-context-parallelism-expert-parallelism/)).

**Prefill** is the other regime. A 3,000-token prompt makes each all-reduce
3,000 × 8,192 × 2 B ≈ 49 MB: 8 + 1.5 × 49 MB ÷ 360 GB/s ≈ 0.21 ms, × 160 ≈ **34 ms**
against ~0.27 s of arithmetic, and now bandwidth sets it. (The case's 512-token
chunks make 8.4 MB all-reduces, ~7 ms per chunk step — part of why it plans at 40%
MFU.)

Across a node boundary, decode's small all-reduces cost several times more because
α does; prefill's 49 MB ones cost about ten times more because B does — enough to
double the prefill. Hence the rule: **keep tensor parallelism inside one NVLink
domain.**

The engine picks the algorithm by message size. In vLLM the tensor-parallel group
tries, in order:

```python
    def all_reduce(self, input_):
        fi_ar_comm = self.fi_ar_comm
        use_fi_ar = (
            fi_ar_comm is not None
            and not fi_ar_comm.disabled
            and fi_ar_comm.should_use_fi_ar(input_)
        )
        …
        if use_fi_ar:
            …
            out = fi_ar_comm.all_reduce(input_)
            …
        ca_comm = self.ca_comm
        if (
            ca_comm is not None
            and not ca_comm.disabled
            and ca_comm.should_custom_ar(input_)
        ):
            out = ca_comm.custom_all_reduce(input_)
            …
        pynccl_comm = self.pynccl_comm
        …
        out = pynccl_comm.all_reduce(input_)
```

*Verbatim — trimmed; vLLM v0.34.0, `vllm/distributed/device_communicators/cuda_communicator.py`. Elided branches handle NCCL symmetric memory, ROCm and PCIe-only variants.*

FlashInfer's kernel comes first (default since v0.29; up to 2 MB at TP=4 on an H100),
then vLLM's own **custom all-reduce** — CUDA IPC buffers each GPU reads directly over
NVLink, capped at 32 MB for TP=4 on Hopper, off above eight GPUs — then NCCL. A
330 KB decode all-reduce never touches NCCL; a 49 MB prefill all-reduce does. To see
which link NCCL chose, run with `NCCL_DEBUG=INFO` and look for `via NET/IB/GDRDMA`
rather than `via NET/Socket`, which the vLLM docs call "not efficient"
([parallelism and scaling](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/serving/parallelism_scaling.md)).

TP buys **fit** (each GPU holds `1/N` of the weights), **speed** (each reads `1/N` per
step — minus the all-reduces, and minus some efficiency, since each GPU's matrix
multiplies are `N` times smaller) and **cache**: at the case's 0.90 budget,
Llama-3.3-70B in BF16 at TP=4 leaves ~33 GB per GPU for KV; at TP=2 it does not fit.

## Pipeline and data parallelism

**Pipeline parallelism (PP)** cuts across layers instead: layers 1–40 on one GPU,
41–80 on another. Each token's activations pass from stage to stage in a single
**point-to-point** transfer — at batch 20, the same 330 KB, once per stage boundary
instead of 160 times per step — frugal enough to cross nodes over InfiniBand.

![Side-by-side collectives: an all-reduce where four GPUs each end holding the same summed megabyte-scale tensor twice per layer, versus a point-to-point handoff where one GPU passes a kilobyte-scale activation vector to a single neighbor at each stage boundary](assets/diagrams/collectives.svg)

> [!predict] Before you read on
> A single conversation decodes on a two-stage pipeline. What fraction of the time is
> each GPU busy?

About half. Token `n + 1` cannot start until token `n` has gone through both stages
and been sampled. That idle time is the **pipeline bubble**. Engines fill it with
several batches in flight, one per stage — throughput recovers, but no token gets
faster, and each pays every hop. vLLM's guidance (v0.34) is TP inside each node, PP
across nodes (`--tensor-parallel-size 8 --pipeline-parallel-size 2` for two
eight-GPU nodes), and PP instead of TP on GPUs without NVLink.

**Data parallelism** is whole replicas, each with its own batch, KV cache and prefix
cache. Two TP=2 replicas on four GPUs are data parallelism of degree 2. For a dense
model it costs no communication; it costs a full copy of the weights per replica and
a router that decides which replica gets which request.

## Experts and long contexts

A **mixture-of-experts** model replaces each MLP with many smaller ones and sends
each token to a few. **Expert parallelism (EP)** places experts on different GPUs and
moves each token to the GPUs holding its choices — an **all-to-all**, every GPU
sending a different packet to every other. It has its own chapter, [Serving MoE at
Scale](#/moe-serving).

**Context parallelism (CP)** splits the *sequence*: each GPU takes a range of tokens,
and with **ring attention** the GPUs pass KV blocks (or queries) around a ring,
overlapping transfers with computation. Yang et al. report a **1-million-token
prefill of Llama 3 405B in 77 seconds on up to 128 H100s across 16 nodes, at 93%
parallelisation efficiency** ([arXiv 2411.01783](https://arxiv.org/abs/2411.01783)),
with variants for prefill and decode. **Decode context parallelism** answers the
replication problem above: it shards each sequence's cache along its tokens instead
of its heads and merges the partial attention results. vLLM v0.34 calls it
`--decode-context-parallel-size`; its docs give the extreme case, a DeepSeek model
whose MLA cache has one KV head, stored eight times over at `-tp 8` until `-dcp 8`
removes the duplication ([context parallel deployment](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/serving/context_parallel_deployment.md)).
TensorRT-LLM v1.3 ships the idea as Helix parallelism.

> [!dashboard] The interconnect
> **Utilisation:** `DCGM_FI_DEV_NVLINK_THROUGHPUT_BYTES_PER_SECOND` (dcgm-exporter
> 4.9.0 default set) against the nameplate — low at decode, where all-reduces are
> latency, not bytes. **Saturation:** none — derive it: measured decode step minus
> rung 2's weight-read time is communication and launch overhead; a one-step profile
> shows the all-reduce kernels. **Errors:** `DCGM_FI_DEV_NVLINK_CRC_ERROR_TOTAL` and
> `DCGM_FI_DEV_NVLINK_REPLAY_TOTAL` on Hopper (commented out by default; enable them),
> and `DCGM_FI_DEV_XID_ERROR`.

> [!case] The case: one big replica, or two small ones?
> Halden's node is four NVLinked H100s. With BF16 weights the model needs all four
> (TP=4). With FP8 weights — approved conditionally in
> [Quantization](#/quantization) — 70 GB fits on two, so there is a choice:
>
> | | 1 × TP=4, BF16 | 1 × TP=4, FP8 | 2 × TP=2, FP8 |
> |---|---|---|---|
> | Weights per GPU | 35 GB | 17.5 GB | 35 GB |
> | Decode step, planning rung | ~14 ms | ~8 ms | ~14 ms |
> | KV pool | 132 GB, one pool | 202 GB, one pool | 66 GB × 2 |
> | A GPU fault | service stops | service stops | one replica keeps serving |
> | Prefix cache | one | one | one per replica: route by conversation |
>
> The FP8 TP=4 step is the ladder redone for 17.5 GB per GPU (5.2 ms floor, ~6 ms
> achievable, plus ~1.5 ms of all-reduces). Both FP8 layouts meet the 60 ms TPOT
> promise several times over.
>
> ```bash
> CUDA_VISIBLE_DEVICES=0,1 vllm serve RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
>   --tensor-parallel-size 2 --kv-cache-dtype fp8 \
>   --gpu-memory-utilization 0.90 --max-num-batched-tokens 512 --port 8001
> CUDA_VISIBLE_DEVICES=2,3 vllm serve RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic \
>   --tensor-parallel-size 2 --kv-cache-dtype fp8 \
>   --gpu-memory-utilization 0.90 --max-num-batched-tokens 512 --port 8002
> ```
>
> *Real format, illustrative values — flag names from vLLM v0.34.0
> `vllm/engine/arg_utils.py` and the `CUDA_VISIBLE_DEVICES` usage of its NIXL
> examples; the checkpoint is the FP8 one the case pins (pin its revision in
> production); values are the case's decisions, not a tested configuration.*
>
> **What this settles:** two independent TP=2 servers, Halden's router pinning each
> conversation to one port so its prefix cache stays warm. **The stake** is phase 2:
> its FP8 working set is ~61 GB for the node on average, ~31 GB per replica. If one
> replica dies at the phase-2 peak, the survivor needs those ~61 GB in its 66 GB pool —
> and ~75 GB at a p95 count of sessions, which does not fit. One TP=4 replica would
> hold it in 202 GB and stop entirely on any GPU fault. Halden takes the redundancy
> and carries the overflow to [The KV Fabric](#/the-kv-fabric)'s host-memory tier. If the FP8 evaluation fails, the fallback is BF16 on one
> TP=4 replica, the only BF16 layout that fits.

## Exercises

<div class="exercise">

**Exercise 1.** Someone proposes running Llama-3.3-70B (BF16) at TP=8 across two
four-GPU nodes "for half the decode time". In a node take α = 8 µs, B = 360 GB/s;
across nodes α = 25 µs, B = 40 GB/s per GPU, and 2(n−1)/n = 1.75 for n = 8. Estimate
(a) the decode step at batch 20, from rung 2 of the ladder, for TP=4 in one node and
TP=8 across two; (b) the all-reduce time of a 3,000-token prefill in each. What would
you do with eight GPUs instead?

<details>
<summary>Reveal answer</summary>

(a) TP=4: 12.3 ms + 160 × 9.4 µs ≈ **13.8 ms**. TP=8: weight reads halve to ~6.2 ms,
but each all-reduce is 25 + 1.75 × 330 KB ÷ 40 GB/s ≈ 39 µs, × 160 ≈ 6.3 ms →
**~12.5 ms**. Twice the GPUs for ~1 ms.
(b) TP=4: ≈ **34 ms** against ~0.27 s of arithmetic. TP=8: 160 × (25 µs + 1.75 ×
49 MB ÷ 40 GB/s ≈ 2.2 ms) ≈ **0.35 s**, more than the ~0.14 s of arithmetic eight GPUs
need — the prefill gets *slower* (~0.49 s against ~0.30 s). Run **two TP=4 replicas**,
one per node: the same step, twice the throughput, plus redundancy.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team serves Llama-3.3-70B in FP8 at TP=8 on a rented
eight-GPU PCIe instance and gets a TPOT twice what a vendor reports for an HGX H100
board. `nvidia-smi topo -m` on the instance shows:

```plaintext
        GPU0  GPU1  GPU2  GPU3  GPU4  GPU5  GPU6  GPU7  CPU Affinity  NUMA Affinity
GPU0     X    NV12  PIX   PIX   SYS   SYS   SYS   SYS   0-47          0
GPU1    NV12   X    PIX   PIX   SYS   SYS   SYS   SYS   0-47          0
GPU2    PIX   PIX    X    NV12  SYS   SYS   SYS   SYS   0-47          0
GPU3    PIX   PIX   NV12   X    SYS   SYS   SYS   SYS   0-47          0
GPU4    SYS   SYS   SYS   SYS    X    NV12  PIX   PIX   48-95         1
GPU5    SYS   SYS   SYS   SYS   NV12   X    PIX   PIX   48-95         1
GPU6    SYS   SYS   SYS   SYS   PIX   PIX    X    NV12  48-95         1
GPU7    SYS   SYS   SYS   SYS   PIX   PIX   NV12   X    48-95         1
```

*Real format, illustrative values — matrix layout and link codes as printed by `nvidia-smi topo -m` (compare the DGX H100 output above); this topology is invented for the exercise.*

What is binding, and what layout would you run?

<details>
<summary>Reveal answer</summary>

NVLink joins only **pairs** (0–1, 2–3, 4–5, 6–7). A TP=8 group's 160 all-reduces per
step cross PCIe switches (`PIX`) and the socket link (`SYS`), each at a larger α, and
an all-reduce moves at the pace of its slowest link. The fix follows the islands:
FP8 Llama-3.3-70B fits on two GPUs, so run **four TP=2 replicas**, one per NVLink
pair, each pinned to its socket's cores (`CPU Affinity`). If a model needed four GPUs
here, PP=2 across two pairs would beat TP=4 over `PIX`.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** A 30B dense model in FP8 (30 GB) fits on one 80 GB GPU. You
have a four-GPU node and the case's budget rules (72 GB per GPU, ~3 GB of overhead and
~1 GB of activations per GPU). Compare one TP=4 replica with four TP=1 replicas on
decode latency, throughput and KV capacity.

<details>
<summary>Reveal answer</summary>

**TP=4:** 7.5 GB read per GPU per step — the lowest latency — plus two all-reduces
per layer; KV pool 288 − 30 − 12 − 4 = **242 GB**, one pool. **4 × TP=1:** 30 GB per
step (~9 ms floor, far inside a 60 ms promise), no all-reduces, four batches; KV pool
4 × (72 − 30 − 3 − 1) = **152 GB** in four pools. The single replica has 60% more
cache, because it stores the weights once; the four have redundancy and throughput
but need a router that keeps conversations together. If the working set exceeds
~38 GB per replica, the four-replica layout fails first.

</details>

</div>

<div class="exercise">

**Exercise 4 — find the flaw.** A capacity memo proposes Llama-3.3-70B (BF16) at TP=16
across two eight-GPU H100 nodes: "Each GPU holds 8.75 GB of weights, so decode is
8.75 GB ÷ 3.35 TB/s ≈ 2.6 ms. KV per token per GPU is 328 KB ÷ 16 = 20.5 KB, so the
cache holds 16 times more tokens than on one GPU. Each all-reduce moves 330 KB over
NVLink at 900 GB/s, under a microsecond, so communication is negligible." Find the
errors.

<details>
<summary>Reveal answer</summary>

(1) **KV heads:** 8 heads cannot be split 16 ways; each is replicated on two GPUs —
41 KB per token per GPU, half the claimed capacity. (2) **The link:** a TP=16 group
spans two nodes, so every all-reduce crosses InfiniBand (~50 GB/s each way per GPU);
and 900 GB/s is the two-direction NVLink figure — 450 one way. (3) **α:** at 330 KB the
cost is per-operation latency; 160 cross-node all-reduces at tens of microseconds is
several milliseconds per step, more than the 2.6 ms of weight reads. Run two TP=8
replicas, one per node.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>Can TP be any number?</summary>

It must divide the attention heads — vLLM refuses to start otherwise — and in
practice it is a power of two inside one NVLink island. Above `num_key_value_heads`
it replicates KV heads; decode context parallelism is the remedy if the cache matters.
Whatever you choose, measure the step with `vllm bench serve` at concurrency 1.

</details>

</div>

## What to remember

- One GPU runs out of weight capacity, cache capacity or speed; name which before
  choosing a split.
- Compare links per GPU, per direction: NVLink 4 ~450 GB/s, a 400 Gb/s NIC 50 GB/s —
  about 10× apart, and several times apart in latency.
- TP splits one matrix by columns and the next by rows: two all-reduces per layer, and
  a KV cache sharded by KV head (replicated once TP exceeds the KV heads).
- All-reduce ≈ α + 2(n−1)/n × S/B: decode messages live in α, prefill messages in
  bandwidth — so crossing a node hurts prefill most.
- PP crosses nodes with point-to-point hand-offs; CP shards a sequence, in prefill
  and in decode.
- Several small replicas buy redundancy and throughput; one large replica buys one
  big cache and the lowest per-token latency.

```quiz
[
  {
    "q": "Qwen3-30B-A3B has 48 layers, 4 KV heads and head_dim 128 (BF16 KV, 98 KB per token in total). At TP=8, how much KV does each GPU store per token?",
    "choices": [
      "About 12 KB: one eighth of the 98 KB, as with the weights",
      "About 25 KB: one KV head per GPU, every head stored on two GPUs",
      "About 98 KB: under tensor parallelism every GPU keeps the full cache",
      "About 49 KB: two KV heads per GPU, as the model would have at TP=2"
    ],
    "answer": 1,
    "explain": "With 4 KV heads and 8 ranks, each GPU holds one head (2 × 48 × 1 × 128 × 2 B ≈ 24.6 KB) and each head lives on two GPUs, so the node stores the cache twice. Dividing 98 KB by 8 assumes a head can be split, which it cannot."
  },
  {
    "q": "On four NVLinked GPUs (α ≈ 8 µs, B ≈ 360 GB/s), the decode batch grows from 1 to 64 sequences of an 8,192-wide model. Roughly how does one TP all-reduce's time change?",
    "choices": [
      "It grows about 64 times, from ~8 µs to ~0.5 ms",
      "It halves, because larger messages use bandwidth more efficiently",
      "It is unchanged, since all-reduces do not depend on message size",
      "It grows about 1.5 times, from ~8 µs to ~12 µs"
    ],
    "answer": 3,
    "explain": "The array grows from 16 KB to 1 MB; the bandwidth term goes from ~0.07 µs to ~4.4 µs on top of α ≈ 8 µs, so ~8.1 → ~12.4 µs. Small messages live in the latency term; only multi-megabyte ones scale with size. Message size does matter — just not much below a megabyte."
  },
  {
    "q": "A 70B model runs at TP=8 across two nodes. Decode looks acceptable, but a profile of a 32K-token prefill shows more time in all-reduce than in matrix multiplies. What explains the difference between the phases?",
    "choices": [
      "Prefill all-reduces carry ~0.5 GB each, so the slow inter-node bandwidth sets their time",
      "Prefill issues more all-reduces per layer than decode, about one per token in the chunk",
      "Prefill runs its all-reduces on the CPU while decode keeps them on the GPUs",
      "Prefill all-reduces are latency-bound, and the latency grows with the context length"
    ],
    "answer": 0,
    "explain": "Each all-reduce carries tokens × width × 2 B = 32K × 8,192 × 2 ≈ 0.54 GB, so the bandwidth term dominates and the inter-node link has about a tenth of NVLink's per-GPU bandwidth. The count stays at two per layer whatever the token count; decode's small messages are latency-bound, which crossing nodes hurts less."
  },
  {
    "q": "A hypothetical Rubin node has NVLink 6 quoted at 3 TB/s per GPU (both directions) and one 800 Gb/s NIC per GPU. Like for like, how much wider is the island than the sea?",
    "choices": [
      "About 30 times: the quoted 3 TB/s against the NIC's 100 GB/s",
      "About 4 times: the quoted 3 TB/s against the NIC's 800 Gb/s line rate",
      "About 15 times: 1.5 TB/s each way against 100 GB/s each way",
      "About 60 times: the quoted 3 TB/s against 50 GB/s per direction"
    ],
    "answer": 2,
    "explain": "Put both per direction: 3 TB/s bidirectional is 1.5 TB/s each way; 800 Gb/s is 100 GB/s each way. 1.5 TB/s ÷ 100 GB/s = 15×. Thirty mixes a two-direction figure with a one-direction one; four confuses bits with bytes."
  },
  {
    "q": "A box has eight L40S GPUs with no NVLink, only PCIe. A 70B FP8 model needs at least two of their 48 GB. Which layout fits the links?",
    "choices": [
      "TP=8, so each GPU reads the least weight per step",
      "PP across two or four GPUs per replica, with several replicas",
      "TP=2 pairs chosen at random, since PCIe is uniform across slots",
      "One replica at PP=8, one layer range per GPU, for the lowest latency"
    ],
    "answer": 1,
    "explain": "Without NVLink, TP's 160 all-reduces per step pay PCIe latency every time; PP's few point-to-point hand-offs survive the slow links, and replicas recover throughput. vLLM's docs recommend PP over TP on GPUs without NVLink such as L40S. PP=8 adds seven hops and a deep bubble to every token."
  }
]
```
