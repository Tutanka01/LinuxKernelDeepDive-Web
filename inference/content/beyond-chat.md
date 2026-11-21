# Beyond Chat

> **The question:** the course has modelled every request as a prompt that is
> prefilled once and an answer decoded token by token — what changes in the
> engine, and in the arithmetic, when the workload does not have that shape?
>
> **You'll be able to:** price a workload nobody taught you — embeddings, images,
> adapters, bulk jobs — by changing one term of the course's cost model; predict
> which resource binds and which metric replaces TTFT and TPOT; diagnose a cache
> that cannot hit because its key changed.

Every Ask Halden prompt so far contained ~2,000 tokens of retrieved documents
that appeared from nowhere. They did not. Before the LLM sees a question, an
**embedding model** turns it into a vector, a search returns the ~50 nearest
document chunks, and a **reranker** reads each (question, chunk) pair and keeps
the best four. With 500-token chunks, a 200-token question and the reranker's
instruction template, that is 50 pairs of ~750 tokens: **37,500 tokens per
question**, twelve times the LLM's prompt. The course has never priced them.

None of the workloads in this chapter needs a new theory. The cost model of
[Inference Arithmetic](#/inference-arithmetic) — `step ≈ max(t_w, t_c) + t_kv`,
2 FLOPs per parameter per token, KV bytes held for a request's lifetime —
covers them all; each changes one term.

## Embeddings and rerankers: a prefill that never decodes

An embedding model reads a text and returns one vector (1,024 numbers below),
placed so that texts with similar meaning land close together. A reranker, or
**cross-encoder**, reads a query and a document together and returns one
relevance score. Neither generates anything: a request is one forward pass, with
no decode loop and no TTFT or TPOT.

vLLM v0.34 serves both as **pooling models** on `/v1/embeddings`, `/v1/score`
and a Cohere-style `/v1/rerank` — "primarily for convenience", its documentation
warns, with no guaranteed speed-up over Sentence Transformers. TensorRT-LLM
v1.3.0 added `/v1/embeddings`; Dynamo v1.6.0, `/v1/rerank` for SGLang
cross-encoders. Here is a current open embedding model; look at the
architecture and the vocabulary.

```json
{
  "architectures": ["Qwen3ForCausalLM"],
  …
  "hidden_size": 1024,
  "intermediate_size": 3072,
  "max_position_embeddings": 32768,
  …
  "num_hidden_layers": 28,
  "num_key_value_heads": 8,
  …
  "tie_word_embeddings": true,
  …
  "vocab_size": 151669
}
```

*Verbatim — `config.json` of Qwen/Qwen3-Embedding-0.6B on Hugging Face (fetched 2026-11-21), trimmed with `…`; the card gives 0.6B parameters, 32K context and output dimensions from 32 to 1,024.*

The architecture is a causal *decoder* used with last-token pooling: "encoder
model" names the job, not the attention. That matters to the engine. In vLLM
v0.34 a BERT-style bidirectional encoder needs no KV cache ("Encoder attention
needs no KV cache", `EncoderOnlyModelState`), while a decoder-based one runs the
ordinary KV-backed path for its tokens in flight — 115 KB per token here
(2 × 28 × 8 × 128 × 2 bytes) — and, with last-token pooling, can use the prefix
cache (`vllm/config/model.py`). Then the vocabulary: 151,669 × 1,024 = 155M of
the 595.8M parameters are the token-embedding table, and a lookup is not
arithmetic. At 70B the table is under 2% and the 2·P rule ignores it; here it is 26%.
Use the 440M other parameters: ~0.88 GFLOP per token, ~0.97 with attention at
750 tokens.

> [!predict] Before you read on
> Per Ask Halden question, the reranker (this 0.6B shape, 37,500 tokens) and
> the LLM (70B, one 3,000-token prefill) both do arithmetic. Which does more,
> and by roughly how much?

The LLM, by about twelve times: 4.2 × 10¹⁴ FLOPs against 37,500 × 0.97 × 10⁹ ≈
3.6 × 10¹³. Twelve times more tokens, each at 1/144th of the cost. On one H100
at the course's 40% MFU the rerank takes ~92 ms.

Batching changes completely. This model's 1.2 GB of weights take ~0.4 ms to
read on an H100 and a token costs ~2.4 µs of arithmetic, so the knee sits near
175 tokens — less than one document. Every batch is compute-bound; throughput is
FLOP/s ÷ FLOPs per token. An engine that flattens requests into one token batch,
as vLLM does, pays only for real tokens; a server that pads each batch to its
longest document pays for the padding too. The metrics are latency per request,
documents or pairs per second, and each rerank response's `usage.total_tokens`.

## Images and audio enter as prompt tokens

A vision-language model (VLM) contains a second model: a **vision encoder** cuts
the image into patches and turns them into vectors inserted into the prompt as
if they were tokens. From there they are prefill tokens: 2·P FLOPs each, and KV
for the life of the request. You can price an image once you know its token
count.

> [!predict] Before you read on
> A scanned A4 page at 150 dpi (1,240 × 1,754 pixels) is sent to
> Qwen2.5-VL-7B. Roughly how many tokens does it become: about 250, about 2,800,
> or about 28,000?

The model card gives the rule: each side is rounded to a multiple of 28 pixels
and each 28 × 28 square becomes one token (14-pixel patches merged 2 × 2), from
4 to 16,384 tokens per image by default. Qwen3-VL uses 32-pixel squares; Gemma 3
resizes every image to 896 × 896 and encodes it as 256 tokens.

```python
# What one image costs a 7B vision-language model (Qwen2.5-VL-7B-Instruct).
def qwen_tokens(w, h, px):  # card: sides rounded to a multiple of px; 1 token per px x px
    return round(w / px) * round(h / px)

LM = 2 * (7_615_616_512 - 2 * 152_064 * 3_584)  # FLOPs/token: text weights minus embed + lm_head
VIS = 2 * 676_550_144 * 4                       # encoder FLOPs/token: 4 patches merge into 1 token
KV = 2 * 28 * 4 * 128 * 2                       # bytes/token: 2 x layers x KV heads x head_dim x BF16
H100 = 990e12 * 0.40                            # FLOP/s at the course's 40% MFU

print(f"{'image':17}{'Qwen2.5-VL':>11}{'Qwen3-VL':>9}{'Gemma 3':>8}"
      f"{'prefill ms':>11}{'encoder':>8}{'KV MB':>6}")
for name, (w, h) in {"photo 1280x960": (1280, 960),
                     "A4 scan, 150 dpi": (1240, 1754)}.items():
    t = qwen_tokens(w, h, 28)
    ms = t * (LM + VIS) / H100 * 1e3
    print(f"{name:17}{t:11,}{qwen_tokens(w, h, 32):9,}{256:8}"
          f"{ms:11.0f}{VIS / (LM + VIS):8.0%}{t * KV / 1e6:6.0f}")

# --- output of an actual run ---
# image             Qwen2.5-VL Qwen3-VL Gemma 3 prefill ms encoder KV MB
# photo 1280x960         1,564    1,200     256         73     29%    90
# A4 scan, 150 dpi       2,772    2,145     256        129     29%   159
```

*Runnable — Python 3 standard library only; output shown is from an actual run. Parameter counts from the Hugging Face API for Qwen2.5-VL-7B-Instruct (8,292,166,656) and Qwen2.5-7B-Instruct (7,615,616,512), the encoder being the difference; shapes from the model's `config.json`.*

About 2,800: one page is more prompt than Ask Halden's retrieved documents.
In the `encoder` column, the vision encoder does 29% of the arithmetic on a 7B
model, because it processes four patches per token it emits; in front of a 70B
model it would be ~4%.

What the engine adds is machinery around that second model:

- **Its own memory.** vLLM's `EncoderCacheManager` tracks encoder outputs kept
  in GPU memory, sized in embeddings, so an image is encoded once even when its
  prefill is split into chunks, and shared by requests carrying the same image.
- **Caches keyed by the media.** Each image's identifier is a hash of the bytes
  the client sent (`vllm/multimodal/hasher.py`, BLAKE3 by default) or a `uuid`
  the client supplies. The processor cache (`--mm-processor-cache-gb`, 4 GiB per
  process by default), the encoder cache and the prefix-cache block hash all use
  it. Hits show as `vllm:mm_cache_queries` and `vllm:mm_cache_hits` (counted in
  items) and as "MM cache hit rate" in the periodic log line.
- **A third phase to split.** Encoder-cache (EC) connectors arrived in v0.26;
  v0.28 added encoder/prefill/decode (E/P/D) disaggregation to Model Runner V2.
  vLLM's guide gives three reasons: scale encoders independently, let text-only
  requests bypass them, share encoder outputs across processes — the argument
  of [Disaggregated Serving](#/disaggregation) with one more phase. Dynamo
  v1.6.0 extended video-aware KV routing to SGLang, so repeated video requests
  reach the worker that holds their blocks.

## Speech

Speech recognition (ASR) is the image case with a clock. Whisper-large-v3-turbo's
configuration files show the shape: a 32-layer encoder over 1,500 positions per
30-second chunk (50 per second of audio), and a 4-layer decoder that writes the
text. The work is an encoder-heavy prefill and a short decode. The metric is
the **real-time factor** (RTF): processing time ÷ audio duration. Above 1, a
live stream falls behind for good.

vLLM v0.34 takes files on `/v1/audio/transcriptions` and live audio on
`/v1/realtime`, a WebSocket carrying 16 kHz PCM16 chunks in and
`transcription.delta` events out; usage is counted in seconds of audio, and each
stream holds a connection (`vllm:websocket_connections_active`). Text-to-speech
is the reverse — a short prompt and a long decode of audio tokens, priced like
any decode once the card says how many tokens make a second.

## Adapters: one base model, many fine-tunes

A **LoRA** adapter specialises a model without copying it. For a weight matrix W
(d_out × d_in) it adds two thin ones, B (d_out × r) and A (r × d_in), and the
layer computes `Wx + B(Ax)`. On Llama-3.3-70B at rank 16, on all seven matrices
of all 80 layers, that is 16 × 80 × 161,792 = 207M parameters: **414 MB** in
BF16, 0.3% of the base's bytes and FLOPs. Forty teams' fine-tunes cost forty
adapters, not forty models.

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct \
  --tensor-parallel-size 4 \
  --enable-lora \
  --max-loras 4 --max-lora-rank 16 --max-cpu-loras 16 \
  --lora-modules claims=/adapters/claims customs=/adapters/customs …
```

*Real format, illustrative values — flags from vLLM v0.34.0 `docs/features/lora.md` and `vllm/config/lora.py`; adapter names and paths invented.*

A request names its adapter in the `"model"` field. `--max-loras` (default 1)
is how many different adapters one batch may mix; a request whose adapter would
exceed it waits. `--max-lora-rank` (default 16) caps the rank. The GPU slots
are allocated at startup — `create_lora_weights` builds zeroed tensors of
`max_loras` × `max_lora_rank` for every wrapped layer — so they cost memory
whether or not an adapter is loaded, memory the KV pool would otherwise have
had: at least 1.7 GB for four rank-16 slots here, more under tensor parallelism,
where by default "only half of the LoRA computation is sharded". (S-LoRA,
arXiv 2311.03285, paged adapters and KV blocks from one pool; vLLM keeps them
apart.)

The surprise is the prefix cache. vLLM v0.34 adds `("lora", name, path)` to
every block's hash (`kv_cache_utils.py`): one system prompt under eight adapters
is eight prefixes, stored eight times, and no request hits blocks computed under
another adapter or the base model.

> [!dashboard] Adapter slots
> | USE | the metric |
> |---|---|
> | Utilisation | the `running_lora_adapters` label of `vllm:lora_requests_info` (a gauge whose value is a timestamp; the information is in the labels), against its `max_lora` label |
> | Saturation | a non-empty `waiting_lora_adapters` label on the same gauge, with `vllm:num_requests_waiting` |
> | Errors | none — derive it from the gateway's errors for requests naming an adapter the server has not loaded |

## Offline work: batch jobs and RL rollouts

Remove the interactive promise and the only number left is tokens per GPU-hour:
the batch grows until memory stops it. On Halden's node ~123
phase-1-sized sequences fill the 132 GB pool; a step is then ~14 ms + 123 ×
3,125 × 29 ns ≈ 25 ms (rung 4 of the decode ladder, KV reads for every
sequence): ~4,900 tokens per second, against ~1,250 for the twenty concurrent
requests of the morning peak. Four times the tokens from the same node, at a
25 ms TPOT nobody watches. The KV pool binds.

vLLM v0.34 runs such jobs from a file in the format of OpenAI's batch API:

```json
{"custom_id": "doc-000001", "method": "POST", "url": "/v1/embeddings", "body": {"model": "Qwen/Qwen3-Embedding-0.6B", "input": "Warehouse safety policy, section 4.2 …"}}
{"custom_id": "doc-000002", "method": "POST", "url": "/v1/embeddings", "body": {"model": "Qwen/Qwen3-Embedding-0.6B", "input": "Customs declaration checklist …"}}
```

*Real format, illustrative values — one request per line as parsed by vLLM v0.34.0 `vllm/entrypoints/launchers/run_batch.py` (chat, completions, embeddings, score, rerank and audio URLs accepted), run with `vllm run-batch -i INPUT.jsonl -o OUTPUT.jsonl --model <model>`; texts invented.*

> **State of play (November 2026):** providers sell this slack as a price.
> Anthropic's Batch API gives "a 50 percent discount on both input and output
> tokens"; OpenAI lists batch prices at half the standard ones, and
> "background" requests at 30% below standard with a 2-hour completion window
> and 40% below with an 8-hour one
> ([Anthropic](https://platform.claude.com/docs/en/about-claude/pricing),
> [OpenAI](https://developers.openai.com/api/docs/pricing), read 2026-11-21).

Reinforcement-learning post-training is the extreme case. The trainer needs
thousands of **rollouts** — the model's own attempts — per step, often many
continuations of one prompt: vLLM splits a request with `n` samples into `n`
children (`parallel_sampling.py`) whose identical prompts hit the prefix cache
after the first. Outputs are long and uneven, so each step waits for its
longest rollout. The weights change every training step, so the engine sleeps
(`--enable-sleep-mode`; level 2 drops weights and KV cache alike, since new
weights are coming) and wakes. And the trainer must score exactly what was
sampled. SGLang
v0.5.20's `return_sampling_mask` returns each step's token set so a trainer
"can replay the rollout without reconstructing top-k or top-p"; vLLM's
`VLLM_BATCH_INVARIANT=1` (beta) makes outputs independent of batch size and
order, at a throughput cost — kernels as part of correctness, as in [Did
Quantization Break Your Model?](#/did-quantization-break-your-model).

Image and video *generation* is out of scope: diffusion models, with a
different architecture and arithmetic (many denoising passes, no token loop).
Philip Kiely's *Inference Engineering* (Baseten), chapter 6, covers them:
<https://www.baseten.co/inference-engineering/book/>.

## One table to price the next workload

| workload | replaces "prefill + decode" | binding resource | replaces TTFT / TPOT | breaks the prefix cache |
|---|---|---|---|---|
| chat (the course) | prefill, then one token per step | weight reads; KV pool | TTFT, TPOT | any change to leading tokens |
| embedding | one pass | arithmetic, past the knee | latency; documents/s | no cache for bidirectional models |
| reranking | one pass per pair | arithmetic × pairs × length | pairs/s; time inside the user's TTFT | document placed before the query |
| image / audio in | encoder + longer prefill + decode | encoder and prefill arithmetic; KV | TTFT with encode; MM hit rate | other bytes for the same media |
| speech recognition | encoder + short decode | encoder arithmetic; live streams | real-time factor | — |
| multi-LoRA | chat + thin matmuls | adapter slots; KV per adapter | TTFT, TPOT per adapter | another adapter |
| batch / RL | chat with no promise | KV pool | tokens per GPU-hour; makespan | prompts with no shared prefix |

## The case

> [!case] The case: what serves retrieval
> Take Qwen3-Embedding-0.6B and Qwen3-Reranker-0.6B (Apache 2.0, 595.8M
> parameters each, 1.2 GB in BF16) and a generous corpus: 2 million 500-token
> chunks, 10⁹ tokens.
>
> - **Indexing:** 10⁹ × 0.94 GFLOP ≈ 9.4 × 10¹⁷ FLOPs: ~40 minutes of one H100
>   at 40% MFU, ~10 of the node. A nightly batch on the node, idle after hours.
>   The vectors (2M × 1,024 × 4 bytes ≈ 8 GB) live in the vector store's RAM.
> - **Per question:** embedding 200 tokens, ~0.5 ms; reranking 37,500 tokens,
>   ~92 ms of one H100. At 1.5 questions/s: 14% of one GPU, 3.4% of the node.
>   Small models rarely reach 40% MFU — measure it.
> - **Memory:** two 1.2 GB models, 37,500 × 115 KB ≈ 4.3 GB of in-flight KV,
>   two CUDA contexts: budget 8 GB on one GPU — all of the margin the case
>   leaves outside the LLM's budget. Lowering the LLM's
>   `--gpu-memory-utilization` from 0.90 to 0.80 frees it, but the flag applies
>   to all four GPUs: the pool falls from 132 to **100 GB** (phase 1 needs ~21).
> - **Time:** two processes on one GPU take turns, and a tensor-parallel step
>   waits for its slowest GPU, so a rerank on GPU 0 stretches the LLM steps it
>   overlaps on all four.
>
> **Decision.** Phase 1: both models on GPU 0, LLM at 0.80; compare
> `vllm:inter_token_latency_seconds` p99 with reranking on and off. Phase 2
> evicts them: at 0.80 an FP8 TP=2 replica holds 0.80 × 160 − 78 = **50 GB**,
> below the ~61 GB a survivor needs when its twin fails at the peak. The
> reranker moves to a small separate GPU, or scores 20 candidates instead of 50.
> [Sizing a Deployment](#/sizing-a-deployment) budgets both phases this way.
>
> **The stake.** Retrieval sits inside the user's TTFT and outside
> `vllm:time_to_first_token_seconds`, which starts when the engine receives the
> prompt. A reranker moved to a CPU would need ~360 TFLOP/s to finish in 0.1 s;
> on a real CPU it takes seconds, and the engine's dashboard stays green. Halden
> measures TTFT at the gateway and gives the LLM what retrieval leaves of 1.5 s.

## Exercises

<div class="exercise">

**Exercise 1 — quantitative.** The search team wants Qwen3-Embedding-8B
(7,567,295,488 parameters; vocabulary 151,665 × 4,096; 36 layers; up to 4,096
dimensions). Re-price the nightly re-index of 10⁹ tokens, the vector store at
full dimension in float32, and one query. What survives of the case's plan?

<details>
<summary>Reveal answer</summary>

Non-embedding parameters: 7.567B − 0.621B = 6.95B → ~14.0 GFLOP per token with
attention, fifteen times the 0.6B model. 10⁹ × 1.4 × 10¹⁰ = 1.4 × 10¹⁹ FLOPs ÷
3.96 × 10¹⁴ ≈ **10 H100-hours, ~2.5 hours of the node**: still one night. The
store grows to 2M × 4,096 × 4 bytes ≈ **33 GB**; the model accepts smaller
output dimensions, so 1,024 keeps 8 GB if recall allows. A 200-token query is
2.8 × 10¹² FLOPs, ~7 ms of an H100. What breaks is memory: 15 GB of weights for
daytime query embedding no longer fits in GPU 0's 8 GB budget, so it moves off
the node or the LLM gives up another 32 GB of pool.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A damage-assessment assistant runs Qwen2.5-VL-7B on
one H100. Each conversation carries six photos (~1,000 tokens each) that the
stateless API re-sends every turn; conversations last about five turns. TTFT p95
has reached 9 s. Two scrapes, 60 s apart:

```plaintext
# 10:14:00
vllm:mm_cache_queries_total{engine="0",model_name="damage-vl"} 541200
vllm:mm_cache_hits_total{engine="0",model_name="damage-vl"} 3790
vllm:prefix_cache_queries_total{engine="0",model_name="damage-vl"} 676500000
vllm:prefix_cache_hits_total{engine="0",model_name="damage-vl"} 90150000
vllm:num_requests_waiting{engine="0",model_name="damage-vl"} 31
# 10:15:00
vllm:mm_cache_queries_total{engine="0",model_name="damage-vl"} 542400
vllm:mm_cache_hits_total{engine="0",model_name="damage-vl"} 3799
vllm:prefix_cache_queries_total{engine="0",model_name="damage-vl"} 678000000
vllm:prefix_cache_hits_total{engine="0",model_name="damage-vl"} 90355000
vllm:num_requests_waiting{engine="0",model_name="damage-vl"} 38
```

*Real format, illustrative values — metric names and labels from vLLM v0.34.0 `vllm/v1/metrics/loggers.py` (counters carry `_total` when scraped); values computed for this scenario, not measured.*

What binds, which cache is failing, what is the likely cause, and how do you
confirm and fix it?

<details>
<summary>Reveal answer</summary>

In the minute: 1,200 media items queried, **9 hits (0.75%)**; 1.5M prompt
tokens queried, 205,000 hit (14%); the queue grows. Six items per request is 200
requests, 25,000 prompt tokens/s — at ~18 GFLOP per image token, ~110% of an
H100 at 40% MFU. Prefill arithmetic binds.

Five-turn conversations should find all six photos cached four turns in five:
an MM hit rate near 80%. Near zero means the identifiers change between turns.
The hash covers the bytes sent, and a client that resizes and re-encodes each
photo on every send produces new bytes for the same picture. The prefix cache
falls with it, because blocks holding an image carry its identifier; the 14%
still hitting is the text before the first photo.

Confirm by hashing the uploaded bytes for two turns of one conversation. Fix by
re-sending the first upload's bytes, or a stable `"uuid"` per photo in the
`image_url` part; the load then falls to about a fifth of the GPU.

</details>

</div>

<div class="exercise">

**Exercise 3 — find the flaw.** A memo proposes adapters for eight departments
on a Llama-3.3-70B node (TP=4, 132 GB pool). Which statements are wrong?

1. "A rank-16 adapter on all modules is ~400 MB, so eight cost ~3.3 GB."
2. "We launch with `--enable-lora --max-loras 32 --max-lora-rank 256` so we
   never restart when adapters change."
3. "All departments share the 800-token system prompt, so prefix-cache hit
   rates stay as they are."
4. "Teams load adapters themselves through `/v1/load_lora_adapter`, with
   `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True` on the production server."

<details>
<summary>Reveal answer</summary>

1 is right (414 MB each). 2 is wrong: slots for `max_loras` adapters at
`max_lora_rank` are reserved at startup. A rank-256 slot is 16 × 414 MB ≈
6.6 GB; thirty-two are ≈ 212 GB, more than the pool. vLLM's guide says to set
the rank to the largest one in use. 3 is wrong: the adapter is in every block
hash, so the prompt is stored eight times (8 × 262 MB) and each department hits
only its own copy. 4 is wrong for production: the documentation warns runtime
loading "should not be used in production unless it is an isolated, fully
trusted environment".

</details>

</div>

<div class="exercise">

**Exercise 4 — transfer.** Legal wants parties, dates and amounts extracted as
JSON from 1 million archived contracts, overnight (10 hours), on Halden's node.
Contracts average 1,500 tokens; the JSON is ~150; the instruction and schema are
600 tokens, identical for every contract. Fill in the closing table's row and
say whether the night is long enough.

<details>
<summary>Reveal answer</summary>

Chat with no promise: batch. Prefill is 1.5 × 10⁹ contract tokens × 0.089 ms ≈
**37 node-hours** on the 70B model; decode, 1.5 × 10⁸ tokens at ~4,900 tokens/s,
adds ~8.5. Prefill arithmetic binds, not the KV pool, and the night is over four
times too short. Metric: makespan and tokens per GPU-hour. Prefix cache: put the
600-token instruction and schema first, computed once instead of a million times
(0.6 × 10⁹ tokens). Then shrink the work: an 8B model cuts prefill to ~4 node-hours
if an evaluation shows it extracts as well, or send only the pages that hold the
fields. Constrained decoding (vLLM's structured outputs, xgrammar or guidance
backends) guarantees valid JSON at some per-step cost — measure it in a pilot. A
provider's batch API would be half price; the data rule forbids it.

</details>

</div>

## What to remember

- Embedding and reranking are prefill without decode, past the knee from the
  first document: throughput is FLOP/s ÷ FLOPs per token, and a small model's
  embedding table does no arithmetic.
- An image or a second of audio is a token count fixed by the model card plus an
  encoder pass: price it like text, then add the encoder.
- Media and adapters are part of the cache key: the same text under another
  adapter, or the same photo in other bytes, is a miss.
- Without an interactive promise the operating point moves to the memory limit;
  providers sell that slack at about half price.
- Time spent outside the LLM engine is inside the user's TTFT and outside the
  engine's metric: measure at the gateway.

```quiz
[
  {
    "q": "A support tool sends 1,024 × 768 screenshots to Qwen3-VL, whose processor turns every 32 × 32-pixel square into one token. How many visual tokens does one screenshot add to the prompt?",
    "choices": [
      "256, because every image is resized to a fixed 896 × 896 input first",
      "1,003, because each side is rounded to a multiple of 28 pixels first",
      "768, from 32 squares across times 24 squares down",
      "3,072, because each token stands for one 16 × 16 patch of pixels"
    ],
    "answer": 2,
    "explain": "1,024 ÷ 32 = 32 and 768 ÷ 32 = 24, so 768 tokens. The 1,003 answer uses Qwen2.5-VL's 28-pixel squares, 256 is Gemma 3's fixed encoding, and 3,072 counts the 16-pixel patches before the 2 × 2 merge."
  },
  {
    "q": "A reranking service on vLLM keeps its GPU's arithmetic near 100%, and each /v1/rerank call takes time proportional to the number of documents sent. An engineer proposes raising --max-num-seqs so more requests share each step. What happens to throughput?",
    "choices": [
      "Almost nothing: every step is already past the knee, so pairs/s is set by FLOP/s",
      "It rises sharply, because more sequences now share each read of the weights",
      "It falls, because a larger batch forces the scheduler to preempt running requests",
      "It doubles, because the reranker's KV cache can now be reused across requests"
    ],
    "answer": 0,
    "explain": "A pooling model's knee is a few hundred tokens and one document exceeds it, so a bigger batch shares nothing new: throughput is FLOP/s ÷ FLOPs per pair. Fewer candidates, shorter chunks, a smaller model or more GPUs move it. 'Share each read of the weights' is decode intuition, true only below the knee."
  },
  {
    "q": "An encoder with 335M non-embedding parameters embeds 512-token chunks on an A100 (312 TFLOP/s BF16) at 40% MFU. Ignoring attention, about how many chunks per second can it embed?",
    "choices": [
      "About 36, because each chunk takes one full pass over the weights",
      "About 360, from 1.25e14 FLOP/s over 3.4e11 FLOPs per chunk",
      "About 3,600, since the batch amortises the weight reads across chunks",
      "About 180,000, from FLOP/s divided by FLOPs for one token of each chunk"
    ],
    "answer": 1,
    "explain": "Per chunk: 2 × 335e6 × 512 ≈ 3.4e11 FLOPs. Achieved: 312e12 × 0.40 ≈ 1.25e14 FLOP/s. Ratio ≈ 360 chunks/s. The 3,600 answer assumes batching makes arithmetic cheaper, which it does not past the knee; 180,000 forgets that every token of the chunk costs 2·P."
  },
  {
    "q": "A live-captioning service measures a real-time factor of 0.05 per stream when idle. At peak, contention pushes each stream's real-time factor to 1.3. What do viewers see?",
    "choices": [
      "Captions slow down by 30% at first, then recover as the queue drains on its own",
      "Nothing visible, since 1.3 is still close enough to real time for live viewing",
      "Captions arrive 1.3 s late at a constant offset behind the audio throughout",
      "Captions fall further behind every second, without bound, until load drops"
    ],
    "answer": 3,
    "explain": "A real-time factor above 1 means each second of audio takes 1.3 s to process, so the backlog grows by 0.3 s per second of speech: the delay increases without limit. A constant offset needs a factor at or below 1; nothing drains while audio arrives faster than it is processed."
  },
  {
    "q": "An RL team's trainer recomputes the log-probabilities of tokens sampled by its vLLM rollout server and finds small differences that change with how many rollouts ran in the same batch. What is the cause, and the fix?",
    "choices": [
      "The sampler drew different tokens; set temperature to zero for all rollouts",
      "Kernels depend on batch shape; set VLLM_BATCH_INVARIANT=1, at a speed cost",
      "The weights were stale; put the engine to level-2 sleep before every request",
      "The prefix cache served wrong blocks; disable it so every prompt is recomputed"
    ],
    "answer": 1,
    "explain": "The tokens are the same; their scores differ because reductions inside the kernels depend on batch size and order. vLLM's batch-invariant mode makes outputs independent of both, and its documentation warns it may cost performance. Greedy sampling does not change the logit arithmetic, and the prefix cache is keyed by exact tokens."
  }
]
```
