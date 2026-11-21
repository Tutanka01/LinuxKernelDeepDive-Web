/* The review deck and the chapter warm-up, in a real browser.

   Tier 1 proves the generators and the schedule as pure functions. What
   only a browser shows: that the deck mounts on #/review, that a typed
   answer moves the card between Leitner boxes in localStorage, that the
   warm-up is injected into a chapter rendered by the shared engine — and
   only when an earlier chapter is complete — and that none of it logs an
   error. Progress is seeded through an init script, the way a returning
   reader's browser would already hold it. */

"use strict";

const { test, expect, COURSES, courseUrl, waitForChapter, SETTLE_MS } = require("./helpers");

const inf = COURSES.find(c => c.id === "inference");
const PROGRESS_KEY = "inf-course-progress-v1";
const REVIEW_KEY = "inf-review-v1";
const titleOf = slug => inf.flat.find(c => c.slug === slug).title;

/* Runs before any page script, on every navigation in this context. It only
   writes the course progress; the review schedule is left to the page, so a
   reload sees what the deck itself saved. */
async function seedProgress(page, completedSlugs) {
  await page.addInitScript(([key, slugs]) => {
    const completed = {};
    slugs.forEach(s => { completed[s] = true; });
    try { localStorage.setItem(key, JSON.stringify({ completed, last: null })); } catch (e) {}
  }, [PROGRESS_KEY, completedSlugs]);
}

async function openChapter(page, slug) {
  await page.goto(courseUrl(inf, `#/${slug}`), { waitUntil: "domcontentloaded" });
  await waitForChapter(page, titleOf(slug));
}

function noErrors(capture, where) {
  expect(capture.pageErrors, `${where}: uncaught exception(s)`).toEqual([]);
  expect(capture.consoleErrors, `${where}: console error(s)`).toEqual([]);
  expect(capture.failedRequests, `${where}: failed request(s)`).toEqual([]);
}

const readSchedule = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || "{}"), REVIEW_KEY);
const cardInfo = page => page.locator(".inf-review-card").evaluate(el => el._infReview);

test.describe("Inference — review deck", () => {
  test.skip(!inf.flat.some(c => c.slug === "review"), "the course no longer has a review page");

  test("the deck renders on #/review with nothing completed", async ({ page, capture }) => {
    await openChapter(page, "review");
    const deck = page.locator(".inf-review-deck");
    await expect(deck, "the review widget never mounted").toBeVisible();
    await expect(deck.locator(".inf-review-boxes li")).toHaveCount(6);
    await expect(deck.locator(".inf-review-empty"), "with no chapter completed the deck should say why it is empty")
      .toContainText("No cards yet");
    await expect(deck.getByLabel("include chapters I have not completed yet")).toBeVisible();

    /* ticking the box deals a card from anywhere in the course */
    await deck.getByLabel("include chapters I have not completed yet").check();
    await expect(deck.locator(".inf-review-card")).toBeVisible();
    await expect(deck.locator(".inf-review-fallback, .inf-widget-fallback")).toHaveCount(0);
    noErrors(capture, "#/review");
  });

  test("a right answer moves a card to box 2, a wrong one to box 1", async ({ page, capture }) => {
    await seedProgress(page, ["inside-a-forward-pass"]);
    await openChapter(page, "review");
    const deck = page.locator(".inf-review-deck");
    await expect(deck.locator(".inf-review-card"), "a completed chapter should unlock its cards").toBeVisible();

    /* right: type the expected answer, press Enter */
    const first = await cardInfo(page);
    expect(first, "card carries no test hook").toBeTruthy();
    const input = deck.getByLabel("Your answer");
    await input.fill(String(first.answer));
    await input.press("Enter");
    await expect(deck.locator(".inf-review-verdict")).toContainText("Right");
    await expect(deck.locator(".inf-review-solution")).toBeVisible();
    await expect(deck.locator(".inf-review-source a")).toHaveAttribute("href", "#/inside-a-forward-pass");
    let sched = await readSchedule(page);
    expect(sched[first.id] && sched[first.id].box, `${first.id} after a right answer`).toBe(2);
    expect(sched[first.id].due).toBeGreaterThan(Date.now());

    /* the next card is a different generator; answer it wrong */
    await deck.getByRole("button", { name: "Next" }).click();
    const second = await cardInfo(page);
    expect(second.id).not.toBe(first.id);
    await expect(deck.getByLabel("Your answer"), "Next should hand focus to the new card's input").toBeFocused();
    await deck.getByLabel("Your answer").fill(String(second.answer * 7));
    await deck.getByRole("button", { name: "Check" }).click();
    await expect(deck.locator(".inf-review-verdict")).toContainText("Not yet");
    sched = await readSchedule(page);
    expect(sched[second.id] && sched[second.id].box, `${second.id} after a wrong answer`).toBe(1);

    /* a reload keeps both: the answered cards are no longer due */
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForChapter(page, titleOf("review"));
    await expect(deck.locator(".inf-review-summary")).toContainText("due now");
    sched = await readSchedule(page);
    expect(Object.keys(sched).sort()).toEqual([first.id, second.id].sort());
    noErrors(capture, "#/review answering");
  });

  test("input formats: 1,500-style, 1.5e3-style and 1.5k-style answers are read", async ({ page }) => {
    await seedProgress(page, ["inside-a-forward-pass"]);
    await openChapter(page, "review");
    const deck = page.locator(".inf-review-deck");
    await expect(deck.locator(".inf-review-card")).toBeVisible();
    const { answer } = await cardInfo(page);
    await deck.getByLabel("Your answer").fill((answer / 1e3).toPrecision(6) + "k");
    await deck.getByLabel("Your answer").press("Enter");
    await expect(deck.locator(".inf-review-verdict")).toContainText("Right");
  });

  test("the warm-up appears on a later chapter once an earlier one is complete", async ({ page, capture }) => {
    await seedProgress(page, ["what-is-inference", "inside-a-forward-pass"]);
    await openChapter(page, "inference-arithmetic");
    await page.waitForTimeout(SETTLE_MS);

    const warm = page.locator("details.inf-review-warmup");
    await expect(warm, "no warm-up on a chapter after two completed ones").toHaveCount(1);
    await expect(warm.locator("summary")).toHaveText(/^Warm-up: [1-3] questions? from earlier chapters$/);
    await expect(warm, "the warm-up must start collapsed").not.toHaveAttribute("open", /.*/);

    /* placed right after the opening goal blockquote */
    const placement = await page.evaluate(() => {
      const host = document.querySelector(".inf-review-warmup-host");
      const prev = host && host.previousElementSibling;
      return { parent: host && host.parentElement.className, prev: prev && prev.tagName,
               goal: prev ? /The question/.test(prev.textContent) : false };
    });
    expect(placement.parent).toContain("article-body");
    expect(placement.prev).toBe("BLOCKQUOTE");
    expect(placement.goal, "the warm-up should follow the chapter's goal blockquote").toBe(true);

    /* the cards are from earlier chapters only, and answering works */
    await warm.locator("summary").click();
    const info = await cardInfo(page);
    expect(["what-is-inference", "inside-a-forward-pass"]).toContain(
      await page.evaluate(id => window.InfReview.byId[id].chapter, info.id));
    await warm.getByLabel("Your answer").fill(String(info.answer));
    await warm.getByLabel("Your answer").press("Enter");
    await expect(warm.locator(".inf-review-verdict")).toContainText("Right");

    /* navigating away and back must not stack a second warm-up */
    await page.goto(courseUrl(inf, "#/gpu-mental-model"), { waitUntil: "domcontentloaded" });
    await waitForChapter(page, titleOf("gpu-mental-model"));
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator(".inf-review-warmup-host")).toHaveCount(1);
    await expect(page.locator(".inf-review-warmup-slot, .inf-review-warmup-host")).toHaveCount(1);
    noErrors(capture, "warm-up");
  });

  test("no warm-up when nothing earlier is complete", async ({ page, capture }) => {
    /* only a *later* chapter completed */
    await seedProgress(page, ["quantization"]);
    await openChapter(page, "inference-arithmetic");
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator(".inf-review-warmup, .inf-review-warmup-slot, [data-mode='warmup']")).toHaveCount(0);
    noErrors(capture, "no warm-up");

    /* and none on the first chapter or on the deck itself, whatever is
       complete. (Console errors are not re-checked past this point: course.js
       preloads the first chapter's neighbour, and chapters listed in inf.js
       but not yet written 404 — that is the content's state, not this widget.) */
    await seedProgress(page, inf.slugs);
    await openChapter(page, inf.slugs[0]);
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator("[data-mode='warmup']")).toHaveCount(0);
    await openChapter(page, "review");
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator("[data-mode='warmup']")).toHaveCount(0);
    expect(capture.pageErrors, "uncaught exception(s)").toEqual([]);
  });

  test("at 320px the deck fits the screen", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await seedProgress(page, ["inside-a-forward-pass"]);
    await openChapter(page, "review");
    await expect(page.locator(".inf-review-card")).toBeVisible();
    const geom = await page.evaluate(() => {
      const deck = document.querySelector(".inf-review-deck");
      const over = [...deck.querySelectorAll("*")].filter(el => el.scrollWidth > el.clientWidth + 1 &&
        getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0).map(el => el.className || el.tagName);
      return {
        doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth,
        deckRight: deck.getBoundingClientRect().right, over,
      };
    });
    expect(geom.doc, "the page scrolls sideways at 320px").toBeLessThanOrEqual(geom.view);
    expect(geom.deckRight).toBeLessThanOrEqual(geom.view);
    expect(geom.over, "something inside the deck overflows its box").toEqual([]);
  });

  test("works with localStorage blocked", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new DOMException("blocked", "SecurityError"); },
      });
    });
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));
    await openChapter(page, "review");
    const deck = page.locator(".inf-review-deck");
    await expect(deck).toBeVisible();
    await deck.getByLabel("include chapters I have not completed yet").check();
    const { answer } = await cardInfo(page);
    await deck.getByLabel("Your answer").fill(String(answer));
    await deck.getByLabel("Your answer").press("Enter");
    await expect(deck.locator(".inf-review-verdict")).toContainText("Right");
    await expect(deck.locator(".inf-review-saved")).toContainText("blocking local storage");
    expect(pageErrors.filter(m => /review/i.test(m)), "the deck threw with storage blocked").toEqual([]);
  });
});
