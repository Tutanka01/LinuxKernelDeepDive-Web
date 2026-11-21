# PagedAttention & Prefix Caching

> **The question:** dozens of KV caches grow one token at a time toward
> lengths nobody knows in advance — how do you store them without wasting most
> of the GPU's memory, and how do you avoid computing the same prompt twice?
>
> **You'll be able to:** explain why contiguous KV allocation wastes memory and
> how a block table removes the waste; predict how much of a request will hit the
> prefix cache, and lay out a prompt so that it does; size a block pool from a
> launch line and reconcile it with the engine's startup log.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="kv"></div>

From [Inference Arithmetic](#/inference-arithmetic) you know that every token
leaves a key and a value per layer in the KV cache, and that every later token
reads all of them. From [Continuous Batching](#/continuous-batching) you know a
modern engine keeps dozens of sequences decoding at once, joining and leaving
every step. Put the two together and you get the defining memory problem of
serving: many caches, each growing by one token per step, toward a final length
that is unknown until the model stops.

Operating systems solved a version of that allocator problem decades ago. This
chapter is that solution, moved into a GPU.

## Contiguous allocation wastes most of the pool

The attention kernels of early engines needed each sequence's cache to be one
contiguous tensor. The simple way to guarantee that is to reserve, when a request
starts, a slab large enough for its maximum possible length: its prompt plus the
`max_tokens` it asked for. Different requests ask for different maxima, so the
slabs have different sizes.

```text
  Reserve prompt + max_tokens per sequence, contiguous in HBM:

  Seq A ┃██░░░░░░░░░░░░┃                         used   180 / 1,024
  Seq B ┃█████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┃   used   620 / 4,096
  free  ┊··········┊                              1,500 tokens free
  Seq C ┃█░░░░░░░░░░░░░░░░░░░░░┃                  used    40 / 2,048
         └used┘└── reserved, never written: internal fragmentation

  Next request wants 2,048 contiguous tokens: 1,500 + free space
  elsewhere would hold it, but no single hole does → external fragmentation
```

> [!predict] Before you read on
> If sequences reserve 2,048 tokens on average but end, on average, at 400,
> roughly what fraction of the reserved KV memory ever holds data?

About a fifth: 400 / 2,048 ≈ 20%. The rest is reserved for growth that never
happens (**internal fragmentation**), and on top of that, the holes left between
slabs of different sizes as sequences come and go are often too small for the
next slab (**external fragmentation**). The vLLM paper measured existing systems
wasting **60–80%** of their KV memory this way
([Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180)). You buy an 80 GB
GPU and get the cache capacity of a much smaller one.

If you took the Linux course, you have seen this failure under its old name:
segmentation. Variable-size contiguous regions, reserved for a worst case, leave
holes nothing can use. Operating systems abandoned it for paging, and so did
inference engines.

## Paging the KV cache

**PagedAttention**, the founding idea of vLLM, is demand paging applied to the KV
cache. Each sequence's cache is cut into fixed-size **blocks** of `block_size`
tokens. All blocks come from one shared pool. Each sequence has a **block table**
mapping its logical block numbers to physical blocks, and new physical blocks are
allocated only as the sequence's tokens need them. In vLLM v0.34 the default
block is **64 tokens**; it was 16 until that release, and ROCm's paged attention
still uses 16. Page, frame, page table, free list: the mapping to the Linux
course is one to one.

![Left, contiguous pre-allocation: KV slabs sized for each request's maximum, mostly reserved and never written, with a free gap between them too small to hold another slab. Right, PagedAttention: one pool of fixed-size blocks, coloured by owning sequence and scattered through the pool, addressed by per-sequence block tables.](assets/diagrams/paged-attention.svg)

A sequence's cache is now physically scattered and logically contiguous, exactly
as a process sees a flat address space over scattered frames. Fixed-size blocks
eliminate external fragmentation outright: any free block fits any need.
Internal fragmentation shrinks to at most one partly filled block per sequence —
under 64 tokens, a few percent at typical lengths.

Paging is not free. The attention kernel must look up every block in the block
table instead of striding through one tensor, and the block size trades kernel
efficiency (longer contiguous reads) against waste and sharing granularity —
the trade behind the move from 16 to 64. How kernels follow a block table is
[FlashAttention](#/flashattention)'s concern.

**How big is a block?** Per layer, a block holds K and V for `block_size` tokens:

```text
   bytes per block per layer  =  2 × block_size × n_kv_heads × head_dim × bytes

   Llama-3-8B, BF16:   2 × 64 × 8 × 128 × 2  =  256 KiB per layer
                       × 32 layers           =    8 MiB per block (64 tokens)
```

That is 128 KiB per token, the same figure Inference Arithmetic gives. An 80 GB
H100 serving the 8B model with `--gpu-memory-utilization 0.90` gets 72 GB; less
16 GB of weights and ~2 GB of activations and overhead, ~54 GB remain: about
**6,400 blocks** in its pool.

## Where the pool's size comes from

That 0.90 is easy to misread. In vLLM v0.34, `--gpu-memory-utilization f` is a
fraction of the GPU's **total** memory: the engine may use `total × f`, and the KV
pool is whatever is left of that after the weights, the activation peak it
measures with a dummy batch at startup, and the CUDA-graph memory. It is not a
fraction of what remains after the weights. Lowering it from 0.90 to 0.85 on an
80 GB GPU takes 4 GB, all of it from the KV pool.

The engine prints the result when it starts. These two lines are the ones to
find in the startup log:

```plaintext
(Worker_TP0 pid=3120) INFO 11-21 09:38:52 […] Available KV cache memory: 30.73 GiB
(EngineCore pid=3011) INFO 11-21 09:38:55 […] GPU KV cache size: 402,816 tokens, Maximum concurrency for 16,384 tokens per request: 24.59x
```

*Real format, illustrative values — message formats from vLLM v0.34.0
`vllm/v1/worker/gpu_worker.py` and `vllm/v1/core/kv_cache_utils.py`; numbers
computed from the running case's budget (below), not measured.*

You can reproduce both from Halden's launch line (four H100s, tensor parallelism
4, `--gpu-memory-utilization 0.90`, `--max-model-len 16384`). Each GPU holds a
quarter of the weights and two of the eight KV heads:

```text
   per GPU:  0.90 × 80 GB                                  =  72 GB
             − 35 GB weights − 3 GB overhead − 1 GB activations
                                                           =  33 GB  =  30.73 GiB
   KV per token per GPU     =  327,680 B ÷ 4               =  81,920 B
   one 64-token block       =  64 × 81,920 B               =  5,242,880 B (5 MiB)
   blocks                   =  33e9 ÷ 5,242,880            =  6,294
   tokens                   =  6,294 × 64                  =  402,816
   concurrency at 16,384    =  6,294 ÷ (16,384 ÷ 64)       =  24.59×
```

Three things to read off it. The log speaks GiB, the case GB: 33 GB is 30.73 GiB.
"Maximum concurrency" assumes every request runs to `--max-model-len`; Halden's
3,250-token requests fit `402,816 ÷ 3,250` ≈ 123 times — the case's figure. And
the 3 GB and 1 GB are planning guesses that the engine measures on the real node:
this line is where the estimate gets replaced.

### Virtual memory, for real this time

vLLM v0.34 changed how the pool is sized. With the new **extensible KV cache**,
on by default on CUDA and ROCm, the engine reserves the KV cache's *address range*
with the GPU driver's virtual-memory API and commits physical pages to it only
after warm-up and CUDA-graph capture, so the pool is sized from memory actually
free then, not from an estimate. Unset, the utilisation now defaults to 1.0
(0.92 without the extensible cache), and the release notes advise most users to
drop the flag.

If you know `mmap(MAP_NORESERVE)`, this is familiar: reserve address space
cheaply, back it later. It decides *how big* the pool is; it does not replace the
block table, and sequences still own scattered 64-token blocks inside the range.
vAttention ([Prabhu et al., ASPLOS 2025](https://arxiv.org/abs/2405.04437)) used
the same CUDA facility for a more radical end: each request's KV stays
*virtually contiguous*, backed page by page by the driver, so unmodified kernels
need no block table (its authors report up to 1.23× the throughput of paged
kernels). vLLM's extensible cache is not that design.

## Parallel sampling: fork() without the copy

**Parallel sampling** asks for several completions of one prompt — the API's `n`
parameter — and all of them begin with byte-identical prompt KV. The vLLM paper
handled it like `fork()`: every sample's block table points at the same physical
blocks with a reference count, and a sample about to write into a shared, partly
filled block copies it first — copy-on-write. vLLM v0.34 does it differently. The
API server splits an `n=4` request into four child requests (`0_<id>` …
`3_<id>`, `vllm/v1/engine/parallel_sampling.py`) that meet in the prefix cache of
the next section: full prompt blocks are shared by reference count, and each
child computes its own last, partial block. There is no copy-on-write path for an
ordinary attention model.

## Prefix caching: compute a prompt once

The larger prize is sharing *across* requests, and it rests on a property of
attention: it is **causal**. Token *i*'s key and value depend only on tokens 1 to
*i*. So if two requests begin with the same tokens, their KV for that span is
identical — deterministically, not approximately.

Real traffic is full of such spans: system prompts, tool definitions, popular
documents. **Prefix caching** keeps their KV and lets later requests skip that
prefill. vLLM uses a **content-addressed** map: when a block fills, the engine
hashes it together with its parent's hash:

```python
def hash_block_tokens(
    hash_function: Callable[[Any], bytes],
    parent_block_hash: BlockHash | None,
    curr_block_token_ids: Sequence[int],
    extra_keys: tuple[Any, ...] | None = None,
) -> BlockHash:
    …
    if not parent_block_hash:
        parent_block_hash = NONE_HASH

    curr_block_token_ids_tuple = tuple(curr_block_token_ids)
    return BlockHash(
        hash_function((parent_block_hash, curr_block_token_ids_tuple, extra_keys))
    )
```

*Verbatim — vLLM v0.34.0, `vllm/v1/core/kv_cache_utils.py` (docstring trimmed).*

Because each hash includes its parent's, a block's hash fingerprints the *entire*
token history up to and including that block — the structure of a Merkle chain.
The `hash_function` is SHA-256 by default (`--prefix-caching-hash-algo`).
`extra_keys` carries whatever besides the tokens determines the KV: the LoRA
adapter's name and path, hashes of images or audio in the prompt, prompt
embeddings, and, on the first block only, a per-request **`cache_salt`**. The
engine keeps a dictionary from hash to physical block; a new request hashes its
prompt blocks the same way, looks each one up, and on a hit points its block
table at the existing block.

The chaining is not decoration. Block 3's keys and values depend on blocks 0–2,
so two requests with identical tokens in block 3 but a different block 0 have
different KV there. Their chained hashes differ, so they correctly share nothing.

> [!predict] Before you read on
> Halden's system prompt is 800 tokens. Two requests carry it identically and
> differ from token 801 on. With vLLM v0.34's 64-token blocks, how many of the
> second request's tokens come from the cache: 800, 768 or 0?

768. The hasher stops at the last *full* block: tokens 769–800 share block 13
with the first 32 tokens of each request's own documents, so that block's hash
differs and the chain ends at block 12. A short program reproduces the scheme:

```python
import hashlib, pickle
BLOCK = 64                                  # vLLM v0.34 default block size

def block_hashes(tokens, salt=None):
    parent, out = b"none-hash", []          # stand-in for NONE_HASH
    for i in range(0, len(tokens) - BLOCK + 1, BLOCK):   # full blocks only
        extra = (("cache_salt", salt),) if (i == 0 and salt) else None
        key = (parent, tuple(tokens[i:i + BLOCK]), extra)
        parent = hashlib.sha256(pickle.dumps(key)).digest()
        out.append(parent)
    return out

def shared(a, b):
    return sum(x == y for x, y in zip(a, b))

system = list(range(1, 801))                # an 800-token system prompt
a = block_hashes(system + [5] * 2200)       # two requests, different documents
b = block_hashes(system + [6] * 2200)
print("full blocks:", len(a), "| shared:", shared(a, b), "=", 64 * shared(a, b), "tokens")
c = block_hashes([7] + system[1:] + [5] * 2200)
print("first token changed -> shared:", shared(a, c))
d = block_hashes(system + [5] * 2200, salt="tenant-b")
print("same tokens, other cache_salt -> shared:", shared(a, d))
```

*Runnable — Python 3 standard library only; output shown is from an actual run.
A sketch of vLLM's scheme, not its code.*

```plaintext
full blocks: 46 | shared: 12 = 768 tokens
first token changed -> shared: 0
same tokens, other cache_salt -> shared: 0
```

*Runnable — output of the program above, pasted from a real run with `python3`.*

The second line is the rule that shapes prompt templates: one varying token at
position zero invalidates the whole prefix, because every later hash chains from
it. Put stable content first and variable content (dates, user names, retrieved
documents) after it. Two smaller rules: a request whose whole prompt is cached
still recomputes its last token, because the engine needs that token's logits
(the lookup is capped at prompt length − 1); and when the pool needs room,
unreferenced cached blocks are evicted least-recently-released first, a request's
blocks freed tail-first so a chain loses its end before its root.

In vLLM's V1 engine prefix caching is on by default, and its cost at a 0% hit
rate is under 1% of throughput
([V1 announcement](https://vllm.ai/blog/2025-01-27-v1-alpha-release)). There is
no reason to run without it — with one caveat.

**A shared cache is a timing side channel.** A hit shortens TTFT measurably, so
a tenant can send a guessed prefix and learn whether another tenant sent it
recently. The third output line is the fix: give each tenant its own `cache_salt`
(a request field) and their hashes never meet. vLLM's docs flag the faster
`xxhash` options as a collision risk for multi-tenant use; keep SHA-256.

> [!bridge] From the Linux course
> A prefix cache is the page cache with a different key. The kernel caches file
> pages by `(inode, offset)` so a second read never reaches the disk; the engine
> caches KV blocks by chained content hash so a second request over the same
> prefix never reaches the GPU's compute units. Both are worth running even when
> they mostly miss. What differs: a file offset is stable, while a KV block's
> identity depends on every token before it; and vLLM's eviction is a single queue
> ordered by release, much simpler than the kernel's active/inactive lists or MGLRU.
> [→ Linux: Watch the Page Cache Work](../#/lab-page-cache)

### Measuring the hit rate

The stats log prints a hit rate over recent requests; for anything you graph,
use the two counters on `/metrics`. Both count **tokens**: queried prompt tokens
and the ones found in the cache. Take two scrapes and divide the differences:

```plaintext
# 10:00:00
vllm:prefix_cache_queries_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 4.821e+07
vllm:prefix_cache_hits_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 1.219e+07
# 10:05:00
vllm:prefix_cache_queries_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 4.956e+07
vllm:prefix_cache_hits_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 1.2561e+07
```

*Real format, illustrative values — counter names and labels from vLLM v0.34.0
`vllm/v1/metrics/loggers.py`; values constructed for Ask Halden at peak
(1.5 requests/s × 300 s × 3,000 tokens), not measured.*

`(12,561,000 − 12,190,000) ÷ (49,560,000 − 48,210,000)` = 371,000 ÷ 1,350,000 ≈
**27.5%** (in PromQL, `rate(…hits_total[5m]) / rate(…queries_total[5m])`). It is
token-weighted: the 768 system-prompt tokens give 25.6%, popular documents the
rest. [Lab: Batching and the Prefix Cache](#/lab-batching-and-cache) shows a hit
and a miss on your laptop.

### RadixAttention

SGLang keeps cached KV in a **radix tree** (a compressed trie) keyed on token
sequences: **RadixAttention**. Chained hashes already share every common
ancestor, so branching is not the difference. These are: SGLang matches at token
granularity (default page size one token in v0.5.23), so a prefix diverging
mid-block still shares everything before the divergence; eviction works from the
leaves; and the scheduler can order its queue by longest cached prefix
(`--schedule-policy lpm`). It matters most for agentic and multi-turn traffic.

> **State of play (November 2026):** vLLM v0.34.0 (16 November) made 64-token
> blocks and the extensible KV cache the defaults
> ([release notes](https://github.com/vllm-project/vllm/releases/tag/v0.34.0));
> v0.25.0 deleted the original PagedAttention kernel. Published hit rates and
> engine-versus-engine prefix-cache comparisons depend on the workload and flip
> between releases; measure your own with the two counters above.

The same mechanism is why "cached input" is a separate, discounted line on hosted
API price sheets: a hit skips prefill, though the provider still pays to keep the
KV resident. Discounts differ by provider and change often;
[The Agentic Era](#/agentic-serving) works out the economics.

## What paging did not solve

- **The pool is still one GPU's memory.** Paging packs the pool; it does not
  enlarge it.
- **Pressure still forces eviction.** When the pool is exhausted, the scheduler
  preempts a sequence — and recomputing it is cheap only for the part of its
  prompt still in the prefix cache.
- **A prefix cached on one replica is useless on another.** Block tables are
  local. Routing requests to where their prefix lives, and moving KV between
  machines, is the subject of [The KV Fabric](#/the-kv-fabric).

## Watch the pool

In the simulator, the bottom panel is the block pool: one cell per block,
coloured by owning sequence, green where shared. Load preset 3 ("Agent, no prefix
cache") and turn **prefix caching** on: shared green blocks appear and TTFT
drops. Then load preset 4, whose pool is too small for its load: the flashes are
sequences losing their blocks and restarting from their prompts — preemption by
recompute. Drag the **KV pool** slider right until they stop.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

> [!dashboard] The KV block pool
> **Utilisation:** `vllm:kv_cache_usage_perc` (0–1; cached blocks that no request
> references count as free). **Saturation:** `vllm:num_requests_waiting_by_reason{reason="capacity"}`
> while KV usage is high; `rate(vllm:num_preemptions_total)`. **Errors:** none as a
> metric — derive thrash from `vllm:request_num_preemptions` (requests preempted
> more than once), and cache effectiveness from
> `rate(vllm:prefix_cache_hits_total) / rate(vllm:prefix_cache_queries_total)`.

> [!case] The case: the shared system prompt
> Every Ask Halden request begins with the same 800-token system prompt.
>
> - **Granularity:** with 64-token blocks, 12 blocks — 768 tokens — are shared;
>   the last 32 are recomputed with each request's documents, ~3 ms. (With 16-token
>   blocks it was exactly 50.)
> - **Memory:** stored once, 768 × 328 KB ≈ **252 MB**, shared by every request in
>   flight. Without sharing, twenty concurrent requests would hold twenty copies,
>   5 GB.
> - **Compute:** each request skips 768 of its 3,000 prompt tokens, so TTFT's
>   prefill part drops from ~0.27 s to ~0.20 s. Expect a token-weighted hit rate
>   of at least **25.6%**; anything below it means the prefix is broken.
> - **Isolation:** one shared cache means any employee could, in principle, learn
>   from TTFT whether a colleague recently retrieved the same document. Halden is
>   one tenant with company-wide document access, so it runs without `cache_salt`.
>   That decision flips the day an HR or legal assistant with restricted documents
>   shares the node: it gets its own salt.
>
> **What this settles:** prefix caching stays on, and the prompt template gets one
> rule — nothing that varies per request or per day goes before the system prompt.
> The app team's plan to open the prompt with "Hello {first_name}, today is {date}"
> is rejected. In phase 2 the shared preamble grows to 3,000 tokens and the stakes
> grow with it.

## Exercises

<div class="exercise">

**Exercise 1.** The startup log above reports 6,294 blocks of 64 tokens on Halden's
node. How many blocks does one full phase-1 request (3,250 tokens) hold, how many
of them are the shared system prompt, and how many such requests fit with and
without sharing?

<details>
<summary>Reveal answer</summary>

`⌈3,250 / 64⌉` = **51 blocks**, the last one 50/64 full. The shared system prompt
is 12 of them (768 tokens). Without sharing: `6,294 ÷ 51` ≈ **123** requests,
the case's figure. With sharing, each request after the first costs 39 private
blocks: `(6,294 − 12) ÷ 39` ≈ **161**. A 30% gain from one prompt — and Little's
law said Halden needs ~20, so phase 1 never touches either number.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** Ask Halden's hit rate has been ~27% for weeks. After
Tuesday's app release, two scrapes five minutes apart read:

```plaintext
vllm:prefix_cache_queries_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 2.1013e+08
vllm:prefix_cache_hits_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 5.4870e+07
…
vllm:prefix_cache_queries_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 2.1148e+08
vllm:prefix_cache_hits_total{model_name="meta-llama/Llama-3.3-70B-Instruct",engine="0"} 5.4873e+07
```

*Real format, illustrative values — vLLM v0.34.0 counter names; values
constructed for this exercise, not measured.*

The release made two changes: retrieval now returns five chunks instead of
four, and so that the assistant knows the time, the app passes
`chat_template_kwargs={"date_string": "21 Nov 2026 14:03"}` with every request.
Llama-3.3's chat template, which vLLM applies to every chat request, contains:

```plaintext
{%- if not date_string is defined %}
    {%- set date_string = "26 Jul 2024" %}
{%- endif %}
…
{{- "<|start_header_id|>system<|end_header_id|>\n\n" }}
…
{{- "Cutting Knowledge Date: December 2023\n" }}
{{- "Today Date: " + date_string + "\n\n" }}
```

*Verbatim — the `chat_template` in Llama-3.3-70B-Instruct's
`tokenizer_config.json` (read from a public mirror of the checkpoint), trimmed.*

What is the new hit rate, which change caused it, and what do you do?

<details>
<summary>Reveal answer</summary>

`(54,873,000 − 54,870,000) ÷ (211,480,000 − 210,130,000)` = 3,000 ÷ 1,350,000 ≈
**0.2%**: the system prompt no longer hits at all.

The template writes `Today Date: …` into the system header *before* your system
prompt, inside block 0. With a time to the minute, block 0 changes every minute,
and every later hash chains from it; the few hits left are requests that arrived
in the same minute. The extra retrieved chunk only changes tokens after the system
prompt, so it cannot touch blocks 0–11.

Fix: pass the date without the time (one miss per day), or put the time in the
user message, after the stable prefix. The cost of leaving it is ~70 ms of prefill
per request (768 × 0.089 ms) and a quarter more prefill load on the node.
[When It Breaks](#/when-it-breaks) meets the same failure as an incident.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** A team proposes Mistral Medium 3.5 for Ask Halden on
the same node. Its `config.json`:

```json
{
  "dtype": "bfloat16",
  …
  "quantization_config": {
    …
    "quant_method": "fp8",
    …
  },
  "text_config": {
    "head_dim": 128,
    …
    "max_position_embeddings": 262144,
    …
    "num_attention_heads": 96,
    "num_hidden_layers": 88,
    "num_key_value_heads": 8,
    …
  },
  …
}
```

*Verbatim — `config.json` of `mistralai/Mistral-Medium-3.5-128B` on Hugging Face,
trimmed.*

The repository's weight index gives `"total_size": 133605834656` bytes. With
`--tensor-parallel-size 4 --gpu-memory-utilization 0.90 --max-model-len 32768`,
and the case's 3 GB + 1 GB of non-KV memory per GPU, predict the two startup log
lines. Does the bigger model hold fewer tokens than Llama-3.3-70B?

<details>
<summary>Reveal answer</summary>

Weights per GPU: 133.6 GB ÷ 4 = 33.4 GB (FP8 weights). KV pool per GPU:
72 − 33.4 − 4 = **34.6 GB = 32.22 GiB**. The KV cache stays BF16 (`dtype`
bfloat16, and `--kv-cache-dtype` defaults to the model's): 2 × 88 × 8 × 128 × 2
= 360,448 B per token, 90,112 B per GPU, 5,767,168 B per 64-token block. Blocks:
34.6e9 ÷ 5,767,168 ≈ 5,999 → **383,936 tokens**. A 32,768-token request needs
512 blocks: **11.72×**.

```plaintext
… Available KV cache memory: 32.22 GiB
… GPU KV cache size: 383,936 tokens, Maximum concurrency for 32,768 tokens per request: 11.72x
```

*Real format, illustrative values — computed above, not measured.*

A slightly *larger* pool than Llama's 33 GB (FP8 weights are smaller than 70B in
BF16), but ~5% fewer tokens: 88 layers make each token 10% heavier.

</details>

</div>

## Frequently asked

<div class="faq">

<details>
<summary>Can a cache hit change my output?</summary>

The cached KV is what the model would have computed for those tokens, so a hit is
reuse, not approximation. What can differ is floating-point reduction order: KV
computed in a different batch shape can differ in the last bits, and a near-tie in
sampling can land differently. If you need byte-reproducible output, you are
already fighting batch-shape effects; prefix caching does not add a new kind.

</details>

</div>

## What to remember

- Reserving a contiguous maximum-length slab per sequence wastes 60–80% of KV
  memory to internal and external fragmentation — segmentation's failure.
- PagedAttention is demand paging: fixed blocks (64 tokens by default in vLLM
  v0.34) from a shared pool, a block table per sequence, waste bounded by one
  partial block.
- `--gpu-memory-utilization` is a fraction of total memory; the pool is what is
  left after weights, activations and graphs, as the startup log prints. The
  extensible KV cache sizes it; the block table still pages it.
- Prefix caching chains block hashes, so only full blocks hit and one differing
  token invalidates its block and everything after it. Stable content goes first.
- A shared prefix cache leaks timing between tenants; `cache_salt` separates them.
- Hit rate is token-weighted: divide the deltas of `vllm:prefix_cache_hits_total`
  and `vllm:prefix_cache_queries_total`.

```quiz
[
  {
    "q": "A model needs 160 KB of KV per token on each GPU. The pool is 40 GB per GPU, blocks are 64 tokens, and --max-model-len is 32,768. What 'Maximum concurrency' does the startup log print?",
    "choices": [
      "About 244x: the pool holds 3,906 blocks, one block per request",
      "About 15.3x: 3,906 blocks over 256 blocks per request",
      "About 7.6x: 3,906 blocks over 512 blocks per request",
      "About 1.9x: the pool over a request's memory at full context, counted twice for K and V"
    ],
    "answer": 2,
    "explain": "A block is 64 × 160 KB = 10.24 MB, so 40 GB holds ~3,906 blocks. A request at the 32,768-token cap needs 32,768 ÷ 64 = 512 blocks: 3,906 ÷ 512 ≈ 7.6. Dividing by 256 assumes 16K tokens; the per-token figure already includes both K and V."
  },
  {
    "q": "An agent framework puts 2,000 tokens of tool definitions right after a fixed system prompt, but re-sorts the tools by most recent use on every call. What does the prefix cache do?",
    "choices": [
      "Hits through the system prompt and up to the first tool whose position changed; everything after misses",
      "Hits on every tool definition wherever it sits, since each tool's text is identical whatever its position",
      "Misses on everything, including the system prompt, because the request as a whole differs",
      "Hits on all of it, because vLLM normalises the order of tool definitions before hashing"
    ],
    "answer": 0,
    "explain": "Chained hashes match from position zero until the first full block whose content (or any ancestor) differs; after a reordering that is the block holding the first moved tool. Matching is by position, not by content anywhere in the prompt, and the system prompt's blocks before the change still hit. Fix: a stable tool order."
  },
  {
    "q": "Two business units share one vLLM v0.34 node. Unit B shows it can tell from TTFT whether unit A recently sent a given contract. What closes this without turning prefix caching off?",
    "choices": [
      "Switching the prefix-caching hash to SHA-256 so that block hashes cannot collide",
      "Lowering the block size to 16 so that fewer tokens are shared per hit",
      "Encrypting the KV blocks held in GPU memory so one unit cannot read the other's",
      "Giving each unit its own cache_salt, which enters the first block's hash"
    ],
    "answer": 3,
    "explain": "The leak is a cache hit itself: a shared prefix is served faster. With a per-unit cache_salt in the first block's extra keys, every chained hash differs between units, so A's blocks never satisfy B's lookups. SHA-256 is already the default and addresses collisions, not hits; smaller blocks still hit; nobody reads the blocks, they only time them."
  },
  {
    "q": "A client asks vLLM v0.34 for n=4 completions of a 1,610-token prompt (64-token blocks). What happens to the prompt's KV?",
    "choices": [
      "All four point at the same 26 blocks, and the partial last block is copied on write when a sample first appends a token",
      "Four child requests share the 25 full prompt blocks through the prefix cache; each computes its own last 10 tokens",
      "Each of the four samples computes and holds a private copy of all 26 blocks of the prompt",
      "One sample runs the prompt; the other three are drawn from its logits at every step"
    ],
    "answer": 1,
    "explain": "1,610 = 25 × 64 + 10. v0.34 splits n into child requests in the API server; they meet in the prefix cache, which only shares full blocks, and each computes its 10-token tail. Copy-on-write of the partial block is the original paper's design, not v0.34's for attention models. Samples generate independently, not from one sequence's logits."
  },
  {
    "q": "On an 80 GB GPU holding 50 GB of weights and 4 GB of other non-KV memory, an operator lowers --gpu-memory-utilization from 0.90 to 0.80 'to leave more room'. What happens to the KV pool?",
    "choices": [
      "It shrinks from 18 GB to 10 GB: the 8 GB comes entirely out of the pool",
      "It shrinks from 23.4 GB to 20.8 GB: the factor applies to what the weights leave",
      "It does not change, since the extensible KV cache ignores an explicit value",
      "It shrinks from 18 GB to 16 GB: the pool scales by 0.80 ÷ 0.90 of its size"
    ],
    "answer": 0,
    "explain": "The flag is a fraction of total memory: 0.90 × 80 = 72 GB, minus 54 GB non-KV, leaves 18 GB; 0.80 × 80 = 64 GB leaves 10 GB. A 44% smaller pool for a 10-point change. Applying the factor after the weights is the common misreading; an explicit value is honoured with the extensible cache too (it is how you opt out of its default of 1.0)."
  }
]
```
