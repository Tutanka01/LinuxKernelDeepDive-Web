# FlashAttention & Decode Kernels

> **The question:** why is attention a memory problem rather than an arithmetic
> one — and how do modern kernels compute it *exactly* without ever storing the
> matrix that naive attention depends on?
>
> **You'll be able to:** count the bytes attention moves with and without the
> score matrix, for a real model's shapes; carry out online softmax and the
> split-KV merge by hand; explain how a decode kernel walks a block table, and
> predict how many splits it needs to fill the GPU.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kernels"></div>

Attention, from [Inside a Forward Pass](#/inside-a-forward-pass): every query is
scored against every key, each row of scores goes through a softmax, and the
weights average the values. Written as three array operations over `N` tokens:

```text
   S = Q · Kᵀ        scores    N × N
   P = softmax(S)    weights   N × N
   O = P · V         output    N × d
```

This chapter is about the middle of that — the `N × N` matrices — and the idea
that removed them.

## Naive attention moves bytes it never needed

The tensor cores compute only on data already on the chip, in an SM's registers
and **shared memory** ([The GPU Mental Model](#/gpu-mental-model)). The budget
that matters is per SM, not per chip: on an H100, 228 KB of shared memory and a
256 KB register file (NVIDIA's [Hopper tuning
guide](https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html)). Whatever a
kernel works on at one moment must fit there. The score matrix does not, so a
naive kernel writes `S` to HBM, reads it back to softmax it, writes `P`, and reads
`P` back to multiply by `V`.

> [!predict] Before you read on
> At a 32,768-token context, how large is the score matrix for **one** attention
> head, in 16-bit numbers? Kilobytes, megabytes or gigabytes?

Gigabytes: `32,768² × 2 bytes ≈ 2.1 GB` — per head, per layer. Writing and
reading it twice moves four times that across the HBM bus, all for an
intermediate the output does not contain.

Compare the arithmetic with the traffic. The two matrix multiplies cost about
`4·N²·d` FLOPs. The score traffic is `S` written, `S` read, `P` written, `P` read:
four passes of `N²` numbers at 2 bytes, `8·N²` bytes. The ratio is `d / 2`: for
`head_dim` = 128, **64 FLOPs per byte**, well below the H100's ridge of ~295.
Naive attention is memory-bound because of a matrix it creates for itself.

## Tiling, and the obstacle

The fix is to never write the score matrix. Load a block of queries into shared
memory, stream the keys and values past it a tile at a time, compute that tile's
scores on chip, use them, discard them. What never touches HBM is the `N × N`
matrix. Q is read once and O written once; K and V are streamed once for every
query tile, so they are *requested* `N / B_r` times (for a tile of `B_r` query
rows) — but one head's keys and values are small enough (1.5 MB at 3,000 tokens)
that most of those re-reads are served by the 50 MB L2 cache. The traffic grows
with `N·d` per pass, not with `N²`.

![Naive attention round-trips the N×N score matrix through HBM four times, while FlashAttention keeps score tiles on chip: Q and O cross the HBM boundary once, K and V are streamed once per query tile, and no N×N matrix is ever written](assets/diagrams/flash-tiling-v3.svg)

> [!bridge] From the Linux course
> This is cache blocking: restructure the loop so the working set fits the fast
> tier and the slow tier is touched far less. What differs is that nothing is
> automatic — no hardware cache pulls tiles into shared memory for you. The kernel
> author schedules every load by hand.
> [→ Linux: The Machine Underneath](../#/prereq-hardware)

One thing blocks this. **Softmax needs a whole row.** It divides by the sum of
`exp(score)` over every key, after subtracting the row's maximum to avoid
overflow. Both the maximum and the sum depend on the entire row, but a tile holds
only a few keys. How do you normalise a row before you have seen it?

## Online softmax

Process the keys tile by tile, carrying three things for each query row:

- `m`, the largest score seen so far;
- `ℓ`, the running sum of `exp(score − m)`;
- `o`, the running weighted sum of value vectors, not yet divided by `ℓ`.

When a new tile contains a larger score than `m`, every term accumulated so far
was computed against a maximum that is now too small. They are all off by the same
factor, because

```text
   exp(s − m_old)  =  exp(s − m_new) · exp(m_old − m_new)
```

So you do not redo them: you multiply the old `ℓ` and `o` by `exp(m_old − m_new)`
and continue. **When the maximum moves, rescale what you have.**

Worked: one query, scores `[3, 1, 4, 2]` for four keys, values `[10, 20, 30, 40]`,
in two tiles.

```text
  Tile 1  (scores 3, 1; values 10, 20)
     m = 3
     ℓ = exp(0) + exp(−2)            = 1.000 + 0.135 = 1.135
     o = 1.000·10 + 0.135·20                          = 12.707
```

> [!predict] Before you read on
> Tile 2 has scores 4 and 2. By what factor must the tile-1 accumulators be
> rescaled before tile 2 is added?

By `exp(3 − 4) = 0.368`, since the maximum moved from 3 to 4:

```text
  Tile 2  (scores 4, 2; values 30, 40)
     rescale:   ℓ = 1.135 × 0.368 = 0.418     o = 12.707 × 0.368 = 4.675
     add:       ℓ = 0.418 + exp(0) + exp(−2)            = 1.553
                o = 4.675 + 1.000·30 + 0.135·40         = 40.088
  Finish:      O = o ÷ ℓ = 40.088 ÷ 1.553 = 25.81
```

![Four states of the online-softmax walkthrough for scores 3, 1, 4, 2: initial accumulators, tile one, the rescale when the running max moves from 3 to 4, and the folded-in final result 25.81](assets/diagrams/online-softmax.svg)

A full softmax over all four scores gives `ℓ = 1.553` and `O = 25.81` — the same.
Four scores prove little. The program below runs a 3,000-key row (Ask Halden's
prompt length) in tiles of 128, then does something the kernel's decode variant
needs: it computes the two halves of the row independently and merges them.

```python
import math, random
random.seed(0)
N = 3000                                        # keys seen by one query row
s = [random.gauss(0, 4) for _ in range(N)]      # scores q·k / sqrt(d)
v = [random.gauss(0, 1) for _ in range(N)]      # one value channel

m = max(s)                                      # one shot: needs the whole row first
w = [math.exp(x - m) for x in s]
direct = sum(wi * vi for wi, vi in zip(w, v)) / sum(w)

def online(lo, hi, tile=128):                   # running state (m, l, o), tile by tile
    m, l, o = -math.inf, 0.0, 0.0
    for t in range(lo, hi, tile):
        m_new = max(m, max(s[t:min(t + tile, hi)]))
        scale = math.exp(m - m_new)             # the max moved: rescale what you have
        l, o = l * scale, o * scale
        for j in range(t, min(t + tile, hi)):
            p = math.exp(s[j] - m_new)
            l, o = l + p, o + p * v[j]
        m = m_new
    return m, l, o

m1, l1, o1 = online(0, N)
print(f"one shot  {direct:.12f}\nonline    {o1 / l1:.12f}")
(ma, la, oa), (mb, lb, ob) = online(0, 1500), online(1500, N)   # split-KV: two halves
M = max(ma, mb)                                                 # merge with the same rule
L = la * math.exp(ma - M) + lb * math.exp(mb - M)
O = oa * math.exp(ma - M) + ob * math.exp(mb - M)
print(f"split-KV  {O / L:.12f}")

# one shot  -0.452951200300
# online    -0.452951200300
# split-KV  -0.452951200300
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

The last four lines are the whole of the merge: each half reports its own
`(m, ℓ, o)`, and the merge rescales both to the larger maximum and adds. Any
number of partial results combine this way, in any order — which is what lets the
key axis be split across SMs later in this chapter.

> [!trap] "FlashAttention is an approximation"
> It computes the same function as naive attention. Results differ only in the
> last bits, from summing in a different order — as any reordering of
> floating-point additions does. It re-associates the arithmetic for the memory
> hierarchy; it does not approximate it. The same is true of the split-KV merge.

## The kernel, in twenty lines

Here is the forward pass as FlashAttention-2 organises it
([paper](https://arxiv.org/abs/2307.08691), Algorithm 1), for one query tile of
one head. Thousands of these run at once, one per thread block.

```text
  # one thread block per (query tile i, head h)
  load Q_i (B_r × d) from HBM into shared memory              # once
  m = −∞,  ℓ = 0   (one per query row);   O = 0 (B_r × d)     # in registers
  for j in 0 … ⌈N / B_c⌉ − 1:                                  # stream K and V
      load K_j, V_j (B_c × d each) from HBM into shared memory
      S  = Q_i · K_jᵀ / √d             # B_r × B_c scores, tensor cores, registers
      if causal: skip tiles entirely above the diagonal; mask the one it crosses
      m_new = max(m, rowmax(S))
      P  = exp(S − m_new)              # never leaves the chip
      c  = exp(m − m_new)              # the rescale factor
      ℓ  = c · ℓ + rowsum(P)
      O  = c · O + P · V_j             # tensor cores
      m  = m_new
  O = O / ℓ                            # finish the softmax
  write O_i and L_i = m + log ℓ to HBM # L is what a later merge needs
```

Size it for the case's model: `d` = 128 and tiles of `B_r = B_c = 128` in BF16 make
Q, K and V tiles of 128 × 128 × 2 B = 32 KB each, 96 KB of the SM's 228 KB, which
leaves room to load the next K and V tiles while computing on these. The score
tile `S` (128 × 128 in FP32, 64 KB) lives in the registers of the threads that
computed it. Tile sizes are not arbitrary: they are what fits.

Read the loop for its traffic and you get the section above: `Q_i` loaded once,
`O_i` written once, every `K_j` and `V_j` once per query tile, `S` and `P` never.

## What each generation removed

The recurrence has not changed since 2022. What changed is which part of the
hardware it was waiting on.

| kernel | the constraint it removed | how | the number, from its source |
|---|---|---|---|
| FlashAttention ([2022](https://arxiv.org/abs/2205.14135)) | the `N × N` matrix in HBM | tiles plus online softmax | HBM accesses Θ(N²d²/M) for on-chip size M, against Θ(Nd + N²) for standard attention (Theorem 2) |
| FlashAttention-2 ([2023](https://arxiv.org/abs/2307.08691)) | non-matmul work, and idle SMs on one long sequence | fewer non-matmul operations (divide by ℓ once, at the end); parallelise over query tiles | A100: 312 TFLOP/s of matmul against 19.5 TFLOP/s for everything else, so "each non-matmul FLOP is 16× more expensive" |
| FlashAttention-3 ([2024](https://arxiv.org/abs/2407.08608)) | Hopper's tensor cores waiting on loads and on softmax | asynchronous copies by the **TMA** (the Tensor Memory Accelerator, a unit that moves tiles between HBM and shared memory without using registers); some warps multiply while others compute softmax | up to 740 TFLOP/s in FP16 (75% utilisation), close to 1.2 PFLOP/s in FP8, where FA2 reached 35% |
| FlashAttention-4 ([2026](https://arxiv.org/abs/2603.05451)) | Blackwell's tensor cores outgrowing the **special-function unit** (SFU), the per-SM unit that computes `exp` | some exponentials emulated in software on ordinary multiply-add units; rescale skipped when the maximum barely moves | up to 1,613 TFLOP/s in BF16 on B200 (71%) |
| FlashDecoding ([2023](https://pytorch.org/blog/flash-decoding/)) | decode's single query row leaving SMs idle | split the key axis across SMs, merge partials | — |
| FlashInfer ([2025](https://arxiv.org/abs/2501.01005)) | one hand-tuned kernel per cache layout | paged, ragged and prefix-shared caches as one block-sparse format; variants compiled on demand | — |
| FlashMLA ([GitHub](https://github.com/deepseek-ai/FlashMLA)) | decode over a compressed latent cache ([Attention for Serving](#/attention-for-serving)) | all heads share one latent KV, so each byte read feeds much more arithmetic | up to 660 TFLOP/s on H800 in compute-bound configurations (README, April 2025) |

Read the last column as a trend: the first rows are about bytes, the next about
keeping tensor cores fed, and FlashMLA reports TFLOP/s because MLA turned decode
attention from a bandwidth problem into an arithmetic one. CUTLASS, the C++ template library most
of these are built with, and its Python form CuTe-DSL (FA4's language) come back in
[Kernels, Graphs & Compilation](#/kernels-and-compilation).

> **State of play (November 2026):** vLLM v0.34 runs FlashAttention 3 on Hopper
> and prefers FlashInfer on data-centre Blackwell, with FlashAttention 4 next in
> line; v0.27 added FP8 KV support to its FA4 path. Throughput figures belong to
> specific chips and will age; tiling, online softmax and the merge will not.

## Decode has one query row

All of the above was built for prefill, where thousands of query rows can be
spread across the GPU. In decode there is **one query row per sequence**,
attending over the whole KV cache — and reading that cache is the real cost. A
100,000-token context of the case's model is 33 GB of KV (8.2 GB per GPU at TP=4),
~2.9 ms of reading per GPU per step at achievable bandwidth. FlashAttention cannot
shrink those bytes; the job is to read them at full speed.

> [!predict] Before you read on
> Batch 1, Llama-3.3-70B at TP=4, a 100,000-token context. Each GPU holds 16 query
> heads that share 2 KV heads. A kernel packs the 8 query heads that share a KV head
> into one tile and gives each tile one thread block. How many of the 132 SMs have
> work?

Two. Packing the heads that share a KV head (FlashAttention 3's `PackGQA`) is
right — it reads each key once for eight queries — but at batch 1 it leaves
`1 sequence × 2 KV heads = 2` tiles, each walking 100,000 keys alone while 130 SMs
idle. **FlashDecoding** parallelises the other axis: it splits the keys into
chunks, gives each chunk its own thread block, and merges the partial `(m, ℓ, o)`
results with the rule from the program above. FlashAttention 3 decides how many
splits with a small heuristic:

```cpp
inline int num_splits_heuristic(int total_mblocks, int num_SMs, int num_n_blocks, int num_m_blocks, int size_one_kv_head, bool is_causal_or_local, int max_splits) {
    // If we have enough to almost fill the SMs, then just use 1 split
    …
    if (total_mblocks >= 0.8f * num_SMs) {
        …
            return 1;
    }
    // If num_n_blocks is too small, use 1 split. For example, we never split for hdim = 128 and seqlen_k = 512.
    if (num_n_blocks <= 4) { return 1; }
    max_splits = std::min({max_splits, num_SMs, num_n_blocks});
    …
    for (int num_splits = 1; num_splits <= max_splits; num_splits++) {
        float n_waves = float(total_mblocks * num_splits) / num_SMs;
        float eff = n_waves / ceil(n_waves);
        …
    }
    for (int num_splits = 1; num_splits <= max_splits; num_splits++) {
        if (efficiency[num_splits - 1] >= 0.85 * max_efficiency) {
            …
            return num_splits;
        }
    }
    return 1;
}
```

*Verbatim — trimmed; `hopper/heuristics.h` in Dao-AILab/flash-attention (main at cc7b69d, 2026-11-21; file unchanged since 2025-03-05). vLLM builds FlashAttention from its own fork.*

`total_mblocks` is the number of work tiles before splitting; `eff` is how full the
last wave of tiles leaves the GPU; the answer is the *smallest* split count within
85% of the best, because every split adds a partial result to write and merge. Two
lines to notice: a batch that already fills 80% of the SMs is never split, and
`max_splits` caps the answer. In vLLM v0.34 that cap is 32 whenever decode runs as
a full CUDA graph — the graph needs its merge buffers sized at capture
(`flash_attn_max_num_splits_for_cuda_graph`). For the predict above: 2 tiles,
capped at 32 splits, gives 28 splits and 56 busy SMs.

![Without split-KV a single query row keeps one SM busy while the rest idle; FlashDecoding splits the KV cache into chunks, computes a partial output and log-sum-exp per chunk in parallel, then merges them in one reduction](assets/diagrams/flash-decoding.svg)

## Paged KV in the kernel

[Paged KV Cache](#/paged-kv-cache) scattered each sequence's cache across 64-token
blocks (vLLM v0.34's default) listed in a block table. The kernel is where the table
is read. vLLM deleted its original PagedAttention kernel in v0.25 ("The legacy
attention implementation is deleted now that V1/MRv2 backends are the standard
path"); paging lives on as arguments to the FlashAttention and FlashInfer kernels.
This is the call vLLM's FlashAttention backend makes for a step:

```python
            _FA4_DENSE_ATTENTION_KERNEL(
                q=query[:num_actual_tokens],
                k=key_cache,
                v=value_cache,
                out=output[:num_actual_tokens],
                cu_seqlens_q=cu_seqlens_q,
                max_seqlen_q=max_seqlen_q,
                seqused_k=seqused_k,
                max_seqlen_k=max_seqlen_k,
                softmax_scale=self.scale,
                causal=causal,
                …
                block_table=block_table,
                …
                fa_version=self.vllm_flash_attn_version,
                q_descale=q_descale,
                k_descale=k_descale,
                v_descale=v_descale,
                …
                num_splits=num_splits,
                …
            )
```

*Verbatim — trimmed; vLLM v0.34.0 `vllm/v1/attention/backends/flash_attn.py`, `FlashAttentionImpl.forward`. Despite its name, the wrapper dispatches to `flash_attn_varlen_func` with whichever `fa_version` was selected.*

One call serves the whole step. `q` holds the query rows of every sequence back to
back, and `cu_seqlens_q` says where each sequence's rows start — one row for a
decode, a chunk for a prefill. `k` and `v` are the entire block pool, not one
sequence's cache. `seqused_k` gives each sequence's length, and `block_table` has
one row per sequence, listing its physical blocks. A thread block assigned to
sequence `s` that needs key position `t` reads block `block_table[s][t // 64]`, slot
`t % 64`. A 128-key tile therefore spans two blocks that may sit anywhere in the
pool, so tile loads split at block boundaries — one reason block size and tile size
are chosen together. The `*_descale` arguments carry the FP8 scales when the cache
is FP8, which the kernel applies as it reads.

This is the loose end from [Continuous Batching](#/continuous-batching): the matrix
multiplies stack every token of the step into one matrix; attention cannot, because
each sequence attends to its own cache — yet it is still one launch, inside which
each tile walks its own sequence's block list. FlashInfer
generalises the same arrays (its `kv_indptr` and `kv_indices` are a block table in
compressed form) into a block-sparse format that also covers ragged batches and
shared prefixes.

At startup vLLM picks the backend from a priority list per GPU generation and logs
the choice:

```plaintext
INFO … Using FLASH_ATTN attention backend out of potential backends: ['FLASH_ATTN', 'FLASHINFER', 'TRITON_ATTN', 'FLEX_ATTENTION'].
INFO … Using FlashAttention version 3
```

*Real format, illustrative values — messages from vLLM v0.34.0 `vllm/platforms/cuda.py` and `vllm/v1/attention/backends/flash_attn.py`, prefixes trimmed; the candidate list shown is the Hopper priority order for a dense model in `_get_backend_priorities`, and which candidates appear depends on what validates on the machine.*

On Hopper the order is FlashAttention, then FlashInfer, then Triton; on SM100
Blackwell FlashInfer comes first. `--attention-backend` overrides the choice, and
the log is the only record of which kernel actually ran.

> [!dashboard] Decode attention (the KV read)
> **Utilisation:** `DCGM_FI_PROF_DRAM_UTIL_RATIO` — shared with the weight reads, so
> it shows the step's memory pressure, not attention's alone. **Saturation:** none
> as a metric — derive KV bytes per step from the running requests' lengths
> (`vllm:num_requests_running`, `vllm:request_prompt_tokens`) × 82 KB per token per
> GPU, and compare with the 35 GB of weights. **Errors:** none — a backend that
> silently changed shows up only in the startup log above.

> [!case] The case: one thing to check, and when attention starts to matter
> On Halden's H100s, vLLM v0.34 selects FLASH_ATTN with FlashAttention 3, which
> supports the FP8 KV cache and full CUDA graphs. Is attention worth tuning? Price
> it with the cost model: at the phase-1 peak, 20 sequences × 3,000 tokens of KV
> reads take ~1.7 ms of a ~15.7 ms step — **~11%**. Nothing to tune.
>
> That changes with phase 2. Each FP8 TP=2 replica reads the same 82 KB per token
> per GPU; ~30 sequences averaging ~11K tokens make ~9.6 ms of KV reads in a ~23.6 ms
> step — **~40%**. Then the KV read, and the kernel that does it, is a large share of
> TPOT, and a context cap or KV offload moves it.
>
> **The one thing to check:** the FP8-KV path on Hopper. vLLM
> [documented](https://vllm.ai/blog/2026-04-22-fp8-kvcache) FA3's FP8 attention
> losing precision over very long contexts, fixed by a two-level accumulation that
> is on by default and costs some prefill speed ([Did Quantization Break Your
> Model?](#/did-quantization-break-your-model) explains it). The deployment pins
> v0.34, records the two log lines above from production startup, and runs the
> 16K long-document evaluation on that exact backend — not on whatever a laptop
> or a different GPU selects.

## Exercises

<div class="exercise">

**Exercise 1.** Apply online softmax to one query with scores `[2, 5, 1]` and values
`[100, 0, 50]`, in tiles of one key each. Show `m`, `ℓ` and `o` after each tile and
the final output; check it against a direct softmax.

<details>
<summary>Reveal answer</summary>

```text
  key 1 (2, 100):  m = 2,  ℓ = 1,                 o = 100
  key 2 (5, 0):    max moves 2 → 5, rescale by exp(−3) = 0.0498
                   ℓ = 0.0498 + 1 = 1.0498,       o = 4.98 + 0 = 4.98
  key 3 (1, 50):   max stays 5
                   ℓ = 1.0498 + exp(−4) = 1.0681, o = 4.98 + 0.0183·50 = 5.894
  O = 5.894 ÷ 1.0681 ≈ 5.52
```

Direct: weights ∝ `[e², e⁵, e¹]` → normalised `[0.0466, 0.9362, 0.0171]`;
`O = 4.66 + 0 + 0.86 = 5.52`. Same.

</details>

</div>

<div class="exercise">

**Exercise 2 — count the bytes.** Ask Halden's prefill: 3,000 tokens through
Llama-3.3-70B (80 layers, 64 query heads, 8 KV heads, head_dim 128, BF16). (a) How
many bytes of score matrix would naive attention write per head per layer, and
how much HBM traffic across the whole prefill? (b) At the node's 13.4 TB/s, how
long is that, against the ~0.27 s prefill? (c) What does FlashAttention read and
write instead? (d) Redo (a)–(b) at 32K tokens.

<details>
<summary>Reveal answer</summary>

(a) `3,000² × 2 B = 18 MB` per head per layer; four passes make 72 MB; × 64 heads ×
80 layers ≈ **369 GB** of traffic for one prefill.

(b) 369 GB ÷ 13.4 TB/s ≈ 28 ms — about 10% on top of 0.27 s. At Halden's prompt
length naive attention would be wasteful, not ruinous.

(c) Q and O are `3,000 × 8,192 × 2 B` ≈ 49 MB each per layer, K and V
`3,000 × 1,024 × 2 B` ≈ 6 MB each: ~111 MB per layer, ~8.8 GB for the prefill. K
and V are requested once per query tile (24 tiles of 128 rows), but a KV head's
1.5 MB stays in L2 between those requests.

(d) The score traffic grows with N²: × (32,768 ÷ 3,000)² ≈ 119 → ~44 TB, **~3.3 s**
at 13.4 TB/s. The same quadratic that is 10% at 3K is the whole budget at 32K.

</details>

</div>

<div class="exercise">

**Exercise 3 — diagnosis.** To make its evaluation runs reproducible, a team
starts the long-document service like this:

```bash
VLLM_BATCH_INVARIANT=1 vllm serve meta-llama/Llama-3.1-8B-Instruct --max-model-len 131072
```

*Real format, illustrative values — the environment variable is from vLLM v0.34.0 `vllm/envs.py`, the flags from `vllm/engine/arg_utils.py`; the model and length are invented for the exercise.*

At batch 1 over 120,000-token documents on one H100, decode is far slower than
the KV read predicts, and `DCGM_FI_PROF_DRAM_UTIL_RATIO` sits low during attention.
The startup log shows FLASH_ATTN with FlashAttention version 3. Llama-3.1-8B has 32
query heads and 8 KV heads. What is binding, and what are the options?

<details>
<summary>Reveal answer</summary>

Batch invariance forces one split: vLLM's FlashAttention backend sets
`max_num_splits = 1` under `VLLM_BATCH_INVARIANT`, because a different split count
changes the order of the sums. With packed GQA, batch 1 and 8 KV heads give 8 work
tiles on 132 SMs, each walking 120,000 keys: the bandwidth sits idle in 124 SMs.

Options: run the reproducible evaluation separately and serve without batch
invariance (the heuristic would then choose up to 32 splits under CUDA graphs);
or accept the latency as the price of bit-reproducibility. Reproducibility and
long-context latency trade against each other here, and the trade belongs in the
deployment notes.

</details>

</div>

<div class="exercise">

**Exercise 4 — transfer.** Llama-3.1-8B on one H100 (132 SMs) decodes **2**
sequences of 64,000 tokens under a full CUDA graph (split cap 32). Using the
heuristic above with packed GQA: how many work tiles before splitting, how many
splits, and how many SMs end up busy? Would batch 64 at 2,000 tokens be split?

<details>
<summary>Reveal answer</summary>

Tiles: 2 sequences × 8 KV heads = 16. Efficiency for s splits is `16s / 132` while
under one wave: s = 7 gives 0.85, s = 8 gives 0.97 (the best; past it the waves
round up badly). The smallest within 85% of 0.97 (≥ 0.82) is **7 splits**: 112
tiles on 132 SMs. At batch 64, 64 × 8 = 512 tiles already exceed 0.8 × 132, so the
heuristic returns 1 — the batch fills the GPU and splitting would only add merges.

</details>

</div>

## What to remember

- Naive attention writes and re-reads an `N × N` score matrix — ~2 GB per head per
  layer at 32K. FlashAttention removes that working memory; it does not shrink the
  KV cache (GQA, MLA and KV quantization do).
- FlashAttention never writes that matrix: Q and O cross HBM once, K and V are
  streamed once per query tile, and the tile must fit an SM's 228 KB.
- Online softmax keeps `(m, ℓ, o)` and rescales by `exp(m_old − m_new)`; the same
  rule merges partial results, which is what split-KV decode runs on.
- A decode kernel walks each sequence's block table inside one call for the whole
  batch; at small batch it needs splits along the keys to fill the SMs.
- In decode the cost is the KV read itself — ~11% of Halden's phase-1 step, ~40%
  of its phase-2 step.

```quiz
[
  {
    "q": "A model with 32 query heads prefills 8,192 tokens. How much HBM traffic would naive attention's score matrices cause in one layer, in BF16?",
    "choices": [
      "About 134 MB, one score matrix for the layer",
      "About 17 GB: 134 MB per head, four passes, 32 heads",
      "About 4.3 GB: 134 MB per head across all 32 heads",
      "About 2 MB, since only Q and K are read to form the scores"
    ],
    "answer": 1,
    "explain": "One head's matrix is 8,192² × 2 B ≈ 134 MB. Naive attention writes S, reads it, writes P, reads P: four passes, 537 MB per head, ≈ 17 GB for 32 heads. 4.3 GB counts each matrix once; the real cost is the round trips."
  },
  {
    "q": "Two split-KV partials for one query row report (m = 2, ℓ = 3) and (m = 5, ℓ = 1). What is the merged ℓ?",
    "choices": [
      "4, the plain sum of the two partial sums, ℓ₁ + ℓ₂",
      "3e³ + 1 ≈ 61.3, rescaling the first up to the second",
      "1 + 3 = 4 again, since a correction factor cancels out in O ÷ ℓ",
      "3·e⁻³ + 1 ≈ 1.15, rescaling the first to the larger maximum"
    ],
    "answer": 3,
    "explain": "Merge to M = max(2, 5) = 5: ℓ = 3·exp(2 − 5) + 1·exp(5 − 5) ≈ 0.149 + 1 = 1.15. Adding 3 + 1 ignores that the first sum was computed against a smaller maximum; multiplying by e³ rescales in the wrong direction."
  },
  {
    "q": "A decode batch of 64 sequences with 2,000-token contexts runs on a GPU with 132 SMs, 8 KV heads per GPU, packed GQA. Will FlashAttention 3's heuristic split the keys?",
    "choices": [
      "No: 512 work tiles already fill the SMs, so splitting would only add merges",
      "Yes, into 32 splits, the cap that vLLM sets for decode under CUDA graphs",
      "Yes, into as many splits as there are 64-token blocks in each sequence",
      "No, because split-KV is used only for prefill chunks, never for decode steps"
    ],
    "answer": 0,
    "explain": "64 × 8 = 512 tiles ≥ 0.8 × 132, and the heuristic returns 1 when the tiles nearly fill the SMs. Split-KV is a decode technique for small batches and long contexts; 32 is only the upper bound under CUDA graphs."
  },
  {
    "q": "Block size 64. A sequence's block table begins [7, 3, 12, 40, 9, 22, 15, 31, 5, 18, 2, 44, 60, 61, 17, 8, …]. Where is the key for logical position 1,000?",
    "choices": [
      "Block 1000 ÷ 64 = 15 of the pool, slot 40, i.e. pool slot 1,000",
      "Block 15 of the table is 17; slot 1000 mod 64 = 40, pool slot 1,128",
      "Block 8, slot 40: pool slot 8 × 64 + 40 = 552",
      "Block 7, the first in the table, slot 1,000"
    ],
    "answer": 2,
    "explain": "Logical block 1000 // 64 = 15; entry 15 (counting from 0) of the table is 8; offset 1000 % 64 = 40; pool slot 8 × 64 + 40 = 552. Reading entry 15 as the 15th from 1 gives 17, and using 15 as a pool block ignores the table entirely."
  },
  {
    "q": "Which statement about FlashAttention's HBM traffic is correct?",
    "choices": [
      "Q, K, V and O are each read or written exactly once, whatever the context",
      "It moves the same bytes as naive attention, but in an order the caches like",
      "The scores stay in HBM, but compressed to FP8 between the softmax passes",
      "No N × N matrix is written; K and V are streamed once per query tile"
    ],
    "answer": 3,
    "explain": "Each query tile streams all of K and V, so they are requested N / B_r times (largely served from L2), while Q is read once, O written once, and the score matrix never leaves the chip. 'Each exactly once' is the common simplification and is wrong for K and V."
  }
]
```
