# Inference Engineering — chapter contract, v3 (2026-11)

v2 (`STYLE-v2.md`, still in force for everything not restated here) fixed how a
chapter *teaches*: one question, predictions, a running case, exercises. A
cold-reader audit of all 25 chapters in November 2026 found what v2 left out:

- **No contact with reality.** Not one command, log line, metrics scrape,
  config file or line of source code in 72,000 words. Capabilities such as
  "read a preemption log" were promised and never shown.
- **Practice that replays.** Most quiz questions repeated a `[!predict]` or an
  exercise with the same numbers; almost no problem asked the reader to carry
  an idea to a model, chip or workload the chapter had not worked.
- **Two cost models.** Hybrid steps were priced as prefill + decode in some
  chapters and by the roofline in others; the decode step was 10.4, 12.3, 14
  or 16 ms without ever being presented as one ladder.
- **Mechanisms stated wrong** in a handful of places (verified against
  primary sources before fixing — see `case.md` v3 for the ones that moved
  case numbers).
- **A case with no stakes** in the early chapters: every box concluded that
  everything was fine.

v3 adds what an expert has that a well-read person does not: they have seen the
real thing, and they can reason about a situation nobody worked for them.

## Version pin

Engine facts are verified against **vLLM v0.34.0 (2026-11-16)**. Other pins:
llama.cpp 1.0.0 / build b12608, SGLang v0.5.23, Dynamo v1.6.2, llm-d v1.0.0,
TensorRT-LLM v1.3.0. A claim about an engine's behaviour, default or flag names
the version it was checked against the first time it appears in a chapter
("in vLLM v0.34"). "State of play" boxes are dated **November 2026**.

## Real artifacts (new, mandatory)

Every chapter carries **at least two** real artifacts: a fenced block in one
of `bash`, `shell`, `python`, `json`, `yaml`, `ini`, `c`, `cpp`, `diff`,
`plaintext` (`text` stays reserved for ASCII diagrams and formulas, and is not
an artifact). Each artifact is followed by a one-line provenance note in
italics, using exactly one of three labels:

- *Verbatim — vLLM v0.34.0, `vllm/v1/metrics/loggers.py`.* Copied from a
  pinned primary source (source code, official docs, a model repo's
  `config.json`, a paper's table). Trim with `…`, never paraphrase inside the
  fence.
- *Real format, illustrative values — …* The field names, flag names, log
  format or metric names are copied from the pinned source; the numbers are
  computed from the running case, not measured. Say so every time.
- *Runnable — Python 3 standard library only; output shown is from an actual
  run.* A short program (≤ 30 lines) the reader can paste. The author runs it
  and pastes the true output.

Never present a number as measured unless a cited source measured it. Nobody
has run this course's case on four H100s; the course says so.

An artifact is taught, not decorated: the prose before it says what to look
for, the prose after it reads one line of it the reader would have missed.

## The dashboard row (new, ≤ 1 per chapter)

`> [!dashboard] …` records the chapter's row of the serving **USE grid**
(utilisation / saturation / errors — the reader knows USE from the Linux
course): the resource this chapter is about, and the real metric that shows
each column, by its exact name (`vllm:kv_cache_usage_perc`,
`vllm:num_requests_waiting`, `vllm:num_preemptions`, DCGM field names …).
If no metric exists for a cell, write "none — you must derive it from …";
an honest "?" is the point of the method. *Operating It* assembles the rows.

## Promises and practice

- **2–4 capabilities** in "You'll be able to", and each one is exercised by an
  exercise or a quiz question in the chapter. Cut the promise or add the
  practice.
- **At least three exercises:** one quantitative; one *diagnosis* that shows
  its symptoms as an artifact (a metrics scrape, a log excerpt, a table of
  measurements) rather than describing them; one **transfer** problem set on a
  model, chip or workload the chapter did not work (a different `config.json`,
  an A100 or a Rubin, an embedding workload, a 1M-token context …).
- **Find the flaw.** Each module has at least one exercise that presents a
  plausible, wrong piece of work — a capacity memo, a launch line, a benchmark
  claim, a postmortem — and asks the reader to find the errors before the
  reveal.
- **Quiz:** no question reuses the scenario and numbers of a `[!predict]` or an
  exercise of the same chapter. At least two questions are set in a situation
  the chapter did not work. The v2 rules on position, length and kind stand.

## One cost model, one ladder

`case.md` defines the step-time model (`step ≈ max(t_w, t_c) + t_kv`), the
decode-time ladder (10.4 → 12.3 → 14 → 16 ms, each rung named) and the
difference between the nameplate critical batch (~295) and the effective knee
on the case's node (~160 tokens per step). A chapter that prices a step uses
that model and names the rung. *Inference Arithmetic* owns the derivation;
other chapters cite it instead of re-deriving it.

Wherever the course gives an estimate, it says how the reader would replace it
with a measurement (which command, which metric).

## The case has stakes

A `[!case]` box records a decision that could have gone the other way, or a
way the plan fails — never only "the promise is met with margin". If the
honest answer is "nothing to decide here", the box says what would have to
change for the chapter to matter to Halden, with the number.

## Cross-references

Refer to parts of the course by name ("The Engine", "Serving at Scale"),
never by number ("Module 4"). The first use of a term owned by a later chapter
gets one clause of definition and a link.

## Labs

Lab chapters (`lab-*.md`) follow the Linux course's lab shape — numbered
stages, each with a command, what to expect, and "what just happened" — with
three additions:

- A banner directly under the goal box:
  `> **Not executed by the author.** …` naming the tool version the commands
  were taken from. Expected results are described by **shape** (which number is
  larger, by roughly what factor, what the curve does), never as invented
  figures.
- Every stage that measures something opens with a `[!predict]` asking the
  reader to compute the expected value on their own machine first, and closes
  by reconciling prediction and measurement.
- A results table for the reader to fill in.

Labs run on a laptop (llama.cpp); they exist so that the reader meets the
course's central claims on hardware they can touch, and learns to redo the
arithmetic for a machine that is not an H100.

## Length

Unchanged: 2,200–3,200 words of prose, ceiling 3,600; fenced blocks do not
count. A chapter below the floor has room for its artifacts and its transfer
exercise.
