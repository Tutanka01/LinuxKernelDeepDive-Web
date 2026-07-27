/* The functions tests/lib/repo.js transcribes must still match the engines.

   The heading deep-link test is only meaningful if it computes ids the way
   the browser does. It cannot import assets/app.js (that file touches the DOM
   at load), so slugify() and parseFrontmatter() are copied. A copy rots
   silently: if someone widens slugify's character class, every #/slug@heading
   link in the repo could break while the link test kept passing against the
   old rule. This test compares the copies against the source text they were
   taken from, and against the two engines against each other. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { read, slugify, parseFrontmatter } = require("../lib/repo");
const { noProblems } = require("../lib/report");

/* pull a named function's source out of a browser script */
function fnSource(file, name) {
  const src = read(file);
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${file} no longer declares function ${name}()`);
  let depth = 0, i = src.indexOf("{", start), end = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const normalise = s => s.replace(/\s+/g, " ").trim();

test("slugify() is identical in assets/app.js and assets/course.js", () => {
  assert.equal(
    normalise(fnSource("assets/app.js", "slugify")),
    normalise(fnSource("assets/course.js", "slugify")),
    "the two engines mint different heading ids — a #/slug@heading link that works in " +
    "one course silently scrolls nowhere in the other");
});

test("tests/lib/repo.js slugify() still matches the engine's", () => {
  const engine = fnSource("assets/app.js", "slugify");
  const mine = normalise(slugify.toString());
  assert.equal(mine, normalise(engine),
    "tests/lib/repo.js has drifted from assets/app.js. Re-copy slugify() verbatim, then " +
    "re-run the link tests: heading ids may have changed for every chapter.\n" +
    `  engine: ${normalise(engine)}\n  tests : ${mine}`);
});

test("tests/lib/repo.js parseFrontmatter() still matches assets/app.js", () => {
  const engine = fnSource("assets/app.js", "parseFrontmatter");
  assert.equal(normalise(parseFrontmatter.toString()), normalise(engine),
    "tests/lib/repo.js has drifted from assets/app.js — re-copy parseFrontmatter() verbatim");
});

test("slugify behaves as the heading-id tests assume", () => {
  const cases = [
    ["Follow the code (kernel v6.12)", "follow-the-code-kernel-v612"],
    ["What `docker run` assembles", "what-docker-run-assembles"],
    ["USE: Utilization, Saturation, Errors", "use-utilization-saturation-errors"],
    ["  Leading and trailing  ", "leading-and-trailing"],
    /* an em dash is neither \w, \s nor "-", so it is deleted and the two
       surrounding spaces collapse to a single hyphen */
    ["Em — dashes", "em-dashes"],
    ["Kernel, User Space & Syscalls", "kernel-user-space-syscalls"],
    ["a".repeat(80), "a".repeat(64)],   // ids are truncated at 64 chars
  ];
  const problems = cases
    .filter(([input, want]) => slugify(input) !== want)
    .map(([input, want]) => `slugify(${JSON.stringify(input)}) === ` +
                            `${JSON.stringify(slugify(input))}, expected ${JSON.stringify(want)}`);
  noProblems(problems, "slugify behaviour");
});

test("the engines' loading placeholder is still recognisable to the tier-2 test", () => {
  /* Audit finding C1: an uncancelled setTimeout replaced a rendered chapter
     with this placeholder. tests/tier2 asserts an article never matches
     /^\s*<p class="loading">/. If the markup changes, that assertion goes
     quietly blind — so pin it here. */
  const src = read("assets/app.js");
  assert.match(src, /<p class="loading">/,
    'assets/app.js no longer emits `<p class="loading">`. tests/tier2/chapters.spec.js ' +
    "matches on exactly that string to detect the C1 regression; update both together.");
  assert.match(src, /clearTimeout\(placeholderTimer\)/,
    "assets/app.js schedules a placeholder timer but no longer clears it — this is audit " +
    "finding C1 verbatim: a fetch that resolves inside the delay lets the timer fire " +
    "afterwards and blank the rendered chapter.");
});
