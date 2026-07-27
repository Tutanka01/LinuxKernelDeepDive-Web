/* Linux chapter frontmatter is valid.

   parseFrontmatter() in assets/app.js is deliberately forgiving: it never
   throws, it just returns whatever it found. metaBannerHtml() then silently
   drops anything it does not recognise — an unknown `level` renders no badge,
   a `requires` slug that does not exist is filtered out of the prerequisite
   line, a missing `minutes` removes the reading estimate. Every one of those
   is invisible in the browser, which is exactly why they are asserted here. */

"use strict";

const { test } = require("node:test");
const { COURSES, read } = require("../lib/repo");
const { noProblems } = require("../lib/report");

/* LEVEL_LABEL in assets/app.js is the authority on what a level may be. */
const VALID_LEVELS = ["core", "mechanism", "internals"];
const REQUIRED = ["level", "kernel", "verified", "minutes"];

const linux = COURSES.find(c => c.id === "linux");
const known = new Set(linux.slugs);

test("Linux: LEVEL_LABEL in assets/app.js still defines exactly the levels this test allows", () => {
  const m = /const\s+LEVEL_LABEL\s*=\s*\{([^}]*)\}/.exec(linux.source);
  const { noProblems: np } = require("../lib/report");
  if (!m) {
    np(["assets/app.js no longer declares LEVEL_LABEL — this test's list of valid levels " +
        "is now unanchored and must be re-derived from the engine"], "Linux: level vocabulary");
    return;
  }
  const declared = [...m[1].matchAll(/(\w+)\s*:/g)].map(x => x[1]).sort();
  const expected = [...VALID_LEVELS].sort();
  np(
    declared.join(",") === expected.join(",") ? [] :
      [`assets/app.js LEVEL_LABEL declares [${declared}] but tests/tier1/frontmatter.test.js ` +
       `allows [${expected}] — update the test to match the engine`],
    "Linux: level vocabulary drift");
});

test("Linux: every chapter has complete, well-formed frontmatter", () => {
  const problems = [];
  for (const slug of linux.fileSlugs) {
    const file = `content/${slug}.md`;
    const raw = read(linux.fileFor(slug));

    if (!raw.startsWith("---")) {
      problems.push(`${file} has no frontmatter block — the chapter renders with no level ` +
                    `badge, no reading time and no prerequisite line`);
      continue;
    }
    if (raw.indexOf("\n---", 3) === -1) {
      problems.push(`${file}: the frontmatter block is never closed, so parseFrontmatter() ` +
                    `returns the whole file as the body and the YAML ships as prose`);
      continue;
    }

    const { meta } = require("../lib/repo").parseFrontmatter(raw);

    for (const key of REQUIRED) {
      if (!(key in meta) || !String(meta[key]).trim()) {
        problems.push(`${file}: frontmatter is missing "${key}"`);
      }
    }

    if (meta.level && !VALID_LEVELS.includes(meta.level)) {
      problems.push(`${file}: level is "${meta.level}"; LEVEL_LABEL only knows ` +
                    `${VALID_LEVELS.join(" | ")} — the badge is silently dropped`);
    }

    if (meta.minutes !== undefined) {
      if (!/^\d+$/.test(meta.minutes)) {
        problems.push(`${file}: minutes is "${meta.minutes}"; it must be a plain integer`);
      } else if (Number(meta.minutes) < 1 || Number(meta.minutes) > 240) {
        problems.push(`${file}: minutes is ${meta.minutes} — implausible for a chapter`);
      }
    }

    if (meta.kernel !== undefined && !/^\d+\.\d+(\.\d+)?$/.test(meta.kernel)) {
      problems.push(`${file}: kernel is "${meta.kernel}"; expected a version like 6.12`);
    }

    if (meta.verified !== undefined && !/^\d{4}-\d{2}(-\d{2})?$/.test(meta.verified)) {
      problems.push(`${file}: verified is "${meta.verified}"; expected YYYY-MM or YYYY-MM-DD`);
    }

    if (meta.requires !== undefined && meta.requires !== "") {
      const reqs = meta.requires.split(",").map(s => s.trim()).filter(Boolean);
      for (const r of reqs) {
        if (!known.has(r)) {
          problems.push(`${file}: requires "${r}", which is not a chapter of this course — ` +
                        `metaBannerHtml() filters it out, so the prerequisite silently vanishes ` +
                        `from the reader's "Before this chapter" line`);
        }
      }
      if (reqs.includes(slug)) {
        problems.push(`${file}: requires itself`);
      }
      if (new Set(reqs).size !== reqs.length) {
        problems.push(`${file}: requires lists the same chapter twice`);
      }
    }
  }
  noProblems(problems, "Linux: frontmatter");
});

test("Linux: the pinned kernel version is consistent across every chapter", () => {
  const versions = new Map();
  for (const slug of linux.fileSlugs) {
    const { meta } = require("../lib/repo").parseFrontmatter(read(linux.fileFor(slug)));
    if (!meta.kernel) continue;
    versions.set(meta.kernel, [...(versions.get(meta.kernel) || []), slug]);
  }
  const ranked = [...versions].sort((a, b) => b[1].length - a[1].length);
  const pin = ranked.length ? ranked[0][0] : null;
  const problems = ranked.slice(1)
    .map(([v, slugs]) => `kernel: ${v} in ${slugs.length} chapter(s) — ${slugs.join(", ")}; ` +
                         `the rest of the course is pinned to ${pin}`);
  noProblems(problems, "Linux: kernel pin drift");
});

test("Guided courses carry no frontmatter (their engine does not parse it)", () => {
  const problems = [];
  for (const course of COURSES.filter(c => !c.frontmatter)) {
    for (const slug of course.fileSlugs) {
      const raw = read(course.fileFor(slug));
      if (raw.startsWith("---") && raw.indexOf("\n---", 3) !== -1) {
        problems.push(`${course.contentDir}/${slug}.md opens with a frontmatter block, but ` +
                      `assets/course.js renders the file verbatim — the YAML would be shown ` +
                      `to the reader as a horizontal rule and a paragraph of key: value pairs`);
      }
    }
  }
  noProblems(problems, "Guided courses: unexpected frontmatter");
});
