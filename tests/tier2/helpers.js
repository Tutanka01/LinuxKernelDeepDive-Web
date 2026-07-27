/* Shared fixtures for the browser tier.

   `chapterPage` is the important one: it wires up console/network capture
   *before* the first navigation (a listener attached after goto() misses the
   errors that matter), navigates to a chapter, waits for the render to settle,
   and then waits past the engine's 150 ms placeholder timer before handing
   the page over. That last wait is the whole point of this tier — audit
   finding C1 was a timer that fired *after* a successful render and replaced
   the chapter with "Loading …". Asserting immediately after render would
   never have seen it. */

"use strict";

const { test: base, expect } = require("@playwright/test");
const { COURSES } = require("../lib/repo");

/* assets/app.js schedules its placeholder at 150 ms; wait comfortably past it */
const PLACEHOLDER_DELAY_MS = 150;
const SETTLE_MS = PLACEHOLDER_DELAY_MS + 250;

const courseUrl = (course, hash = "") =>
  `/${course.baseDir ? course.baseDir + "/" : ""}${hash}`;

/* The element each engine renders a chapter into. */
const ARTICLE_SELECTOR = "#article, #view";

/* Ignore noise that is not the site's fault. Anything else is a failure. */
const IGNORED_CONSOLE = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
];

function attachCapture(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some(re => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", err => pageErrors.push(`${err.name}: ${err.message}`));
  page.on("requestfailed", req => {
    const url = req.url();
    if (IGNORED_CONSOLE.some(re => re.test(url))) return;
    failedRequests.push(`${req.method()} ${url} — ${req.failure()?.errorText || "failed"}`);
  });
  page.on("response", res => {
    if (res.status() < 400) return;
    if (IGNORED_CONSOLE.some(re => re.test(res.url()))) return;
    failedRequests.push(`${res.status()} ${res.url()}`);
  });

  return { consoleErrors, pageErrors, failedRequests };
}

/* Wait until the engine has finished rendering a chapter: the article element
   holds real markup and the document title is no longer the course-home one. */
async function waitForChapter(page, expectedTitle) {
  try {
    await page.waitForFunction(
      (title) => {
        const el = document.querySelector("#article, #view");
        if (!el) return false;
        if (el.querySelector("p.loading")) return false;
        const h1 = el.querySelector("h1");
        if (!h1) return false;
        return document.title.startsWith(title.slice(0, 30));
      },
      expectedTitle,
      { timeout: 15_000 },
    );
  } catch (err) {
    /* a bare "waitForFunction timed out" says nothing about which chapter or
       what the page was actually showing */
    const state = await page.evaluate(() => {
      const el = document.querySelector("#article, #view");
      return {
        url: location.href,
        title: document.title,
        html: el ? el.innerHTML.slice(0, 300) : "(no #article / #view element)",
      };
    }).catch(() => ({ url: "?", title: "?", html: "(page unavailable)" }));
    throw new Error(
      `The chapter never finished rendering.\n` +
      `  expected title to start with: ${JSON.stringify(expectedTitle)}\n` +
      `  url:   ${state.url}\n` +
      `  title: ${JSON.stringify(state.title)}\n` +
      `  article: ${state.html}\n` +
      `  original: ${err.message}`);
  }
  /* let the pending placeholder timer — if any — fire */
  await page.waitForTimeout(SETTLE_MS);
}

/* Read everything the per-chapter assertions need, in one round trip. */
async function readChapterState(page) {
  return page.evaluate(() => {
    const el = document.querySelector("#article, #view");
    const body = el.querySelector(".article-body") || el;
    const headings = [...el.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter(h => !h.closest(".page-toc, .sidebar, .topbar"))
      .map(h => ({
        level: Number(h.tagName[1]),
        text: (h.textContent || "").replace(/¶$/, "").trim().slice(0, 80),
      }));
    return {
      html: el.innerHTML.slice(0, 400),
      text: (body.textContent || "").trim(),
      title: document.title,
      headings,
      hasPager: !!document.querySelector("#pager a, .pager a"),
      pageTocEntries: document.querySelectorAll("#page-toc a, .inline-toc a").length,
    };
  });
}

const test = base.extend({
  capture: async ({ page }, use) => {
    await use(attachCapture(page));
  },
});

module.exports = {
  test, expect, COURSES,
  courseUrl, waitForChapter, readChapterState,
  ARTICLE_SELECTOR, SETTLE_MS,
};
