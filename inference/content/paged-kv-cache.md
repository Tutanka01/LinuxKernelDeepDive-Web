# PagedAttention & Prefix Caching

> **Goal of this chapter:** understand why pre-2023 engines wasted most of
> their KV-cache memory, how PagedAttention fixed it by lifting the OS's
> virtual-memory playbook wholesale into a GPU process, and how the same
> block machinery gives you copy-on-write sharing and prefix caching almost
> for free. After this chapter, the phrase "cached input tokens, 10× cheaper"
> stops being a pricing gimmick and becomes a data structure you can draw.

You already know the KV cache from [Inference Arithmetic](#/inference-arithmetic):
every token a model has seen leaves behind a key and a value vector per layer,
and every future token reads all of them. You know from
[Continuous Batching](#/continuous-batching) that a modern engine keeps dozens
of sequences decoding at once. Put those together and you get the defining
resource problem of LLM serving: **a pile of KV cache, one per sequence, each
growing one token at a time toward a length nobody knows in advance.**

This is a memory-allocator problem. And it turns out the operating system
solved it in the 1960s. This chapter is that solution, rediscovered inside a
GPU.

## The KV cache has a shape problem

Here is the naive thing every early engine did. A request can generate up to,
say, 2048 tokens. The KV cache must be a contiguous tensor so the attention
kernel can stride through it. So: reserve a contiguous 2048-token slab per
sequence, up front, and let it fill in.

Watch what that costs. The KV cache lives in **HBM** — the GPU's on-package
high-bandwidth memory, the scarce resource that caps how many sequences you can
serve at once. And most of every slab sits empty:

```text
Reserve max_len (2048 tokens) per sequence, contiguous in HBM:

Seq A ┃████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┃  used  180 / 2048
Seq B ┃██████████░░░░░░░░░░░░░░░░░░░░░░░░┃  used  620 / 2048
Seq C ┃█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┃  used   40 / 2048
       └used┘└────── reserved, never written ──────┘
                    INTERNAL fragmentation

Between and after the slabs: gaps too small to hold another
2048-slab, so unusable → EXTERNAL fragmentation.
```

If you did the Linux course, you have seen this exact failure before: it is
**segmentation**. Variable-size contiguous allocations that must reserve for a
worst case, leaving holes you can't reuse. vLLM's measurements put the damage at
**60–80% of KV memory wasted** ([PagedAttention, SOSP 2023](https://en.wikipedia.org/wiki/PagedAttention)) —
reservation for growth that never happens (internal), plus unusable gaps
between slabs (external). You bought an 80 GB GPU and got the KV capacity of a
16 GB one.

The kernel abandoned segmentation for the same reason. The fix has a name.

## Paging, rediscovered

**PagedAttention** (Kwon et al., SOSP 2023) is the founding idea of vLLM, and
it is — almost literally — demand-paged virtual memory for the KV cache. Chop
each sequence's cache into fixed-size **blocks** of `block_size` tokens (vLLM's
default is **16**). Keep one shared pool of physical blocks. Give each sequence
a **block table** mapping its logical block numbers to physical blocks. Allocate
a new physical block only when the sequence's current block fills up.

The correspondence is one-to-one, and it is worth drawing in full — this is the
whole chapter in one table:

| Operating system                     | PagedAttention                          |
|--------------------------------------|-----------------------------------------|
| Virtual page (fixed size)            | KV block (16 tokens, fixed)             |
| Physical page frame                  | Physical block in the pool              |
| Per-process page table (virt→phys)   | Per-sequence block table (logical→phys) |
| Demand paging (map frame on touch)   | Allocate a block when the 17th token arrives |
| Free-frame list                      | `free_block_queue` (often 100k+ blocks) |
| `fork()` + copy-on-write             | Block sharing + copy-on-write (next section) |

A sequence's KV is now **physically scattered** across the pool and **logically
contiguous** through its block table — precisely how a process sees a flat
address space over scattered page frames. The attention kernel walks the block
table instead of a raw stride. (How that kernel actually gathers scattered
blocks efficiently is [FlashAttention](#/flashattention)'s job, not ours.)

Fixed-size blocks kill external fragmentation outright — any free block fits any
need, because all blocks are the same size. Internal fragmentation shrinks to
**at most one partly-filled block per sequence** (under 16 tokens, so well below
4%). That is exactly the guarantee paging gives the kernel: waste bounded by the
last partial page, nothing more.

**Block size, in bytes.** One block stores K and V for `block_size` tokens, per
layer. Per layer:

```text
bytes/block/layer = 2 (K and V) × block_size × num_kv_heads
                    × head_size × dtype_bytes
```

Work it for Llama-3-8B in fp16: `num_kv_heads = 8` (it uses grouped-query
attention — several query heads share one KV head; see
[Attention Architectures](#/attention-for-serving)), `head_size = 128`,
`block_size = 16`, `dtype_bytes = 2`:

```text
2 × 16 × 8 × 128 × 2 = 65,536 bytes = 64 KiB per layer
× 32 layers          = 2 MiB per block, whole model
```

So one block holds 16 tokens across the whole model in 2 MiB — i.e. 128 KiB of
KV per token, which matches the per-token figure you'd get straight from
[Inference Arithmetic](#/inference-arithmetic). An 80 GB GPU, after weights,
leaves room for on the order of tens of thousands of such blocks in the pool —
the `free_block_queue` the scheduler hands out from.

## fork() for a prompt: copy-on-write

Once KV lives in shared physical blocks addressed through per-sequence tables,
one trick comes for free — and it is the one you already know cold.

Consider **parallel sampling**: one prompt, `n = 4` independent completions (an
API's `n` parameter, or beam search's beams). All four share the *identical*
prompt. Recomputing or copying the prompt's KV four times is pure waste — its
keys and values are byte-for-byte the same.

So don't. Point all four block tables at the *same* physical blocks for the
prompt, and bump a reference count. The four sequences diverge only when they
start generating different tokens — and generation only ever appends, into the
last, partly-filled block. When a sequence needs to write into a block that is
still shared (refcount > 1), **copy it first, then write** to the private copy.

That is `fork()` and copy-on-write, verbatim. A forked process shares its
parent's pages read-only and pays for a copy only on the first write to each
page; here, `n` samples share the prompt's blocks and pay for a copy only on the
boundary block each one writes into. Every full prompt block — the overwhelming
majority — stays shared for the whole request, because completed KV blocks are
never rewritten. The KV cache is, if anything, a *friendlier* case for COW than
the kernel's: it is append-only.

## Computing a prefix once: prefix caching

COW shares blocks *within* one request. The bigger prize is sharing *across*
requests — and it rests on one fact about attention.

Attention is **causal**: token *i*'s key and value depend only on token *i* and
everything before it, never on anything after. So if two different requests
begin with the same tokens, the KV for that shared span is *identical* — not
approximately, deterministically, bit for bit. And real traffic is drowning in
shared spans: the same 800-token system prompt on every chat turn, the same
few-shot examples on every classification call, the same retrieved documents
across a RAG batch, the same tool-definition preamble on every agent step.

**Prefix caching** computes that shared KV once and reuses the physical blocks.
The prefill work — the expensive, compute-bound pass over the prompt — is simply
skipped for any prefix already in the cache, collapsing time-to-first-token.

vLLM's scheme is **content-addressed**, and if you've seen a Merkle chain you've
seen it. When a 16-token block fills, hash it:

```text
block_hash = hash(parent_block_hash, tokens_in_this_block, metadata)
```

The `parent_block_hash` chains each block's identity to its *entire* prefix, so
a block's hash is a fingerprint of the whole token history that produced it.
Store `block_hash → physical block` in a dictionary
(`cached_block_hash_to_block`). A new request hashes its prompt blocks the same
way, looks them up, and on a hit points its block table straight at the cached
physical blocks — zero recompute. When the pool fills, evict by **LRU**.

Why chain the hash instead of just hashing the 16 tokens? Because block 3's KV
depends on blocks 0–2 (causality again). Two requests with the same tokens in
block 3 but a different block 0 have *different* KV there — and the chained hash
differs, so they correctly share nothing. Content-addressing enforces the exact
sharing rule the math demands.

> **Common trap:** "same text ⇒ cache hit." It's same *tokens from position
> zero*, not same text. A prefix that diverges by a single token — one extra
> space, a different date in line one — produces a different hash for that block
> and every block after it, and shares nothing downstream. Sharing is a prefix
> property, all-or-nothing at each block boundary. Put your stable content
> (system prompt, few-shot examples) *first* and your variable content last, or
> you throw the cache away.

The beautiful part: in vLLM V1 this is **on by default and essentially free
even at a 0% hit rate** — the only cost is a hash per completed block and a dict
insert, well under 1% throughput ([V1 alpha](https://vllm.ai/blog/2025-01-27-v1-alpha-release)).
There is no reason not to run it, so everyone does.

## RadixAttention: the trie variant

SGLang attacks the same problem with a different data structure. **RadixAttention**
stores the KV cache in a **radix tree** (a compressed trie) keyed on token
sequences. Shared prefixes become shared paths from the root automatically; a
conversation that branches — an agent that forks into three tool calls, a chat
that regenerates from turn five — becomes three child branches off a shared
trunk, sharing every ancestor block with no special handling.

The trie buys **prefix-of-a-prefix** sharing as a structural property: partial
overlaps and nested prefixes fall out of tree traversal, where the flat hash map
matches only at whole-block boundaries you thought to insert. SGLang pairs it
with cache-aware routing — send a request to the worker whose tree already holds
its prefix — and LRU eviction over tree leaves.

Trie versus hash, honestly: the hash map is dead simple and O(1) per block; the
trie is more machinery but expresses branching and hierarchical reuse natively.
The difference earns its keep most on **branching, agentic, tree-structured**
workloads and matters little for a stream of unrelated prompts.

> **State of play (mid-2026):** vendor blogs quote radix cache-hit rates of
> 85–95% on shared few-shot and multi-turn chat, and up to several-× TTFT wins
> on prefix-heavy RAG. Treat the exact figures as marketing — they are not
> peer-reviewed and swing per workload. The *established* claim is narrower and
> solid: both schemes deliver large TTFT reductions once the shared prefix
> exceeds roughly half the prompt, and the trie's edge concentrates on branching
> and agent trees. Engine-vs-engine deltas flip release to release; don't
> memorize a number.

## The bill: why cached input is cheaper

This machinery is why "cached input tokens" is a line item on every provider's
price sheet, typically around **10× cheaper** than fresh input tokens. A cache
hit means the provider skips the prefill compute for that span entirely — you're
paying for a dictionary lookup and some already-resident HBM, not GPU FLOPs. The
whole economics of agents and long system prompts — where the same preamble is
re-sent thousands of times a day — rests on it. We'll cash that out fully in
[The Agentic Era](#/agentic-serving); for now, know that the cheaper tier is
this data structure, exposed as a price.

## What paging did not solve

PagedAttention virtualized memory *within one GPU*. Three problems it leaves
standing, each a later chapter:

- **The cache still lives in one GPU's HBM.** Paging scatters blocks across a
  pool; it doesn't grow the pool. When you're out of HBM, you're out.
- **Memory pressure still forces eviction.** When the pool empties and a running
  sequence needs a block, something must give — the engine **preempts**, either
  recomputing dropped KV later or swapping it to host RAM. That policy belongs to
  the scheduler ([Anatomy of a Serving Engine](#/anatomy-of-an-engine)), and it
  pairs naturally with prefix caching: recompute is cheap when the prefix is
  cached.
- **A prefix cached on GPU A is useless to a request that lands on GPU B.**
  Block tables are local; there is no shared address space across machines. Making
  KV a first-class, movable, cluster-wide resource is the subject of
  [Disaggregated Serving & the KV Fabric](#/disaggregation).

The through-line: the KV cache started as a naive contiguous buffer, became
paged memory, and — you can already see where this goes — is on its way to
becoming a distributed, tiered storage system. The kernel's whole memory
hierarchy, replayed one layer at a time inside the serving stack.

## What to remember

- **The problem is fragmentation.** Contiguous max-length KV reservation is
  segmentation: 60–80% of KV HBM lost to internal (reserved-but-unwritten) and
  external (unusable-gap) waste.
- **PagedAttention is demand paging for KV.** Fixed 16-token blocks, a shared
  physical pool, a per-sequence block table (logical→physical). External
  fragmentation gone; internal bounded to one partial block per sequence (<4%).
- **Block bytes** `= 2 × block_size × num_kv_heads × head_size × dtype_bytes`
  per layer — 64 KiB/layer, 2 MiB/block for Llama-3-8B in fp16.
- **Copy-on-write** lets `n`-way sampling and beam search share the prompt's
  blocks and copy only on write — `fork()`, and easier, because KV is
  append-only.
- **Prefix caching** exploits causal attention: identical prefix ⇒ identical KV.
  vLLM chains block hashes (`hash(parent, tokens)`) into a content-addressed
  map, LRU eviction, ~free even at 0% hit rate. SGLang's **RadixAttention** uses
  a trie for automatic prefix-of-prefix and branch sharing.
- **Cached-input pricing (~10×)** is this data structure sold by the token. What
  paging did *not* fix — single-GPU HBM limits, eviction, cross-machine sharing —
  points straight at disaggregation.

```quiz
[
  {
    "q": "Why did pre-PagedAttention engines waste 60–80% of their KV-cache memory?",
    "choices": [
      "The attention kernel could only read half of each cache line",
      "They reserved a contiguous max-length slab per sequence, so most of every slab sat reserved-but-unwritten, plus unusable gaps formed between slabs",
      "KV vectors were stored in fp32 when fp16 would do",
      "The GPU reserved 70% of HBM for model weights regardless of model size"
    ],
    "answer": 1,
    "explain": "It's a segmentation problem. A contiguous worst-case reservation per sequence leaves the unused tail reserved (internal fragmentation) and leaves gaps between slabs too small to reuse (external fragmentation) — exactly why operating systems moved from segmentation to paging."
  },
  {
    "q": "In the OS-to-PagedAttention analogy, what plays the role of a per-process page table?",
    "choices": [
      "The free_block_queue",
      "The per-sequence block table mapping logical block numbers to physical blocks",
      "The attention kernel's stride computation",
      "The dtype of the KV vectors"
    ],
    "answer": 1,
    "explain": "Each sequence sees a logically contiguous cache over physically scattered blocks, resolved through its block table — precisely a page table mapping a process's virtual pages to scattered physical frames."
  },
  {
    "q": "For n-way parallel sampling from one prompt, why is copy-on-write on the prompt's KV blocks especially cheap here compared to a general fork()?",
    "choices": [
      "GPUs have hardware COW that CPUs lack",
      "The prompt blocks are compressed, so copies are tiny",
      "KV is append-only: completed prompt blocks are never rewritten, so nearly all shared blocks stay shared for the whole request and only the one boundary block each sample appends to ever needs copying",
      "Parallel samples never diverge, so no copy is ever needed"
    ],
    "answer": 2,
    "explain": "Generation only appends into the current partial block; full prompt blocks are immutable. So the copy-on-write cost is limited to the single boundary block per sample, and the bulk of the prompt's KV is shared for free — a friendlier case than general memory COW."
  },
  {
    "q": "vLLM hashes each KV block as hash(parent_block_hash, tokens, metadata) rather than just hashing the 16 tokens. Why chain in the parent hash?",
    "choices": [
      "To make the hash cryptographically secure against tampering",
      "To save memory by storing shorter hashes",
      "Because a block's KV depends on all preceding tokens (causal attention), so identical tokens under a different prefix must produce a different hash and correctly share nothing",
      "Because 16 tokens don't provide enough entropy for a good hash"
    ],
    "answer": 2,
    "explain": "Causality means block N's keys/values depend on blocks 0..N-1. Chaining the parent hash makes each block's identity a fingerprint of its entire prefix, so two requests share a cached block only if their whole history up to it matches — the exact sharing rule the attention math requires."
  },
  {
    "q": "Which limitation does PagedAttention NOT address?",
    "choices": [
      "Internal fragmentation from partly-filled allocations",
      "External fragmentation from variable-size reservations",
      "Sharing a cached prefix across different GPUs or machines",
      "Reusing the prompt's KV across n parallel samples"
    ],
    "answer": 2,
    "explain": "Paging virtualizes memory within a single GPU's HBM: it fixes both fragmentation types and enables intra-GPU sharing (COW, prefix caching). It does nothing for cross-GPU/cross-machine KV sharing, which requires a distributed KV fabric — the disaggregation chapter's subject."
  }
]
```
