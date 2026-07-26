# Attention Architectures for Serving

> **Goal of this chapter:** finally learn the one mechanism the course has been
> deferring — **attention** — gently and from scratch, then watch model
> architects redesign it to shrink the KV cache *at design time*. By the end
> you'll be able to read "GQA-8", "MLA", "sliding window", and "sparse
> attention" on a model card and know exactly what each one does to the memory
> that caps your concurrency — and why every 2026 flagship model uses one.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kernels,kv"></div>

You already know the KV cache is the villain of serving. [Inference
Arithmetic](#/inference-arithmetic) gave you the formula — `2 × n_layers ×
n_kv_heads × head_dim × bytes` per token — and the punchline: at long context and
high concurrency, that cache, not the weights, caps how many users share a GPU.
[PagedAttention](#/paged-kv-cache) then packed it without waste.

But paging only manages the cache you're given. This chapter is a more
fundamental lever: **the architect chooses how big each token's cache entry is,
before a single weight is trained.** To see how, you must finally open the box
the course has carried unopened — the mechanism that produces those keys and
values.

## Attention in ten lines

Here is the entire idea. A transformer processes a sequence of tokens. For each
token it must decide *which other tokens matter* for predicting what comes next,
and mix in information from them. **Attention** is how.

Every token turns its own vector (the embedding from chapter 1) into **three**
new vectors, each by a simple matrix multiply — a learned weight matrix times the
token's vector:

- **Query (Q)** — "what am I looking for?"
- **Key (K)** — "what do I offer, if someone's looking?"
- **Value (V)** — "what information do I contribute if attended to?"

That's all Q, K, V are: three linear projections of the same token, nothing
exotic. Now the mechanism, in one sentence: **a token's output is a weighted
average of every earlier token's Value, where each weight is how well that
token's Key matches my Query.** The match score is just a dot product `Q · K`
(big when the vectors point the same way), turned into weights that sum to 1 by
**softmax** — the squash-to-probabilities function from chapter 1.

Make it concrete with three tokens: `The cat ... it`. Processing `it`, the model
emits a query that asks "what noun am I standing in for?" The token `cat` has
been advertising a key that says "I'm an animal, a subject." Their dot product is
large; `The` scores low. Softmax turns those into weights like `0.9` on `cat`,
`0.1` on `The` — so `it`'s output is mostly `cat`'s *value*. The model has
resolved the pronoun by *attending* to `cat`. Do this for every token and
information flows along exactly the links that matter.

```text
  processing "it":

     Q(it) · K(The) = 0.4  ┐                weights        pulls in
     Q(it) · K(cat) = 3.1  ├─ softmax ─▶  The:0.10  ─▶  0.10·V(The)
                           ┘              cat:0.90  ─▶  0.90·V(cat)
                                                          ─────────────
                                          output(it) ≈ mostly V(cat)
```

## Where the KV cache actually comes from

Look at what the output of `it` needed: the **Key and Value of every earlier
token** — the whole reason the KV cache exists. In the autoregressive loop each
new token dots its query against all past keys and averages all past values, so
the engine stores each token's K and V once and reuses them forever after.
Recompute them every step and you're back to the quadratic waste chapter 1 warned
about.

Now the chapter-3 formula stops being magic and becomes *obvious*:

- The `2` is **K and V** — two vectors cached per token.
- `head_dim` is the length of each K (and V) vector.
- And the heads? Real transformers don't run *one* attention but many in
  parallel — **multi-head attention (MHA)** — each head with its own Q, K, V
  projections, learning a different notion of "what matters" (syntax, long-range
  topic, the pronoun link above). So each token caches K and V *per head*, and the
  formula's `n_kv_heads` is exactly that head count.

`2 × n_layers × n_kv_heads × head_dim × bytes`. Every factor is now a thing you
can point at — and the moment you can point at `n_kv_heads`, you see the lever:
**cache fewer K/V heads and every entry shrinks, permanently, free at serve
time.** The rest of this chapter is architects pulling that lever four ways.

## MHA → MQA → GQA: share the K/V heads

In plain MHA, 64 query heads means 64 key heads and 64 value heads — a full K/V
per head, maximum quality and maximum cache. The insight of the next two
variants: query heads must stay diverse (they ask 64 different questions), but
the keys and values they look at can be **shared**.

- **MQA (multi-query attention):** all 64 query heads share a *single* K/V head —
  a 64× cut. But one shared K/V can measurably hurt long-context recall; it's a
  lot to ask of 64 different queries.
- **GQA (grouped-query attention):** the compromise that won. Split the query
  heads into `g` groups, each sharing one K/V head. With **8 groups (GQA-8)**, 64
  query heads map onto 8 K/V heads — an 8× cache cut that recovers essentially all
  of MHA's quality. **Llama 3, Qwen, Mistral, and Gemma all ship GQA-8**: the
  2026 default.

Run one 70B-class model (80 layers, 64 query heads, `head_dim` 128, BF16) through
all four designs — the table to keep in your head for the whole chapter:

| Variant | K/V heads | KV bytes / token | vs. MHA |
|---|---|---|---|
| **MHA** | 64 | `2×80×64×128×2` = **2.6 MB** | 1× |
| **MQA** | 1 | `2×80×1×128×2` = **41 KB** | 64× smaller |
| **GQA-8** | 8 | `2×80×8×128×2` = **328 KB** | 8× smaller |
| **MLA** (DeepSeek-V3\*) | latent 576 | ≈ **70 KB** | see below |

\* MLA's row is DeepSeek-V3, a **671B** model (61 layers) — no one applies MLA to
a 70B, and that's exactly the point of the next section.

The MHA→GQA-8 jump alone is the difference between fitting a handful of long
sequences on a GPU and fitting dozens. Everything before this chapter — paging,
prefix caching — squeezes the 328 KB; GQA *chose* 328 KB over 2.6 MB at design
time.

## MLA: cache one latent, not many heads

DeepSeek asked a sharper question: instead of *sharing* K/V heads, why store
per-head K/V at all? **Multi-head Latent Attention (MLA)**
([DeepSeek-V2/V3](https://arxiv.org/pdf/2412.19437)) jointly compresses *all*
heads' keys and values into **one small latent vector** per token (512 dims here)
via a down-projection, caching only that latent; at decode an up-projection
reconstructs each head's full K and V on the fly.

The result is the table's headline: DeepSeek-V3, a **671-billion-parameter**
model, caches **~70 KB/token** — *less than the 70B GQA model's 328 KB.* A model
nearly ten times larger with a smaller per-token cache, because the cache was
designed as a compression target, not a raw dump of every head.

![Four attention architectures side by side — MHA wiring 64 query heads to 64 K/V heads at 2.6 MB per token, MQA collapsing to one shared K/V head at 41 KB, GQA-8 grouping the query heads onto 8 K/V heads at 328 KB, and MLA caching a single 576-dimension latent that an up-projection expands at decode time, about 70 KB](assets/diagrams/attention-architectures.svg)

Two subtleties make MLA work, and both are beautiful.

**1. Decoupled RoPE — why the obvious thing breaks.** Transformers encode token
*position* using RoPE (rotary position embeddings), which rotates each key by an
angle that depends on where the token sits. The trouble: that position-dependent
rotation does **not** survive low-rank compression — mixing position into the
compressed key destroys the clean factorization MLA relies on. DeepSeek's fix is
to *split* the key: a compressed **content** part (512 dims, no RoPE) plus a
small **decoupled positional** part (64 dims, RoPE applied) carried alongside.
`512 + 64 = 576` — the "latent 576" in the table. When an elegant trick collides
with a load-bearing feature, carve out a tiny separate channel rather than
abandon the trick.

**2. Matrix absorption — more math per byte, on purpose.** Naively, decode would
up-project the latent back to full K/V, then attend. But matrix multiplication is
associative, so the up-projection weights can be *absorbed* into the neighboring
query and output matrices ahead of time — decode then attends **directly on the
compressed 576-dim latent**, never materializing the full heads. This does *more*
arithmetic per byte read, and recall from [Inference
Arithmetic](#/inference-arithmetic) that decode is **memory-bandwidth bound**,
wasting almost all the GPU's FLOPs. Trading spare compute for fewer bytes is
exactly right when bandwidth-starved. (Prefill, compute-bound, uses the
un-absorbed "materialize" path.) These kernels live in
[FlashAttention](#/flashattention).

## Sliding windows, hybrid layers, and the sink nobody expected

GQA and MLA shrink each token's entry; a different lever caps the *number* of
entries. **Sliding-window attention (SWA)** lets a token attend only to the last
`W` tokens instead of the whole history, so the cache per SWA layer never grows
past `W` — bounded KV regardless of a million-token context. Pure SWA throws away
long-range recall, so modern models **interleave** window and full layers:

- **Gemma 3** ([paper](https://arxiv.org/pdf/2503.19786)) runs **5 local
  (1024-window) layers per 1 global** — a 5:1 ratio that pulls KV from ~60% to
  under 15% of activation memory at 128K context.
- **gpt-oss** ([vLLM](https://blog.vllm.ai/2025/08/05/gpt-oss.html)) alternates
  full and 128-window layers **1:1**, atop GQA (64 query / 8 K/V heads).

> **Common trap:** "sliding window just means a smaller context." No — the model
> still handles long contexts; only *most layers* look locally, while the few
> global layers carry long-range information forward. It's a memory-shape choice,
> not a context-length limit.

Now the strangest empirical fact in the area. Softmax weights must sum to 1, so
when a token has nothing useful to attend to, the mechanism still puts that
probability *somewhere* — and it reliably dumps the excess onto **the very first
token**. This "**attention sink**" looks like a bug and is load-bearing: evict
token 0 to save cache and a sliding-window model's quality **collapses**.
gpt-oss handles it by baking in a **learnable per-head sink logit** — an explicit
"attend to nothing" slot — so a head can shed probability without hijacking a
real token. Engines must cooperate: the kernel needs an explicit sink term, and
the KV allocator must pin the sink tokens even under a sliding window.

> [!bridge] You already know this — from the Linux course
> A sliding window is an eviction policy, and Linux's page-cache reclaim is the
> one you already have intuition for: keep the recently used, drop the rest.
> What differs is the exception. Linux reclaim scans by recency, so the oldest
> page is the first victim; here the *oldest* entry — token 0, the attention
> sink — is the one entry you must never evict, and the KV allocator has to know
> that as a rule, not learn it from access patterns.
> [→ Linux: Virtual Memory](../#/memory)

## Trainable sparse attention: the real break from dense

Every variant so far still attends *densely* within its window — each query sees
every key in range. The 2025–26 breakthrough: attend to only a **small learned
subset** of past tokens, and **train the model that way from the start** rather
than bolting sparsity on afterward.

The lineage: **NSA** (DeepSeek, [ACL 2025](https://arxiv.org/abs/2502.11089))
made sparsity hardware-aligned and native to pretraining; **MoBA** (Moonshot)
routed query blocks to KV blocks like a mixture-of-experts. Then **DSA (DeepSeek
Sparse Attention)** in **DeepSeek-V3.2-Exp** reached production
([vLLM](https://blog.vllm.ai/2025/09/29/deepseek-v3-2.html), Sept 2025): a
**"lightning indexer"** — an ultra-cheap FP8 scorer — runs over every past token,
**top-k** picks the most relevant (k ≈ 2048), and full MLA attention runs on
*only those*. Cost drops from O(L²) to O(L·k), near-flat as context grows.

> **State of play (mid-2026):** DSA shipped day-0 in vLLM and SGLang with a
> **>50% API price cut** — the clearest sign it's production-real, not a paper.
> It is the **first genuine break from dense attention at frontier scale**, and it
> works *because* the sparsity was trained in: the model learned to rely on
> exactly the tokens the indexer keeps. (DeepSeek-V4 followed with the same
> lineage.)

## When the cache stops growing at all: SSM hybrids

The most radical answer abolishes the growing cache. **State-space model
(SSM / Mamba)** layers carry a **fixed-size recurrent state** — a running summary
updated token by token — instead of a per-token cache. Memory is **O(1)** in
sequence length; decode cost is constant however long the context.

The catch: pure SSMs underperform on precise recall (a fixed state can't hold
every token verbatim). So production uses **hybrids** — mostly SSM with a
minority of real attention layers for recall: **Nemotron-H**, **IBM Granite 4**
(~9:1 Mamba:attention), **Jamba**. Engines treat these first-class — vLLM's V1
manages the SSM state alongside paged KV
([PyTorch](https://pytorch.org/blog/hybrid-models-as-first-class-citizens-in-vllm/)).
Attention buys quality, SSM buys cheap long context — the industry **mixes them**
rather than picking.

> [!bridge] You already know this — from the distributed course
> A KV cache is an append-only log of everything that happened; an SSM state is
> a snapshot of what that log *means*. Raft makes exactly this trade when it
> compacts: replace an unbounded log with a fixed-size snapshot of the state
> machine, and bound your memory forever. The cost is the same in both places —
> once the log is gone you can no longer replay a specific old entry verbatim,
> which is precisely the recall weakness that forces SSM *hybrids* to keep a few
> real attention layers around.
> [→ Distributed: Raft, Step by Step](../distributed/#/raft)

## A serving footnote: extending context with RoPE scaling

One honest paragraph, because it's adjacent. Techniques like **YaRN**
([paper](https://arxiv.org/pdf/2309.00071)) stretch a model trained at 4K tokens
to run at 128K by *interpolating* RoPE's frequencies — a serving-time feature, no
retraining. The tension worth knowing: with *dynamic* scaling the rotation on
keys changes as the sequence grows, so a key cached under one scaling is wrong
under the next — **it can break naive reuse of cached RoPE'd keys**. Context
extension and KV reuse pull against each other; the details belong to
[Parallelism for Inference](#/parallelism-for-inference).

> **What actually shipped.** The literature is full of *post-hoc* KV savings —
> **H2O** and **StreamingLLM** evict "unimportant" cached tokens at inference
> time, both heavily cited. In production they're rare. Frontier serving went
> **architectural and trained-in** (GQA, MLA, hybrid windows, trained sparsity)
> plus [quantization](#/quantization) and [paging](#/paged-kv-cache). The lasting
> gift of that eviction literature wasn't an algorithm — it was StreamingLLM
> *discovering the attention sink*, which architects baked into the model.

## What to remember

- **Attention in one line:** each token emits a Query, Key, Value; its output is
  a softmax-weighted average of past tokens' Values, weighted by `Q·K`. The
  cached K and V *are* the KV cache — per-head, which is why the chapter-3
  formula counts `n_kv_heads`.
- **GQA-8** — 8 K/V heads shared across 64 query heads — is the 2026 default
  (Llama/Qwen/Mistral/Gemma): 8× smaller cache, MHA-level quality.
- **MLA** compresses all heads' K/V into one ~576-dim latent; a 671B DeepSeek
  caches **less per token than a 70B GQA model**. It needs **decoupled RoPE**
  (position won't compress) and profits from **matrix absorption** (attend on the
  latent — more FLOPs per byte, a win when bandwidth-bound).
- **Sliding-window + hybrid layers** (Gemma 5:1, gpt-oss 1:1) bound KV
  regardless of context; **attention sinks** (softmax's dumping ground on
  token 0) must be preserved or SWA collapses.
- **Trainable sparse attention** (NSA → MoBA → **DSA**, DeepSeek-V3.2) is the
  first real break from dense attention at frontier scale — O(L·k), trained in.
- **SSM hybrids** (Nemotron-H, Granite 4, Jamba) swap the growing cache for a
  fixed-size state — O(1) memory — keeping a few attention layers for recall.
- All are **design-time** choices about cache size. Production chose these plus
  quantization and paging over the cited-but-unshipped post-hoc eviction papers.

## Frequently asked

<div class="faq">

<details>
<summary>The model card doesn't say "GQA" anywhere. How do I tell what it uses?</summary>

Open the checkpoint's `config.json` and compare `num_attention_heads` with
`num_key_value_heads`. Equal means MHA. `num_key_value_heads: 1` means MQA.
Anything in between is GQA, and the ratio is the group count — 64 and 8 is
GQA-8. That second number is the `n_kv_heads` in the KV formula, so it is the
only one that sets your cache size. MLA models look different again: you will
see a `kv_lora_rank` (512 for DeepSeek-V3) and a separate rope-dimension field
instead of a K/V head count.

</details>

<details>
<summary>Does GQA make decode faster, or only smaller?</summary>

Both, and for the same reason. The query heads are untouched, so the attention
FLOPs barely change — but decode is bandwidth-bound, and each step must read
every cached K and V for every sequence in the batch. Cutting `n_kv_heads` from
64 to 8 cuts those reads 8×, so at long context and high concurrency, where KV
traffic rivals or exceeds weight traffic, GQA is a real latency win on top of
the capacity win. At batch 1 with a short context, where weight reads dominate,
you will barely notice it.

</details>

<details>
<summary>If MLA caches less per token than GQA, why isn't everyone shipping it?</summary>

Because it is not a serving flag — it is a pretraining commitment. The
down-projection and up-projection matrices are trained weights, so you cannot
switch a finished GQA checkpoint to MLA the way you can turn on FP8 KV. It also
demands more of the engine: decoupled RoPE means two key paths to manage, and
matrix absorption means a decode kernel distinct from the prefill one. GQA needs
none of that — it is one integer in a config, supported everywhere — which is
why it is the default and MLA appears mainly in models built around it from day
one.

</details>

</div>

```quiz
[
  {
    "q": "In attention, how is a token's output vector produced?",
    "choices": [
      "By concatenating the Keys of all earlier tokens",
      "As a softmax-weighted average of earlier tokens' Value vectors, where each weight is the Query·Key match",
      "By multiplying the token's embedding by the full weight matrix once",
      "By taking the single earlier token with the highest Key norm"
    ],
    "answer": 1,
    "explain": "Each token makes a Query; it scores every earlier token's Key by dot product; softmax turns those scores into weights that sum to 1; the output is those weights times the earlier tokens' Values. Storing each past token's K and V so this can run every step is exactly what the KV cache holds."
  },
  {
    "q": "A 70B model has 64 query heads and 128-dim heads over 80 layers. Why does switching from MHA to GQA-8 cut the KV cache 8×?",
    "choices": [
      "GQA halves head_dim and halves the layer count",
      "GQA stops caching Values and keeps only Keys",
      "GQA stores 8 K/V heads instead of 64, and KV bytes scale with the number of K/V heads",
      "GQA compresses each head into a shared latent vector"
    ],
    "answer": 2,
    "explain": "KV bytes/token = 2 × layers × n_kv_heads × head_dim × bytes. Query heads stay at 64, but GQA-8 shares them across just 8 K/V heads, so n_kv_heads drops from 64 to 8 — an 8× cut (2.6 MB → 328 KB) at essentially MHA-level quality. Compressing into one latent is MLA, a different design."
  },
  {
    "q": "MLA's 'matrix absorption' lets decode attend directly on the compressed latent, doing more arithmetic per byte read. Why is that a good trade for decode specifically?",
    "choices": [
      "Decode is compute-bound, so cutting FLOPs is what matters",
      "It reduces the model's parameter count",
      "It lets decode skip the softmax entirely",
      "Decode is memory-bandwidth-bound and wastes most of the GPU's FLOPs, so trading spare compute for fewer bytes moved is a net win"
    ],
    "answer": 3,
    "explain": "Decode reads huge amounts of KV per token while leaving the GPU's arithmetic units almost idle (roofline: it's bandwidth-bound). Absorbing the up-projection so attention runs on the small latent moves fewer bytes at the cost of extra FLOPs the GPU had to spare — exactly the right direction when bandwidth is the bottleneck."
  },
  {
    "q": "Why must a sliding-window model keep the very first token in its cache even when the window has moved far past it?",
    "choices": [
      "The first token stores the model's positional zero-point",
      "It is the 'attention sink' — softmax dumps its leftover probability there, and evicting it collapses quality",
      "The first token holds the system prompt",
      "Kernels index the cache relative to token 0 and crash without it"
    ],
    "answer": 1,
    "explain": "Softmax weights must sum to 1, so when heads have nothing useful to attend to they park the excess mass on the first token. Evict that sink and a sliding-window model degrades sharply — which is why gpt-oss adds an explicit learnable per-head sink logit as a proper 'attend to nothing' slot."
  },
  {
    "q": "What makes DeepSeek's DSA (in V3.2) a genuine break from dense attention, unlike cited-but-rarely-deployed methods such as H2O or StreamingLLM?",
    "choices": [
      "It evicts unimportant KV entries at inference time after training",
      "It replaces attention with a fixed-size recurrent state",
      "It quantizes the KV cache to 4 bits",
      "It uses a trained-in lightning indexer + top-k selection so each query attends to ~k tokens (O(L·k)), and shipped in production with a >50% price cut"
    ],
    "answer": 3,
    "explain": "H2O and StreamingLLM are post-hoc eviction schemes bolted on at inference; production largely passed on them. DSA trains sparsity in — a cheap FP8 indexer scores every past token and top-k picks ~2048 for full MLA — turning O(L²) into O(L·k) and shipping day-0 in vLLM/SGLang with a >50% API price cut. Fixed recurrent state is SSM/Mamba; 4-bit KV is the next chapter."
  }
]
```
