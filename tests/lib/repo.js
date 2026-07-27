/* ============================================================
   Shared repo model for the tier-1 structural tests.

   These tests parse the site's own source files and assert its
   invariants. Nothing here is allowed to invent behaviour: the
   slugify() below and parseFrontmatter() are transcribed verbatim
   from assets/app.js and assets/course.js, because a heading
   deep-link is only valid if *the engine* would produce that id.
   If the engines change, these must change with them — the
   engine-parity test in tier1/engine-parity.test.js fails loudly
   if they drift apart.
   ============================================================ */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");

const abs = (...p) => path.join(ROOT, ...p);
const rel = p => path.relative(ROOT, p);
const read = p => fs.readFileSync(path.isAbsolute(p) ? p : abs(p), "utf8");
const exists = p => fs.existsSync(path.isAbsolute(p) ? p : abs(p));

/* ---------------- extracting the course data ----------------
   assets/app.js and the two course data files are browser scripts:
   they touch `document` at the top level, so they cannot simply be
   required. Instead we slice the array literal out of the source by
   bracket matching (string- and comment-aware) and evaluate just
   that, which is inert data. */

function extractArrayLiteral(source, varName) {
  const decl = new RegExp(`(?:^|\\n)\\s*(?:const|let|var)\\s+${varName}\\s*=\\s*`, "");
  const m = decl.exec(source);
  if (!m) throw new Error(`could not find a declaration of ${varName}`);
  const start = m.index + m[0].length;
  const open = source[start];
  const close = open === "[" ? "]" : open === "{" ? "}" : null;
  if (!close) throw new Error(`${varName} is not an array or object literal`);

  let depth = 0, i = start;
  let str = null, esc = false, line = false, block = false;
  for (; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === "/" && n === "/") { line = true; i++; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error(`unbalanced literal for ${varName}`);
  const literal = source.slice(start, i);
  return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 2000 });
}

/* ---------------- the three courses ---------------- */

/* `hashPrefix` is how a chapter of this course is addressed from a
   markdown file in *another* course: the reader's link forms are
   `#/slug` (same course), `../#/slug` (Linux, from a sub-course) and
   `../<course>/#/slug` (a sub-course, from anywhere). */
const COURSE_DEFS = [
  {
    id: "linux",
    name: "The Linux Deep Dive",
    dataFile: "assets/app.js",
    varName: "BOOK",
    groupKey: "part",
    contentDir: "content",
    /* the directory the course page is served from, which is what a
       relative asset path inside one of its chapters resolves against */
    baseDir: "",
    shell: "index.html",
    guided: false,
    frontmatter: true,
  },
  {
    id: "distributed",
    name: "Distributed Systems",
    dataFile: "distributed/assets/ds.js",
    varName: "COURSE",
    groupKey: "module",
    contentDir: "distributed/content",
    baseDir: "distributed",
    shell: "distributed/index.html",
    guided: true,
    frontmatter: false,
  },
  {
    id: "inference",
    name: "Inference Engineering",
    dataFile: "inference/assets/inf.js",
    varName: "COURSE",
    groupKey: "module",
    contentDir: "inference/content",
    baseDir: "inference",
    shell: "inference/index.html",
    guided: true,
    frontmatter: false,
  },
];

/* Where a course's own home (the chapter map) lives.

   The Linux course used to own the bare "/" route. A platform landing page
   took that slot, and the course map moved to "#/course" — every chapter link
   is unaffected, but a test that assumed "/" is the map now silently checks
   the wrong page. Derived from the engine so it cannot rot. */
function homeHashFor(def, source) {
  if (def.id !== "linux") return "";
  const m = /\bhref:\s*["'](#\/[\w-]*)["']\s*,\s*total:/.exec(source);
  if (m) return m[1];
  return /kind === "platform"|renderPlatform/.test(source) ? "#/course" : "";
}

function loadCourse(def) {
  const source = read(def.dataFile);
  const tree = extractArrayLiteral(source, def.varName);
  const groups = tree.map(g => ({
    name: g[def.groupKey],
    blurb: g.blurb,
    chapters: g.chapters,
  }));
  const flat = groups.flatMap(g => g.chapters.map(ch => ({ ...ch, group: g.name })));
  const files = fs.readdirSync(abs(def.contentDir))
    .filter(f => f.endsWith(".md"))
    .sort();
  return {
    ...def,
    source,
    homeHash: homeHashFor(def, source),
    groups,
    flat,
    slugs: flat.map(c => c.slug),
    files,
    fileSlugs: files.map(f => f.replace(/\.md$/, "")),
    /* absolute path of a chapter file */
    fileFor: slug => abs(def.contentDir, `${slug}.md`),
  };
}

const COURSES = COURSE_DEFS.map(loadCourse);
const COURSE_BY_ID = Object.fromEntries(COURSES.map(c => [c.id, c]));

/* every chapter across all three courses, as {course, slug, file, relPath} */
const ALL_CHAPTERS = COURSES.flatMap(c =>
  c.fileSlugs.map(slug => ({
    course: c,
    slug,
    file: c.fileFor(slug),
    relPath: `${c.contentDir}/${slug}.md`,
  })));

/* ---------------- engine functions, transcribed ---------------- */

/* VERBATIM from assets/app.js:573 and assets/course.js:279. */
function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 64);
}

/* VERBATIM from assets/app.js:487. */
function parseFrontmatter(md) {
  const meta = {};
  if (!md.startsWith("---")) return { meta, body: md };
  const end = md.indexOf("\n---", 3);
  if (end === -1) return { meta, body: md };
  md.slice(3, end).split("\n").forEach(line => {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return { meta, body: md.slice(end + 4).replace(/^\s*\n/, "") };
}

module.exports = {
  ROOT, abs, rel, read, exists,
  extractArrayLiteral,
  COURSES, COURSE_BY_ID, COURSE_DEFS, ALL_CHAPTERS,
  slugify, parseFrontmatter,
};
