# Anatomy of a Serving Engine

> **The question:** when you run `vllm serve`, what is actually running — which
> process does what, what happens to one request between HTTP and the token
> stream, and what does each launch flag spend?
>
> **You'll be able to:** trace a request through vLLM's processes and loop,
> naming which process holds what; read a launch line, justify each flag and spot
> the one that defeats its purpose; tell where a slow request's time went from the
> engine's latency histograms; say what the API layer — chat template, parsers,
> sampler, logprobs — does to every request.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="api,scheduler,batch,runner"></div>

You now own the parts: a scheduler that rebuilds the batch every step
([Continuous Batching](#/continuous-batching)), a paged block pool with prefix
reuse ([PagedAttention](#/paged-kv-cache)), chunked prefill. None of them is an
engine yet. An engine is those parts wired together behind an HTTP server and run
in a loop that never stops, under real traffic, without letting the GPU go idle.

This chapter follows one request through **vLLM** (v0.34, its "V1" engine; the
"Model Runner V2" of its release notes is the GPU-side half of the same engine),
then shows how **SGLang** solves the same problems, and ends with the launch
command for the running case.

## Processes, so the GPU never waits for the CPU

A GPU forward pass is the expensive thing you rent. Everything around it is CPU
work: parsing HTTP, rendering the chat template, tokenizing, turning output token
IDs back into text, building grammar masks for JSON mode, scheduling the next
step, framing the event stream.

> [!predict] Before you read on
> Suppose the CPU work around each step — detokenizing twenty sequences' new
> tokens, admitting a newcomer, formatting the stream — takes 2 ms, and a decode
> step on the GPU takes 16 ms. If both run in one thread, one after the other,
> what fraction of the GPU's time is lost?

About 11%: each cycle is 18 ms, of which the GPU is idle for 2. That loss applies
to every step, forever, and it grows with the batch, because CPU work scales with
the number of sequences. vLLM splits the work across processes. Here is what
`ps` shows on Halden's node:

```shell
$ ps -eo pid,ppid,args | grep -iE '[v]llm'
   2817    2790 /usr/bin/python3 /usr/local/bin/vllm serve meta-llama/Llama-3.3-70B-Instruct --tensor-parallel-size 4 …
   3011    2817 VLLM::EngineCore
   3120    3011 VLLM::Worker_TP0
   3121    3011 VLLM::Worker_TP1
   3122    3011 VLLM::Worker_TP2
   3123    3011 VLLM::Worker_TP3
```

*Real format, illustrative values — process titles as set in vLLM v0.34.0
(`vllm/v1/engine/core.py`, `vllm/v1/executor/multiproc_executor.py`, prefix
`VLLM_PROCESS_NAME_PREFIX`); PIDs invented, unrelated helper processes trimmed.*

- The **API server** (the original `vllm serve` process; its log lines say
  `(APIServer pid=…)`): HTTP, chat template, tokenization, detokenization,
  streaming, metrics. It holds each request's connection and its detokenizer state.
- **EngineCore**: the scheduler and the loop. It holds every request's state —
  its tokens, its block table, how far it has computed.
- One **worker per GPU** under tensor parallelism: each holds a quarter of the
  weights, its share of every KV block, and the persistent input batch, and runs
  the forward pass. The four meet in NCCL all-reduces inside every layer.

The API server talks to EngineCore over ZeroMQ sockets; EngineCore broadcasts each
step's `SchedulerOutput` to the workers through a shared-memory queue. While the
GPUs run step N, the API server detokenizes step N−1's tokens and tokenizes
newcomers on other cores. And since v0.34 enables **async scheduling** by default,
EngineCore itself schedules step N+1 while step N runs — the predict's "admitting a
newcomer" no longer alternates with the GPU either. The loop says so:

```python
    def step_with_batch_queue(
        self,
    ) -> tuple[dict[int, EngineCoreOutputs] | None, bool]:
        """Schedule and execute batches with the batch queue.
        Note that if nothing to output in this step, None is returned.

        The execution flow is as follows:
        1. Try to schedule a new batch if the batch queue is not full.
        If a new batch is scheduled, directly return an empty engine core
        output. In other words, fulfilling the batch queue has a higher priority
        than getting model outputs.
        2. If there is no new scheduled batch, meaning that the batch queue
        is full or no other requests can be scheduled, we block until the first
        batch in the job queue is finished.
        3. Update the scheduler from the output.
        """
```

*Verbatim — vLLM v0.34.0, `vllm/v1/engine/core.py`. With async scheduling the
batch queue holds two steps (`max_concurrent_batches` in `vllm/config/vllm.py`).*

The catch is the step whose inputs depend on the step before: step N+1 needs the
tokens step N samples. The scheduler books them as placeholders
(`num_output_placeholders`) and the GPU fills them in.

![An engine's request path: the client calls the API server, which tokenizes and hands the request over a message queue to the EngineCore process, where a four-stage cycle — schedule, model runner, sample, update — runs forever; the paged KV block pool hangs off the scheduler and the grammar backend off the sampler, and step outputs return to the API server to be detokenized and streamed.](assets/diagrams/engine-architecture.svg)

> [!bridge] From the Linux course
> An interrupt handler does the minimum in interrupt context and defers the rest
> to a softirq or workqueue, so the hard path is free for the next interrupt. This
> is the same split drawn around a different scarce resource: the GPU loop is the
> hard path, and tokenizing and stream framing are the bottom half. What differs
> is that the "bottom half" here runs in a separate process on separate cores,
> communicating by message, rather than later on the same CPU.
> [→ Linux: Interrupts, Exceptions & Softirqs](../#/interrupts)

## One request, end to end

```text
   API SERVER PROCESS                   ENGINECORE PROCESS (the loop)
   ──────────────────                   ─────────────────────────────
   POST /v1/chat/completions
     │ apply chat template, tokenize
     ▼
   [128000, 9906, 11, ...]   add_request(id, token_ids)
     └──────────────────────────────►  every step, forever:
                                        1. SCHEDULE   spend the token budget:
                                           {A: 512 prefill, B: 1, C: 1, …}
                                           allocate or reuse KV blocks
                                        2. RUN        workers: one forward pass
                                           over the whole hybrid batch → logits
                                        3. SAMPLE     one token id per sequence
                                        4. UPDATE     append to KV, free the
                                           finished, emit {id: new_token}
     ┌──────────────────────────────── step outputs
     ▼
   detokenize, stream "data: {…}" to the client, until end-of-sequence
```

Step 1's data structure is the design. The scheduler has no prefill mode and no
decode mode, only one currency, `{request_id: num_tokens}`, summed against one
per-step **token budget**. A 512-token prefill chunk, a next decode token and
four speculative tokens to verify are three entries in the same map.
[Continuous Batching](#/continuous-batching) showed how the budget is spent; here,
note what it buys the engine: one code path. The V1 announcement credited its
"up to 1.7×" over the older engine to cutting CPU overhead across the whole stack
([vLLM blog, January 2025](https://vllm.ai/blog/2025-01-27-v1-alpha-release)), of
which this simpler scheduler was one part.

![Two scheduler steps drawn to scale against an 8,192-token budget. In the first, 64 running sequences contribute one decode token each, leaving 8,128 tokens for the prefill chunk. In the second, 2,048 running sequences contribute 2,048 decode tokens, squeezing the prefill chunk down to 6,144.](assets/diagrams/token-budget.svg)

> [!predict] Before you read on
> The token budget is 2,048. Sixty-four sequences are decoding and one request is
> waiting with a 6,000-token prompt. How many of its tokens are prefilled this
> step, and how many steps until its first token?

Each decoding sequence takes one token of budget, leaving 2,048 − 64 = 1,984 for
the prefill: the prompt is chunked as 1,984 + 1,984 + 1,984 + 48, and the first
output token is sampled at the end of the **fourth** step. The decodes are never
starved; the long prompt takes several steps to start.

## SGLang: the same problems, different reflexes

[SGLang](https://pytorch.org/blog/sglang-joins-pytorch/) lands on convergent
answers — a sign the field has found real structure.

- **Overlap scheduling**, on by default (`--disable-overlap-schedule` turns it
  off): the CPU prepares step N+1 while step N runs on the GPU, with step N's
  not-yet-sampled tokens represented by placeholders that a GPU-side "future map"
  resolves. It is the same idea as vLLM's async scheduling.
- **RadixAttention**: a token-granular radix tree of cached prefixes instead of a
  hash map of blocks ([PagedAttention & Prefix Caching](#/paged-kv-cache)).
- **A frontend language**: `gen`, `select`, `fork`/`join` let you write a
  multi-call LLM program whose branches the runtime can see, and whose shared
  prefixes it can therefore keep cached.

## What the API layer does to every request

The OpenAI-compatible surface looks thin. In production it is where requests
break, because each field is turned into tokens or masks by a component you
configure.

- **The chat template.** Messages become tokens through the Jinja template in the
  model's `tokenizer_config.json`, unless `--chat-template` overrides it.
  Llama-3.3's writes a `Today Date:` line into the system header and decides where
  tool definitions go. Change the template and you change the prompt — and, as
  [the previous chapter](#/paged-kv-cache)'s Exercise 2 showed, the prefix cache.
- **Parsers.** The model emits tool calls and reasoning as plain text; a parser
  turns them into the API's structured fields. Tool calling needs
  `--enable-auto-tool-choice --tool-call-parser <name>` (`llama3_json` for
  Halden's model; its docs list parallel tool calls as unsupported for Llama 3).
  Reasoning models need `--reasoning-parser`, which moves the thinking into a
  `reasoning` field — renamed from `reasoning_content`, a change that silently
  breaks old clients. Since v0.32 a generic `hf` parser reads the
  `response_template` a checkpoint ships, if it ships one.
- **Structured output.** When the API must return valid JSON, the engine sets the
  logits of every token that would break the grammar to −∞ before sampling, so
  the output is valid by construction. vLLM's default `auto` backend uses
  [XGrammar](https://arxiv.org/abs/2411.15100) for most schemas: it compiles the
  grammar to a pushdown automaton, precomputes the tokens whose legality never
  depends on the stack, and builds each step's mask on the CPU while the GPU runs
  the forward pass. The first request with a new schema pays the compile.
- **Logprobs.** Up to 20 per token by default (`--max-logprobs`), and by default
  they are the *raw* model distribution (`--logprobs-mode raw_logprobs`), before
  temperature and top-p — not the distribution you sampled from.
- **Disconnects.** When a client closes the stream, the API server's generator is
  cancelled and it sends an abort; EngineCore frees the request's blocks at the
  end of the current step (full blocks stay in the prefix cache, evictable). A
  client that times out and retries a long request pays its prefill twice unless
  the prefix cache still holds it.

## The sampler is a synchronisation point

Step 3 turns the logits — one score per vocabulary entry, about 128,000 of them —
into one token ID per sequence, applying temperature, top-k and top-p as
[What Actually Happens When You Call an LLM](#/what-is-inference) defined them,
on the GPU — the model's `generation_config.json` defaults wherever a request
sets none ([Reading a Model Card](#/reading-a-model-card)).

Two system facts follow. First, the sampler is where the loop must
**synchronise** with the GPU: the forward pass is a stream of asynchronous kernel
launches, but nothing downstream can use a token until it exists. Async
scheduling hides this behind the next step; it does not remove it. Second,
**greedy is cheaper than sampled**: greedy is one `argmax` per sequence, while
top-p must find, for every sequence at every step, the most probable tokens
covering probability `p` out of ~128,000 — a sort, or a sorting-free kernel that
does the same job. At large batches that is real work, which is why samplers are
fused GPU kernels.

## Two more views from the scheduler's seat

**Speculative decoding** makes `num_tokens` per request variable and greater than
one: several candidate tokens are verified in one pass, and the KV of rejected
candidates is rolled back. It fits the same budget with no new phase
([Speculative Decoding](#/speculative-decoding)). **Multi-LoRA serving** tags each
request with a small adapter of low-rank weight deltas, and a batched kernel
applies the right delta per row, so one deployment serves many fine-tunes
([Beyond Chat](#/beyond-chat)).

Finally, the forward pass is usually replayed as a **CUDA graph**: a pre-recorded
sequence of GPU operations launched with one call, so the CPU does not pay launch
overhead for thousands of small kernels per step. vLLM v0.34's default mode is
`FULL_AND_PIECEWISE`: one full graph for decode-only batches, and piecewise
graphs — attention left outside — for prefill and mixed batches.
[Kernels, Graphs & Compilation](#/kernels-and-compilation) explains why.

## Where a request's time went

The engine timestamps each request as it moves through the loop, and exports the
intervals as Prometheus histograms. TTFT is measured from the moment the API
server received the request; the other four from EngineCore's own events:

```text
   event (process)                  interval that ends here
   ───────────────────────────────  ──────────────────────────────────────
   arrival      (API server)
     template, tokenize
   QUEUED       (EngineCore)
     waiting in the scheduler       request_queue_time    QUEUED → SCHEDULED
   SCHEDULED    (EngineCore)
     prefill, all chunks            request_prefill_time  SCHEDULED → first token
   first token                      time_to_first_token   arrival → first token
     decode                         request_decode_time   first → last token
   last token                       request_inference_time  SCHEDULED → last token
                                    e2e_request_latency   arrival → last token
```

All are `vllm:`-prefixed histograms with `_sum` and `_count`, so the mean of any
interval over a window is the increase of its `_sum` divided by the increase of
its `_count`. TTFT minus queue minus prefill is time spent before the engine saw
the request — template rendering and tokenization in the API server. A preemption
puts a request back in the queue, and its recompute lands in these intervals too.
Pair the histograms with the gauges: a long queue time with
`vllm:num_requests_running` pinned at a constant says a cap is binding; with KV
usage near 1, memory is.

> [!dashboard] The engine's CPU side
> **Utilisation:** `process_cpu_seconds_total` covers only the API server (and
> is absent with `--api-server-count` above 1); derive the rest from `top`/`pidstat` on the
> `VLLM::EngineCore` process (a process at 100% of one core is saturated,
> whatever the GPU shows). **Saturation:** TTFT minus queue minus
> prefill, from `vllm:time_to_first_token_seconds`,
> `vllm:request_queue_time_seconds` and `vllm:request_prefill_time_seconds`:
> growth means requests wait on the API server. **Errors:** HTTP 4xx/5xx from the
> API server's access log; `vllm:request_success_total` by `finished_reason`.

> **State of play (November 2026):** open-source serving has consolidated around
> vLLM and SGLang, with orchestration layers above them.
>
> | Project | Status | Role |
> |---|---|---|
> | vLLM | [v0.34.0](https://github.com/vllm-project/vllm/releases/tag/v0.34.0), 16 Nov 2026 | general high-throughput serving, broad model and hardware coverage |
> | SGLang | [v0.5.23](https://github.com/sgl-project/sglang/releases/tag/v0.5.23), 2 Nov 2026 | prefix-heavy, structured, agentic and RL-rollout serving |
> | TensorRT-LLM | [v1.3.0](https://github.com/NVIDIA/TensorRT-LLM/releases/tag/v1.3.0), 20 Nov 2026: the TensorRT backend is removed, PyTorch is the only backend | NVIDIA-first kernels; a Dynamo backend |
> | NVIDIA Dynamo | [v1.6.2](https://github.com/ai-dynamo/dynamo/releases/tag/v1.6.2), 5 Nov 2026 | an orchestrator, not an engine: KV-aware routing, disaggregation, flow control |
> | llm-d | [v1.0.0](https://github.com/llm-d/llm-d/releases/tag/v1.0.0), 20 Oct 2026 | Kubernetes-native routing, fairness and autoscaling over upstream engines |
> | TGI (Hugging Face) | [repository](https://github.com/huggingface/text-generation-inference) archived, last push March 2026 | migrate off |
> | llama.cpp | [v1.0.0](https://github.com/ggml-org/llama.cpp/releases/tag/v1.0.0), 13 Nov 2026 | local and edge, GGUF quantization |
>
> Engine-versus-engine benchmark deltas flip between releases; benchmark on your
> own traffic.

> [!case] The case: the launch line
> Ask Halden's first deployment, on the four-GPU node:
>
> ```bash
> vllm serve meta-llama/Llama-3.3-70B-Instruct \
>   --tensor-parallel-size 4 \
>   --max-model-len 16384 \
>   --gpu-memory-utilization 0.90 \
>   --max-num-seqs 64 \
>   --max-num-batched-tokens 512
> ```
>
> *Real format, illustrative values — flag names from vLLM v0.34.0
> `vllm/engine/arg_utils.py`; values are the case's decisions, not a tested
> configuration.*
>
> - `--tensor-parallel-size 4`: four workers, each with 35 GB of weights and two of
>   the eight KV heads.
> - `--max-model-len 16384` caps a request's context; it is an admission limit, not
>   a reservation. Phase 1 needs 3,250 tokens. **The stake:** phase 2's agent calls
>   reach 20,000 tokens and would be rejected; the flag must rise (and the startup
>   log's concurrency fall) the day phase 2 ships — to 24,576 in
>   [Sizing a Deployment](#/sizing-a-deployment).
> - `--gpu-memory-utilization 0.90`: 72 GB of each GPU's 80 for the engine; after
>   weights and measured overhead, ~33 GB per GPU of KV pool, 8 GB per GPU left for
>   what the engine does not measure. In v0.34 the flag is an opt-out: unset, the
>   extensible KV cache sizes the pool from memory free after warm-up, which would
>   give Halden a larger pool, at a TPOT cost the release notes put at 6–18% on some
>   models. Phase 1 needs ~20 requests in a pool that holds 123; Halden keeps 0.90
>   and the predictable step time.
> - `--max-num-seqs 64` caps the running batch at ~3× the planned 20. The v0.34
>   default on an H100 is 1,024; the cap also sizes per-request buffers and the
>   CUDA-graph batch sizes captured at startup, and 64 × 3,250 tokens fits the pool
>   twice over, so phase-1-shaped traffic can never be preempted.
> - `--max-num-batched-tokens 512` is the token budget chosen in
>   [Continuous Batching](#/continuous-batching): ~50 ms hybrid steps instead of
>   the default 8,192.
>
> Prefix caching, chunked prefill, async scheduling and CUDA graphs are on by
> default. **What this settles:** each flag spends something computed earlier, and
> one of them has an expiry date. Phase 2 will also need
> `--enable-auto-tool-choice --tool-call-parser llama3_json`.

## Exercises

<div class="exercise">

**Exercise 1 — diagnosis.** At 10:30 Ask Halden's TTFT alert fires. The node is
quiet on `nvidia-smi`. Over the last five minutes:

```plaintext
increase(vllm:time_to_first_token_seconds_sum[5m])       1512.0
increase(vllm:time_to_first_token_seconds_count[5m])      540.0
increase(vllm:request_queue_time_seconds_sum[5m])        1269.0
increase(vllm:request_prefill_time_seconds_sum[5m])       205.2
increase(vllm:request_decode_time_seconds_sum[5m])       2592.0
increase(vllm:request_decode_time_seconds_count[5m])      540.0
vllm:num_requests_running                                   8.0
vllm:kv_cache_usage_perc                                    0.07
```

*Real format, illustrative values — metric names from vLLM v0.34.0
`vllm/v1/metrics/loggers.py`; values constructed for this exercise, not
measured.*

Where did the time go, and what is the most likely cause?

<details>
<summary>Reveal answer</summary>

Means per request (540 requests, 1.8/s): TTFT 2.80 s = queue **2.35 s** +
prefill 0.38 s + 0.07 s before the engine. Decode 4.8 s for ~250 tokens is ~19 ms
per token: healthy. The time is in the queue.

Memory is not it (7% KV usage) and the GPUs are idle, yet only 8 requests run.
Little's law says the running set needs `1.8 × (0.38 + 4.8)` ≈ 9.3 on average:
more than 8, so a cap of 8 makes the queue grow until arrivals slow. Someone
launched with `--max-num-seqs 8` (check the launch line or
`vllm:num_requests_waiting_by_reason{reason="capacity"}`). Restore 64.

</details>

</div>

<div class="exercise">

**Exercise 2 — find the flaw.** A colleague's launch line for an internal policy
assistant on one 80 GB H100. Every request starts with the same 1,500-token
policy preamble; users stream answers of ~300 tokens.

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --max-model-len 32768 \
  --max-num-seqs 128 \
  --max-num-batched-tokens 2048 \
  --gpu-memory-utilization 0.90 \
  --no-enable-prefix-caching
```

*Real format, illustrative values — flag names from vLLM v0.34.0
`vllm/engine/arg_utils.py`; the configuration is an exercise, not a
recommendation.*

One flag defeats the purpose of this deployment. Which, and what does it cost?

<details>
<summary>Reveal answer</summary>

`--no-enable-prefix-caching`. The 1,500-token preamble is the deployment's one
shared prefix, and this flag makes every request prefill it again:
`2 × 8e9 × 1,500` = 2.4e13 FLOPs, ~60 ms of one H100 at 40% MFU, added to every
TTFT and to the GPU's prefill load. With caching, 1,472 tokens (23 blocks of 64)
would be reused, and its cost at a 0% hit rate is under 1%.

The rest is defensible: 72 GB less 16 GB of weights and ~2 GB leaves ~54 GB, ~412K
tokens at 128 KiB each, enough for 128 requests of ~2,000 tokens; 2,048 tokens per
step keep hybrid steps short for an 8B model; 32,768 is an admission cap, not a
reservation.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Halden later moves to FP8 weights and launches
`--data-parallel-size 2 --tensor-parallel-size 2` on the same four GPUs. List
the vLLM processes you expect. Which of them does one request touch, and where
does its KV live? How many copies of the weights and of the prefix cache are
there?

<details>
<summary>Reveal answer</summary>

Two engines, each with two workers: `VLLM::EngineCore_DP0` with `Worker_DP0_TP0`
and `Worker_DP0_TP1`, and `EngineCore_DP1` with its two. In this internal
load-balancing mode, v0.34 also defaults `--api-server-count` to the DP size, so
two API server processes (under a supervising parent).

A request is handled by one API server and routed to one engine; its KV lives
only in that engine's two workers, half the KV heads on each. There are two full
copies of the weights (each split across two GPUs) and two independent prefix
caches: the system prompt is cached twice, and a follow-up routed to the other
engine misses — the routing problem of [The KV Fabric](#/the-kv-fabric), inside
one box.

</details>

</div>

## What to remember

- `vllm serve` is an API server process, an EngineCore process and one worker per
  GPU; ZeroMQ between the first two, shared memory to the workers, NCCL among them.
- Async scheduling (on by default in v0.34) prepares step N+1 while step N runs;
  SGLang's overlap scheduler does the same.
- The scheduler's single currency is `{request_id: num_tokens}` against a per-step
  token budget.
- The API layer rewrites requests: templates make the prompt, parsers make tool
  calls and reasoning fields, logprobs are raw by default, disconnects abort.
- TTFT = API-server time + queue + prefill; the engine's histograms give each, and
  the gauges say which limit binds.
- Launch flags are decisions with stakes: Halden's `--max-model-len 16384` must
  change before phase 2.

```quiz
[
  {
    "q": "A user closes the browser tab 50 tokens into a 2,000-token streamed answer. What does vLLM v0.34 do with the request?",
    "choices": [
      "Generates the remaining 1,950 tokens, because EngineCore never sees the HTTP connection",
      "Parks the request with its KV intact for a few minutes in case the client reconnects",
      "Aborts it: the API server cancels and notifies EngineCore, which frees its blocks",
      "Finishes the current chunk, then stores the partial answer for an automatic retry"
    ],
    "answer": 2,
    "explain": "The disconnect cancels the API server's generator, which sends an abort; EngineCore finishes the request and frees its blocks, the full ones staying in the prefix cache as evictable. EngineCore does not see HTTP, but it does receive aborts, and there is no reconnect or retry state."
  },
  {
    "q": "Over an hour, a service's mean TTFT is 0.90 s, mean request_queue_time 0.05 s and mean request_prefill_time 0.12 s. Where is most of the TTFT spent?",
    "choices": [
      "Before the engine: rendering and tokenizing in the API server, which only TTFT counts",
      "In prefill: chunked prefill splits the work so the histogram counts only the first chunk",
      "In decode: the first token is sampled only after the first decode step has run",
      "In the scheduler's waiting queue, since queue time excludes requests that are deferred"
    ],
    "answer": 0,
    "explain": "TTFT runs from the API server's arrival time; queue and prefill are measured by EngineCore from QUEUED to the first token. 0.90 − 0.05 − 0.12 = 0.73 s happened before the engine saw the request: a CPU-starved API server, a huge template or tool list. The prefill interval spans all chunks, the first token comes from the prefill pass, and deferred requests are still in the queue interval."
  },
  {
    "q": "On a node whose KV pool holds ~130 requests of 3,000 tokens, a colleague raises --max-num-seqs from 64 to 2,048 'for throughput'. What do you expect under a burst?",
    "choices": [
      "Nothing changes, because admission already checks free blocks before running anything",
      "Prompts fill the pool on admission, and preemptions follow as their outputs grow",
      "The engine refuses to start, since 2,048 sequences cannot fit in the pool",
      "Throughput rises roughly in proportion, since decode is far below the knee"
    ],
    "answer": 1,
    "explain": "Admission checks that a prompt fits now and reserves nothing for its output, so with no lower cap the scheduler admits until prompts nearly fill the pool; as those requests decode they need new blocks and the latest admitted get preempted and recomputed. The cap was the only thing preventing over-admission. The engine starts fine, and memory, not the knee, is the limit here."
  },
  {
    "q": "An evaluation team reads logprobs from vLLM v0.34 to estimate how confident sampled answers are (temperature 0.7, top-p 0.9). What are they reading by default?",
    "choices": [
      "The distribution actually sampled from, after temperature and top-p",
      "The top 20 alternatives for every token, whether they asked for them or not",
      "The probability of the chosen token only, renormalised over the top-p set",
      "The raw model distribution, before temperature and top-p are applied"
    ],
    "answer": 3,
    "explain": "logprobs_mode defaults to raw_logprobs: values before any logits processing, including temperature and top-k/top-p. Use processed_logprobs to see the distribution you sampled from. 20 is the maximum a request may ask for (--max-logprobs), not something returned unasked."
  },
  {
    "q": "In vLLM v0.34's default CUDA-graph mode, FULL_AND_PIECEWISE, which steps replay one full graph?",
    "choices": [
      "Every step, since piecewise graphs are only used when torch.compile has been turned off by the user",
      "Prefill-only steps, where the batch shape is largest and launches cost the most",
      "Decode-only batches; prefill and mixed batches run piecewise graphs, attention outside",
      "None by default; full graphs are captured only when --enforce-eager is passed"
    ],
    "answer": 2,
    "explain": "Decode-only batches have a uniform shape that one full graph can capture, attention included. Prefill and mixed batches vary in shape, so attention runs eagerly between graphed pieces. --enforce-eager disables graphs altogether."
  }
]
```
