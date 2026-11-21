# Inside a Forward Pass

> **The question:** what does one pass over the model actually compute — and
> where, exactly, do "140 GB of weights" and "328 KB of KV cache per token"
> come from?
>
> **You'll be able to:** count a model's parameters from its `config.json` and
> say what the simple count leaves out; explain attention well enough to say why
> keys and values are cached, queries are not, and why a cached key is only
> valid behind the same prefix; compute KV bytes per token for a model whose
> config does not follow the simple pattern; say what changes between a prefill
> pass and a decode pass.

[Reading a Model Card](#/reading-a-model-card) walked through the files in a
model repository. For Llama-3.3-70B-Instruct, the large ones are 30 weight
shards totalling 141 GB. The small one, `config.json`, tells you how those
numbers are arranged:

```json
{
  "architectures": [
    "LlamaForCausalLM"
  ],
  "attention_bias": false,
  "attention_dropout": 0.0,
  "bos_token_id": 128000,
  "eos_token_id": [
    128001,
    128008,
    128009
  ],
  "head_dim": 128,
  "hidden_act": "silu",
  "hidden_size": 8192,
  "initializer_range": 0.02,
  "intermediate_size": 28672,
  "max_position_embeddings": 131072,
  "mlp_bias": false,
  "model_type": "llama",
  "num_attention_heads": 64,
  "num_hidden_layers": 80,
  "num_key_value_heads": 8,
  "pretraining_tp": 1,
  "rms_norm_eps": 1e-05,
  "rope_scaling": {
    "factor": 8.0,
    "high_freq_factor": 4.0,
    "low_freq_factor": 1.0,
    "original_max_position_embeddings": 8192,
    "rope_type": "llama3"
  },
  "rope_theta": 500000.0,
  "tie_word_embeddings": false,
  "torch_dtype": "bfloat16",
  "transformers_version": "4.47.0.dev0",
  "use_cache": true,
  "vocab_size": 128256
}
```

*Verbatim — `config.json` of Llama-3.3-70B-Instruct. The meta-llama repo is gated; this is the copy in the public RedHatAI/Llama-3.3-70B-Instruct repo, whose values are identical to the mlx-community/Llama-3.3-70B-Instruct-bf16 copy (checked 2026-11-21).*

Seven fields set the size of everything: `hidden_size`, `num_hidden_layers`,
`num_attention_heads`, `num_key_value_heads`, `head_dim`, `intermediate_size`,
`vocab_size`. Four more change the arithmetic when they take other values:
`torch_dtype` (bytes per number), `tie_word_embeddings`, and the two `*_bias`
flags. The `rope_*` fields and `max_position_embeddings` govern positions and
context length, `eos_token_id` lists the stop tokens, and most of the rest
matters to training rather than serving. By the end of
this chapter you will derive the model's size, its KV cache per token and its
compute per token from these fields, and know what each one controls. The
weights' values are given; [Where a Model Comes From](#/where-models-come-from)
covers how they were made.

## The shape of the computation

A forward pass takes token IDs in and produces next-token scores out. In
between, every token is represented by a vector of `hidden_size` = 8,192 numbers,
and that vector is pushed through 80 identical layers.

```text
  token IDs
     │  embedding lookup: row i of a 128,256 × 8,192 table
     ▼
  ┌────────── x  (one 8,192-wide vector per token) ──────────┐
  │                                                          │
  │   layer 1:   x ← x + Attention(norm(x))                  │
  │              x ← x + MLP(norm(x))                        │
  │   layer 2:   same shape, different weights               │
  │   …                                                      │
  │   layer 80                                               │
  └──────────────────────────────────────────────────────────┘
     │  final norm, then multiply by an 8,192 × 128,256 matrix
     ▼
  logits: one score per vocabulary entry → softmax → sample
```

Three things to notice before going inside.

**The vector `x` is never replaced, only added to.** Each block reads it, computes
a correction, and adds the correction back. This running vector is called the
**residual stream**. In systems terms: every stage of an 80-stage pipeline adds
its delta to the same fixed-width vector. A delta can cancel or overwrite a
direction, but no stage replaces the vector wholesale, and every stage sees the
sum of all the deltas before it.

**The norm** (`norm`, RMSNorm in Llama) rescales the vector before each block so
the numbers stay in a sensible range. It has 8,192 weights per use — negligible
for sizing.

**Each layer has two blocks.** **Attention** is the only place where tokens
exchange information with each other. The **MLP** (multilayer perceptron, also
called the feed-forward block) works on each token's vector independently. All
of the KV cache comes from the first; most of the weights live in the second.

## The MLP: where most of the weights are

Llama's MLP projects the 8,192-wide vector up to `intermediate_size` = 28,672
twice — through a "gate" matrix and an "up" matrix — passes the gate's result
through a nonlinearity (SiLU, the config's `hidden_act`), multiplies it element
by element with the up result, and projects back down to 8,192. Three matrices:

```text
  gate:  8,192 × 28,672  = 234.9 M weights
  up:    8,192 × 28,672  = 234.9 M weights
  down: 28,672 ×  8,192  = 234.9 M weights
                           ───────────────
  MLP per layer          = 704.6 M weights
```

Nothing in the MLP looks at other tokens. Feed it ten tokens and it does ten
independent matrix-vector products with the same matrices, which is to say one
matrix-matrix product. Keep that in mind; it is about to matter.

## Attention: how tokens read each other

> [!predict] Before you read on
> Of the ~856 million weights in one layer, how many belong to attention: most of
> them, about half, or less than a fifth?

Less than a fifth — about 151 million, or 18%. You will see why in a moment. The
weights are not where attention is expensive; the KV cache is.

Attention lets each token pull information from the tokens before it. Each
token's vector is multiplied by three learned matrices to produce three new
vectors:

- a **query** (`q`): what this token is looking for;
- a **key** (`k`): what this token offers to anyone looking;
- a **value** (`v`): what this token contributes if it is chosen.

They are three linear views of the same token. The mechanism is then one
sentence: **a token's attention output is an average of earlier tokens' values,
weighted by how well each earlier token's key matches this token's query.** The
match is a dot product, and softmax turns the dot products into weights that are
positive and sum to 1.

A three-token example with two-number vectors. Token 3 is being processed; its
query is `q₃ = (2, 0)`.

```text
  token   key k      value v     score q₃·k   softmax weight
  1       (1, 0)     (10, 0)        2            0.47
  2       (0, 1)     (0, 10)        0            0.06
  3       (1, 1)     (5, 5)         2            0.47

  output₃ = 0.47·(10,0) + 0.06·(0,10) + 0.47·(5,5)  ≈  (7.0, 3.0)
```

Token 3's output is mostly made of tokens 1 and 3, whose keys matched its query,
and barely of token 2, whose key did not. Real models divide the scores by
√head_dim before the softmax, to keep them from growing with vector length; here
that is √2, which would soften the weights to 0.45, 0.11, 0.45.

Two rules make this usable for generation. A token may only attend to itself and
earlier tokens — the **causal mask** — so nothing reads the future. And position
is injected by rotating each query and key by an angle that depends on the
token's position (**RoPE**, rotary position embedding), so the dot product knows
how far apart two tokens are.

### Why the cache holds K and V, and never Q

Now apply this to decode. To produce the next token you process exactly one new
token, so you compute exactly one new query. That query must be scored against
the key of **every** earlier token, and the resulting weights applied to the
value of **every** earlier token.

What do token 7's key and value depend on? In layer 1, only on token 7 and its
position. In every later layer they are computed from token 7's residual stream,
which by then carries the attention outputs of the layers below — so they depend
on tokens 1 through 7. What they never depend on is anything *after* token 7:
the causal mask forbids it. Once computed, they are final; they are the same at
step 8, step 800 and step 80,000. So they are computed once and kept: that is
the KV cache. Token 7's query, by contrast, was used once — when token 7 itself
was being processed — and no later step ever reads it. Hence a KV cache, not a
QKV cache.

The same fact sets the limits of sharing. A cached key and value are valid only
behind exactly the same tokens 1 through 7, at the same positions (keys are
cached after their RoPE rotation). Two requests that contain the same paragraph
at different offsets, or behind different text, share nothing. That is why
prefix caching, in [PagedAttention & Prefix Caching](#/paged-kv-cache), shares
*prefixes* and nothing else.

### Heads, and grouped-query attention

A layer does not run one attention but `num_attention_heads` = 64 of them side by
side, each on its own 128-number slice — the config's `head_dim`. Different
heads learn to look for different things. Their 64 outputs of 128 numbers are
concatenated back to 8,192 and mixed by one more matrix, the output projection.

If every head had its own keys and values, each token would store 64 keys and 64
values per layer. Llama 3 instead uses **grouped-query attention (GQA)**:
`num_key_value_heads` = 8, so the 64 query heads are split into 8 groups of 8, and
each group shares one key head and one value head. The query projection is still
8,192 wide; the key and value projections are only 8 × 128 = 1,024 wide.

```text
  Q projection:   8,192 × 8,192   = 67.1 M
  K projection:   8,192 × 1,024   =  8.4 M
  V projection:   8,192 × 1,024   =  8.4 M
  output proj.:   8,192 × 8,192   = 67.1 M
                                    ───────
  attention per layer             = 151.0 M
```

The cost and benefit of GQA, and its successors such as DeepSeek's MLA, belong to
[Attention Architectures for Serving](#/attention-for-serving). What you need here
is the consequence for the cache.

## The two numbers, derived

**Weights.** One layer is 151.0 M (attention) + 704.6 M (MLP) = 855.6 M weights.
Eighty layers make 68.45 B. The embedding table and the final output matrix
(the "LM head") are each 128,256 × 8,192 = 1.05 B, and `tie_word_embeddings:
false` says they are two separate matrices. Here is the whole count, run on the
config's own field names:

```python
# Fields copied from Llama-3.3-70B-Instruct's config.json
cfg = {"hidden_size": 8192, "intermediate_size": 28672,
       "num_hidden_layers": 80, "num_attention_heads": 64,
       "num_key_value_heads": 8, "head_dim": 128,
       "vocab_size": 128256, "tie_word_embeddings": False}

d, L = cfg["hidden_size"], cfg["num_hidden_layers"]
hd = cfg.get("head_dim") or d // cfg["num_attention_heads"]
q_width = cfg["num_attention_heads"] * hd     # all query heads side by side
kv_width = cfg["num_key_value_heads"] * hd    # K (and V) heads side by side

attn = d * q_width + 2 * d * kv_width + q_width * d   # Q, K, V, O
mlp = 3 * d * cfg["intermediate_size"]                # gate, up, down
norms = 2 * d                                         # two RMSNorm vectors
embed = cfg["vocab_size"] * d
lm_head = 0 if cfg["tie_word_embeddings"] else embed

total = L * (attn + mlp + norms) + embed + lm_head + d   # + final norm
print(f"per layer: attention {attn:,}  MLP {mlp:,}  norms {norms:,}")
print(f"parameters: {total:,}")
print(f"BF16 weights: {2 * total:,} bytes ({2 * total / 1e9:.1f} GB)")
print(f"KV per token, BF16: {2 * L * kv_width * 2:,} bytes")

# --- output of an actual run ---
# per layer: attention 150,994,944  MLP 704,643,072  norms 16,384
# parameters: 70,553,706,496
# BF16 weights: 141,107,412,992 bytes (141.1 GB)
# KV per token, BF16: 327,680 bytes
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

The repository agrees to the byte. Its `model.safetensors.index.json`, which
maps each of the 723 tensors to a shard, opens like this:

```json
{
  "metadata": {
    "total_size": 141107412992
  },
  "weight_map": {
    "lm_head.weight": "model-00030-of-00030.safetensors",
    "model.embed_tokens.weight": "model-00001-of-00030.safetensors",
    "model.layers.0.input_layernorm.weight": "model-00001-of-00030.safetensors",
    "model.layers.0.mlp.down_proj.weight": "model-00001-of-00030.safetensors",
    …
```

*Verbatim — trimmed; `model.safetensors.index.json` in the RedHatAI/Llama-3.3-70B-Instruct and unsloth/Llama-3.3-70B-Instruct copies (same `total_size` in both, checked 2026-11-21).*

The tensor names are the chapter's vocabulary: per layer, `q_proj`, `k_proj`,
`v_proj`, `o_proj`, `gate_proj`, `up_proj`, `down_proj` and two norms — nine
tensors × 80 layers, plus embedding, final norm and LM head, is 723. The simple
formula (layers × (attention + MLP) + embedding + head) leaves out only the norms,
1.3 M weights, 0.002%. It holds here because this config has no biases
(`attention_bias`, `mlp_bias` false) and untied embeddings. A model with
`tie_word_embeddings: true` stores one vocabulary matrix, not two; one with
biases adds a vector per projection.

The exact size is 141.1 GB. The course, like most people, rounds the model to
"70 B parameters" and uses **70 × 10⁹ × 2 bytes = 140 GB** from here on; the
1 GB difference moves no decision.

**KV cache per token.** Each token stores, in every layer, one key and one value
for each of the 8 KV heads, each 128 numbers long:

```text
  kv_bytes_per_token = 2 × n_layers × n_kv_heads × head_dim × bytes_per_element
                     = 2 (K and V) × 80 × 8 × 128 × 2 bytes
                     = 327,680 bytes  ≈  328 KB per token
```

Notice what is *not* in it: `hidden_size`, `intermediate_size`, the number of
query heads, the vocabulary. The MLP holds 80% of the weights and contributes
nothing to the cache. Only the attention's key-value shape does. And read
`head_dim` from the config: it equals `hidden_size / num_attention_heads` here,
but not in every model.

> [!predict] Before you read on
> If Llama 3 had given every one of its 64 query heads its own key and value
> heads, how much bigger would the KV cache be per token?

Eight times bigger — `n_kv_heads` would be 64 instead of 8 — so about 2.6 MB per
token instead of 328 KB. A 3,000-token conversation would hold 7.9 GB of cache
instead of 1 GB. That one design choice is the difference between serving
dozens of long conversations per GPU and serving a handful.

## How much work a pass does

Every weight in a matrix multiply is used once per token: one multiplication and
one addition into a running sum. Two floating-point operations (**FLOPs**) per
weight per token, so a forward pass costs about **2 × P FLOPs per token**. Two
corrections, both small for this model: the embedding is a table lookup, not a
multiply, and in prefill an engine applies the LM head only to the last prompt
token. Exactly counted, a token costs ~139 GFLOPs; the course uses
2 × 70 × 10⁹ = 140 GFLOPs, the figure [Inference Arithmetic](#/inference-arithmetic)
builds on.

Attention adds a second kind of work that involves no weights: scoring the query
against every cached key and averaging every cached value. For one query head
and a context of c tokens, the scores are c dot products of length 128 — a
multiply and an add per element, 2 × 128 × c FLOPs — and the weighted sum of c
values costs the same again. Per layer and per token that is
`4 × head_dim × c` for each of the 64 query heads: `4 × 8,192 × c`. GQA does not
help here: eight query heads share a key, but each still computes its own dot
product with it. GQA cuts the cache's bytes, not attention's arithmetic.

> [!predict] Before you read on
> At a context of 3,000 tokens — the case's typical request — is that attention
> work, for one decode step, a rounding error next to the 140 GFLOPs of weight
> work, roughly equal to it, or larger?

A rounding error, for now: `4 × 8,192 × 3,000 × 80 layers ≈ 7.9 GFLOPs`, about
6% of the weight work. It grows linearly with context, so near 53,000 tokens it
equals the weight work, and at 128K it is more than double. Prefill is cheaper
per token: under the causal mask, token *i* of a 3,000-token prompt attends to
*i* tokens, 1,500 on average, so attention adds about 3% to a prefill at this
length. Long contexts change the economics, which is why the kernels in
[FlashAttention](#/flashattention) exist; the more immediate cost of context is
bytes, since every cached key and value is read at every decode step.

## Prefill and decode, as shapes

You now have enough to see the difference between the two phases as a difference
in matrix shapes.

During **prefill**, all `T` prompt tokens go through each layer together. The
activations are a `T × 8,192` matrix, and each weight multiply is a
matrix × matrix product: `[T × 8,192] · [8,192 × 28,672]`. Each weight is fetched
once and used for all `T` tokens.

During **decode**, one token goes through. The activations are a `1 × 8,192`
vector, and each weight multiply is a vector × matrix product:
`[1 × 8,192] · [8,192 × 28,672]`. Each weight is fetched once and used for one
token — and then the whole model must be fetched again for the next token.

Same weights, same code, very different ratio of arithmetic to data fetched.
[The GPU Mental Model](#/gpu-mental-model) explains why that ratio decides
everything about speed, and [Inference Arithmetic](#/inference-arithmetic) puts
numbers on it.

> [!case] The case: what Ask Halden is carrying
> Everything below comes from Llama-3.3-70B's `config.json`.
>
> - **Weights:** 140 GB in BF16 (141.1 GB exactly). One 80 GB GPU cannot hold
>   them. Split four ways with [tensor parallelism](#/parallelism-for-inference) (each GPU holds a quarter of
>   every layer's matrices, including 2 of the 8 KV heads), each GPU carries
>   35 GB of weights and 82 KB of KV per token.
> - **KV cache:** 328 KB per token on the node. A typical request (3,000 in, 250
>   out) ends holding 3,250 × 328 KB ≈ 1.07 GB, of which the 800-token system
>   prompt is 262 MB — shareable between requests only because it comes first.
> - **Compute:** ~140 GFLOPs per token; prefilling 3,000 tokens is ~4.2 × 10¹⁴
>   FLOPs, plus ~3% for attention.
>
> **Why four GPUs and not two.** Two GPUs hold 160 GB. At the case's memory
> budget (90% of each GPU) that is 144 GB, minus 140 GB of weights and ~8 GB of
> runtime overhead and activations: **−4 GB**. In BF16 the model does not run on
> two GPUs at all, so the four-GPU node is forced. That holds only while weights
> take two bytes each; [Quantization](#/quantization) reopens it.

## Exercises

<div class="exercise">

**Exercise 1 — find the flaw.** A colleague drafts this capacity note for Ask
Halden. Some lines are wrong, some are right. Find the errors and correct them
before you open the answer.

```text
Capacity note: KV cache (draft)
1. KV per token = 2 (K, V) × 80 layers × 8,192 (hidden_size) × 2 B ≈ 2.6 MB.
2. So a full phase-1 request (3,250 tokens) holds ~8.5 GB of KV.
3. The MLP is 80% of the weights, so a variant with half the
   intermediate_size would roughly halve the KV cache as well.
4. Every request that quotes the warehouse safety policy can reuse that
   policy's cached K/V, wherever the policy appears in the prompt.
5. Prefill attention at 3,000 tokens adds only ~3% to the weight FLOPs.
```

<details>
<summary>Reveal answer</summary>

1. **Wrong.** It uses `hidden_size`, the width of all 64 query heads. The cache
   stores KV heads only: 8 × 128 = 1,024 wide, so 2 × 80 × 1,024 × 2 = 327,680 B
   ≈ 328 KB. The error is 8×, exactly the GQA factor.
2. **Wrong by inheritance:** 3,250 × 328 KB ≈ 1.07 GB.
3. **Wrong.** The MLP appears nowhere in the KV formula. Halving it cuts the
   weights by ~40% and the cache by nothing (and makes a different, weaker model).
4. **Wrong.** Beyond the first layer, the policy's keys and values depend on
   every token before them, and keys carry their position. They are reusable
   only when everything before them is identical too — a shared prefix.
5. **Right.** Under the causal mask the average token attends to ~1,500 others:
   2 × 8,192 × 3,000² × 80 ≈ 1.2 × 10¹³ FLOPs against 4.2 × 10¹⁴.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** The team starts vLLM v0.34 on the node with the
case's settings (TP=4, `--gpu-memory-utilization 0.90`, nothing else). The
capacity plan promised room for ~120 full-length phase-1 requests. A colleague
pastes two startup lines into the channel: "we can only serve 3 users at
once?!"

```plaintext
INFO … Available KV cache memory: 30.73 GiB
INFO … GPU KV cache size: 402,816 tokens, Maximum concurrency for 131,072 tokens per request: 3.07x
```

*Real format, illustrative values — message formats from vLLM v0.34.0 `vllm/v1/worker/gpu_worker.py` and `vllm/v1/core/kv_cache_utils.py`, logger prefix trimmed; numbers computed from the case's 33 GB-per-GPU pool, not measured.*

Is the pool smaller than planned? Where does 3.07 come from — which field of
`config.json` is behind it? What would you change, and what would the change
cost?

<details>
<summary>Reveal answer</summary>

Check the pool first. 30.73 GiB is 33.0 GB per GPU. Each GPU holds 2 of the 8 KV
heads, so 81,920 bytes per token: 33.0 × 10⁹ ÷ 81,920 ≈ 402,800 tokens, rounded
down to whole 64-token blocks. The
token figure matches the plan (132 GB on the node), and 402,816 ÷ 3,250 ≈ 124
full-length requests. Nothing is missing.

The 3.07× is the token figure divided by `max_model_len`: 402,816 ÷ 131,072. No
`--max-model-len` was passed, so vLLM derived it from `max_position_embeddings`
in `config.json` (for `rope_type` "llama3" it does not multiply by the scaling
factor; `vllm/config/model.py`). The line answers "how many requests of 131,072
tokens fit", which nobody asked.

Read the token figure, not the concurrency figure. If you want the line to speak
your workload, pass `--max-model-len` set to the longest request you will accept
— 32,768 would make it read 12.29× — at the price of rejecting anything longer.
Phase 1 needs ~3,250; phase 2's agent contexts reach 20K, so a cap below ~21K
would break phase 2.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Qwen3.8-27B, an open-weights model released in
August 2026, is a candidate for a second Halden service. Excerpts of its
`config.json` (text model) and of its weight index:

```json
    "full_attention_interval": 4,
    "head_dim": 256,
    "hidden_size": 5120,
    "intermediate_size": 17408,
    "layer_types": [
        "linear_attention",
        "linear_attention",
        "linear_attention",
        "full_attention",
        …
    ],
    "linear_conv_kernel_dim": 4,
    "linear_key_head_dim": 128,
    "linear_num_key_heads": 16,
    "linear_num_value_heads": 48,
    "linear_value_head_dim": 128,
    "mamba_ssm_dtype": "float32",
    …
    "num_attention_heads": 24,
    "num_hidden_layers": 64,
    "num_key_value_heads": 4,
    …
  "metadata": {
    "total_size": 55562855904.0
```

*Verbatim — trimmed; `config.json` (`text_config`) and `model.safetensors.index.json` of Qwen/Qwen3.8-27B on Hugging Face, revision 37561816, checked 2026-11-21. The 64-entry `layer_types` list repeats the pattern shown.*

(a) How big are the weights, and why will the Llama-style count not reproduce
it? (b) What is its KV cache per token in BF16? (c) How many 3,250-token
requests fit in a 40 GB pool, against ~37 for Llama-3.3-70B?

<details>
<summary>Reveal answer</summary>

(a) 55.6 GB, ≈ 27.8 B parameters at two bytes. The simple count would miss
pieces this repo carries — a vision encoder (`model.visual.*` tensors), a
multi-token-prediction layer (`mtp.*`), and linear-attention layers with
projections of their own shape. When the config is not a plain Llama, trust
`total_size`.

(b) Two traps. `hidden_size / num_attention_heads` is 213.3; the real `head_dim`
is 256. And only the `full_attention` layers — every fourth, 16 of 64 — keep
keys and values per token. 2 × 16 × 4 × 256 × 2 = **65,536 bytes**, 64 KiB per
token. The naive formula (64 layers, head_dim 213) gives 218,112: 3.3× too big.

(c) The other 48 layers keep a fixed-size state per sequence instead of a
per-token cache. In vLLM v0.34 its shape is 48 value heads × 128 × 128 per layer
(`mamba_utils.py`), stored in float32 because the config's `mamba_ssm_dtype`
says so: 3.1 MB per layer, ~150 MB per sequence (plus ~3 MB of convolution
state), whatever the length. A 3,250-token request: 3,250 × 64 KiB ≈ 213 MB +
~154 MB ≈ 367 MB, so ~109 requests in 40 GB, three times Llama's 37. For short
requests the fixed state is the larger part — it equals the KV of ~2,300 tokens.

</details>

</div>

## What to remember

- A forward pass pushes one `hidden_size`-wide vector per token through `n`
  identical layers, each made of an attention block and an MLP block that add to
  a running residual stream.
- Most weights are in the MLP (80% for Llama-3.3-70B). The KV cache comes
  entirely from attention.
- A token's keys and values at layer ℓ depend on every token up to it and on
  nothing after it: computed once, never changed, and reusable only behind an
  identical prefix.
- `kv_bytes_per_token = 2 × n_layers × n_kv_heads × head_dim × bytes` — 328 KB
  for Llama-3.3-70B — counting only layers that keep a per-token cache, with
  `head_dim` read from the config.
- A pass costs ~2 × P FLOPs per token for the weights, plus attention work that
  grows with context; GQA shrinks the cache, not that work.
- Prefill multiplies weights by a `T`-row matrix; decode multiplies them by a
  single row. That difference in shape is what the next two chapters turn into
  speed.

```quiz
[
  {
    "q": "A team serves Llama-3.3-70B (8 KV heads) with tensor parallelism across 16 GPUs on two nodes. How many bytes of BF16 KV cache does each GPU hold per token?",
    "choices": [
      "20,480 bytes: the 327,680-byte total divided evenly across all 16 GPUs",
      "40,960 bytes: one KV head per GPU, each head held by two of the GPUs",
      "327,680 bytes: every GPU keeps a full copy of the cache for all its tokens",
      "81,920 bytes: each GPU always holds two KV heads under any tensor split"
    ],
    "answer": 1,
    "explain": "A KV head cannot be split below one per GPU. With 8 heads and 16 GPUs, each GPU holds one head and pairs of GPUs hold the same one (vLLM replicates KV heads when the TP size exceeds their number): 2 × 80 × 1 × 128 × 2 = 40,960 bytes. The 20,480 answer assumes heads divide indefinitely."
  },
  {
    "q": "Request A is an 800-token system prompt followed by a policy excerpt. Request B is the same policy excerpt with no system prompt in front. Can B reuse A's cached keys and values for the excerpt?",
    "choices": [
      "Yes, because the excerpt's tokens are identical in both requests",
      "Yes, provided both requests also use the same sampling temperature",
      "Only for the first layer, where keys depend on nothing but the token",
      "No: from layer 2 on they depend on every token before the excerpt"
    ],
    "answer": 3,
    "explain": "Beyond the first layer, a token's key and value are projections of its residual stream, which already mixes in all earlier tokens; keys also carry their absolute position. Different text in front means different vectors. The first-layer option is true in principle but useless: an engine needs every layer of a token cached to skip recomputing it."
  },
  {
    "q": "Why does the KV cache store keys and values but not queries?",
    "choices": [
      "Queries are recomputed cheaply from the cached keys at each decode step instead",
      "Queries are much larger than keys and values, so caching them costs far too much",
      "An earlier token's query is never read again; its K and V are read at every step",
      "Queries depend on the sampled output, so they change after every single decode step"
    ],
    "answer": 2,
    "explain": "At each decode step only the new token's query is needed, and it must be computed anyway. Every earlier token's key and value are read by every later step and never change, so storing them once saves recomputation. Under GQA queries are wider than keys, but that is not the reason."
  },
  {
    "q": "Llama-3.2-1B's config has hidden_size 2048, vocab_size 128,256 and tie_word_embeddings: true. A count that adds an embedding table and an LM head separately is too high by about how much?",
    "choices": [
      "About 263 million: one 128,256 × 2,048 matrix counted twice",
      "About 525 million: both vocabulary matrices are shared, so both go",
      "About 131 million: tying shares only half of the vocabulary rows",
      "Nothing: tying changes how weights are trained, not how many are stored"
    ],
    "answer": 0,
    "explain": "Tied embeddings mean the LM head reuses the embedding matrix, so the checkpoint stores one 128,256 × 2,048 table (262.7 M weights) instead of two. Removing both would leave no vocabulary matrix at all. On a 1.2B-parameter model that is a fifth of the total, which is why the field matters most for small models."
  },
  {
    "q": "Llama-3-8B has 32 layers and 32 query heads of 128 (4,096 wide) and costs ~16 GFLOPs per token in weights. At a 32K-token context, how does one decode step's attention work compare?",
    "choices": [
      "A few percent, as for the 70B model at a typical context",
      "About 10%, because 8 KV heads shrink attention eightfold",
      "Roughly equal: 4 × 4,096 × 32,768 × 32 ≈ 17 GFLOPs",
      "About four times larger, since attention dominates past 8K"
    ],
    "answer": 2,
    "explain": "Attention per decode step is 4 × (query heads × head_dim) × context × layers = 4 × 4,096 × 32,768 × 32 ≈ 17 GFLOPs, about the same as the ~16 GFLOPs of weights. Smaller models reach the crossover at shorter contexts. GQA does not shrink this work: every query head still scores every key."
  }
]
```
