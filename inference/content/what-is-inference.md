# What Actually Happens When You Call an LLM

> **Goal of this chapter:** turn the chatbot from magic into machinery. By the
> end you'll know what a large language model *is* (a function that scores the
> next word), what those streaming tokens actually are, why the first one is
> slow and the rest are fast, and why serving one model to thousands of people
> is a hard systems problem — the problem this whole course is about.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="client,api,runner"></div>

You open a chat box, type "Explain how a rainbow forms," and press Enter. A
half-second of nothing. Then words appear — one small chunk at a time, left to
right, at roughly reading speed, as if something on the other end were typing.

That pause and that typewriter rhythm are not cosmetic. They are the visible
shadow of everything happening inside a datacenter: a model running on a graphics
card that costs more than a car, shared with thousands of other people asking
their own questions at the same instant. This chapter is first contact — no math,
no hardware, just the right mental model to build the rest of the course on.

## An LLM is a function that scores the next word

Strip away the mystique and a large language model (**LLM** — "large" because it
has tens or hundreds of billions of tunable numbers inside) is a single
mathematical function. It takes in the text so far and produces, for *every*
possible next word, a score: how likely that word is to come next.

That's it. That's the whole engine. Given "The capital of France is", the model
assigns a high score to "Paris", a low score to "banana", and some score to
every other option in between. It does not "know" anything or "plan" a sentence.
It scores what comes next, and it happens to be extraordinarily good at it
because those billions of internal numbers were tuned on a large fraction of the
text humanity has written.

Everything else — essays, code, apparent reasoning — is this one operation run
over and over. Understanding that loop is understanding inference.

> **Inference** is the industry's word for *using* a trained model to produce
> outputs, as opposed to **training**, the far more expensive process that tuned
> those internal numbers in the first place. Training happens once, in a lab.
> Inference happens billions of times a day, every time anyone sends a prompt.
> This course is entirely about inference.

## Tokens: the model doesn't see words, it sees pieces

There's one honest complication in "scores the next word." The model doesn't work
in words. It works in **tokens** — chunks of text usually a few characters long,
somewhere between a letter and a word. Common words are a single token; rarer
words get split into pieces.

Here is a real sentence broken into tokens (each `│` is a boundary; a leading
space is part of the token, which is why the model handles spacing so cleanly):

```text
  "Tokenization feels unintuitive at first."

  Token │ ization │  feels │  un │ intuit │ ive │  at │  first │ .
    ↑
  9 tokens for 6 words — "Tokenization" splits into 2 pieces,
  "unintuitive" into 3, but "feels", "at", "first" are one each.
```

Why chop text up this way? Because a fixed list of whole words could never cover
every name, typo, URL, or foreign word. A **vocabulary** of subword pieces
(typically 50,000–200,000 of them) can spell out *anything* by combining pieces,
while keeping common words fast as single units. **Tokenization** is the step that
converts your raw text into a list of token ID numbers before the model sees it,
and converts the model's output numbers back into text on the way out.

A rough rule of thumb worth memorizing: **one token ≈ 4 characters of English ≈
0.75 words.** So 1,000 words is roughly 1,300 tokens. This matters later than you
think — every price, speed, and memory number in this course is quoted *per
token*, not per word.

## From scores to a chosen token: logits, softmax, sampling

So the model produces a score for every token in the vocabulary. Those raw scores
are called **logits** — one number per token, maybe 128,000 of them, and they can
be any value, positive or negative. Raw logits aren't probabilities; they're just
a ranking with arbitrary scale.

To turn them into probabilities that sum to 1, we pass them through a function
called **softmax**. You don't need the formula yet — just the behavior: softmax
exaggerates the gaps between logits and squashes the whole set into clean
percentages. A token that scored a bit higher than the rest ends up with most of
the probability; the long tail of unlikely tokens ends up with slivers.

Now we have a probability for every possible next token. The final step is
**sampling**: actually picking one. The simplest choice is "always take the
highest-probability token," which makes the model deterministic. But most
deployments add a little randomness so the output feels natural and varied —
and this is what the **temperature** knob controls.

> **Temperature intuition:** temperature reshapes the probabilities *before* we
> draw from them. Low temperature (near 0) sharpens the distribution toward the
> single most likely token — focused, repetitive, "safe." High temperature
> (above 1) flattens it, giving unlikely tokens a real chance — creative,
> surprising, sometimes incoherent. Temperature 0 means "always pick the top
> token." That's the whole idea; the knob just trades predictability for variety.

## The autoregressive loop: one token, then do it all again

Here is the part that surprises everyone. The model produces *one token per run*.
To write a paragraph, it runs the whole function again for each token, feeding its
own previous output back in as input. This is called **autoregressive**
generation — "auto" (self) + "regressive" (feeding prior outputs back).

```text
  input: "The capital of France is"
      → run model → scores → sample → "Paris"

  input: "The capital of France is Paris"
      → run model → scores → sample → ","

  input: "The capital of France is Paris,"
      → run model → scores → sample → " a"
  ... and so on, one token at a time, until a special "stop" token.
```

This is why generation is fundamentally **sequential**. You cannot compute the
tenth token until you've computed the ninth, because the ninth becomes part of the
tenth's input. No amount of hardware breaks this chain — the model literally does
not know token 9 until it produces it. That single fact is the root cause of most
of the hard problems in this course.

## Two phases that behave nothing alike: prefill and decode

Look closely at that loop and you'll notice the very first run is different from
all the rest.

On the first run, the model has to read your *entire* prompt — every token of
"Explain how a rainbow forms" — before it can produce anything. All those prompt
tokens can be processed **together, in one pass**, because they already exist; the
model isn't waiting on itself. This phase is called **prefill**: digesting the
prompt.

After that, every subsequent run adds exactly *one* new token to the end and asks
for the next one. This phase is called **decode**: generating the answer, one
token at a time, sequentially.

```text
   PREFILL                          DECODE
   read the whole prompt at once    generate one token per step
   ┌───────────────────────┐        ┌──┐ ┌──┐ ┌──┐ ┌──┐
   │ all prompt tokens  →  │  then  │t1│→│t2│→│t3│→│t4│→ …
   └───────────────────────┘        └──┘ └──┘ └──┘ └──┘
   one big parallel pass            many tiny sequential passes
```

Hold onto this distinction — it is the spine of the entire course. Prefill and
decode run on the same hardware and the same model, yet stress that hardware in
*opposite* ways: one is limited by raw calculation, the other by how fast memory
can be read. Almost every optimization you'll learn is a trick for one phase or
the other. The [next chapter](#/gpu-mental-model) gives you the hardware picture,
and [Inference Arithmetic](#/inference-arithmetic) makes the "opposite ways"
precise with real numbers. For now, just plant the seed: *these two phases are not
the same animal.*

## The KV cache: the model keeps notes so it doesn't re-read everything

Autoregressive generation hides an expensive trap. At step 100, the naive way to
produce token 100 would be to re-read all 99 previous tokens from scratch. At step
101, re-read all 100. Every single token would mean re-processing the entire
conversation so far — enormous, wasteful, and quadratically slow.

Models avoid this with the **KV cache**. As the model processes each token, it
computes some intermediate results about that token (called keys and values —
hence "KV"; the details wait for later chapters) and *saves them*. When the next
token comes along, the model reuses those saved notes instead of recomputing them.

> **Analogy:** imagine summarizing a long meeting live. Instead of re-listening to
> the entire recording before writing each new sentence, you keep a running page
> of notes and only process what was *just* said, glancing at your notes for
> everything prior. The KV cache is that page of notes. It turns "re-read the
> whole history every step" into "read the history once, then only handle the new
> token." The catch — and it's a big one — is that this page of notes grows with
> every token and has to be held in the graphics card's precious memory. Managing
> that growing cache is one of the central engineering problems of serving, and it
> gets its own chapter: [PagedAttention & Prefix Caching](#/paged-kv-cache).

> [!bridge] You already know this — from the Linux course
> The page cache plays the same trick: hold the expensive result of a slow
> operation in fast memory so you never pay for it twice, and spend your
> scarce RAM to buy back time. What differs is what gets avoided — the page
> cache saves you a *disk read*, the KV cache saves you *recomputation* — and
> that KV entries belong to one conversation, so they cannot be shared between
> users the way a hot file's pages are.
> [→ Linux: Watch the Page Cache Work](../#/lab-page-cache)

## What "serving" actually means

Everything so far described one request. **Serving** is running this for the real
world: one copy of a model on a **GPU** (graphics processing unit — the specialized
chip that does the model's math, and the subject of the next chapter), answering
*thousands* of people at once, around the clock. Those GPUs rent for roughly
**$2–3 per hour each**, and a large model needs several of them just to fit. The
meter is always running, so every millisecond of idle silicon is money burned.

Here's the life of your request, end to end:

```text
   your keystrokes
        │  HTTP request over the internet
        ▼
   ┌─────────┐   ┌───────────┐   ┌──────────────┐   ┌─────────────┐
   │  queue  │→  │ tokenize  │→  │  GPU: prefill │→  │ GPU: decode │
   │ (wait   │   │ text →    │   │  the prompt   │   │ loop, 1 tok │
   │  for a  │   │ token IDs │   │  (one pass)   │   │ at a time   │
   │  slot)  │   └───────────┘   └──────────────┘   └──────┬──────┘
   └─────────┘                                             │ each token
        ▲                                                  ▼ streamed back
        └──────────── tokens appear in your browser ◀──────┘
```

Two things about this picture explain your lived experience directly.

**Streaming.** The server doesn't wait for the whole answer before replying. As
each token pops out of the decode loop, it's sent to your screen immediately.
That's why you see text *typing* rather than appearing all at once — you're
watching the decode loop in real time, one token per frame.

**Why the first token is slow.** Before token one can appear, your request had to
wait in the queue, get tokenized, and go through the *entire prefill pass* over
your prompt. Only then does decoding start. So the first token carries all that
startup cost, while every token after it is just one quick decode step. This gap
has a name you'll meet constantly: **TTFT** (time to first token), as distinct from
the steady per-token pace that follows. A long prompt means a longer prefill means
a longer wait for that first word — you can feel the physics through the screen.

![One request's timeline: queue wait and tokenization, then a single wide prefill block that swallows the whole prompt in one pass, then a long train of narrow evenly spaced decode ticks, one per output token, ending at the stop token. TTFT is bracketed from arrival to the first tick; the steady gap between later ticks is the per-token pace.](assets/diagrams/request-timeline.svg)

## Why this is a systems discipline

If a model were just a function you called once, this would be a math course. It
becomes an *engineering* course because of a tension baked into serving.

You want two things that fight each other. **Latency:** each individual user wants
their answer fast — snappy first token, quick typing. **Throughput:** the operator
wants to serve as many users as possible per expensive GPU-hour. The trouble is
that the tricks which raise throughput (packing many users' requests together to
keep the GPU busy) can hurt any single user's latency, and the tricks that
minimize one user's latency (giving them the GPU all to themselves) waste capacity.
Navigating that trade-off — and bending it in your favor — is the craft this
course teaches.

> [!bridge] You already know this — from the Linux course
> This is the scheduler's oldest dilemma in new clothes: the Linux run queue
> also trades one task's responsiveness against the whole machine's
> throughput, and the timeslice is the knob on exactly that. What differs is
> the granularity and the stakes — a CPU context switch costs microseconds and
> can happen almost anywhere, while a GPU is committed to a batch for the
> whole forward pass, and every idle millisecond of it bills at $2–3 an hour.
> [→ Linux: CPU Scheduling](../#/scheduling)

> **State of play (mid-2026):** the stakes are enormous and concrete. The price of
> LLM output has fallen by very roughly **95% since 2023** — not mainly because
> chips got cheaper, but because the *serving* techniques in this course
> (continuous batching, paged caches, quantization, speculative decoding,
> disaggregation) squeezed far more useful work out of each GPU. The engineering
> *is* the cost curve. That is why it's worth a whole course.

## Frequently asked

<div class="faq">

<details>
<summary>If the model only ever scores the next token, how does it produce a coherent argument?</summary>

Because the text it has already written is part of its input on every
subsequent pass. By the time it is choosing token 300 it is conditioning on
the 299 tokens it just committed to, so the constraint "be consistent with
what I already said" is baked into the scoring rather than planned in advance.
Coherence is an emergent property of a very good next-token scorer running in
a loop, not evidence of a plan held somewhere. That is also why a model can
paint itself into a corner: it cannot revise token 12 once token 13 exists.

</details>

<details>
<summary>Why can't the server compute the whole answer in parallel and send it in one go?</summary>

Because of the autoregressive chain — token 10 is part of the input needed to
produce token 11, so there is nothing to parallelise *within* one response.
What the server does parallelise is *across* responses: many users' decode
steps are packed into one pass over the model, which is where all the
throughput comes from. Streaming is then just honesty about the situation —
the tokens genuinely become available one at a time, so there is no reason to
withhold them. [Continuous Batching & Scheduling](#/continuous-batching) is
that packing, in detail.

</details>

<details>
<summary>When I send a follow-up message, does the model re-read the whole conversation?</summary>

Logically yes — every turn's tokens are part of the prompt for the next turn,
which is why long chats get slower and more expensive to start. Physically,
often no: if the server still holds the KV cache for that conversation's
prefix, it can skip straight past the part it has already digested and prefill
only your new message. That is prefix caching, and it is the difference
between a follow-up costing a few hundred tokens of prefill and costing tens
of thousands. The mechanism is
[PagedAttention & Prefix Caching](#/paged-kv-cache).

</details>

</div>

## Where this course goes

The rest of the course follows the machine outward from a single forward pass to a
global fleet:

- **Foundations** (you are here): [this chapter](#/what-is-inference), then
  [The GPU Mental Model](#/gpu-mental-model) — what the hardware is and why it's
  shaped the way it is — and [Inference Arithmetic](#/inference-arithmetic), which
  makes prefill-vs-decode quantitative.
- **The Engine:** how a real server juggles many requests —
  [Continuous Batching & Scheduling](#/continuous-batching),
  [PagedAttention & Prefix Caching](#/paged-kv-cache), and the
  [Anatomy of a Serving Engine](#/anatomy-of-an-engine).
- **Squeezing the Model:** making the model itself cheaper to run —
  [Attention Architectures for Serving](#/attention-for-serving),
  [Quantization](#/quantization), and [Speculative Decoding](#/speculative-decoding).
- **Under the Hood:** the fast code that does the work —
  [FlashAttention & Decode Kernels](#/flashattention) and
  [Kernels, Graphs & Compilation](#/kernels-and-compilation).
- **Serving at Scale:** spreading one model across many GPUs —
  [Parallelism for Inference](#/parallelism-for-inference),
  [Serving MoE at Scale](#/moe-serving),
  [Disaggregated Serving & the KV Fabric](#/disaggregation), and
  [The Agentic Era](#/agentic-serving).
- **The Big Picture:** [Hardware & Economics](#/hardware-and-economics) and
  [The Frontier, mid-2026](#/frontier).

## What to remember

- An **LLM is a function**: text in → a score for every possible next token. Nothing more mystical is happening.
- The model works in **tokens** (subword pieces), not words. Everything in this course is measured *per token*.
- Logits → **softmax** → **sampling** turns raw scores into one chosen token; **temperature** trades predictability for variety.
- Generation is an **autoregressive loop**: one token per pass, each output fed back in. It is inherently **sequential**.
- **Prefill** (read the whole prompt in one pass) and **decode** (generate one token at a time) behave utterly differently — the central theme of the course.
- The **KV cache** saves per-token "notes" so the model needn't re-read the whole history every step — and it grows, straining GPU memory.
- **Serving** means one model, many GPUs at $2–3/hr each, thousands of concurrent users — a **latency-vs-throughput** engineering problem. That engineering is why tokens got ~95% cheaper since 2023.

```quiz
[
  {
    "q": "At its core, what does a large language model compute?",
    "choices": [
      "The single correct answer to the user's question",
      "A probability score for every possible next token, given the text so far",
      "A compressed database lookup of memorized sentences",
      "A plan for the whole response, which it then writes out"
    ],
    "answer": 1,
    "explain": "An LLM is a function from the current token sequence to a score over every token in the vocabulary. Everything else — essays, code, apparent reasoning — is that one next-token operation repeated in a loop."
  },
  {
    "q": "Why is text generation inherently sequential?",
    "choices": [
      "The GPU can only do one calculation at a time",
      "The network can only stream one token at a time",
      "Each new token becomes part of the input needed to produce the following token",
      "Softmax must finish before sampling can begin"
    ],
    "answer": 2,
    "explain": "Autoregression feeds each generated token back in as input for the next. Token 10 cannot be computed until token 9 exists, so the chain can't be parallelized away — this is the root of most serving difficulties."
  },
  {
    "q": "How do prefill and decode differ?",
    "choices": [
      "Prefill runs on the CPU; decode runs on the GPU",
      "Prefill processes the entire prompt in one parallel pass; decode generates one token per sequential pass",
      "Prefill generates tokens; decode only tokenizes the input",
      "They are two names for the same single forward pass"
    ],
    "answer": 1,
    "explain": "Prefill digests the whole prompt at once (all prompt tokens already exist, so they're processed together). Decode then adds one token per pass, sequentially. The two phases stress the hardware in opposite ways — the spine of the course."
  },
  {
    "q": "What problem does the KV cache solve?",
    "choices": [
      "It stores the model's weights so they load faster at startup",
      "It saves per-token intermediate results so the model needn't reprocess the entire history for every new token",
      "It caches finished responses so identical prompts return instantly",
      "It compresses the vocabulary to make tokenization faster"
    ],
    "answer": 1,
    "explain": "Without it, producing token 100 would mean re-reading all 99 prior tokens, and token 101 all 100 — quadratic waste. The KV cache keeps each token's 'notes' so the model only processes the newest token, at the cost of growing GPU memory."
  },
  {
    "q": "Why does the first token of a response take noticeably longer than the tokens that follow?",
    "choices": [
      "The first token is larger and contains more characters",
      "Temperature is applied only to the first token",
      "Before any output appears, the request must queue, tokenize, and run the full prefill pass over the whole prompt",
      "The GPU has to load the entire model from disk for the first token"
    ],
    "answer": 2,
    "explain": "Time to first token (TTFT) bundles queueing, tokenization, and the complete prefill over your prompt. Only after prefill does decoding start, and each later token is just one quick decode step — so a longer prompt means a longer wait for word one."
  }
]
```
