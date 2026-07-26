# UI/UX Audit — 2026-07-26

**Scope.** The whole static site: the platform shell (`index.html`, `assets/style.css`,
`assets/course.css`), the two reader engines (`assets/app.js` for The Linux Deep Dive,
`assets/course.js` for the two guided courses), the three course shells
(`/`, `/distributed/`, `/inference/`), the standalone `/inference/simulator.html`,
the inference widget layer (`inference/assets/inf*.js`, `inf.css`), the 23 baked SVG
diagrams, and all 93 chapters of Markdown.

**Method.** Three independent audits were run in parallel — a design-system/visual audit,
a responsive/rendering audit across every course page, and an accessibility/interaction/
content-density audit — and every load-bearing claim was then re-verified by the author of
this document against the site running locally in headless Chromium (CDP geometry probes,
computed styles, screenshots) at 360 / 390 / 800 / 1024 / 1280 / 1440 / 1600 / 1800 px in
both themes. Contrast ratios were recomputed from the token values with an sRGB
relative-luminance script, alpha-compositing `accent-soft` and `opacity` grounds before
measurement.

**Convention.** Findings are split into **verified bugs** — something is objectively broken
and there is code or a measurement to point at — and **design recommendations**, which are
judgement calls about hierarchy, density and orientation. Ranked Critical / High / Medium /
Low by reader impact, not by effort.

---

## 0. Executive summary

The shell is genuinely well built. One `html[data-theme="paper"]` block that overrides only
custom properties means there is no class-by-class theme gap to hunt; the breakpoint ladder
is contiguous at integer widths; `overflow-x: clip` plus `wrapTables()` means **no page on
the site pushes the document sideways at 360 px** — a full sweep of all 24 inference
chapters, all 13 distributed chapters and the 12 riskiest Linux chapters reported zero
document-level overflow. Error and empty states are honest, including the `localStorage`
refusal paths. The 23 inference SVGs carry 200–600 character alt text that describes the
*finding*, not the picture; that is best-in-class and must not be touched.

What is wrong falls into five clusters:

1. **Two rendering bugs that destroy content.** A never-cleared `setTimeout` wipes freshly
   rendered Linux chapters back to `Loading …`; a global `appearance: none` makes every
   checkbox in the site render at 0×0, including the four switches the engine simulator's
   whole lesson is built on.
2. **Figures do not survive a phone.** Mermaid renders at 0.28 scale and the baked SVGs at
   0.37 scale, so 14 px and 9 px labels land at 3.4–3.9 CSS px. Both are shrink-to-fit with
   no scroll, no zoom and no escape.
3. **A recessive-ink token pushed one step too far.** `--text-faint` is 2.95–3.61 : 1 in
   both themes and colours roughly thirty components — the entire orientation layer.
4. **Keyboard operation is technically present and practically unusable.** 64 tab stops
   before `<main>`, 63 phantom stops inside the closed drawer, a `role="dialog"` with none
   of the dialog behaviour, and scroll containers that cannot be reached at all.
5. **Drift between the three courses.** Two number formats in the same TOC rail, two
   completion affordances, a level-badge colour system that was designed and never wired
   up, module numbering that contradicts the sidebar beside it, and a chapter count that is
   wrong on every page of the site.

---

## CRITICAL

### C1 — A never-cleared placeholder timer wipes rendered Linux chapters back to `Loading …`
`assets/app.js:715` (pre-fix)

```js
const placeholder = setTimeout(() => {
  articleEl.className = "article";
  articleEl.innerHTML = `<p class="loading">Loading ${TITLE_OF[slug]}…</p>`;
  pagerEl.innerHTML = "";
  if (pageTocEl) pageTocEl.innerHTML = "";
}, 150);

try {
  const raw = await fetchChapterSource(slug);
  ...
```

`clearTimeout(placeholder)` is never called — `grep -n clearTimeout assets/app.js` returned
nothing. If the fetch resolves in under 150 ms the chapter renders, and 150 ms later the
timer fires and replaces it with `Loading …`, blanks the pager and blanks the on-this-page
rail. Permanently: nothing re-renders until the next navigation.

**Verified.** Headless Chromium against a local server, `#/tcp-congestion`: `document.title`
was correctly `"TCP Congestion Control & Tuning — The Linux Deep Dive"` (set at the end of a
*successful* render) while `#article.innerHTML` was 67 bytes of
`<p class="loading">Loading TCP Congestion Control & Tuning…</p>`.

This fires on exactly the navigations the engine works hardest to make fast: `preloadNeighbours()`
warms the chapters on either side, so the pager and ←/→ are cache hits and land well inside
150 ms; so does anything already fetched by the search indexer. The faster the connection,
the more often the book blanks itself. `assets/course.js` has no placeholder timer and is
unaffected.

### C2 — Every `<input type="checkbox">` on the site renders 0×0
`assets/style.css:94`

```css
button, input {
  -webkit-appearance: none;
  appearance: none;
  font: inherit;
  color: inherit;
}
```

`appearance: none` on a bare `input` strips checkboxes and radios too. `inference/assets/inf.css:282`
supplies only `accent-color`, which is a no-op once appearance is stripped, and there is no
custom box anywhere.

**Verified.** `/inference/simulator.html` at 1440 px: 4 `.inf-toggle input[type=checkbox]`,
every one measuring `{w: 0, h: 0, appearance: "none"}`.

The blast radius is the flagship interactive: *chunked prefill*, *prefix caching*,
*speculative decoding* and *inject a 10K prompt* have no box, no tick and no state indicator
at any width. Because they sit inside `<label>`, clicking still toggles the underlying input —
so the reader flips state **blind**, and simulator scenarios 2, 3 and 6, whose captions read
"tick this box and watch the spike flatten", are unverifiable by eye. The author hit this bug
once already and patched it locally for quiz radios only (`assets/course.css:248`,
`.quiz-choice input { appearance: auto; … }`) without generalising it.

Related, same root cause: `input[type="range"]` is also stripped, and there are no
`::-webkit-slider-thumb` / `::-webkit-slider-runnable-track` rules anywhere. Chromium
supplies a fallback track (measured 16 px tall); WebKit/iOS renders an unstyled
`appearance: none` range as an **invisible** track and thumb. Unverified on real Safari, but
the same one-line class of defect, on the primary phone platform.

### C3 — Mermaid diagrams are illegible on a phone; 50 of 56 Linux chapters carry one
`assets/app.js:248-274` fixes `fontSize: "14px"` in both Mermaid themes;
`assets/style.css:946` caps the result at `max-width: 100%`.

**Verified.** `#/networking` at 360 px: the emitted SVG has `viewBox="-50 -10 1122 505"` and
renders at **310 × 140 — scale 0.28**, so a 14 px node label lands at **3.9 CSS px**.

Unlike `<pre>` and `<table>`, `pre.mermaid` is `text-align: center` with no `overflow-x`, so
the diagram is *shrunk to fit* rather than made scrollable. There is no zoom, no tap-to-open
and no fallback. Distributed and Inference contain zero mermaid fences.

### C4 — The 23 baked inference SVGs are illegible on a phone, and so is the stack map
Every file in `inference/assets/diagrams/` is authored at `viewBox="0 0 880 …" width="880"`;
`inference/assets/inf.css:24` caps them at `max-width: 100%`.

At 360 px the column is 328 px, so the render scale is **0.373**. Authored label sizes across
the set: 94 elements at 9 px, 117 at 10 px, 122 at 11 px, 102 at 12 px. Rendered:

| authored | at 360 px | at 1400 px |
|---|---|---|
| 8 px (`launch-gap.svg`) | **2.98 px** | 5.7 px |
| 9 px (7 files) | **3.35 px** | 6.5 px |
| 10 px (10 files) | **3.73 px** | 7.2 px |
| 17 px figure titles | 6.3 px | 12.2 px |

Even on a 1400 px desktop the smallest annotations render below the page's smallest body
text. There is no `<a>` wrapper, no click handler and no lightbox — measured
`img has click/zoom handler: false`.

The same defect hits `inf-stackmap.js`, which builds `viewBox="0 0 880 118"` with 18 px and
16 px labels. At 360 px the strip renders 328 × 44, so "Scheduler" sets at **6.7 px** and
"KV cache" at **6.0 px** — and this strip heads 21 chapters.

### C5 — `--text-faint` fails AA in both themes and colours the entire orientation layer
`assets/style.css:20` `--text-faint: #6d6456` · `assets/style.css:65` `--text-faint: #877d68`

| | on `--bg` | on `--bg-raised` | required |
|---|---|---|---|
| dark `#6d6456` | **3.07 : 1** | **2.95 : 1** | 4.5 : 1 |
| paper `#877d68` | **3.61 : 1** | **3.42 : 1** | 4.5 : 1 |

Recomputed independently; both audits agree. Every consumer is body-size or smaller, so every
one needs 4.5 : 1 and none reach it. The consumers are, in full: `.toc-num`, `.toc-part`,
`.toc-list a.read .toc-title`, `.chip-desc`, `.chip-title::after`, `.course-switch-title`,
`.site-subtitle`, `.sidebar-footer`, `.search-open`, `.search-kbd`, `.search-hint`,
`.search-footer`, `.sr-part`, `.theme-btn` (idle), `.sidebar-collapse`, `.progress-count`,
`.card-num`, `.chapter-card.done .card-title`, `.hero-hint`, `.hero-kicker`, `.ring-label span`,
`.module-index`, `.crumb`, `.read-time`, `.chapter-meta`, `.meta-item`, `.meta-read-btn`,
`.meta-prereqs`, `.pager-label`, `.page-toc a`, `.page-toc-title`, `.page-footer`, `.loading`,
`li::marker`, `.inf-result-label`, `.inf-stackmap-cap`.

This is not thirty bugs; it is one token. The stated intent — *"Everything structural
recedes; the reading column is the only place that carries contrast"* (`style.css:2-6`) — is
a good instinct executed one step too far. Chapter numbering, reading time, breadcrumbs, the
on-this-page rail, the theme-switch labels and the whole search chrome are sub-threshold.

---

## HIGH

### H1 — Keyboard operation: 64 stops before `<main>`, 63 phantom stops in the closed drawer
No skip link exists — `grep -rn "skip\|tabindex"` across all HTML/CSS/JS returns nothing.

**Verified.** At 1440 px on `#/tcp-congestion`, counting visible focusables preceding
`<main>`: **64**. `loadChapter()` and `renderChapter()` replace the content wholesale and
never move focus, so this is paid again after every navigation.

**Verified.** At 390 px with the drawer closed, `assets/style.css:1004` keeps
`visibility: visible` with `transform: translateX(-100%)`. Measured: **63 focusable
off-screen links**, and `.focus()` on one succeeds. A keyboard or switch-control user tabbing
past the Contents button falls into 56 invisible chapter links plus the search, theme and
course controls.

`setSidebar()` (`app.js:908`, `course.js:661`) never moves focus into the drawer, never traps
it, and never restores it. Measured `document.activeElement` after opening: `BODY`.

### H2 — The search modal is a `role="dialog"` with none of the dialog behaviour
`index.html:98` and both course shells declare `role="dialog"` — and nothing else.
`grep -rn "aria-modal\|inert"` returns zero.

**Verified.** `document.getElementById('search-modal').getAttribute('aria-modal')` → `null`.

Four defects at once: screen readers never enter dialog mode; one Tab from `#search-input`
walks out of the modal into the ~60 links behind the scrim, which stay reachable and
clickable while the visual scrim says they are not; `closeSearch()` never restores focus, so
after Escape the next Tab restarts at stop #1; and the modal locks nothing, so the article
scrolls behind it (`grep -rn overscroll` → none, so `#search-results` also chains its scroll
into the page).

Results are non-focusable `<li>`s with raw click handlers — the only click handler in the
codebase bound to a non-focusable element. The list has no `role="listbox"`, the rows no
`role="option"` / `aria-selected`, and nothing on the site has `aria-live`. A screen-reader
user types a query and hears silence: no result count, no "no results", no indexing progress.
`.selected` is presentational only.

**Verified.** `#search-input { outline: none }` (`style.css:810`) is the only `outline: none`
in the repo and beats the global `*:focus-visible` (`style.css:126`) on ID specificity —
`getComputedStyle(...).outlineStyle` → `"none"`. The one control inside the dialog has no
focus indicator.

### H3 — Deep-link anchors land behind the sticky Contents bar on every phone and tablet
`assets/app.js:896` / `assets/course.js:336`

```js
const y = el.getBoundingClientRect().top + window.scrollY - 24;
```

**Verified.** At 390 px on `#/networking`: sticky bar bottom = **57 px**; after an anchor
jump the target heading's top = **24 px**. The heading is 33 px behind the bar.
`grep -rn "scroll-margin"` across all three stylesheets → none;
`getComputedStyle(h2).scrollMarginTop` → `0px`.

Three unrelated magic numbers govern one geometry: `-24` in `scrollToAnchor`, `<= 90` in the
scroll-spy (`app.js:625`, `course.js:317`), and `min-height: 3.25rem` on the bar
(`style.css:983`).

### H4 — Wide tables and code blocks cannot be scrolled by keyboard, and give no cue that they scroll
`wrapTables()` coverage is complete — every table measured across all three courses sits in a
`.table-scroll`. But the wrapper is built with no `tabindex`, no `role` and no label, and
`.article pre` likewise.

**Verified.** `document.querySelector('.table-scroll').tabIndex` → `-1`;
`document.querySelector('.article pre').tabIndex` → `-1`. WCAG 2.1.1: the right-hand columns
of a 6.4-screen-wide table are unreachable without a mouse or touch.

Measured horizontal scroll distances at 360 px (client width 328 px):

| chapter | cols | table px | screens |
|---|---|---|---|
| `inference/content/operating-it.md:107` | 4 | **2089** | **6.4×** |
| `content/snapshot-taxonomy.md:420` | 5 | **1707** | 5.2× |
| `inference/content/choosing-model-gpu-framework.md:295` | 4 | 1570 | 4.8× |
| `content/rust-kernel.md:80` | 2 | 1336 | 4.1× |
| `content/devices-modules.md:357` | 3 | 1079 | 3.3× |
| `distributed/content/real-world-architectures.md:149` | 6 | 876 | 2.7× |

Column count is a poor predictor — cell prose length drives it. `.table-scroll` has no
edge fade, shadow or caption, so a phone reader has no signal that six more screens exist.
The same applies to code: a screenshot of `#/sizing-a-deployment` at 390 px shows the
arithmetic block cut mid-token at `160 GB (70 G` with nothing to indicate more.

Compounding: ArrowLeft/ArrowRight are captured globally (`app.js:1160`, `course.js:922`) with
a `typing` guard that only checks `INPUT|TEXTAREA|SELECT`. Once these containers *are* made
focusable, pressing → to scroll a code block would navigate to the next chapter instead.

### H5 — Default browser blue on both guided-course home pages
`assets/course.js:425`

```js
<p>Part of <a href="../">The Linux Deep Dive</a> — but a journey of its own.</p>
```

The home view is `<div class="home">`, not `.article`, so `.article a` never matches, and
there is no global `a { color }` rule in any of the three stylesheets.

**Verified.** `/inference/#/` → `getComputedStyle('.page-footer a').color` = **`rgb(0, 0, 238)`**.
Unstyled `#0000EE`, plus `#551A8B` when visited, in the middle of a warm amber/ivory palette,
in both themes, on both guided courses.

### H6 — The difficulty-level badge colour system was designed and never wired up
`assets/course.js:383` and `:571` emit `class="lvl-badge lvl-${mod.level}"` →
`lvl-beginner`, `lvl-intermediate`, `lvl-advanced`. **No stylesheet defines any of them.**
`style.css:658-660` defines `.level-core` / `.level-mechanism` / `.level-internals` — a
different scheme, for the other course.

**Verified.** `/inference/#/` — all nine badges return the identical
`color: rgb(143, 93, 26)` despite carrying three different level classes. PREFACE, BEGINNER,
BEGINNER+, INTERMEDIATE and ADVANCED+ are visually indistinguishable; the difficulty
progression the course data models is invisible.

### H7 — Module numbering on the home contradicts the sidebar beside it
`assets/course.js:378-380` emits the positional index and then strips the authored number:

```js
<span class="module-index">${String(mi + 1).padStart(2, "0")}</span>
<h2>${mod.module.replace(/^Module \d+ — /, "")}</h2>
```

**Verified.** `/inference/#/` home reads `01 Before we start`, `02 The Physics`,
`03 The Engine`, while the sidebar for the same sections reads `Before we start`,
`Module 1 — The Physics`, `Module 2 — The Engine`. Every module is off by one because the
unnumbered preface occupies index 1, and `inf.js` contains a "Module 3.5" that an integer
index cannot represent.

### H8 — The inference disclosure design is overridden by the shared `.article details` block
Guided chapters render as `<article class="article"><div class="article-body">`
(`course.js:565`), so `assets/style.css:718` and `inference/assets/inf.css:116` both match at
equal specificity. `inf.css` sets only `border-top`, so `border: 1px solid var(--rule)`,
`border-radius: 6px` and `background: var(--rule-soft)` all survive; `font-family: var(--mono)`
is never reset, so every FAQ and exercise summary renders in monospace rather than the serif
the inf.css design implies; and `padding: 0 1.1rem` stacks with `margin-left: 1.4rem` so
answer bodies sit ~40 px in from the column. `inf.css:160`
(`.exercise details { border-top-color: … }`) is the smoking gun: the author believed only a
top border existed. Affects every inference chapter with a `<details>`.

### H9 — `¶` heading anchors are invisible tab stops, and unreachable on touch
`assets/style.css:898` sets `opacity: 0` with a hover-only reveal, and no `:focus-visible`
rule. `opacity: 0` suppresses the outline too, so the global focus ring paints nothing.

**Verified.** `getComputedStyle('.hlink').opacity` → `"0"`; measured hit area **8 × 16**.

A chapter with 16 headings inserts 16 completely invisible tab stops. `grep -rn "any-hover\|pointer:"`
→ none, so on any touch device the anchor never appears at all: section-level sharing, a
first-class feature of the `#/slug@heading` URL scheme, is unreachable on phones and tablets.
Even revealed, the idle glyph colour is `var(--rule)` — **1.21 : 1**.

### H10 — Links are distinguished by colour alone
`assets/style.css:498-504` — `text-decoration: none` with a zero-width gradient underline that
animates in on hover only. Link colour against the surrounding body text: **1.43 : 1 (dark)**,
**2.32 : 1 (paper)**; WCAG 1.4.1 requires ≥ 3 : 1 when colour is the only distinguisher, plus
a non-colour cue. There is no `:focus-visible` underline reveal either, so the single
non-colour cue is mouse-exclusive.

### H11 — Callout and badge labels fail AA; `--accent-dim` is inverted between themes
`--accent-dim` is *darker* than `--accent` in dark (`#a4783f` vs `#d9a05b`) and *lighter* in
paper (`#b08a4e` vs `#8f5d1a`) — so a token used as a text colour flips polarity with the
theme.

| pair | ratio | required |
|---|---|---|
| `.callout-*::before`, `.inf-callout-title` — `#a4783f` on `#2b231a` | **3.93 : 1** | 4.5 |
| same, paper — `#b08a4e` on `#eee5d6` | **2.55 : 1** | 4.5 |
| `.quiz-flag` "Checkpoint", paper — `#b08a4e` on `#f1ebdd` | **2.68 : 1** | 4.5 |
| `.inf-result-note a` (a link), paper | **2.68 : 1** | 4.5 |
| `.toc-list a.active`, `.theme-btn.active`, `.course-chip.current`, paper | **4.27 : 1** | 4.5 |
| `.lvl-badge`, `.complete-toggle.done`, `.callout-nuance::before`, paper | **4.49 : 1** | 4.5 |

The label that tells you *what kind of box this is* is the least readable text in the box.

### H12 — No loading state, no focus move and no announcement on chapter navigation
`course.js:564` awaits the fetch with the previous chapter still on screen and then swaps
`innerHTML` — no placeholder, no `aria-busy`, no `aria-live`, no focus move. On a slow
connection the page simply looks frozen. Clicking the pager destroys the focused element;
focus falls to `<body>`, compounding H1. `grep -rn aria-live` across the repo → zero.

### H13 — The engine simulator autoplays an unbounded rAF loop with no reduced-motion gate
`inference/assets/inf-simulator.js:578` `playing: true` and `:893` `raf = requestAnimationFrame(frame)`.
The only two `prefers-reduced-motion` checks in all the JS (`app.js:299`, `course.js:123`)
guard the theme cross-fade. Navigating to `continuous-batching`, `paged-kv-cache`,
`speculative-decoding`, `the-kv-fabric`, `agentic-serving` or `/inference/simulator.html`
starts a continuously moving canvas for a reader who has asked the OS for no motion. A Pause
button exists (`:656`), which satisfies 2.2.2 — but the default should be paused, not
"find the button first".

### H14 — Quiz correctness is conveyed by border colour alone
`course.js:467-477` toggles `.right` / `.wrong`, which `course.css:232-233` renders as a
border colour. No icon, no text, no `aria-invalid`. `--quiz-good` vs `--quiz-bad` measures
**1.30 : 1 (dark)** and **1.23 : 1 (paper)** — indistinguishable under deuteranopia or
protanopia. Only the aggregate result has `role="status"`; the per-question explanations are
un-hidden with no live region, so a screen-reader user hears "3/5 correct" and cannot learn
*which* three. This is the mechanism that gates chapter completion in both guided courses.

### H15 — Widget results and calculator verdicts are never announced; canvases have no name
`inf-calculators.js:294-317`, `:319`, `:644`, `:826` and `inf-simulator.js:604-620` replace
`innerHTML` on `.inf-results` / `.inf-verdict` with no `role="status"` and no `aria-live`.
The inputs are correctly labelled — `InfWidgets.slider`/`select` build real `<label for>`
pairs, which is a genuine strength — so a screen-reader user can move a slider and never
receive the answer.

`InfWidgets.canvas()` (`inf-widgets.js:123`) creates a bare `<canvas>`: no `role="img"`, no
`aria-label`, no fallback content. `/inference/simulator.html` is a page whose only content
is that canvas.

Related: the sliders are *index* sliders with no `aria-valuetext` — `inf-calculators.js:205`
announces "15 of 18" while the screen says "32K", and "5 of 13" while the screen says "16".

---

## MEDIUM

### M1 — `h4` is smaller than the body text it heads; `h3` is 5 % larger than body at every width
`assets/style.css:489` `.article h4 { font-size: 1rem }` is never overridden, while `body`
is: 17 px base, **18 px at 601–900 px**, 16 px at ≤ 600, 15.5 px at ≤ 420.

| viewport | body | h3 | h4 |
|---|---|---|---|
| 1400 px | 17 px | 17.92 px | **16 px** |
| 800 px | 18 px | 18.88 px | **16 px** |

At tablet width h4 is 11 % *smaller* than the paragraph under it, distinguished only by
weight. Visible in the 1440 px chapter screenshot: "Congestion avoidance: linear probing" (an
h3) is barely separable from a bold run of body text. The bottom two levels of the heading
scale carry no size signal.

Related (`style.css:453, 473, 482, 489`): `h1` and `h2` declare `line-height`; `h3` and `h4`
inherit body `1.7`, so at 1400 px an h3 sets 17.92 px type on **30.46 px** leading while the
larger h2 sets 22.4 px on 29.12 px. A smaller heading gets more leading than a bigger one.

### M2 — The chapter count is wrong on every page of the site
`index.html:70`, `distributed/index.html:71`, `inference/index.html:73` all read
`23 chapters`. `inference/assets/inf.js` defines **24**, there are **24** files in
`inference/content/`, and the inference hero renders "A SELF-PACED COURSE · 24 CHAPTERS" —
the two numbers contradict each other on the same screen. `README.md` says **17**.

### M3 — Every UI border in the product fails the 3 : 1 non-text minimum
`--rule` is **1.16–1.21 : 1** in dark and **1.25–1.32 : 1** in paper, against both surfaces.
Consumers that genuinely need to be perceived: `.search-open`, `.theme-switch`,
`.sidebar-collapse`, `.quiz-q`, `.card-check`, `.chapter-card`, `.complete-toggle`,
`.inf-control select` / `input[type=number]`, the simulator's inline buttons, `.ring-track`.
The unchecked `.card-check` circle on the course map is effectively invisible, so "how many
have I done" reads as "there is nothing here".

Two tokens are used as *text* colours at hairline contrast: `.crumb-sep` (`course.css:205`)
and `.hlink` (`style.css:900`) are both `var(--rule)` — **1.21 : 1**. The `/` in the
breadcrumb is not there.

### M4 — Search-result selection is a 1.10–1.17 : 1 background tint
`style.css:829` — `accent-soft` composited over `--bg-raised` is `#2f271c` on `#1e1b16`
(**1.17 : 1**) and `#e9e0cd` on `#f1ebdd` (**1.10 : 1**). This is the only indication of
which of twelve results Enter will open.

### M5 — The "On this page" rail is unavailable below 1280 px, though it is built on every render
`style.css:892` — one rule, no intermediate treatment. That removes in-chapter navigation
from every phone, every tablet in both orientations, iPad Pro portrait (1024) and any laptop
window under 1280 px, while `buildPageToc()` still does the work. Measured at 901–1279 px the
content column reaches 1015 px around a 720 px article — 147 px of dead space per side.
`content/memory.md` has 16 h2s and 9 h3s in 5,879 words.

### M6 — Reading measure narrows as the window grows across the 900 → 901 px boundary
At 900 px the reader gets 18 px / 1.75 type in a **624 px** measure; at 901 px, 17 px / 1.7
in a **541 px** measure. `--measure: 44rem` applies only in the 601–900 band, and at 901 px
the 264 px sidebar eats the width before `--measure: 720px` can be reached. Rotating a tablet
or dragging a window across this threshold reflows in the wrong direction.

### M7 — Fractional-width gaps between adjacent breakpoints
Every pair uses `max-width: N` / `min-width: N+1`, so `N.5` (browser zoom, desktop UI
scaling, some Android devices) matches neither. At **600.5 px** the reader loses the phone
table fallback and `code { overflow-wrap: anywhere }` while keeping desktop gutters; at
**900.5 px** `.nav-collapsed .sidebar { display: none }` never applies while `.sidebar-show`
stays hidden, so a reader who collapsed the nav watches it silently reappear.

### M8 — `aria-current` is never applied to the active chapter or section
`markActive()` (`app.js:671`, `course.js:259`) and the page-toc spy (`app.js:627`) toggle a
class only. The single `aria-current` in the repo is the hardcoded one on the course chip:
state is exposed for "which of 3 courses" but not for "which of 56 chapters".

### M9 — Landmarks are unlabelled where it matters most
`<nav id="sidebar">` has no `aria-label` and *contains* a labelled `<nav class="course-switch">`.
Both pagers are unlabelled. The rotor reads "navigation, navigation (Courses on this site),
navigation, complementary (On this page)" — the primary 56-item table of contents is the
unnamed one.

### M10 — Body scroll lock is insufficient; neither overlay contains overscroll
`style.css:1043` `body.nav-open { overflow: hidden }` does not lock scroll on iOS Safari
(measured `body.position: static`, no offset restore) — the page rubber-bands and loses
position. The search modal locks nothing at all.

### M11 — `#progress-bar` ignores the safe area and is stacked as if it were a modal
`style.css:133` — `top: 0` with `viewport-fit=cover` puts the 2 px hairline behind the notch
on iOS portrait, on exactly the devices it was designed for, while `#sidebar-toggle`,
`.sidebar`, `.article`, `.pager` and `.page-footer` all use `env(safe-area-inset-*)`.
Measured stacking: `#progress-bar` 9998 > `.sidebar` 80 > `.sidebar-scrim` 70 >
`#sidebar-toggle` 60, so it draws across the top of the open drawer.

### M12 — Widget `<h4>`s break heading order
`inf-calculators.js:87` and `inf-simulator.js:598` emit `<h4>` inside `.inf-widget-head`.
Inference chapters use a flat h2-only structure, so a widget after an `## H2` produces
h2 → h4. Measured on `#/sizing-a-deployment`: `H1 H2 H2 H2 H4 H2 …`. The *authored* markdown
is clean — all 93 chapters have exactly one h1 and zero level jumps; the skips are introduced
entirely by the widget layer.

### M13 — Touch targets below the project's own 44 px standard
The codebase sets the bar itself (`.quiz-choice`, `.complete-toggle`, `#sidebar-toggle`,
`.search-open` all carry an explicit 44 px floor). Measured at 390 px, everything else falls
short: simulator preset/action buttons **33 px** (nine of them in a wrapped row — the densest
control cluster on the site), widget range sliders **16 px**, `.theme-btn` **38 px** desktop /
`.inf-toggle` **~24 px**, `.meta-read-btn` **24 px**, `.page-toc a` **27 px**, `.hlink`
**16 px**.

### M14 — `renderLoadError` in the guided courses drops the pager
`course.js:625` renders retry + home but no `<nav class="pager">`. `app.js:785` does the
opposite, with the comment *"a dead end otherwise: keep prev/next reachable"*. The fix was
applied to one engine and not the other.

### M15 — Three `rgba(0,0,0,…)` shadows bypass the token layer and have no paper variant
`style.css:371`, `:803`, `:1026`. These are the only colour declarations in `style.css` that
bypass tokens; the paper block re-declares custom properties only. A pure-black 60 px-blur
shadow under the search modal reads as dirt on ivory stock. `--scrim` already holds the right
warm neutral.

### M16 — `.complete-toggle` and `.meta-read-btn` are toggles without `aria-pressed`
`course.js:502`, `app.js:376`. `applyTheme()` sets `aria-pressed` correctly on the theme
buttons, so the pattern is known and simply not applied. Neither `.quiz-submit` nor
`.complete-toggle` declares `type="button"`.

### M17 — Design tokens are re-declared as JS literals in three places, and have drifted
`inf-widgets.js:58-68` copies 22 hexes rather than reading them from
`getComputedStyle(document.documentElement)`, and invents a `cool` that exists in no
stylesheet. `app.js:253-273` does the same for Mermaid and has already drifted:
`primaryColor: "#efe8d7"` (paper) matches no token — `--bg-code` is `#efe9d9`, `--bg-raised`
is `#f1ebdd`.

### M18 — Canvas sizing floor overflows its own wrapper at ≤ 320 px
`inf-widgets.js:131` — `w = Math.max(280, wrap.clientWidth || 640)`. At 320 px the wrapper is
**276 px**, so a 280-logical-px drawing is squashed into 276 CSS px and every computed
x-coordinate is 1.4 % off, clipping the right-hand axis label. Affects the Galaxy Fold cover
screen, 320 px split-screen and browser zoom on small phones.

### M19 — Dead and unimplemented CSS
- `style.css:522-544` defines `.callout-simple` / `.callout-nuance` with `::before` labels.
  `grep -r "callout-simple\|callout-nuance"` outside the stylesheet → **zero hits**. The root
  course has 480 plain blockquotes that would be its clients.
- `inf.css:38-46` styles `figure` / `figcaption`; there are **0** `<figure>` elements in
  `inference/content/`.
- `inf.css:167-169` promises a glossary at "two columns on a wide screen"; no `columns` /
  `column-count` rule exists anywhere, so `:387`'s phone override is a no-op.
- `inf-widgets.js:184` registers a `note` callout with no `.callout-note` rule and no user.

### M20 — Two number formats in the same TOC rail; two tokens for one colour
`app.js:640` emits `1, 2, … 56`; `course.js:235` emits `01, 02, …`. Identical component,
identical CSS. And `course.css:11-19` defines `--quiz-good` / `--quiz-bad` byte-for-byte
identical to `--lvl-core` / `--lvl-internals`, then mixes both paths four lines apart for the
same component (`.quiz-result.fail` vs `.quiz-result.warn`).

### M21 — `::placeholder` is never styled
Zero `::placeholder` rules in any stylesheet. `#search-input` sets `background: transparent`
over `--bg-raised`, so the placeholder is whatever the UA derives — not theme-aware, and
different across browsers. It is the only unstyled foreground in the product.

### M22 — `overflow-x: clip` turns overflow bugs into silent content loss
`style.css:113`. Every probe reports `scrollWidth === clientWidth`, which is proof of
clipping, not of correctness. `style.css:1133` provides a `display: block; overflow-x: auto`
fallback for an unwrapped table **only at ≤ 600 px**; at 601–900 px a 2089 px table would be
clipped to 704 px with no scrollbar and no hint. The clip is a good backstop and a bad
containment strategy.

### M23 — `.course-chip` negative margins overflow the sidebar padding box
`style.css:282` `margin: 0 -0.6rem` (both sides) vs `:214` `.toc-list a { margin-left: -0.6rem }`
(left only). Measured at 1280 px: sidebar content box ends at x = 268, chip right edge at
**x = 277**; `.course-switch` reports `clientWidth 239 / scrollWidth 249`. Since `.sidebar`
has `overflow-y: auto` (⇒ computed `overflow-x: auto`), this is one padding value away from a
horizontal scrollbar in the sidebar, and the two highlight blocks already have different
right edges.

### M24 — `100vh` on mobile; `simulator.html` is a dead-end shell
`style.css:162` `.layout { min-height: 100vh }` and `:861` `.page-toc { height: 100vh }` use
the largest viewport, so short pages always over-scroll; the drawer already uses `100dvh`.
`inference/simulator.html` loads all three stylesheets but has no sidebar, no theme switch,
no `#hljs-theme`, no progress bar and no footer — a reader arriving from a search engine
cannot switch theme or see where they are, and has one text link back.

### M25 — OS colour preference is ignored on first visit
All four shells open with `var theme = "dark"` and consult only `localStorage`.
`prefers-color-scheme` appears nowhere in the codebase.

---

## LOW

- **L1** — The `.pager` / `.page-footer` / `.search-box` safe-area padding set at
  `style.css:1066` is overridden by plain shorthands at `:1152`, `:1156`, `:1193` and `:1150`;
  the bottom inset is kept, the horizontal ones dropped. Bites only on foldables and
  split-screen.
- **L2** — `inf-simulator.js:795` un-hides the sparkline wrapper *after* `spark.size()` runs
  on resize, so `wrap.clientWidth` is 0 and `inf-widgets.js:133` falls through to the `640`
  literal. Verified: `attrW = 632` while the wrapper is `display: none`.
- **L3** — The signature amber tick is `border-radius: 2px` on chapters (`style.css:468`) and
  square on home pages (`course.css:59`) — same geometry, one property omitted.
- **L4** — 49 distinct `font-size` values across the three stylesheets, 17 of them inside the
  0.6–0.88 rem band; 42 distinct padding values, 29 margin, 16 gap. Only `--measure` and
  `--gutter` are tokenised. The "secondary italic caption" role alone is written five ways
  (0.82 / 0.84 / 0.85 / 0.86 / 0.9 rem).
- **L5** — `--measure` is `720px` at `style.css:40` and `44rem` (= 704 px) at `:1080`: one
  token, two unit systems, so one branch respects browser font scaling and the other does not.
- **L6** — `.toc-check` at `opacity: 0.7` is **2.53 : 1** in paper — the only per-chapter
  completion signal in the sidebar.
- **L7** — Stack-map dimmed stages render at **1.61–1.75 : 1** (`inf-stackmap.js:99-101`).
- **L8** — `<kbd>/</kbd>` in the search button is shown on touch devices, advertising a key
  the reader cannot press.
- **L9** — `aria-expanded` on `#sidebar-collapse` is set to `false` on a button that
  `display: none` has just removed, while `#sidebar-show` — the button that actually expands —
  has no `aria-expanded` at all. Nothing in the repo has `aria-controls`. (The mobile drawer's
  `aria-expanded` is correctly maintained.)
- **L10** — `InfWidgets.slider` derives ids from a label hash while `numberField` uses
  `Math.random()`; two same-labelled controls at the same child index would collide and break
  both `<label for>` associations. Latent, not currently triggered.
- **L11** — Ten colours live outside the token system: `#8d8370`, `#b8791f`, `#ece5d4`,
  `#3b5a8f`, `#2f6d7d` in the SVGs and widget palette; `#b6a2d8` / `#5b4a8f` and
  `#c7b46a` / `#7d6a1f` in the simulator series; `#efe8d7` in the Mermaid theme.
- **L12** — Inline code (`0.84em` → 14.28 px, `--code-ink`) and block code (`0.82rem` →
  13.12 px, CDN gruvbox: `#fb4934`, `#fe8019`, `#fabd2f`, `#b8bb26`, `#8ec07c`, `#83a598`,
  `#d3869b`) are two different colour *and* size systems. The same identifier renders
  amber-cream in a sentence and gruvbox-red inside a fence, against the stylesheet's own
  "one accent, no neon" header.
- **L13** — Three left-accented tinted boxes, three geometries: `.path-legend` (3 px bar, no
  radius), `.callout-*` / `.inf-callout` (2 px, `0 6px 6px 0`), `.inf-verdict` (2 px,
  `0 4px 4px 0`).

---

## Design recommendations (subjective)

These are judgement calls, not defects.

- **D1 — Give code, tables and figures more width than prose on a large screen.** Measured at
  1440 px: the content column is 932 px and the article is pinned at 720 px, so code blocks
  render **632 px wide** with 106 px of empty column on each side, while the widest table in
  the book wants 2089 px. A technical book should let its evidence breathe wider than its
  measure. This costs nothing below ~1400 px, where there is no slack.
- **D2 — A phone reader has no idea which chapter they are in.** Once scrolled, the only
  chrome on a phone is a bar reading "☰ Contents". The chapter title, the part, and the
  section are all off-screen. The sticky bar is the natural place for the chapter title.
- **D3 — The Linux course has no breadcrumb and no ordinal.** The guided courses render
  `Course home / Module name` plus a badge and read time; `metaBannerHtml()` renders a level
  dot, minutes and a kernel version — no part name, no chapter number, no link home. It is
  the largest of the three courses and the only one where a chapter does not say where it sits.
  Nothing anywhere says "chapter N of M".
- **D4 — The 0 % progress ring is a 132 px hole for every first-time visitor.** An empty grey
  donut labelled "0% READ" competes with the primary CTA and communicates nothing until the
  second visit.
- **D5 — `.path-legend` outranks the content it introduces.** It carries the heaviest accent
  bar in the system (3 px), an amber fill and the full column width, directly under the CTA,
  for footnote-grade copy about a tick-off mechanic. It reads as a warning banner.
- **D6 — `.card-desc` is clipped to one line on phones.** The comment defends it — *"the map
  is all a phone reader has to steer by — clip the blurb, never drop it"* — and then clips it
  to one line at 13.3 px. Two-line clamping keeps roughly double the information at the same
  rhythm.
- **D7 — Four figure technologies, four visual treatments.** Linux uses theme-aware Mermaid
  on `--bg-code`; Inference uses baked ivory SVGs *and* theme-aware dark stack maps *and*
  canvas widgets, so a single chapter stacks an ivory inset directly above a dark strip — two
  grounds, two type stacks, two corner radii. Distributed has no figures at all across 13
  chapters.
- **D8 — `.lvl-badge` means two different things.** `app.js:835` puts a chapter *count* in the
  pill that `course.js:383` uses for *difficulty* — same pill, same colour, same position, on
  sibling courses one click apart.
- **D9 — Two completion affordances for one action.** A borderless 0.68 rem mono link at the
  top of a Linux chapter; a 44 px centred pill at the foot of a guided one. The mechanics
  genuinely differ (auto-tick on scroll vs quiz-gated) but nothing in the visual language
  communicates *that* — it just reads as two products.
- **D10 — The Distributed Systems course contains zero hyperlinks across all 13 chapters.**
  `what-is-a-distributed-system.md:178-192` draws a five-stage course map with "(you are
  here)" and links none of it. Compare `content/start-here.md` (77 internal links) and the
  inference course's 48 cross-course bridge boxes. This is a content fix, not a code fix.
- **D11 — Nine Linux chapters carry 100–171-word paragraphs.** Worst: `content/tcp-congestion.md:50`
  — 171 words, 1,059 characters, one source line, no internal break. Also `cpu-isolation`,
  `cpu-mitigations`, `kvm-internals`, `numa-deep-dive`, `perf-methodology`, `power-management`,
  `storage-stack`, `trusted-computing`. The measure and leading are good; no typography fixes
  a nine-line paragraph. Elsewhere the book averages 34–41 words per paragraph and
  `distributed/` a disciplined 19–34.
- **D12 — Hard `<br>` in both guided hero headlines** (`ds.js:88`, `inf.js:142`) breaks at a
  fixed point regardless of width. `text-wrap: balance` does the job responsively.
- **D13 — There is no platform front door.** `/` *is* the Linux course: it owns the domain
  title, the `<title>`, and the visitor's first screen. The other 37 chapters are discoverable
  only from the left rail.
- **D14 — 61 files carry box-drawing ASCII diagrams inside plain `text` fences**, and
  `distributed/` relies on them exclusively. Screen readers read `─│┌└┐┘▶◀` character by
  character. A one-line prose gloss above each would cost little.

---

## What was implemented in this pass

This is an improvement pass, not a claim that every finding above was fixed. The
implemented changes are in the accompanying feature-branch commit and include:

- the Linux chapter loading race guard; native checkboxes/ranges restored for the
  simulator; stronger secondary-text and control contrast;
- accessible skip links, main landmarks, modal/drawer focus management, visible
  focus states, keyboard-reachable scroll regions, and reader orientation
  metadata;
- mobile-safe horizontal scrolling for Mermaid, tables, inference figures and
  stack maps rather than shrinking technical labels into illegibility;
- shared course navigation/orientation improvements and a standalone simulator
  shell with theme controls and course context.

The audit was independently re-reviewed before commit. The focus trap is nested
so opening search from the mobile drawer cannot release the drawer's trap.

**Deliberately not done**, and why:

- **D10, D11, D14** and the callout-grammar unification are *content* edits. The brief was
  explicit that lesson substance is not to be rewritten, and these need an author, not an
  engineer.
- **D7 / C4 follow-up** — authoring phone variants of 23 SVG diagrams is a design project.
  This pass makes them legible by letting them scroll at a readable minimum size and by
  making that scroll reachable; it does not redraw them.
- **L4, L5, L11, L12** — a full spacing/type scale and a token-driven syntax theme are a
  refactor with a large regression surface and little reader-visible gain relative to
  everything above. The `--measure` unit mismatch (L5) *was* fixed.
- **M17** — reading tokens from `getComputedStyle` in the widget layer is correct but touches
  every canvas draw path; the drifted Mermaid value was corrected in place instead.
- **C2 (WebKit half)** — the native `appearance: auto` controls could not be
  verified on real Safari from this environment.
