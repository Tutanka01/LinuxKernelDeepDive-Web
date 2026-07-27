/* Every ```quiz fence is valid.

   renderQuizzes() in assets/course.js does `try { JSON.parse(...) } catch { return }`
   — a malformed quiz is not an error, it is *silence*: the fence renders as a
   plain code block showing raw JSON, and because completion in both guided
   courses is gated on passing the quiz, the chapter can never be completed
   from the quiz path. That is the single most damaging silent failure in the
   guided engine, so the schema is asserted field by field. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { COURSES, read } = require("../lib/repo");
const { fencedBlocks } = require("../lib/markdown");
const { noProblems } = require("../lib/report");

/* the fence marker itself, kept out of the template literals below */
const QF = "```quiz";

/* Chapters that legitimately carry no checkpoint. Reference material is not
   read in order and has nothing to test; anything else appearing here is a
   chapter that quietly cannot be completed the intended way. */
const QUIZLESS_BY_DESIGN = new Set([
  "inference/content/glossary.md",
]);

const guided = COURSES.filter(c => c.guided);

for (const course of guided) {
  test(`${course.name}: every quiz fence parses and matches the schema`, () => {
    const problems = [];
    for (const slug of course.fileSlugs) {
      const file = `${course.contentDir}/${slug}.md`;
      const md = read(course.fileFor(slug));
      const quizzes = fencedBlocks(md).filter(b => b.info === "quiz");

      if (quizzes.length > 1) {
        problems.push(`${file}: ${quizzes.length} ${QF} fences — the engine renders all of ` +
                      `them but completion only reads the last; keep one per chapter`);
      }

      for (const q of quizzes) {
        const at = `${file}:${q.startLine}`;
        if (q.unterminated) {
          problems.push(`${at}: the ${QF} fence is never closed`);
          continue;
        }
        let data;
        try {
          data = JSON.parse(q.body);
        } catch (err) {
          problems.push(`${at}: quiz JSON does not parse — ${err.message}. ` +
                        `renderQuizzes() swallows this: the reader sees raw JSON and ` +
                        `chapter "${slug}" can never be completed by quiz.`);
          continue;
        }
        if (!Array.isArray(data)) {
          problems.push(`${at}: quiz is a ${typeof data}, expected a JSON array of questions`);
          continue;
        }
        if (data.length === 0) {
          problems.push(`${at}: quiz array is empty — the chapter would auto-complete on submit`);
          continue;
        }
        data.forEach((item, i) => {
          const qn = `${at}: question ${i + 1}`;
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            problems.push(`${qn} is not an object`);
            return;
          }
          for (const key of ["q", "choices", "answer", "explain"]) {
            if (!(key in item)) problems.push(`${qn} is missing the "${key}" field`);
          }
          if ("q" in item && (typeof item.q !== "string" || !item.q.trim())) {
            problems.push(`${qn}: "q" must be a non-empty string`);
          }
          if ("explain" in item && (typeof item.explain !== "string" || !item.explain.trim())) {
            problems.push(`${qn}: "explain" must be a non-empty string — it is what the reader ` +
                          `sees after checking their answers`);
          }
          if (!Array.isArray(item.choices)) {
            if ("choices" in item) problems.push(`${qn}: "choices" must be an array`);
            return;
          }
          if (item.choices.length < 2) {
            problems.push(`${qn}: only ${item.choices.length} choice(s) — a question with fewer ` +
                          `than 2 is not a question`);
          }
          item.choices.forEach((c, ci) => {
            if (typeof c !== "string" || !c.trim()) {
              problems.push(`${qn}: choice ${ci + 1} is not a non-empty string`);
            }
          });
          if (new Set(item.choices).size !== item.choices.length) {
            problems.push(`${qn}: duplicate choices — two options are the same text`);
          }
          if (!Number.isInteger(item.answer)) {
            if ("answer" in item) {
              problems.push(`${qn}: "answer" is ${JSON.stringify(item.answer)}; it must be an ` +
                            `integer index into "choices"`);
            }
          } else if (item.answer < 0 || item.answer >= item.choices.length) {
            problems.push(`${qn}: "answer" is ${item.answer} but there are only ` +
                          `${item.choices.length} choices (valid range 0–${item.choices.length - 1}) ` +
                          `— this question can never be answered correctly, so chapter "${slug}" ` +
                          `can never be completed`);
          }
        });
      }
    }
    noProblems(problems, `${course.name}: invalid quiz`);
  });

  test(`${course.name}: every chapter carries a checkpoint quiz`, () => {
    const missing = course.fileSlugs
      .map(slug => `${course.contentDir}/${slug}.md`)
      .filter(f => !QUIZLESS_BY_DESIGN.has(f))
      .filter(f => !fencedBlocks(read(f)).some(b => b.info === "quiz"))
      .map(f => `${f} has no ${QF} fence — completion in this course is gated on the quiz, ` +
                `so this chapter can only be ticked off with the manual toggle`);
    noProblems(missing, `${course.name}: chapter without a checkpoint`);
  });
}

test("the Linux course carries no quiz fences (it gates on scroll, not quizzes)", () => {
  const linux = COURSES.find(c => c.id === "linux");
  const stray = linux.fileSlugs
    .filter(s => fencedBlocks(read(linux.fileFor(s))).some(b => b.info === "quiz"))
    .map(s => `content/${s}.md has a ${QF} fence, but assets/app.js has no quiz renderer — ` +
              `it would ship to the reader as a block of raw JSON`);
  noProblems(stray, "Linux: unrenderable quiz fence");
});

test("the quizless-by-design allow-list still refers to real files", () => {
  const { exists } = require("../lib/repo");
  for (const f of QUIZLESS_BY_DESIGN) {
    assert.ok(exists(f), `${f} is allow-listed as quizless in tests/tier1/quizzes.test.js but no longer exists`);
  }
});
