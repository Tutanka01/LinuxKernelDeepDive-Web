# The Frontier (late 2026)

> **The question:** of everything new in inference, what has actually shipped, what is
> still a claim, and how do you tell — fast — whether a new idea should change your own
> plans?
>
> **You'll be able to:** triage a new technique by the wall it moves, whether it
> composes with your stack, the measurement that would settle it and the number that
> would trigger adoption; compute what a new attention design does to KV per session
> and to a pool; find the flaw in a frontier claim applied to your deployment.

Every other chapter was written to age slowly: the roofline, the KV cache and batching
economics do not expire. This one carries a date, 21 November 2026. It is a photograph
of a moving thing — and a method for reading the next photograph yourself. The method
comes first, because the photograph will be wrong within a quarter.

## The method: four questions

A new technique reaches you as a release note, a paper or a vendor's slide. Ask four
questions of it, in order.

**Which wall does it move?** There are only five, and the course has built each one:

- *bytes read per token* — the weights and KV a decode step streams
  ([Inference Arithmetic](#/inference-arithmetic));
- *arithmetic per token* — the FLOPs prefill spends, 2 × active parameters each;
- *KV per token* — what a session holds while it lives or waits
  ([Attention Architectures for Serving](#/attention-for-serving));
- *tokens per answer* — how many decode steps the product needs
  ([The Agentic Era](#/agentic-serving));
- *overhead per step* — launches, synchronisation, CPU work between kernels
  ([Kernels, Graphs & Compilation](#/kernels-and-compilation)).

**Does it compose?** Does it keep a causal model, an exact KV cache in paged blocks,
continuous batching, prefix caching and your engine — or does it ask you to give one
up? Techniques that compose land in a release; techniques that invalidate the stack
must be much better to be worth the rewrite.

**What single measurement would settle it — at which batch and context?** A gain
measured at batch 1 on short prompts says nothing about batch 20 on 11K-token
contexts. Name the curve (TPOT against concurrency, goodput against rate, the
evaluation score) and the operating point.

**What number would trigger adoption here?** Not "it is better" but "when X crosses
Y on our dashboard, we re-plan". Without a trigger, a frontier item is reading, not
engineering.

## A worked example: diffusion LLMs

A **diffusion LLM** starts from a block of masked positions and refines all of them
over several passes, instead of committing one token at a time from left to right.
Its attention inside the block is bidirectional, so no position is final until the
block converges, and an exact KV cache — which works because a causal model's earlier
tokens never change ([PagedAttention](#/paged-kv-cache)) — cannot hold the block in
flight. Fast-dLLM ([arXiv 2505.22618](https://arxiv.org/abs/2505.22618)) answered with
a "block-wise approximate KV Cache" and confidence-aware parallel decoding, reporting
"up to 27.6× throughput improvement with minimal accuracy loss" on LLaDA and Dream.

By late 2026 this is no longer only research. Google released **DiffusionGemma** on 10
June 2026 ("Our newest open experimental model", Apache 2.0), which generates 256
tokens in parallel per forward pass; vLLM added it in v0.24.0 (29 June). Inception
sells **Mercury** models through an OpenAI-compatible commercial API, describing them
as "a new class of diffusion LLMs" (its models page, checked 21 November 2026). The
frontier labs' flagship chat models remain autoregressive.

> [!predict] Before you read on
> Google's own post on DiffusionGemma locates its advantage. Ask Halden's phase 2 runs
> about 40 open sessions on two replicas. Would you expect a diffusion model to beat
> autoregressive decoding plus speculation on cost per token there — yes or no?

No, and Google says why in its own words: "The throughput advantage is strongest at
low-to-medium batch sizes on a single accelerator", while in high-volume serving
"DiffusionGemma's parallel decoding offers diminishing returns and can result in
higher serving costs." That is the roofline in a vendor's voice. Generating 256
positions per pass buys more tokens per read of the weights — exactly what batching
already buys at concurrency, and what speculation buys at low batch. Run the four
questions: it moves *bytes read per token* (and *tokens per pass*); it does not compose
(approximate cache, a scheduler for requests that converge after different numbers of
passes); the settling measurement is cost per token at a fixed per-user speed against
AR plus speculation at your concurrency; and Halden's trigger is none — a single-user
or on-device product would be a different question.

The part that does compose has already shipped: a small block-diffusion model as the
*drafter* of speculative decoding, verified by an ordinary autoregressive target, so
the output distribution is the target's. DFlash ([arXiv
2602.06036](https://arxiv.org/abs/2602.06036)) conditions such a drafter "on context
features extracted from the target model" and its authors report "over 6x lossless
acceleration"; vLLM has carried DFlash and DSpark drafters since v0.25
([Speculative Decoding](#/speculative-decoding)).

## The snapshot, triaged

Each row is dated (2026), sourced and attributed to whoever makes the claim. Numbers
in quotes are the source's, measured on its hardware and model, not on yours.

| item (date, source) | wall it moves | composes? | settling measurement | trigger for Halden |
|---|---|---|---|---|
| Megakernels as opt-in plugins: "up to 44% faster single-user decode on GB300" for DeepSeek-V4.1-Flash (SGLang v0.5.23, 2 Nov) | overhead per step | yes, per model and per vendor plugin | TPOT against concurrency at your batch | none: other model, other GPU, batch ≫ 1 — see Exercise 3 |
| Diffusion LLMs served: DiffusionGemma (Google, 10 Jun; vLLM v0.24); Mercury API (Inception) | tokens per pass | no | cost per token at a fixed per-user speed | none at 40 concurrent sessions |
| Lossy verification: FLy, "1.04-1.31x decode throughput on MI355X and B300" (vLLM v0.33, 2 Nov; [arXiv 2511.22972](https://arxiv.org/abs/2511.22972)) | tokens accepted per target pass | mechanically yes; breaks "output unchanged" | your evaluation harness, not a speed test | only if decode binds, and only after the evaluation |
| Compressed sparse attention: DeepSeek V4, "Token-wise compression + DSA", "1M context is now the default" (DeepSeek, 24 Apr); Kimi-K3.1-Pro (llama.cpp v1.0.0) | KV per token, attention reads | yes, with a new cache layout | KV per token from `config.json`; evaluation | a model passing Halden's evaluation with KV per session small enough to restore failover — Exercise 2 |
| SSM/Mamba hybrids with prefix caching: on by default in vLLM v0.28 (26 Aug); "prefix caching for Mamba hybrid models, such as Qwen3.5" (TensorRT-LLM v1.3.0) | KV per token (fixed state) | yes, with state checkpoints at block boundaries | hit rate on your traffic; evaluation | same as the row above |
| Hybrid GPU + SRAM-silicon fleets: NVIDIA Groq 3 LPX "in full production" (NVIDIA, 24 Aug); Cerebras disaggregated inference "now in production" (Cerebras, 17 Nov) | bytes read per token, at decode | yes, through disaggregation | cost per token at your per-user speed | none: one rented node, and the data rule |
| Engine-managed memory and warm restarts: extensible KV cache on by default, checkpoint/restore (vLLM v0.34, 16 Nov) | overhead per restart | yes | the startup log | already adopted where it applies: [Operating It](#/operating-it) |

Two rows deserve their mechanism. The sparse-attention and SSM rows are worked in
[Attention Architectures for Serving](#/attention-for-serving): DeepSeek V4 stores one
compressed entry per 4 or 128 tokens per layer beside a 128-token window, and a Mamba
layer keeps a fixed-size state that prefix caching can reuse only where the engine
saved a copy. Composing is not free: SGLang v0.5.22's notes record: "Hybrid linear
models could resume from wrong mamba states when speculative decoding and structured
output were used together" — three features that each compose, failing together.

> [!trap] "Speculation never changes the output"
> It did not, until it became optional. vLLM's FLy documentation is explicit: "FLy is
> intentionally lossy. Unlike standard speculative decoding, it does not preserve the
> target distribution and may degrade model outputs." Its validation table reports a
> minimum accuracy retention of about 96% against the target alone. A lossy policy is
> a quantization-like decision and goes through the same gate: [Did Quantization Break
> Your Model?](#/did-quantization-break-your-model).

> [!predict] Before you read on
> NVIDIA and Cerebras both now split one request across two kinds of silicon: GPUs
> and SRAM-heavy chips. Which phase goes to the SRAM chips — prefill or decode?

Decode. The course's central fact predicts the split: prefill is
compute-bound, which is what GPUs sell; decode is bound by the bytes read per token,
and a chip whose working set lives in on-die SRAM reads them faster than any HBM.
NVIDIA's wording: "Rubin GPUs handle large-scale context processing while LPX
accelerates latency-sensitive decode workloads". Cerebras: AMD GPUs "process prompts,
and Cerebras CS-3 systems generate responses", with its KV Portal moving the cache
over RDMA. It is [disaggregation](#/disaggregation) across vendors, and it composes for
the same reason disaggregation does: KV is bytes. The same reasoning drives
Prefill-as-a-Service ([arXiv 2604.15039](https://arxiv.org/abs/2604.15039)), which
argues that "hybrid-attention architectures substantially reduce KVCache size,
making cross-cluster KVCache transport increasingly plausible" and ships long-context
prefill's cache "over commodity Ethernet" to decode clusters.

## Invariants and weather

**Durable — bet on these:**

- prefill is compute-bound, decode is memory-bound;
- decode is gated by bandwidth and capacity, prefill by arithmetic — Halden's
  uncached phase 2 is over capacity in FLOP/s, not in bytes;
- the KV cache is what grows, what runs out, and what is worth paging, quantizing,
  sharing and shipping — and new architectures compete on shrinking it;
- throughput and per-user latency trade along a curve; provision on goodput.

**Volatile — hold loosely:** engine defaults (vLLM's default block size was 16 until
v0.34 made it 64), number formats, chips and racks, and above all prices. Cached input
was ~10× cheaper than fresh in mid-2026; by November it is 10× at Google and 20× to
40× on Anthropic's and OpenAI's newest models. The direction is durable — a hit skips
prefill — and the ratio is a pricing decision.

**Reading the next photograph.** Read engine release notes for their "New defaults"
and "Breaking changes" sections; they are where a deployment silently changes. Read a
new model's `config.json` before its benchmark table: the attention fields give KV per
token, the parameter counts give bytes and FLOPs per token. Read papers' hardware and
model sections before their abstracts. And keep two harnesses ready — the evaluation
and the load test — because every row above ends in one of them.

> [!case] The case: which of these would change Halden's plan?
> Most of the table is "none", and saying so with the number is the point.
>
> - **A reasoning model for the agent** — the item most likely to reach Halden.
>   Thinking tokens lengthen each agent call: running calls at the peak are ≈ 2 calls/s
>   × (today's ~5.8 s per call + R × 25 ms) for R thinking tokens per call, each holding ~1.8 GB of live
>   FP8 KV that cannot be parked in host memory. The node's pools hold ~70 such calls
>   (R ≈ 1,200); one replica, the failover case, holds ~34 (R ≈ 460). **Trigger:** a
>   candidate whose median thinking per agent call on Halden's traces exceeds ~450
>   tokens cannot be adopted without a `thinking_token_budget` or more hardware — and
>   the TPOT margin goes even earlier ([The Agentic Era](#/agentic-serving)).
> - **A newer open-weights model** — the stake [Reading a Model Card](#/reading-a-model-card)
>   raised. Qwen3.8-27B fits one GPU per replica in BF16; a DeepSeek-V4-class design
>   stores tens of times less KV per token. **Trigger:** all three pieces of evidence
>   listed there — the 1,500-question evaluation (thinking off and on), the
>   `config.json` arithmetic showing the survivor's phase-2 KV under its pool with
>   margin (today ~61 of 66 GB), and a passing load test. A newer date is not evidence.
> - **Better speculation** (DFlash-class drafters): Halden already trials EAGLE-3
>   ([Speculative Decoding](#/speculative-decoding)), so this is a swap, and it matters
>   most if a reasoning model makes TPOT bind. Trigger: a drafter whose measured
>   acceptance on Halden's traces beats the EAGLE-3 head's at ~20 concurrent sequences.
> - **Megakernels, diffusion LLMs, lossy verification, SRAM fleets:** no trigger short
>   of a different deployment.
>
> **What this settles:** the frontier enters Halden's plan through two gates already
> built — the evaluation harness and the load test — plus one dashboard number per
> item. Nothing is adopted because it is new.

## Exercises

<div class="exercise">

**Exercise 1 — triage a paper (transfer).** Nebula ([arXiv
2611.09474](https://arxiv.org/abs/2611.09474), 2026-11) combines *position-independent
caching* (PIC: reusing a cached segment, such as a retrieved document, even when it
appears after a different prefix) with a cluster-wide cache. Its abstract ends:
"Across four models and four real-world RAG and agentic workloads, Nebula reduces
median TTFT by an average of 61.4% compared with the strongest existing baseline and
recovers an average of 76.1% of the tokens missed by prefix caching." Its results are
plotted; its one table is the motivating analysis:

```plaintext
Category  Workload               PC%     PIC%    NPHR%   PMRR%
RAG       ChatRAG-doc2dial        2.63   99.68   97.06   99.7
RAG       ChatRAG-QuAC            3.15   87.50   84.36   87.1
RAG       RAGPulse               31.53   72.01   40.48   59.1
Agent     nebius-SWE-agent       95.26   97.49    2.23   47.0
Agent     τ-bench-Retail         92.62   96.69    4.07   55.1
Agent     ChatDev                77.59   96.57   18.98   84.7
Table 1: Theoretical cache hit analysis of PC and PIC on RAG and agent workloads.
```

*Verbatim — Table 1 of arXiv 2611.09474v1 (HTML version, checked 2026-11-21); citation markers removed. PC = prefix-cache hit rate, NPHR = hits PIC adds, PMRR = share of prefix-missed tokens PIC recovers.*

The paper's setup: two servers of four H20-3e GPUs, seven prefill workers and one
decode worker, models from Mistral-7B to Qwen3.5-35B-A3B; on reuse quality it says
"Nebula leaves KV reuse and recomputation policies, including their accuracy
tradeoffs, to the PIC backend." Run the four questions for Ask Halden.

<details>
<summary>Reveal answer</summary>

**Wall:** arithmetic per token — fewer prompt tokens computed. **Composes?** Only
partly: PIC reuses a segment's KV under a different prefix, which is not what a causal
model would have computed, so backends recompute some tokens and accept an accuracy
trade-off the paper delegates; it also needs a cluster-wide directory Halden's single
node does not have. **Measurement:** none needs the system — log a hash of every
retrieved chunk and tool output, and compute Halden's own PMRR offline. **Trigger:**
phase 1 has no prefill problem (~15% load). In phase 2 the Q&A misses are the 2,000
retrieved tokens per question (≤ 2.2K tokens/s even if all recurred, a tenth of the
node), and the agent misses are tool outputs — the kind τ-bench-Retail shows recurring
(PMRR 55%). It matters only when prefill binds: the failover case (~19.7K tokens/s
against 11.3K). So: measure PMRR now; if it is high on tool outputs, PIC becomes a
candidate for degraded mode, gated by the evaluation. The 61.4% TTFT figure, on 8 GPUs
of small MoE models, transfers to nothing until then.

</details>

</div>

<div class="exercise">

**Exercise 2 — quantitative.** DeepSeek made 1M tokens the default context of its
services. Here is how V4-Flash stores its cache:

```json
{
  "head_dim": 512,
  "index_head_dim": 128,
  "num_hidden_layers": 43,
  "num_key_value_heads": 1,
  "sliding_window": 128,
  "compress_ratios": [0, 0, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 128, 4, 0]
}
```

*Verbatim — trimmed, list reflowed onto one line; `config.json` of deepseek-ai/DeepSeek-V4-Flash on Hugging Face, checked 2026-11-21.*

```python
# DeepseekV4: 448B NoPE + 128B RoPE + 8B fp8 scale = 584B per token;
…
if self.compress_ratio == 4:
    # Only C4A uses sparse attention and hence has indexer.
…
# NOTE(yifan): FP8 indexer cache uses the same layout as V3.2:
# head_dim bytes = 128 fp8 + 4 fp32 scale = 132.
```

*Verbatim — trimmed and dedented; lines from vLLM v0.34.0 `vllm/models/deepseek_v4/attention.py`. Each layer with ratio r > 1 stores one 584-byte entry per r tokens (`tokens_per_state=self.compress_ratio`); every layer also keeps a 128-token sliding window; the 44th ratio belongs to the MTP layer, not counted.*

(a) KV bytes per token at long context, and the fixed cost per sequence. (b) One
1M-token session, against Llama-3.3-70B in FP8 at 164 KB per token. (c) How many
1M-token sessions would a 66 GB pool hold, and how many of Halden's 20K-token agent
calls? (d) Does "1M is the default" change the KV of a request whose prompt is 20K
tokens? (e) Which wall does this *not* move?

<details>
<summary>Reveal answer</summary>

```python
# KV bytes per token for DeepSeek-V4-Flash, from its config.json and the
# per-entry sizes in vLLM v0.34.0 (FP8 layout)
ratios = [0, 0] + [4, 128] * 20 + [4]     # compress_ratios, first 43 entries
assert len(ratios) == 43                  # num_hidden_layers
MAIN, INDEX = 584, 132                    # bytes per stored entry (main KV, indexer K)
window = 128 * 43 * MAIN                  # sliding window: fixed per sequence
per_token = 0.0
for r in ratios:
    if r > 1:                             # one entry per r tokens
        per_token += MAIN / r + (INDEX / r if r == 4 else 0)
print(f"per token: {per_token:,.0f} B   window: {window / 1e6:.1f} MB per sequence")
llama = 2 * 80 * 8 * 128 * 1              # Llama-3.3-70B, FP8 KV
print(f"Llama-3.3-70B FP8: {llama:,} B per token ({llama / per_token:.0f}x more)")
for n in (20_000, 128_000, 1_000_000):
    print(f"{n:>9,} tokens: V4-Flash {(n * per_token + window) / 1e9:6.2f} GB"
          f"   Llama {n * llama / 1e9:6.1f} GB")
# per token: 3,850 B   window: 3.2 MB per sequence
# Llama-3.3-70B FP8: 163,840 B per token (43x more)
#    20,000 tokens: V4-Flash   0.08 GB   Llama    3.3 GB
#   128,000 tokens: V4-Flash   0.50 GB   Llama   21.0 GB
# 1,000,000 tokens: V4-Flash   3.85 GB   Llama  163.8 GB
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

(a) ~3.9 KB per token, the indexer's keys included (21 layers at 584/4 + 132/4, 20
at 584/128), plus 3.2 MB of window. Without the indexer it is ~3.2 KB, the basis on
which [Attention Architectures for Serving](#/attention-for-serving) gives ~4.5 KB
for V4-Pro (~5.5 KB with it). Both are computed from the config and vLLM's code, not
published by DeepSeek. (b) 3.85 GB against 164 GB — 43× less; Llama could not hold one such session
on the whole node, and its context stops at 128K anyway. (c) ~17 one-million-token
sessions, or ~800 20K-token calls, in 66 GB. (d) No: KV follows the tokens actually in
context; the default is a ceiling. (e) Arithmetic per token: a 1M-token prefill at 13B
active parameters is still 2 × 13e9 × 1e6 = 2.6e16 FLOPs plus attention — ~16 s of a
replica at Halden's 1.58e15 FLOP/s. And it does not fit Halden: even at 4 bits, 284B
parameters are ~142 GB, a whole TP=2 replica's budget.

</details>

</div>

<div class="exercise">

**Exercise 3 — find the flaw.** A colleague circulates this memo:

> *"SGLang v0.5.23 ships megakernels: up to 44% faster decode. Megakernels were
> research-only a year ago; now they are production. Switching Ask Halden from vLLM to
> SGLang's low-latency mode cuts our TPOT by 44%, which lets the node serve 44% more
> users before we buy GPUs. Recommend we switch this quarter."*

Find at least four errors.

<details>
<summary>Reveal answer</summary>

(1) The release note says "single-user decode": batch 1. Halden runs ~6–30 sequences
per replica, where the weight read is already shared and per-step overhead is a
smaller share of a step. (2) The model and hardware: DeepSeek-V4.1-Flash on GB300 (and
MI350X for the AMD plugin) — an MoE on Blackwell, not dense Llama-3.3-70B on H100; the
plugins are per model, so support for Halden's model is the first thing to check. (3)
"Up to" is a maximum, not a median. (4) Faster decode does not mean more users:
Halden's binding resources in phase 2 are prefill and KV, and TPOT sits at ~25 ms
against a 60 ms promise — the speedup buys nothing a user feels. (5) Switching engines
is a rollout of everything: the evaluation, the template and parser behaviour, the
metrics and alerts of [Operating It](#/operating-it). The settling measurement would
be TPOT against concurrency for Halden's model on H100 — and it only matters once TPOT
binds.

</details>

</div>

<div class="exercise">

**Exercise 4 — diagnosis.** Halden canaries a reasoning variant of its model on
replica B for the agent traffic, thinking budget unset. Two dashboard readings at the
peak, A unchanged:

```plaintext
                                                          A (old)   B (reasoning)
sum(rate(vllm:request_generation_tokens_sum[30m]))
  / sum(rate(vllm:request_generation_tokens_count[30m]))     212       1,450
avg_over_time(vllm:kv_cache_usage_perc[30m])                 0.14      0.97
rate(vllm:num_preemptions_total[30m])                        0         0.4
cached / total prompt tokens (30m)                           0.60      0.38
TTFT bad ratio (le="1.5")                                    0.01      0.22
TPOT bad ratio (le="0.06")                                   0.005     0.09
```

*Real format, illustrative values — metric names from vLLM v0.34.0 `loggers.py`, PromQL from this course's rules; values computed from the case for an assumed ~1,250 thinking tokens per agent call, not measured.*

What is binding, by what chain, and what is the first lever?

<details>
<summary>Reveal answer</summary>

Output per call rose ~7×, so each call runs ~7× longer, and by Little's law ~7× as
many calls are live at once: their KV fills the pool (0.97) and preemptions start.
Parked sessions are evicted to make room, so the hit rate falls (0.60 → 0.38), which
adds prefill, which lengthens TTFT; more live sequences and more hybrid steps push
TPOT past the promise for 9% of requests. Binding: the KV pool, by session duration.
First lever: a thinking budget (`thinking_token_budget`, [The Agentic
Era](#/agentic-serving)) near the ~450 tokens per call the case box allows — then
re-run the evaluation, because a budget changes answers.

</details>

</div>

## What to remember

- Triage anything new with four questions: which wall it moves, whether it composes,
  which measurement settles it at your operating point, and what number triggers it.
- Diffusion LLMs now ship (DiffusionGemma, Mercury), with their makers saying the gain
  fades at high concurrency; block-diffusion drafters compose and shipped first.
- Lossy verification breaks speculation's guarantee; it goes through the evaluation
  gate like quantization.
- New attention designs compete on KV per token; read it from `config.json`, and
  remember that a context default is a ceiling, not a cost.
- For Halden, the item with a trigger is a reasoning model: past ~450 thinking tokens
  per agent call, failover is lost.

This was the last chapter of prose. [Mixed Problems](#/mixed-problems) mixes every
part of the course into one unlabelled problem set, and the [review deck](#/review)
brings back what you are about to forget.

```quiz
[
  {
    "q": "A hybrid model stores 20 KB of KV per token in its few attention layers plus a fixed 60 MB of recurrent state per sequence. How many 10,000-token sessions fit in a 30 GB pool?",
    "choices": [
      "About 150, since only the 20 KB per token grows with the session context",
      "About 500, since the recurrent state is shared between all sessions",
      "About 115, since each session holds 0.2 GB of KV plus its 60 MB state",
      "About 3,000, since the fixed-size state replaces the per-token KV cache"
    ],
    "answer": 2,
    "explain": "Per session: 10,000 × 20 KB = 0.2 GB, plus 0.06 GB of state = 0.26 GB; 30 ÷ 0.26 ≈ 115. Ignoring the state (150) is the tempting error — at short contexts the fixed state is a large share. The state is per sequence, not shared, and the attention layers still grow."
  },
  {
    "q": "An API provider announces that a 1M-token context is now the default for its model. Your application's prompts are 6,000 tokens. What happens to the KV each of your requests occupies on the provider's servers?",
    "choices": [
      "It grows to the 1M-token size reserved for the default context",
      "Nothing changes; KV follows the tokens actually in the context",
      "It shrinks, because long-context models compress every token",
      "It doubles, because the long-context rotary scaling adds keys"
    ],
    "answer": 1,
    "explain": "A context default is a ceiling. Engines allocate KV blocks for the tokens a request actually holds, so a 6,000-token prompt costs the same whatever the maximum is. Compression is a property of the architecture, not of the default."
  },
  {
    "q": "A team proposes enabling vLLM's FLy verification on its 70B service after a load test shows 1.2× decode throughput. What must happen before it ships?",
    "choices": [
      "A second load test at higher concurrency, because the gain may fade",
      "Nothing more: speculation leaves the target's distribution unchanged",
      "A check that the drafter shares the target's tokenizer and vocabulary",
      "The quality evaluation, because FLy may change what the model outputs"
    ],
    "answer": 3,
    "explain": "FLy is intentionally lossy: it defers some rejections, so outputs can differ from the target's. That makes it a quality decision like quantization, gated by the evaluation harness. Standard speculation is lossless, which is the misconception the second choice repeats."
  },
  {
    "q": "Google says DiffusionGemma's throughput advantage is strongest at low-to-medium batch sizes. Which deployment is the best fit for it?",
    "choices": [
      "A single-user assistant running on one workstation GPU",
      "A shared cloud endpoint serving hundreds of concurrent users",
      "A batch job that summarises a million documents overnight",
      "An agent fleet whose sessions keep long prefixes cached"
    ],
    "answer": 0,
    "explain": "Generating many positions per pass buys more tokens per read of the weights — valuable when nothing else shares that read. At high concurrency, batching already shares it, so the parallel decoding adds little and can cost more. Agent fleets also depend on exact prefix caching, which diffusion's in-flight blocks do not support."
  },
  {
    "q": "A vendor pairs GPUs with SRAM-heavy accelerators in one rack and splits each request between them. Reasoning from the roofline, which split makes sense?",
    "choices": [
      "SRAM chips prefill, GPUs decode, because the prompts are the larger input",
      "GPUs prefill, SRAM chips decode, because decode is bound by bytes read",
      "SRAM chips hold the KV cache, GPUs run every layer of both phases",
      "GPUs run attention, SRAM chips run the MLP, for prefill and decode"
    ],
    "answer": 1,
    "explain": "Prefill is compute-bound, which is what GPUs sell; decode streams the weights and KV for every token, and on-die SRAM reads them far faster than HBM. NVIDIA's LPX and Cerebras's disaggregated product both use exactly this split, moving the KV cache between the two."
  }
]
```
