/* Every chapter of every course, rendered in a real browser.

   This is the tier that would have caught audit finding C1: a setTimeout in
   assets/app.js whose clearTimeout was never reached. If the chapter fetch
   resolved in under 150 ms — which is to say, on every warm navigation the
   engine works hardest to make fast — the timer fired *after* the render and
   replaced the finished chapter with the string "Loading …", wiping the pager
   and the on-this-page rail. Nothing crashed. Nothing logged. The reader just
   got a blank page on the navigations that were supposed to feel instant.

   So: navigate, wait for the render, then wait past the placeholder delay,
   and only then look. */

"use strict";

const {
  test, expect, COURSES, courseUrl, waitForChapter, readChapterState,
} = require("./helpers");

/* A chapter with less prose than this is not a chapter; the shortest real one
   in the repo is comfortably above it. */
const MIN_TEXT_LENGTH = 800;

for (const course of COURSES) {
  test.describe(`${course.name} — chapters`, () => {
    for (const ch of course.flat) {
      test(`${course.id}/${ch.slug} renders`, async ({ page, capture }) => {
        const url = courseUrl(course, `#/${ch.slug}`);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await waitForChapter(page, ch.title);

        const state = await readChapterState(page);
        const where = `${course.name} → ${ch.slug} (${url})`;

        /* ---- C1: the article must not be the loading placeholder ---- */
        expect(state.html,
          `${where}: the article element still holds the loading placeholder after render. ` +
          `This is audit finding C1 — a delayed placeholder timer fired after the chapter ` +
          `had already been painted and wiped it.`)
          .not.toMatch(/^\s*<p class="loading">/);

        expect(state.text.length,
          `${where}: rendered only ${state.text.length} characters of text ` +
          `(floor is ${MIN_TEXT_LENGTH}). Either the markdown failed to render or the ` +
          `article was replaced after rendering.`)
          .toBeGreaterThan(MIN_TEXT_LENGTH);

        /* ---- the title is the chapter's, not the course-home fallback ---- */
        expect(state.title,
          `${where}: document.title is ${JSON.stringify(state.title)}; expected it to start ` +
          `with the chapter title ${JSON.stringify(ch.title)}. A title left on the course-home ` +
          `fallback means the render path bailed before its final step.`)
          .toContain(ch.title);

        /* ---- exactly one H1, and no heading-level skips ---- */
        const h1s = state.headings.filter(h => h.level === 1);
        expect(h1s.length,
          `${where}: found ${h1s.length} <h1> elements ` +
          `(${h1s.map(h => JSON.stringify(h.text)).join(", ") || "none"}); expected exactly one.`)
          .toBe(1);

        const skips = [];
        for (let i = 1; i < state.headings.length; i++) {
          const prev = state.headings[i - 1], cur = state.headings[i];
          if (cur.level > prev.level + 1) {
            skips.push(`h${prev.level} ${JSON.stringify(prev.text)} → ` +
                       `h${cur.level} ${JSON.stringify(cur.text)}`);
          }
        }
        expect(skips,
          `${where}: the rendered heading outline skips a level. The authored markdown is ` +
          `usually clean — this is the widget/quiz layer injecting a heading at the wrong ` +
          `depth (audit finding M12), which breaks screen-reader navigation.\n  ` +
          skips.join("\n  "))
          .toEqual([]);

        /* ---- nothing in the console, nothing failed on the wire ---- */
        expect(capture.pageErrors,
          `${where}: uncaught exception(s) during render`).toEqual([]);
        expect(capture.consoleErrors,
          `${where}: console error(s) during render`).toEqual([]);
        expect(capture.failedRequests,
          `${where}: failed network request(s) during render`).toEqual([]);
      });
    }

    test(`${course.id} course home renders`, async ({ page, capture }) => {
      /* The Linux course map moved off "/" when the platform landing page took
         that route; course.homeHash is read out of the engine, not guessed. */
      await page.goto(courseUrl(course, course.homeHash), { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".chapter-card", { timeout: 15_000 });
      const cards = await page.locator(".chapter-card").count();
      expect(cards,
        `${course.name}: the course home shows ${cards} chapter cards, but the course has ` +
        `${course.flat.length} chapters`).toBe(course.flat.length);
      expect(capture.pageErrors, `${course.name} home: uncaught exception(s)`).toEqual([]);
      expect(capture.consoleErrors, `${course.name} home: console error(s)`).toEqual([]);
      expect(capture.failedRequests, `${course.name} home: failed request(s)`).toEqual([]);
    });
  });
}

/* The bare "/" route is the platform landing page: three course cards, and a
   chapter total it hardcodes because it has only the Linux course data in
   memory. If a card ever disappears, two of the three courses become
   unreachable to anyone who lands on the front page. */
test("the platform landing page lists all three courses with correct totals", async ({ page, capture }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".course-card", { timeout: 15_000 });

  const cards = await page.locator(".course-card").evaluateAll(els => els.map(el => ({
    title: el.querySelector(".course-card-title")?.textContent?.trim(),
    /* the count may live in the meter, the meta line or both, depending on
       whether this browser has any saved progress — read the whole card */
    text: (el.textContent || "").replace(/\s+/g, " ").trim(),
    href: el.getAttribute("href"),
  })));

  expect(cards.length,
    `the landing page shows ${cards.length} course cards; the site has ${COURSES.length} courses`)
    .toBe(COURSES.length);

  for (const course of COURSES) {
    const card = cards.find(c => c.title === course.name);
    expect(card, `no landing-page card for "${course.name}" — the course is unreachable from ` +
      `the front page. Cards found: ${cards.map(c => c.title).join(", ")}`).toBeTruthy();
    expect(card.text,
      `${course.name}: the landing-page card reads "${card.text}" — it never states the course's ` +
      `real chapter count (${course.flat.length}). The landing page hardcodes these totals, so ` +
      `they go stale the moment a chapter is added.`)
      .toMatch(new RegExp(`\\b${course.flat.length}\\b[\\s\\S]{0,20}chapters?`, "i"));
    expect(card.href,
      `${course.name}: the landing-page card links to "${card.href}", which is empty`).toBeTruthy();
  }

  const total = COURSES.reduce((a, c) => a + c.flat.length, 0);
  await expect(page.locator(".hero-kicker"),
    `the landing-page kicker should state the ${total}-chapter total`)
    .toContainText(`${total} chapters`);

  expect(capture.pageErrors, "landing page: uncaught exception(s)").toEqual([]);
  expect(capture.consoleErrors, "landing page: console error(s)").toEqual([]);
  expect(capture.failedRequests, "landing page: failed request(s)").toEqual([]);
});
