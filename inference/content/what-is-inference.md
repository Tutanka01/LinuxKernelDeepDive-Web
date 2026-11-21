# What Actually Happens When You Call an LLM

> **The question:** between pressing Enter and seeing words appear, what does
> the machine actually do — and why is doing it for thousands of people at
> once an engineering problem rather than a solved one?
>
> **You'll be able to:** explain an LLM as a next-token function run in a
> loop; tell prefill from decode and say which one a user is complaining
> about; estimate a request's size in tokens and its time; read a streamed
> response and a latency SLO the way a serving engineer does.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="client,api,runner"></div>

You type "Explain how a rainbow forms" into a chat box and press Enter. Nothing
happens for about half a second. Then words appear, a few characters at a time,
at roughly reading speed, as if someone on the other end were typing.

The pause and the typing rhythm are not a user-interface choice. They are the
two halves of the computation, showing through the screen. By the end of this
chapter you will be able to look at any chat interface — or at the raw stream
behind it — and say which part of the machine you are watching.

## An LLM is a function that scores the next token

A large language model (**LLM**) is one mathematical function with tens or
hundreds of billions of tunable numbers inside it, called **parameters** or
**weights**. You give it text. It gives you back, for every possible next piece
of text, a score: how likely that piece is to come next.

Given "The capital of France is", it scores " Paris" high, " banana" low, and
every other option somewhere in between. It does not look anything up and it
does not plan the sentence. It scores one next step. The reason this produces
essays and working code is that its weights were tuned, during **training**, on
a large fraction of the text people have written — and that every longer output
is this one operation repeated. How that tuning is done, and what you download
when you download a model, is the subject of
[Where a Model Comes From](#/where-models-come-from).

**Inference** is the industry's word for *using* a trained model: running the
function to produce output. Training happens once per model, in a lab.
Inference happens every time anyone sends a prompt, billions of times a day,
and its bill never stops arriving. This course is entirely about inference.

## Tokens: what the model reads and writes

The model does not work in words. It works in **tokens**: chunks of text, usually
a few characters long. Common words are one token. Rare words are split into
pieces. A leading space is usually part of the token that follows it.

```text
  "Tokenization feels unintuitive at first."

  Token │ ization │  feels │  un │ intuit │ ive │  at │  first │ .

  (illustrative — every model family has its own tokenizer, and the
   exact boundaries differ, but the pattern is always like this)
```

The model has a fixed **vocabulary** of these pieces — Llama 3's has 128,256 —
which can spell anything by combining them. **Tokenization** turns your text
into a list of token numbers; the reverse step turns output numbers into text.

A rule of thumb you will use constantly: one token ≈ 4 characters of English ≈
¾ of a word. A thousand words is about 1,300 tokens. Code, JSON and most other
languages take more tokens per word, so treat the rule as a floor for them.
Every price, speed and memory figure in this field is quoted per token.

## What the model actually reads

A chat request is a list of messages; the server turns it into one token
sequence using the model's **chat template**, which ships with the model. Here
is what Llama-3.3-70B-Instruct receives for a system and a user message. Look
for the special tokens in `<|…|>` and for text nobody typed.

```plaintext
<|begin_of_text|><|start_header_id|>system<|end_header_id|>

Cutting Knowledge Date: December 2023
Today Date: 26 Jul 2024

You are Ask Halden, the internal assistant of Halden. Answer only from the
documents provided. … (rules, ~800 tokens, identical for every request)<|eot_id|><|start_header_id|>user<|end_header_id|>

Documents:
[1] Warehouse safety policy, section 4.2 … (~2,000 tokens retrieved for this question)

Question: Which forklift licence do new warehouse staff need?<|eot_id|><|start_header_id|>assistant<|end_header_id|>

```

*Real format, illustrative values — structure produced by the `chat_template` in Llama-3.3-70B-Instruct's `tokenizer_config.json` (identical in the public RedHatAI and unsloth mirrors of the gated repo, checked 2026-11-21), rendered by hand; the message text is invented.*

"Today Date: 26 Jul 2024" is hard-coded in the template: unless the caller
passes a `date_string`, the model is told it is July 2024 forever. The sequence
ends with an *open* assistant header, and the model's job is to continue from
there until it produces `<|eot_id|>` (token 128,009), one of three end IDs in
the model's `generation_config.json`. Everything above the user header is
identical for every Ask Halden request — remember that for the cache section.
[Reading a Model Card](#/reading-a-model-card) shows where a template lives and
what it says about tools; [Where a Model Comes From](#/where-models-come-from),
why the wrong one silently degrades answers.

## From scores to one token: logits, softmax, sampling

The model's raw output is one score per vocabulary entry, called a **logit**:
128,256 numbers for Llama 3, where only the order and the gaps mean anything.
**Softmax** turns them into probabilities: exponentiate each, divide by the
total. Because of the exponential, a slightly higher logit gets a lot more of
the probability.

**Sampling** picks one token from that distribution. Always taking the most
likely one (**greedy** decoding) is deterministic. Most products draw at random
instead, after dividing the logits by a **temperature**: below 1 sharpens the
distribution, above 1 flattens it. On three candidate tokens:

```python
import math

logits = {" Paris": 3.0, " Lyon": 2.0, " banana": 0.0}

def softmax(scores, temperature):
    exps = {t: math.exp(s / temperature) for t, s in scores.items()}
    total = sum(exps.values())
    return {t: e / total for t, e in exps.items()}

print("temperature   " + "".join(f"{t:>9}" for t in logits))
for T in (0.5, 1.0, 2.0):
    p = softmax(logits, T)
    print(f"T = {T:<9}" + "".join(f"{p[t]:9.3f}" for t in logits))

# --- output of an actual run ---
# temperature       Paris     Lyon   banana
# T = 0.5          0.879    0.119    0.002
# T = 1.0          0.705    0.259    0.035
# T = 2.0          0.547    0.331    0.122
```

*Runnable — Python 3 standard library only; the output shown in the comments is from an actual run.*

Read the last column: " banana" goes from 1 draw in 500 at T = 0.5 to 1 in 8 at
T = 2. Two more knobs cut that tail off. **Top-k** keeps only the k most likely
tokens and renormalises. **Top-p** keeps the smallest set of top tokens whose
probabilities add up to at least p; at T = 1 with p = 0.9, " Paris" and " Lyon"
(0.964 together) survive and " banana" can never be drawn. Llama-3.3's
`generation_config.json` sets temperature 0.6 and top-p 0.9, and vLLM v0.34 uses
a model's generation config as the default for requests that do not set them.

## The loop: one token per pass

The model produces one token per run. To write a paragraph, the serving system
runs it again for every token, appending each output to the input before the
next run. This is **autoregressive** generation.

```text
  input: "The capital of France is"            → run → " Paris"
  input: "The capital of France is Paris"      → run → ","
  input: "The capital of France is Paris,"     → run → " a"
  … until the model emits an end token such as <|eot_id|>,
    or the request's max_tokens is reached
```

Generation is therefore sequential within one response. Token 10 cannot be
computed before token 9 exists, because token 9 is part of its input. Faster
hardware makes each step shorter; nothing makes the steps overlap — except the
trick in [Speculative Decoding](#/speculative-decoding).

## Two phases: prefill and decode

Look at the first run of the loop. Before the model can write anything, it has to
process your whole prompt. All the prompt's tokens already exist, so they can be
fed through the model together, in one pass. This phase is **prefill**.

Every run after that adds exactly one token. This phase is **decode**: one token
per pass, strictly in order.

```text
   PREFILL                          DECODE
   the whole prompt, one pass       one token per pass
   ┌───────────────────────┐        ┌──┐ ┌──┐ ┌──┐ ┌──┐
   │ all prompt tokens     │  then  │t1│→│t2│→│t3│→│t4│→ …
   └───────────────────────┘        └──┘ └──┘ └──┘ └──┘
```

> [!predict] Before you read on
> A request has a 3,000-token prompt and a 250-token answer. On the same
> hardware, which takes longer in total: prefill (reading 3,000 tokens) or decode
> (writing 250)? Commit to a guess, and a rough ratio.

Decode, by a wide margin. On the hardware this course uses as its running
example, prefilling 3,000 tokens takes about a quarter of a second, while 250
decode steps at roughly 14 ms each take about 3.5 seconds — more than ten times
longer for twelve times fewer tokens. You will derive both numbers yourself in
[Inference Arithmetic](#/inference-arithmetic).

The reason is that a pass has two costs, and they behave differently. The first
is fixed: every pass must read all of the model's weights from memory once,
which takes about 14 ms on the case's server, however many tokens ride in the
pass. The second is arithmetic, about 0.09 ms per token. The two overlap, so a
pass costs whichever is larger. A 3,000-token prefill is all arithmetic —
3,000 × 0.09 ms ≈ 0.27 s — and the 14 ms of reading hides inside it, shared by
every token. A decode pass carries one token and pays the whole 14 ms for it.
Per token, decode is about 150 times more expensive than prefill.

That asymmetry is why the course treats the two phases as different workloads.
[Inside a Forward Pass](#/inside-a-forward-pass) shows where the weights and the
arithmetic come from; [The GPU Mental Model](#/gpu-mental-model) shows the
hardware side.

## The KV cache: notes that save recomputation

Each pass of the loop needs information about every earlier token. Done naively,
step 100 would reprocess tokens 1 to 99 from scratch, step 101 would reprocess 1
to 100, and so on.

> [!predict] Before you read on
> Generating a 1,000-token answer naively, re-processing every earlier token at
> each step, how many token-computations is that compared with processing each
> token once? About 2×, about 30×, or about 500×?

About 500×. Step *n* reprocesses *n* tokens, so the total is 1 + 2 + … + 1,000 ≈
500,000 token-computations instead of 1,000. The work grows with the square of
the length, which is what makes the naive approach unusable for long answers.

The fix is the **KV cache**. As the model processes each token, it computes, in
every layer, a set of vectors called **keys** and **values** (hence "KV"; one
pair per attention head, as the next chapters show) that every later token
needs. It stores them. The next step computes only the new token's vectors and
reads everyone else's from the cache.

The cost is memory: the cache grows with every token of every conversation in
flight, in the GPU's limited memory — about a third of a megabyte per token for
the model this course follows. [PagedAttention & Prefix
Caching](#/paged-kv-cache) is devoted to managing that pile.

> [!bridge] From the Linux course
> The page cache makes the same trade: spend scarce memory to avoid repeating
> slow work. What differs is the work avoided — a disk read there, a
> recomputation here — and ownership: a hot file's cached pages serve every
> process, while a token's cached keys and values depend on every token before
> it, so they can be shared only when two requests begin with exactly the same
> tokens — a shared *prefix*, like the system prompt above.
> [→ Linux: Watch the Page Cache Work](../#/lab-page-cache)

## What serving means

**Serving** is running this loop for real users: a copy of the model loaded on
one or more **GPUs** (the chips that do the math), answering many people at
once, continuously. The running case rents its GPUs at $2.50 an hour each and
needs four. Idle silicon still bills.

A request's life looks like this:

```text
   browser ─HTTP─▶ ┌───────┐   ┌──────────┐   ┌─────────┐   ┌─────────────┐
                   │ queue │ → │ tokenize │ → │ prefill │ → │ decode loop │
                   └───────┘   └──────────┘   └─────────┘   └──────┬──────┘
   browser ◀──────────── each token streamed back as it is made ───┘
```

![One request's timeline: queue wait and tokenization, then a single wide prefill block, then a long train of evenly spaced decode ticks, one per output token, ending at the stop token. TTFT is bracketed from arrival to the first tick; the steady gap between later ticks is the per-token pace.](assets/diagrams/request-timeline.svg)

**Time to first token (TTFT)** is the pause before anything appears. It contains
the queue wait, tokenization and the whole prefill. A longer prompt means a
longer prefill and a longer pause.

**Time per output token (TPOT)** is the steady rhythm afterwards: one decode step
per token, sent the moment it exists. At 20 ms per token you see 50 tokens a
second, faster than anyone reads; at 150 ms the typing visibly drags.

On the wire, most engines (vLLM included) speak the OpenAI-compatible chat API;
with `"stream": true` the answer comes back as server-sent events, one `data:`
line per chunk:

```bash
curl -sN http://ask-halden-llm:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "meta-llama/Llama-3.3-70B-Instruct",
       "messages": [{"role": "system", "content": "You are Ask Halden, …"},
                    {"role": "user", "content": "Documents: … Question: …"}],
       "max_tokens": 400,
       "stream": true,
       "stream_options": {"include_usage": true}}'
```

*Real format, illustrative values — request fields (`stream`, `stream_options.include_usage`, `max_tokens`) from vLLM v0.34.0 `vllm/entrypoints/openai/chat_completion/protocol.py`; host name and messages invented.*

```plaintext
 t (s)  line received
 0.27   data: {"id":"chatcmpl-3f9c…","object":"chat.completion.chunk","created":1795253400,"model":"meta-llama/Llama-3.3-70B-Instruct","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],…}
 0.27   data: {"id":"chatcmpl-3f9c…",…,"choices":[{"index":0,"delta":{"content":"New"},"logprobs":null,"finish_reason":null,…}],…}
 0.28   data: {…,"choices":[{"index":0,"delta":{"content":" warehouse"},…}],…}
 0.30   data: {…,"choices":[{"index":0,"delta":{"content":" staff"},…}],…}
 …
 3.76   data: {…,"choices":[{"index":0,"delta":{"content":""},"logprobs":null,"finish_reason":"stop",…}],…}
 3.76   data: {"id":"chatcmpl-3f9c…","object":"chat.completion.chunk","created":1795253400,"model":"meta-llama/Llama-3.3-70B-Instruct","choices":[],"usage":{"prompt_tokens":3000,"total_tokens":3250,"completion_tokens":250}}
 3.76   data: [DONE]
```

*Real format, illustrative values — chunk structure from vLLM v0.34.0 `vllm/entrypoints/openai/chat_completion/serving.py` (role chunk, one chunk per token, `usage` only with `include_usage`, then `[DONE]`), repeated fields trimmed; the time column is computed from the case (0.27 s prefill, 14 ms per step), not measured.*

Three readings. TTFT is the arrival of the first chunk with *text* — the role
chunk carries none, and a client that times the first byte will flatter the
server whenever the two are sent apart. TPOT is (3.76 − 0.27) s over the 249
tokens after the first: 14 ms. And `usage.prompt_tokens` is the request's true
size — template, system prompt and whatever retrieval put in — the number to log
for every request.

Serving teams write their promises in these two units — "TTFT p95 under 1 s,
TPOT p95 under 50 ms" — and a **p95** means 95% of requests must do at least that
well. The averages hide the users who complain.

## Why this is a systems problem

With many users, two goals collide. Each user wants low latency: a short pause
and a fast rhythm. The operator wants as many tokens per GPU-hour as possible.
The 14 ms of reading per pass is the lever: packing many users' tokens into one
pass shares it among them, but anything that makes the pass longer slows the
rhythm for everyone in it. Giving each user the hardware alone keeps latency low
and wastes most of the chip. That trade-off, and the techniques that bend it, is
the rest of the course. It is the Linux scheduler's latency-versus-throughput
problem with one difference: a CPU can switch tasks in microseconds, while a GPU
is committed to a batch for a whole pass over the model.

> **State of play (November 2026):** the price of a fixed level of model
> capability has fallen fast — 9× to 900× per year depending on the benchmark,
> per Epoch AI (March 2025). Cheaper models and the serving techniques in this
> course both contribute; no published source splits the decline between them.

## The case: Ask Halden

Every chapter applies itself to one running scenario, so that by the end you
have built a deployment plan rather than collected facts.

> [!case] The case: the brief
> You are the platform engineer at **Halden**, a fictional 2,000-person logistics
> company. Legal has ruled that internal documents may not leave the company's
> cloud account, so a hosted model API is off the table. You are asked to
> self-host **Ask Halden**: an assistant that answers employees' questions using
> company documents.
>
> - **Model:** Llama-3.3-70B-Instruct, an open-weights model with 70 billion
>   parameters.
> - **Hardware:** one rented server with four H100 GPUs (about $7,300 a month).
> - **Traffic:** ~600 daily users, ~12,000 requests a day, bursting to 1.5
>   requests per second in the morning peak.
> - **Request shape:** an 800-token system prompt (the same for everyone) +
>   ~2,000 tokens of retrieved document text + a ~200-token question ≈ **3,000
>   tokens in**; a median answer of **250 tokens out**.
> - **Promises:** TTFT p95 ≤ 1.5 s; TPOT p95 ≤ 60 ms.
>
> **What this chapter settles.** The 60 ms TPOT promise is ~17 tokens a second,
> faster than reading — a promise about decode; a 250-token answer at 60 ms takes
> 15 s, acceptable *because* it streams. The 1.5 s TTFT promise is about
> queueing plus prefill, and prefill grows with a number you do not control.
>
> **The stake.** The system prompt and the question are yours; the 2,000 tokens
> in the middle are whatever retrieval returns. At ~0.09 ms per prompt token,
> 1.5 s buys ~16,800 tokens of prompt — about **14,900** once attention work that
> grows with length is counted — on an idle server with no queue. That is
> retrieval returning ~14,000 tokens instead of 2,000: one "fetch 30 chunks"
> setting, or one chunk that is a whole manual. At the peak, queueing eats part
> of the 1.5 s first. Decision: the application caps retrieved text at a token
> budget (Halden starts at 4,000) and logs every request's
> `usage.prompt_tokens`. Open question: can one server keep both promises for
> everyone at the peak?

## Exercises

<div class="exercise">

**Exercise 1.** An employee pastes a 1,500-word policy document into Ask Halden
and asks for a 300-word summary. Roughly how many tokens are in the request and
in the answer? Which phase handles each, and how long does each part of the
user's wait last on the case's server with nobody else using it?

<details>
<summary>Reveal answer</summary>

At ~1.3 tokens per word: the document is ~2,000 tokens, plus the 800-token
system prompt and a short instruction, so ~2,850 tokens in. The 300-word summary
is ~400 tokens out.

The input is prefill: one pass, ~2,850 × 0.09 ms ≈ 0.26 s, the pause before
the first word (TTFT). The output is decode: 400 sequential steps, the
length of the typing. At ~14 ms per step that is ~5.6 s of streaming; at the
60 ms limit of the promise it would be 24 s. The answer, not the long document,
dominates the total time.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** The gateway in front of Ask Halden logs one line per
request: when it arrived, the two `usage` counts, and when the first chunk with
text and the last chunk arrived (seconds after arrival). Which requests break
which promise, which number in the row explains it, and did the culprit hurt
anyone else?

```plaintext
req    arrived   prompt_tokens  completion_tokens  first_text_s  last_chunk_s
q-101  09:41:02          3,012                244          0.31          3.95
q-102  09:41:05         21,870                251          2.36          5.89
q-103  09:41:06          2,986                255          0.30          5.45
q-104  09:41:09          3,104                238          0.33          3.66
```

*Real format, illustrative values — `prompt_tokens` and `completion_tokens` are the vLLM v0.34.0 `usage` fields shown above; the times are computed from the case's numbers, not measured.*

<details>
<summary>Reveal answer</summary>

TTFT is `first_text_s`; TPOT is (`last_chunk_s` − `first_text_s`) ÷
(`completion_tokens` − 1).

- q-101: 0.31 s, 15 ms. q-104: 0.33 s, 14 ms. Healthy.
- q-102: TTFT 2.36 s, over the promise, with a healthy 14 ms TPOT. The cause
  is in its own row: 21,870 prompt tokens, seven times the plan; 21,870 ×
  0.09 ms ≈ 2 s of prefill plus attention. Retrieval stuffed the prompt — the
  case's stake.
- q-103: 0.30 s and 20 ms — within both promises, but slower than its
  neighbours, and nothing in its own row explains it. Look at the clock: it
  arrived one second after q-102, whose 2-second prefill occupied the passes
  q-103's decode steps needed.

The cause of a slow stream is often in somebody else's request;
[Continuous Batching](#/continuous-batching) shows how engines interleave the
two.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** A different product: an internal chat assistant with
no retrieval. A user sends the tenth message of a long conversation. The nine
earlier turns are ~6,000 tokens, re-sent with every request (the chat API is
stateless); the new message is 200 tokens. Estimate TTFT with an idle server,
first if the server recomputes everything, then if it still holds the keys and
values for the first 6,000 tokens. What must the client do for the second case
to happen?

<details>
<summary>Reveal answer</summary>

Recompute everything: 6,200 × 0.09 ms ≈ 0.56 s, more with attention, and
growing every turn — why long chats get slower to start. With the earlier turns
cached, only 200 tokens are prefilled: 18 ms, just above the 14 ms any pass
costs, so ~20 ms, about thirty times faster.

The reuse works only if the new request *begins* with exactly the cached tokens.
The client must re-send earlier turns byte for byte through the same template; a
timestamp in the system prompt or a reordered message makes the whole
conversation a miss. That is prefix caching,
[PagedAttention & Prefix Caching](#/paged-kv-cache).

</details>

</div>

## The road from here

Each part answers one question about the request you just followed; the first
three end with a lab on your own laptop, with llama.cpp.

- Foundations — what you download ([Where a Model Comes
  From](#/where-models-come-from), [Reading a Model Card](#/reading-a-model-card)),
  what one pass computes, the GPU, and the arithmetic behind TTFT and TPOT;
  [Lab: Your First Tokens](#/lab-first-tokens).
- The Engine — many requests at once: batching, cache memory, the engine;
  [a lab](#/lab-batching-and-cache) on parallel slots and the prefix cache.
- Squeezing the Model — smaller numbers and caches, speculation, checking
  quality; [a lab](#/lab-squeezing).
- Under the Hood — kernels and compilation.
- Serving at Scale — many GPUs, mixture-of-experts, split fleets, agents,
  [workloads beyond chat](#/beyond-chat).
- In Production — sizing (where Ask Halden closes), [load
  testing](#/load-testing) and [its lab](#/lab-load-test), cost, choice,
  operations, [failure](#/when-it-breaks).
- Epilogue — the frontier, and mixed problems over everything.

## What to remember

- An LLM is a function from text to a score for every possible next token, run in
  a loop: one token per pass, each output fed back in, until an end token or
  `max_tokens`.
- Text is measured in tokens (≈ ¾ of an English word), and the prompt the
  model reads includes a chat template you did not write.
- Prefill processes the whole prompt in one pass and sets the pause (TTFT).
  Decode produces one token per pass and sets the rhythm (TPOT). A pass has a
  fixed cost (reading the weights) that prefill shares across thousands of
  tokens and decode pays per token.
- The KV cache stores each token's keys and values so they are computed once.
  It turns quadratic work into linear work and costs GPU memory per token, per
  conversation.
- In a stream, TTFT is the first chunk with text and `usage.prompt_tokens` is the
  request's true size; log it.

```quiz
[
  {
    "q": "A coding assistant receives a 50-token prompt and writes a 2,000-token answer on the case's server, alone. Roughly how long does the whole answer take, and which phase owns that time?",
    "choices": [
      "About 0.3 s, almost all of it in prefill, since prompts dominate",
      "About 3 s, split evenly between the prefill pass and the decode steps",
      "About 28 s, nearly all of it decode: 2,000 steps at ~14 ms each",
      "About 180 s, because every output token re-reads the whole prompt"
    ],
    "answer": 2,
    "explain": "Prefill of 50 tokens is a single pass of ~14 ms — it cannot cost less than reading the weights once. Decode is 2,000 sequential steps at ~14 ms ≈ 28 s. The 180 s distractor assumes no KV cache; the 0.3 s one assumes cost follows the prompt, which is only true when the prompt is long and the answer short."
  },
  {
    "q": "A client timestamps a vLLM stream: the role-only chunk and the first text chunk both arrive at 0.42 s, the last text chunk at 4.40 s, and usage reports completion_tokens: 200. What are TTFT and TPOT?",
    "choices": [
      "TTFT 0.42 s and TPOT 20 ms, from 3.98 s spread over 199 gaps",
      "TTFT 0.42 s and TPOT 22 ms, from the 4.40 s total over 200 tokens",
      "TTFT 4.40 s, when the answer is complete, and TPOT 2 ms per token",
      "TTFT 0.42 s and TPOT 4.4 ms, from 4.40 s divided by 1,000 tokens"
    ],
    "answer": 0,
    "explain": "TTFT is the arrival of the first chunk carrying text: 0.42 s. TPOT is the time after it over the tokens after it: (4.40 − 0.42) / 199 ≈ 20 ms, inside a 60 ms promise. The tempting 22 ms divides the whole request time, prefill included, by the token count — it charges the pause to the rhythm."
  },
  {
    "q": "After temperature, the next-token probabilities are 0.60, 0.25, 0.10, 0.05. With top-p = 0.9, which tokens can still be drawn?",
    "choices": [
      "Only the first two, whose probabilities sum to 0.85",
      "Every token, since top-p only reorders the probabilities",
      "Only the first, because it alone holds a majority of the mass",
      "The first three, the smallest top set reaching at least 0.9"
    ],
    "answer": 3,
    "explain": "Top-p keeps the smallest set of most likely tokens whose probabilities sum to at least p. 0.60 + 0.25 = 0.85 is short of 0.9; adding 0.10 reaches 0.95. So three tokens survive, renormalised; the 0.05 tail is cut. The two-token answer stops one token early."
  },
  {
    "q": "A developer moves Ask Halden's retrieved documents ahead of the 800-token system prompt, inside the same system message. What happens to the work the server can share between requests?",
    "choices": [
      "Nothing changes, since the same 800 tokens still appear in every prompt",
      "Sharing is lost: requests now differ from their first few tokens onward",
      "Sharing improves, because retrieved documents repeat across users",
      "Only decode slows down, since prefill does not depend on token order"
    ],
    "answer": 1,
    "explain": "Cached keys and values can be reused only for an identical prefix: every token's cached vectors depend on all the tokens before it. With documents first, two requests diverge almost immediately, so the system prompt is recomputed for every request. Its 800 tokens are still there, but no longer at the same place after the same tokens."
  },
  {
    "q": "Why can't the server generate all 250 tokens of one answer in parallel?",
    "choices": [
      "Streaming over HTTP can only deliver one token at a time to the client",
      "Softmax has to normalise across the whole answer at once, not per token",
      "Each token is part of the input used to choose the next one",
      "The GPU can only run one forward pass at a time for each user"
    ],
    "answer": 2,
    "explain": "Autoregression: token 10 is chosen by a pass whose input includes token 9, so it cannot start before token 9 exists. Streaming is a consequence of this, not a cause. GPUs do run many users' passes together — that is batching — but nothing parallelises the steps within one answer."
  }
]
```
