# Inference Engineering course — chapter style contract

Every chapter agent MUST follow this contract exactly. Read `distributed/content/raft.md` and `distributed/content/what-is-a-distributed-system.md` first to absorb the house voice.

## Audience

A smart, curious reader who may be **completely new to GPUs and ML**. They have systems intuition (they did the Linux kernel and distributed-systems courses on this site: they know processes, memory, caches, NUMA, scheduling, networks) but assume **zero** prior GPU or deep-learning knowledge beyond what *earlier chapters of this course* teach. The course is sequenced: never use a concept before its chapter without a one-line refresher + cross-link.

## Voice

- English. Second person, direct, confident. Vivid but never cute or hypey.
- Short paragraphs. Concrete before abstract. Numbers over adjectives.
- The distributed course's register: "After this chapter, etcd and friends stop being magic."
- Explain *why* something wins, not just *that* it exists. Every mechanism gets a motivation first ("here is the problem this solves").

## Structure (mandatory)

1. `# Chapter Title`
2. `> **Goal of this chapter:** ...` — 2–4 lines stating exactly what the reader will be able to do/understand after.
3. Body in `##` sections. Open with a hook: a concrete scenario, question, or surprising number — not a definition.
4. ASCII diagrams in ` ```text ` fenced blocks where a picture helps (the site has no Mermaid on this sub-site). Tables for comparisons.
5. **Worked numeric examples** wherever there is math: show the actual arithmetic with real model/hardware numbers the reader can redo.
6. A short recap section near the end (bulleted, titled e.g. `## What to remember`).
7. LAST element of the file: an interactive quiz block (see below).

## Quiz format (exact)

A fenced code block with language `quiz` containing a **valid JSON array** (no trailing commas, double quotes only, no comments). 4–5 questions. `answer` is the 0-based index of the correct choice. Wrong choices must be *plausible* (common misconceptions). `explain` teaches — it re-derives why the answer is right in 1–3 sentences, never just "see above".

```quiz
[
  {
    "q": "Question text?",
    "choices": ["choice 0", "choice 1", "choice 2", "choice 3"],
    "answer": 1,
    "explain": "Why 1 is correct, taught as a mini-lesson."
  }
]
```

## Pedagogy rules

- **Define every term at first use.** GPU, HBM, FLOP, tensor core, logits, softmax — everything. One clause is enough, but it must be there.
- **Intuition before formalism.** Analogy or scenario first, then the equation, then a worked example, then the caveats.
- **Misconception callouts:** where the dossier lists a common misconception relevant to your chapter, address it explicitly in a blockquote starting `> **Common trap:**`.
- **Honesty boxes:** claims that are volatile (prices, versions, benchmark numbers, "current SOTA") go in a blockquote starting `> **State of play (mid-2026):**` so future staleness is localized. Timeless math and established mechanisms stay in normal prose.
- **"What actually shipped":** where research and production diverge (the dossier flags these), say so plainly. This course's credibility depends on it.
- Real citations, sparingly: link primary sources (papers, official blogs) inline at the point of the claim. No link dumps. If the dossier flags a claim as vendor-marketing or thin sourcing, either verify it quickly (WebSearch) or hedge/omit it. Never state a flagged-uncertain claim as fact.

## Length

1,700–2,400 words (excluding the quiz block). Long enough to teach, short enough to finish in a sitting. If your scope doesn't fit, cut breadth, not depth — and cross-link to the chapter that owns the cut material.

## Cross-links

Link other chapters as `[Chapter Title](#/slug)`. The full course map (slug → title):

- Module 1 — Foundations: `what-is-inference` (What Actually Happens When You Call an LLM) · `gpu-mental-model` (The GPU Mental Model) · `inference-arithmetic` (Inference Arithmetic)
- Module 2 — The Engine: `continuous-batching` (Continuous Batching & Scheduling) · `paged-kv-cache` (PagedAttention & Prefix Caching) · `anatomy-of-an-engine` (Anatomy of a Serving Engine)
- Module 3 — Squeezing the Model: `attention-for-serving` (Attention Architectures for Serving) · `quantization` (Quantization) · `speculative-decoding` (Speculative Decoding)
- Module 4 — Under the Hood: `flashattention` (FlashAttention & Decode Kernels) · `kernels-and-compilation` (Kernels, Graphs & Compilation)
- Module 5 — Serving at Scale: `parallelism-for-inference` (Parallelism for Inference) · `moe-serving` (Serving MoE at Scale) · `disaggregation` (Disaggregated Serving & the KV Fabric) · `agentic-serving` (The Agentic Era)
- Module 6 — The Big Picture: `hardware-and-economics` (Hardware & Economics) · `frontier` (The Frontier, mid-2026)

## Scope discipline

Cover YOUR chapter's scope and nothing else. When you brush against another chapter's territory, one sentence + a cross-link, then move on. The chapter briefs define ownership; respect them so the course has no duplicated explanations.
