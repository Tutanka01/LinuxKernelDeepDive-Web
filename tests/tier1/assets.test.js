/* Every referenced local asset exists.

   A dead <img src> in a chapter is a broken-image icon in the middle of an
   explanation and a 404 in the console — and the tier-2 browser test treats
   any failed request as a failure, so this is the cheap version of the same
   check. Paths in a chapter resolve against the *page* URL, not the markdown
   file: a chapter of the inference course is fetched by /inference/, so
   `assets/diagrams/x.svg` inside it means `inference/assets/diagrams/x.svg`. */

"use strict";

const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { COURSES, read, exists, abs, ROOT } = require("../lib/repo");
const { links } = require("../lib/markdown");
const { noProblems } = require("../lib/report");

const isExternal = t => /^(https?:)?\/\//.test(t) || t.startsWith("mailto:") || t.startsWith("data:");
const isRoute = t => t.startsWith("#") || /^\.\.\/(?:distributed\/|inference\/)?#\//.test(t);

test("every asset referenced from a chapter exists on disk", () => {
  const problems = [];
  for (const course of COURSES) {
    for (const slug of course.fileSlugs) {
      const md = read(course.fileFor(slug));
      for (const link of links(md)) {
        const target = link.target.split("#")[0].split("?")[0];
        if (!target || isExternal(link.target) || isRoute(link.target)) continue;
        /* resolve against the served directory of this course */
        const resolved = path.normalize(path.join(ROOT, course.baseDir, target));
        if (!resolved.startsWith(ROOT)) {
          problems.push(`${course.contentDir}/${slug}.md:${link.n} → "${link.target}" escapes the site root`);
          continue;
        }
        if (!fs.existsSync(resolved)) {
          problems.push(`${course.contentDir}/${slug}.md:${link.n} (chapter "${slug}") → ` +
                        `"${link.target}" resolves to ${path.relative(ROOT, resolved)}, which does not exist`);
        }
      }
    }
  }
  noProblems(problems, "dead asset reference");
});

test("every asset referenced from the site's own JS and CSS exists on disk", () => {
  const problems = [];
  const sources = [
    "assets/app.js", "assets/course.js", "assets/reader-ui.js",
    "inference/assets/inf.js", "inference/assets/inf-widgets.js",
    "inference/assets/inf-calculators.js", "inference/assets/inf-simulator.js",
    "inference/assets/inf-stackmap.js",
    "distributed/assets/ds.js",
    "assets/style.css", "assets/course.css",
  ].filter(f => exists(f));

  for (const file of sources) {
    const src = read(file);
    const baseDir = file.startsWith("inference/") ? "inference"
      : file.startsWith("distributed/") ? "distributed" : "";

    /* vendorUrl("x") resolves against assets/vendor/, wherever it is called
       from — reader-ui.js derives the base from its own script URL. */
    const vendored = new Set();
    for (const m of src.matchAll(/vendorUrl\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      vendored.add(m[1]);
      if (!fs.existsSync(path.join(ROOT, "assets", "vendor", m[1]))) {
        const line = src.slice(0, m.index).split("\n").length;
        problems.push(`${file}:${line} loads vendorUrl("${m[1]}") but assets/vendor/${m[1]} does not exist`);
      }
    }

    /* string literals that look like a path to a real asset file */
    const re = /["'`]([^"'`\s]*\.(?:svg|png|jpg|jpeg|webp|gif|css|js|md|woff2?))["'`]/g;
    let m;
    while ((m = re.exec(src))) {
      const t = m[1];
      if (isExternal(t) || t.startsWith("#")) continue;
      if (t.includes("${")) continue;                  // template-built path, checked elsewhere
      if (vendored.has(t)) continue;                   // already checked above
      const resolved = path.normalize(path.join(ROOT, baseDir, t.replace(/^\//, "")));
      if (!fs.existsSync(resolved)) {
        const line = src.slice(0, m.index).split("\n").length;
        problems.push(`${file}:${line} references "${t}" → ${path.relative(ROOT, resolved)}, which does not exist`);
      }
    }
  }
  noProblems(problems, "dead asset reference in source");
});

test("every script and stylesheet an HTML shell loads exists on disk", () => {
  const problems = [];
  for (const course of COURSES) {
    const html = read(course.shell);
    const dir = path.dirname(abs(course.shell));
    const re = /<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const t = m[1].split("?")[0].split("#")[0];   // cache-busting ?v=… is not part of the path
      if (isExternal(t) || !t) continue;
      const resolved = path.normalize(path.join(dir, t));
      if (!fs.existsSync(resolved)) {
        problems.push(`${course.shell} loads "${t}" → ${path.relative(ROOT, resolved)}, which does not exist`);
      }
    }
  }
  noProblems(problems, "missing shell asset");
});

test("no diagram in inference/assets/diagrams is orphaned", () => {
  const dir = abs("inference/assets/diagrams");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".svg"));
  const corpus = COURSES.flatMap(c => c.fileSlugs.map(s => read(c.fileFor(s))))
    .concat(["inference/assets/inf-widgets.js", "inference/assets/inf-stackmap.js"]
      .filter(exists).map(read))
    .join("\n");
  const orphans = files
    .filter(f => !corpus.includes(f))
    .map(f => `inference/assets/diagrams/${f} is referenced by nothing — it ships in the ` +
              `image but no chapter shows it`);
  noProblems(orphans, "orphan diagram");
});
