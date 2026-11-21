# Lab: Your First Tokens

> **The question:** do the two numbers this course is built on — bytes read per
> generated token, arithmetic per prompt token — predict what your own machine
> does?
>
> **You'll be able to:** read a `timings` object and split a request into its
> prefill and decode costs; predict a decode ceiling from a model file's size and
> a memory bandwidth, then report the fraction you achieved; measure your
> machine's knee and explain why it is not the H100's.

> **Not executed by the author.** Flags, endpoints and response fields come
> from the llama.cpp server README at build b12608 (2026-11-21); Homebrew
> installs llama.cpp 1.0.0 (2026-11-13) — if a flag is rejected, `llama-server
> --help` is the authority. Expected results are described by shape, never as
> figures; the results table is yours to fill. The Python scripts were tested
> against a mock server that returns the documented format, not against
> `llama-server`.

[Inference Arithmetic](#/inference-arithmetic) made two claims about an H100.
Decode reads every weight once per token, so its time is bytes ÷ bandwidth.
Prefill uses each weight read for every prompt token, so its time is FLOPs ÷
compute. This lab asks whether those claims survive contact with a laptop, a
4-bit model file and an engine you did not write — and where the knee moves
when the chip is not an H100.

**What you need:** an Apple Silicon Mac with 16 GB or more (the lab was written
for a 24 GB M5 Pro), or a Linux box with an NVIDIA GPU; about 2.1 GB of disk for
the model; `python3` and `jq`; about 45 minutes.

**The model** is Llama-3.2-3B-Instruct, the small sibling of the case's
Llama-3.3-70B: same tokenizer, same grouped-query attention with 8 KV heads,
same 128K context. From its `config.json`: 28 layers, 8 KV heads, head_dim 128,
3.21 billion parameters. You will run the `Q4_K_M` file from
`bartowski/Llama-3.2-3B-Instruct-GGUF`, 2,019,377,696 bytes, about 5 bits per
weight, in GGUF, llama.cpp's single-file format (weights, tokenizer and chat
template together).

---

## Stage 1: install and start the server

```bash
brew install llama.cpp
llama-server --version
```

*Real format, illustrative values — Homebrew formula `llama.cpp` (stable 1.0.0); not run by the author.*

On Linux with an NVIDIA GPU, take the prebuilt CUDA archive from the release
the README was pinned to (a CUDA 13.5 build sits next to it for newer drivers):

```bash
curl -LO https://github.com/ggml-org/llama.cpp/releases/download/b12608/llama-b12608-bin-ubuntu-cuda-12.8-x64.tar.gz
tar xzf llama-b12608-bin-ubuntu-cuda-12.8-x64.tar.gz    # llama-server is inside
```

*Real format, illustrative values — asset name from the b12608 release listing; not run by the author.*

Start the server. `-hf` downloads the file from Hugging Face on first use and
caches it; `-c` fixes the context size, which otherwise defaults to the model's
own 131,072; `-np 1` asks for one slot, one request at a time; `-ngl all` puts
every layer on the GPU.

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 8192 -np 1 -ngl all
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608.*

In a second terminal, wait for `{"status": "ok"}` and confirm what you got:

```bash
curl -s http://127.0.0.1:9931/health
curl -s http://127.0.0.1:9931/props | jq '.default_generation_settings.n_ctx, .total_slots'
```

*Real format, illustrative values — `/health` and `/props` as documented in the README at b12608.*

**What just happened:** the server mapped a 2 GB file, placed it where the GPU
reads it (on a Mac, the unified memory the CPU shares; on Linux, the GPU's own
DRAM) and reserved a KV cache for 8,192 tokens. At this build the default port
is **9931**, not the 8080 of older tutorials.

---

## Stage 2: two speeds in one request

> [!predict] Before you read on
> One request carries about a dozen prompt tokens and asks for 128 output
> tokens. The response reports two rates: prompt tokens per second and generated
> tokens per second. Which is larger — and by more or less than 10×?

Stream a response first, to watch the tokens arrive:

```bash
curl -sN http://127.0.0.1:9931/completion -H 'Content-Type: application/json' \
  -d '{"prompt": "A forklift, a pallet jack and a conveyor walk into a warehouse. Tell the story.", "n_predict": 128, "stream": true}'
```

*Real format, illustrative values — `/completion` and `stream` as documented in the README at b12608.*

Each `data:` line carries one token's text; the README specifies that a stream
returns only `content`, `tokens` and `stop` until the end, and the last line
carries the full response, `timings` included. To read the timings cleanly, ask
again without streaming and keep only that object:

```bash
curl -s http://127.0.0.1:9931/completion -H 'Content-Type: application/json' \
  -d '{"prompt": "Name three causes of late deliveries in road freight.", "n_predict": 128}' | jq .timings
```

*Real format, illustrative values — `timings` field of the `/completion` response, README at b12608.*

Before you read your own, read the README's. Look at the first two fields:

```json
  "timings": {
    "cache_n": 236, // number of prompt tokens reused from cache
    "prompt_n": 1, // number of prompt tokens being processed
    "prompt_ms": 30.958,
    "prompt_per_token_ms": 30.958,
    "prompt_per_second": 32.301828283480845,
    "predicted_n": 35, // number of predicted tokens
    "predicted_ms": 661.064,
    "predicted_per_token_ms": 18.887542857142858,
    "predicted_per_second": 52.94494935437416
  }
```

*Verbatim — llama.cpp server README at b12608, "Timings and context usage" (comments are the README's).*

That example is a prompt-cache hit: 236 tokens were reused and one was
evaluated, so its `prompt_per_second` of 32 measures one token's trip through the
model, not prefill. llama.cpp keeps a slot's previous prompt and, with
`cache_prompt` on (the default), evaluates only the suffix that differs: send
the same request twice and the second looks like the README's. Every prefill
measurement in this lab therefore sets `"cache_prompt": false`.

**What just happened:** `prompt_ms` is prefill — on an idle server it is your
TTFT minus HTTP and tokenization. `predicted_per_token_ms` is TPOT, and
`predicted_per_second` is its inverse. On a fresh prompt, expect
`prompt_per_second` to come out several times higher — for a prompt this short,
up to about as many times higher as the prompt has tokens. The whole prompt
rides through the weights in one pass, so a dozen tokens cost little more than
one weight read, while each output token pays for a full read of the file. A
short prompt therefore hides the real prefill rate; Stage 4 uses long ones.

---

## Stage 3: the decode ceiling, predicted then measured

> [!predict] Before you read on
> Look up your machine's memory bandwidth and divide the model file's size by
> it. That is the time to read every weight once — the floor under one decode
> step. Write down the ceiling in tokens per second before you measure.

**Find your bandwidth on the vendor's spec page, not in a forum.** Apple prints
it per chip: the M5 has 153 GB/s, the M5 Pro 307 GB/s, the M5 Max 460 or
614 GB/s depending on GPU core count
([M5 announcement](https://www.apple.com/newsroom/2025/10/apple-unleashes-m5-the-next-big-leap-in-ai-performance-for-apple-silicon/),
[M5 Pro and M5 Max announcement](https://www.apple.com/newsroom/2026/03/apple-debuts-m5-pro-and-m5-max-to-supercharge-the-most-demanding-pro-workflows/),
[MacBook Pro tech specs](https://www.apple.com/macbook-pro/specs/)). For an older
Mac, `system_profiler SPHardwareDataType` names the chip; look that chip up on
Apple's tech-specs page. On Linux, `nvidia-smi --query-gpu=name --format=csv`
names the GPU; its datasheet gives the bandwidth.

Then compute — save this as `ceiling.py` and pass your bandwidth in GB/s:

```python
#!/usr/bin/env python3
# Predict before you measure: Llama-3.2-3B-Instruct GGUF on your machine.
import sys
bw = float(sys.argv[1]) * 1e9                  # nameplate bandwidth, GB/s
ctx = int(sys.argv[2]) if len(sys.argv) > 2 else 4096
FILES = {"Q4_K_M": 2_019_377_696, "Q8_0": 3_421_899_296, "F16": 6_433_687_840}
P = 3_212_749_888                              # parameters (GGUF metadata)
KV = 2 * 28 * 8 * 128 * 2                      # K and V, layers, KV heads, head_dim, f16
print(f"prefill work : {2 * P / 1e9:.2f} GFLOP per prompt token")
print(f"KV cache     : {KV:,} B per token; {ctx:,} tokens = {KV * ctx / 2**20:,.0f} MiB")
for name, size in FILES.items():
    t = size / bw
    print(f"{name:>7}: {size / 1e9:.2f} GB per step -> floor {t * 1e3:5.2f} ms, "
          f"ceiling {1 / t:5.1f} tok/s; at {ctx:,} tokens of context "
          f"{(size + KV * ctx) / size - 1:.0%} more bytes")
```

```plaintext
$ python3 ceiling.py 307 4096
prefill work : 6.43 GFLOP per prompt token
KV cache     : 114,688 B per token; 4,096 tokens = 448 MiB
 Q4_K_M: 2.02 GB per step -> floor  6.58 ms, ceiling 152.0 tok/s; at 4,096 tokens of context 23% more bytes
   Q8_0: 3.42 GB per step -> floor 11.15 ms, ceiling  89.7 tok/s; at 4,096 tokens of context 14% more bytes
    F16: 6.43 GB per step -> floor 20.96 ms, ceiling  47.7 tok/s; at 4,096 tokens of context 7% more bytes
```

*Runnable — Python 3 standard library only; output shown is from an actual run (file sizes from the Hugging Face repository listing, 307 GB/s from Apple's M5 Pro specification).*

Read the `Q4_K_M` line for your bandwidth: on the M5 Pro the ceiling is about
150 tokens/s. The file stands in for "bytes read per step" because the model
ties its input embedding to its output layer, so even the 128,256-row vocabulary
matrix is read once per token. Now measure: run the request from Stage 2 three
times with different prompts and take the median `predicted_per_second`.

The achieved fraction is your lab's version of MBU (model bandwidth utilisation,
[Inference Arithmetic](#/inference-arithmetic)):

```text
   achieved bandwidth  =  predicted_per_second × 2.02 GB
   achieved fraction   =  achieved bandwidth ÷ nameplate bandwidth
```

**What just happened:** expect a fraction below 1 — the ceiling assumes every
byte streams at nameplate speed and nothing else costs time. If it lands at a
large share, "decode time is bytes ÷ bandwidth" held on your machine, and the
gap is per-step overhead (kernel launches, sampling) plus what a real read
sustains. The case's planning figure assumed 74%; published whole-engine
batch-1 figures are 50–60%. A small fraction means something besides the weights
is in the step — commonly layers left on the CPU (Exercise 2).

---

## Stage 4: TTFT and TPOT against prompt length

> [!predict] Before you read on
> You will send prompts of roughly 300, 1,100 and 4,400 tokens. If prefill is
> compute-bound, how should `prompt_ms` grow from the first to the last? And
> TPOT: flat, or rising — and if rising, by about how much at 4,400 tokens of
> context? (`ceiling.py` printed the number you need.)

Save this as `ttft_sweep.py` and run `python3 ttft_sweep.py` against the server
from Stage 1 (its `-c 8192` holds the longest prompt):

```python
#!/usr/bin/env python3
# Prefill time and decode pace against prompt length, from llama-server's timings.
import json, urllib.request

URL = "http://127.0.0.1:9931/completion"
PARA = ("The Rotterdam depot ships pallets to Hamburg every Monday and the "
        "trucks come back with empty crates on Wednesday. ")

def run(repeats):
    body = {"prompt": PARA * repeats + "\nList every departure day.",
            "n_predict": 64, "ignore_eos": True,
            "cache_prompt": False}            # time real prefill, not the cache
    req = urllib.request.Request(URL, json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["timings"]

run(4)                                        # warm-up, result discarded
print(f"{'prompt_n':>8} {'prompt_ms':>10} {'prompt t/s':>10} {'TPOT ms':>8} {'decode t/s':>10}")
for repeats in (12, 48, 192):
    t = run(repeats)
    print(f"{t['prompt_n']:>8} {t['prompt_ms']:>10.1f} {t['prompt_per_second']:>10.1f}"
          f" {t['predicted_per_token_ms']:>8.2f} {t['predicted_per_second']:>10.1f}")
```

*Runnable — Python 3 standard library only; run by the author against a mock server that speaks the documented llama.cpp format, not against llama-server, so no output is shown: the numbers are yours.*

`ignore_eos` makes every request generate exactly 64 tokens; `prompt_n` reports
the true prompt length.

**What just happened:** `prompt_ms` should grow close to linearly — roughly 4×
from each row to the next — because each prompt token costs the same
6.4 GFLOPs. Look at `prompt t/s` to see the departure from linear: expect it to
sag somewhat at 4,400 tokens. That is attention's own arithmetic, which grows
with the square of the prompt: relative to 2·P per token it adds about
`layers × T × d_model ÷ P` — under 1% at 300 tokens, about 12% at 4,400.

TPOT is the test of the other claim. At 4,400 tokens of context every decode
step also reads that sequence's keys and values: 4,400 × 114,688 bytes ≈ 0.5 GB,
a quarter as much again as the weights. If decode is bandwidth-bound, TPOT
should rise by roughly that fraction; if it rises much less, part of the step
was not waiting on memory. This is Inference Arithmetic's "attention does not
batch away" made visible: KV reads belong to one sequence and never amortise.

---

## Stage 5: your machine's knee

> [!predict] Before you read on
> On the case's node the effective knee — the number of tokens one step can
> carry before arithmetic, not the weight read, sets its time — is about 160.
> Will your laptop's be higher or lower, and by how much?

You already have both inputs. A batch-1 decode step costs one weight read,
`t_w = 1 ÷ predicted_per_second`. Each extra token in a step costs its
arithmetic, `t_c = 1 ÷ prompt_per_second` (from the 1,100-token row: long, but
little attention). A step carrying
`B` tokens costs about `max(t_w, B × t_c)`, the step-time model of
[Inference Arithmetic](#/inference-arithmetic), so the knee is where the two
are equal:

```text
   knee (tokens per step)  =  t_w ÷ t_c  =  prompt_per_second ÷ predicted_per_second
```

The case derives its ~160 exactly this way, from 14 ms ÷ 0.089 ms. Apple does not
print a FLOP/s figure for its GPUs on the pages above, so on a Mac this
measurement is the only ridge you will get. Two more numbers from the same
inputs: achieved compute is `prompt_per_second × 6.43 GFLOP`, and achieved
bandwidth you computed in Stage 3.

**What just happened:** expect a knee far below 160, for two reasons that
multiply. The chip has much less arithmetic per byte of bandwidth than an H100,
whose nameplate ridge is 295 FLOPs per byte. And the file stores about 0.63
bytes per weight, not BF16's 2, so each token in a step does 2 FLOPs for every
0.63 byte read: the knee in tokens is only about a third of the ridge in
FLOPs per byte, the same effect as the halving of B_crit for 8-bit weights in
Inference Arithmetic. The H100's "dozens of sequences ride along free" does
not transfer; [the next lab](#/lab-batching-and-cache) fires concurrent requests, and your knee predicts
when each stream starts to slow.

---

## Stage 6: the KV cache made visible

> [!predict] Before you read on
> The KV cache costs 114,688 bytes per token of context. How much memory does
> `-c 32768` reserve, compared with `-c 4096`? And if you start the server
> with no `-c` on a 16 GB machine, will you get the model's full 131,072?

Restart the server three times and compare what it reports:

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 4096 -np 1 -ngl all
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 32768 -np 1 -ngl all
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -np 1 -ngl all    # no -c
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608.*

Each time, search the startup log for the line that reports the KV cache buffer
it allocated (search for `KV`; the wording changes between builds), and read
`n_ctx` from `/props` as in Stage 1.

**What just happened:** `-c 4096` reserves 448 MiB and `-c 32768` 3.5 GiB — 8×,
because the reservation is per token of context, made at startup whether or not
a request ever uses it. The full 131,072 tokens would need 14 GiB, seven times
the weights; but `--fit`, on by default, "adjusts unset arguments to fit in device memory" and
may shrink the context down to `--fit-ctx` (default 4,096). On a 16 GB machine,
expect to be handed less than you would ask for — `n_ctx` tells you what. The
cache type is the other lever: `-ctk` and `-ctv` store K and V in 8-bit or
smaller formats, which [Lab: Bits, Bytes and Drafts](#/lab-squeezing) measures.

---

## Your results

| Measurement | Predicted | Measured |
|---|---|---|
| Nameplate bandwidth (GB/s) and its source | — | |
| Decode ceiling, Q4_K_M (tok/s) | | |
| `predicted_per_second`, short prompt (median of 3) | | |
| Achieved fraction (your MBU) | | |
| `prompt_ms` at ~300 / ~1,100 / ~4,400 tokens | | |
| TPOT at ~300 vs ~4,400 tokens of context | | |
| `prompt_per_second` at ~1,100 tokens | | |
| Knee = prompt t/s ÷ decode t/s | | |
| `n_ctx` granted with no `-c` | | |

> [!case] The case: the node in miniature
> Your laptop and Halden's node obey the same two numbers. Bytes per token: you
> read 2.02 GB per step; each H100 reads its 35 GB share, a 10.4 ms floor (the
> ladder's first rung) and ~14 ms as the planning figure (rung 3, assuming 74%
> of nameplate). Arithmetic per token: 6.4 GFLOPs here, 140 there. The knee you
> measured in Stage 5 is the same quantity as the node's ~160.
>
> **The stake:** 14 ms and 160 are estimates. How far below its ceiling could
> the node land before the plan fails? At 20 concurrent requests a step reads
> ~10.4 ms of weights plus ~1.5 ms of KV at nameplate bandwidth. Divided by the
> achieved fraction, plus ~1.7 ms of communication and launch overhead, that
> stays under the 60 ms TPOT promise down to about **20% of nameplate**. TPOT is
> safe; the knee is what a bad estimate moves, and it decides how much prefill a
> step absorbs before decodes slow.
>
> **What this records:** Halden's first act on the node repeats your Stages 3
> and 5 — decode tokens/s at concurrency 1, prefill tokens/s on a 3,000-token
> prompt — and replaces 14 ms and 160 with the two measured numbers before any
> other decision is revisited; [Load Testing](#/load-testing) builds the rest of
> that acceptance test.

## Exercises

<div class="exercise">

**Exercise 1 — transfer.** A colleague has a MacBook Pro with the 40-core M5
Max (614 GB/s). (a) What is the decode ceiling for the `Q8_0` file
(3,421,899,296 bytes)? (b) She proposes serving Llama-3.3-70B from it at the
same bits per weight as your `Q4_K_M` file. Estimate the ceiling, and say
whether one user could get Ask Halden's 60 ms TPOT.

<details>
<summary>Reveal answer</summary>

```text
   (a)  3.42 GB ÷ 614 GB/s  =  5.57 ms   →  ceiling ≈ 180 tok/s
   (b)  bytes per weight in Q4_K_M  =  2,019,377,696 ÷ 3,212,749,888  ≈  0.63
        70e9 × 0.63  ≈  44 GB  ÷  614 GB/s  ≈  72 ms   →  ceiling ≈ 14 tok/s
```

(b) misses the 60 ms promise before any overhead. The node's four H100s read
35 GB each in parallel at 3.35 TB/s; the laptop reads 44 GB through one
614 GB/s bus. Capacity is not the problem (128 GB holds the file); bandwidth is.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** A Linux box with an NVIDIA GPU of about 1 TB/s. The
launch line and one response:

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 8192 -np 1 -ngl 12
```

```json
{ "cache_n": 0, "prompt_n": 1104, "prompt_ms": 2911.0, "prompt_per_second": 379.2,
  "predicted_n": 128, "predicted_ms": 7111.1, "predicted_per_token_ms": 55.56,
  "predicted_per_second": 18.0 }
```

*Real format, illustrative values — flags and `timings` fields from the llama.cpp server README at b12608; numbers invented for the exercise.*

What fraction of the ceiling is this, and what is wrong?

<details>
<summary>Reveal answer</summary>

The ceiling is 2.02 GB ÷ 1 TB/s ≈ 2 ms, about 500 tok/s; 18 tok/s is under 4% of
it. `-ngl 12` put 12 of 28 layers on the GPU, so 16 layers — about 1.15 GB — are
read from host DRAM by the CPU every token. The step is the sum of the two parts: at a few tens of GB/s, 1.15 GB alone costs tens of milliseconds — the
55 ms you see. The fix is `-ngl all`; the lesson is that "bytes ÷ bandwidth"
applies per memory, and a step pays for its slowest one.

</details>

</div>

<div class="exercise">

**Exercise 3 — find the flaw.** A blog post argues: "On Apple Silicon, prefill
and decode run at the same speed, so the 'prefill is compute-bound' story is an
NVIDIA artefact." Its evidence, the second of two identical requests:

```json
{ "cache_n": 412, "prompt_n": 1, "prompt_ms": 24.1, "prompt_per_second": 41.5,
  "predicted_n": 200, "predicted_ms": 5263.2, "predicted_per_second": 38.0 }
```

*Real format, illustrative values — `timings` fields from the llama.cpp server README at b12608; numbers invented for the exercise.*

Find the errors before you open the answer.

<details>
<summary>Reveal answer</summary>

`cache_n` 412 and `prompt_n` 1: the prompt came from the slot's cache, and the
"prefill" was one token. One token through the model is one weight read — a
decode step — so it runs at decode speed. A second error hides behind it: even
uncached, a prompt of a few tokens sits below the knee and is priced by the
weight read. Prefill speed must be measured on hundreds of tokens, as in
Stage 4.

</details>

</div>

## What to remember

- llama.cpp's `timings` splits a request in two: `prompt_ms` is prefill (TTFT on
  an idle server), `predicted_per_token_ms` is TPOT. Check `cache_n` before you
  believe a prefill number.
- The decode ceiling is the bytes read per step ÷ the nameplate bandwidth from
  the vendor's spec page; measured tokens/s × bytes ÷ nameplate is your MBU.
- Prefill time grows about linearly with prompt length, bending upward as
  attention's quadratic term grows; TPOT rises with context by the share of KV
  bytes in the step.
- Your machine's knee is `prompt_per_second ÷ predicted_per_second` — the
  measured form of the case's 14 ÷ 0.089 ≈ 160. A laptop's is far lower, and
  low-bit weights lower it further.
- The KV cache is reserved for the whole `-c` at startup: 114,688 bytes per token
  for this model in F16. Read `n_ctx` to learn what you were given.

```quiz
[
  {
    "q": "An idle llama-server returns: cache_n 0, prompt_n 3000, prompt_ms 1500, predicted_n 250, predicted_ms 7500. What were this request's TTFT and TPOT, approximately?",
    "choices": [
      "TTFT about 9 s and TPOT about 3 ms, from total time over all 3,250 tokens",
      "TTFT about 1.5 s and TPOT about 30 ms per output token",
      "TTFT about 0.5 ms and TPOT about 7.5 s, from the per-token prompt cost",
      "TTFT about 1.5 s and TPOT about 2.3 ms, from 7,500 ms over 3,250 tokens"
    ],
    "answer": 1,
    "explain": "On an idle server TTFT is essentially prompt_ms, 1.5 s. TPOT is decode time per output token: 7,500 ms ÷ 250 = 30 ms. Dividing decode time by prompt plus output tokens mixes the two phases; prompt tokens do not take decode steps."
  },
  {
    "q": "A Linux GPU with 960 GB/s serves a Llama-3.1-8B Q4_K_M file of 4,912,898,304 bytes and decodes at 140 tokens/s at batch 1. What fraction of nameplate bandwidth is it achieving?",
    "choices": [
      "About 15%, since 140 tokens/s is small next to 960 GB/s",
      "Over 100%, since 8 billion weights × 2 bytes × 140 exceeds 960 GB/s",
      "About 50%, since half of each step is spent on compute",
      "About 72%: 4.91 GB × 140 per second ≈ 690 GB/s"
    ],
    "answer": 3,
    "explain": "Achieved bandwidth = bytes read per step × steps per second = 4.91 GB × 140 ≈ 688 GB/s, 72% of 960. Using 2 bytes per weight assumes BF16, but this file stores about 5 bits per weight — the 'over 100%' answer is the sign of using the wrong byte count. Comparing tokens/s with GB/s directly mixes units."
  },
  {
    "q": "For this lab's model (28 layers, d_model 3,072, 3.21B parameters), at roughly what prompt length does attention's extra prefill arithmetic reach half of the 2·P term?",
    "choices": [
      "About 19,000 tokens",
      "About 4,400 tokens",
      "About 1,100 tokens",
      "About 131,000 tokens"
    ],
    "answer": 0,
    "explain": "Relative to 2·P per token, attention adds about layers × T × d_model ÷ P. Setting 28 × T × 3,072 ÷ 3.21e9 = 0.5 gives T ≈ 18,700. At 4,400 tokens the term is only about 12%; 131,072 is the context limit, where attention would cost about 3.5× the matmuls."
  },
  {
    "q": "A new laptop chip doubles GPU arithmetic but keeps the same memory bandwidth. Running the same Q4_K_M file, what happens to decode tokens/s, prefill tokens/s and the knee?",
    "choices": [
      "Both speeds double and the knee is unchanged, since the ratio is preserved",
      "Decode doubles because dequantizing the 4-bit weights gets cheaper; prefill and knee unchanged",
      "Decode is about unchanged, prefill up to about doubles, and the knee about doubles",
      "Decode is unchanged, prefill is unchanged, and only the knee moves"
    ],
    "answer": 2,
    "explain": "Batch-1 decode is set by bytes ÷ bandwidth, which did not change. Long-prompt prefill is compute-priced, so it speeds up with arithmetic. The knee is prefill rate ÷ decode rate, so it rises with the compute. Doubling decode would need more bandwidth or fewer bytes, not more FLOPs."
  },
  {
    "q": "On the same server, a request with 30,000 tokens of context decodes at about 2.5× the TPOT of a request with 300. With this model's 114,688 bytes of KV per token and a 2.02 GB file, what does that say?",
    "choices": [
      "Decode has turned compute-bound, since long contexts add FLOPs to every step",
      "It fits bandwidth-bound decode: the step now reads about 2.7× the bytes",
      "The server is swapping the KV cache to disk at long contexts",
      "Something is misconfigured, since TPOT should not depend on context"
    ],
    "answer": 1,
    "explain": "At 30,000 tokens each step reads 2.02 GB of weights plus 30,000 × 114,688 ≈ 3.4 GB of KV, about 5.5 GB against 2.05 GB at 300 tokens — 2.7× the bytes, so a 2.5× TPOT is what bytes ÷ bandwidth predicts. Attention FLOPs per decode step stay tiny; KV reads, not arithmetic, grew."
  }
]
```
