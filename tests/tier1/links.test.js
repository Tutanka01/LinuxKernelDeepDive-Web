/* Every internal link in every chapter resolves.

   The reader's link vocabulary:
     ](#/slug)                  a chapter of the same course
     ](#/slug@heading-id)       …scrolled to one of its headings
     ](../#/slug)               a Linux chapter, from a sub-course
     ](../distributed/#/slug)   a sub-course chapter, from anywhere
     ](../inference/#/slug)
     ](#anchor)                 a bare in-page anchor — the router does NOT
                                handle these; they are a defect
   A dead `#/slug` is not a 404. The router renders "Couldn't load this
   chapter" or, in the guided engine, silently keeps the old view — either
   way the reader is stranded with no signal that the author made a typo. */

"use strict";

const { test } = require("node:test");
const { COURSES, COURSE_BY_ID, read, parseFrontmatter } = require("../lib/repo");
const { links, headingIds } = require("../lib/markdown");
const { noProblems } = require("../lib/report");

/* memoised heading-id maps, so a chapter linked from 40 places is parsed once */
const idCache = new Map();
function idsFor(course, slug) {
  const key = `${course.id}/${slug}`;
  if (!idCache.has(key)) {
    const { body } = parseFrontmatter(read(course.fileFor(slug)));
    idCache.set(key, headingIds(body));
  }
  return idCache.get(key);
}

/* Resolve a link target to { course, slug, anchor } or null if it is not a
   course link at all. */
function resolveCourseLink(target, from) {
  let t = target;
  let course = from;
  if (t.startsWith("../distributed/#/"))     { course = COURSE_BY_ID.distributed; t = t.slice("../distributed/#/".length); }
  else if (t.startsWith("../inference/#/"))  { course = COURSE_BY_ID.inference;   t = t.slice("../inference/#/".length); }
  else if (t.startsWith("../#/"))            { course = COURSE_BY_ID.linux;       t = t.slice("../#/".length); }
  else if (t.startsWith("#/"))               { t = t.slice(2); }
  else return null;
  const at = t.indexOf("@");
  return at === -1
    ? { course, slug: t, anchor: null }
    : { course, slug: t.slice(0, at), anchor: t.slice(at + 1) };
}

for (const course of COURSES) {
  test(`${course.name}: every internal chapter link resolves`, () => {
    const problems = [];
    for (const slug of course.fileSlugs) {
      const file = `${course.contentDir}/${slug}.md`;
      const md = read(course.fileFor(slug));
      for (const link of links(md)) {
        const r = resolveCourseLink(link.target, course);
        if (!r) continue;
        const where = `${file}:${link.n} (chapter "${slug}")`;
        if (!r.slug) {
          problems.push(`${where} → "${link.target}" has an empty slug`);
          continue;
        }
        if (!r.course.fileSlugs.includes(r.slug)) {
          problems.push(`${where} → "${link.target}" points at ${r.course.name} chapter ` +
                        `"${r.slug}", which does not exist ` +
                        `(no ${r.course.contentDir}/${r.slug}.md)`);
          continue;
        }
        if (!r.course.slugs.includes(r.slug)) {
          problems.push(`${where} → "${link.target}" points at "${r.slug}", which has a file ` +
                        `but is not registered in ${r.course.dataFile}`);
          continue;
        }
        if (r.anchor) {
          const ids = idsFor(r.course, r.slug);
          if (!ids.has(r.anchor)) {
            const near = [...ids.keys()].filter(id => id.includes(r.anchor.split("-")[0]));
            problems.push(`${where} → "${link.target}" targets heading id "${r.anchor}" ` +
                          `in ${r.course.contentDir}/${r.slug}.md, but no heading there slugifies ` +
                          `to it${near.length ? `. Did you mean: ${near.slice(0, 3).join(", ")}?` : ""}`);
          }
        }
      }
    }
    noProblems(problems, `${course.name}: broken internal link`);
  });

  test(`${course.name}: no bare "#anchor" links (the router does not handle them)`, () => {
    const problems = [];
    for (const slug of course.fileSlugs) {
      const md = read(course.fileFor(slug));
      for (const link of links(md)) {
        if (link.target.startsWith("#") && !link.target.startsWith("#/")) {
          problems.push(`${course.contentDir}/${slug}.md:${link.n} → "${link.target}" — ` +
                        `the hash router owns the fragment; use "#/${slug}@heading-id" instead`);
        }
      }
    }
    noProblems(problems, `${course.name}: unroutable anchor link`);
  });

  test(`${course.name}: no cross-course link uses the wrong relative depth`, () => {
    /* The Linux course is served at "/", so "../#/slug" from one of its own
       chapters escapes the site root; the sub-courses are one level down. */
    const problems = [];
    for (const slug of course.fileSlugs) {
      const md = read(course.fileFor(slug));
      for (const link of links(md)) {
        const t = link.target;
        if (!t.startsWith("../")) continue;
        if (course.id === "linux" && /^\.\.\/#\//.test(t)) {
          problems.push(`${course.contentDir}/${slug}.md:${link.n} → "${t}" — this is already ` +
                        `the Linux course, served at "/"; "../#/" leaves the site. Use "#/…".`);
        }
        if (course.id !== "linux" && t.startsWith(`../${course.baseDir}/#/`)) {
          problems.push(`${course.contentDir}/${slug}.md:${link.n} → "${t}" — a link from ` +
                        `${course.name} back into itself; use the bare "#/…" form.`);
        }
        if (/^\.\.\/\.\./.test(t)) {
          problems.push(`${course.contentDir}/${slug}.md:${link.n} → "${t}" — climbs above the site root`);
        }
      }
    }
    noProblems(problems, `${course.name}: wrong link depth`);
  });
}
