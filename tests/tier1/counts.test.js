/* Chapter counts agree everywhere.

   The count of chapters in a course is stated in six independent places:
   the files on disk, the course data array, the course chips in all three
   HTML shells, prose inside the course data (blurbs, hero copy), the README
   summary table, and the README's per-course narrative. They have drifted
   twice. The count on disk is treated as the truth here; everything else
   has to agree with it. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { COURSES, read } = require("../lib/repo");
const { noProblems } = require("../lib/report");

const truth = Object.fromEntries(COURSES.map(c => [c.id, c.files.length]));
const total = Object.values(truth).reduce((a, b) => a + b, 0);

/* The chip copy in every shell is the same three lines, repeated. */
const CHIP_LABEL = { linux: "kernel, processes", distributed: "first principles to Raft", inference: "rooflines, engines" };

test("course data and the files on disk agree", () => {
  const problems = [];
  for (const c of COURSES) {
    if (c.flat.length !== c.files.length) {
      problems.push(`${c.name}: ${c.dataFile} declares ${c.flat.length} chapters but ` +
                    `${c.contentDir}/ holds ${c.files.length} .md files`);
    }
    const groupSum = c.groups.reduce((a, g) => a + g.chapters.length, 0);
    if (groupSum !== c.flat.length) {
      problems.push(`${c.name}: module chapter arrays sum to ${groupSum}, flat list is ${c.flat.length}`);
    }
  }
  noProblems(problems, "chapter counts");
});

test("all three HTML shells state the same per-course chapter counts, and they are correct", () => {
  const problems = [];
  for (const shellCourse of COURSES) {
    const html = read(shellCourse.shell);
    for (const c of COURSES) {
      const re = new RegExp(`(\\d+)\\s+chapters\\s+—\\s+${CHIP_LABEL[c.id].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      const m = re.exec(html);
      if (!m) {
        problems.push(`${shellCourse.shell}: no course chip found for ${c.name} ` +
                      `(looked for "N chapters — ${CHIP_LABEL[c.id]}…"); the cross-course ` +
                      `switcher may have lost an entry`);
        continue;
      }
      if (Number(m[1]) !== truth[c.id]) {
        problems.push(`${shellCourse.shell}: the ${c.name} chip says "${m[1]} chapters" ` +
                      `but ${c.contentDir}/ holds ${truth[c.id]}`);
      }
    }
  }
  noProblems(problems, "shell course chips");
});

test("prose inside the course data does not hardcode a stale chapter count", () => {
  /* e.g. assets/app.js: "six ordered paths through the 56 of them" */
  const problems = [];
  for (const c of COURSES) {
    const strings = [
      ...c.groups.map(g => g.blurb || ""),
      ...c.flat.map(ch => `${ch.title} ${ch.desc || ""}`),
    ].join("\n");
    for (const m of strings.matchAll(/\b(\d{2,3})\b(?=[^\n]{0,40}?(chapters?|of them))/g)) {
      const n = Number(m[1]);
      if (n !== truth[c.id] && n !== total && n > 5 && n < 200) {
        problems.push(`${c.dataFile}: prose says "${m[0]}" near "chapters"/"of them" but the ` +
                      `course has ${truth[c.id]}`);
      }
    }
  }
  /* the Linux blurb's "the 56 of them" is the known instance; assert it directly */
  const linux = COURSES.find(c => c.id === "linux");
  const blurb = linux.groups[0].blurb || "";
  const m = /the (\d+) of them/.exec(blurb);
  if (m && Number(m[1]) !== truth.linux) {
    problems.push(`assets/app.js "Start Here" blurb says "the ${m[1]} of them" but the course ` +
                  `has ${truth.linux} chapters`);
  }
  noProblems(problems, "hardcoded counts in course data");
});

test("the platform landing page in assets/app.js states the right per-course totals", () => {
  /* The landing page cannot compute these — it only has the Linux course data
     in memory — so it hardcodes `total:` for all three. That makes it a fourth
     independent copy of every chapter count. */
  const src = read("assets/app.js");
  const block = /const\s+COURSES\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  const problems = [];
  if (!block) {
    problems.push("assets/app.js no longer declares the landing page's COURSES array — " +
                  "if the landing page was removed, drop this test with it");
  } else {
    const seen = {};
    for (const m of block[1].matchAll(/id:\s*["'](\w+)["'][\s\S]*?total:\s*(\d+)/g)) {
      seen[m[1]] = Number(m[2]);
    }
    for (const c of COURSES) {
      if (!(c.id in seen)) {
        problems.push(`assets/app.js COURSES has no entry for "${c.id}" — the landing page is ` +
                      `missing a course`);
      } else if (seen[c.id] !== truth[c.id]) {
        problems.push(`assets/app.js COURSES says ${c.id} has ${seen[c.id]} chapters, ` +
                      `${c.contentDir}/ holds ${truth[c.id]}`);
      }
    }
  }
  noProblems(problems, "landing page course totals");
});

test("the course home hero counts are computed, not hardcoded", () => {
  /* If someone ever replaces `${FLAT.length}` with a literal, this catches it
     before the number goes stale. */
  const problems = [];
  const checks = [
    ["assets/app.js", /hero-kicker">A field guide · ([^<]+) chapters/],
    ["assets/course.js", /hero-kicker">A self-paced course · ([^<]+) chapters/],
  ];
  for (const [file, re] of checks) {
    const m = re.exec(read(file));
    if (!m) { problems.push(`${file}: could not find the hero kicker chapter count`); continue; }
    if (!m[1].includes("FLAT.length")) {
      problems.push(`${file}: the hero kicker now hardcodes "${m[1]}" instead of \${FLAT.length}`);
    }
  }
  noProblems(problems, "hero chapter count");
});

test("README chapter numbers agree with the repository", () => {
  const readme = read("README.md");
  const problems = [];

  /* 1. the headline total, in the opening paragraph */
  const intro = readme.slice(0, readme.indexOf("\n## "));
  const headline = /Together they contain \*\*(\d+) chapters\*\*/.exec(intro)
    || /\*\*(\d+) chapters\*\*/.exec(intro);
  if (!headline) {
    problems.push("README.md: the opening paragraph no longer states a chapter total");
  } else if (Number(headline[1]) !== total) {
    problems.push(`README.md: headline says "**${headline[1]} chapters**" but the three courses ` +
                  `hold ${total} (${COURSES.map(c => `${c.name} ${truth[c.id]}`).join(", ")})`);
  }

  /* 2. the summary table row per course */
  for (const c of COURSES) {
    const row = new RegExp(`\\|\\s*${c.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\|\\s*(\\d+)\\s*\\|`);
    const m = row.exec(readme);
    if (!m) {
      problems.push(`README.md: no summary-table row for "${c.name}"`);
    } else if (Number(m[1]) !== truth[c.id]) {
      problems.push(`README.md: the summary table gives ${c.name} ${m[1]} chapters, actual ${truth[c.id]}`);
    }
  }

  /* 3. the per-course narrative: "Its **N chapters** progress through…" */
  for (const m of readme.matchAll(/Its \*\*(\d+) chapters\*\*/g)) {
    const n = Number(m[1]);
    if (!Object.values(truth).includes(n)) {
      problems.push(`README.md: "Its **${n} chapters**" matches no course ` +
                    `(${COURSES.map(c => `${c.name}=${truth[c.id]}`).join(", ")})`);
    }
  }

  /* 4. the repository-layout tree: "content/  N … chapters" */
  for (const c of COURSES) {
    const re = new RegExp(`content/\\s+(\\d+) ${c.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`);
    const m = re.exec(readme);
    if (m && Number(m[1]) !== truth[c.id]) {
      problems.push(`README.md repository layout: "${m[0].trim()}" but ${c.contentDir}/ holds ${truth[c.id]}`);
    }
  }

  /* 5. "That is **N entries in total**" under the Linux curriculum table */
  const entries = /That is \*\*(\d+) entries in total\*\*/.exec(readme);
  if (entries && Number(entries[1]) !== truth.linux) {
    problems.push(`README.md: "**${entries[1]} entries in total**" but content/ holds ${truth.linux}`);
  }

  /* 6. "all N chapters" — the Development section's description of tier 2 */
  for (const m of readme.matchAll(/\*\*all (\d+) chapters\*\*/g)) {
    if (Number(m[1]) !== total) {
      problems.push(`README.md: "**all ${m[1]} chapters**" but the three courses hold ${total}`);
    }
  }

  /* 7. "how many of the N chapters are read" in the features list */
  for (const m of readme.matchAll(/how many of the (\d+) chapters are read/g)) {
    if (Number(m[1]) !== truth.linux) {
      problems.push(`README.md: "how many of the ${m[1]} chapters are read" but content/ holds ${truth.linux}`);
    }
  }

  noProblems(problems, "README chapter counts");
});

test("the README's Linux curriculum table matches the BOOK parts in assets/app.js", () => {
  const readme = read("README.md");
  const linux = COURSES.find(c => c.id === "linux");
  const problems = [];
  const rows = [...readme.matchAll(/^\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*[^|]*\|$/gm)]
    .map(m => ({ section: m[1], count: Number(m[2]) }))
    .filter(r => linux.groups.some(g => g.name === r.section));

  for (const g of linux.groups) {
    const row = rows.find(r => r.section === g.name);
    if (!row) {
      problems.push(`README.md: the curriculum table has no row for BOOK part "${g.name}"`);
    } else if (row.count !== g.chapters.length) {
      problems.push(`README.md: curriculum table gives "${g.name}" ${row.count} chapters, ` +
                    `assets/app.js has ${g.chapters.length}`);
    }
  }
  const sum = rows.reduce((a, r) => a + r.count, 0);
  if (rows.length === linux.groups.length && sum !== truth.linux) {
    problems.push(`README.md: the curriculum table's rows sum to ${sum}, not ${truth.linux}`);
  }
  noProblems(problems, "README curriculum table");
});

test("the README's guided-course module lists match the COURSE arrays", () => {
  const readme = read("README.md");
  const problems = [];
  for (const c of COURSES.filter(x => x.guided)) {
    /* the narrative section runs from the course heading to the next "## " */
    const start = readme.indexOf(`## ${c.name}`);
    if (start === -1) { problems.push(`README.md: no "## ${c.name}" section`); continue; }
    const rest = readme.slice(start + 3);
    const end = rest.indexOf("\n## ");
    const section = end === -1 ? rest : rest.slice(0, end);

    /* module names as the README writes them: the COURSE `module` string with
       any "Module N — " prefix stripped, exactly as the course home renders it */
    for (const g of c.groups) {
      const short = g.name.replace(/^Module [\d.]+ — /, "");
      if (!section.includes(`**${short}**`)) {
        problems.push(`README.md: the ${c.name} section never mentions module "${short}" ` +
                      `(from ${c.dataFile}) as a bolded bullet`);
      }
    }
    /* "progress through N modules" */
    const m = /progress through (\w+) modules/.exec(section);
    const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    if (m) {
      const stated = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (stated !== c.groups.length) {
        problems.push(`README.md: says ${c.name} has ${m[1]} modules, ${c.dataFile} defines ${c.groups.length}`);
      }
    }
  }
  noProblems(problems, "README module lists");
});

test("the totals add up", () => {
  assert.equal(total, COURSES.reduce((a, c) => a + c.flat.length, 0),
    "the sum of the on-disk chapter counts and the sum of the course-data counts disagree");
});
