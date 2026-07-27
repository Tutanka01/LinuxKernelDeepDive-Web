/* Every slug in a course's data resolves to a file, and every file in a
   content directory is reachable from its course data.

   The second half matters as much as the first: an orphan .md is invisible
   to readers — no card on the course home, no sidebar entry, not in the
   search index — while still shipping in the image. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { COURSES } = require("../lib/repo");
const { noProblems } = require("../lib/report");

for (const course of COURSES) {
  test(`${course.name}: every slug in ${course.dataFile} has a chapter file`, () => {
    const problems = course.flat
      .filter(ch => !course.fileSlugs.includes(ch.slug))
      .map(ch => `${course.dataFile} lists "${ch.slug}" (${ch.title}) in ${ch.group}, ` +
                 `but ${course.contentDir}/${ch.slug}.md does not exist`);
    noProblems(problems, `${course.name}: dangling slug`);
  });

  test(`${course.name}: every chapter file is reachable from ${course.dataFile}`, () => {
    const known = new Set(course.slugs);
    const problems = course.fileSlugs
      .filter(s => !known.has(s))
      .map(s => `${course.contentDir}/${s}.md exists but no entry in ${course.dataFile} ` +
                `points at it — it is unreachable from the course home, the sidebar and search`);
    noProblems(problems, `${course.name}: orphan chapter`);
  });

  test(`${course.name}: no duplicate slugs`, () => {
    const seen = new Map();
    const problems = [];
    for (const ch of course.flat) {
      if (seen.has(ch.slug)) {
        problems.push(`"${ch.slug}" appears twice in ${course.dataFile} ` +
                      `(${seen.get(ch.slug)} and ${ch.group})`);
      }
      seen.set(ch.slug, ch.group);
    }
    noProblems(problems, `${course.name}: duplicate slug`);
  });

  test(`${course.name}: every chapter has a title and a description`, () => {
    const problems = course.flat.flatMap(ch => {
      const bad = [];
      if (!ch.title || !ch.title.trim()) bad.push(`"${ch.slug}" has no title in ${course.dataFile}`);
      if (!ch.desc || !ch.desc.trim()) bad.push(`"${ch.slug}" has no desc — its card on the course home would be blank`);
      return bad;
    });
    noProblems(problems, `${course.name}: incomplete chapter entry`);
  });

  test(`${course.name}: every chapter file opens with a single H1`, () => {
    const { headings } = require("../lib/markdown");
    const { read, parseFrontmatter } = require("../lib/repo");
    const problems = [];
    for (const slug of course.fileSlugs) {
      const { body } = parseFrontmatter(read(course.fileFor(slug)));
      const h1s = headings(body).filter(h => h.level === 1);
      if (h1s.length === 0) {
        problems.push(`${course.contentDir}/${slug}.md has no H1 — the reader has no chapter title`);
      } else if (h1s.length > 1) {
        problems.push(`${course.contentDir}/${slug}.md has ${h1s.length} H1s ` +
                      `(lines ${h1s.map(h => h.n).join(", ")}) — exactly one is expected`);
      }
    }
    noProblems(problems, `${course.name}: chapter H1`);
  });
}

test("slugs are unique across all three courses' cross-links", () => {
  /* A slug that exists in two courses is legal (both have a "glossary"),
     but it must be reachable unambiguously: the link forms are course-scoped,
     so this only asserts we know about every collision. */
  const byslug = new Map();
  for (const c of COURSES) for (const s of c.slugs) {
    byslug.set(s, [...(byslug.get(s) || []), c.id]);
  }
  const collisions = [...byslug].filter(([, ids]) => ids.length > 1);
  assert.deepEqual(
    collisions.map(([s, ids]) => `${s}: ${ids.join(", ")}`),
    ["glossary: linux, inference"],
    "the set of slugs shared between courses changed — a same-course `](#/slug)` link " +
    "now resolves differently depending on which course the reader is in");
});
