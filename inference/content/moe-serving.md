# Serving MoE at Scale

> **The question:** a mixture-of-experts model computes like a small model and
> stores like a huge one — how do you serve it, and why does doing so overturn
> the parallelism rules from the previous chapter?
>
> **You'll be able to:** size an MoE from its `config.json` — the pool it leaves and
> the bytes a decode step reads at a given batch; price a wide-EP deployment's
> all-to-all against the expert arithmetic it feeds; diagnose expert-load imbalance
> from the engine's statistics and size the redundant experts that fix it.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="fabric,runner"></div>

A dense model runs every weight for every token. DeepSeek-V3 has **671 billion**
parameters and uses about **37 billion** of them per token. By November 2026 its
successor DeepSeek-V4-Pro is 1.6 trillion total and 49 billion active
([DeepSeek, April 2026](https://api-docs.deepseek.com/news/news260424)). That gap is
the architectural bet behind most frontier open-weights models, and it changes the
serving problem from the ground up.

## What a mixture of experts is

In a dense transformer, each layer's MLP is one large block that every token passes
through ([Inside a Forward Pass](#/inside-a-forward-pass)). A **mixture-of-experts
(MoE)** layer replaces it with many smaller MLPs — **experts** — and a small
**router**. DeepSeek-V3 has 256 routed experts per MoE layer. The router scores each
token against all of them and sends it to the **top 8**; the token's output is the
weighted sum of those eight experts' outputs. Most designs, DeepSeek's included, also
keep a **shared expert** every token visits.

![One MoE layer end to end: three tokens hit a router that picks top-k of N experts, an all-to-all dispatch sends each token to the GPUs owning its experts, the expert feed-forward networks run, and a second all-to-all combines the weighted sums back to each token](assets/diagrams/moe-layer.svg)

An engine does not loop over tokens. It routes the whole step's batch, *regroups*
the rows by expert so that each expert runs one matrix multiply over every row that
chose it (a [grouped GEMM](#/kernels-and-compilation)), and then scatters the results
back. Here is that path on six tokens and four experts:

```python
import math, random
random.seed(3)
T, E, k, d = 6, 4, 2, 3            # tokens in the step, experts, top-k, width
X = [[random.gauss(0, 1) for _ in range(d)] for _ in range(T)]
Wr = [[random.gauss(0, 1) for _ in range(E)] for _ in range(d)]           # router
Wexp = [[[random.gauss(0, 1) for _ in range(d)] for _ in range(d)] for _ in range(E)]
mm = lambda v, W: [sum(v[i] * W[i][j] for i in range(len(v))) for j in range(len(W[0]))]

# 1. route: score every expert, keep the top k, renormalise their weights
assign = []                                    # (expert, token, weight)
for t, x in enumerate(X):
    s = [math.exp(v) for v in mm(x, Wr)]
    top = sorted(range(E), key=lambda e: -s[e])[:k]
    for e in top:
        assign.append((e, t, s[e] / sum(s[j] for j in top)))
# 2. permute: group the (token, expert) pairs by expert -> one batch per expert
assign.sort(key=lambda a: a[0])
# 3. grouped GEMM: each expert multiplies only the rows routed to it
out = [mm(X[t], Wexp[e]) for e, t, w in assign]
# 4. un-permute: scatter each row back to its token, weighted, and sum
Y = [[0.0] * d for _ in range(T)]
for (e, t, w), row in zip(assign, out):
    Y[t] = [a + w * b for a, b in zip(Y[t], row)]
print("rows per expert:", [sum(1 for a in assign if a[0] == e) for e in range(E)])
print("expert order   :", [a[0] for a in assign])
print("token order    :", [a[1] for a in assign])
print("token 0 output :", [round(v, 3) for v in Y[0]])

# --- output of an actual run ---
# rows per expert: [0, 3, 3, 6]
# expert order   : [1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3]
# token order    : [1, 4, 5, 0, 2, 3, 0, 1, 2, 3, 4, 5]
# token 0 output : [0.256, -0.213, -0.261]
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

Look at the first output line: with six random tokens, expert 0 received nothing and
expert 3 received every token. Load is lumpy even when nothing is wrong — and when
experts live on different GPUs, steps 2 and 4 become network transfers.

A model's `config.json` tells you its shape. OpenAI's gpt-oss-120b, the MoE this
chapter's case considers:

```json
{
  "architectures": ["GptOssForCausalLM"],
  "experts_per_token": 4,
  "head_dim": 64,
  "hidden_size": 2880,
  "intermediate_size": 2880,
  "layer_types": ["sliding_attention", "full_attention", …],
  "num_attention_heads": 64,
  "num_experts_per_tok": 4,
  "num_hidden_layers": 36,
  "num_key_value_heads": 8,
  "num_local_experts": 128,
  "quantization_config": {
    "modules_to_not_convert": ["model.layers.*.self_attn", "model.layers.*.mlp.router",
                               "model.embed_tokens", "lm_head"],
    "quant_method": "mxfp4"
  },
  "sliding_window": 128,
  …
}
```

*Verbatim — trimmed, lists collapsed onto one line; `config.json` of openai/gpt-oss-120b on Hugging Face, checked 2026-11-21. `layer_types` alternates the two values for all 36 layers.*

128 experts per layer, 4 per token, 36 layers; experts in 4-bit MXFP4, everything
else in BF16; half the layers attend over only the last 128 tokens. Field names are
not standard: DeepSeek-V3 says `n_routed_experts: 256`, `num_experts_per_tok: 8`,
`n_shared_experts: 1`, `first_k_dense_replace: 3` (three dense layers first).

## Total and active

Two numbers that are equal in a dense model diverge:

- **Total parameters** must all be in GPU memory, because any expert may be chosen
  for the next token. DeepSeek-V3: 671B — ~671 GB in FP8 (685B on Hugging Face,
  which adds a 14B multi-token-prediction module).
- **Active parameters** run for a given token: 37B, so ~74 GFLOPs per token by the
  2·P rule — the compute of a 37B dense model.

That is why labs moved to MoE: the knowledge capacity of the total at the compute
cost of the active. And it is why serving changes: the compute of a small model, the
memory footprint of a giant one.

> [!predict] Before you read on
> At batch 1, a DeepSeek-V3 decode step reads roughly the active weights, ~37 GB in
> FP8. At batch 64, each token still picks 8 of 256 experts per layer. What fraction
> of the experts does the step have to read?

Most of them. If each token picks its experts uniformly and independently of the
others, an expert is missed by all 64 with probability `(1 − 8/256)⁶⁴ ≈ 0.13`, so
about **87%** are read:

```text
   batch:               1      8      64     256
   experts touched:     3%     22%    87%    ~100%
```

The formula has a known bias. Real routing is skewed, and skew *lowers* the touched
fraction: popular experts are chosen repeatedly while others stay cold. Treat
`1 − (1 − k/N)^B` as an upper bound. At batch 1 an MoE's bandwidth advantage is large;
at realistic batches a step reads most of the model. Applied to gpt-oss-120b (a
65.25 GB checkpoint, of which 2.17 billion BF16 parameters are non-expert):

```python
# gpt-oss-120b (config.json above) vs Llama-3.3-70B FP8, per decode step
N, k, L = 128, 4, 36                   # experts per layer, top-k, layers
ckpt   = 65.25e9                       # checkpoint bytes (Hugging Face file sizes)
dense  = 2.167e9 * 2                   # BF16 tensors: attention, router, embeddings
embed  = 201088 * 2880 * 2             # input embedding: rows gathered, not streamed
expert = (ckpt - dense) / (N * L)      # one expert of one layer, MXFP4
always = dense - embed                 # read every step whatever the batch

def touched(B):                        # uniform, independent routing assumed
    return 1 - (1 - k / N) ** B

print(f"one expert: {expert / 1e6:.1f} MB; read every step: {always / 1e9:.2f} GB")
for B in (1, 5, 10, 20, 64):
    gb = (always + touched(B) * N * L * expert) / 1e9
    print(f"batch {B:3}: experts touched {touched(B):4.0%}  "
          f"bytes/step {gb:5.1f} GB  tokens per expert {B * k / N:5.2f}")
print("Llama-3.3-70B FP8: 70.0 GB per step at any batch")
kv_full = 18 * 2 * 8 * 64 * 2          # full-attention layers, BF16, per token
kv_swa  = 18 * 2 * 8 * 64 * 2 * 128    # sliding layers: capped at 128 tokens
print(f"KV: {kv_full / 1e3:.1f} KB per token + {kv_swa / 1e6:.1f} MB per sequence")

# --- output of an actual run ---
# one expert: 13.2 MB; read every step: 3.18 GB
# batch   1: experts touched   3%  bytes/step   5.1 GB  tokens per expert  0.03
# batch   5: experts touched  15%  bytes/step  12.1 GB  tokens per expert  0.16
# batch  10: experts touched  27%  bytes/step  19.7 GB  tokens per expert  0.31
# batch  20: experts touched  47%  bytes/step  31.8 GB  tokens per expert  0.62
# batch  64: experts touched  87%  bytes/step  56.1 GB  tokens per expert  2.00
# Llama-3.3-70B FP8: 70.0 GB per step at any batch
# KV: 36.9 KB per token + 4.7 MB per sequence
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. Inputs: `config.json` above; parameter counts and file sizes from the Hugging Face API for openai/gpt-oss-120b, checked 2026-11-21.*

The last column is the one people miss. **Tokens per expert**, `B·k/N`, is the row
count of each expert's matrix multiply — its arithmetic intensity. The case's node has
its knee near 160 ([Inference Arithmetic](#/inference-arithmetic)); at batch 20 each
expert multiplies 0.6 rows. Every expert GEMM at decode is a matrix-vector product,
bandwidth-bound. Feeding experts enough rows takes a very large pooled batch — which
is what wide expert parallelism is for.

> [!trap] "37B active, so I can serve it like a 37B model"
> You can *compute* like one. You must *store* like a 671B one, and at real batch
> sizes you *read* nearly like one too.

## Why expert parallelism replaces tensor parallelism — at scale

On one node the default is the previous chapter's: "Without
`--enable-expert-parallel`, MoE layers would use tensor parallelism"
([vLLM v0.34.0 EP docs](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/serving/expert_parallel_deployment.md)).
It stops scaling because experts are already small: slice 256 experts sixteen ways and
every slice does a sliver of work on a handful of rows.

**Expert parallelism (EP)** places *whole* experts on different GPUs: 256 experts over
32 GPUs is 8 per GPU. Each GPU receives every token in the deployment that chose one
of its experts, so its GEMMs see the pooled batch. DeepSeek gives two reasons for
going wide: it "significantly scales the batch size, enhancing GPU matrix
computation efficiency", and each GPU holds "only a small subset of experts
(reducing memory access demands), thereby lowering latency"
([DeepSeek, inference system overview](https://github.com/deepseek-ai/open-infra-index/blob/main/202502OpenSourceWeek/day_6_one_more_thing_deepseekV3R1_inference_system_overview.md)).

Attention goes **data-parallel**: each GPU owns its sequences, their whole KV cache
and a copy of the attention weights. For DeepSeek's models this is forced by **MLA** (multi-head latent attention, [Attention for
Serving](#/attention-for-serving)): its cache is one compressed latent per token
shared by all heads, so there is no head axis to shard — vLLM counts it as one KV
head (`get_num_kv_heads` returns 1), so every TP rank stores the whole latent and a
`-tp 8` deployment stores that cache eight times over
([context parallel deployment](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/serving/context_parallel_deployment.md)).
DeepSeek's own label is "Routed Expert EP32, MLA/Shared Expert DP32". In vLLM v0.34:

```bash
# Single node EP deployment
vllm serve deepseek-ai/DeepSeek-V3-0324 \
    --tensor-parallel-size 1 \       # Tensor parallelism across 1 GPU
    --data-parallel-size 8 \         # Data parallelism across 8 processes
    --enable-expert-parallel         # Enable expert parallelism
```

*Verbatim — vLLM v0.34.0, `docs/serving/expert_parallel_deployment.md`. The inline comments are the docs'; delete them before pasting, since a comment after `\` breaks the line continuation. The docs note it needs an eight-GPU H200 or H20 node.*

EP size is computed as `TP × DP` = 8: eight attention replicas, one expert group.

> [!bridge] From the Distributed Systems course
> Expert parallelism is hash partitioning with the expert ID as the key. The usual
> lessons transfer: the key distribution sets the load, popular keys make hot
> shards, and you fix hot shards by replicating them. What does not transfer is the
> freedom to choose the key — a trained router hands you its distribution, and you
> can only rebalance placement around it.
> [→ Distributed: Partitioning & Sharding](../distributed/#/partitioning)

## The price: two all-to-alls per layer

A token's attention runs on one GPU; its experts live on others. Every MoE layer,
every token: **dispatch** (send it to the GPUs holding its chosen experts), the
experts compute, **combine** (return the outputs). Each is an **all-to-all**: every
GPU sends a *different* packet to every other. An all-reduce produces one shared sum;
an all-to-all *regroups* data by destination — steps 2 and 4 of the script, across
the network.

![An all-reduce is a symmetric reduction where every GPU ends holding the same sum, while an all-to-all is a personalized regroup where each GPU sends a different, data-dependent shard to every other GPU](assets/diagrams/moe-alltoall.svg)

> [!predict] Before you read on
> DeepSeek-style decode on H100-class nodes, 128 sequences per GPU. Which takes longer
> per MoE layer: moving the tokens, or the expert arithmetic they feed?

A DeepSeek-V3 token is 7,168 numbers wide, dispatched in FP8 (7.2 KB) and combined
in BF16 (14.3 KB), and the model sends each token to experts on **at most 4 nodes**
([DeepSeek-V3 report](https://arxiv.org/abs/2412.19437)). Across nodes that is up to
4 × 21.5 KB ≈ 86 KB per token per layer; × 128 tokens ≈ **11 MB per GPU per layer**,
**~0.22 ms** at 50 GB/s each way. The arithmetic: at EP144 each GPU hosts 2 routed
experts and the shared one; 144 × 128 × 8 ÷ 256 ≈ 576 rows per routed expert, plus 128
shared — ~1.1 × 10¹¹ FLOPs, **~0.14 ms** at 40% of an H100's FP8 rate. Moving the
tokens takes longer than the math, 58 MoE layers a step: ~13 ms per step if
unhidden. Meta puts all-to-all at "10-30%" of end-to-end latency in its EP serving
([Meta Engineering](https://engineering.fb.com/2025/10/17/ai-research/scaling-llm-inference-innovations-tensor-parallelism-context-parallelism-expert-parallelism/)).

So the work is overlap. DeepSeek splits each prefill batch into two micro-batches,
one computing while the other communicates, and runs decode as a five-stage pipeline;
vLLM's equivalent is `--enable-dbo` (dual batch overlap). The transfers run on
**[DeepEP](https://github.com/deepseek-ai/DeepEP)**, over NVLink inside a node and
RDMA between nodes. They are not free of compute: the current README says "zero-SM
RDMA EP is not supported", and DeepSeek's V3 report gave communication 20 of the
H800's 132 SMs in training.

## Hot experts and stragglers

Routing is not uniform. The combine cannot finish until every expert has produced its
outputs, so it is a barrier — and the GPU holding the busiest experts sets the pace
for every GPU.

> [!predict] Before you read on
> One expert receives three times its fair share of tokens this step. Its GPU takes
> three times as long. What do the other GPUs do meanwhile?

They wait. Average utilisation looks fine; the step time is set by the maximum.
Production systems answer with two tools:

- **Redundant experts.** Replicate the hottest experts on several GPUs so their load
  splits. DeepSeek adds **32 redundant experts** to its 256.
- **Expert-parallel load balancing (EPLB).** Popularity drifts, so a balancer
  measures load and re-places experts. In vLLM: `--enable-eplb`, with `--eplb-config`
  keys `window_size` (default 1000 steps), `step_interval` (default 3000) and
  `num_redundant_experts` — each costing ~2.4 GB per rank for DeepSeek-V3.

The engine reports the imbalance if you ask it to (`"log_balancedness": true`):

```plaintext
EPLB step: 2400 for model Qwen/Qwen3-30B-A3B: avg_tokens=24576.00, max_tokens=39322, balancedness=0.6250, steps until the next rearrangement: 600
```

*Real format, illustrative values — the log format string from vLLM v0.34.0 `vllm/distributed/eplb/eplb_state.py`; the numbers are invented for the exercise below.*

`avg_tokens` is the mean load per EP rank and `max_tokens` the busiest rank's, each
summed over the MoE layers; `balancedness` is their ratio. At 0.625 the busiest rank
carries 1.6× the mean, so every expert phase runs ~1.6× longer than perfect placement
allows. v0.34 exports no per-expert metric; this line is per rank.

## DeepSeek-V3/R1 in production

On 1 March 2025 DeepSeek published its serving system
([overview](https://github.com/deepseek-ai/open-infra-index/blob/main/202502OpenSourceWeek/day_6_one_more_thing_deepseekV3R1_inference_system_overview.md)),
with statistics for 27–28 February. It runs prefill and decode on **separate pools**
with different parallelism — the subject of [Disaggregated
Serving](#/disaggregation) — on **H800s**, the export variant of the H100 with
reduced NVLink bandwidth (DeepSeek measured 160 GB/s over NVLink against 50 GB/s over
InfiniBand), which is part of why it invests so much in overlap.

| | Prefill | Decode |
|---|---|---|
| Scale | EP32 — 4 nodes × 8 H800 | EP144 — 18 nodes × 8 H800 |
| Experts per GPU | 9 routed + 1 shared | 2 routed + 1 shared |
| Hiding the all-to-all | two micro-batches | a 5-stage pipeline |

Both pools hold 256 + 32 = 288 routed experts; decode spreads them thinner. In 24
hours the service took 608B input tokens, 56.3% of which "hit the on-disk KV cache",
at ~73.7k input tokens/s per node in prefill and ~14.8k output tokens/s per node in
decode; [Hardware & Economics](#/hardware-and-economics) reads its cost figures.

## Wide-EP, and racks instead of servers

What looked exotic in early 2025 is now reproducible with open stacks. LMSYS rebuilt
DeepSeek-scale serving on 96 H100s in SGLang
([LMSYS](https://www.lmsys.org/blog/2025-05-05-large-scale-ep/)), and on GB200 NVL72
— **72 GPUs in one NVLink domain**, so the all-to-all never leaves NVLink — measured
"7,583 tokens per second per GPU for decoding", "a 2.7x speedup compared to the H100
per GPU", at 2,000-token inputs
([LMSYS, June 2025](https://www.lmsys.org/blog/2025-06-16-gb200-part-1/)). For
wide-EP MoE, the interconnect is a large part of the product.

> **State of play (November 2026):** wide-EP with data-parallel attention is standard
> in vLLM (v0.34.0) and SGLang (v0.5.23), both with DeepEP v2 as a selectable backend;
> TensorRT-LLM v1.3.0 keeps attention DP with a KV-cache-aware router. vLLM v0.34
> adds fault-tolerant DP+EP scale-down — "dead ranks are removed and their experts
> redistributed without a restart" — and `--enable-ep-weight-filter`, so each rank
> reads only its own experts from disk. At the other end, SGLang v0.5.23's opt-in
> **Paged Experts** "runs MoE models larger than GPU memory on a single consumer GPU".
> The reference sizes are now DeepSeek-V4-Pro (1.6T / 49B active) and V4-Flash (284B
> / 13B). Under study: **attention–FFN disaggregation** — ByteDance's
> [MegaScale-Infer](https://arxiv.org/abs/2504.02263) puts attention and experts on
> separate pools and reports "up to 1.90x higher per-GPU throughput".

> [!dashboard] Expert parallelism
> **Utilisation:** none as a metric — derive per-rank expert load from the EPLB log
> (`avg_tokens` per rank, with `log_balancedness` on). **Saturation:**
> `balancedness` in the same line: 1 ÷ balancedness is how much longer the expert
> phase takes than with perfect placement; watch it fall between rearrangements.
> **Errors:** none as a metric in v0.34 — a lost EP rank surfaces as engine errors,
> and v0.34 can drop it through `POST /v1/fault_tolerance/apply`; the GPU's own
> `DCGM_FI_DEV_XID_ERROR` says why it was lost.

> [!case] The case: should Halden switch to an MoE?
> The candidate is gpt-oss-120b (Apache 2.0): 116.8B parameters, 5.1B active, a
> 65 GB checkpoint that the model card says fits "a single 80GB GPU". Laid out like
> the Llama plan, as two TP=2 replicas:
>
> - **Memory.** Pool per replica: 0.90 × 160 − 65 − 6 − 2 ≈ **71 GB**, against Llama
>   FP8's 66. The difference is the cache: 37 KB per token (plus 4.7 MB per sequence
>   for the sliding layers) against 164 KB. Phase 2's working set, counted as the case
>   counts it (40 sessions × 8K unique tokens + 20 Q&A × 2,450, preamble once), is
>   ~0.37M tokens → **~14 GB** for the node, against ~61 GB for Llama in FP8 KV. The
>   failover squeeze from [Parallelism for Inference](#/parallelism-for-inference)
>   disappears. Four single-GPU replicas would not: 72 − 65 − 4 ≈ 3 GB of pool per GPU
>   against ~3.5 GB of phase-2 KV each.
> - **Bytes per step.** ~10 sequences per replica touch ~27% of experts if routing is
>   uniform (fewer if skewed): ~20 GB per replica, ~10 GB per GPU — a ~3 ms physics
>   floor against Llama's 10.4 ms.
> - **Compute.** ~1.0 × 10¹⁰ FLOPs per token, 14× less than Llama. At decode it buys
>   nothing — each expert sees 0.3 rows per step, far below the knee. At prefill it
>   buys everything: phase 2's uncached 26.5K tokens/s, over capacity for Llama, is
>   ~2.7 × 10¹⁴ FLOP/s, about 17% of the two replicas even with BF16 arithmetic at
>   40% MFU.
>
> **What this settles:** on serving arithmetic the MoE wins on every axis Halden
> measures, and it removes phase 2's capacity problem rather than managing it. So the
> decision moves to where it can still go the other way: the evaluation harness on
> Halden's 1,500 questions, and gpt-oss's harmony response format, which changes the
> application's tool-call parsing. Halden runs that evaluation before phase 2 ships;
> the model choice is reopened in [Choosing: Model, GPU,
> Framework](#/choosing-model-gpu-framework).

## Exercises

<div class="exercise">

**Exercise 1 — transfer.** Size Qwen3-30B-A3B on one H100 in BF16 from its
configuration:

```json
{
  "head_dim": 128,
  "hidden_size": 2048,
  "moe_intermediate_size": 768,
  "num_experts": 128,
  "num_experts_per_tok": 8,
  "num_hidden_layers": 48,
  "num_key_value_heads": 4,
  "torch_dtype": "bfloat16",
  "vocab_size": 151936
}
```

*Verbatim — trimmed; `config.json` of Qwen/Qwen3-30B-A3B on Hugging Face, revision ad44e777, checked 2026-11-21. The repository holds 30.53B BF16 parameters.*

Using the case's budget rules (72 GB, ~4 GB of overhead and activations), find the KV
pool in tokens, and the bytes a decode step reads at batch 1, 16 and 64, assuming
uniform routing. Expert weights are 3 matrices of 2,048 × 768 per expert.

<details>
<summary>Reveal answer</summary>

Weights: 30.53B × 2 B ≈ **61 GB**, so the pool is 72 − 61 − 4 ≈ **7 GB**. KV per token:
2 × 48 × 4 × 128 × 2 = 98 KB → ~**71K tokens**. Experts: 3 × 2,048 × 768 × 128 × 48 ≈
29.0B parameters (58 GB); the rest, minus the 0.3B-parameter input embedding, ~2.5 GB,
is read every step. Touched at top-8 of 128: batch 1 → 6%, batch 16 →
`1 − (120/128)¹⁶ ≈ 64%`, batch 64 → 98%. Bytes per step ≈ 2.5 + f × 58: **~6 GB,
~40 GB, ~60 GB** — 1.8, 12 and 18 ms at the physics floor. At batch 64 it reads almost
what a dense 30B model would, while computing a tenth as much: 4 rows per expert.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A Qwen3-30B-A3B deployment runs at DP=4, EP=4 on one
node. TPOT is 40% worse than a benchmark of the same layout, and the EPLB log shows
the line above (`balancedness=0.6250`). Expert loads for one layer over the last
window, per rank and, on the busiest rank, per expert:

```plaintext
rank 0: 480   rank 1: 470   rank 2: 819   rank 3: 279      (mean 512)
rank 2, top experts: E71 210   E66 190   next 30 experts: 419 in total
```

*Real format, illustrative values — a constructed per-rank and per-expert table (vLLM v0.34 logs only the per-rank summary); the numbers are invented and consistent with the log line.*

What is binding, and what would you change?

<details>
<summary>Reveal answer</summary>

Rank 2 carries 819 ÷ 512 = 1.6× the mean, which is the 1 ÷ 0.625 in the log: every
MoE layer waits at the combine barrier for it. Two experts, E71 and E66, carry 400 of
its 819 rows — hot experts, not a bad rank. Give each a redundant copy on rank 3, the
coldest: rank 2 drops to 819 − 105 − 95 = 619, rank 3 rises to 479, and the maximum
falls to 619 ÷ 512 ≈ 1.21× the mean. That is `--enable-eplb` with
`num_redundant_experts` of at least 2 — in practice 4, so that every rank holds the same
number of expert slots; EPLB then re-places all experts by measured load, which also spreads rank 2's
remaining 419.

</details>

</div>

<div class="exercise">

**Exercise 3.** Take the chapter's DeepSeek decode arithmetic (128 sequences per GPU,
~0.14 ms of expert arithmetic per layer) to a GB200 NVL72 rack, where every
destination is on NVLink 5 at ~900 GB/s each way per GPU. Node limits no longer
apply, so assume each token goes to its 8 experts on 8 different GPUs. How long does
one layer's dispatch and combine take now, and what does that change?

<details>
<summary>Reveal answer</summary>

Per token: 8 × (7.2 + 14.3) KB ≈ 172 KB; × 128 ≈ **22 MB per GPU per layer** — twice
the cross-node case, since nothing is deduplicated by node. At 900 GB/s that is
**~24 µs**, against 220 µs over InfiniBand and 140 µs of arithmetic. Communication
falls from longer than the math to a sixth of it, so overlap no longer has to be
perfect for the experts to stay busy — the mechanism behind the NVL72 decode numbers.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>Does expert placement change the outputs?</summary>

Placement does not: an expert computes the same function anywhere. A **capacity
limit** can — some implementations cap the tokens an expert accepts per step and drop
the overflow. Check whether your engine drops or reroutes before comparing quality
across configurations.

</details>

</div>

## What to remember

- Memory follows **total** parameters, compute follows **active** ones; read both,
  plus experts per layer and top-k, from `config.json`.
- Experts touched per step ≈ `1 − (1 − k/N)^B` under uniform routing, an upper bound;
  rows per expert = `B·k/N`, which at decode is far below the knee.
- At scale, experts go expert-parallel and attention goes data-parallel — forced by
  MLA, whose cache has no head axis to shard.
- Dispatch and combine can take longer than the expert math across nodes; overlap,
  FP8 dispatch, node-limited routing and NVLink-scale domains exist to hide them.
- The combine is a barrier: `balancedness` below 1 stretches every layer by its
  inverse; redundant experts and EPLB fix it.

```quiz
[
  {
    "q": "A team plans to serve a 400B-total, 20B-active MoE in FP8 on eight 80 GB GPUs, arguing that 20 GB of active weights leaves most of the memory for KV cache. What is wrong?",
    "choices": [
      "Nothing: only the active experts are loaded for each step",
      "Active weights double in FP8, so 40 GB are needed per step",
      "All 400 GB stay resident, leaving ~240 GB for the rest",
      "MoE models keep no KV cache, so the extra memory would go unused"
    ],
    "answer": 2,
    "explain": "Any expert may be chosen next, so every expert stays in memory: 400 GB of the 640. Sizing memory from the active count is the classic MoE error; active parameters size the FLOPs per token, not the footprint."
  },
  {
    "q": "An MoE with 64 experts and top-2 routing decodes at batch 32. Under uniform routing, about what share of experts does a step read, and how many rows does each expert multiply?",
    "choices": [
      "About 64% of experts, with about one row each",
      "About 50% of experts, with about two rows each",
      "All of the experts, with 32 rows each",
      "About 3% of experts, with 32 rows each"
    ],
    "answer": 0,
    "explain": "Missed by all 32 tokens: (1 − 2/64)^32 = (31/32)^32 ≈ 0.36, so ~64% are touched; rows per expert = 32 × 2 / 64 = 1. Every expert GEMM is a matrix-vector product, far below any knee — the bandwidth bill is most of the model while the compute is tiny."
  },
  {
    "q": "Production logs show routing is heavily skewed: a third of the experts receive most tokens. Compared with the uniform estimate, what happens to the bytes a decode step reads?",
    "choices": [
      "They rise, because hot experts must be read several times per step",
      "They are unchanged, because the formula does not depend on routing",
      "They rise, because cold experts must still be prefetched each step",
      "They fall: hot experts are picked repeatedly, so fewer are read"
    ],
    "answer": 3,
    "explain": "An expert is read once per step however many tokens chose it. Concentrating choices on fewer experts means fewer distinct experts per step, so fewer bytes; the uniform formula is an upper bound. Skew costs elsewhere: under EP it makes hot ranks and stragglers."
  },
  {
    "q": "A DeepSeek-style model uses MLA attention. Why does a wide-EP deployment run its attention data-parallel instead of tensor-parallel?",
    "choices": [
      "MLA has no attention weights, so there is nothing to shard",
      "MLA's cache has no head axis, so TP would duplicate it on every rank",
      "Data parallelism removes the need for the dispatch and combine all-to-alls",
      "Tensor parallelism cannot run on the same GPUs as expert parallelism"
    ],
    "answer": 1,
    "explain": "MLA caches one compressed latent per token shared by all heads — vLLM counts it as a single KV head — so TP=8 would store the cache eight times. Data-parallel attention gives each GPU its own sequences and their whole cache. The all-to-alls remain; they serve the experts."
  },
  {
    "q": "After moving a wide-EP deployment from two InfiniBand-connected 8-GPU nodes to one NVL72 rack, per-GPU decode throughput rises sharply with the same model and batch. What mostly explains it?",
    "choices": [
      "The rack's GPUs each hold the full set of experts, so no tokens move",
      "The router picks fewer experts per token when the domain is larger",
      "The all-to-alls stay on NVLink and shrink below the expert math",
      "NVL72 racks run attention on the CPUs, freeing the GPUs for the experts"
    ],
    "answer": 2,
    "explain": "Tokens still move twice per MoE layer, but over NVLink 5 at roughly eighteen times a 400 Gb/s NIC's per-GPU bandwidth, so communication shrinks below the expert arithmetic and overlap hides it. Placement, routing and attention are unchanged by the rack."
  }
]
```
