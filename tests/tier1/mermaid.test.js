/* Mermaid fences must be theme-safe.

   Both themes are live at once in this site: the reader flips between
   "terminal" (dark) and "paper" (light) with a button, and renderMermaid()
   re-renders every diagram on the change because the colours are baked into
   the emitted SVG. The engine supplies those colours through mermaid's
   themeVariables. A diagram that sets its own — via an `%%{init}%%` directive,
   a classDef, a `style N fill:#...` line, or a bare hex anywhere — pins itself
   to one theme and becomes unreadable in the other. It looks perfect to
   whoever authored it, because they only ever looked at one theme. */

"use strict";

const { test } = require("node:test");
const { COURSES, read, exists } = require("../lib/repo");
const { fencedBlocks } = require("../lib/markdown");
const { noProblems } = require("../lib/report");

const RULES = [
  {
    re: /%%\{/,
    why: "an %%{init}%% directive overrides the theme variables the engine injects, " +
         "freezing the diagram to whatever palette it names",
  },
  {
    re: /^\s*classDef\b/m,
    why: "classDef hardcodes fill/stroke/colour for a class of nodes; the engine's " +
         "themeVariables no longer reach them",
  },
  {
    re: /^\s*style\s+\S+[^\n]*\bfill\s*:/m,
    why: "a `style … fill:` line paints one node a fixed colour, which will be " +
         "invisible or unreadable in the other theme",
  },
  {
    re: /#[0-9a-fA-F]{3,8}\b/,
    why: "a raw hex colour is theme-blind by construction",
  },
  {
    re: /\b(?:rgb|rgba|hsl|hsla)\s*\(/,
    why: "a literal rgb()/hsl() colour is theme-blind by construction",
  },
];

test("no Mermaid fence hardcodes colours or overrides the injected theme", () => {
  const problems = [];
  for (const course of COURSES) {
    for (const slug of course.fileSlugs) {
      const file = `${course.contentDir}/${slug}.md`;
      for (const block of fencedBlocks(read(course.fileFor(slug)))) {
        if (block.info !== "mermaid" && !block.info.startsWith("mermaid ")) continue;
        for (const rule of RULES) {
          const m = rule.re.exec(block.body);
          if (!m) continue;
          const offset = block.body.slice(0, m.index).split("\n").length;
          problems.push(`${file}:${block.startLine + offset} (chapter "${slug}") — ` +
                        `"${m[0].trim()}": ${rule.why}`);
        }
      }
    }
  }
  noProblems(problems, "theme-unsafe Mermaid");
});

/* Mermaid rendering was centralised into assets/reader-ui.js so both engines
   share it; before that, a mermaid fence in distributed/content/ rendered as
   a wall of raw diagram source. These two tests pin that arrangement. */
const ENGINES = { linux: "assets/app.js", distributed: "assets/course.js", inference: "assets/course.js" };

test("every course with Mermaid fences runs them through an engine that renders Mermaid", () => {
  const problems = [];
  for (const course of COURSES) {
    const withDiagrams = course.fileSlugs.filter(slug =>
      fencedBlocks(read(course.fileFor(slug))).some(b => b.info === "mermaid"));
    if (!withDiagrams.length) continue;
    const engine = ENGINES[course.id];
    if (!/ReaderUI\.renderMermaid/.test(read(engine))) {
      problems.push(`${course.name}: ${withDiagrams.length} chapter(s) contain a mermaid fence ` +
                    `(${withDiagrams.slice(0, 5).join(", ")}${withDiagrams.length > 5 ? ", …" : ""}) ` +
                    `but ${engine} never calls ReaderUI.renderMermaid — those fences ship to the ` +
                    `reader as raw diagram syntax in a code block`);
    }
  }
  if (!/function renderMermaid/.test(read("assets/reader-ui.js"))) {
    problems.push("assets/reader-ui.js no longer defines renderMermaid — no course can draw a diagram");
  }
  noProblems(problems, "Mermaid rendering per course");
});

test("a theme change re-renders every diagram", () => {
  /* Mermaid bakes colours into the emitted SVG, so a theme toggle that does not
     re-run it leaves the previous theme's palette on the page. The source is
     kept on the node as data-src precisely so it can be re-run. */
  const problems = [];
  const ui = read("assets/reader-ui.js");
  if (!/setMermaidTheme/.test(ui)) {
    problems.push("assets/reader-ui.js exposes no setMermaidTheme — nothing reacts to a theme flip");
  }
  if (!/pre\.mermaid\[data-src\]/.test(ui)) {
    problems.push("assets/reader-ui.js no longer re-runs `pre.mermaid[data-src]` on a theme change — " +
                  "diagrams keep the colours of whichever theme was active when they were drawn");
  }
  if (/themeVariables/.test(ui) && !/token\(/.test(ui)) {
    problems.push("assets/reader-ui.js builds mermaid themeVariables from literals rather than from " +
                  "CSS custom properties — the palette will drift from assets/style.css");
  }
  for (const file of ["assets/app.js", "assets/course.js"].filter(exists)) {
    if (!/ReaderUI\.setMermaidTheme/.test(read(file))) {
      problems.push(`${file} changes the theme without telling ReaderUI — diagrams in this course ` +
                    `keep the old theme's colours until the chapter is re-rendered`);
    }
  }
  noProblems(problems, "Mermaid theme re-render");
});
