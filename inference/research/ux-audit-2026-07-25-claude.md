# UX and README Audit — 2026-07-25 (Claude Opus)

## Executive Summary

The repo now serves three courses (56 + 13 + 17 = 86 chapters) but presents itself as one Linux guide with a footnote. There is no front door: `/` IS the Linux book, opening straight into chapter 1 with no course map, and the only path to the other two courses is a pair of deliberately quiet links buried below a 56-item TOC. The shared shell (theme tokens, drawer, search modal, breakpoints) is genuinely good and correctly reused by all three sub-sites — but the three engines have drifted: ds.js/inf.js are a fork of each other (inf.css is byte-identical to ds.css, header comment included) and both lack ~6 behaviours app.js has, while app.js carries two search bugs the forks fixed. Three concrete defects need attention: typing a second character while the Linux search index builds throws and silently drops input; an unguarded localStorage.setItem makes the quiz say "chapter marked as complete" when nothing saved; and a failed chapter fetch in the Linux course is sticky. The README is the weakest artifact — it never mentions Inference at all.

## Critical Issues

### Search input dropped (and throws) while the index builds — Linux only
- **Severity: Critical** · assets/app.js:647, :699-708
- openSearch() focuses the input BEFORE await buildSearchIndex() resolves; searchIndex is null until all 56 fetches land. The input listener → searchQuery → for (const doc of searchIndex) with no null guard. First char is safe (terms filtered to length > 1); the second char throws TypeError. Every keystroke until the index lands is lost while "Indexing chapters…" sits there.
- Both forks already fix this (ds.js:507, inf.js:524). Guard searchQuery, and re-render once the index resolves so the in-flight query is honoured.

### Quiz claims completion when the write failed
- **Severity: Critical** · inference/assets/inf.js:106, distributed/assets/ds.js:90
- saveProgress calls localStorage.setItem with no try/catch while every read path is guarded. In Safari private mode / at quota it throws. The success message is painted before the write (inf.js:375-377), so the user reads "Perfect — chapter marked as complete ✓", then the exception aborts the handler: button never syncs, tick never appears, ring never moves. Gone on reload.
- Same unguarded-write bug at assets/app.js:238 (saveReadSet). Return a success boolean; only paint success on a confirmed write.

### A failed chapter load is sticky — clicking the same chapter again does nothing
- **Severity: High** · assets/app.js:533-590
- lastSlug = slug is committed at :538, before the fetch. On failure the error panel renders but lastSlug is already set, so re-clicking that TOC entry hits sameChapter → return at :542 with no refetch. Recovery requires navigating elsewhere and back, or reloading. Commit lastSlug only after a successful render; add a "Try again" control.

### 404s get indexed as chapter content — Linux only
- **Severity: High** · assets/app.js:629-637
- No res.ok check (unlike inf.js:510 / ds.js:493). A missing file means nginx's HTML error page is parsed as Markdown and indexed as that chapter — it then matches "nginx"/"404" and never its real subject. Silent to maintainers.

### There is no front door to the platform
- **Severity: High** · index.html:59-67, assets/app.js:144, :505-508
- Empty hash resolves to FLAT[0].slug = start-here. The site title link (index.html:31, href="#/") resolves to the same chapter. A first-time visitor lands mid-book with no signal the other two courses exist. Both sub-courses built a rich home view (hero, ring, module cards, CTA); the entry point everyone hits first has none of it.

### Cross-course discovery is buried below a 56-item TOC
- **Severity: High** · index.html:43-52, assets/style.css:254-287
- The two course links sit after the entire injected TOC — roughly 2–3 viewport heights down. The CSS comment states the intent ("a quiet footnote, not a competing CTA"), which was right for one extra course and is wrong for three. Nothing in the article body, pager, footer, or title mentions the other courses. Promote a compact course switcher to the top of all three sidebars.

### Search never crosses courses, but the UI implies it does
- **Severity: Medium** · all three: placeholder="Search all chapters…"
- Searching "raft" from Linux returns nothing; "KV cache" from Distributed returns nothing. The empty-state hint is honest ("all 56 chapters"); the placeholder is not. Either scope the placeholder honestly or index all three with a course badge.

## Consistency Issues

### inf.css is a byte-identical copy of ds.css
- diff reports zero differences (8630 bytes each), and inference/assets/inf.css:1 still reads "/* Distributed Systems course-only presentation." The brief's premise ("supplementary inf.css") does not hold; it's a full duplicate. Versions have already drifted (?v=20260723 vs ?v=20260720) despite identical bytes. Same for ds.js/inf.js: 165 diff lines out of ~660. → Promote to a shared assets/course.css / shared engine.

### JS not cache-busted in sub-courses
- index.html:87 uses app.js?v=20260719; distributed/index.html:85 and inference/index.html:85 have bare ds.js/inf.js. nginx.conf:10 (no-cache) covers this today; a CDN or GitHub Pages deploy would not.

### Mobile toggle bar auto-hides only in Linux
- updateToggleBar (app.js:328-348) exists only in app.js, but the .hide rule lives in the shared stylesheet (style.css:927). Distributed/Inference keep a 3.25rem bar pinned to every phone viewport.

### Scroll position not preserved on reload in sub-courses
- app.js:271-321 (SCROLL_KEY, restoreScroll, pagehide/visibilitychange) has no counterpart in ds.js/inf.js.

### Route changes smooth-scroll in sub-courses, jump in Linux
- style.css:108 sets scroll-behavior: smooth globally; app.js:575 opts out with behavior: "instant", while inf.js:316,470 and ds.js:299,453 use scrollTo(0,0) and inherit the animation.

### Active chapter not scrolled into view in sub-course sidebars
- app.js:510-518 calls scrollIntoView({block:"nearest"}); inf.js:223-227 only toggles the class.

### Sidebar labels differ
- "☰ Contents" / "Toggle table of contents" vs "☰ Course outline" / "Toggle course outline". Same control, same position, same shortcut, two names.

### Progress visible in sidebar only in Linux
- index.html:54 + app.js:248-261 render "N / 56 chapters read" with a fill bar; the sub-course sidebar footers carry static text.

### Progress semantics differ, unexplained
- Linux auto-marks on reaching page end (app.js:355-358); sub-courses gate on a perfect quiz (inf.js:374-379). Same .toc-check tick, two meanings.

### "On this page" rail only in Linux
- index.html:69 + app.js:457-481.

### Mermaid loaded only by Linux
- Nothing broken today (0 mermaid in sub-course content), but a contributor following README.md:19 would get a silent raw text block.

### Escape closes search only while focus is in the input
- Consistently wrong in all three (app.js:721-723). Clicking the results padding kills it; footer still advertises "Esc close".

### Cross-course copy is asymmetric
- Inference described two different ways; kicker is "Standalone course" vs "Sister course"; Inference→Distributed has a pedagogical hook, the reverse doesn't.

### Links use index.html, not directory URLs
- index.html:43,48 produce /distributed/index.html, while error panels and README say /distributed/. The canonical URL users copy is the ugly one.

## README Issues

### Inference does not appear in the README at all — Critical
- 17 chapters, its own reader and quizzes, ~26KB of JS, zero mentions. Specifically: H1 :1, intro :3, feature list ends at "A separate 13-chapter distributed systems course" :24, Docker URLs :34 (two of three), a "Distributed Systems course" section :101-111 with no counterpart, repo layout :115-129 with no inference/ node, contributing :144. → Lead with the platform: a three-row table (course · chapters · URL · one-liner) before any Linux-specific detail.

### Counts and scope statements are stale — High
- :5 and :11 state 56 chapters as facts about the repository, which holds 86. :24 frames Distributed as the only extra course. :69 calls the glossary "cross-course" — it lives in content/glossary.md, is reachable only from the Linux TOC.

### Feature list conflates platform-wide with Linux-only — Medium
- :19 Mermaid, :15 heading anchors/deep links/on-page outline are Linux-only. :14 search is per-course. :18 progress is three different systems. The sub-courses' most distinctive feature (quiz-gated completion with progress ring) is never mentioned.

### Repo layout omits inference/ — Medium
- Also omits LICENSE and inference/research/. The ten research notes and STYLE.md ship to production at /inference/research/*.md, directly fetchable.

### Contributing covers two of three courses — Medium
- :135-142 is a solid Linux recipe; :144 is one sentence for Distributed; nothing for inference/.

### Deployment correct but incomplete — Low
- docker compose up --build + 8081:80 → localhost:8081 is right; :34 lists two of three URLs.

### No demo, screenshot, or badges — Low

## Minor Polish

- nextUnread() mislabels "Continue" (inf.js:128-131, :290-292): finished 1–3, reading 10 → told to continue at 4. setLastVisited writes p.last on every view and nothing ever reads it.
- No loading state between chapters — all three await the fetch without clearing the view
- Rapid navigation can render the wrong chapter — no request-sequence guard on async render
- Sub-course error panel is a dead end (inf.js:413-420) — no pager, no link home, no retry
- marked.setOptions({highlight}) is dead code (inf.js:182-189) — removed from marked v12
- Inconsistent fetch caching — inf.js:407 default vs inf.js:509 no-cache for same files, fetched twice
- Search modal isn't a modal for AT — role="dialog" without aria-modal, no focus trap
- id="home-link" unused (distributed|inference/index.html:32)
- hljs theme flashes on light loads — all three hardcode dark gruvbox
- Quiz touch targets under 44px — .quiz-choice ≈30px
- Chapter descriptions vanish on phones — inf.css:308 .card-desc { display: none } below 600px
- Search index build unbounded/unreported — 56 concurrent no-cache fetches, one static hint

## What Works Well — do not touch

- Theme + sidebar state shared across all three sub-sites, correctly. ldd-theme / ldd-nav-collapsed read by identical pre-paint inline scripts.
- Progress keys are namespaced with no collisions: ldd-read, ds-course-progress-v1, inf-course-progress-v1.
- The responsive system is well-considered: style.css:874-1073 documents its own breakpoint ladder.
- prefers-reduced-motion respected in both CSS and JS.
- Keyboard shortcuts genuinely consistent across all three: /, Ctrl/Cmd-K, [, ←/→, Escape, ↑↓/Enter.
- Error handling names the actual likely cause.
- Linux scroll memory is unusually well built — restoreScroll re-pins across ~40 frames to survive reflow.
- The auto-hiding toggle bar uses a direction-flip accumulator, not a naive threshold.
- The sub-course home views are the strongest screens in the product. Bring Linux up to this.
- Wide tables wrapped for touch scrolling.
- The Linux curriculum table in the README is accurate.
- nginx.conf:8's no-cache is the right call for a no-build static site.
