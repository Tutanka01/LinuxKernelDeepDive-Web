/* The GPU–Kernel Track, in a browser.

   The track shipped as a standalone page — its own layout, its own back-links
   row, its own theme buttons — and read as a different site. It now runs in
   the same shell as the three courses, which means it has the same things to
   get wrong: a drawer that traps focus, a theme switch shared through
   localStorage with every other page, a rail whose links have to actually
   arrive somewhere.

   The rail is the reason this file exists. Its links are #phase-<id>
   fragments into sections that path.js injects after parse, and the page
   scrolls to them itself rather than letting `scroll-behavior: smooth` animate
   7,000px. Both of those are places where the hash can change and the page not
   move, so every scroll assertion here reads window.scrollY — a test that only
   checked location.hash would pass against a page that never went anywhere. */

"use strict";

const { test, expect } = require("./helpers");

const TRACK = "/path/";
const DELIVERABLE_KEY = "path-gpu-kernel-deliverables-v1";

test.describe("The GPU–Kernel Track", () => {

  test("renders the shared shell, the six phases and every step", async ({ page, capture }) => {
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });

    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator("#toc .toc-list a")).toHaveCount(6);
    await expect(page.locator(".phase")).toHaveCount(6);

    /* the rail says which page you are on, exactly once */
    await expect(page.locator(".course-chip.current")).toHaveCount(1);
    await expect(page.locator(".course-chip.current")).toHaveAttribute("aria-current", "page");

    /* every step is a link into one of the three courses — the track owns no
       chapters, so a step pointing at this directory is a bug */
    const hrefs = await page.locator(".chapter-card").evaluateAll(
      els => els.map(e => e.getAttribute("href")));
    expect(hrefs.length).toBeGreaterThan(30);
    for (const href of hrefs) {
      expect(href, `"${href}" does not leave the track for a course`)
        .toMatch(/^\.\.\/(distributed\/|inference\/)?#\//);
    }

    expect(capture.pageErrors, "the track page threw").toEqual([]);
    expect(capture.consoleErrors, "the track page logged errors").toEqual([]);
    expect(capture.failedRequests, "the track page requested something that 404ed").toEqual([]);
  });

  test("a phase link in the rail actually scrolls to that phase", async ({ page }) => {
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });

    await page.locator('#toc a[data-phase="memory"]').click();

    await expect.poll(
      () => page.evaluate(() => Math.round(window.scrollY)),
      { message: "clicking a phase in the rail changed the hash but never moved the page" },
    ).toBeGreaterThan(100);

    expect(await page.evaluate(() => location.hash)).toBe("#phase-memory");

    /* and it lands at the heading, not somewhere near it */
    const top = await page.evaluate(() =>
      Math.round(document.getElementById("phase-memory").getBoundingClientRect().top));
    expect(Math.abs(top), `phase 2 landed ${top}px from the top of the viewport`).toBeLessThan(40);
  });

  test("a phase heading opened by deep link clears the sticky bar", async ({ page }) => {
    /* the sticky bar only exists below the drawer breakpoint */
    await page.setViewportSize({ width: 720, height: 800 });
    await page.goto(`${TRACK}#phase-frontier`, { waitUntil: "domcontentloaded" });

    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)),
      { message: "a #phase- deep link opened cold did not scroll" }).toBeGreaterThan(100);

    const clearance = await page.evaluate(() => {
      const bar = document.getElementById("topbar");
      const heading = document.querySelector("#phase-frontier h2");
      return Math.round(heading.getBoundingClientRect().top - bar.getBoundingClientRect().bottom);
    });
    expect(clearance,
      `the phase heading landed ${clearance}px from the bottom of the sticky bar — ` +
      `a negative number means it is behind it`).toBeGreaterThanOrEqual(0);
  });

  test("a deliverable ticks, persists, and is the only one that moves", async ({ page }) => {
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });

    const first = page.locator("[data-deliverable]").first();
    await expect(first).toHaveAttribute("aria-pressed", "false");

    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".phase.is-delivered")).toHaveCount(1);

    /* the tick is ours; the chapter ticks belong to the courses and this page
       must never write to them */
    const stored = await page.evaluate(key => ({
      ours: localStorage.getItem(key),
      linux: localStorage.getItem("ldd-read"),
    }), DELIVERABLE_KEY);
    expect(JSON.parse(stored.ours)).toHaveLength(1);
    expect(stored.linux, "the track wrote to the Linux course's reading progress").toBeNull();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-deliverable]").first())
      .toHaveAttribute("aria-pressed", "true");

    /* and it un-ticks */
    await page.locator("[data-deliverable]").first().click();
    await expect(page.locator(".phase.is-delivered")).toHaveCount(0);
  });

  test("a chapter read in a course shows as read on the track", async ({ page }) => {
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });
    /* write the Linux course's own key, the way that course does */
    await page.evaluate(() => localStorage.setItem("ldd-read", JSON.stringify(["prereq-c"])));
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.locator('.chapter-card[data-slug="prereq-c"]')).toHaveClass(/done/);
    await expect(page.locator("#progress-summary")).toContainText("1 /");
  });

  test("search finds a step and leaves for its course", async ({ page }) => {
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });

    await page.locator("#search-open").click();
    const modal = page.locator("#search-modal");
    await expect(modal).not.toHaveAttribute("hidden", /.*/);

    await page.locator("#search-input").fill("iommu");
    const first = page.locator("#search-results .search-result").first();
    await expect(first, "searching the track for a word in a step title found nothing")
      .toBeVisible();
    await expect(first).toContainText("IOMMU");

    await page.keyboard.press("Escape");
    await expect(modal).toHaveAttribute("hidden", /.*/);
    expect(await page.evaluate(() => document.activeElement?.id),
      "closing search with Escape dropped focus instead of returning it to the trigger")
      .toBe("search-open");
  });

  test("the theme switch is the site's, and is shared with the courses", async ({ page }) => {
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });

    await page.locator('.theme-btn[data-theme-value="paper"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
    /* the rail styles the pressed button on the class, not on aria-pressed */
    await expect(page.locator('.theme-btn[data-theme-value="paper"]')).toHaveClass(/active/);
    expect(await page.evaluate(() => localStorage.getItem("ldd-theme"))).toBe("paper");

    /* a course opened next must come up in the same theme, with no flash */
    await page.goto("/#/course", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  });

  test("on a phone the rail is a drawer, and is out of the tab order when shut", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });

    const toggle = page.locator("#sidebar-toggle");
    await expect(toggle).toBeVisible();
    await expect(page.locator("#toc .toc-list a").first()).toBeHidden();

    await toggle.click();
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await expect(page.locator("#toc .toc-list a").first()).toBeVisible();

    /* tapping a phase closes the sheet it was tapped through, and scrolls */
    await page.locator('#toc a[data-phase="patch"]').click();
    await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)),
      { message: "tapping a phase in the drawer did not scroll to it" }).toBeGreaterThan(100);
  });

  test("the page never scrolls sideways on a small phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(TRACK, { waitUntil: "domcontentloaded" });

    const overflow = await page.evaluate(() => {
      const wide = [...document.querySelectorAll("#track *")]
        .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map(el => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
      return { wide: wide.slice(0, 5), count: wide.length };
    });
    expect(overflow.count, `${overflow.count} elements run past the right edge: ` +
      overflow.wide.join(", ")).toBe(0);
  });
});
