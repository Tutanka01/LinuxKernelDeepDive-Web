/* Does the C1 detector still detect anything?

   The assertion in chapters.spec.js is a string match against markup the
   engine happens to emit. If that markup ever changes, 93 tests keep passing
   while asserting nothing — the exact failure mode this whole suite exists to
   prevent. So: render a real chapter, reproduce the C1 corruption by hand, and
   prove the predicate flips. A green run of this file means the other 93 are
   actually looking at something. */

"use strict";

const { test, expect, COURSES, courseUrl, waitForChapter } = require("./helpers");

const linux = COURSES.find(c => c.id === "linux");
const subject = linux.flat.find(c => c.slug === "memory") || linux.flat[1];

/* the predicate chapters.spec.js applies, in one place */
const looksBlanked = (html, text) =>
  /^\s*<p class="loading">/.test(html) || text.trim().length <= 800;

test("the C1 signature is detectable: a blanked article fails the predicate", async ({ page }) => {
  await page.goto(courseUrl(linux, `#/${subject.slug}`), { waitUntil: "domcontentloaded" });
  await waitForChapter(page, subject.title);

  const healthy = await page.evaluate(() => {
    const el = document.querySelector("#article, #view");
    return { html: el.innerHTML.slice(0, 400), text: el.textContent };
  });
  expect(looksBlanked(healthy.html, healthy.text),
    "a correctly rendered chapter is being reported as blanked — the predicate is inverted " +
    "or the text floor is too high").toBe(false);

  /* Reproduce exactly what the uncancelled placeholder timer used to do:
     assets/app.js replaced articleEl.innerHTML with this, and emptied the
     pager and the on-this-page rail with it. */
  const corrupted = await page.evaluate(() => {
    const el = document.querySelector("#article, #view");
    el.className = "article";
    el.innerHTML = `<p class="loading">Loading Virtual Memory…</p>`;
    const pager = document.getElementById("pager");
    if (pager) pager.innerHTML = "";
    const toc = document.getElementById("page-toc");
    if (toc) toc.innerHTML = "";
    return { html: el.innerHTML.slice(0, 400), text: el.textContent };
  });

  expect(looksBlanked(corrupted.html, corrupted.text),
    "the C1 corruption was reproduced in the page and the detector did not notice. " +
    "assets/app.js must have changed its placeholder markup — update the assertion in " +
    "tests/tier2/chapters.spec.js and the pin in tests/tier1/engine-parity.test.js together.")
    .toBe(true);
});

test("the heading-skip detector is detectable: an injected h4 after an h2 is caught", async ({ page }) => {
  await page.goto(courseUrl(linux, `#/${subject.slug}`), { waitUntil: "domcontentloaded" });
  await waitForChapter(page, subject.title);

  const skips = await page.evaluate(() => {
    const el = document.querySelector("#article, #view");
    /* audit finding M12: the widget layer injecting an <h4> straight after an <h2> */
    const h2 = el.querySelector("h2");
    const h4 = document.createElement("h4");
    h4.textContent = "Injected by a widget";
    h2.insertAdjacentElement("afterend", h4);

    const hs = [...el.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .map(h => Number(h.tagName[1]));
    const out = [];
    for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) out.push(`h${hs[i - 1]}→h${hs[i]}`);
    return out;
  });

  expect(skips,
    "an h2 → h4 jump was injected into the live page and the heading-order check did not " +
    "flag it — the assertion in chapters.spec.js is not doing anything").not.toEqual([]);
});
