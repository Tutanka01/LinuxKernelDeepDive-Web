/* The Inference course's teaching contract
   (inference/research/STYLE-v2.md, extended by STYLE-v3.md).

   quizzes.test.js proves a quiz *works*. This file proves it *tests
   something*. Before v2, the right answer was the longest choice in 113 of
   114 questions and sat at index 1 in 93 of them: a reader could pass every
   checkpoint without reading a word, and since completion is gated on the
   quiz, the progress bar measured nothing.

   The chapter-shape assertions encode the rest of the contract — each
   chapter asks the reader to predict before it tells, carries the running
   case forward, has worked exercises, and (v3) shows the reader real
   artifacts with an honest provenance line — because those are the
   ingredients that drift out first when a chapter is edited in a hurry.

   Three kinds of page:
     reference — glossary, review, mixed-problems: not read in order, no contract
     lab       — lab-*.md: the lab shape (stages, predictions, a results table)
     regular   — everything else: the full v2 + v3 chapter contract

   Every rule is a pure function of the Markdown, and the self-check at the
   bottom runs each one against an in-memory fixture that must pass and a
   mutation that must fail. A green self-check means a red chapter is a real
   finding, not a regex accident. Failures are reported one test per chapter,
   each problem tagged with its rule id, plus an index by rule (a diagnostic,
   so it never double-counts) for routing the work. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { COURSE_BY_ID, read } = require("../lib/repo");
const { fencedBlocks, stripQuotes, headings } = require("../lib/markdown");
const { noProblems } = require("../lib/report");

const inf = COURSE_BY_ID.inference;

/* ---------------- page kinds ---------------- */

const REFERENCE = new Set(["glossary", "review", "mixed-problems"]);
const kindOf = slug => REFERENCE.has(slug) ? "reference" : slug.startsWith("lab-") ? "lab" : "regular";

/* ---------------- shared parsing ---------------- */

/* STYLE-v3 "Real artifacts": the info strings that count. `text` stays
   reserved for ASCII diagrams and formulas and is deliberately absent. */
const ARTIFACT_LANGS = new Set(["bash", "shell", "python", "json", "yaml", "ini", "c", "cpp", "diff", "plaintext"]);
const PROVENANCE = /^\*(Verbatim —|Real format, illustrative values —|Runnable —)/;

function quizIn(md) {
  const q = fencedBlocks(md).find(b => b.info === "quiz");
  if (!q) return [];
  try { const v = JSON.parse(q.body); return Array.isArray(v) ? v : []; } catch { return []; }
}

/* Line numbers (1-based) covered by any fence, quoted or not. */
function fenceLineSet(blocks) {
  const s = new Set();
  for (const b of blocks) for (let n = b.startLine; n <= b.endLine; n++) s.add(n);
  return s;
}

function proseText(md, blocks) {
  const inFence = fenceLineSet(blocks);
  return md.split("\n").filter((_, i) => !inFence.has(i + 1)).join("\n");
}

const countLines = (md, re) => md.split("\n").filter(l => re.test(l)).length;

/* The line that must carry an artifact's provenance: the next non-blank line
   after its closing fence, inside the same blockquote. Returns
   { text } or { error }. */
function provenanceLineAfter(lines, block) {
  if (block.unterminated) return { error: "the fence is never closed" };
  const depth = block.quoteDepth || 0;
  /* closedByContainer: endLine is the last content line; else the fence line */
  for (let i = block.endLine; i < lines.length; i++) {
    const raw = lines[i];
    if (depth === 0) {
      if (!raw.trim()) continue;
      return { text: raw.trim() };
    }
    if (!raw.trim()) return { error: "the blockquote ends right after the block — put the provenance line inside it (\"> *Verbatim — …*\")" };
    const q = stripQuotes(raw, depth);
    if (q.depth < depth) return { error: "the provenance line sits outside the blockquote the block is in" };
    if (!q.rest.trim()) continue;
    return { text: q.rest.trim() };
  }
  return { error: "nothing follows the block" };
}

/* "State of play (mid-2026)" and friends. Anything not a month ≥ November
   2026 (or a later year) is flagged, including an undated box. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function stateOfPlayProblems(prose) {
  const out = [];
  const re = /State of play\b(\s*\(([^)]*)\))?/g;
  let m;
  while ((m = re.exec(prose))) {
    const before = prose.slice(Math.max(0, m.index - 2), m.index);
    const label = m[2];
    if (label === undefined) {
      /* only the box marker form must carry a date, not a passing mention */
      if (before === "**") out.push(`undated "State of play" box — date it "(November 2026)"`);
      continue;
    }
    const d = /^\s*([A-Za-z]+)\.?\s+(\d{4})\s*$/.exec(label);
    const mi = d ? MONTHS.indexOf(d[1].slice(0, 3).toLowerCase()) : -1;
    const ok = d && mi >= 0 && (Number(d[2]) > 2026 || (Number(d[2]) === 2026 && mi >= 10));
    if (!ok) out.push(`"State of play (${label})" — boxes are dated November 2026 or later, by month and year`);
  }
  return out;
}

/* Parts of the course by number ("Module 4", "Part II"). Prose and quiz only:
   an artifact may legitimately contain anything. */
const PART_NUMBER = /\b(?:Modules?|Parts?)\s+(?:\d+|[IVX]+)\b/;

const BANNED = [
  /single most important/i,
  /\bload-bearing\b/i,
  /\bthe punchline\b/i,
  /\bRead that again\b/,
  /Here is a fact that surprises/i,
  /\bis the spine of\b/i,
  /whole chapter in one/i,
];

function voiceProblems(md, prose, quizBody, push) {
  for (const re of BANNED) {
    if (re.test(prose) || re.test(quizBody)) push("voice", `uses the inflated phrase ${re} — show importance by consequence`);
  }
  for (const text of [prose, quizBody]) {
    for (const line of text.split("\n")) {
      const m = PART_NUMBER.exec(line);
      if (m) push("part-number", `refers to a part of the course by number ("${m[0]}") — use its name`);
    }
  }
  for (const p of stateOfPlayProblems(prose)) push("state-of-play", p);
}

function hasTable(md, inFence) {
  const lines = md.split("\n");
  const SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  for (let i = 1; i < lines.length; i++) {
    if (inFence.has(i) || inFence.has(i + 1)) continue;
    const head = stripQuotes(lines[i - 1]).rest, sep = stripQuotes(lines[i]).rest;
    if (/\|/.test(head) && /\|/.test(sep) && SEP.test(sep)) return true;
  }
  return false;
}

/* ---------------- the contract ---------------- */

/* Returns [{ rule, msg }] — empty when the page meets its contract. */
function checkChapter(slug, md) {
  const kind = kindOf(slug);
  const out = [];
  const push = (rule, msg) => out.push({ rule, msg });
  if (kind === "reference") return out;

  const blocks = fencedBlocks(md, { blockquotes: true });
  const prose = proseText(md, blocks);
  const quiz = blocks.find(b => b.info === "quiz" && !b.quoteDepth);
  const qs = quizIn(md);
  const predicts = countLines(md, /^> \[!predict\]/);
  const cases = countLines(md, /^> \[!case\]/);

  if (!/^> \*\*The question:\*\*/m.test(md)) push("question", `no "> **The question:**" line`);
  if (predicts < 2) push("predict", `${predicts} [!predict] callout(s), need ≥ 2`);
  if (cases !== 1) push("case", `${cases} [!case] callout(s), need exactly 1`);
  if (qs.length < 4 || qs.length > 5) push("quiz-length", `${qs.length} quiz questions, need 4–5`);
  voiceProblems(md, prose, quiz ? quiz.body : "", push);

  if (kind === "lab") {
    if (!/^> \*\*Not executed by the author\.\*\*/m.test(md)) {
      push("lab-banner", `no "> **Not executed by the author.** …" banner under the goal box`);
    }
    const stages = headings(md).filter(h => h.level === 2 && /^Stage\b/.test(h.text)).length;
    if (stages < 4) push("lab-stages", `${stages} "## Stage" heading(s), need ≥ 4`);
    if (!hasTable(md, fenceLineSet(blocks))) push("lab-table", "no Markdown table — a lab needs a results table for the reader to fill in");
    return out;
  }

  /* regular chapter: v2 … */
  const words = prose.split(/\s+/).filter(Boolean).length;
  const exercises = (md.match(/class="exercise"/g) || []).length;
  const bridges = countLines(md, /^> \[!bridge\]/);
  if (exercises < 3) push("exercises", `${exercises} exercise(s), need ≥ 3 (quantitative, diagnosis, transfer)`);
  if (bridges > 1) push("bridge", `${bridges} [!bridge] boxes, at most 1`);
  if (words > 3600) push("length", `${words} words of prose, ceiling 3,600`);

  /* … and v3 */
  const lines = md.split("\n");
  const artifacts = blocks.filter(b => ARTIFACT_LANGS.has((b.info.split(/\s+/)[0] || "").toLowerCase()));
  if (artifacts.length < 2) {
    push("artifacts", `${artifacts.length} real artifact(s), need ≥ 2 (a fence in ${[...ARTIFACT_LANGS].join("/")})`);
  }
  for (const b of artifacts) {
    const after = provenanceLineAfter(lines, b);
    if (after.error) push("provenance", `the \`${b.info}\` block at line ${b.startLine}: ${after.error}`);
    else if (!PROVENANCE.test(after.text)) {
      push("provenance", `the \`${b.info}\` block at line ${b.startLine} is not followed by a provenance line ` +
        `("*Verbatim — …*", "*Real format, illustrative values — …*" or "*Runnable — …*"); found ${JSON.stringify(after.text.slice(0, 60))}`);
    }
  }
  const dashboards = countLines(md, /^> \[!dashboard\]/);
  if (dashboards > 1) push("dashboard", `${dashboards} [!dashboard] callouts, at most 1`);
  return out;
}

/* ---------------- the course ---------------- */

const slugs = inf.fileSlugs;
const results = slugs.map(slug => ({ slug, kind: kindOf(slug), problems: checkChapter(slug, read(inf.fileFor(slug))) }));

/* Quiz statistics run over every page that has a quiz, whatever its kind. */
const all = slugs.flatMap(slug => quizIn(read(inf.fileFor(slug))).map(q => ({ slug, ...q })));

test("Inference: the right answer is not given away by its position", () => {
  const problems = [];
  const counts = {};
  for (const q of all) counts[q.answer] = (counts[q.answer] || 0) + 1;
  for (const [idx, n] of Object.entries(counts)) {
    const share = n / all.length;
    if (share > 0.35) {
      problems.push(`index ${idx} is the right answer in ${n}/${all.length} questions ` +
                    `(${Math.round(share * 100)}%; ceiling 35%) — always guessing it beats reading`);
    }
  }
  for (const slug of slugs) {
    const qs = quizIn(read(inf.fileFor(slug)));
    if (qs.length >= 4 && new Set(qs.map(q => q.answer)).size < 3) {
      problems.push(`${slug}: answers use only ${new Set(qs.map(q => q.answer)).size} distinct ` +
                    `positions across ${qs.length} questions — vary them`);
    }
  }
  noProblems(problems, "quiz answer position");
});

test("Inference: the right answer is not given away by its length", () => {
  const longest = all.filter(q => {
    const L = q.choices.map(c => c.length);
    const max = Math.max(...L);
    return L[q.answer] === max && L.filter(x => x === max).length === 1;
  });
  const share = longest.length / Math.max(all.length, 1);
  const problems = [];
  if (share > 0.30) {
    problems.push(`the right answer is the strictly longest choice in ${longest.length}/${all.length} ` +
                  `questions (${Math.round(share * 100)}%; ceiling 30%). Worst offenders: ` +
                  [...new Set(longest.map(q => q.slug))].slice(0, 8).join(", "));
  }
  noProblems(problems, "quiz answer length");
});

/* One test per page, so a failure names the chapter to route it to. */
for (const r of results) {
  if (r.kind === "reference") continue;
  test(`Inference contract (v3, ${r.kind}): ${r.slug}`, () => {
    noProblems(r.problems.map(p => `[${p.rule}] ${p.msg}`), `${r.slug}.md`);
  });
}

/* The same failures, indexed by rule. Informational: it never fails (the
   per-chapter tests above already did), it tells the manager who owns what. */
test("Inference contract: failures indexed by rule (informational)", t => {
  const byRule = new Map();
  for (const r of results) {
    for (const p of r.problems) {
      if (!byRule.has(p.rule)) byRule.set(p.rule, new Set());
      byRule.get(p.rule).add(r.slug);
    }
  }
  if (!byRule.size) { t.diagnostic("no chapter breaks the contract"); return; }
  for (const [rule, set] of [...byRule].sort()) {
    t.diagnostic(`${rule} (${set.size}): ${[...set].join(", ")}`);
  }
});

/* ============================================================
   Self-check: every rule against a fixture.

   GOOD_* must pass with zero problems; each mutation must be caught by
   exactly the rule it targets. If a rule's regex rots, this is what fails —
   not 30 chapters at once for a reason nobody can see.
   ============================================================ */

const FILLER = "The step reads the weights once and every sequence in the batch shares that read. ";

const GOOD_CHAPTER = `# A Chapter

> **The question:** Why does the step take as long as it does?
>
> **You'll be able to:** compute a step time; diagnose a slow step.

A hook with a number: 14 ms. ${FILLER.repeat(3)}

> [!predict] Before you read on
> More or less than 10×?

${FILLER.repeat(4)}

> [!predict] And now
> Which resource runs out first?

\`\`\`bash
vllm serve meta-llama/Llama-3.3-70B-Instruct --tensor-parallel-size 4
\`\`\`

*Real format, illustrative values — flag names from vLLM v0.34.0; values from the case.*

${FILLER}

> [!note] A quoted artifact
> Read the count, not the rate.
>
> \`\`\`plaintext
> vllm:num_preemptions_total 12
> \`\`\`
> *Verbatim — vLLM v0.34.0, \`vllm/v1/metrics/loggers.py\`.*

\`\`\`text
an ASCII diagram, which is not an artifact and needs no provenance
\`\`\`

> **State of play (November 2026):** something volatile, mentioned once in "The Engine".

> [!dashboard] KV cache
> | | metric |
> |---|---|
> | utilisation | \`vllm:kv_cache_usage_perc\` |

<div class="exercise">

One.

</div>

<div class="exercise">

Two.

</div>

<div class="exercise">

Three.

</div>

> [!case] The case: Halden
> The decision.

## What to remember

- A claim.

\`\`\`quiz
${JSON.stringify([1, 2, 3, 4].map(i => ({ q: "Q" + i, choices: ["a", "b", "c"], answer: i % 3, explain: "e" })))}
\`\`\`
`;

const GOOD_LAB = `# Lab: First tokens

> **The question:** Does your laptop obey the same two numbers as the node?

> **Not executed by the author.** Commands are from llama.cpp b12608.

## Stage 1 — build

> [!predict] Before you run it
> How many tokens per second?

\`\`\`bash
cmake -B build
\`\`\`

## Stage 2 — measure

> [!predict] Again
> Prefill or decode, which is faster per token?

## Stage 3 — compare

| run | predicted | measured |
|---|---|---|
| 1 | | |

## Stage 4 — reconcile

> [!case] The case: Halden
> A miniature of the node.

\`\`\`quiz
${JSON.stringify([1, 2, 3, 4].map(i => ({ q: "Q" + i, choices: ["a", "b", "c"], answer: i % 3, explain: "e" })))}
\`\`\`
`;

/* [rule, description, mutate(md) → md] */
const CHAPTER_MUTATIONS = [
  ["question", "drop the question line", md => md.replace("> **The question:**", "> **Question:**")],
  ["predict", "only one [!predict]", md => md.replace("> [!predict] And now", "> [!note] And now")],
  ["case", "two [!case] boxes", md => md.replace("## What to remember", "> [!case] Again\n> More.\n\n## What to remember")],
  ["case", "no [!case] box", md => md.replace("> [!case] The case: Halden", "> [!note] The case: Halden")],
  ["exercises", "only two exercises", md => md.replace('<div class="exercise">\n\nThree.', "<div>\n\nThree.")],
  ["bridge", "two [!bridge] boxes", md => md.replace("## What to remember", "> [!bridge] A\n> x\n\n> [!bridge] B\n> y\n\n## What to remember")],
  ["length", "over 3,600 words of prose", md => md.replace("## What to remember", FILLER.repeat(260) + "\n\n## What to remember")],
  ["voice", "an inflated phrase", md => md.replace("A hook with a number", "The single most important number")],
  ["quiz-length", "a three-question quiz", md => md.replace(/```quiz\n.*\n```/, "```quiz\n" + JSON.stringify([1, 2, 3].map(i => ({ q: "Q" + i, choices: ["a", "b"], answer: i % 2, explain: "e" }))) + "\n```")],
  ["artifacts", "one artifact only (the other turned into text)", md => md.replace("```plaintext", "```text").replace("> *Verbatim — vLLM v0.34.0, `vllm/v1/metrics/loggers.py`.*", "> plain line")],
  ["provenance", "a top-level artifact without provenance", md => md.replace("*Real format, illustrative values — flag names from vLLM v0.34.0; values from the case.*", "Plain prose instead.")],
  ["provenance", "a provenance line with the wrong label", md => md.replace("*Real format, illustrative values —", "*Illustrative —")],
  ["provenance", "a quoted artifact whose provenance falls outside the quote", md => md.replace("> *Verbatim — vLLM v0.34.0", "\n*Verbatim — vLLM v0.34.0")],
  ["provenance", "a quoted artifact without provenance", md => md.replace("> *Verbatim — vLLM v0.34.0, `vllm/v1/metrics/loggers.py`.*", "> That is the counter.")],
  ["dashboard", "two [!dashboard] callouts", md => md.replace("## What to remember", "> [!dashboard] Again\n> x\n\n## What to remember")],
  ["part-number", "a part of the course by number", md => md.replace('mentioned once in "The Engine"', "mentioned once in Module 4")],
  ["part-number", "a part by number inside the quiz", md => md.replace('"q":"Q1"', '"q":"As Module 2 showed, Q1"')],
  ["state-of-play", "a box dated mid-2026", md => md.replace("State of play (November 2026)", "State of play (mid-2026)")],
  ["state-of-play", "a box dated before November 2026", md => md.replace("State of play (November 2026)", "State of play (October 2026)")],
  ["state-of-play", "an undated box", md => md.replace("**State of play (November 2026):**", "**State of play:**")],
];

const LAB_MUTATIONS = [
  ["question", "drop the question line", md => md.replace("> **The question:**", "> **Goal:**")],
  ["lab-banner", "no banner", md => md.replace("> **Not executed by the author.**", "> **Executed.**")],
  ["lab-stages", "three stages", md => md.replace("## Stage 4 — reconcile", "## Reconcile")],
  ["predict", "one [!predict]", md => md.replace("> [!predict] Again", "> [!note] Again")],
  ["case", "no [!case]", md => md.replace("> [!case] The case: Halden", "> [!note] Halden")],
  ["quiz-length", "a six-question quiz", md => md.replace(/```quiz\n.*\n```/, "```quiz\n" + JSON.stringify([1, 2, 3, 4, 5, 6].map(i => ({ q: "Q" + i, choices: ["a", "b", "c"], answer: i % 3, explain: "e" }))) + "\n```")],
  ["lab-table", "no table", md => md.replace("| run | predicted | measured |\n|---|---|---|\n| 1 | | |", "A list instead.")],
  ["state-of-play", "a stale box", md => md.replace("## Stage 4 — reconcile", "> **State of play (July 2026):** x\n\n## Stage 4 — reconcile")],
];

test("contract self-check: the fixtures pass", () => {
  assert.deepStrictEqual(checkChapter("a-chapter", GOOD_CHAPTER), [], "GOOD_CHAPTER should meet the regular contract");
  assert.deepStrictEqual(checkChapter("lab-first-tokens", GOOD_LAB), [], "GOOD_LAB should meet the lab contract");
  /* reference pages carry no contract at all */
  for (const slug of REFERENCE) assert.deepStrictEqual(checkChapter(slug, "# Anything\n\nno quiz"), []);
  /* a lab is not held to the chapter contract (no exercises, no artifacts) */
  assert.ok(checkChapter("a-chapter", GOOD_LAB).some(p => p.rule === "exercises"),
    "the lab fixture read as a regular chapter should lack exercises — the kinds are not being told apart");
  /* later months and years pass the state-of-play rule */
  for (const ok of ["December 2026", "Nov 2026", "January 2027"]) {
    assert.deepStrictEqual(stateOfPlayProblems(`> **State of play (${ok}):** x`), [], ok);
  }
});

for (const [kind, good, slug, mutations] of [
  ["chapter", GOOD_CHAPTER, "a-chapter", CHAPTER_MUTATIONS],
  ["lab", GOOD_LAB, "lab-x", LAB_MUTATIONS],
]) {
  test(`contract self-check: each ${kind} rule catches its violation`, () => {
    const misses = [];
    for (const [rule, what, mutate] of mutations) {
      const md = mutate(good);
      if (md === good) { misses.push(`${rule} / ${what}: the mutation did not change the fixture`); continue; }
      const rules = checkChapter(slug, md).map(p => p.rule);
      if (!rules.includes(rule)) misses.push(`${rule} / ${what}: not caught (got ${JSON.stringify(rules)})`);
      else if (rules.some(r => r !== rule)) misses.push(`${rule} / ${what}: caught, but also tripped ${JSON.stringify([...new Set(rules.filter(r => r !== rule))])}`);
    }
    noProblems(misses, `${kind} rule self-check`);
  });
}

test("contract self-check: fencedBlocks sees quoted fences only when asked", () => {
  const md = "> ```bash\n> echo hi\n> ```\n> *Verbatim — x*\n\n```quiz\n[]\n```\n";
  const plain = fencedBlocks(md);
  assert.deepStrictEqual(plain.map(b => b.info), ["quiz"],
    "default mode must keep ignoring fences inside blockquotes (quizzes.test.js and mermaid.test.js rely on it)");
  const deep = fencedBlocks(md, { blockquotes: true });
  assert.deepStrictEqual(deep.map(b => [b.info, b.quoteDepth, b.body, b.startLine, b.endLine]),
    [["bash", 1, "echo hi", 1, 3], ["quiz", 0, "[]", 6, 8]]);
  /* a blockquote that ends under an open fence closes it */
  const cut = fencedBlocks("> ```bash\n> a\n\nafter\n", { blockquotes: true });
  assert.strictEqual(cut.length, 1);
  assert.strictEqual(cut[0].closedByContainer, true);
  assert.strictEqual(cut[0].body, "a");
  /* a top-level fence's body keeps its own ">" lines verbatim */
  const top = fencedBlocks("```diff\n> quoted in a diff\n```\n", { blockquotes: true });
  assert.strictEqual(top[0].body, "> quoted in a diff");
});

module.exports = { checkChapter, kindOf };
