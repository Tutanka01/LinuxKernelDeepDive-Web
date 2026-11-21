/* The review deck's generators (inference/assets/inf-review.js).

   Each card is a function that invents a fresh problem from a seed. A
   generator that, for one seed in fifty, divides by zero or prints
   "undefined" into its prompt fails the way this site always fails —
   silently: the reader is told the right answer is NaN, or is marked
   wrong for typing the right number. So every generator is run over
   200 seeds here, and a handful are pinned to the running case's own
   numbers (inference/research/case.md), which is the truth the chapters
   are being reconciled against.

   The module is a browser script that also exports under Node; nothing
   in it may touch the DOM before its `document` guard. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { COURSE_BY_ID, abs, read } = require("../lib/repo");
const { noProblems } = require("../lib/report");

const R = require(abs("inference/assets/inf-review.js"));
const inf = COURSE_BY_ID.inference;

const SEEDS = 200;
/* not chapters a formula is taught in */
const NOT_TEACHING = new Set(["glossary", "review", "mixed-problems"]);

const near = (actual, expected, rel, what) => {
  const err = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(err <= rel,
    `${what}: got ${actual}, expected ${expected} (±${rel * 100}%) — off by ${(err * 100).toFixed(2)}%`);
};

test("Review deck: the bank is large, ids are unique, and every generator names a teaching chapter", () => {
  const problems = [];
  const gens = R.generators;
  if (gens.length < 25) problems.push(`only ${gens.length} generators; the deck should cover the whole course (~30)`);
  const seen = new Set();
  for (const g of gens) {
    if (!/^[a-z0-9-]+$/.test(g.id || "")) problems.push(`generator id ${JSON.stringify(g.id)} is not a slug`);
    if (seen.has(g.id)) problems.push(`duplicate generator id "${g.id}" — two cards would share one schedule entry`);
    seen.add(g.id);
    if (!inf.slugs.includes(g.chapter)) {
      problems.push(`${g.id}: chapter "${g.chapter}" is not a slug in inference/assets/inf.js — ` +
                    `the card could never become eligible`);
    } else if (NOT_TEACHING.has(g.chapter)) {
      problems.push(`${g.id}: chapter "${g.chapter}" is reference material, not where a formula is taught`);
    }
    if (!g.title || typeof g.title !== "string") problems.push(`${g.id}: no title`);
    for (const fn of ["draw", "solve", "make"]) {
      if (typeof g[fn] !== "function") problems.push(`${g.id}: ${fn} is not a function`);
    }
  }
  noProblems(problems, "review-deck bank");
});

test(`Review deck: every generator × ${SEEDS} seeds yields a finite positive answer and clean text`, () => {
  const problems = [];
  const realRandom = Math.random;
  Math.random = () => { throw new Error("make() called Math.random — use the seeded rng it is given"); };
  try {
    for (const g of R.generators) {
      const prompts = new Set();
      let reported = 0;
      const report = msg => { if (reported++ < 3) problems.push(msg); };
      for (let seed = 0; seed < SEEDS; seed++) {
        let p;
        try {
          p = g.make(R.mulberry32(seed));
        } catch (err) {
          report(`${g.id} seed ${seed}: make() threw — ${err.message}`);
          continue;
        }
        const where = `${g.id} seed ${seed}`;
        if (typeof p.answer !== "number" || !isFinite(p.answer) || !(p.answer > 0)) {
          report(`${where}: answer is ${p.answer} — must be a finite number > 0 (relative grading divides by it)`);
        }
        for (const field of ["prompt", "solution", "unit"]) {
          const s = p[field];
          if (typeof s !== "string" || !s.trim()) { report(`${where}: ${field} is empty`); continue; }
          if (/undefined|NaN|Infinity|\[object/.test(s)) report(`${where}: ${field} contains a broken value: ${s.slice(0, 160)}`);
        }
        if (!(p.tolerance > 0 && p.tolerance <= 0.25)) report(`${where}: tolerance ${p.tolerance} outside (0, 0.25]`);
        /* the worked solution has to land on the number the reader is graded against */
        if (typeof p.solution === "string" && !p.solution.includes(R.fmt(p.answer))) {
          report(`${where}: the solution never states the graded answer ${R.fmt(p.answer)}:\n      ${p.solution.replace(/\n/g, "\n      ")}`);
        }
        prompts.add(p.prompt);
      }
      /* "never asks the same thing twice" — at least, not often */
      if (prompts.size < 10) problems.push(`${g.id}: only ${prompts.size} distinct prompts over ${SEEDS} seeds`);
    }
  } finally {
    Math.random = realRandom;
  }
  noProblems(problems, "review-deck generator output");
});

test("Review deck: a seed reproduces its card exactly", () => {
  const problems = [];
  for (const g of R.generators) {
    const a = g.make(R.mulberry32(1234)), b = g.make(R.mulberry32(1234));
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${g.id}: the same seed produced two different cards`);
  }
  noProblems(problems, "review-deck determinism");
});

/* ---------------- oracles: the running case (case.md v3) ---------------- */

test("Review deck: formulas reproduce the running case's derived numbers", () => {
  const F = R.formulas;
  assert.strictEqual(F.kvBytesPerToken(80, 8, 128, 2), 327680, "KV per token, 80 × 8 × 128 × BF16");
  assert.strictEqual(F.kvBytesPerToken(80, 8, 128, 1), 163840, "FP8 KV per token");
  near(F.kvPoolGB(320, 0.90, 140, 16), 132, 1e-9, "KV pool, 0.90 × 320 − 140 − 16 (vLLM v0.34 semantics)");
  near(F.kvPoolGB(160, 0.90, 70, 8), 66, 1e-9, "KV pool per FP8 TP=2 replica");
  near(F.little(1.5, 4.3), 6.45, 1e-9, "Little: 1.5 req/s × 4.3 s");
  near(F.specExpected(0.8, 4), 3.3616, 1e-9, "speculative yield, α 0.8 γ 4");
  near(F.decodeFloorMs(35, 3.35), 10.4, 0.01, "decode floor, 35 GB ÷ 3.35 TB/s");
  near(F.prefillMs(70, 3000, 4, 990, 0.4), 270, 0.03, "prefill of 3,000 tokens");
  near(F.msPerToken(70, 4, 990, 0.4), 0.089, 0.01, "t_c per token");
  near(F.criticalBatch(990, 3.35), 295, 0.01, "nameplate B_crit");
  near(F.stepMs(14, 0.089, 512 + 20, 1.7), 49, 0.03, "hybrid step, 512 chunk + 20 decodes (~50 ms)");
  near(F.kvReadMs(327680 / 4, 2.85, 20 * 3000), 1.7, 0.03, "t_kv at 20 × 3K tokens");
  assert.strictEqual(F.maxSequences(132, 327680, 3250), 123, "phase-1 requests that fit in the pool");
  near(F.nodeMonthly(4, 2.5), 7300, 1e-9, "node price per month");
  near(F.apiMonthly(12000, 3000, 250, 3, 15), 4590, 1e-9, "phase-1 API bill (~$4,600)");
  assert.strictEqual(F.fullBlocks(800, 16), 50, "800-token system prompt in 16-token blocks");
  near(F.expertsTouched(8, 256, 64), 0.87, 0.01, "experts touched at batch 64, top-8 of 256");
  near(F.breakevenUtil(5, 2000, 3), 0.23, 0.02, "break-even utilisation, $5/h vs $3/M");
});

test("Review deck: generators fed the case's inputs give the case's answers", () => {
  const g = R.byId;
  const BF16 = { name: "BF16", bytes: 2 };
  const H100 = R.chips.find(c => c.name.startsWith("H100"));

  near(g["kv-per-token"].solve({ layers: 80, kv: 8, q: 64, hd: 128, dt: BF16 }).answer, 327.68, 1e-9,
    "kv-per-token, Llama-3.3-70B in KB");
  near(g["kv-pool"].solve({ chip: H100, gpus: 4, f: 0.9, P: 70, dt: BF16, oh: 3, act: 1 }).answer, 132, 1e-9,
    "kv-pool on the Halden node");
  near(g["little-in-flight"].solve({ rate: 1.5, ttft: 0.3, outTok: 250, tpot: 16 }).answer, 6.45, 1e-9,
    "little-in-flight at Halden's peak");
  near(g["spec-expected"].solve({ alpha: 0.8, gamma: 4 }).answer, 3.36, 0.001, "spec-expected");
  near(g["kv-per-sequence"].solve({ layers: 80, kv: 8, hd: 128, dt: BF16, inTok: 3000, outTok: 250 }).answer,
    1.07, 0.01, "kv-per-sequence, one phase-1 request");
  near(g["decode-floor"].solve({ P: 70, dt: BF16, chip: H100, tp: 4 }).answer, 10.4, 0.01, "decode-floor rung 1");
  near(g["prefill-time"].solve({ P: 70, dt: BF16, chip: H100, tp: 4, T: 3000, mfu: 0.4 }).answer, 270, 0.03,
    "prefill-time, 3,000 tokens");
  near(g["effective-knee"].solve({ P: 70, dt: BF16, chip: H100, tp: 4, tw: 14, mfu: 0.4 }).answer, 160, 0.03,
    "effective knee (~160)");
  near(g["step-time"].solve({ tw: 14, tTok: 0.089, chunk: 512, decodes: 20, tkv: 1.7 }).answer, 49, 0.03,
    "step-time, the case's hybrid step");
  assert.strictEqual(g["max-concurrency"].solve({ pool: 132, kvKB: 327.68, ctx: 3250 }).answer, 123,
    "max-concurrency, ~123 phase-1 requests");
  near(g["kv-read-time"].solve({ kvKB: 327.68, tp: 4, chip: H100, seqs: 20, ctx: 3000 }).answer, 1.7, 0.03,
    "kv-read-time, rung 4");
  near(g["api-bill"].solve({ req: 12000, inTok: 3000, outTok: 250, pin: 3, pout: 15 }).answer, 4600, 0.01,
    "api-bill, phase 1");
  near(g["breakeven-volume"].solve({ gpus: 4, price: 2.5, inTok: 3000, outTok: 250, pin: 3, pout: 15 }).answer,
    7300 / (30 * 0.01275), 1e-9, "breakeven-volume, phase-1 shape");
  near(g["pool-blocks"].solve({ pool: 132, kvKB: 327.68, block: 16 }).answer, 25177, 0.01, "pool-blocks");
});

/* ---------------- answer parsing and grading ---------------- */

test("Review deck: answers parse in the forms a reader types", () => {
  const cases = [
    ["1500", 1500], ["1,500", 1500], ["1.5e3", 1500], ["1.5k", 1500], ["1.5K", 1500],
    ["  1500 ", 1500], ["~1500", 1500], ["$1,500", 1500], ["1,234,567", 1234567],
    ["0.25", 0.25], [".25", 0.25], ["64%", 64], ["132 GB", 132], ["12ms", 12],
    ["2.5M", 2.5e6], ["70b", 70e9], ["1e-3", 0.001],
  ];
  const problems = [];
  for (const [raw, want] of cases) {
    const got = R.parseAnswer(raw);
    if (!(Math.abs(got - want) <= 1e-9 * Math.max(1, want))) problems.push(`parseAnswer(${JSON.stringify(raw)}) = ${got}, want ${want}`);
  }
  for (const raw of ["", "abc", "1,5", "--3", "k"]) {
    if (!Number.isNaN(R.parseAnswer(raw))) problems.push(`parseAnswer(${JSON.stringify(raw)}) should be NaN, got ${R.parseAnswer(raw)}`);
  }
  noProblems(problems, "answer parsing");
});

test("Review deck: grading is relative, with a 'close' band and a units hint", () => {
  assert.strictEqual(R.grade("132", 132, 0.1).verdict, "right");
  assert.strictEqual(R.grade("140", 132, 0.1).verdict, "right");
  assert.strictEqual(R.grade("160", 132, 0.1).verdict, "close");
  assert.strictEqual(R.grade("300", 132, 0.1).verdict, "wrong");
  assert.strictEqual(R.grade("hello", 132, 0.1).verdict, "invalid");
  assert.strictEqual(R.grade("51", 50, 0.001).verdict, "close", "an off-by-one block is close, not right");
  assert.strictEqual(R.grade("132000", 132, 0.1).scale, 3, "a factor of 1,000 is flagged as a unit slip");
});

/* ---------------- scheduling ---------------- */

test("Review deck: Leitner boxes move as specified", () => {
  const DAY = 86400000;
  const now = new Date(2026, 10, 21, 15, 30).getTime();
  const midnight = new Date(2026, 10, 21).getTime();
  assert.deepStrictEqual(R.INTERVALS, [1, 3, 7, 16, 35]);

  assert.ok(R.isDue(undefined, now), "a card never seen is due now");
  const first = R.nextEntry(undefined, true, now);
  assert.strictEqual(first.box, 2, "right on a new card → box 2");
  assert.strictEqual(first.due, midnight + 3 * DAY, "box 2 comes back in 3 days");
  assert.deepStrictEqual([first.seen, first.right], [1, 1]);
  assert.ok(!R.isDue(first, now));

  const miss = R.nextEntry(undefined, false, now);
  assert.strictEqual(miss.box, 1, "wrong on a new card → box 1");
  assert.strictEqual(miss.due, midnight + DAY, "…due tomorrow");

  let e = undefined;
  for (let i = 0; i < 8; i++) e = R.nextEntry(e, true, now);
  assert.strictEqual(e.box, 5, "box 5 is the ceiling");
  assert.strictEqual(e.due, midnight + 35 * DAY);
  const drop = R.nextEntry(e, false, now);
  assert.strictEqual(drop.box, 1, "a miss from box 5 goes back to box 1");

  const practised = R.nextEntry({ box: 3, due: now + 5 * DAY, seen: 4, right: 3 }, true, now, true);
  assert.strictEqual(practised.box, 3, "a right answer in practice does not move the card");
  assert.strictEqual(practised.due, now + 5 * DAY);
});

test("Review deck: the warm-up draws only due cards from completed, earlier chapters", () => {
  const order = inf.slugs;
  const gens = R.generators;
  const now = Date.now();
  const current = "continuous-batching";
  const before = new Set(order.slice(0, order.indexOf(current)));
  const completed = Object.fromEntries(order.map(s => [s, true]));

  const picks = R.warmupPicks({ generators: gens, order, current, completed, state: {}, now });
  assert.ok(picks.length > 0 && picks.length <= 3, `expected 1–3 picks, got ${picks.length}`);
  for (const g of picks) assert.ok(before.has(g.chapter), `${g.id} (${g.chapter}) is not before ${current}`);

  assert.strictEqual(
    R.warmupPicks({ generators: gens, order, current, completed: {}, state: {}, now }).length, 0,
    "nothing completed → no warm-up");
  assert.strictEqual(
    R.warmupPicks({ generators: gens, order, current: order[0], completed, state: {}, now }).length, 0,
    "the first chapter has nothing before it");
  const onlyLater = { quantization: true };
  assert.strictEqual(
    R.warmupPicks({ generators: gens, order, current, completed: onlyLater, state: {}, now }).length, 0,
    "a completed *later* chapter does not feed an earlier chapter's warm-up");

  const state = {};
  for (const g of gens) state[g.id] = { box: 3, due: now + 86400000, seen: 2, right: 2 };
  assert.strictEqual(
    R.warmupPicks({ generators: gens, order, current, completed, state, now }).length, 0,
    "nothing due → no warm-up");
});

/* ---------------- wiring ---------------- */

test("Review deck: the page, the shell and the widget are wired together", () => {
  const problems = [];
  const md = read(inf.fileFor("review"));
  if (!/data-widget="review"[^>]*data-mode="deck"/.test(md)) {
    problems.push(`inference/content/review.md has no data-widget="review" data-mode="deck" placeholder`);
  }
  if (/```quiz/.test(md)) problems.push("inference/content/review.md carries a quiz; the deck page has none by design");
  const html = read("inference/index.html");
  for (const asset of ["assets/inf-review.js", "assets/inf-review.css"]) {
    if (!html.includes(asset)) problems.push(`inference/index.html does not load ${asset}`);
  }
  if (!/define\(\s*["']review["']/.test(read("inference/assets/inf-review.js"))) {
    problems.push("inf-review.js does not register the review widget with InfWidgets.define");
  }
  if (/Math\.random/.test(R.generators.map(g => String(g.draw) + String(g.solve)).join("\n"))) {
    problems.push("a generator's draw/solve mentions Math.random — cards must be reproducible from their seed");
  }
  noProblems(problems, "review-deck wiring");
});
