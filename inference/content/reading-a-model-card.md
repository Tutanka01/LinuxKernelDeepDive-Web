# Reading a Model Card

> **The question:** given a model's page on a hub, what can you tell — before
> running anything — about whether you can serve it, on what, and what it will
> cost you?
>
> **You'll be able to:** decode a model's name and repository into serving facts
> (precision, total and active parameters, template, default sampling); turn a
> card's four numbers into a first estimate of memory, hardware and arithmetic;
> read a licence and a `generation_config.json` for what they impose without
> asking; say what a card cannot tell you, and how you would find out.

A colleague forwards a link: Kimi-K3, "the world's first open 3T-class model",
with a 1-million-token context. "Could we run this instead?" The card answers
before you open a terminal. Its summary table gives 2.8T total parameters and
104B activated per token; the Hub's file listing gives 96 weight shards totalling
1,561 GB, stored in a 4-bit format the model was trained for. Halden's node has
320 GB of GPU memory. No — known in a minute, without downloading a byte. This
chapter is that minute, done carefully.

## Open weights, and the distinctions that last

An **open-weights** model is one whose files you can download and run on your own
hardware, within its licence; an **API-only** model runs only on its vendor's
servers. Open weights is not open source: you get the numbers and the
configuration, rarely the training data or code. A serving engineer cares about
both: the open model is what you deploy, the API is the price and quality you are
compared against — Ask Halden's hosted alternative would cost ~$4,600 a month at
phase-1 volume, and only Legal's data rule rules it out.

Leaderboards reshuffle every month. These distinctions do not:

- Total parameters decide memory: every weight sits in GPU memory whether or
  not a token uses it.
- Dense or mixture-of-experts. In a dense model every weight takes part in
  every token. A **mixture-of-experts (MoE)** model splits most of each layer into
  many parallel blocks called experts, and a small learned router sends each token
  through a few. **Active parameters** are the ones one token uses. Total sets
  the memory, active the arithmetic per token; [Serving MoE at
  Scale](#/moe-serving) covers what happens under load.
- Context length: the longest sequence the model was trained or extended to
  handle — a maximum; each request's KV cache grows with its own length.
- Reasoning or not, and whether thinking can be switched off per request.
- Inputs: text only, or also images, audio and video through an extra encoder
  network ([Beyond Chat](#/beyond-chat)).

> **State of play (November 2026):** a sample of open-weights models, read from
> their Hugging Face repositories on 2026-11-21. "On the Hub" is the repository's
> creation month from the Hub API; a public release can follow it by weeks.
>
> | Repository | On the Hub | Total / active | Context | Licence |
> |---|---|---|---|---|
> | meta-llama/Llama-3.3-70B-Instruct | Dec 2024 | 70B, dense | 128K | Llama 3.3 Community |
> | openai/gpt-oss-120b | Aug 2025 | 117B / 5.1B | 131,072 | Apache-2.0 |
> | google/gemma-4-31B-it | Mar 2026 | 30.7B, dense | 256K | Apache-2.0 |
> | google/gemma-4-26B-A4B-it | Mar 2026 | 25.2B / 3.8B | 256K | Apache-2.0 |
> | moonshotai/Kimi-K3 | Jun 2026 | 2.8T / 104B | 1M | Kimi K3 (modified MIT) |
> | LGAI-EXAONE/K-EXAONE-2.0-750B-A37B | Jul 2026 | 750B / 37B | 262,144 | Apache-2.0 |
> | Qwen/Qwen3.8-27B | Aug 2026 | 27B, dense | 262,144 | Apache-2.0 |
> | deepseek-ai/DeepSeek-V4-Pro-0813 | Aug 2026 | 1.6T / 49B | 1M | MIT |
> | mistralai/Mistral-Large-4-1T-A52B | Sep 2026 | ~1T / 49B (52B with embeddings) | 1M | Mistral Ecosystem (modified MIT) |
>
> In this sample every model above 100B parameters is an MoE, and more than half
> accept images as well as text. Meta's Hub account shows no new Llama since
> Llama 4 (April 2025).

## Decoding a name

A repository name is a compressed card. Read `Llama-3.3-70B-Instruct` left to
right: family, version, total size, and the training stage — `Instruct` is the
chat-tuned model; the same name without it (`Llama-3.1-70B`) is usually the base
model. Other parts you will meet:

| Part | Meaning | Example |
|---|---|---|
| `-it` | instruction-tuned (Google's spelling of `Instruct`) | `gemma-4-31B-it` |
| `-Base` | pretrained only | `NVIDIA-Nemotron-3-Super-120B-A12B-Base-BF16` |
| `-A4B`, `-A37B` | active parameters of an MoE | `gemma-4-26B-A4B-it`, `K-EXAONE-2.0-750B-A37B` |
| `E4B` | "effective" size (Google's per-layer embeddings) | `gemma-4-E4B-it` |
| `-FP8`, `-NVFP4`, `-FP8-dynamic` | a quantized copy, and how it was made | `Qwen3.8-27B-FP8`, `Llama-3.3-70B-Instruct-FP8-dynamic` |
| `-GGUF` and `:Q4_K_M` | llama.cpp's single-file format, and which quantization in it | `Llama-3.2-3B-Instruct-GGUF:Q4_K_M` |
| `-Flash` | the vendor's smaller, faster sibling; no fixed size | `DeepSeek-V4-Flash` (284B / 13B against Pro's 1.6T / 49B) |
| `-0813`, `-03-2025` | a dated snapshot of the same model line | `DeepSeek-V4-Pro-0813` |

Gemma's card defines its `A`: it "stands for 'active parameters' in contrast to
the total number of parameters the model contains". llama.cpp's server takes
`-hf <user>/<model>[:quant]`, the tag defaulting to `Q4_K_M` (README, build
b12608).

Names are conventions; the files are the contract. Mistral Large 4's name says
52B active, its card "49 billion active parameters per token (52 billion
including embeddings and output layers)". `-FP8-dynamic` becomes precise only in
the `quantization_config` of RedHatAI's FP8 copy of Llama 3.3:

```json
  "quantization_config": {
    "config_groups": {
      "group_0": {
        "input_activations": {
          "dynamic": true,
          "num_bits": 8,
          "strategy": "token",
          "type": "float"
          …
        },
        "weights": {
          "dynamic": false,
          "num_bits": 8,
          "strategy": "channel",
          "type": "float"
          …
        }
      }
    },
    "format": "float-quantized",
    "ignore": [
      "lm_head"
    ],
    "quant_method": "compressed-tensors",
```

*Verbatim — trimmed; `config.json` of RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic on Hugging Face, checked 2026-11-21.*

Weights in 8-bit floating point with one scale per output channel, fixed in the
file; activations quantized per token at run time ("dynamic"); the final
`lm_head` matrix left in BF16 — one reason the files total 72.7 GB, not 70.6.
[Quantization](#/quantization) explains each choice.

## What is in the repository, file by file

Here is the repository the case's model comes from, listed through the Hub API:

```plaintext
$ curl -s 'https://huggingface.co/api/models/RedHatAI/Llama-3.3-70B-Instruct?blobs=true' \
    | jq -r '.siblings[] | "\(.size)\t\(.rfilename)"' | awk -F'\t' '{printf "%15s  %s\n", $1, $2}'
           1570  .gitattributes
           7909  LICENSE
            148  NOTICE file Llama 3.3 Attribution
          28475  README.md
           6021  USE_POLICY.md
            879  config.json
            189  generation_config.json
     4584408808  model-00001-of-00030.safetensors
     4664167376  model-00002-of-00030.safetensors
…
     2101346432  model-00030-of-00030.safetensors
          59615  model.safetensors.index.json
            433  original/README.md
    17640971024  original/consolidated.00.pth
…
    17640971024  original/consolidated.07.pth
            221  original/params.json
        2183982  original/tokenizer.model
             68  special_tokens_map.json
       17209920  tokenizer.json
          55425  tokenizer_config.json
```

*Verbatim — trimmed (shards 3–29, consolidated.01–06 and two small files of `original/` cut); Hub API listing of RedHatAI/Llama-3.3-70B-Instruct, a public mirror of the gated meta-llama repository, revision 3cbf1bcb, run 2026-11-21.*

- `README.md` is the card; `LICENSE`, `USE_POLICY.md` and `NOTICE` are the
  legal terms.
- `config.json` describes the architecture; [Inside a Forward
  Pass](#/inside-a-forward-pass) derives size and KV cache from it. For quantized
  weights its `quantization_config`, not `torch_dtype`, says how they are stored.
- The 30 `model-*.safetensors` shards are the numbers, 141 GB;
  `model.safetensors.index.json` maps each tensor to its shard.
- `original/` holds the same weights again, 8 × 17.6 GB, in Meta's own format.
  A safetensors engine never reads it; download it and you fetch 282 GB to use 141.
- `tokenizer.json` (17 MB) is the vocabulary and the rules that split text into
  it; `tokenizer_config.json` names the special tokens and holds the chat
  template.
- `generation_config.json` holds default sampling settings and stop tokens.

Other repositories carry more. gpt-oss ships its template as a separate
`chat_template.jinja`. DeepSeek-V4-Pro-0813 "does not include a Jinja-format chat
template" and provides Python encoding scripts instead. Nemotron 3 Super's
repository includes `modeling_nemotron_h.py` and a reasoning-parser plugin:
Python that the engine runs when you pass `--trust-remote-code` — code you
deploy, and should review.

### The template, and what it says about tools

Llama 3.3's `tokenizer_config.json` keeps the template as one long string. A few
of its lines decide things a serving engineer must know:

```plaintext
{%- if not tools_in_user_message is defined %}
    {%- set tools_in_user_message = true %}
{%- endif %}
{%- if not date_string is defined %}
    {%- set date_string = "26 Jul 2024" %}
{%- endif %}
…
    {%- elif 'tool_calls' in message %}
        {%- if not message.tool_calls|length == 1 %}
            {{- raise_exception("This model only supports single tool-calls at once!") }}
        {%- endif %}
```

*Verbatim — trimmed; the `chat_template` value in `tokenizer_config.json` of RedHatAI/Llama-3.3-70B-Instruct (revision 3cbf1bcb), newlines unescaped.*

The model supports tool calling, with tool definitions placed in the first user
message by default. It takes one tool call per assistant turn: a conversation
history holding two calls in one turn is rejected when the template is rendered,
and vLLM v0.34 maps the template error to a 400. And unless the caller passes a
date, the model is told it is 26 July 2024.

### `generation_config.json`: defaults nobody asked for

```json
{
  "bos_token_id": 128000,
  "do_sample": true,
  "eos_token_id": [
    128001,
    128008,
    128009
  ],
  "temperature": 0.6,
  "top_p": 0.9,
  "transformers_version": "4.47.0.dev0"
}
```

*Verbatim — `generation_config.json` of RedHatAI/Llama-3.3-70B-Instruct (revision 3cbf1bcb); identical in unsloth's copy of the original upload, checked 2026-11-21.*

These are the settings Meta recommends sampling with. vLLM v0.34 applies them to
every request that does not set its own (`--generation-config` defaults to
`auto`; the request handler's comment reads "Priority: user -> server default ->
OpenAI default"), and says so once, at startup:

```plaintext
WARNING … Default vLLM sampling parameters have been overridden by the model's `generation_config.json`: `{'temperature': 0.6, 'top_p': 0.9}`. If this is not intended, please relaunch vLLM instance with `--generation-config vllm`.
```

*Real format, illustrative values — message from vLLM v0.34.0 `vllm/config/model.py` (`get_diff_sampling_param`); the dictionary is what that code builds from the file above, not captured from a running server; logger prefix trimmed.*

Another engine, or the same engine with another flag, may use its own defaults
instead (vLLM's own are temperature 1.0, top-p 1.0). The model, the prompt and
the client are unchanged, and the answers are not.

## Four numbers in a minute

Four numbers on a card decide most of what you need before running anything.

1. **Total parameters × bytes per parameter = memory for weights.** 70B × 2
   bytes = 140 GB in BF16.
2. **Context length bounds the KV cache of one request.** The cache grows with
   every token of the request; the next chapter derives how many bytes each token
   costs for a given config.
3. **Active parameters set the arithmetic per token**: about 2 × active
   floating-point operations (FLOPs) per token.
4. **The licence** decides whether you may use the model at all.

> [!predict] Before you read on
> gemma-4-26B-A4B-it has 25.2B parameters, 3.8B of them active per token. Is the
> GPU memory its weights need closer to that of a 4B model or a 26B model? And
> its arithmetic per token?

Memory follows the total: every expert must be resident, because the next token
may be routed to any of them. Arithmetic follows the active count. Run the first
and third numbers for a few real repositories:

```python
import math

# (repo, total parameters, active parameters, bytes per parameter as shipped)
# Totals: the Hub API's safetensors count for each repo (vision encoders included).
models = [
    ("meta-llama/Llama-3.3-70B-Instruct",         70_553_706_496,  70.6e9, 2),
    ("Qwen/Qwen3.8-27B",                          27_781_427_952,  27.8e9, 2),
    ("google/gemma-4-31B-it",                     31_273_088_876,  31.3e9, 2),
    ("google/gemma-4-26B-A4B-it",                 25_805_936_206,   3.8e9, 2),
    ("LGAI-EXAONE/K-EXAONE-2.0-750B-A37B",        749_357_484_800, 37.0e9, 2),
    ("LGAI-EXAONE/K-EXAONE-2.0-750B-A37B-FP8",    749_357_484_800, 37.0e9, 1),
]
GPU_GB = 80

print(f"{'repo':42} {'weights':>10} {'80GB GPUs':>9} {'GFLOP/token':>11}")
for repo, total, active, nbytes in models:
    gb = total * nbytes / 1e9
    gpus = math.ceil(gb / GPU_GB)          # weights alone: no KV, no overhead
    print(f"{repo:42} {gb:7,.0f} GB {gpus:>9} {2 * active / 1e9:>11,.0f}")

# --- output of an actual run ---
# repo                                          weights 80GB GPUs GFLOP/token
# meta-llama/Llama-3.3-70B-Instruct              141 GB         2         141
# Qwen/Qwen3.8-27B                                56 GB         1          56
# google/gemma-4-31B-it                           63 GB         1          63
# google/gemma-4-26B-A4B-it                       52 GB         1           8
# LGAI-EXAONE/K-EXAONE-2.0-750B-A37B           1,499 GB        19          74
# LGAI-EXAONE/K-EXAONE-2.0-750B-A37B-FP8         749 GB        10          74
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run. Parameter totals from the Hub API (`safetensors.total`) on 2026-11-21; active counts from each card; the FP8 row reuses the BF16 total at one byte (that repository's files total 752 GB).*

Read the GPU column as a floor, never a plan. It says Llama 3.3 fits on two
GPUs; the case needs four, because a server also needs room for the KV cache,
activations and buffers — [Inside a Forward Pass](#/inside-a-forward-pass) finds
two GPUs 4 GB short. The Gemma rows are the dense-versus-MoE trade: nearly the
same memory, an eighth of the arithmetic. The EXAONE rows show why large MoE
models ship quantized: in BF16 the weights alone overflow two eight-GPU servers.

> [!predict] Before you read on
> Llama 3.3's KV cache costs about a third of a megabyte per token, as
> [What Actually Happens When You Call an LLM](#/what-is-inference) said. One request that uses the whole 131,072-token context: is
> its cache smaller or larger than one GPU's 35 GB share of the weights on the
> case's node?

Larger: 131,072 × 327,680 bytes ≈ 43 GB, for one conversation. A context length
is a promise the model can handle that much, not an allowance you can give every
request. The admission limit (`--max-model-len`) is yours to set, and the
card's number is its ceiling.

## Licences, read rather than assumed

The card's licence tag is a pointer. The terms are in the files, and they
differ in ways that matter to a company serving a model:

| Licence | Read on | Commercial use | What can bite |
|---|---|---|---|
| Apache-2.0 / MIT | Qwen3.8-27B, Gemma 4, gpt-oss, K-EXAONE 2.0 / DeepSeek-V4 | yes | little; gpt-oss adds a usage policy asking you to comply with applicable law |
| Llama 3.3 Community | Llama-3.3-70B-Instruct | yes | above 700M monthly users on the release date you need Meta's permission; the Acceptable Use Policy applies to all use; "Built with Llama" when you distribute it or a product containing it; a model trained on its outputs and distributed must be named "Llama…" |
| Modified MIT with a "Model as a Service" clause | Kimi K3, Mistral Large 4 | yes | selling third parties inference they control needs a separate licence: Mistral for any such business, Moonshot above $20M revenue in 12 months; Kimi K3 must be displayed above 100M monthly users or $20M monthly revenue; internal use is exempt in both |
| NVIDIA Nemotron Open Model | Nemotron 3 | yes | attribution notice when you redistribute; the licence ends if you sue claiming the model infringes |
| CC-BY-NC-4.0 | CohereLabs Command A (111B, 256K) | no | the download form asks you to agree to "non-commercial use ONLY" |

This is not legal advice, and a summary is not the licence. Open `LICENSE` and
the use policy before the first capacity estimate: a licence can end a project
that every number says yes to.

## What a card does not tell you

- **Quality on your task.** A card's benchmarks are chosen and run by the vendor,
  with its own harness and settings; Kimi K3's notes, for one, describe
  compacting context at 300K tokens for one benchmark. Only your evaluation set
  measures your task — [Did Quantization Break Your
  Model?](#/did-quantization-break-your-model) builds one.
- **Speed on your hardware.** Bytes and FLOPs per token are a start; the next
  four chapters do the rest.
- **Behaviour under your interface.** Whether your engine version supports the
  architecture, template, tool-call and reasoning formats; a card's launch line
  was tested on the engine version it names.

> [!case] The case: why Llama-3.3-70B, and when to ask again
> Halden approved `Llama-3.3-70B-Instruct` (card dated 6 December 2024) on four
> facts read from its repository:
>
> - **Licence:** the Llama 3.3 Community Licence allows commercial use; the
>   700M-user clause cannot apply to a 2,000-person company; the Acceptable Use
>   Policy applies, and Legal recorded the attribution duties in case Ask Halden
>   is ever offered outside the company.
> - **Context:** 128K, against 3,250 tokens per phase-1 request and 20K for
>   phase 2's longest agent call.
> - **Size:** dense 70B, 140 GB in BF16 — the four-GPU node with a 132 GB KV pool.
> - **Tools:** JSON tool calls in its template, one call per turn — what phase 2's
>   agent does, one model call per step.
>
> **The stake.** By November 2026 newer open models fit the node more easily:
> Qwen3.8-27B (Apache-2.0, 56 GB in BF16, one GPU per replica, 262K context,
> thinking on by default) and gemma-4-26B-A4B-it (Apache-2.0, 3.8B active), with
> higher scores on their vendors' chosen benchmarks. The course keeps the 2024
> model on purpose: dense, plain grouped-query attention, every number public and
> derivable by hand. For Halden, reopening the choice needs evidence, not a newer
> date: (1) the
> 1,500-question evaluation from [Did Quantization Break Your
> Model?](#/did-quantization-break-your-model), run on the candidate with its
> own template and with thinking off and on, since thinking multiplies decode
> steps; (2) the course's arithmetic on its `config.json` — weights, cache per
> request, active parameters; (3) a [load test](#/load-testing) at Halden's traffic shape.
> [Frontier](#/frontier) returns to this list.

## Exercises

<div class="exercise">

**Exercise 1 — transfer.** Read this card excerpt and its recommended launch
line, for a model this chapter did not work:

```plaintext
| **Total Parameters** | 120B (12B active) |
| **Architecture** | LatentMoE - Mamba-2 + MoE + Attention hybrid with Multi-Token Prediction (MTP) |
| **Context Length** | Up to 1M tokens |
| **Minimum GPU Requirement** | 8× H100-80GB |
…
| **License** | [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) |
| **Release Date** | March 11, 2026 |
```

*Verbatim — trimmed; "Model Summary" table of the model card (`README.md`) of nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16 on Hugging Face (revision 2dc98e2a), checked 2026-11-21. The Hub API counts 123,611,012,096 parameters in its BF16 files.*

```bash
pip install vllm==0.18.1
…
vllm serve $MODEL_CKPT \
  --served-model-name nvidia/nemotron-3-super \
  --kv-cache-dtype fp8 \
  --tensor-parallel-size 8 \
  --max-model-len 262144 \
  --trust-remote-code \
  --gpu-memory-utilization 0.9 \
  --mamba-ssm-cache-dtype float32 \
  --reasoning-parser nemotron_v3 \
  …
```

*Verbatim — trimmed; the vLLM launch line from the same card (its "Quick Start" section).*

(a) How much memory do the weights need, and why does the card ask for eight
H100s when four would hold them? (b) Arithmetic per token against Llama 3.3?
(c) Could Halden's node run it in BF16? (d) Name three things in the launch line
you would check before trusting it. (e) May Halden use it internally?

<details>
<summary>Reveal answer</summary>

(a) 123.6 × 10⁹ × 2 bytes ≈ 247 GB (the files total 247.2 GB). Four GPUs hold
320 GB, but at the card's own 0.9 budget that is 288 GB, leaving ~41 GB across
four GPUs for activations, buffers and every request's cache at contexts up to
262,144 tokens. Eight GPUs give 576 − 247 ≈ 330 GB of room.

(b) ~2 × 12 × 10⁹ = 24 GFLOPs per token, about a sixth of Llama's 140 — while
memory follows the full 120B.

(c) Not usefully: the weights fill the budget and leave almost nothing for the
cache. The card points single-B200 users to an NVFP4 checkpoint; whether that
format runs on H100s is a question for the engine's documentation.

(d) The engine version: the line was tested on vLLM 0.18.1, the course pins
v0.34. `--trust-remote-code`: the repository's Python files will run in your
server. `--mamba-ssm-cache-dtype` and the architecture row: a hybrid with Mamba-2
layers keeps fixed-size state per sequence, so the simple KV-per-token formula of
the next chapter does not apply as is. (Also: `--max-model-len 262144`, an
admission limit you would set for your own traffic.)

(e) The licence says the works "are commercially usable", with no user or
revenue thresholds; attribution applies when redistributing. Internal use is
allowed — after Legal reads the text.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** Ask Halden's test environment moves to a shared
deployment template. Testers report that answers "wander" and twice cited a
section number that does not exist. No error anywhere; same model, same prompts.
The application sends no sampling fields. Here is the change and the first
startup line of each version:

```diff
 vllm serve meta-llama/Llama-3.3-70B-Instruct \
   --tensor-parallel-size 4 \
   --max-model-len 16384 \
   --gpu-memory-utilization 0.90 \
   --max-num-seqs 64 \
-  --max-num-batched-tokens 512
+  --max-num-batched-tokens 512 \
+  --generation-config vllm
```

*Real format, illustrative values — flag names from vLLM v0.34.0 `vllm/engine/arg_utils.py`; the launch line is the case's from [Anatomy of a Serving Engine](#/anatomy-of-an-engine), the added flag invented for this exercise.*

```plaintext
before: WARNING … Default vLLM sampling parameters have been overridden by the model's `generation_config.json`: `{'temperature': 0.6, 'top_p': 0.9}`. If this is not intended, please relaunch vLLM instance with `--generation-config vllm`.
after:  (no such line)
```

*Real format, illustrative values — message from vLLM v0.34.0 `vllm/config/model.py` (`get_diff_sampling_param`); log excerpts constructed for this exercise, not captured.*

What changed for every request, and what is the durable fix?

<details>
<summary>Reveal answer</summary>

Before, vLLM applied the model's own defaults to requests that set nothing:
temperature 0.6, top-p 0.9. `--generation-config vllm` tells it to ignore the
file, so requests fall through to vLLM's neutral defaults, temperature 1.0 and
top-p 1.0: a flatter distribution with no tail cut, so low-probability tokens —
an invented section number — are drawn more often. The missing warning is the
evidence.

Removing the flag restores the old behaviour; the durable fix is in the
application: send `temperature` and `top_p` with every request, so behaviour no
longer depends on an engine's defaults or flags, and evaluate at those settings.

</details>

</div>

<div class="exercise">

**Exercise 3 — find the flaw.** A colleague drafts a procurement note for a
future ticketing agent. Find the errors before opening the answer.

```text
Procurement note: Mistral-Large-4-1T-A52B (draft)
1. Only ~52B parameters are active per token, so the weights need
   about 52 × 2 = 104 GB in BF16: two of our H100s.
2. Arithmetic per token is about that of a 52B dense model,
   ~100 GFLOPs.
3. config.json says "torch_dtype": "bfloat16", so the download is
   1T × 2 bytes ≈ 2 TB.
4. It supports a 1M-token context, so agents can paste entire
   manuals into every prompt at no extra cost.
5. The licence is a modified MIT licence, so it has no conditions.
```

<details>
<summary>Reveal answer</summary>

1. **Wrong.** Memory follows the total, ~1T: every expert stays resident. The
   repository's files total 1,061 GB, at least 14 H100s for weights alone.
2. **Right**, within rounding: ~2 × 49–52B ≈ 100 GFLOPs per token.
3. **Wrong.** The same `config.json` has a `quantization_config` with
   `"quant_method": "fp8"` and 128 × 128 weight blocks; the files are 1,061 GB,
   about one byte per parameter. `torch_dtype` describes what is not quantized.
4. **Wrong.** The context length is a ceiling. Every token of a prompt is
   prefill arithmetic and KV memory, for every request that carries it.
5. **Wrong.** Any "Model as a Service" business — third parties sending their own
   inputs — needs a separate commercial licence from Mistral; internal use is
   exempt. Read section 2 of the `LICENSE`.

</details>

</div>

## What to remember

- Total parameters × bytes per parameter is the memory floor for weights; active
  parameters set the arithmetic per token; an MoE's memory is that of its total.
- A context length is a ceiling, not an allowance: one 128K request of Llama 3.3
  holds ~43 GB of cache.
- Names are conventions; `config.json` (with its `quantization_config`), the
  file sizes and the `LICENSE` are the contract.
- The chat template lives in `tokenizer_config.json`, a `chat_template.jinja`
  or, for some models, the vendor's code; it fixes the tool-call format too.
- `generation_config.json` sets the sampling of every request that does not set
  its own; send explicit sampling settings from the application.
- A card cannot tell you quality on your task, speed on your hardware or support
  in your engine version; each needs a measurement.

```quiz
[
  {
    "q": "A GGUF repository offers a 3.2B-parameter model as Q4_K_M (2.02 GB) and f16 (6.43 GB). About how many bits per parameter does the Q4_K_M file spend on average?",
    "choices": [
      "Exactly 4, as the Q4 in the tag promises for every tensor",
      "About 2.5, since the file is a third of the f16 version's size",
      "About 8, because GGUF keeps an f16 copy next to the 4-bit one",
      "About 5: 2.02 × 10⁹ bytes × 8 bits ÷ 3.2 × 10⁹ parameters"
    ],
    "answer": 3,
    "explain": "2.02e9 × 8 / 3.2e9 ≈ 5.0 bits per parameter. Q4_K_M mixes 4-bit blocks with per-block scales and keeps some tensors at higher precision, so the average is above 4. The 'a third of f16' choice forgets that f16 is 16 bits: a third of 16 is about 5.3, not 2.5."
  },
  {
    "q": "CohereLabs' Command A card says the model supports 256K tokens of context but is configured in its Hugging Face config for 128K. You launch vLLM v0.34 without --max-model-len. What context will the server admit?",
    "choices": [
      "256K, because the card is the authoritative statement of the model's limit",
      "128K, because vLLM derives its default limit from the repository's config",
      "Unlimited, because a context length is only a recommendation to the client",
      "Whatever fits in the KV pool, because vLLM sizes the limit from free memory"
    ],
    "answer": 1,
    "explain": "With no --max-model-len, vLLM takes the limit from the model's config (max_position_embeddings and related fields), not from prose on the card. Going to 256K means overriding the config — and then checking quality at that length yourself. The KV pool decides how many requests fit, not how long one may be."
  },
  {
    "q": "Your company wants to sell API access to Mistral-Large-4-1T-A52B: customers send their own prompts and sampling parameters to your endpoint. Under the Mistral Ecosystem Open-Weight License, what applies?",
    "choices": [
      "You need a separate commercial licence from Mistral before such commercial use",
      "Nothing beyond MIT, since it is a modified MIT licence that keeps the notice",
      "You need a licence only once that business earns over $20M in a 12-month period",
      "Such use is forbidden outright; the weights may be used for research only"
    ],
    "answer": 0,
    "explain": "Section 2 of the licence: a licensee operating a Model-as-a-Service business must enter into a separate commercial licence with Mistral, with no revenue threshold; internal use is exempt. The $20M threshold is Kimi K3's clause, a different licence — the reason to read each one rather than assume."
  },
  {
    "q": "A model's repository contains modeling_*.py and a reasoning-parser .py file, and the card's launch line includes --trust-remote-code. What does that flag mean for your deployment?",
    "choices": [
      "It lets vLLM skip verifying the safetensors checksums so large models load faster",
      "It grants the model network access so its tools can reach remote services",
      "The engine imports and runs the repository's Python code inside your server",
      "It allows the engine to download newer weights automatically at startup"
    ],
    "answer": 2,
    "explain": "The flag allows the engine to execute Python shipped in the model repository (custom architectures, parsers). That code runs with your server's privileges, so pin the revision and review it like any dependency. It has nothing to do with checksums, network tools or automatic weight updates."
  },
  {
    "q": "DeepSeek-V4-Pro-0813's card says the release does not include a Jinja-format chat template and provides Python encoding scripts instead. What does that imply for serving it behind an OpenAI-compatible chat endpoint?",
    "choices": [
      "Nothing: every engine falls back to a generic template that the model accepts",
      "The model can only be served through the completion endpoint, never through chat",
      "The engine must implement or call that encoding to turn messages into the right tokens",
      "The weights must first be converted to GGUF, because GGUF files always embed a usable template"
    ],
    "answer": 2,
    "explain": "Messages must become exactly the token layout the model was trained on. Without a Jinja template, the engine needs model-specific support (or the vendor's encoder in front of it). A generic fallback would produce a format the model never saw — silently worse output, or the chat endpoint refusing the request."
  }
]
```
