# Anatomy of a Serving Engine

> **Goal of this chapter:** assemble the parts you already own —
> continuous batching, chunked prefill, paged KV, prefix caching — into a
> single running engine, and follow one HTTP request all the way through it
> and back out as a token stream. After this chapter, vLLM and SGLang stop
> being black boxes: you can name every stage a request passes, say which
> CPU and which GPU is busy at each moment, and explain why the whole thing
> is built as a loop that never stops.

You have been handed a pile of excellent parts. The
[continuous-batching](#/continuous-batching) chapter gave you a scheduler
that admits and evicts sequences every iteration; the
[paged-KV](#/paged-kv-cache) chapter gave you block tables, prefix reuse,
and chunked prefill. None of those is an engine. An engine is what happens
when you wire them together, put an HTTP server in front, and run the whole
thing in a tight loop under real traffic without ever letting the GPU go
idle. This chapter is that wiring diagram.

We will trace **one** request through **vLLM V1** — the ground-up core
rewrite that shipped in early 2025 and became the default OSS engine — then
show how **SGLang** solves the same problems with different reflexes, and
finally tour the sampler, structured output, and the mid-2026 landscape.

## Why the engine is two processes, not one

Start with the single most important architectural decision, because
everything else follows from it. A GPU forward pass is the expensive thing
you are renting. Everything around it — parsing HTTP, tokenizing the prompt
into integer IDs, detokenizing output IDs back into UTF-8, building the
grammar mask for JSON mode, formatting Server-Sent Events — is **CPU work**.
If that CPU work runs in the same thread as the GPU loop, it *steals time
from the GPU*: while the CPU is busy turning token 4012 into the bytes for
"apple", the GPU sits idle waiting for the next batch to be handed to it.
At 50 decode steps a second, a few milliseconds of CPU per step is a tax on
every step, forever.

So vLLM V1 splits the engine into two processes:

- The **API server process** does the CPU-side, per-request work: HTTP,
  tokenize, detokenize, SSE streaming, request validation.
- The **`EngineCore` process** does nothing but the GPU loop: scheduler +
  model executor, running as fast as it can.

They talk over a message queue. The point is **overlap**: while `EngineCore`
runs step N on the GPU, the API server is tokenizing a newcomer and
detokenizing the outputs of step N−1 on other CPU cores. The GPU never waits
for a keyboard. (This is vLLM's answer to a trick SGLang shipped first —
we'll get there.)

## One request, end to end

Here is the whole journey. Follow the arrows; the boxes on the left are the
API-server process, the boxes on the right are `EngineCore`.

```text
   API SERVER PROCESS                    ENGINECORE PROCESS (the GPU loop)
   ─────────────────────                 ─────────────────────────────────
   POST /v1/chat/completions
        │
        ▼
   tokenize prompt ──► [1051, 402, 88, ...]  (ints, not text)
        │
        │   add_request(req_id, tokens)
        └───────────────────────►  ┌────────────────────────────────┐
                                   │  every ~10–50 ms, forever:      │
                                   │                                 │
                                   │  1. SCHEDULE                    │
                                   │     spend a token budget across │
                                   │     waiting + running reqs:     │
                                   │     {A: 512 prefill-chunk,      │
                                   │      B: 1 decode,               │
                                   │      C: 4 spec-tokens}          │
                                   │     allocate KV blocks / reuse  │
                                   │     cached prefix blocks        │
                                   │                                 │
                                   │  2. MODEL RUNNER (GPU)          │
                                   │     one forward pass over the   │
                                   │     whole hybrid batch → logits │
                                   │                                 │
                                   │  3. SAMPLE (GPU→sync point)     │
                                   │     temp / top-p / greedy →     │
                                   │     one new token id per seq    │
                                   │                                 │
                                   │  4. update KV, evict finished,  │
                                   │     emit {req_id: new_token}    │
                                   └───────────────┬────────────────┘
        ┌──────────────────────────────────────────┘
        ▼   step outputs
   detokenize ──► "app" → "apple"
        │
        ▼
   SSE: data: {"delta": "apple"} ──►  user's terminal
        │
        └── loop until EOS / max_tokens, streaming each token as it lands
```

The thing to burn into memory is step 1's data structure. The scheduler does
**not** think in terms of "prefill requests" and "decode requests" as
separate phases. It thinks in one uniform currency: `{request_id:
num_tokens}`. Request A contributing a 512-token prefill chunk, request B
contributing its single next decode token, request C contributing 4
speculative candidate tokens — these are **the same abstraction**, three
entries in one dictionary, summed against one token budget for this step.
That uniformity is the whole design. Chunked prefill, prefix caching, and
speculative decoding are not special cases bolted on; they are just
different values of `num_tokens` in the same map. V0 had a tangle of
phase-specific code paths here; collapsing them into one budgeted map is
most of what made V1 up to 1.7× faster on text.

The loop runs every ~10–50 ms and **never terminates**. There is no "start
a request" and "finish a request" as distinct control flow — there is one
eternal `while True`, and requests drift in and out of each step's batch
like passengers boarding a moving walkway. Continuous batching, seen from
inside the engine, is simply: the batch is rebuilt from scratch every single
iteration.

## SGLang: the same problems, mirror-image reflexes

[SGLang](https://pytorch.org/blog/sglang-joins-pytorch/) (Berkeley/LMSYS,
now in the PyTorch ecosystem) attacks the identical problem set and arrives
at strikingly convergent answers — a good sign the field has found real
structure, not fashion. Two differences worth knowing:

**The overlap scheduler.** Rather than split into two processes, SGLang's
scheduler prepares the metadata for batch **N+1** on the CPU *while* batch N
is still running on the GPU, using negative-integer slot addresses as
placeholders for KV locations that don't exist yet. Same goal as vLLM's
separate `EngineCore` — never make the GPU wait on the CPU — reached by a
different route. Both are "zero-overhead scheduling"; the mechanism is real
even where the headline utilization numbers (SGLang claims 95–98% GPU util)
are vendor-favorable.

**RadixAttention.** SGLang's prefix cache is a radix tree (a compressed
trie) keyed on token sequences, versus vLLM's flat hash of 16-token blocks.
The payoff is automatic *prefix-of-a-prefix* sharing — branching
conversation trees and agent fan-outs reuse KV naturally. (Full treatment
lives in the [paged-KV](#/paged-kv-cache) chapter.)

**The DSL angle.** SGLang also ships a frontend language: `gen`, `select`,
`fork`/`join` let you write a multi-call LLM *program* whose branch
structure the runtime can see — and therefore whose shared prefixes it can
keep in cache across the forks. This matters most for the agentic workloads
of [chapter 15](#/agentic-serving).

> **State of play (mid-2026):** vLLM V1 and SGLang leapfrog each other every
> few releases. The honest consensus: they are close on general serving;
> SGLang tends to lead on prefix-heavy, structured, and agentic workloads;
> vLLM has broader hardware and model coverage. Almost every "X% faster"
> number online is a vendor blog with an opaque methodology — treat single
> benchmark deltas as noise, not law.

## Sampling is a system component, not a footnote

Step 3 turns the model's raw output — a vector of **logits**, one real
number per vocabulary token, ~128K numbers for a modern tokenizer — into one
chosen token id. Its knobs live here: **temperature** divides the logits
before the softmax (higher = flatter = more random); **top-p** (nucleus)
keeps only the smallest set of tokens whose probabilities sum past *p* and
renormalizes; **top-k** keeps the k highest. These run on the GPU right after
the forward pass.

Two systems facts fall out of this. First, the sampler is a **synchronization
point**. The forward pass can be all asynchronous kernel launches, but the
moment you need the *actual sampled token id* on the CPU to feed the next
step and to detokenize, you must wait for the GPU to finish — the loop's
heartbeat is defined by this sync. Second, **greedy is cheaper than
sampled**. Greedy decoding (temperature 0) is a single `argmax` over the
logits; nucleus sampling requires a sort or partial sort over the whole
vocabulary every step for every sequence in the batch. On a large batch that
sort is not free — it is one of the reasons a batched sampler is written as
careful fused GPU kernels rather than a Python loop.

## Structured output: how "always valid JSON" actually works

Ask an API for guaranteed-valid JSON and something quietly clever has to
happen on **every single decode step**. The model still produces logits over
the entire vocabulary — including thousands of tokens that would make the
output illegal (a letter where the grammar demands `}`, a second decimal
point in a number). The engine's job is to **mask** those logits to −∞
*before* sampling, so only grammar-legal tokens can be chosen. Do that every
step and the stream is valid JSON by construction, not by hope.

The naive version recomputes "which tokens are legal here" from scratch each
step, which is far too slow. The modern answer, and the default backend in
both vLLM and SGLang, is [**XGrammar**](https://arxiv.org/pdf/2411.15100):

- It compiles the grammar (a JSON schema, a regex, an EBNF) into a
  **pushdown automaton** — a finite state machine plus a stack, which is
  exactly the machinery needed to match nested, recursive structure like
  braces and brackets.
- It splits vocabulary tokens into **context-independent** ones (legal or
  not regardless of stack state — precomputable once) and
  **context-dependent** ones (the small set that needs a runtime check).
  The precomputed masks are cached, so per-step work shrinks to almost
  nothing.
- Crucially, it computes the *next* step's mask on the **CPU, overlapped
  with the GPU** forward pass — the same overlap principle as the whole
  engine, applied one level down. The mask is ready the instant the logits
  land.

Then the delightful part: **jump-forward decoding**. Sometimes the grammar
makes the next tokens *deterministic*. After the model commits to a field,
the schema forces the literal `"name":` — there is exactly one legal
continuation for several tokens. So the engine **skips the forward pass
entirely** and appends that fixed string directly, only calling the model
again when a real choice reappears. A deterministic stretch of output costs
zero GPU. The grammar isn't just constraining the model; it's *doing part of
the decoding for free*.

## Two more schedulers-eye views

**Speculative decoding**, from the scheduler's seat only: instead of one
decode token per sequence, a request contributes several candidate tokens
per step (from a small draft model or the model's own earlier layers), which
the big model then verifies in a single pass. For the scheduler this means
`num_tokens` per request becomes **variable and >1**, the attention masks
must handle **tree-shaped** candidate branches, not flat sequences, and the
KV of rejected candidates must be **rolled back** rather than committed.
Because it rides the same `{request_id: num_tokens}` budget, it slots into
the unified scheduler with no new phase. It helps at low batch sizes and can
*hurt* under high load, so mature engines gate it on utilization — the full
story is [chapter 9](#/speculative-decoding).

**Multi-LoRA serving**, in one breath: a LoRA adapter is a small set of
low-rank weight deltas that specializes a shared base model. Serving
thousands of them at once (Punica's SGMV kernel, S-LoRA's *unified paging*
that pages adapter weights in and out of GPU memory beside the KV cache, LRU
eviction) lets one GPU answer requests for many fine-tunes in a single
batch. The scheduler just tags each request with its adapter id; the batched
kernel applies the right delta per row. This is load-bearing for the
[agentic era](#/agentic-serving).

Finally, a forward pointer: the model runner in step 2 is usually replayed
as a **CUDA graph** — a pre-recorded, pre-baked sequence of GPU operations —
so the CPU doesn't pay per-kernel launch overhead (thousands of tiny
launches per forward pass) on every one of the loop's 20–100 iterations per
second. Why that matters and how it's built is
[kernels-and-compilation](#/kernels-and-compilation).

## The engine landscape

> **State of play (mid-2026):** the OSS field has consolidated hard around
> vLLM and SGLang; TGI, once a default, is gone.
>
> | Engine | Status | Niche in one line |
> |---|---|---|
> | **vLLM V1** | Default, dominant OSS engine | General high-throughput serving; the de-facto standard |
> | **SGLang** | Heavy production use, PyTorch ecosystem | Prefix-heavy, structured, agentic, RL rollouts |
> | **TensorRT-LLM** | Active; now a Dynamo backend | Maximum performance on NVIDIA silicon |
> | **NVIDIA Dynamo** | 1.0 shipped | Not an engine — a datacenter *orchestrator*: disaggregated prefill/decode, KV-aware routing |
> | **TGI (HuggingFace)** | **Archived read-only, Mar 2026** | End of life — migrate off |
> | **LMDeploy** | Active | TurboMind kernels; DeepSeek PD-disaggregation |
> | **llama.cpp / Ollama** | Thriving | Edge and local, GGUF quantization |
> | **MLC-LLM** | Active | TVM-compiled; widest device matrix |
>
> **Who runs what:** honesty demands restraint here. Only two production
> pairings are cleanly public: **xAI (Grok) uses SGLang**, and **Microsoft
> Azure serves DeepSeek R1 on AMD GPUs via SGLang**. DeepSeek runs its own
> open-sourced stack. The frontier labs — OpenAI, Anthropic, Google — serve
> on proprietary internal stacks; there is **no reliable public confirmation**
> of which OSS engine, if any, they use. Distrust any unsourced "Lab X runs
> vLLM" claim.

## What to remember

- An engine is a **two-part machine**: a CPU-side API/tokenizer process and
  a GPU-side `EngineCore` loop, deliberately separated so CPU work overlaps
  GPU work and the GPU never idles.
- The scheduler's currency is one uniform map, `{request_id: num_tokens}`,
  spent against a per-step token budget. Prefill chunks, decode tokens, and
  speculative candidates are the same abstraction — that uniformity *is* the
  V1 design.
- The loop runs every ~10–50 ms **forever**; the batch is rebuilt from
  scratch each iteration. That is continuous batching seen from the inside.
- The **sampler** is a GPU sync point and the loop's heartbeat; greedy is an
  `argmax`, nucleus sampling is a per-step sort.
- **Structured output** masks illegal logits every step via a compiled
  pushdown automaton with precomputed masks; **jump-forward decoding** skips
  the model outright on deterministic stretches.
- vLLM and SGLang are **convergent evolution** — separate process vs overlap
  scheduler, hash vs radix tree — close on general serving, SGLang ahead on
  structured/agentic. Cross-engine benchmark deltas are mostly vendor noise.

```quiz
[
  {
    "q": "Why does vLLM V1 run the API server and the EngineCore in separate processes?",
    "choices": [
      "To let two GPUs each run one process",
      "So CPU-heavy work — tokenize, detokenize, HTTP, grammar masks — overlaps GPU execution instead of stealing time from the GPU loop",
      "Because Python cannot run a model and a web server in one process",
      "To isolate crashes so a failed request cannot take down the GPU"
    ],
    "answer": 1,
    "explain": "The GPU is the expensive rented resource. If per-request CPU work shared the GPU loop's thread, the GPU would idle a few milliseconds every step waiting for it. Splitting the processes lets the CPU tokenize newcomers and detokenize old outputs on other cores while the GPU runs the next batch."
  },
  {
    "q": "In the V1 scheduler, how are a request's prefill chunk, another's decode token, and a third's speculative candidates represented?",
    "choices": [
      "As three separate queues processed in strict phase order",
      "As entries in one uniform {request_id: num_tokens} map, summed against a single per-step token budget",
      "Prefill on the GPU, decode and speculation on the CPU",
      "As three different batches run back to back within the step"
    ],
    "answer": 1,
    "explain": "The core V1 idea is that there are no prefill/decode phases — every contribution is just a number of tokens for a request id. Chunked prefill, decode, prefix caching, and spec decode become different values of num_tokens in one budgeted map, which is why they compose without special cases."
  },
  {
    "q": "Structured output must return valid JSON. What does the engine do on each decode step to guarantee it?",
    "choices": [
      "Generate freely, then reparse and retry if the JSON is invalid",
      "Mask the logits of grammar-illegal tokens to negative infinity before sampling, so only legal tokens can be chosen",
      "Switch to a special JSON-only model",
      "Lower the temperature to zero so the model becomes deterministic"
    ],
    "answer": 1,
    "explain": "Validity is enforced by construction: a compiled pushdown automaton knows which vocabulary tokens are legal in the current grammar state, and the engine sets every illegal token's logit to -inf before the sampler runs. XGrammar precomputes most of these masks and overlaps the rest with the GPU forward pass."
  },
  {
    "q": "What is jump-forward decoding?",
    "choices": [
      "Running the draft model several steps ahead of the target model",
      "Skipping the forward pass and appending a fixed string when the grammar makes the next tokens deterministic",
      "Sampling several tokens per step and picking the best",
      "Jumping ahead in the KV cache to reuse a shared prefix"
    ],
    "answer": 1,
    "explain": "When a grammar forces exactly one legal continuation for a stretch (like the literal \"name\": in a JSON schema), there is nothing for the model to decide, so the engine emits those tokens directly with zero GPU cost. The grammar effectively performs part of the decoding for free."
  },
  {
    "q": "Which production-stack claim is actually cleanly public as of mid-2026?",
    "choices": [
      "OpenAI serves production traffic on vLLM",
      "Anthropic runs SGLang internally",
      "xAI (Grok) uses SGLang, and Azure serves DeepSeek R1 on AMD GPUs via SGLang",
      "Google's frontier models run on TensorRT-LLM"
    ],
    "answer": 2,
    "explain": "Only the xAI-SGLang and Azure-DeepSeek-SGLang pairings are cleanly public. The frontier labs serve on proprietary internal stacks with no reliable public confirmation of which OSS engine, if any, they use — so any unsourced 'Lab X runs Y' claim should be distrusted."
  }
]
```
