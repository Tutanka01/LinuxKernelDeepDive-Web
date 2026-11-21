# Lab: Batching and the Prefix Cache

> **The question:** what do continuous batching and a prefix cache look like
> from outside the server?
>
> **You'll be able to:** measure per-stream and aggregate decode speed as
> concurrency grows, and predict where streams start to slow from your machine's
> knee; tell batching from queueing in a `/metrics` scrape; predict `cache_n`
> from where a prompt first differs from what a slot holds.

> **Not executed by the author.** Flags, endpoints, metric names and response
> fields come from the llama.cpp server README at build b12608 (2026-11-21);
> Homebrew installs llama.cpp 1.0.0 (2026-11-13) — if a flag is rejected,
> `llama-server --help` is the authority. Expected results are described by
> shape, never as figures; the results table is yours to fill. The Python
> scripts were tested against a mock server that returns the documented format,
> not against `llama-server`.

[Continuous Batching](#/continuous-batching) and
[PagedAttention & Prefix Caching](#/paged-kv-cache) drew the scheduler and the
cache from the inside. A serving engineer rarely sees either from there. What
you get is a client's stopwatch, a per-request `timings` object, a slot list and
a metrics scrape — and from those you must tell whether streams are sharing
steps or waiting in line, and whether a prompt's prefix was reused or
recomputed. This lab produces each situation on purpose so you know its
signature.

**What you need:** [Lab: Your First Tokens](#/lab-first-tokens) done — the same
model, already downloaded, and your knee from its Stage 5; `python3` and `jq`;
about 40 minutes.

llama.cpp's model of concurrency is simple. The server has a fixed number of
**slots**, set by `-np`; each slot serves one request and holds that request's
KV cache. With continuous batching (`-cb`, on by default) every busy slot
contributes its next token to the same `llama_decode()` call, and a new request
joins at the next step instead of waiting for the batch to finish. A request
that finds no free slot is **deferred**: it waits in the server's queue.

---

## Stage 1: start a server with eight slots

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 16384 -np 8 --metrics -ngl all
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608.*

`--metrics` turns on the Prometheus endpoint; `/slots` is on by default. Look at
the slots:

```bash
curl -s http://127.0.0.1:9931/slots | jq -c '.[] | {id, n_ctx, is_processing, n_decoded: .next_token.n_decoded}'
```

*Real format, illustrative values — `/slots` fields as documented in the README at b12608.*

**What just happened:** eight entries, all idle. Read `n_ctx`: the README
describes a slot's context as `-c` divided by `-np`, so expect 2,048 tokens per
slot — the 16,384-token cache cut into eight private pieces, about 1.75 GiB in
all. (With `-kvu` the slots draw on one shared pool instead; it is on by default
only when `-np` is left on auto.) Each slot's KV belongs to that slot. Keep that
in mind for Stage 4.

---

## Stage 2: N streams at once

> [!predict] Before you read on
> Fire N = 1, 2, 4 and 8 identical-length requests at the same moment. For each
> N, predict per-stream decode speed and aggregate tokens per second, using your
> knee from the previous lab. Below the knee, what should happen to each? Above
> it? Is there a number the aggregate can never exceed?

Save this as `fanout.py` and run it four times — `python3 fanout.py 1`, then 2,
4 and 8:

```python
#!/usr/bin/env python3
# Fire N requests at once; report per-stream and aggregate decode speed.
import json, sys, threading, time, urllib.request

URL, N = "http://127.0.0.1:9931/completion", int(sys.argv[1])
results = []

def one(i):
    body = {"prompt": f"Story {i}. Write a long story about a lighthouse keeper.",
            "n_predict": 200, "ignore_eos": True, "cache_prompt": False}
    req = urllib.request.Request(URL, json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            t = json.load(r)["timings"]
    except OSError as e:
        return print(f"request {i} failed: {e}")
    results.append((t["predicted_per_second"], t["predicted_n"], time.perf_counter() - t0))

threads = [threading.Thread(target=one, args=(i,)) for i in range(N)]
start = time.perf_counter()
for th in threads: th.start()
for th in threads: th.join()
wall = time.perf_counter() - start
speeds = sorted(r[0] for r in results)
tokens = sum(r[1] for r in results)
print(f"N={N}: per-stream decode {speeds[0]:.1f}-{speeds[-1]:.1f} tok/s; "
      f"aggregate {tokens / wall:.1f} tok/s; longest request {max(r[2] for r in results):.1f} s")
```

*Runnable — Python 3 standard library only; run by the author against a mock server that speaks the documented llama.cpp format, not against llama-server, so no output is shown: the numbers are yours.*

Every request generates exactly 200 tokens (`ignore_eos`), so the streams run
side by side from first step to last. Per-stream speed comes from the server's
own `predicted_per_second`; aggregate is all generated tokens over the client's
wall-clock time.

**What just happened:** the step-time model from
[Inference Arithmetic](#/inference-arithmetic) predicts the whole table. A step
carrying N tokens costs about `max(t_w, N × t_c)`: one weight read, or N tokens'
arithmetic, whichever is longer. While N is well below your knee, the weight
read sets the step, so per-stream speed barely moves and the aggregate climbs
almost N-fold — continuous batching paying out. As N approaches the knee, each
added stream lengthens the step, per-stream speed falls and the aggregate
flattens. The ceiling on the aggregate is `1 ÷ t_c`, which is your prefill rate:
once compute-bound, a decode token costs the same arithmetic as a prompt token.
On the H100 node that bend sits at ~160 tokens per step; on a laptop with a 4-bit
file, your knee may be low enough that N = 8 already shows it.

Two caveats when you reconcile. Batched decode does not always use the same
kernels as batch-1 decode or as prefill, so a small dip at N = 2 can be a kernel
change rather than the roofline. And the aggregate includes each request's own
prefill and HTTP time, so it slightly understates the decode rate.

---

## Stage 3: more requests than slots

> [!predict] Before you read on
> Now fire 16 requests at the 8-slot server. What will `requests_processing`
> and `requests_deferred` read in the middle of the run? Compared with N = 8,
> what happens to per-stream decode speed, and to the longest request's
> wall-clock time?

In a second terminal, start a scrape loop before you launch `python3 fanout.py
16`:

```bash
while true; do
  curl -s http://127.0.0.1:9931/metrics |
    grep -E '^llamacpp:(requests_processing|requests_deferred|n_busy_slots_per_decode)'
  echo; sleep 1
done
```

*Real format, illustrative values — metric names from the README's "Available metrics" table at b12608.*

The three gauges, as the README defines them:

```plaintext
| `llamacpp:requests_processing` | Gauge | Number of requests processing. |
| `llamacpp:requests_deferred` | Gauge | Number of requests deferred. |
| `llamacpp:n_busy_slots_per_decode` | Gauge | Average number of busy slots per llama_decode() call. |
```

*Verbatim — llama.cpp server README at b12608, `/metrics`, "Available metrics" (three rows of the table).*

**What just happened:** expect `requests_processing` to sit at 8 and
`requests_deferred` near 8 for the first half of the run, then the deferred count
to drain to zero as the first wave finishes. Per-stream decode speed should look
like your N = 8 row, because no step ever carries more than eight tokens; the
longest request's wall-clock time should be about double. That difference is the
queue. Note what does not show it: expect a deferred request's `timings` to
look healthy, because they describe its processing, and the README documents no
queue-time field. A user's TTFT includes the wait; the server's per-request
numbers do not. Queueing is visible only in the client's clock and in the deferred gauge.

This is [Little's law](#/continuous-batching) seen from outside: the number in
the system is `requests_processing + requests_deferred`, and it equals arrival
rate × time in the system. Slots cap only the first term. If requests arrive
faster than eight slots can finish them, the deferred gauge grows without bound
while every per-request metric stays green. `n_busy_slots_per_decode` is the
batch the GPU actually saw; the README calls it an average without saying over
what window, so compare readings taken before and after a run rather than
trusting one. [Lab: Find the Knee](#/lab-load-test) checks Little's law against
these gauges under a steady arrival rate.

---

## Stage 4: one prefix, four requests

> [!predict] Before you read on
> A ~800-token system prompt, sent four times with `cache_prompt` on: first;
> again unchanged; with the last word of the question changed; with the first
> word of the system prompt changed. For each, predict `cache_n` and `prompt_n`.

Save as `prefix.py` and run it once against the same server:

```python
#!/usr/bin/env python3
# One ~800-token system prompt; then the same, a change at the end, a change at the start.
import json, urllib.request

URL = "http://127.0.0.1:9931/completion"
RULES = ("Answer only from the documents provided, cite the document id, "
         "and say so when the documents do not contain the answer. ") * 32
SYSTEM = "Today you are Ask Halden, the assistant of a logistics company. " + RULES
TESTS = [("first request", SYSTEM + "Question: when does the Hamburg truck leave?"),
         ("same again", SYSTEM + "Question: when does the Hamburg truck leave?"),
         ("end changed", SYSTEM + "Question: when does the Hamburg truck return?"),
         ("start changed", SYSTEM.replace("Today", "Tonight", 1)
                           + "Question: when does the Hamburg truck return?")]

print(f"{'request':<14} {'cache_n':>8} {'prompt_n':>9} {'prompt_ms':>10}")
for name, prompt in TESTS:
    body = {"prompt": prompt, "n_predict": 16, "cache_prompt": True}
    req = urllib.request.Request(URL, json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        t = json.load(r)["timings"]
    print(f"{name:<14} {t['cache_n']:>8} {t['prompt_n']:>9} {t['prompt_ms']:>10.1f}")
```

*Runnable — Python 3 standard library only; run by the author against a mock server that speaks the documented llama.cpp format, not against llama-server, so no output is shown: the numbers are yours.*

**What just happened:** `prompt_n + cache_n` is the prompt's length in tokens
every time (the README: tokens in context = `prompt_n + cache_n +
predicted_n`); only the split moves.

- *First request:* `cache_n` near zero, `prompt_n` the full ~800, and a
  `prompt_ms` you can check against your prefill rate from the previous lab.
- *Same again:* `cache_n` the full prompt bar one, `prompt_n` 1. llama.cpp
  always evaluates at least one token, because it needs that token's output to
  start generating. `prompt_ms` collapses to about one decode step.
- *End changed:* `cache_n` drops only by the few tokens after the change. The
  server chose a slot whose cached prompt matched (`--slot-prompt-similarity`),
  kept the common prefix and evaluated the rest.
- *Start changed:* `cache_n` back near zero (possibly 1: the beginning-of-text
  token the server inserts still matches), `prompt_n` the full prompt. One word
  differs, yet everything after it is recomputed.

The last row is the rule from [PagedAttention & Prefix Caching](#/paged-kv-cache),
measured: a token's key and value depend on every token before it, so an entry
is valid only behind an identical prefix. The server is not being timid — the
KV it holds for token 500 was computed after "Today", and the new request needs
the KV of token 500 after "Tonight".

---

## Stage 5: what sits in front of your system prompt

> [!predict] Before you read on
> Send the same system prompt through the chat endpoint instead, as a `system`
> message. Will the cache still hit for the first request after midnight?

The chat endpoints wrap your messages in the model's chat template before
tokenizing. `/apply-template` shows the result without running the model:

```bash
curl -s http://127.0.0.1:9931/apply-template -H 'Content-Type: application/json' \
  -d '{"messages": [{"role": "system", "content": "Today you are Ask Halden."}, {"role": "user", "content": "Hi"}]}' | jq -r .prompt
```

*Real format, illustrative values — `/apply-template` as documented in the README at b12608.*

Then read the template it applied. This model's, from its GGUF metadata:

```plaintext
{%- if not date_string is defined %}
    {%- if strftime_now is defined %}
        {%- set date_string = strftime_now("%d %b %Y") %}
    {%- else %}
        {%- set date_string = "26 Jul 2024" %}
    {%- endif %}
{%- endif %}
…
{{- "<|start_header_id|>system<|end_header_id|>\n\n" }}
…
{{- "Cutting Knowledge Date: December 2023\n" }}
{{- "Today Date: " + date_string + "\n\n" }}
…
{{- system_message }}
```

*Verbatim — `chat_template` of `bartowski/Llama-3.2-3B-Instruct-GGUF`, read from the Hugging Face API's GGUF metadata, 2026-11-21.*

**What just happened:** the template writes a `Today Date:` line into the system
header, before your system prompt. If the template engine provides
`strftime_now`, that line is today's date and every cached prefix expires at
midnight; if not, it is the fixed fallback, 26 Jul 2024. Your
`/apply-template` output tells you which. Either way, the first tokens of every
chat request belong to the template, not to you, and a cache hit depends on them.

---

## How llama.cpp's cache differs from vLLM's and SGLang's

In llama.cpp at b12608, the unit of reuse is the slot. Each slot keeps the KV of
the last prompt it served; a new request goes to the idle slot whose cached prompt
it matches best, provided the match clears `--slot-prompt-similarity` (default
0.10), and with `cache_prompt` on only the unmatched suffix is evaluated. Two more
mechanisms extend this. `--cache-ram` (default 8,192 MiB) keeps a host-memory
prompt cache, into which idle slots are saved (`--cache-idle-slots`), so a prefix
a slot has given up can come back. `--cache-reuse N` goes beyond prefixes: it
reuses chunks of at least N tokens "via KV shifting", moving cached entries to
new positions. The README documents the flag, not its accuracy — but the KV of a
shifted chunk was computed behind different preceding tokens, so it is not what a
fresh prefill would produce (the README already warns that `cache_prompt` can make
results nondeterministic). What the README does not describe is two running slots
sharing one physical copy of a common prefix: each slot holds its own.

vLLM v0.34.0 keys fixed-size blocks — 64 tokens by default
(`CacheConfig.DEFAULT_BLOCK_SIZE`), finer hit boundaries if `prefix_match_unit` is
set — by a hash chained to the previous block, as The Engine described. Any
request, running or finished, can map a block whose hash matches, so twenty
in-flight requests with the same system prompt share one physical copy, and
reuse stops at the last full matching block. SGLang's radix tree keeps cached
prefixes as paths from a root, which makes branching conversations share their
trunk without special handling. All three obey the same rule you measured in
Stage 4: reuse ends at the first differing token. They differ in what is shared
(a slot's own history, or a pool any request can map), at what granularity, and
whether concurrent requests share memory or only skip compute.

---

## Your results

| Measurement | Predicted | Measured |
|---|---|---|
| Your knee from the previous lab (tokens per step) | — | |
| N = 1: per-stream / aggregate (tok/s) | | |
| N = 2: per-stream / aggregate | | |
| N = 4: per-stream / aggregate | | |
| N = 8: per-stream / aggregate | | |
| N = 16: peak `requests_processing` / `requests_deferred` | | |
| N = 16 vs N = 8: longest request (s) | | |
| Prefix — first / same / end changed / start changed: `cache_n` | | |
| `Today Date:` line from `/apply-template` | | |

> [!case] The case: the shared system prompt, reproduced
> Stage 4 is Ask Halden's 800-token system prompt in miniature. A hit shows as
> `prompt_n` of a handful of tokens; a miss as `prompt_n` ≈ 800. On the node
> that is the difference between ~0.20 s and ~0.27 s of prefill for a
> 3,000-token request.
>
> **The stake:** the app team's opening "Hello {first_name}, today is {date}",
> which [PagedAttention & Prefix Caching](#/paged-kv-cache) rejected, is your
> "start changed" row on every request. The date has a second way in: Llama-3.3-70B's
> template writes `Today Date:` into the system header, with a fixed
> "26 Jul 2024" unless the caller passes `date_string` (`tokenizer_config.json`,
> read from an ungated mirror of the checkpoint). Passing the real date costs one
> cold prefill per replica per day — negligible. Passing anything per-user there
> costs the whole prefix on every request.
>
> **What this records:** `date_string` is allowed; nothing per-user or
> per-request may precede the system prompt. The check is the one you just ran:
> the second request of the day must show the system prompt as cached (on vLLM,
> the counter `vllm:prefix_cache_hits` — in tokens — against
> `vllm:prefix_cache_queries`). And the lab
> shows why Halden runs vLLM: llama.cpp would save the compute per slot, but
> twenty slots would hold twenty copies of the prompt, 5.2 GB instead of the
> ~252 MB of vLLM's twelve shared 64-token blocks.

## Exercises

<div class="exercise">

**Exercise 1 — quantitative.** On an older laptop, the previous lab gave 60
decode tokens/s and 360 prefill tokens/s (knee 6). `fanout.py` then printed:

```plaintext
N=1: per-stream decode 58.9-58.9 tok/s; aggregate 58.1 tok/s; longest request 3.5 s
N=2: per-stream decode 56.0-56.4 tok/s; aggregate 110.9 tok/s; longest request 3.6 s
N=4: per-stream decode 53.8-54.6 tok/s; aggregate 213.0 tok/s; longest request 3.8 s
N=8: per-stream decode 41.2-42.0 tok/s; aggregate 324.5 tok/s; longest request 4.9 s
```

*Real format, illustrative values — output format of `fanout.py` above; numbers invented for the exercise.*

Does the step-time model explain the N = 8 row? What would you expect at N = 16
with 16 slots?

<details>
<summary>Reveal answer</summary>

```text
   t_w = 1/60 = 16.7 ms        t_c = 1/360 = 2.8 ms per token
   N = 4:  max(16.7, 11.1)  = 16.7 ms  →  ~60 tok/s per stream (seen: ~54)
   N = 8:  max(16.7, 22.2)  = 22.2 ms  →  ~45 tok/s per stream (seen: ~42)
   N = 16: max(16.7, 44.4)  = 44.4 ms  →  ~23 tok/s per stream, aggregate ~360
```

Yes: N = 4 is below the knee and nearly free; N = 8 is past it and each stream
pays. At N = 16 the aggregate would sit near the 360 tok/s prefill rate, its
ceiling, while each user's stream halves again.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A team runs this model with `-np 4` for an internal
tool. Users report 20–30 s before the first word, then normal-speed text. A
scrape taken twice, a minute apart:

```plaintext
llamacpp:requests_processing 4
llamacpp:requests_deferred 6
llamacpp:n_busy_slots_per_decode 3.96

llamacpp:requests_processing 4
llamacpp:requests_deferred 11
llamacpp:n_busy_slots_per_decode 3.97
```

*Real format, illustrative values — metric names from the llama.cpp server README at b12608; numbers invented for the exercise.*

Requests arrive at about 0.2 per second; answers average 600 tokens at 25 tok/s
per stream. What is binding, and is it getting better or worse?

<details>
<summary>Reveal answer</summary>

Each request holds a slot for about 600 ÷ 25 = 24 s, so four slots finish at most
4 ÷ 24 ≈ 0.17 requests per second — less than the 0.2 arriving. The queue cannot
drain: deferred went from 6 to 11 in a minute and will keep growing, and TTFT
with it. Decode speed is fine, which is why the text streams normally once it
starts. Little's law asks for 0.2 × 24 ≈ 5 requests in service at once, so the
fix is more slots (each stream slows if that crosses the knee, which lengthens
the 24 s — recompute), shorter answers, or a second server.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** Two requests share their first 1,000 tokens and then
differ. For each case, how many prompt tokens are reused? (a) llama.cpp with
`-np 4`, the second request arriving after the first finished. (b) The same, but
the second arrives while the first is still generating. (c) vLLM v0.34.0 with the
default block size, in either timing.

<details>
<summary>Reveal answer</summary>

(a) About 1,000: the second request matches the idle slot that served the first.
(b) About none: that slot is busy, so the request takes another idle slot,
whose cache holds something else. (c) 960 in both timings: 15 full 64-token
blocks match, and the 40 tokens of the partial block are recomputed. vLLM shares
blocks across running requests; llama.cpp's reuse is a slot's own history.

</details>

</div>

## What to remember

- Below the knee, adding streams raises aggregate tokens/s almost N-fold at
  nearly constant per-stream speed; past it, per-stream speed falls and the
  aggregate flattens toward the prefill rate.
- `requests_processing` is the batch; `requests_deferred` is the queue. A
  deferred request's own `timings` look healthy — queue time lives in the
  client's clock.
- When requests arrive faster than the slots can finish them, the deferred
  gauge grows without bound while every per-request metric stays green.
- `prompt_n + cache_n` is the prompt length; reuse stops at the first token that
  differs from the slot's cached prompt, so a change at the start costs the
  whole prompt and a change at the end costs only what follows it.
- The chat template's own tokens come first; read them with `/apply-template`
  before you trust a prefix-cache design.

```quiz
[
  {
    "q": "A chat app's second turn shows cache_n 1 and prompt_n 1,850; the first turn's prompt was 1,700 tokens. The system prompt begins with a line 'Current time: 14:32:07'. What happened?",
    "choices": [
      "The timestamp changed between turns, so the prefix differed at its first tokens",
      "The second turn overflowed the slot's 2,048-token context, so the server flushed its cache",
      "Prompt caching is off by default and must be requested per call",
      "The second turn was routed to a slot with a smaller n_ctx"
    ],
    "answer": 0,
    "explain": "1,850 tokens is the whole history plus the new turn, recomputed: reuse stopped at token one. A per-second timestamp at the top changes on every request and invalidates everything after it. cache_prompt defaults to true, and a context overflow would show as truncation, not as a clean miss."
  },
  {
    "q": "At one stream a laptop decodes 47 tokens/s; with six concurrent streams each decodes 31 tokens/s. By what factor did aggregate throughput rise?",
    "choices": [
      "About 0.66×: each stream is a third slower, so the server does less",
      "About 6×: six streams share every weight read",
      "About 4×: 6 × 31 = 186 against 47",
      "About 1.5×: the per-stream ratio 47 ÷ 31 is the cost of batching"
    ],
    "answer": 2,
    "explain": "Aggregate = streams × per-stream speed = 186 tokens/s, about 4× the single stream's 47. It is not 6× because six tokens per step already exceed this machine's knee, so the step grew; per-stream slowdown alone says nothing about the total."
  },
  {
    "q": "A server runs with -np 3. Seven long requests arrive together. Midway through the first wave, what do the gauges read?",
    "choices": [
      "requests_processing 7 and requests_deferred 0, since continuous batching admits everyone",
      "requests_processing 3 and requests_deferred 4",
      "requests_processing 1 and requests_deferred 6, since slots are filled one at a time",
      "requests_processing 3 and requests_deferred 0, since excess requests are rejected"
    ],
    "answer": 1,
    "explain": "Three slots, three requests in service; the other four wait as deferred. Continuous batching lets requests join at step boundaries, but only into a free slot. Nothing is rejected: deferral is the queue, and it is what Little's law's 'in the system' counts beyond the slots."
  },
  {
    "q": "On vLLM v0.34.0 with its default 64-token blocks and prefix caching on, two prompts are identical for their first 200 tokens. How many tokens can the second reuse?",
    "choices": [
      "200, since every matching token is reused",
      "0, since only complete prompts are cached",
      "64, since only the first block is ever shared",
      "192: the three full blocks that match"
    ],
    "answer": 3,
    "explain": "Reuse is keyed per full block, and each block's hash chains from its parent's. Tokens 1–192 fill three complete matching blocks; tokens 193–200 sit in a block that also contains differing tokens, so it misses and is recomputed. llama.cpp's slot prefix match would reuse all 200 — when the request lands on that slot."
  },
  {
    "q": "A load generator claims eight concurrent users, yet llamacpp:n_busy_slots_per_decode reads about 1.0 and requests_deferred stays 0 on an 8-slot server. What is the likeliest explanation?",
    "choices": [
      "The prefix cache answered seven of the eight requests from memory",
      "The generator is sending its requests one after another",
      "The server is compute-bound, so its slots take turns on the GPU",
      "The metric only counts slots that are in prefill"
    ],
    "answer": 1,
    "explain": "One busy slot per decode call and an empty queue mean only one request is in the server at a time: the client is serialising (one connection, a sequential loop). A cache hit still occupies a slot while it generates, and compute-bound slots still share each decode call; that is the batching."
  }
]
```
