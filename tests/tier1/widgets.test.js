/* The Inference course's interactive widgets are wired up.

   A chapter cannot carry a <script>: assets/course.js renders markdown with
   innerHTML, and the HTML spec marks script elements parsed that way as
   already-executed. So a widget is a placeholder div plus a registration in
   inference/assets/inf-*.js, and the two halves are joined by a bare string.
   A typo in either half fails the way this codebase always fails — silently:
   the reader sees the fallback paragraph and never knows a calculator was
   meant to be there. */

"use strict";

const { test } = require("node:test");
const fs = require("node:fs");
const { COURSE_BY_ID, read, abs, exists } = require("../lib/repo");
const { noProblems } = require("../lib/report");

const inference = COURSE_BY_ID.inference;

function widgetSources() {
  return fs.readdirSync(abs("inference/assets"))
    .filter(f => /^inf-.*\.js$/.test(f))
    .map(f => `inference/assets/${f}`);
}

function definedWidgets() {
  const names = new Set();
  for (const f of widgetSources()) {
    for (const m of read(f).matchAll(/\bdefine\(\s*["']([^"']+)["']/g)) names.add(m[1]);
  }
  return names;
}

test("every data-widget placeholder in a chapter has a registered implementation", () => {
  const defined = definedWidgets();
  const problems = [];
  for (const slug of inference.fileSlugs) {
    const md = read(inference.fileFor(slug));
    md.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/data-widget="([^"]+)"/g)) {
        if (!defined.has(m[1])) {
          problems.push(`inference/content/${slug}.md:${i + 1} mounts widget "${m[1]}", which no ` +
                        `inf-*.js registers with InfWidgets.define() — the reader gets the ` +
                        `fallback paragraph and nothing else. Registered: ${[...defined].sort().join(", ")}`);
        }
      }
    });
  }
  noProblems(problems, "unregistered widget");
});

/* The stackmap is a decorative orientation strip: if it never mounts the
   reader loses a nicety, not an argument. Every other widget stands in for
   prose the chapter no longer contains, so it owes the reader a fallback. */
const DECORATIVE = new Set(["stackmap"]);

test("every load-bearing widget placeholder carries a no-JS fallback", () => {
  const problems = [];
  for (const slug of inference.fileSlugs) {
    const md = read(inference.fileFor(slug));
    /* the placeholder block runs from the opening div to its closing tag */
    const re = /<div class="inf-widget[^"]*" data-widget="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(md))) {
      if (DECORATIVE.has(m[1])) continue;
      if (!/inf-widget-fallback/.test(m[2])) {
        const line = md.slice(0, m.index).split("\n").length;
        problems.push(`inference/content/${slug}.md:${line} — the "${m[1]}" placeholder has no ` +
                      `<p class="inf-widget-fallback">; with JS off or a widget script failing to ` +
                      `load, the chapter shows an empty gap`);
      }
    }
  }
  noProblems(problems, "widget without a fallback");
});

test("every widget script the inference shell needs is loaded by it", () => {
  const html = read("inference/index.html");
  const problems = widgetSources()
    .filter(f => !html.includes(f.replace("inference/", "")))
    .map(f => `${f} defines widgets but inference/index.html never loads it`);
  noProblems(problems, "unloaded widget script");
});

test("inference/simulator.html, if present, loads the simulator it hosts", () => {
  if (!exists("inference/simulator.html")) return;
  const html = read("inference/simulator.html");
  const problems = [];
  if (!/inf-simulator\.js/.test(html)) {
    problems.push("inference/simulator.html does not load assets/inf-simulator.js — the " +
                  "full-page simulator would render as an empty shell");
  }
  noProblems(problems, "simulator page");
});
