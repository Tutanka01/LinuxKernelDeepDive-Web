/* The four interactions the audit found broken, on one chapter per course.

   H2 — the search modal returned focus to <body> on Escape, so the next Tab
        started 60-odd stops away from where the reader had been.
   H3 — a deep-linked heading landed 33 px behind the sticky "Contents" bar,
        because the scroll offset was a hardcoded -24 rather than --sticky-h.
   M?? — horizontal overflow on a phone. `overflow-x: clip` is set site-wide,
        so scrollWidth alone proves almost nothing; what actually matters is
        that every over-wide block sits inside a scrollable region.
   theme — Mermaid and highlight.js both bake the theme in, so the toggle has
        to move more than a CSS variable. */

"use strict";

const { test, expect, COURSES, courseUrl, waitForChapter } = require("./helpers");

/* One representative chapter per course: a long one, with headings, tables and
   code, so the sticky-bar and overflow checks have something to bite on. */
const SUBJECT = {
  linux: "memory",
  distributed: "raft",
  inference: "inference-arithmetic",
};

for (const course of COURSES) {
  const slug = SUBJECT[course.id];
  const chapter = course.flat.find(c => c.slug === slug);

  test.describe(`${course.name} — interactions`, () => {
    test.skip(!chapter, `${course.name} no longer has a chapter "${slug}"`);

    test(`search modal opens, finds results, and returns focus on Escape`, async ({ page }) => {
      await page.goto(courseUrl(course, `#/${slug}`), { waitUntil: "domcontentloaded" });
      await waitForChapter(page, chapter.title);

      const trigger = page.locator("#search-open");
      await trigger.click();

      const modal = page.locator("#search-modal");
      await expect(modal, "the search modal did not open").not.toHaveAttribute("hidden", /.*/);

      await page.locator("#search-input").fill("the");
      await expect(page.locator("#search-results li").first(),
        `${course.name}: typing into search produced no results — the lazy index may have ` +
        `failed to build, which is silent by design`).toBeVisible({ timeout: 15_000 });

      await page.keyboard.press("Escape");
      await expect(modal, "the search modal did not close on Escape").toHaveAttribute("hidden", /.*/);

      const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      expect(focused,
        `${course.name}: after closing search with Escape, focus went to "${focused}" instead of ` +
        `back to the #search-open trigger (audit finding H2) — the reader's next Tab restarts ` +
        `from the top of the page`).toBe("search-open");
    });

    test(`a #/slug@heading deep link lands clear of the sticky bar`, async ({ page }) => {
      /* the sticky "Contents" bar only exists on narrow viewports */
      await page.setViewportSize({ width: 720, height: 800 });
      await page.goto(courseUrl(course, `#/${slug}`), { waitUntil: "domcontentloaded" });
      await waitForChapter(page, chapter.title);

      const id = await page.evaluate(() => {
        const el = document.querySelector("#article, #view");
        const hs = [...el.querySelectorAll("h2[id]")];
        return hs.length > 1 ? hs[hs.length - 1].id : hs[0]?.id || null;
      });
      test.skip(!id, `${course.name}/${slug} has no h2 with an id to deep-link to`);

      await page.goto(courseUrl(course, `#/${slug}@${id}`), { waitUntil: "domcontentloaded" });
      await waitForChapter(page, chapter.title);
      await page.waitForTimeout(200);

      const geom = await page.evaluate((headingId) => {
        const h = document.getElementById(headingId);
        const bar = document.getElementById("topbar");
        const barBottom = bar && getComputedStyle(bar).position === "sticky"
          ? bar.getBoundingClientRect().bottom
          : 0;
        return { top: h.getBoundingClientRect().top, barBottom, id: headingId };
      }, id);

      expect(geom.top,
        `${course.name}/${slug}: the deep-linked heading "#${geom.id}" sits at y=${Math.round(geom.top)}, ` +
        `but the sticky bar covers everything above y=${Math.round(geom.barBottom)} — the reader ` +
        `follows a link and lands on a heading they cannot see (audit finding H3)`)
        .toBeGreaterThanOrEqual(geom.barBottom);

      expect(geom.top,
        `${course.name}/${slug}: the deep-linked heading is ${Math.round(geom.top)}px down the ` +
        `viewport — far below the sticky bar, so the scroll target is wrong in the other direction`)
        .toBeLessThan(400);
    });

    test(`at 375px nothing overflows the page, and every wide block is scrollable`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(courseUrl(course, `#/${slug}`), { waitUntil: "domcontentloaded" });
      await waitForChapter(page, chapter.title);

      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(doc.scrollWidth,
        `${course.name}/${slug}: the document scrolls horizontally at 375px ` +
        `(${doc.scrollWidth} > ${doc.clientWidth})`).toBeLessThanOrEqual(doc.clientWidth);

      /* The real assertion. `overflow-x: clip` on the shell hides overflow
         rather than fixing it, so the check above passes even when content is
         genuinely cut off. What matters is that anything wider than its
         container is inside something the reader can actually scroll. */
      const escapees = await page.evaluate(() => {
        const root = document.querySelector("#article, #view");
        if (!root) return [];
        const scrollable = el => {
          for (let n = el; n && n !== document.body; n = n.parentElement) {
            if (n.classList.contains("scroll-x") ||
                n.classList.contains("table-scroll") ||
                n.classList.contains("figure-scroll")) return true;
            const ox = getComputedStyle(n).overflowX;
            if (ox === "auto" || ox === "scroll") return true;
          }
          return false;
        };
        const out = [];
        for (const el of root.querySelectorAll("pre, table, .mermaid, img, svg, .inf-widget, blockquote, ul, ol, p")) {
          const parent = el.parentElement;
          if (!parent) continue;
          const over = el.scrollWidth - parent.clientWidth;
          if (over <= 1) continue;
          if (scrollable(el)) continue;
          out.push({
            tag: el.tagName.toLowerCase(),
            cls: el.className && String(el.className).slice(0, 60),
            over,
            text: (el.textContent || "").trim().slice(0, 60),
          });
        }
        return out;
      });

      expect(escapees,
        `${course.name}/${slug}: ${escapees.length} element(s) are wider than their container at ` +
        `375px and are not inside a .scroll-x / .table-scroll wrapper. The page does not visibly ` +
        `scroll only because overflow-x: clip hides it — the content is simply cut off:\n  ` +
        escapees.map(e => `<${e.tag} class="${e.cls}"> overflows by ${e.over}px — ${JSON.stringify(e.text)}`)
          .join("\n  "))
        .toEqual([]);
    });

    test(`the theme toggle flips data-theme and swaps the highlight.js stylesheet`, async ({ page }) => {
      await page.goto(courseUrl(course, `#/${slug}`), { waitUntil: "domcontentloaded" });
      await waitForChapter(page, chapter.title);

      /* The engine's contract: paper sets html[data-theme="paper"], dark is the
         *absence* of the attribute (applyTheme() in assets/app.js). Model that
         rather than expecting a symmetric attribute. */
      const readTheme = () => page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-theme"),
        theme: document.documentElement.getAttribute("data-theme") === "paper" ? "paper" : "dark",
        hljs: [...document.querySelectorAll("link[rel=stylesheet]")]
          .map(l => l.href).find(h => /hljs|highlight|gruvbox/i.test(h)) || null,
        pressed: [...document.querySelectorAll(".theme-btn")]
          .map(b => `${b.dataset.themeValue}=${b.getAttribute("aria-pressed")}`),
      }));

      const before = await readTheme();
      expect(before.hljs,
        `${course.name}: no highlight.js stylesheet is linked at all`).not.toBeNull();

      const other = before.theme === "paper" ? "dark" : "paper";
      await page.locator(`.theme-btn[data-theme-value="${other}"]`).click();
      await page.waitForTimeout(150);

      const after = await readTheme();

      expect(after.theme,
        `${course.name}: clicking the "${other}" theme button left the page on "${after.theme}" ` +
        `(html[data-theme]=${JSON.stringify(after.attr)})`).toBe(other);
      expect(after.attr,
        `${course.name}: the dark theme is the absence of html[data-theme]; it is now ` +
        `${JSON.stringify(after.attr)}`).toBe(other === "paper" ? "paper" : null);
      expect(after.hljs,
        `${course.name}: the theme changed but the highlight.js stylesheet href did not — ` +
        `code blocks keep the previous theme's palette (${after.hljs})`).not.toBe(before.hljs);
      expect(after.pressed.join(" "),
        `${course.name}: aria-pressed on the theme buttons did not follow the change`)
        .toContain(`${other}=true`);
    });
  });
}

/* ---------------- Inference: the v3 decorators, the glossary self-test,
   the simulator and the KV calculator ----------------

   The decorators in inference/assets/inf-widgets.js run on whatever the
   chapter renders. No chapter is guaranteed to carry a [!dashboard] row or a
   provenance line while the v3 rewrite is in flight, so the test renders a
   fixture through the page's own marked and appends it to the live article:
   the same pipeline a chapter goes through, minus the fetch. */

const inference = COURSES.find(c => c.id === "inference");

/* While chapters are being added, inf.js may declare a slug whose file has
   not landed yet, and the reader prefetches its neighbour: that 404 belongs
   to the content work (tier 1 reports it as a dangling slug), not to the
   widget under test. Everything else still fails the test. */
function widgetErrors(capture) {
  const missing = capture.failedRequests.filter(r => /^404 .*\/inference\/content\/[\w-]+\.md$/.test(r));
  return capture.consoleErrors.filter(e => !(missing.length && /Failed to load resource.*404/.test(e)));
}

const V3_FIXTURE = [
  "> [!dashboard]",
  "> | resource | utilisation | saturation | errors |",
  "> |---|---|---|---|",
  "> | KV cache | `vllm:kv_cache_usage_perc` | `vllm:num_requests_waiting` | `vllm:num_preemptions_total` |",
  "",
  "```plaintext",
  "vllm:num_preemptions_total{model_name=\"meta-llama/Llama-3.3-70B-Instruct\"} 12.0",
  "```",
  "",
  "*Verbatim — vLLM v0.34.0, `vllm/v1/metrics/loggers.py`.*",
  "",
  "> **Not executed by the author.** Commands are from llama.cpp b12608; results are described by shape.",
].join("\n");

test.describe("Inference Engineering — v3 widgets", () => {
  const arith = inference.flat.find(c => c.slug === "inference-arithmetic");

  test("dashboard callout, provenance caption and lab banner are decorated, and fit at 320px", async ({ page, capture }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(courseUrl(inference, "#/inference-arithmetic"), { waitUntil: "domcontentloaded" });
    await waitForChapter(page, arith.title);

    await page.evaluate(md => {
      const host = document.createElement("section");
      host.id = "v3-fixture";
      host.innerHTML = window.marked.parse(md);
      document.querySelector("#view .article-body").appendChild(host);
    }, V3_FIXTURE);

    const dash = page.locator("#v3-fixture blockquote.callout-dashboard");
    await expect(dash, "the [!dashboard] blockquote was not turned into a callout").toHaveCount(1);
    await expect(dash.locator(".inf-callout-title")).toHaveText("On the dashboard");
    await expect(dash.locator("td[data-label='saturation']"),
      "dashboard cells did not get their column header as data-label").toHaveCount(1);

    const fit = await dash.evaluate(bq => {
      const t = bq.querySelector("table");
      return { table: t.getBoundingClientRect().width, box: bq.clientWidth, doc: document.documentElement.scrollWidth,
               vw: document.documentElement.clientWidth };
    });
    expect(fit.table, `the dashboard table is ${Math.round(fit.table)}px wide inside a ${fit.box}px callout at 320px`)
      .toBeLessThanOrEqual(fit.box);
    expect(fit.doc, "the page scrolls horizontally at 320px").toBeLessThanOrEqual(fit.vw);

    const prov = page.locator("#v3-fixture p.inf-provenance");
    await expect(prov, "the provenance line after the <pre> was not decorated").toHaveCount(1);
    await expect(prov).toHaveClass(/inf-provenance-verbatim/);
    await expect(prov.locator(".inf-provenance-kind")).toHaveText("Verbatim");
    const gap = await prov.evaluate(p => {
      const pre = p.previousElementSibling;
      return { gap: p.getBoundingClientRect().top - pre.getBoundingClientRect().bottom, preCls: pre.className };
    });
    expect(gap.preCls).toContain("inf-has-provenance");
    expect(gap.gap, "the provenance caption should sit tight under its block").toBeLessThan(12);

    await expect(page.locator("#v3-fixture blockquote.inf-lab-banner"),
      "the 'Not executed by the author.' blockquote did not get the lab banner").toHaveCount(1);

    expect(capture.pageErrors, capture.pageErrors.join("\n")).toEqual([]);
    expect(widgetErrors(capture), widgetErrors(capture).join("\n")).toEqual([]);
  });

  test("glossary self-test hides definitions and reveals them one by one", async ({ page, capture }) => {
    const gloss = inference.flat.find(c => c.slug === "glossary");
    test.skip(!gloss, "no glossary chapter");
    await page.goto(courseUrl(inference, "#/glossary"), { waitUntil: "domcontentloaded" });
    await waitForChapter(page, gloss.title);

    const toggle = page.getByRole("button", { name: "Self-test: hide definitions" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const visibleDefs = () => page.locator("dl.glossary dd:visible").count();
    expect(await visibleDefs()).toBeGreaterThan(5);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await visibleDefs(), "self-test on, but definitions are still visible").toBe(0);

    const terms = page.locator("dl.glossary .inf-gloss-term");
    const n = await terms.count();
    expect(n).toBeGreaterThan(5);
    await expect(terms.first()).toHaveAttribute("aria-expanded", "false");

    await terms.first().click();
    await expect(terms.first()).toHaveAttribute("aria-expanded", "true");
    expect(await visibleDefs()).toBe(1);

    /* keyboard: a term is a real button */
    await terms.nth(1).focus();
    await page.keyboard.press("Enter");
    await expect(terms.nth(1)).toHaveAttribute("aria-expanded", "true");
    expect(await visibleDefs()).toBe(2);
    await expect(page.locator(".inf-gloss-status")).toContainText(`2 of ${n} revealed`);

    await page.getByRole("button", { name: "Show all" }).click();
    expect(await visibleDefs()).toBe(n);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(terms, "turning the self-test off should restore plain terms").toHaveCount(0);
    expect(await visibleDefs()).toBeGreaterThanOrEqual(n);

    expect(capture.pageErrors, capture.pageErrors.join("\n")).toEqual([]);
    expect(widgetErrors(capture), widgetErrors(capture).join("\n")).toEqual([]);
  });

  test("the simulator mounts, its meters move, and it prices steps with the course's cost model", async ({ page, capture }) => {
    await page.goto("/inference/simulator.html", { waitUntil: "domcontentloaded" });
    const sim = page.locator('.inf-widget[data-widget="engine-simulator"]');
    await expect(sim.locator(".inf-results")).toBeVisible();

    const ttft = sim.locator(".inf-result-value").first();
    await expect(ttft, "TTFT p50 never left its placeholder: the simulator is not running").not.toHaveText("—", { timeout: 10_000 });

    await sim.getByRole("button", { name: /^2\. / }).click();
    await expect(sim.locator(".inf-verdict").first()).toContainText("0.9 s");
    await expect(sim.locator(".inf-verdict").last()).toContainText("effective knee");

    /* the meters respond to a control: an arrival-rate change moves the queue or TTFT */
    const before = await sim.locator(".inf-result-value").allTextContents();
    await sim.getByRole("button", { name: /^1\. / }).click();
    await page.waitForTimeout(1500);
    const after = await sim.locator(".inf-result-value").allTextContents();
    expect(after, "no meter changed after switching scenario").not.toEqual(before);

    expect(capture.pageErrors, capture.pageErrors.join("\n")).toEqual([]);
    expect(widgetErrors(capture), widgetErrors(capture).join("\n")).toEqual([]);
  });

  test("the KV calculator lands on the case's 132 GB and 66 GB pools", async ({ page, capture }) => {
    const sizing = inference.flat.find(c => c.slug === "sizing-a-deployment");
    test.skip(!sizing, "no sizing chapter");
    await page.goto(courseUrl(inference, "#/sizing-a-deployment"), { waitUntil: "domcontentloaded" });
    await waitForChapter(page, sizing.title);

    const calc = page.locator('.inf-widget[data-widget="kv-calculator"]').first();
    await expect(calc.locator(".inf-results")).toBeVisible();
    const poolTile = calc.locator(".inf-results > div", { hasText: "KV pool" }).locator(".inf-result-value");

    await calc.getByLabel("Model").selectOption("llama3-70b");
    await calc.getByLabel("GPU", { exact: true }).selectOption("h100");
    await calc.getByLabel("GPUs").selectOption("4");
    await calc.getByLabel("Weight dtype").selectOption("2");
    await expect(poolTile).toHaveText("132.0 GB");

    await calc.getByLabel("GPUs").selectOption("2");
    await calc.getByLabel("Weight dtype").selectOption("1");
    await expect(poolTile).toHaveText("66.0 GB");

    expect(capture.pageErrors, capture.pageErrors.join("\n")).toEqual([]);
  });
});
