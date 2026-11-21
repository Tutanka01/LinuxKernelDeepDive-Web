# Attention Architectures for Serving

> **The question:** every decode step reads each sequence's whole KV cache —
> what does each attention design do to the bytes a token *stores* and the
> bytes a step *reads*, and what must the engine do for the saving to be real?
>
> **You'll be able to:** compute bytes stored and bytes read per step from a
> model's `config.json`, for GQA, MLA, sliding-window, sparse and SSM-hybrid
> designs; predict what tensor parallelism does to each design's per-GPU cache;
> judge whether a model with a different attention design would change a
> workload's capacity enough to justify switching.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kernels,kv"></div>

Halden's phase 2 will run ~40 agent sessions at the peak, each holding ~11,000
tokens of context. At Llama-3.3-70B's 328 KB per token that is 144 GB of KV
cache, more than the node's 132 GB pool. Storage is half the problem. Every
decode step reads each running sequence's entire cache: at 82 KB per token per
GPU and ~2.85 TB/s, that is ~29 ns per context token per sequence
([Inference Arithmetic](#/inference-arithmetic), rung 4 of the decode ladder).
If all 40 sessions decoded in the same step, the cache read would take
40 × 11,000 × 29 ns ≈ 12.8 ms, next to 14 ms for the weights. At agent context
lengths the cache costs as much bandwidth as the model does.

Paging, prefix caching and the scheduler, the subjects of The Engine, manage the
cache you are given. They do not change how many bytes a token costs. That is
fixed when the model is designed, by the formula from
[Inside a Forward Pass](#/inside-a-forward-pass):

```text
   kv_bytes_per_token  =  2 × n_layers × n_kv_heads × head_dim × bytes
```

Architects have pulled every factor in it. This chapter takes the designs one
at a time and asks each the same two questions: what does a token store, and
what does a decode step read?

## Fewer key-value heads: MHA, MQA, GQA

In the original **multi-head attention (MHA)**, each of the 64 query heads has its
own key head and value head. Query heads need to stay diverse — they ask different
questions — but the keys and values they read can be shared.

- **Multi-query attention (MQA):** all query heads share *one* key-value head: a
  64× cut, with a quality loss the GQA paper
  ([Ainslie et al., 2023](https://arxiv.org/abs/2305.13245)) set out to recover.
- **Grouped-query attention (GQA):** query heads are split into groups that each
  share one key-value head. With 8 groups, 64 query heads read 8 key-value heads:
  an 8× cut, with quality close to MHA.

For a 70B-class shape (80 layers, 64 query heads, head_dim 128, BF16):

| Design | KV heads | KV per token | vs MHA |
|---|---|---|---|
| MHA | 64 | `2×80×64×128×2` = 2.6 MB | 1× |
| MQA | 1 | `2×80×1×128×2` = 41 KB | 64× smaller |
| GQA-8 | 8 | `2×80×8×128×2` = 328 KB | 8× smaller |

GQA is the default in current dense models, but the group count is not fixed.
From the `config.json` files themselves: Llama-3.3-70B, Qwen2.5-72B, Qwen3-32B
and gpt-oss-120b have 8 KV heads under 64 query heads; Qwen2.5-7B has 4 under
28; Gemma 3 27B has 16 under 32. Read `num_key_value_heads` and `head_dim`;
never assume them.

For a dense design the two questions have the same answer: a step reads all
that is stored. GQA also changes the *ratio* of arithmetic to bytes in decode
attention. Each cached key or value element is multiplied by every query head
in its group, two FLOPs each, so MHA does about 1 FLOP per byte read and GQA-8
about 8. Both sit far below the H100's ridge of ~295: decode attention is a
streaming read, and fewer bytes is the only lever.

### Under tensor parallelism

With tensor parallelism each GPU holds a slice of every layer, KV heads
included. Here is how vLLM v0.34 decides how many KV heads each GPU stores:

```python
        if self.use_mla:
            # When using MLA during decode it becomes MQA
            return 1

        arch_config = arch_config or self.model_arch_config
        total_num_kv_heads = arch_config.total_num_kv_heads
        # If tensor parallelism is used, we divide the number of KV heads by
        # the tensor parallel size. We will replicate the KV heads in the
        # case where the number of KV heads is smaller than the tensor
        # parallel size so each GPU has at least one KV head.
        return max(1, total_num_kv_heads // parallel_config.tensor_parallel_size)
```

*Verbatim — vLLM v0.34.0, `vllm/config/model.py`, `ModelConfig.get_num_kv_heads`.*

The last line is the one to remember. Halden's TP=4 gives each GPU 2 of the 8
heads, a quarter of the cache. Past TP=8 the division bottoms out at one head per
GPU and heads are *copied*, so the per-GPU cache stops shrinking. The first
branch matters more, and the next section explains it: a model that caches a
single latent per token has nothing to divide, so every GPU in the tensor-parallel
group stores the whole cache.

## A compressed latent: MLA

DeepSeek asked a sharper question: why store per-head keys and values at all?
**Multi-head latent attention (MLA)**
([DeepSeek-V2](https://arxiv.org/abs/2405.04434), kept in V3) compresses all
heads' keys and values for a token into **one small latent vector** through a
learned down-projection, caches only that, and reconstructs per-head keys and
values with an up-projection when attention needs them. The configuration
shows both the latent and a trap:

```json
  "hidden_size": 7168,
  "kv_lora_rank": 512,
  …
  "num_attention_heads": 128,
  "num_hidden_layers": 61,
  "num_key_value_heads": 128,
  …
  "qk_nope_head_dim": 128,
  "qk_rope_head_dim": 64,
  …
  "v_head_dim": 128,
```

*Verbatim — trimmed; `config.json` of deepseek-ai/DeepSeek-V3 on Hugging Face, checked 2026-11-21.*

> [!predict] Before you read on
> DeepSeek-V3 has 671 billion parameters, nearly ten times Llama-3-70B, and its
> config claims 128 KV heads. Is its KV cache per token larger or smaller than
> the 70B's 328 KB?

Smaller — about **70 KB per token**. Fed to the GQA formula, `num_key_value_heads:
128` would suggest megabytes per token. That is the head count of the
*reconstructed* keys, which are never cached. What is cached per layer is the
`kv_lora_rank` latent plus one `qk_rope_head_dim` positional key:
`(512 + 64) × 61 layers × 2 bytes = 70,272 bytes`.

![Four attention architectures side by side — MHA wiring 64 query heads to 64 K/V heads at 2.6 MB per token, MQA collapsing to one shared K/V head at 41 KB, GQA-8 grouping the query heads onto 8 K/V heads at 328 KB, and MLA caching a single 576-dimension latent that an up-projection expands at decode time, about 70 KB](assets/diagrams/attention-architectures.svg)

Two details make MLA work, and the second explains the first.

**Matrix absorption.** Matrix multiplication is associative, so the key
up-projection can be folded into the query projection, and the value
up-projection into the output projection, ahead of time. Decode then scores
queries directly against the 576-wide latents and never materialises per-head
keys and values. All 128 query heads read the same latent, which makes absorbed
MLA a form of MQA with a 576-wide head: per byte read, 128 heads each do a
576-long dot product and a 512-long weighted sum, about 240 FLOPs per byte. That
is near the H100's ridge. MLA decode attention is closer to compute-bound than
any GQA kernel, which is why it has its own kernels
([FlashAttention](#/flashattention)). Prefill, already compute-bound, uses the
un-absorbed path.

**Decoupled position encoding.** RoPE rotates each query and key by an angle
that depends on its position ([Inside a Forward Pass](#/inside-a-forward-pass)).
Applied to the reconstructed keys, a rotation tied to the current token's
position would sit *between* the query projection and the key up-projection, and
the up-projection could no longer be absorbed (the DeepSeek-V2 paper, §2.1.3).
So the position goes into a separate small key — `qk_rope_head_dim`, 64
dimensions — shared by all heads and cached next to the latent, while the 512
content dimensions carry no rotation. 512 + 64 = 576.

MLA is a pretraining commitment, not a serving flag: the projections are trained
weights, so a finished GQA model cannot be switched to MLA. And under tensor
parallelism the vLLM code above returns one KV head: the latent is replicated on
every GPU. DeepSeek-V3 at TP=8 stores 70 KB per token on *each* of the eight
GPUs. Engines answer with **data-parallel attention**: each GPU runs attention
for its own subset of requests, so each latent lives on one GPU, while the
mixture-of-experts layers stay sharded. In vLLM that is `--data-parallel-size`
with `--enable-expert-parallel`; in SGLang v0.5.23, `--attn-dp-size` (the older
`--enable-dp-attention` is deprecated).

## Fewer cached tokens per layer: sliding windows

**Sliding-window attention (SWA)** lets a layer attend only to the last `W`
tokens, so that layer's cache never grows past `W` and a step reads at most `W`
tokens from it. Pure SWA loses long-range recall, so current models
**interleave** window layers with full-attention layers. gpt-oss spells the
pattern out per layer:

```json
  "head_dim": 64,
  …
  "layer_types": [
    "sliding_attention",
    "full_attention",
    "sliding_attention",
    "full_attention",
    …
  ],
  …
  "num_attention_heads": 64,
  "num_hidden_layers": 36,
  "num_key_value_heads": 8,
  …
  "sliding_window": 128,
```

*Verbatim — trimmed; `config.json` of openai/gpt-oss-120b on Hugging Face, checked 2026-11-21. The 36-entry list alternates as shown.*

> [!predict] Before you read on
> Half of gpt-oss's layers keep only 128 tokens. At a 128K-token context, what
> fraction of an all-full-attention cache does it need: about 1%, about 10%, or
> about 50%?

About 50%. The 18 full-attention layers store all 131,072 tokens; the 18 window
layers store 128 each: `1/2 + 1/2 × 128/131,072 ≈ 0.5005`. The window size
barely matters; the share of full-attention layers sets the saving. Gemma 3
([paper](https://arxiv.org/abs/2503.19786)) chose five 1,024-token window layers
per global layer and keeps ~17% at 128K, despite a window eight times wider.

The saving is real only if the engine frees what falls out of the window. vLLM
allocates window layers and full layers as separate groups in one pool, and
releases out-of-window blocks ([vLLM's gpt-oss post](https://vllm.ai/blog/2025-08-05-gpt-oss)).
An engine that sizes every layer for the full context reports a capacity that
ignores the design. Check the startup log's `GPU KV cache size` against your own
arithmetic before trusting either.

### The attention sink

Softmax weights must sum to 1, so a head with nothing useful to attend to still
has to put its probability somewhere, and trained models reliably dump it on the
**first tokens** of the sequence. StreamingLLM
([Xiao et al., ICLR 2024](https://arxiv.org/abs/2309.17453)) named this the
**attention sink**. They took dense models trained with full attention (Llama-2,
MPT, Falcon, Pythia), ran them with a post-hoc window that kept only the most
recent tokens, and watched output collapse once the first tokens fell out;
keeping the first four tokens restored it.

The finding is about evicting what a layer was trained to see. A model trained
with window layers never learned to rely on token 0 in them, and its full layers
keep token 0 anyway. gpt-oss goes further: each head has a trained sink term
([vLLM's gpt-oss post](https://vllm.ai/blog/2025-08-05-gpt-oss)), so there is no
token to pin, only a kernel that must support the term. The hazard lives in
post-hoc eviction policies bolted onto full-attention models, which is one
reason production serving rarely uses them.

## Reading fewer tokens: trained sparse attention

Every design so far reads everything it stores. **Sparse attention** reads a
small, chosen subset of earlier tokens, and the recent advance is training models
that way from the start. The lineage runs from **NSA**
([DeepSeek, ACL 2025](https://arxiv.org/abs/2502.11089)) and Moonshot's **MoBA**
to **DeepSeek Sparse Attention (DSA)** in DeepSeek-V3.2
([vLLM post](https://vllm.ai/blog/2025-09-29-deepseek-v3-2)). Its config adds
three fields to V3's: `index_n_heads: 64`, `index_head_dim: 128`,
`index_topk: 2048`. A cheap "lightning indexer" scores every earlier token; MLA
then attends over the top 2,048 only.

So DSA *adds* storage: each token keeps, per layer, an indexer key of 128 FP8
values plus a 4-byte scale (132 bytes in vLLM v0.34's `DeepseekV32IndexerCache`)
next to its latent, because any token may be selected later. What it cuts is the
read: at 128K context a step reads 2,048 latents and 131,072 small indexer keys
per layer instead of 131,072 latents.

> **State of play (November 2026):** trained sparse attention has spread.
> DeepSeek's V4 preview (24 April 2026; V4-Pro 1.6T total / 49B active, V4-Flash
> 284B / 13B) combines "token-wise compression + DSA", and DeepSeek made 1M
> tokens the default context of its services
> ([announcement](https://api-docs.deepseek.com/news/news260424)). V4's configs
> show it: `compress_ratios` gives each layer a ratio of 4 or 128,
> `sliding_window: 128`, a single 512-wide KV head. In vLLM v0.34's FP8 layout
> each compressed layer stores one 584-byte entry per 4 or per 128 tokens,
> beside a 128-token window: about 4.5 KB per token for V4-Pro's compressed
> layers, against ~40 KB of latents for V3.2 (656 bytes × 61 layers). Computed
> from the configs and vLLM's `deepseek_v4/attention.py` and
> `flashmla_sparse.py`, not a DeepSeek figure.
> llama.cpp v1.0.0 added Kimi-K3.1-Pro, "K3 with the full-attention MLA layers
> replaced by DSA".

## No growing cache: SSM hybrids

**State-space model (SSM)** layers, such as Mamba-2, carry a **fixed-size
recurrent state** updated token by token instead of a per-token cache. Memory
per sequence is constant in context length, and so is the read per step. The
catch is recall: a fixed-size state cannot hold every token verbatim, so
production models are **hybrids** with a minority of attention layers. IBM's
Granite 4.0-H-Small lists its layers:

```json
  "hidden_size": 4096,
  "layer_types": [
    "mamba",
    "mamba",
    "mamba",
    "mamba",
    "mamba",
    "attention",
    "mamba",
    …
  ],
  "mamba_d_conv": 4,
  "mamba_d_head": 64,
  "mamba_d_state": 128,
  "mamba_expand": 2,
  "mamba_n_groups": 1,
  "mamba_n_heads": 128,
  …
  "num_attention_heads": 32,
  "num_hidden_layers": 40,
  "num_key_value_heads": 8,
```

*Verbatim — trimmed; `config.json` of ibm-granite/granite-4.0-h-small on Hugging Face, checked 2026-11-21. The 40-entry list has `attention` at positions 6, 16, 26 and 36.*

Thirty-six Mamba layers to four attention layers. vLLM v0.34 sizes each Mamba
layer's state as `n_heads × d_head × d_state` = 128 × 64 × 128 values plus a
small convolution window, in the model's dtype (`mamba_utils.py`): 2.1 MB per
layer, ~77 MB per sequence whatever its length. The four attention layers add
16 KB per token. [Inside a Forward Pass](#/inside-a-forward-pass) worked the same
arithmetic for Qwen3.8's linear-attention layers, whose state is kept in float32.

Two serving consequences. For short requests the fixed state dominates: at
1,000 tokens Granite holds 77 MB of state and 16 MB of KV. And prefix caching,
which reuses cached keys token by token, can reuse an SSM state only at
positions where the engine saved a copy. vLLM turned prefix caching on by
default for Mamba models in v0.28 and saves such checkpoints at block boundaries.

## Putting the designs side by side

One function covers all of them. It takes a config's fields and a context
length, and returns the bytes one sequence stores and the bytes one decode step
reads from it:

```python
def kv_bytes(c, ctx, b=2):  # -> (bytes stored, bytes read per decode step), one sequence
    if "kv_lora_rank" in c:                    # MLA: one latent plus one RoPE key
        tok = c["kv_lora_rank"] + c["qk_rope_head_dim"]
    else:                                      # MHA/GQA: a K and a V per KV head
        tok = 2 * c["num_key_value_heads"] * c["head_dim"]
    stored = read = 0
    for t in c.get("layer_types") or ["full_attention"] * c["num_hidden_layers"]:
        if t == "mamba":                       # fixed-size state: SSM state + conv window
            conv = (c["mamba_d_conv"] - 1) * (c["mamba_expand"] * c["hidden_size"]
                                              + 2 * c["mamba_n_groups"] * c["mamba_d_state"])
            s = r = (c["mamba_n_heads"] * c["mamba_d_head"] * c["mamba_d_state"] + conv) * b
        else:
            n = min(ctx, c["sliding_window"]) if t == "sliding_attention" else ctx
            idx = 132 * n if "index_topk" in c else 0   # DSA indexer: FP8 key + scale
            s = n * tok * b + idx
            r = min(n, c.get("index_topk", n)) * tok * b + idx   # DSA attends to top-k
        stored, read = stored + s, read + r
    return stored, read
v3 = dict(num_hidden_layers=61, kv_lora_rank=512, qk_rope_head_dim=64)  # fields from config.json
models = {"Llama-3.3-70B": dict(num_hidden_layers=80, num_key_value_heads=8, head_dim=128),
  "DeepSeek-V3": v3, "DeepSeek-V3.2": dict(v3, index_topk=2048),
  "gpt-oss-120b": dict(num_key_value_heads=8, head_dim=64, sliding_window=128,
                       layer_types=["sliding_attention", "full_attention"] * 18),
  "Granite-4.0-H-Small": dict(num_key_value_heads=8, head_dim=128, hidden_size=4096,
      mamba_n_heads=128, mamba_d_head=64, mamba_d_state=128, mamba_d_conv=4, mamba_expand=2,
      mamba_n_groups=1, layer_types=(["mamba"] * 5 + ["attention"] + ["mamba"] * 4) * 4)}
print("MB per sequence      3,250 tok: stored   read    131,072 tok: stored    read")
for name, c in models.items():
    (s1, r1), (s2, r2) = kv_bytes(c, 3_250), kv_bytes(c, 131_072)
    print(f"{name:20}{s1/1e6:20,.0f}{r1/1e6:7,.0f}{s2/1e6:24,.0f}{r2/1e6:8,.0f}")

# --- output of an actual run ---
# MB per sequence      3,250 tok: stored   read    131,072 tok: stored    read
# Llama-3.3-70B                      1,065  1,065                  42,950  42,950
# DeepSeek-V3                          228    228                   9,211   9,211
# DeepSeek-V3.2                        255    170                  10,266   1,199
# gpt-oss-120b                         125    125                   4,837   4,837
# Granite-4.0-H-Small                  131    131                   2,225   2,225
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. Granite's config has no `head_dim` field; 4,096 ÷ 32 heads = 128.*

Read the DeepSeek-V3.2 row against V3's. At 3,250 tokens DSA stores 12% *more*
than plain MLA and reads 25% less. At 131,072 tokens it still stores more and
reads an eighth as much. Sparse attention is a bandwidth design, not a capacity
design. The Granite row is the opposite case: at 3,250 tokens the hybrid stores
about as much as gpt-oss, because 77 MB of its 131 MB is fixed state; it pulls
ahead only as context grows.

> [!dashboard] The attention read per step
> **Utilisation:** none as a metric — derive KV bytes read per step from
> `vllm:kv_cache_usage_perc` × pool size (full-attention models; window and SSM
> groups do not grow) and compare with the weight bytes. **Saturation:**
> `vllm:inter_token_latency_seconds` rising with context
> (`vllm:request_prompt_tokens`) at constant `vllm:num_requests_running`: the
> `t_kv` term of the step. **Errors:** none — a capacity mismatch between the
> startup log's `GPU KV cache size` and your `kv_bytes` arithmetic is the only
> sign that the engine did not implement the design as you assumed.

> [!case] The case: a design you cannot change
> Llama-3.3-70B is GQA-8: 328 KB per token, 82 KB per GPU under TP=4. Phase 2's
> ~40 sessions at ~11K tokens need 144 GB if nothing is shared, against a 132 GB
> pool.
>
> Would a model with a cheaper attention design be worth the switch? An MLA model
> of the same depth (80 layers × 576 × 2 bytes) caches 92 KB per token, 3.6× less
> on paper. On Halden's TP=4 node it caches *more per GPU*: the latent is
> replicated, so each GPU holds 92 KB per token against Llama's 82. The paper
> saving appears only with data-parallel attention, a different deployment. A
> hybrid like Granite would cut the cache far more, but it is a different model
> that would have to pass Halden's quality evaluation from scratch.
>
> **What this settles:** the model stays, and the cache is shrunk with levers
> that need no retraining: storing it in 8 bits ([Quantization](#/quantization)),
> which brings phase 2 to ~61 GB of the 132, and sharing prefixes. The decision
> flips if phase-2 contexts grow: with FP8 KV the pool is full when sessions
> average ~22K tokens, twice today's. Past that point the attention design, not
> the number format, is the lever, and the question goes to
> [Choosing: Model, GPU, Framework](#/choosing-model-gpu-framework).

## Exercises

<div class="exercise">

**Exercise 1.** Gemma 3 27B's text config has `num_hidden_layers: 62`,
`num_attention_heads: 32`, `num_key_value_heads: 16`, `head_dim: 128`,
`hidden_size: 5376`, `sliding_window: 1024` and `sliding_window_pattern: 6`
(every sixth layer is global, the others use the window). Compute the BF16 KV
for one 32K-token and one 128K-token sequence, and compare with an all-global
model of the same shape. Then say what `kv_bytes` above needs to read this
config.

<details>
<summary>Reveal answer</summary>

First the trap: `hidden_size / num_attention_heads` is 168, but `head_dim` says
128. Per layer per token: `2 × 16 × 128 × 2 = 8,192 bytes`. With 62 layers and a
pattern of 6, layers 6, 12, … 60 are global: 10 global, 52 local.

```text
   32K:  global  10 × 8,192 × 32,768   = 2.68 GB
         local   52 × 8,192 × 1,024    = 0.44 GB    → 3.12 GB  (all-global 16.6 GB, 5.3×)
   128K: global  10 × 8,192 × 131,072  = 10.74 GB
         local   52 × 8,192 × 1,024    =  0.44 GB   → 11.17 GB (all-global 66.6 GB, 6.0×)
```

The saving grows with context because the local part is fixed. `kv_bytes` needs
a `layer_types` list built from the pattern —
`(["sliding_attention"] * 5 + ["full_attention"]) * 10 + ["sliding_attention"] * 2`
— since this config states the rule instead of the list.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team moves DeepSeek-V3 (BF16 KV) onto 8 × H200 with
`--tensor-parallel-size 8`. Their capacity sheet assumed the cache shards eight
ways, as Llama's does, and promised ~4.2 million cached tokens on the node. The
startup log says:

```plaintext
INFO … Available KV cache memory: 34.46 GiB
INFO … GPU KV cache size: 526,464 tokens, Maximum concurrency for 163,840 tokens per request: 3.21x
```

*Real format, illustrative values — message formats from vLLM v0.34.0 `vllm/v1/worker/gpu_worker.py` and `vllm/v1/core/kv_cache_utils.py`, logger prefix trimmed; numbers computed for a 37 GB per-GPU pool, not measured.*

Is the pool smaller than expected, or the cache bigger? What would you change?

<details>
<summary>Reveal answer</summary>

Neither number is wrong. 34.46 GiB is 37.0 GB per GPU, and
37.0 × 10⁹ ÷ 70,272 bytes ≈ 526,500 tokens: every GPU stores the *full* 70 KB
latent of every token, because MLA has one latent to shard and vLLM replicates
it (`get_num_kv_heads` returns 1). The node holds ~526K tokens, not 8 × 526K. The
sheet divided by eight a cache that does not divide.

The fix is data-parallel attention — `--data-parallel-size 8
--enable-expert-parallel` in vLLM — so each GPU holds the latents of its own
requests and the node's capacity approaches 8 × 526K. The cost: attention is no
longer split across GPUs, so a single long request runs on one GPU's attention,
and the deployment needs a router that balances requests across the eight ranks.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer: is a model change worth it?** A legal team wants a
document agent with 64K-token contexts on one node with ~100 GB of KV pool. The
candidates: Qwen3-32B (`num_hidden_layers: 64`, `num_key_value_heads: 8`,
`head_dim: 128`, full attention) and Granite 4.0-H-Small (above). How many
64K-token sessions fit for each in BF16, and what would you need to know before
switching?

<details>
<summary>Reveal answer</summary>

Qwen3-32B: `2 × 64 × 8 × 128 × 2 = 262,144` bytes per token; × 65,536 = 17.2 GB
per session → **5 sessions**. Granite: 4 attention layers × 4,096 bytes × 65,536
= 1.07 GB, plus 77 MB of Mamba state → 1.15 GB → **~87 sessions**, 15× more, and
each decode step reads 15× fewer cache bytes.

Capacity is a necessary reason, not a sufficient one. Before switching: does the
hybrid's fixed state recall what the task needs from 64K tokens (run the team's
own long-document evaluation, not a public score)? Does the engine support it at
this length — vLLM keeps Mamba state checkpoints for prefix caching, so check the
hit rate on shared document prefixes? And is the quality of the 32B model
needed at all if a hybrid passes? A 15× capacity gap justifies the evaluation;
only the evaluation justifies the switch.

</details>

</div>

## What to remember

- Ask every attention design two questions: bytes stored per token, and bytes
  read per decode step. Dense designs read all they store; sparse ones do not.
- GQA divides the cache by the group size; read `num_key_value_heads` and
  `head_dim` from the config — 4, 8 and 16 KV heads are all common.
- MLA caches one latent per token (`kv_lora_rank + qk_rope_head_dim`), ~70 KB for
  DeepSeek-V3, but under tensor parallelism every GPU holds all of it; the saving
  needs data-parallel attention.
- Sliding windows save in proportion to the share of window layers, not the
  window size; the saving exists only if the engine frees out-of-window blocks.
- DSA stores slightly more and reads far less; SSM hybrids trade the growing
  cache for a fixed state that dominates short requests.

```quiz
[
  {
    "q": "Mistral-7B-v0.1's config has 32 layers, 8 KV heads, hidden_size 4096 over 32 attention heads, and sliding_window 4096 on every layer. How much BF16 KV cache does one 32,768-token conversation hold?",
    "choices": [
      "About 0.54 GB: no layer keeps more than 4,096 tokens",
      "About 4.3 GB: a window limits reads, not what is stored",
      "About 2.1 GB: half the layers keep the whole context",
      "About 0.07 GB: the window is shared by all 32 layers"
    ],
    "answer": 0,
    "explain": "head_dim = 4,096 / 32 = 128, so each layer stores 2 × 8 × 128 × 2 = 4,096 bytes per token, for at most 4,096 tokens: 32 × 4,096 × 4,096 ≈ 0.54 GB, an eighth of the 4.3 GB a full-attention model would hold at 32K. Every layer is windowed here; the 'half the layers' answer describes gpt-oss, not this config."
  },
  {
    "q": "Qwen2.5-7B has 28 layers, 4 KV heads and head_dim 128. Served by vLLM with tensor parallelism across 8 GPUs, how many bytes of BF16 KV does each GPU store per token?",
    "choices": [
      "7,168 bytes: the 57,344-byte total split evenly over 8 GPUs",
      "57,344 bytes: every GPU keeps the whole cache under TP",
      "14,336 bytes: one KV head per GPU, each head held twice",
      "28,672 bytes: two KV heads per GPU, as at any TP degree"
    ],
    "answer": 2,
    "explain": "vLLM gives each GPU max(1, 4 // 8) = 1 KV head: 28 × 2 × 1 × 128 × 2 = 14,336 bytes. Four heads cannot be split eight ways, so each head is replicated on two GPUs and the per-GPU cache stops shrinking. Even division would need eight heads; the full-copy answer describes MLA, not GQA."
  },
  {
    "q": "DeepSeek-V3.2 adds DSA to V3's MLA. At a 65,536-token context, compared with V3, what happens per sequence?",
    "choices": [
      "It stores less and reads less, because only 2,048 tokens are cached",
      "It stores about 11% more and reads roughly a seventh as much",
      "It stores the same and reads the same, since DSA only saves FLOPs",
      "It stores half as much, because the indexer replaces the latent"
    ],
    "answer": 1,
    "explain": "Per layer each token keeps its 1,152-byte latent plus a 132-byte indexer key: 1,284 vs 1,152, ~11% more. A step reads 2,048 latents (2.36 MB) plus 65,536 indexer keys (8.65 MB) per layer, ~11 MB, against 65,536 × 1,152 = 75.5 MB for V3: about a seventh. Every latent stays cached because any token may be selected later."
  },
  {
    "q": "A team serves Llama-3.1-8B, which uses full attention in every layer, with a custom policy that keeps only the most recent 4,096 cached tokens of each conversation. Long chats degrade into repetition shortly after the policy starts evicting. What is the fix?",
    "choices": [
      "Raise the window to 8,192 tokens so recent context is never lost",
      "Switch the cache to FP8 so that the policy rarely needs to evict",
      "Evict in whole 64-token blocks so the prefix cache stays aligned",
      "Keep the first few tokens resident and evict just after them"
    ],
    "answer": 3,
    "explain": "A model trained with full attention parks spare probability on its first tokens, the attention sink. Evict them and softmax spreads that mass over real tokens, distorting every head; StreamingLLM restored quality by keeping four initial tokens. A wider window or FP8 only delays the same eviction, and block alignment affects cache hits, not quality."
  },
  {
    "q": "Granite 4.0-H-Small keeps ~77 MB of Mamba state per sequence plus 16 KB of KV per token. A chat service sends 1,000-token requests. What limits how many fit in a fixed pool?",
    "choices": [
      "The KV cache of the four attention layers, about 16 MB a request",
      "The Mamba state: ~77 MB of the ~93 MB each request occupies",
      "Neither: SSM hybrids have no per-sequence memory to speak of",
      "The prefix cache, which must hold a state copy for every token"
    ],
    "answer": 1,
    "explain": "At 1,000 tokens the attention layers hold 16 MB and the fixed state 77 MB, so the state is over 80% of each request. It is constant in length, so the hybrid's advantage appears only at long contexts. Prefix caching saves state copies at block boundaries, not per token."
  }
]
```
