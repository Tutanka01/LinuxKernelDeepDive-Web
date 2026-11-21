# Inference Engineering — chapter contract, v2 (2026-10)

v1 (`STYLE.md`) produced chapters that were technically sound but read as
lectures: 3,600–5,000 words against a 2,400 target, the same nine-part
template 24 times, "the single most important fact" claimed in most
chapters, Linux "bridge" boxes that restated the paragraph above them, and
quizzes whose right answer was the longest choice 113 times out of 114.
v2 keeps what worked — worked numbers, real citations, the OS analogies,
volatile numbers fenced in "State of play" boxes — and changes how a
chapter teaches.

## The reader

Did the Linux course (or knows processes, virtual memory, caches,
scheduling). Zero GPU or deep-learning background beyond what earlier
chapters of *this* course teach. Never use a concept before the chapter that
owns it; when you must, one clause of definition plus a cross-link.

## One chapter, one question

Every chapter is organised around **one question the reader could not answer
before** — written as the first line after the title, in the Goal box. Every
section must move toward answering it. Material that answers a different
question is cut or moved to the chapter that owns it.

## Shape

There is no mandatory section list. There are mandatory *ingredients*:

1. `# Title`, then `> **The question:** …` (one sentence) and
   `> **You'll be able to:** …` (2–3 concrete capabilities, verbs you could
   test: *compute*, *predict*, *diagnose*, *choose*).
2. A hook that is a concrete situation or a number, never a definition.
3. **At least two `> [!predict]` callouts** at the moments a reader would
   otherwise just be told the answer. The prompt asks for a guess with a
   committed shape ("more or less than 10×?", "which resource runs out
   first?"). The answer comes in the *following prose*, never in the box.
4. **Worked numbers** the reader can redo, on the course's reference
   hardware and models (implementation-spec.md §6).
5. **`> [!case]` — the running case** (see below): one box per chapter,
   near the end, that applies the chapter to the case and records the
   decision it forces.
6. **Exercises:** at least two `<div class="exercise">` problems with a
   worked reveal. At least one must be quantitative; at least one must be a
   *diagnosis* (here are symptoms/metrics, what is binding, what do you do).
7. `## What to remember` — at most 6 bullets, each a claim, not a topic.
8. The quiz, last.

FAQs are optional (≤ 3, and only for questions a careful reader actually
asks). A Linux bridge is optional (≤ 1 per chapter) and only if it states
*what differs*; if the paragraph above already made the analogy, fold the
"what differs" into that paragraph instead of adding a box.

## Length

**2,200–3,200 words** excluding the quiz. If the scope does not fit, cut
breadth, not depth, and cross-link.

## Voice

- Second person, direct, calm. Numbers over adjectives.
- **Emphasis budget:** the course has exactly one "most important fact"
  (prefill is compute-bound, decode is memory-bound — owned by Inference
  Arithmetic). No other chapter calls anything "the single most important",
  "load-bearing", "the spine", "the punchline", "the whole chapter in one
  …". Show importance by consequence, not by announcement.
- Bold is for a term at its definition, or one claim per section at most.
  Target ≤ 8 bold spans per 1,000 words.
- No "Here is a fact that surprises everyone", no "Read that again", no
  "That's it." Open sections with the problem, not with a drumroll.
- Analogies are introduced once, then used; they are not re-announced.

## Callouts available

| marker | renders as | use for |
|---|---|---|
| `> [!predict] Before you read on` | "Predict first" | a committed guess before the reveal |
| `> [!case] The case: …` | running-case box | applying the chapter to the case |
| `> [!trap] …` | "Common trap" | a misconception readers actually hold |
| `> [!bridge] …` | "You already know this" | ≤ 1, must state what differs |
| `> [!prereq] …` | "Prerequisite" | a skippable refresher |
| `> [!note] …` | "Note" | an aside |
| `> **State of play (Month YYYY):**` | plain blockquote | anything that will date |

## The running case

Defined once in `inference/research/case.md`. Every chapter's `[!case]` box
must be consistent with it and with the decisions recorded by earlier
chapters. The capstone (Sizing a Deployment) closes it.

## Quizzes

4–5 questions, JSON as before. New rules, enforced by
`tests/tier1/quiz-quality.test.js`:

- **Position:** across a chapter, the correct index varies; across the
  course no index holds more than 35% of answers.
- **Length:** the correct choice is the strictly longest in at most 30% of
  questions course-wide. Write distractors at the same length and precision
  as the answer — a wrong answer that is specific and plausible.
- **Kind:** at most two pure recall questions per quiz. The rest are
  *compute* (a number from given inputs), *predict* (what happens if…),
  or *diagnose* (given these metrics, what is binding).
- `explain` re-derives the answer and names why the most tempting
  distractor is wrong.

## Facts

Unchanged from v1: primary sources inline, volatile claims in State-of-play
boxes, no flagged-uncertain claim stated as fact. When rewriting, keep every
number that v1 sourced unless you have verified it is wrong; do not
introduce a new number without a source or a derivation on the page.
