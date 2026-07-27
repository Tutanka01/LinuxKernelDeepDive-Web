/* A failing assertion in this suite has to name the file and the chapter,
   not a line number in a test. Every tier-1 test collects human-readable
   problem strings and hands the whole list to `noProblems`, so one run
   reports every drift at once instead of stopping at the first. */

"use strict";

const assert = require("node:assert");

function noProblems(problems, headline) {
  if (!problems.length) return;
  const lines = problems.map(p => `  ✗ ${p}`).join("\n");
  assert.fail(`${headline} — ${problems.length} problem${problems.length > 1 ? "s" : ""}:\n${lines}\n`);
}

module.exports = { noProblems };
