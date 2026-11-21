# Lab: Bits, Bytes and Drafts

> **The question:** do fewer bytes per weight really buy tokens per second on your
> machine, what do they cost in answers, and does speculation pay at batch 1?
>
> **You'll be able to:** predict decode speed across precisions from file sizes,
> and explain why the measurement departs from the prediction; count flips in a
> paired evaluation and say how many questions a claim would need; read
> acceptance from the speculation counters in `/metrics` and decide whether a
> draft pays for itself.

> **Not executed by the author.** Flags, endpoints, metric names and response
> fields come from the llama.cpp server README at build b12608 (2026-11-21); the
> quantization types from `tools/quantize`, `src/llama-quant.cpp` and
> `ggml/src/ggml-common.h`, and the speculation types from `docs/speculative.md`,
> all at the same build. Homebrew installs llama.cpp 1.0.0 (2026-11-13) — if a
> flag is rejected, `llama-server --help` is the authority. Expected results are
> described by shape, never as figures; the results table is yours to fill. The
> Python scripts that talk to a server were tested against a mock server that
> returns the documented formats, not against `llama-server`.

Squeezing the Model made three promises: fewer bits, faster decode; a price
paid silently in answers; more tokens per weight read from a good draft. This
lab tests all three on your machine, with the model from the first two labs.

**What you need:** [Lab: Your First Tokens](#/lab-first-tokens) done — your
nameplate bandwidth, `ttft_sweep.py`, and your knee; about 11 GB of free disk;
`python3`; about 75 minutes. The F16 file needs 6.4 GB of memory plus its KV
cache: on a 16 GB machine, close everything else.

---

## Stage 1: three files, three names

`llama-quantize` lists every type it can write, with the size and perplexity
cost its authors measured on an 8B model:

```cpp
    { "Q4_K_M",   LLAMA_FTYPE_MOSTLY_Q4_K_M,   " 4.58G, +0.1754 ppl @ Llama-3-8B",  },
    …
    { "Q8_0",     LLAMA_FTYPE_MOSTLY_Q8_0,     " 7.96G, +0.0026 ppl @ Llama-3-8B",  },
    { "F16",      LLAMA_FTYPE_MOSTLY_F16,      "14.00G, +0.0020 ppl @ Mistral-7B",  },
```

*Verbatim — llama.cpp b12608, `tools/quantize/quantize.cpp`, `QUANT_OPTIONS` (three of its rows).*

Note the `MOSTLY_`: most tensors, not all. The block layouts:

```c
#define QK8_0 32
typedef struct {
    ggml_half d;       // delta
    int8_t  qs[QK8_0]; // quants
} block_q8_0;
…
// 4-bit quantization
// 8 blocks of 32 elements each
// weight is represented as x = a * q + b
// Effectively 4.5 bits per weight
```

*Verbatim — llama.cpp b12608, `ggml/src/ggml-common.h` (the `block_q8_0` struct and the comment above `block_q4_K`).*

`Q8_0` stores 32 weights as 32 signed bytes plus one 16-bit scale: 8.5 bits
each, the element-plus-scale pattern from [Quantization](#/quantization).
`Q4_K` packs 256 weights into eight 32-weight blocks of 4-bit values, with
per-block scales and minimums stored in 6 bits: 4.5 bits each. `F16` is plain
16-bit floats. The `_M` is a recipe: at this build `src/llama-quant.cpp`
writes most tensors as `Q4_K` but promotes the attention value and MLP
down-projections in half of this model's 28 layers, and the output matrix
(tied to the input embedding), to `Q6_K`. Divide each file by its
3,212,749,888 parameters and the mixture shows: 5.03 bits per weight for
`Q4_K_M`, 8.52 for `Q8_0`, 16.02 for `F16`.

Fetch the two new files (stop each server once it is ready):

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q8_0 -c 8192 -np 1 -ngl all
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:F16 -c 8192 -np 1 -ngl all
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608.*

If `:F16` does not resolve (the file is `…-f16.gguf`), `-hff
Llama-3.2-3B-Instruct-f16.gguf` names it directly.

---

## Stage 2: bytes against tokens per second

> [!predict] Before you read on
> If decode is priced by bytes read, tokens/s × file size — your achieved
> bandwidth — is the same for all three files. From your `Q4_K_M` speed in the
> first lab, predict `Q8_0` and `F16`. And every file does the same 6.4 GFLOPs
> per prompt token: how much should prefill speed move?

Save this as `precisions.py`. Run it once per file, passing the file's tag and
your bandwidth in GB/s:

```python
#!/usr/bin/env python3
# One precision: median decode speed, prefill speed, and achieved bandwidth.
import json, statistics, sys, urllib.request

URL = "http://127.0.0.1:9931/completion"
SIZE = {"Q4_K_M": 2_019_377_696, "Q8_0": 3_421_899_296, "F16": 6_433_687_840}
quant, bw = sys.argv[1], float(sys.argv[2]) * 1e9     # e.g. Q8_0 307
PARA = ("The Rotterdam depot ships pallets to Hamburg every Monday and the "
        "trucks come back with empty crates on Wednesday. ")

def run(prompt, n):
    body = {"prompt": prompt, "n_predict": n, "ignore_eos": True, "cache_prompt": False}
    req = urllib.request.Request(URL, json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["timings"]

run("Warm-up.", 8)                                   # first request pays one-off costs
dec = statistics.median(run(f"Story {i}: a lighthouse keeper.", 128)["predicted_per_second"]
                        for i in range(3))
pre = run(PARA * 48 + "\nList every departure day.", 8)["prompt_per_second"]   # ~1,100 tokens
gbs = dec * SIZE[quant]                              # bytes read per second at batch 1
print(f"{quant:>7}: decode {dec:6.1f} tok/s   prefill {pre:7.1f} tok/s   "
      f"tok/s x size = {gbs / 1e9:5.1f} GB/s = {gbs / bw:4.0%} of nameplate")
```

*Runnable — Python 3 standard library only; run by the author against a mock server that speaks the documented llama.cpp format, not against llama-server, so no output is shown: the numbers are yours.*

The quantize README publishes the same experiment on Llama-3.1-8B (it does not
name the hardware):

```plaintext
| Measure                     | Q4_K_S       | Q4_K_M        | Q5_K_S       | Q5_K_M       | Q6_K          | Q8_0         |
| --------------------------- | ------------ | ------------- | ------------ | ------------ | ------------- | ------------ |
| bits/weight                 |       4.6672 |        4.8944 |       5.5704 |       5.7036 |        6.5633 |       8.5008 |
| size (GiB)                  |       4.36   |        4.58   |       5.21   |       5.33   |        6.14   |       7.95   |
| prompt processing t/s @ 512 | 818.55 ±9.58 | 821.81 ±21.44 | 752.52 ±0.99 | 758.69 ±7.43 | 812.01 ±10.82 | 865.09 ±8.30 |
| text generation t/s @ 128   |  76.71 ±0.20 |  71.93 ±1.52  |  69.53 ±0.18 |  67.23 ±1.08 |  58.67 ±3.13  |  50.93 ±0.08 |

| Measure                     | F16          |
| --------------------------- | ------------ |
| bits/weight                 |      16.0005 |
| size (GiB)                  |      14.96   |
| prompt processing t/s @ 512 | 923.49 ±0.53 |
| text generation t/s @ 128   |  29.17 ±0.04 |
```

*Verbatim — llama.cpp b12608, `tools/quantize/README.md`, "Quantization" (the last two tables).*

Multiply size by generation speed: 329 GiB/s for `Q4_K_M`, 405 for `Q8_0`, 436
for `F16`. The product is not constant; it climbs with the bit width. Prompt
processing moves 12% across a 3.3× range of bytes; generation moves 2.5×.

**What just happened:** expect your products to climb the same way, prefill
to barely move. Three reasons:

- **Unpacking costs arithmetic.** A 4-bit weight is expanded with its block's
  scale and minimum before the multiply, and a 4-bit byte carries 1.6 weights
  to unpack. F16 needs none.
- **Your knee is low.** With little arithmetic per byte of bandwidth, that
  extra work pushes a 4-bit step toward being compute-bound.
- **Fixed costs weigh most on the shortest step**: launches and sampling cost
  the same at every precision.

Prefill is priced in arithmetic, the same at every precision.

---

## Stage 3: what the bytes cost

> [!predict] Before you read on
> You will ask 20 multiplications at temperature 0, twice to `F16` and once to
> `Q4_K_M`. How many answers will differ between the two `F16` runs? Between
> `F16` and `Q4_K_M`, will every change go from right to wrong? How many
> one-way flips out of 20 would convince you?

Multi-digit arithmetic is a "close decision" of the kind rounding noise flips:
one carry, one digit. Save as `flips.py`:

```python
#!/usr/bin/env python3
# 20 fixed multiplications at temperature 0: "run FILE" saves answers, "compare A B" counts flips.
import json, math, re, sys, urllib.request

URL = "http://127.0.0.1:9931/v1/chat/completions"
QS = [(47 + 53 * i, 13 + 4 * i) for i in range(20)]       # 47 x 13 ... 1,054 x 89

def ask(a, b):
    body = {"messages": [{"role": "user", "content": f"What is {a} * {b}? Reply with the number only."}],
            "max_tokens": 16, "temperature": 0, "top_k": 1, "cache_prompt": False}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = json.load(r)["choices"][0]["message"]["content"]
    nums = re.findall(r"\d[\d,]*", text)                   # keep the last number
    return int(nums[-1].replace(",", "")) if nums else None

if sys.argv[1] == "run":
    json.dump([ask(a, b) for a, b in QS], open(sys.argv[2], "w"))
else:
    A, B = (json.load(open(f)) for f in sys.argv[2:4])
    ra = [x == a * b for x, (a, b) in zip(A, QS)]
    rb = [x == a * b for x, (a, b) in zip(B, QS)]
    b = sum(p and not q for p, q in zip(ra, rb))              # right -> wrong
    c = sum(q and not p for p, q in zip(ra, rb))              # wrong -> right
    n, k = len(QS), b + c                                     # k: discordant questions (flips)
    p = min(1.0, 2 * sum(math.comb(k, i) for i in range(min(b, c) + 1)) / 2 ** k) if k else 1.0
    se = math.sqrt(k - (c - b) ** 2 / n) / n                  # paired difference, as in the chapter
    print(f"correct {sum(ra)}/{n} vs {sum(rb)}/{n}   flips {k}: right->wrong {b}, wrong->right {c}")
    print(f"paired difference {(c - b) / n:+.0%} +/- {1.96 * se:.0%} (95%)   McNemar exact p = {p:.2f}")
```

*Runnable — Python 3 standard library only; run by the author against a mock server that speaks the documented llama.cpp format, not against llama-server, so no output is shown: the numbers are yours.*

With `F16` up: `python3 flips.py run f16-a.json`, then `run f16-b.json`. On
`Q4_K_M`: `run q4.json`. Then `compare f16-a.json f16-b.json` and `compare
f16-a.json q4.json`, all on one day (the chat template writes today's date
into every prompt). `top_k` 1 leaves one candidate, so sampling cannot differ;
`cache_prompt` off removes a nondeterminism the README warns of.

**What just happened:** `F16` against itself is your flip floor — expect zero
or nearly. Anything there is the stack's nondeterminism, to subtract from every
comparison. Against `Q4_K_M`, expect changes in *both* directions: the
quantized model gets some products right that the original got wrong, which is
why equal scores prove nothing.

Now apply the gate from [Did Quantization Break Your
Model?](#/did-quantization-break-your-model): the 95% interval of the paired
difference stays above −2 points, and flips stay at most twice the floor. Only
flips carry information, so they set the interval's width:

```text
   standard error of the paired difference  ≈  √(flips) ÷ n
   20 questions, 1 flip:    ± 1.96 × √0.95 ÷ 20  ≈  ± 10 points  →  fails "above −2"
   20 questions, 0 flips:   ± 0                                  →  passes
   smallest reliable drop (95%, 80% power)  ≈  2.8 × √(flip rate ÷ n)
       20 questions, 10% flips:  ≈ 20 points        1,500 questions, 5% flips:  ≈ 1.6 points
```

On 20 questions the gate reduces to "no flips at all", and McNemar's exact test
needs 6 flips, all one way, before p falls below 0.05. Twenty questions detect a model that
newly fails 6 of them, nothing subtler.

---

## Stage 4: the KV cache's own precision

> [!predict] Before you read on
> `-ctk q8_0 -ctv q8_0` stores keys and values in the `Q8_0` layout. What does
> one token of KV cost then (114,688 bytes at F16)? How much does `-c 32768`
> reserve? And how much faster should TPOT be at ~300 tokens of context, and at
> ~4,400?

The two flags, as the README defines them:

```plaintext
| `-ctk, --cache-type-k TYPE` | KV cache data type for K<br/>allowed values: f32, f16, bf16, f8_e4m3, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1<br/>(default: f16)<br/>(env: LLAMA_ARG_CACHE_TYPE_K) |
| `-ctv, --cache-type-v TYPE` | KV cache data type for V<br/>allowed values: f32, f16, bf16, f8_e4m3, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1<br/>(default: f16)<br/>(env: LLAMA_ARG_CACHE_TYPE_V) |
```

*Verbatim — llama.cpp server README at b12608, "Common params".*

Run the first lab's `ttft_sweep.py` against each of these:

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 32768 -np 1 -ngl all
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 32768 -np 1 -ngl all -ctk q8_0 -ctv q8_0
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608.*

**What just happened:** `q8_0` stores 34 bytes per 32 values, so a token costs
114,688 ÷ 2 × 34 ÷ 32 = 60,928 bytes, a little over half (`f8_e4m3` would be
exactly half). The startup log's KV line should drop from 3.5 GiB to about
1.9 GiB. TPOT moves only by the KV share of the bytes read: under 1% at 300
tokens, about 9% at 4,400 (2.02 GB of weights plus 0.50 GB of KV becomes 2.02
plus 0.27), about 22% at 16,000. A quantized cache is a capacity lever first,
and a speed lever only at long context.

If TPOT gets *worse*, your backend reads the quantized cache through a slow
path (`-fa`, default `auto`, picks it; the startup log reports a refused
combination). And test quality at the context length you serve: long-context
failures of a quantized cache appear only at length.

---

## Stage 5: a draft model

> [!predict] Before you read on
> The 1B draft file is 0.81 GB, the 3B target 2.02 GB: a draft step costs about
> `c = 0.40` of a target step. With 3 drafted tokens, how high must α (the
> probability a drafted token is accepted) be to break even? Will boilerplate
> code clear it? An open-ended story?

[Speculative Decoding](#/speculative-decoding) gave tokens per round as
`(1 − α^(γ+1)) ÷ (1 − α)` and the speedup as that divided by `1 + c·γ`. For
your measured `c`, save and run `breakeven.py`:

```python
#!/usr/bin/env python3
# Does a draft pay? Speedup = E ÷ (1 + c·γ), with E = (1 − α^(γ+1)) ÷ (1 − α).
import sys
c = float(sys.argv[1])                     # draft step time ÷ target step time
E = lambda a, g: sum(a ** i for i in range(g + 1))
print(f"draft cost c = {c:.2f}")
print("  γ   round cost   break-even α   speedup if α =  0.6   0.7   0.8   0.9")
for g in range(1, 6):
    lo, hi = 0.0, 1.0
    for _ in range(50):                    # bisect for E(α, γ) = 1 + c·γ
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if E(mid, g) < 1 + c * g else (lo, mid)
    row = "".join(f"{E(a, g) / (1 + c * g):6.2f}" for a in (0.6, 0.7, 0.8, 0.9))
    print(f"  {g}   {1 + c * g:10.2f}   {lo:12.2f}   {'':>12}{row}")
```

```plaintext
$ python3 breakeven.py 0.40
draft cost c = 0.40
  γ   round cost   break-even α   speedup if α =  0.6   0.7   0.8   0.9
  1         1.40           0.40                 1.14  1.21  1.29  1.36
  2         1.80           0.52                 1.09  1.22  1.36  1.51
  3         2.20           0.61                 0.99  1.15  1.34  1.56
  4         2.60           0.67                 0.89  1.07  1.29  1.58
  5         3.00           0.71                 0.79  0.98  1.23  1.56
```

*Runnable — Python 3 standard library only; output shown is from an actual run (c = 0.40 is the file-size ratio, 807,694,464 ÷ 2,019,377,696 bytes).*

At γ = 3, break-even is α ≈ 0.61, and even a perfect draft cannot pass
4 ÷ 2.2 = 1.8×; short drafts win unless acceptance is very high. Measure your
own `c`: run the 1B alone
(`-hf bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M`), send the first lab's
Stage 2 request, and divide the 3B's `predicted_per_second` by the 1B's (expect
more than 0.40: fixed costs weigh more on a small model).

Now start the target with the draft beside it (they share a tokenizer and chat
template, which a draft requires):

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 8192 -np 1 -ngl all --metrics \
  --spec-type draft-simple -hfd bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M -ngld all \
  --spec-draft-n-max 3
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608 (`--spec-draft-n-max` defaults to 3; the old `--draft*` flags are removed).*

The counters you will read, as the README defines them:

```plaintext
| `llamacpp:spec_decode_num_draft_tokens_total` | Counter | Total draft tokens generated (0 when spec-decode is off). |
| `llamacpp:spec_decode_num_accepted_tokens_total` | Counter | Total draft tokens accepted by the target model (0 when spec-decode is off). |
| `llamacpp:spec_decode_num_drafts_total` | Counter | Total speculative decoding verification steps (0 when spec-decode is off). |
| `llamacpp:spec_decode_num_accepted_tokens_per_pos_total` | Counter | Accepted tokens per draft position (labeled `position="N"`; absent when spec-decode is off or before the first completed speculative request). |
```

*Verbatim — llama.cpp server README at b12608, `/metrics`, "Available metrics" (four rows).*

Save `spec.py`, which scrapes them around one request (the counters are
server-wide, so send nothing else meanwhile):

```python
#!/usr/bin/env python3
# One request; read the speculation counters before and after it, and reconcile.
import json, re, sys, urllib.request

BASE = "http://127.0.0.1:9931"
TEXT = ("Halden's Rotterdam depot ships pallets to Hamburg every Monday. The trucks return on "
        "Wednesday with empty crates, which the yard team stacks by the north gate. Drivers log "
        "their hours before noon, and the dispatcher in Hamburg confirms each arrival by email. "
        "Late trucks are reported on Thursday, with the reason and the new arrival time in Hamburg.")
PROMPTS = {"code": "Write a Python dataclass Address with 12 string fields and a getter "
                   "and a setter method for each field. Code only.",
           "story": "Describe a dream you might have had, in strange and vivid detail.",
           "edit": "Repeat this text word for word, but write Bremen instead of Hamburg:\n\n" + TEXT}

def counters():
    txt = urllib.request.urlopen(BASE + "/metrics").read().decode()
    return {m[1]: float(m[2]) for m in re.finditer(r"^llamacpp:spec_decode_(\S+) (\S+)$", txt, re.M)}

before = counters()
body = {"messages": [{"role": "user", "content": PROMPTS[sys.argv[1]]}],
        "max_tokens": 400, "temperature": 0, "top_k": 1}
req = urllib.request.Request(BASE + "/v1/chat/completions", json.dumps(body).encode(),
                             {"Content-Type": "application/json"})
t = json.load(urllib.request.urlopen(req, timeout=600))["timings"]
d = {k: v - before.get(k, 0) for k, v in counters().items()}
drafts, drafted, acc = (d[f"num_{k}_total"] for k in ("drafts", "draft_tokens", "accepted_tokens"))
print(f"decode {t['predicted_per_second']:.1f} tok/s; {t['predicted_n']} tokens, {drafts:.0f} rounds")
if not drafts: sys.exit("no drafts counted: speculation is off (your baseline) or found nothing to draft")
pos = sorted((int(re.search(r"\d+", k)[0]), v) for k, v in d.items() if "per_pos" in k)
print(f"accepted / drafted = {acc / drafted:.2f}; mean draft length = {drafted / drafts:.2f}")
print(f"tokens per round: 1 + accepted/drafts = {1 + acc / drafts:.2f}")
print("accepted per round, by position:", "  ".join(f"{v / drafts:.2f}" for _, v in pos[:8]))
```

*Runnable — Python 3 standard library only; run by the author against a mock server that speaks the documented llama.cpp format, not against llama-server, so no output is shown: the numbers are yours.*

Run `python3 spec.py code` and `python3 spec.py story`. For the baseline, restart
without the speculation flags (keep `--metrics`) and run both again: the script
prints the speed and stops.

**What just happened:** a round is one verification step, the README's
"drafts". *Tokens per round*, `1 + accepted ÷ drafts`, is the measured `E`: each
round emits the accepted tokens plus one of the target's own. *Accepted per
round at position i* is the share of rounds in which the first i drafts all
survived, so the numbers must fall; the ratio of neighbours is each position's
conditional acceptance. The formula assumes one constant α, which in practice
decays by position: compare your `E` with the formula at the first-position
value. *Accepted ÷ drafted* is not α: it averages in the late positions. It is
the number llama.cpp's log prints:

```plaintext
draft acceptance rate = 0.57576 (  171 accepted /   297 generated)
```

*Verbatim — llama.cpp b12608, `docs/speculative.md`, "Statistics" (an example from the documentation, not a run of this lab).*

Expect code to accept far more than the story: twelve getters and setters are
predictable even to a 1B model. Against the baseline, expect the story slower
and the code modestly faster, if at all: the draft costs two-fifths of the
target, not a twentieth (the chapter's EAGLE-3 head is `c = 0.05`). And if 4
tokens is above your knee, the verification step itself costs more than one
decode step.

---

## Stage 6: drafts from the prompt itself

> [!predict] Before you read on
> An n-gram drafter costs almost nothing: it finds the last few tokens earlier
> in the text and proposes what followed them there. When the answer copies
> its input, what will α and the draft length be? On the story? And what does
> a 48-token draft cost to verify when your knee is a handful of tokens?

`ngram-simple` "looks for the last n-gram in history that matches the current
n-gram and creates a draft using the m tokens following the matched n-gram"
(12 and 48 by default). Restart with the documentation's example settings:

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 8192 -np 1 -ngl all --metrics \
  --spec-type ngram-simple --spec-draft-n-max 64
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608; settings from the `ngram-simple` example in `docs/speculative.md`.*

Run `python3 spec.py edit`, then `python3 spec.py story`, and compare both with
the baseline.

**What just happened:** on the edit, expect long drafts, high acceptance until
each edit point, and a speed above the baseline. On the story, expect few
rounds: n-gram speculation drafts only on a match. The cost side is the knee
again: a 49-token verification is a small prefill. With a knee of
10 tokens it costs about five decode steps, so each round must land about four
accepted tokens before it helps.

---

## Your results

| Measurement | Predicted | Measured |
|---|---|---|
| Decode tok/s: Q4_K_M / Q8_0 / F16 | | |
| tok/s × size (GB/s): Q4_K_M / Q8_0 / F16 | | |
| Prefill tok/s: Q4_K_M / Q8_0 / F16 | | |
| F16 vs F16: answers changed | | |
| Q4_K_M vs F16: right→wrong / wrong→right / 95% interval / McNemar p | | |
| KV reserved at `-c 32768`: f16 / q8_0 | | |
| TPOT at ~4,400 tokens: f16 / q8_0 KV | | |
| Draft cost `c` (3B tok/s ÷ 1B tok/s) | — | |
| Code, draft model: α / tokens per round / tok/s vs baseline | | |
| Story, draft model: α / tokens per round / tok/s vs baseline | | |
| Edit, n-gram: mean draft length / tokens per round / tok/s vs baseline | | |

> [!case] The case: the FP8 gate, in miniature
> On your laptop, halving the file on the same chip should raise tokens/s —
> Stage 2. On Halden's node FP8 does not do that: an FP8 TP=2 replica runs on
> half the GPUs, each still reading 35 GB per step as under BF16 TP=4, so its
> batch-1 step stays ~14 ms. FP8 buys a second replica — capacity and
> redundancy — not a faster token.
>
> **The stake** is the gate in [Did Quantization Break Your
> Model?](#/did-quantization-break-your-model): the 95% interval of the paired
> difference stays above −2 points, flips at most twice the BF16-against-BF16
> floor, generated tokens within ±5%. It replaced "within one point on 1,500
> questions" because 1,500 paired questions at 5% flips resolve only about
> 1.6 points — Stage 3's arithmetic at scale. Your 20-question run is the same
> gate, and it fails as any too-small evaluation does: the interval is too wide
> to clear −2. The floor clause can fail too: measured at concurrency 1, as
> here, the floor is likely zero, and "twice zero" rejects any changed answer.
>
> **What this records:** the floor is measured under production concurrency
> before the gate runs. Speculation, on only if a replay shows at least 1.5
> tokens per round and an A/B at concurrency 20 ([Load Testing](#/load-testing))
> confirms it, is judged by
> `1 + accepted ÷ drafts` — the line `spec.py` prints — never by a logged
> accepted ÷ drafted.

## Exercises

<div class="exercise">

**Exercise 1 — transfer.** A colleague serves the 3B at `F16` with the 1B
`Q4_K_M` draft. (a) Estimate `c`. (b) At γ = 3, where does it break even, and
what does α = 0.7 give? (c) Why does the same draft pay better here?

<details>
<summary>Reveal answer</summary>

```text
   (a)  c  =  807,694,464 ÷ 6,433,687,840  ≈  0.13
   (b)  round cost  =  1 + 0.13 × 3  =  1.39   →   break-even where 1 + α + α² + α³ = 1.39:  α ≈ 0.29
        α = 0.7:  E = 1 + 0.7 + 0.49 + 0.343 = 2.53   →   2.53 ÷ 1.39  ≈  1.8×
```

(c) Speculation trades draft steps for target steps, so what matters is the
cost ratio, not the draft's size: a heavy target makes every saved step worth
more. Halden's EAGLE-3 head goes further: a 4.9 GB file against 141 GB of
target, which [Speculative Decoding](#/speculative-decoding) rounds up to
`c = 0.05` for fixed costs.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** This lab's 3B target and 1B draft serve a chat
assistant with `--spec-draft-n-max 5`. Decode runs at 0.7× its speed without
speculation. The counter deltas over one long request:

```plaintext
llamacpp:spec_decode_num_draft_tokens_total 1500
llamacpp:spec_decode_num_accepted_tokens_total 291
llamacpp:spec_decode_num_drafts_total 300
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 150
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="1"} 76
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="2"} 37
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="3"} 19
llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="4"} 9
```

*Real format, illustrative values — metric names and the `position` label from the llama.cpp server README at b12608; numbers invented for the exercise.*

What are α and the tokens per round? Does the course's formula explain
the 0.7×, and what would you change?

<details>
<summary>Reveal answer</summary>

```text
   α  =  150 ÷ 300  =  0.5        (positions fall 0.50, 0.25, 0.12, 0.06, 0.03: independent)
   E  =  1 + 291 ÷ 300  =  1.97   (formula: (1 − 0.5⁶) ÷ 0.5 = 1.97)
   round cost  =  1 + 0.4 × 5  =  3.0   →   1.97 ÷ 3.0  ≈  0.66×
```

Yes: about 0.66× predicted, 0.7× seen; the logged accepted ÷ drafted would
read 0.19. The best setting, `--spec-draft-n-max 1`, gives about
1.5 ÷ 1.4 ≈ 1.07× — not worth a second model's memory. Turn speculation off
here, or try n-gram drafting if answers quote their input.

</details>

</div>

<div class="exercise">

**Exercise 3 — find the flaw.** A post claims: "Q4_K_M is as good as F16 and
3.2× faster. On our 20-question benchmark both scored 17/20 with default
settings, and the file is 3.2× smaller, so decode is 3.2× faster." Find the
errors before you open the answer.

<details>
<summary>Reveal answer</summary>

Four. *Equal scores hide flips*: 17/20 each can mean three lost, three
gained. *Twenty questions resolve almost nothing*: below 6 one-way flips the
McNemar test cannot separate the models. *Default settings* mean temperature 0.8,
so even `F16` against itself would show flips. *Speed does not scale with
bytes*: the quantize README's own table gives 2.5× generation speed for 3.3×
fewer bytes (`F16` to `Q4_K_M`, 8B model). The size ratio is an upper bound;
the speed has to be measured.

</details>

</div>

## What to remember

- Decode speed × file size is your achieved bandwidth, and it climbs with bit
  width: fewer bytes buy speed, but less than the ratio. Prefill barely moves.
- Measure quality as paired flips against a floor (the model against itself),
  and gate on the 95% interval of the paired difference. Its width,
  ≈ 1.96 × √(flips) ÷ n, means 20 questions catch only gross breakage.
- A quantized KV cache saves memory at every length, time only at long context.
- Tokens per round = 1 + accepted ÷ drafts; per-position counts ÷ rounds fall
  with position; accepted ÷ drafted is not α. A draft pays only when `E` beats
  `1 + c·γ`: easily at `c = 0.05` (an EAGLE-3 head), rarely at ~0.4 (a 1B
  draft for a 3B target).

```quiz
[
  {
    "q": "A Linux GPU decodes this lab's files at 95 tok/s (Q4_K_M, 2.02 GB), 70 tok/s (Q8_0, 3.42 GB) and 40 tok/s (F16, 6.43 GB). Which file uses the memory bandwidth best?",
    "choices": [
      "Q4_K_M, because the fastest file must be reading at the highest rate",
      "Q8_0, because 8-bit integers need no unpacking before the multiply",
      "F16, at about 257 GB/s against roughly 239 and 192",
      "All three equally, since batch-1 decode is always bandwidth-bound"
    ],
    "answer": 2,
    "explain": "Achieved bandwidth is tok/s × bytes read per token: 192, 239 and 257 GB/s. The fastest file reads the fewest bytes but uses the bus least efficiently, because unpacking and fixed per-step costs weigh more on its short step. Q8_0 still applies a scale per block of 32."
  },
  {
    "q": "Over one request, a server reports 200 rounds (spec_decode_num_drafts_total), 800 drafted tokens and 500 accepted tokens. How many tokens did each round produce on average?",
    "choices": [
      "0.63, the share of drafted tokens accepted",
      "3.5: one plus 500 ÷ 200",
      "2.5: 500 accepted ÷ 200 rounds",
      "4, the drafted tokens per round"
    ],
    "answer": 1,
    "explain": "Each round emits the accepted draft tokens plus one token from the target itself, so E = 1 + 500 ÷ 200 = 3.5. 0.63 is accepted ÷ drafted, which is neither α nor E. 2.5 forgets the target's own token; 4 is the draft length, the ceiling when everything is accepted."
  },
  {
    "q": "A team turns on -ctk q8_0 -ctv q8_0 for a chatbot whose prompts are about 400 tokens. TPOT is unchanged. What does that show?",
    "choices": [
      "At 400 tokens, KV is only about 2% of the bytes each step reads",
      "The flags were ignored, since a q8_0 cache should roughly halve TPOT",
      "The cache is still f16, because V cannot be quantized unless K is too",
      "Decode has become compute-bound, so the bytes read no longer matter"
    ],
    "answer": 0,
    "explain": "At 400 tokens the KV cache is about 46 MB against 2.02 GB of weights, so halving it changes the step by about 1%. The flags pay off in memory (more context or slots) at any length, and in TPOT only when context makes KV a large share of the bytes."
  },
  {
    "q": "A paired evaluation of 200 questions finds 9 answers that went right→wrong and 2 that went wrong→right. Is the loss established at the 5% level?",
    "choices": [
      "Yes: 7 net losses out of 200 is a 3.5-point drop",
      "Yes, because any one-sided pattern of flips is significant",
      "No, because only flips above twice the floor count as evidence",
      "No: McNemar's exact test on the 11 flips gives p ≈ 0.07"
    ],
    "answer": 3,
    "explain": "Only the 11 discordant questions carry information. If the models were equal, a 9–2 split or worse in either direction has probability 2 × (1 + 11 + 55) ÷ 2,048 ≈ 0.065. Suggestive, not established. The course's gate would still block the release: the paired difference is −3.5 ± 3.2 points, an interval reaching below −2. A gate asks whether a loss can be ruled out, not whether it is proven."
  },
  {
    "q": "Speculative Decoding prices an EAGLE-3 head for Llama-3.3-70B at c = 0.05 (a 4.9 GB file against 141 GB). Why can it pay at modest acceptance when this lab's 1B draft barely pays against its 3B target?",
    "choices": [
      "Because H100 tensor cores accept more draft tokens than a laptop GPU",
      "At c = 0.05 a γ = 3 round costs 1.15 target steps, not 2.2",
      "Because a 70B target has a higher acceptance rate for every draft",
      "Because BF16 drafts need no unpacking, unlike Q4_K_M ones"
    ],
    "answer": 1,
    "explain": "The draft's cost relative to the target sets the denominator 1 + c·γ: 1 + 0.05 × 3 = 1.15 for the head, 1 + 0.4 × 3 = 2.2 for the 1B draft. The head breaks even at 1.15 tokens per round; the 1B draft needs 2.2. Acceptance depends on how well the draft matches the target, not on the hardware — which is why Halden's decision still waits for a measured 1.5 tokens per round."
  }
]
```
