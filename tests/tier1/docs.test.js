/* The README describes a repository that exists.

   Documentation drift is the same class of failure as everything else this
   suite guards: nothing breaks, the file just quietly stops being true. The
   inference course's chapter count sat at 17 in the README for seven chapters'
   worth of writing. Paths, filenames and commands get the same treatment as
   the numbers do. */

"use strict";

const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { read, exists, abs, ROOT } = require("../lib/repo");
const { noProblems } = require("../lib/report");

const readme = read("README.md");

test("every path the README's repository-layout tree names exists", () => {
  /* the tree block, and only it */
  const block = /```text\n([\s\S]*?)```/.exec(readme);
  const problems = [];
  if (!block) {
    problems.push("README.md no longer contains the ```text repository-layout tree");
    noProblems(problems, "README repository layout");
    return;
  }

  /* rebuild each entry's full path from the box-drawing indentation */
  const stack = [];
  for (const line of block[1].split("\n")) {
    const m = /^([\s│]*)(?:├──|└──)\s+(\S+)/.exec(line);
    if (!m) continue;
    const depth = Math.floor(m[1].replace(/│/g, " ").length / 4);
    stack.length = depth;
    stack[depth] = m[2].replace(/\/$/, "");
    const rel = stack.slice(0, depth + 1).join("/");
    if (!fs.existsSync(path.join(ROOT, rel))) {
      problems.push(`README.md repository layout names "${rel}", which does not exist`);
    }
  }
  noProblems(problems, "README repository layout");
});

test("every command and file the README's Development section points at exists", () => {
  const problems = [];
  const referenced = [
    ["tests/run.sh", "the one command the README tells a developer to run"],
    ["tests/package.json", "the test suite's own dependencies, kept out of the repo root"],
    ["tests/playwright.config.js", "the tier-2 configuration"],
    ["tests/tier2/detector.spec.js", "the README claims this proves the C1 detector still fires"],
    [".github/workflows/tests.yml", "the README says both tiers run in CI"],
  ];
  for (const [f, why] of referenced) {
    if (!exists(f)) problems.push(`README.md references ${f} — ${why} — but it does not exist`);
  }
  if (exists("tests/run.sh")) {
    const mode = fs.statSync(abs("tests/run.sh")).mode;
    if (!(mode & 0o111)) {
      problems.push("tests/run.sh is not executable, but the README says to run it as ./tests/run.sh");
    }
  }
  /* the tier-1 invocation quoted in the README must actually be the one that works */
  const quoted = /node --test "tier1\/\*\.test\.js"/.test(readme);
  if (!quoted) {
    problems.push('README.md no longer quotes the working tier-1 command ' +
                  '(`node --test "tier1/*.test.js"` from tests/)');
  }
  noProblems(problems, "README development section");
});

test("the README documents the route the Linux course home actually lives at", () => {
  /* The Linux course map used to own "/". A platform landing page took that
     route and the map moved to "#/course"; the README said "/" for a while,
     which sends a reader to a page that is not the one described. */
  const { COURSE_BY_ID } = require("../lib/repo");
  const hash = COURSE_BY_ID.linux.homeHash;      // "" or "#/course"
  const problems = [];

  if (hash) {
    if (!readme.includes(`/${hash}`)) {
      problems.push(`assets/app.js routes the Linux course home to "${hash}" (the bare "/" is the ` +
                    `platform landing page), but README.md never mentions it — every URL the ` +
                    `README gives for the Linux course points at the wrong page`);
    }
    if (!/landing page/i.test(readme)) {
      problems.push('assets/app.js has a platform landing page at "/" that README.md does not describe');
    }
  } else if (/#\/course/.test(readme)) {
    problems.push('README.md documents a "#/course" route, but assets/app.js no longer has one');
  }
  noProblems(problems, "README route documentation");
});

test("the site keeps no dependencies at the repository root", () => {
  /* The owner's stated design goal: plain files, no bundler, no npm at the
     root. If a package.json ever appears there, the site has quietly acquired
     a build step. */
  const problems = [];
  for (const f of ["package.json", "package-lock.json", "node_modules", "yarn.lock", "pnpm-lock.yaml"]) {
    if (exists(f)) {
      problems.push(`${f} exists at the repository root — the site is meant to be dependency-free ` +
                    `and build-free; test tooling belongs under tests/`);
    }
  }
  noProblems(problems, "root-level dependency");
});

test("test artefacts are excluded from the image and from git", () => {
  const problems = [];
  const dockerignore = exists(".dockerignore") ? read(".dockerignore") : "";
  const gitignore = exists(".gitignore") ? read(".gitignore") : "";

  if (!/^tests\/?$/m.test(dockerignore)) {
    problems.push(".dockerignore does not exclude tests/ — node_modules would ship inside the " +
                  "nginx image and be fetchable from the served site");
  }
  if (!/tests\/node_modules/.test(gitignore)) {
    problems.push(".gitignore does not exclude tests/node_modules/");
  }
  for (const dir of ["docs", "inference/research"]) {
    if (exists(dir) && !new RegExp(`^${dir}/?$`, "m").test(dockerignore)) {
      problems.push(`.dockerignore does not exclude ${dir}/ — its notes would be served at /${dir}/`);
    }
  }
  noProblems(problems, "artefact exclusion");
});
