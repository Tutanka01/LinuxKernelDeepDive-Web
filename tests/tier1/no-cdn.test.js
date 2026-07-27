/* The site loads nothing from the network.

   marked, highlight.js and mermaid are vendored under assets/vendor/. A
   surviving CDN <script> is not a style preference: it makes the reader's
   experience depend on cdnjs being reachable, leaks a request on every page
   view, and — because marked is what turns a chapter into HTML — turns any
   CDN outage or offline reader into a permanently blank article. */

"use strict";

const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, read, exists } = require("../lib/repo");
const { noProblems } = require("../lib/report");

/* every HTML / JS / CSS file that is part of the served site */
function siteFiles() {
  const SKIP = new Set(["node_modules", ".git", "tests", "docs", "research", "vendor", ".claude", ".conductor"]);
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js|css)$/.test(e.name)) out.push(path.relative(ROOT, p));
    }
  })(ROOT);
  return out.sort();
}

const FILES = siteFiles();

test("no file references cdnjs.cloudflare.com", () => {
  const problems = [];
  for (const f of FILES) {
    read(f).split("\n").forEach((line, i) => {
      if (line.includes("cdnjs.cloudflare.com")) {
        problems.push(`${f}:${i + 1} — ${line.trim().slice(0, 140)}`);
      }
    });
  }
  noProblems(problems,
    "CDN reference (the vendored copies live in assets/vendor/)");
});

test("no <script src> or <link rel=stylesheet href> points at an external origin", () => {
  const problems = [];
  for (const f of FILES.filter(f => f.endsWith(".html"))) {
    const src = read(f);
    const re = /<(script|link)\b[^>]*?\s(?:src|href)="((?:https?:)?\/\/[^"]+)"/gi;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(`${f}:${line} — <${m[1].toLowerCase()}> loads ${m[2]} from another origin; ` +
                    `vendor it under assets/vendor/ instead`);
    }
  }
  noProblems(problems, "external script/style");
});

test("no JS builds an external asset URL at runtime", () => {
  /* index.html swaps the highlight.js theme stylesheet on a theme change; if
     that href is still a CDN URL, the light/dark code theme silently fails
     offline even once the <script> tags are vendored. */
  const problems = [];
  for (const f of FILES) {
    const src = read(f);
    const re = /["'`](https?:)?\/\/(?!localhost|127\.0\.0\.1)[^"'`\s]*\.(?:js|css)\b/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(`${f}:${line} — builds a remote asset URL: ${m[0].slice(1, 100)}`);
    }
  }
  noProblems(problems, "runtime external asset URL");
});

test("the vendored libraries the shells expect are present", () => {
  const problems = [];
  const expected = ["assets/vendor/marked.min.js", "assets/vendor/highlight.min.js"];
  for (const f of expected) {
    if (!exists(f)) problems.push(`${f} is missing — the shells have nothing local to load`);
  }
  noProblems(problems, "vendored library");
});
