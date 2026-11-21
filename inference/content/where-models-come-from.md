# Where a Model Comes From

> **The question:** what was done to produce the file you are about to serve —
> and which of it is frozen by the time it reaches you?
>
> **You'll be able to:** read a checkpoint's tensor listing and say what is, and
> is not, in it; tell a base model from a chat model and a reasoning model, and
> predict how each behaves behind your server; estimate what training cost
> next to what serving costs, and say why they are different engineering
> problems; separate what a serving team can still choose from what the lab
> froze.

To serve Llama-3.3-70B-Instruct you download thirty files of 2 to 5 GB each.
Before loading them into anything, open the first one. You need not download
4.6 GB: the format puts a table of contents at the front of the file, and an
HTTP range request fetches just that.

## A model is a file of numbers

The format is **safetensors**: eight bytes giving the length of a JSON header,
the header itself, then raw numbers. The header lists every **tensor** (a named
multi-dimensional array of numbers) in the file, with its number format, its
shape, and where its bytes sit.

```python
# Fetch only the first 64 KB of the first weight shard (the file is 4.6 GB):
#   curl -sL -r 0-65535 -o shard1.head https://huggingface.co/RedHatAI/\
#     Llama-3.3-70B-Instruct/resolve/main/model-00001-of-00030.safetensors
import json, struct

with open("shard1.head", "rb") as f:
    n = struct.unpack("<Q", f.read(8))[0]    # 8 bytes, little-endian: header size
    header = json.loads(f.read(n))           # then n bytes of JSON

print(f"header: {n:,} bytes of JSON; metadata: {header.pop('__metadata__')}")
total = 0
for name, t in sorted(header.items()):
    begin, end = t["data_offsets"]           # where this tensor's bytes sit
    total += end - begin
    if name.startswith(("model.embed", "model.layers.0.")):
        print(f"{name:46} {t['dtype']} {str(t['shape']):15} {end - begin:>13,}")
print(f"{len(header)} tensors, {total:,} bytes of numbers in this shard")

# --- output of an actual run ---
# header: 1,760 bytes of JSON; metadata: {'format': 'pt'}
# model.embed_tokens.weight                      BF16 [128256, 8192]  2,101,346,304
# model.layers.0.input_layernorm.weight          BF16 [8192]                 16,384
# model.layers.0.mlp.down_proj.weight            BF16 [8192, 28672]     469,762,048
# model.layers.0.mlp.gate_proj.weight            BF16 [28672, 8192]     469,762,048
# model.layers.0.mlp.up_proj.weight              BF16 [28672, 8192]     469,762,048
# model.layers.0.post_attention_layernorm.weight BF16 [8192]                 16,384
# model.layers.0.self_attn.k_proj.weight         BF16 [1024, 8192]       16,777,216
# model.layers.0.self_attn.o_proj.weight         BF16 [8192, 8192]      134,217,728
# model.layers.0.self_attn.q_proj.weight         BF16 [8192, 8192]      134,217,728
# model.layers.0.self_attn.v_proj.weight         BF16 [1024, 8192]       16,777,216
# 15 tensors, 4,584,407,040 bytes of numbers in this shard
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run on the first 64 KB of `model-00001-of-00030.safetensors` in the public RedHatAI/Llama-3.3-70B-Instruct mirror of the gated meta-llama repo (revision 3cbf1bcb, fetched 2026-11-21).*

Every line is a table of numbers with a name. `BF16` is bfloat16, two bytes per
number, so `[8192, 8192]` is 67 million numbers and 134 MB. The first entry is a
128,256 × 8,192 table: one row of 8,192 numbers for each entry of the
vocabulary you met in [What Actually Happens When You Call an
LLM](#/what-is-inference). The names after it — `q_proj`, `k_proj`, `mlp`,
`layernorm` — are the parts of one layer, and the next chapter takes them
apart. Here, read only what kind of object this is.

> [!predict] Before you read on
> The shard is 4,584,408,808 bytes on disk. How many of those bytes are
> something other than numbers — code, rules, an index of facts, the training
> documents? More or less than 1%?

Far less. The header is 1,760 bytes and its length field 8 more:
4,584,408,808 − 1,768 = 4,584,407,040, exactly the sum the script printed.
There is no code in the file and no training text, and no tensor holds "the
forklift policy": whatever the model knows is spread across all 70 billion
numbers, and nobody can point at the bytes that hold one fact. The program that
does the arithmetic lives in the serving engine, written once per architecture.
The checkpoint is a data file and the engine its interpreter — with the
difference that you cannot audit this input by reading it.

## Where the numbers come from

Before training, every one of those numbers is random, and the model's
next-token scores are noise. **Pretraining** fixes that with one procedure,
repeated an enormous number of times:

1. Take a passage of real text.
2. At every position, have the model score the next token, just as it does when
   you serve it.
3. Compare with the token that actually came next in the passage.
4. Nudge every weight a tiny amount in the direction that would have made the
   right token score a little higher (computing that direction is what
   backpropagation does; serving never needs it).
5. Repeat with the next passage.

No rules or facts are entered by hand. Grammar, arithmetic and the capital of
France emerge because they help predict the next token across trillions of
examples.

The scale is what makes it expensive. Llama 3.3's card (December 2024) reports
pretraining on "~15 trillion tokens of data from publicly available sources",
with a cutoff of December 2023, and 7.0 million GPU-hours on H100-80GB for the
model. At the $2.50 per GPU-hour Halden pays, that is $17.5 million of rented
time; Halden's four-GPU node would need about two hundred years. Meta's paper on
the family ([The Llama 3 Herd of Models](https://arxiv.org/abs/2407.21783), July
2024) trained the 405B sibling on up to 16,000 H100s. The scale has kept growing:
NVIDIA's Nemotron 3 Super card (March 2026) reports pretraining "for over 25T
tokens", and Mistral's Large 4 card (September 2026) a model "trained from
scratch on 3,800 NVIDIA Grace Blackwell GPUs".

The result of pretraining is a **base model**: a general text continuer. Give it
the first half of a document and it writes a plausible second half. Give it a
question and it may answer — or continue with three more questions, because
that is also how such text continues on the web. It has no notion of whose turn
it is or of when an answer is finished. And its knowledge stops at the data's
cutoff: December 2023 for Llama 3.3, forever.

## From predictor to assistant

**Instruction tuning** (also called supervised fine-tuning, SFT) runs the same
training loop on a much smaller set of example conversations — prompts and good
answers — all written in one fixed layout: the **chat template** you saw in
[What Actually Happens When You Call an LLM](#/what-is-inference), with its `<|start_header_id|>` headers and an `<|eot_id|>` after every
turn. The model learns that after an assistant header comes an answer, and that
after the answer comes `<|eot_id|>`. Llama 3.3's card says its fine-tuning data
includes "over 25M synthetically generated examples".

The architecture does not change. Here is the base model's `config.json` against
the instruct model's, field by field:

```diff
--- base.json	(Meta-Llama-3.1-70B, the pretrained model)
+++ instruct.json	(Llama-3.3-70B-Instruct)
@@ -5,7 +5,12 @@
   "attention_bias": false,
   "attention_dropout": 0.0,
   "bos_token_id": 128000,
-  "eos_token_id": 128001,
+  "eos_token_id": [
+    128001,
+    128008,
+    128009
+  ],
+  "head_dim": 128,
   "hidden_act": "silu",
   "hidden_size": 8192,
   "initializer_range": 0.02,
@@ -28,7 +33,7 @@
   "rope_theta": 500000.0,
   "tie_word_embeddings": false,
   "torch_dtype": "bfloat16",
-  "transformers_version": "4.44.2",
+  "transformers_version": "4.47.0.dev0",
   "use_cache": true,
   "vocab_size": 128256
 }
```

*Verbatim — output of `diff -u` on the two `config.json` files with keys sorted (`jq -S`), from the public mirrors unsloth/Meta-Llama-3.1-70B (revision 1b730665) and RedHatAI/Llama-3.3-70B-Instruct (revision 3cbf1bcb), checked 2026-11-21; three fields the unsloth mirror adds (`_name_or_path`, `pad_token_id`, `unsloth_version`) removed before diffing, file labels annotated. Llama 3.3's card names `meta-llama/Llama-3.1-70B` as its `base_model`.*

Same layers, same widths, same vocabulary; `head_dim` is written out explicitly
but has the value the base model derives. The one real difference is the list of
stop tokens: the base model knows only `<|end_of_text|>` (128001), the end of a
document, while the instruct model also stops at the end of a turn
(`<|eot_id|>`, 128009) and at `<|eom_id|>` (128008), which its template uses
after a call to a built-in tool. Everything else that changed is inside the
141 GB of numbers. The base repository's `tokenizer_config.json` has no chat
template at all.

That is why the template matters. The model was trained on that exact sequence of
tokens, so the same words wrapped in another family's turn markers are input it
never saw. Nothing fails: the server sends text, the model returns tokens. The
answers are simply worse, or do not stop where they should. OpenAI's gpt-oss card
says it bluntly: the models "were trained on our harmony response format and
should only be used with the harmony format as it will not work correctly
otherwise".

**Preference and reinforcement tuning** come next. The model writes several
answers to the same prompt; something scores them — people ranking them, a
second model trained on such rankings, or an automatic check such as a unit test
or a known numeric answer — and the weights are nudged toward the better-scored
answers. Llama 3.3's card says "supervised fine-tuning (SFT) and reinforcement
learning with human feedback (RLHF)"; Nemotron 3 Super's lists a further stage
of "multi-environment reinforcement learning" over math, code and tool use.
Safety tuning uses the same machinery to teach refusals and their tone.

**Reasoning models** are trained, mostly with that reinforcement stage on
problems whose answers can be checked, to write a long scratchpad before the
answer. To the server these thinking tokens are ordinary output: one decode step
each, a slot in the KV cache each, billed like any other token. Qwen3.8-27B's
card (August 2026) says: "Thinking mode is on by default and can be disabled per
request." vLLM v0.34 separates the two in the response when it runs a reasoning
parser (`--reasoning-parser`): the scratchpad goes to a `reasoning` field, the
answer to `content`, and `usage.completion_tokens_details.reasoning_tokens` counts
the part the user may never see. What that does to an agent's traffic is the
subject of [Agentic Serving](#/agentic-serving).

```text
  random numbers
      │  pretraining: trillions of tokens, "score the next token"
      ▼
  base model            continues any text; no turns, no notion of done
      │  instruction tuning: conversations in one fixed template
      ▼
  chat model            answers, then emits its end-of-turn token
      │  preference / reinforcement tuning, safety tuning
      ▼
  released checkpoint   …-Instruct: the files you serve
      ├─ quantized copy     the same model, fewer bytes per number
      ├─ distilled model    a smaller model trained to imitate it
      └─ adapter (LoRA)     a small add-on file for a narrower task
```

## Same model, other shapes

Labs, and other people, publish more than one artifact per model.

**Distilled models.** A small model can be trained to imitate a large one: instead
of learning only from the single next token in the text, it learns from the
large model's whole score distribution at each position. Meta's card for Llama 3.2
1B and 3B says "logits from the Llama 3.1 8B and 70B models" were used "as
token-level targets". Google's [Gemma 3 report](https://arxiv.org/abs/2503.19786)
(March 2025) says its models "are trained with distillation" and that
Gemma3-4B-IT is "competitive with Gemma2-27B-IT", a model nearly seven times its
size from the year before. Parameter count is a cost, not a quality ranking
across generations; only an evaluation on your task ranks two models for you.

**Quantized releases.** The same model with fewer bytes per number:
RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic is 72.7 GB of weight files against
141 GB. Some models now ship this way from the lab: gpt-oss stores its experts in
a 4-bit format (MXFP4), and its card notes: "All evals were performed with the
same MXFP4 quantization." Whether a copy someone else made is as good as the original is a
question you answer by measurement, in [Quantization](#/quantization).

**Adapters.** A **LoRA** (low-rank adaptation) adapter trains a small set of
extra numbers next to frozen weights instead of changing the weights themselves.
The [LoRA paper](https://arxiv.org/abs/2106.09685) (2021) reports 10,000 times
fewer trainable parameters than full fine-tuning on GPT-3 175B. The adapter is a
separate small file; one copy of the base model in GPU memory can serve many
adapters, one per request, which [Beyond Chat](#/beyond-chat) covers.

## Training and serving are different machines

Training and inference run the same forward pass, which is why it is tempting to
think of them as one workload at two sizes.

> [!predict] Before you read on
> Serving Llama-3.3-70B needs its ~140 GB of weights in GPU memory, plus the KV
> cache. Full fine-tuning the same model, with the standard optimizer (Adam) in
> mixed precision, needs how much memory for the model's state alone, before any
> per-token data: about the same, about twice, or about eight times?

About eight times. Training keeps, for every parameter, the BF16 weight, a
gradient (the computed nudge), and the optimizer's state: an FP32 master copy of
the weight and two running averages. The [ZeRO
paper](https://arxiv.org/abs/1910.02054) counts it as 2 + 2 + 12 = 16 bytes per
parameter against the 2 a server needs: 70 billion × 16 = 1,120 GB, plus the
intermediate results of every layer, kept for the backward pass. Serving has none
of that. It has something training does not: state that belongs to each user.

| | Training | Serving |
|---|---|---|
| What is optimised | tokens learned per GPU-hour, over weeks | a latency promise per request (TTFT, TPOT) |
| Arithmetic per token | ~6 × parameters (forward pass plus computing the nudges) | ~2 × parameters (forward pass only) |
| Memory besides the weights | gradients and optimizer state, ~14 bytes per parameter | KV cache, per conversation, growing with every token |
| Who shapes the batch | the training script, fixed in advance | whoever arrives, unknown in advance |
| A machine fails | restart from the last checkpoint, lose minutes | every request in flight fails, in front of a user |
| The weights | change every step | frozen and read-only |

The failure row is not theoretical. Over 54 days of Llama 3 405B pretraining,
Meta counted "466 job interruptions", 419 unexpected, about 78% of those from
confirmed hardware issues, and still reported "higher than 90% effective
training time": a training job is built to lose work and redo it. A server has
nothing to redo. The factor of six is from the scaling-laws paper ([Kaplan et
al., 2020](https://arxiv.org/abs/2001.08361)): the backward pass costs
"approximately twice the compute as the forwards pass". That is why serving is
its own discipline; this course assumes the training is over.

## What is frozen, and what is yours

When the checkpoint reaches you, these are fixed:

- the weights, and with them what the model knows and its knowledge cutoff;
- the vocabulary and tokenizer: which text becomes how many tokens;
- the architecture: layers, widths, heads — hence the bytes of weights and of
  KV cache per token, which the next chapter derives;
- the trained context length;
- the interface: chat template, stop tokens, tool-call format, whether it thinks
  first.

These are yours:

- precision — fewer bytes per number changes the model slightly, so it comes
  with an evaluation ([Did Quantization Break Your
  Model?](#/did-quantization-break-your-model));
- engine, hardware and parallelism;
- scheduling: how requests share passes and memory, most of The Engine;
- sampling: temperature, top-p, maximum length, stop strings;
- what you admit: the longest prompt (at most the trained context), the system
  prompt, what retrieval puts in.

> [!case] The case: Halden runs a published checkpoint, unchanged
> Ask Halden serves `Llama-3.3-70B-Instruct` exactly as Meta released it. Its
> knowledge stops at December 2023; every lever Halden holds is on the "yours"
> list.
>
> **The stake.** At the pilot review a manager asks: "Why retrieve documents at
> every request? Fine-tune the model on them once." Price it.
>
> - **Compute:** ~6 × 70 × 10⁹ FLOPs per training token. At the node's achieved
>   1.58 × 10¹⁵ FLOP/s, every 100 million tokens of documents costs ~7.4 hours per
>   pass. Affordable.
> - **Memory:** a full fine-tune needs ~16 bytes per parameter: 1,120 GB, before
>   activations, on a node with 320 GB. It does not fit. A LoRA adapter would:
>   frozen 140 GB plus a small trainable add-on.
> - **What it freezes:** the documents as of training day. A safety policy revised
>   on Monday is not in Sunday's weights; every revision means training again and
>   re-running the evaluation. Retrieval reads Monday's version on Monday, knows
>   which document each answer came from, and can respect who may read what. A
>   fine-tuned model answers every employee from everything it was trained on.
>
> **Decision.** Halden does not train or fine-tune; the checkpoint is a fixed
> input and retrieval stays. What would reopen it: a behaviour that the system
> prompt cannot get (a strict output format, a house style) — and then a LoRA
> adapter served on the same base, not new weights. Everything Halden can change —
> precision, engine, hardware, scheduling — is the rest of the course.

## Exercises

<div class="exercise">

**Exercise 1.** Use Llama 3.3's card: ~15 trillion pretraining tokens, 7.0 million
H100 GPU-hours. (a) At Halden's traffic (12,000 requests a day of ~3,250 tokens
each), how long would Ask Halden take to push as many tokens through the model
as pretraining did? (b) Pretraining costs ~6 × parameters FLOPs per token.
Compute the total, and the average rate per GPU the card's hours imply. What
fraction of an H100's 990 TFLOP/s is that?

<details>
<summary>Reveal answer</summary>

(a) 12,000 × 3,250 = 39 million tokens a day. 15 × 10¹² ÷ 39 × 10⁶ ≈ 385,000
days, about 1,050 years. The lab pays for making the model once; you pay for
serving it every month.

(b) 6 × 70 × 10⁹ × 15 × 10¹² ≈ 6.3 × 10²⁴ FLOPs. The card's hours are 7.0 × 10⁶ ×
3,600 ≈ 2.5 × 10¹⁰ GPU-seconds, so ≈ 2.5 × 10¹⁴ FLOP/s per GPU: about 25% of
990 TFLOP/s — an average over whatever the hours cover, which the card does not
say (restarts, fine-tuning, evaluation). From parameters, tokens and a peak rate
you can check any training claim to within a factor of two.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A developer brings up a test server for Ask Halden.
The chat endpoint fails:

```plaintext
$ curl -s http://llm-dev:8000/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"model": "llama-70b", "messages": [{"role": "user", "content": "Which forklift licence do new warehouse staff need?"}]}'
{"error":{"message":"As of transformers v4.44, default chat template is no longer allowed, so you must provide a chat template if the tokenizer does not define one.","type":"BadRequestError","param":null,"code":400}}
```

*Real format, illustrative values — error text from vLLM v0.34.0 `vllm/renderers/hf.py` (`safe_apply_chat_template`), error body from `vllm/entrypoints/serve/exception_handling/error_response.py` (a client error maps to 400 `BadRequestError`); host, model name and question invented.*

They switch to the plain completion endpoint with a hand-written prompt,
`"Question: Which forklift licence do new warehouse staff need?\nAnswer:"`, and
get an answer, then this. They also paste `/v1/models`:

```plaintext
{"id":"cmpl-8d1e…","object":"text_completion","created":1795253412,"model":"llama-70b","choices":[{"index":0,"text":" Category B.\n\nQuestion: Do agency staff need the same licence?\nAnswer: Yes.\n\nQuestion: How long is the licence valid?\nAnswer: …","logprobs":null,"finish_reason":"length","stop_reason":null,…}],"usage":{"prompt_tokens":17,"total_tokens":417,"completion_tokens":400}}

{"object":"list","data":[{"id":"llama-70b","object":"model","created":1795253400,"owned_by":"vllm","root":"unsloth/Meta-Llama-3.1-70B","parent":null,"max_model_len":131072,…}]}
```

*Real format, illustrative values — field names from vLLM v0.34.0 `vllm/entrypoints/openai/completion/protocol.py` (`CompletionResponse`) and `vllm/entrypoints/serve/engine/protocol.py` (`ModelCard`: `root`, `max_model_len`); text and numbers invented.*

What is wrong, which line of the artifacts proves it, and what is the fix? Would
passing `--chat-template` with the Llama 3 template be a fix?

<details>
<summary>Reveal answer</summary>

The server runs the base model. `root` says `Meta-Llama-3.1-70B`, with no
`-Instruct`; the served name `llama-70b` hid it. The base repository has no chat
template, so vLLM v0.34 refuses chat requests (the 400). On the completion
endpoint the model continues the text as such text continues on the web — more
questions and answers — and never stops: `finish_reason` is `length`, 400 tokens
of 400. Its only stop token is `<|end_of_text|>`, the end of a document.

The fix is to deploy `Llama-3.3-70B-Instruct`. Passing the Llama 3 template would
remove the error, not the problem: the base model was never trained on that
format and has no reason to emit `<|eot_id|>`. Add a startup check that compares
`root` with the approved checkpoint.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Another team serves Qwen3.8-27B, a reasoning model with
thinking on by default, for a code-review assistant on one GPU. They measured
22 ms per decode step at their load, and TTFT of 0.4 s. One typical response
reports:

```json
"usage": {"prompt_tokens": 4210, "total_tokens": 7046, "completion_tokens": 2836,
          "completion_tokens_details": {"reasoning_tokens": 2511}}
```

*Real format, illustrative values — field names from vLLM v0.34.0 `vllm/entrypoints/serve/engine/protocol.py` (`UsageInfo`, `CompletionTokenUsageInfo`), present when a reasoning parser is configured; numbers invented.*

(a) How many tokens does the reviewer read? (b) If the client does not display
the reasoning, how long until the first visible word, and how long would the
whole reply take without thinking? (c) The team sized the deployment from the
length of visible answers. By what factor is that off? (d) What can they change,
and what must they measure before changing it?

<details>
<summary>Reveal answer</summary>

(a) 2,836 − 2,511 = 325 tokens of answer. `completion_tokens` counts both parts.

(b) The first visible token comes after TTFT plus 2,511 decode steps: 0.4 +
2,511 × 0.022 ≈ 55.6 s. Without thinking, the whole 325-token answer would take
0.4 + 325 × 0.022 ≈ 7.6 s.

(c) 2,836 decode steps, not 325: 8.7 times more, and each request holds its KV
cache 8.7 times longer, with 2,511 extra tokens in it. Throughput, memory and
cost estimates built on visible answers are off by that factor.

(d) Qwen's card offers two levers: turn thinking off per request, or lower
`reasoning_effort` (default `xhigh`; also `medium`, `low`). Either changes the
answers, so run the team's review benchmark at each setting first. Do not cap
`max_tokens` near the visible length: the cap counts reasoning, and a cut-off
scratchpad means no answer.

</details>

</div>

## What to remember

- A checkpoint is named tensors of numbers — safetensors is an 8-byte length, a
  JSON header and raw bytes. No code, no documents, no fact you can point to.
- Pretraining makes a base model that continues text. Instruction tuning on one
  fixed template, then preference and reinforcement tuning, make the model you
  serve; the architecture does not change, the stop tokens and the template do.
- A model is trained on its own template. Another template is not an error; it
  is silently worse answers.
- Reasoning tokens are ordinary output tokens: decode steps, KV and cost, counted
  in `completion_tokens` whether the user sees them or not.
- Training needs ~16 bytes of state per parameter and ~6 × parameters FLOPs per
  token, and tolerates restarts; serving needs ~2 bytes and ~2 × parameters,
  plus per-user KV, and answers to a latency promise.
- Frozen: weights, vocabulary, architecture, trained context, template. Yours:
  precision, engine, hardware, scheduling, sampling, what you admit.

```quiz
[
  {
    "q": "A team serves google/gemma-4-31B-it but launches vLLM with --chat-template pointing at a ChatML template copied from another model family. Every request succeeds, no errors are logged, and reviewers say the answers got worse and sometimes do not stop cleanly. What is the most likely cause?",
    "choices": [
      "The engine rejects ChatML's special tokens and quietly falls back to the base weights",
      "The model learned its own turn format in training; a different one is unfamiliar input",
      "ChatML adds so many tokens per turn that prompts overflow the model's context window",
      "A foreign template swaps the tokenizer's vocabulary, so token IDs no longer match rows"
    ],
    "answer": 1,
    "explain": "A chat template is only text with special tokens; the engine renders whatever template it is given, and the model reads it. Gemma was tuned on its own turn markers and end-of-turn token, so foreign markers are out-of-distribution input: worse answers, misplaced stops, no error. The template does not change the vocabulary (the tokenizer file does that), and a few markers per turn cannot fill a 256K window."
  },
  {
    "q": "You want to fully fine-tune an 8B-parameter model with Adam in mixed precision on one 80 GB GPU. Its BF16 weights are 16 GB. Does the training state fit?",
    "choices": [
      "Yes: Adam keeps one extra copy of the weights, 32 GB in total, leaving room",
      "Yes: 16 GB of weights leave 64 GB free, the same headroom serving would have",
      "No: training needs about six times the weights, about 96 GB, before activations",
      "No: about 16 bytes per parameter is about 128 GB, before any activations"
    ],
    "answer": 3,
    "explain": "Mixed-precision Adam keeps a 2-byte weight, a 2-byte gradient, and 12 bytes of optimizer state (FP32 master copy and two moments) per parameter: 16 × 8 × 10⁹ = 128 GB. The 'six times' distractor confuses the 6 × parameters FLOPs per training token with memory."
  },
  {
    "q": "A vendor announces that its new 4B model, distilled from a large teacher, matches last year's 27B model on public benchmarks. What can you conclude before testing it on your workload?",
    "choices": [
      "Its serving cost follows its own 4B size; how well it does your task is still unknown",
      "It will match the 27B on every task, because distillation copies the teacher's knowledge",
      "Its serving cost is close to the teacher's, because the knowledge came from the teacher",
      "Nothing: parameter counts say nothing about the memory or compute a model needs"
    ],
    "answer": 0,
    "explain": "Memory and arithmetic per token follow the parameters you load: a 4B model costs a 4B model's bytes and FLOPs. Quality is another matter: public benchmarks are not your task, and a distilled student matches its teacher on some tasks and not others. The teacher's size does not enter the serving bill."
  },
  {
    "q": "Users of an internal chatbot built on an open-weights model complain that it knows nothing about events after its training data's cutoff. Which change is within a serving team's reach and addresses the complaint?",
    "choices": [
      "Raising --max-model-len to the full trained context so more knowledge is available",
      "Switching to a newer FP8 copy of the same model, which a mirror uploaded this year",
      "Putting the relevant current documents into the prompt at request time (retrieval)",
      "Lowering the temperature so the model guesses less about events it has not seen"
    ],
    "answer": 2,
    "explain": "What a model knows is frozen in its weights at its training cutoff. A quantized copy has the same cutoff whatever its upload date; a longer context admits longer prompts but adds no knowledge; temperature changes how tokens are drawn, not what the model knows. Only new input at request time — retrieval — brings in newer facts without training."
  },
  {
    "q": "Twelve departments each want the same 70B base model adapted to their own writing style. Roughly how much weight memory must be resident to serve all twelve: twelve full fine-tunes, or one base plus twelve LoRA adapters?",
    "choices": [
      "About 140 GB either way, since fine-tuning never changes a model's size",
      "About 1.7 TB either way, because each adapter is a full copy of the weights",
      "About 1.7 TB for twelve fine-tunes; about 140 GB plus twelve small add-ons",
      "About 12 GB for the adapters alone, as they replace the base weights entirely"
    ],
    "answer": 2,
    "explain": "Each full fine-tune is a separate 140 GB set of weights: 12 × 140 ≈ 1.7 TB. A LoRA adapter is a small set of extra numbers trained next to frozen weights, so one base in memory plus twelve small files serves all twelve. The first choice is true of one fine-tune, but twelve different ones are twelve copies."
  }
]
```
