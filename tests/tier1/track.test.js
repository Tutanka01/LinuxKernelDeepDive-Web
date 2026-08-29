/* The GPU–Kernel Track points at chapters that exist.

   path/assets/path.js hardcodes 38 (course, slug, title) triples. Nothing in
   the site generates them and nothing else validates them: rename a chapter,
   move it between courses, or drop it, and the track keeps rendering a row
   that navigates to a course home with an unrecognised hash — no error, no
   404, just a link that quietly stops arriving anywhere.

   The title is checked too, not only the slug. The track prints its own copy
   of every chapter title, so a retitled chapter leaves the track advertising
   the old name — the kind of drift that survives a review because both sides
   look right on their own page.

   The track's shell is checked against the three course shells for the same
   reason the course switcher exists at all: it is the one piece of chrome
   that has to be identical everywhere, and it is hand-written in four files. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { read, exists, extractArrayLiteral, COURSE_BY_ID } = require("../lib/repo");
const { noProblems } = require("../lib/report");

const TRACK_JS = "path/assets/path.js";
const TRACK_SHELL = "path/index.html";

const SHELLS = ["index.html", "distributed/index.html", "inference/index.html", TRACK_SHELL];

const trackSource = exists(TRACK_JS) ? read(TRACK_JS) : null;
const PHASES = trackSource ? extractArrayLiteral(trackSource, "PHASES") : [];

test("the track exists and is made of phases with steps and a deliverable", () => {
  assert.ok(trackSource, `${TRACK_JS} is missing — the track page cannot render`);
  assert.ok(PHASES.length, "path.js declares no phases");
  const problems = [];
  for (const p of PHASES) {
    if (!p.id) problems.push(`a phase has no id`);
    if (!Array.isArray(p.steps) || !p.steps.length) problems.push(`phase "${p.id}" has no steps`);
    if (!p.deliverable || !p.deliverable.id) problems.push(`phase "${p.id}" has no deliverable`);
  }
  noProblems(problems, "malformed phase");
});

test("every step of the track names a chapter that exists, under its own title", () => {
  const problems = [];
  for (const phase of PHASES) {
    for (const [courseId, slug, title] of phase.steps) {
      const course = COURSE_BY_ID[courseId];
      if (!course) {
        problems.push(`phase "${phase.id}" → "${slug}" is filed under course "${courseId}", ` +
                      `which is not one of ${Object.keys(COURSE_BY_ID).join(", ")}`);
        continue;
      }
      const chapter = course.flat.find(c => c.slug === slug);
      if (!chapter) {
        problems.push(`phase "${phase.id}" → ${course.name} has no chapter "${slug}" — ` +
                      `the track's link lands on that course's home with an unknown hash`);
        continue;
      }
      if (!exists(`${course.contentDir}/${slug}.md`)) {
        problems.push(`phase "${phase.id}" → ${course.contentDir}/${slug}.md does not exist`);
      }
      if (chapter.title !== title) {
        problems.push(`phase "${phase.id}" → "${slug}" is titled "${chapter.title}" in ` +
                      `${course.name}, but the track calls it "${title}"`);
      }
    }
  }
  noProblems(problems, "dead or drifted track step");
});

test("no chapter is walked twice, and every deliverable id is unique", () => {
  const problems = [];
  const seenStep = new Map();
  const seenDeliverable = new Map();
  for (const phase of PHASES) {
    for (const [courseId, slug] of phase.steps) {
      const key = `${courseId}/${slug}`;
      if (seenStep.has(key)) {
        problems.push(`"${key}" appears in phase "${seenStep.get(key)}" and again in "${phase.id}" — ` +
                      `it would be counted twice in the track's progress`);
      } else seenStep.set(key, phase.id);
    }
    const id = phase.deliverable.id;
    if (seenDeliverable.has(id)) {
      problems.push(`deliverable id "${id}" is used by phase "${seenDeliverable.get(id)}" and ` +
                    `"${phase.id}" — ticking one would tick both`);
    } else seenDeliverable.set(id, phase.id);
  }
  noProblems(problems, "duplicate track entry");
});

test("the track page is built on the shared shell, not a page of its own", () => {
  const html = read(TRACK_SHELL);
  const problems = [];
  const required = [
    ["assets/style.css", "the shell stylesheet"],
    ["assets/course.css", "the course-home vocabulary the phases are drawn in"],
    ["assets/reader-ui.js", "the shared focus trap the drawer and search modal need"],
    ['class="layout"', "the three-column layout every other page uses"],
    ['id="sidebar"', "the rail"],
    ['id="sidebar-scrim"', "the drawer backdrop"],
    ['id="progress-bar"', "the reading-progress bar"],
    ['id="topbar"', "the sticky bar a phone reader navigates by"],
    ['id="search-modal"', "the search modal"],
    ['id="live-region"', "the live region that announces state changes"],
    ["skip-link", "the skip link"],
  ];
  for (const [needle, why] of required) {
    if (!html.includes(needle)) {
      problems.push(`${TRACK_SHELL} no longer carries ${needle} (${why}) — the track has drifted ` +
                    `back into being a page of its own`);
    }
  }
  noProblems(problems, "track shell drift");
});

test("every shell offers the same way to every course, and to the track", () => {
  const problems = [];
  /* Each shell links the other three courses and marks its own current, so
     the set of destinations is the same everywhere once its own is included. */
  const DESTINATIONS = [
    /* the landing is "#/" on the root shell and "../" from a sub-directory;
       the chip-all class is what all four have in common */
    [/chip-all/, "the platform landing"],
    [/href="(\.\.\/)?#\/course"|chip-title">The Linux Deep Dive/, "the Linux course"],
    [/href="(\.\.\/)?distributed\/"|chip-title">Distributed Systems/, "the distributed course"],
    [/href="(\.\.\/)?inference\/"|chip-title">Inference Engineering/, "the inference course"],
    [/chip-track/, "the GPU–Kernel Track"],
  ];
  for (const shell of SHELLS) {
    if (!exists(shell)) { problems.push(`${shell} does not exist`); continue; }
    const html = read(shell);
    if (!html.includes("course-switch")) {
      problems.push(`${shell} has no course switcher at all`);
      continue;
    }
    for (const [re, what] of DESTINATIONS) {
      if (!re.test(html)) problems.push(`${shell}'s course switcher does not offer ${what}`);
    }
    /* exactly one entry is the page you are on */
    const current = (html.match(/course-chip[^"]*\bcurrent\b/g) || []).length;
    if (shell !== "index.html" && current !== 1) {
      problems.push(`${shell} marks ${current} chips as the current page; exactly one should be ` +
                    `(the landing page marks none in markup — app.js sets it per route)`);
    }
  }
  noProblems(problems, "course switcher drift");
});
