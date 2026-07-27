/* ============================================================
   Shared reader UI behaviours.

   Both engines — assets/app.js (The Linux Deep Dive) and
   assets/course.js (Distributed Systems, Inference Engineering) —
   render chapters into their own element and then need exactly the
   same things done to the result: scrollable blocks made reachable,
   an inline outline built for narrow screens, focus moved to the
   article, the sticky bar told which chapter it is sitting on.

   Those behaviours used to be written twice, or once and forgotten
   in the other engine. They live here so a fix lands in all three
   courses at the same time. This file is loaded before both engines
   and exposes one global, ReaderUI.

   Nothing here assumes a course: everything takes the root element
   to work on. If this file fails to load the engines still render —
   they check for the global.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- vendored libraries ----------------

     marked, highlight.js and Mermaid are served from assets/vendor/ rather
     than a CDN: the rest of the site is one self-contained tree, and the
     three CDN tags carried no integrity hash, so any answer cdnjs gave was
     executed unverified.

     The shells sit at two different depths — / and /distributed/,
     /inference/ — so "assets/vendor/…" resolves to two different places
     and a bare relative path is wrong for two of the three courses. All
     three load *this* file from the same URL, so its own src is the one
     reliable anchor. Everything that needs a vendored file asks here. */

  const VENDOR_BASE = new URL("vendor/", document.currentScript.src);

  function vendorUrl(rel) {
    return new URL(rel, VENDOR_BASE).href;
  }

  /* ---------------- markdown ----------------

     GFM treats a single `~x~` as strikethrough. This book writes "~" for
     "approximately" constantly — "~128 entries", "~10%", "~350 syscalls" —
     so any paragraph containing two of them had the text between them
     struck through, which reads as retracted. 37 chapters across the three
     courses are affected; content/memory.md renders "64 entries for data,
     ~128 for instructions) and a unified L2 TLB (1,500" with a line
     through it.

     Fix it at the renderer: require the doubled `~~` that the prose
     actually uses when it means strikethrough. */

  function configureMarkdown() {
    if (typeof marked === "undefined" || !marked.use) return;
    marked.use({
      tokenizer: {
        del(src) {
          const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
          if (!m) return false;
          return {
            type: "del",
            raw: m[0],
            text: m[1],
            tokens: this.lexer.inlineTokens(m[1]),
          };
        },
      },
    });
  }

  /* ---------------- announcements ---------------- */

  const liveEl = () => document.getElementById("live-region");

  /* A polite live region is the only way a screen-reader user learns
     that a hash change replaced the whole page. Re-setting the same
     string is not announced, so nudge it. */
  function announce(message) {
    const el = liveEl();
    if (!el) return;
    el.textContent = "";
    setTimeout(() => { el.textContent = message; }, 60);
  }

  /* ---------------- focus ----------------
     Every navigation replaced the content wholesale and left focus on
     a destroyed node, so it fell to <body> and the next Tab restarted
     at stop #1 — 64 stops away from the article. */

  function focusMain() {
    const main = document.getElementById("main");
    if (!main) return;
    /* preventScroll: the engines have already decided where the page
       should be (top, a restored offset, or an anchor) */
    main.focus({ preventScroll: true });
  }

  /* ---------------- the sticky bar's chapter title ---------------- */

  function setTopbarTitle(text) {
    const el = document.getElementById("topbar-title");
    if (el) el.textContent = text || "";
  }

  /* ---------------- scrollable evidence ----------------

     Wide tables (up to 6.4 phone screens), long code lines and 880px
     diagrams all scroll horizontally, and none of it was reachable
     without a mouse: no tabindex, no role, no label, and no hint that
     there was anything to the right. */

  const SCROLL_LABEL = {
    PRE: "Code block",
    DIV: "Table",
  };

  function markScrollable(el, label) {
    el.classList.add("scroll-x");
    const overflows = el.scrollWidth > el.clientWidth;
    if (!overflows) {
      el.removeAttribute("tabindex");
      el.removeAttribute("role");
      /* only ours. An author (or a widget) who labelled this element meant
         it, and a window widened past the overflow point must not strip a
         label we never wrote. */
      if (el.dataset.scrollLabelled) {
        el.removeAttribute("aria-label");
        delete el.dataset.scrollLabelled;
      }
      delete el.dataset.overflow;
      return;
    }
    el.dataset.overflow = "1";
    el.tabIndex = 0;
    el.setAttribute("role", "region");
    if (!el.getAttribute("aria-label") || el.dataset.scrollLabelled) {
      el.setAttribute("aria-label", label + " (scrolls horizontally)");
      el.dataset.scrollLabelled = "1";
    }
    if (!el.dataset.scrollBound) {
      el.dataset.scrollBound = "1";
      el.addEventListener("scroll", () => {
        if (el.scrollLeft > 4) el.dataset.scrolled = "1";
        else delete el.dataset.scrolled;
      }, { passive: true });
    }
  }

  /* Diagrams were shrunk to fit rather than allowed to scroll, so a
     9px label landed at 3.4px on a phone: the figure was not degraded,
     it was gone. Give it a frame it can be bigger than, plus a plain
     link to the file at full size. */
  function wrapFigures(root) {
    root.querySelectorAll("img").forEach(img => {
      const parent = img.parentElement;
      if (!parent || parent.classList.contains("figure-scroll")) return;
      if (img.closest(".figure-scroll")) return;

      const wrap = document.createElement("div");
      wrap.className = "figure-scroll";
      /* marked wraps a lone image in a <p>. Replace that paragraph rather
         than nesting inside it, so the frame is a direct child of the
         article and can take the wide-screen bleed with the code blocks
         and tables. */
      const lone = parent.tagName === "P" &&
                   parent.childNodes.length === 1 &&
                   parent.firstChild === img;
      (lone ? parent : img).replaceWith(wrap);
      wrap.appendChild(img);

      const src = img.getAttribute("src");
      if (src) {
        const open = document.createElement("a");
        open.className = "figure-full";
        open.href = src;
        open.target = "_blank";
        open.rel = "noopener";
        open.textContent = "open full size ↗";
        wrap.after(open);
      }
    });
  }

  /* Called after render, and again once late layout (highlighting,
     Mermaid, images) has settled — an element's scrollWidth is not
     final until its content is. */
  function refreshScrollables(root) {
    if (!root) return;
    const candidates = [
      ...[...root.querySelectorAll("pre")].map(el => ({
        el, label: el.classList.contains("mermaid") ? "Diagram" : "Code block",
      })),
      ...[...root.querySelectorAll(".table-scroll")].map(el => ({ el, label: "Table" })),
      ...[...root.querySelectorAll(".figure-scroll")].map(el => ({ el, label: "Diagram" })),
      ...[...root.querySelectorAll(".inf-stackmap")].map(el => ({ el, label: "Architecture diagram" })),
    ];
    const totals = candidates.reduce((counts, item) => {
      counts[item.label] = (counts[item.label] || 0) + 1;
      return counts;
    }, {});
    const seen = {};
    candidates.forEach(({ el, label }) => {
      seen[label] = (seen[label] || 0) + 1;
      const unique = totals[label] > 1 ? `${label} ${seen[label]} of ${totals[label]}` : label;
      markScrollable(el, unique);
    });
  }

  /* ---------------- keeping that evidence current ----------------

     The measurement above used to happen once, at render time, and never
     again. A chapter opened at 1600px and then narrowed to a phone left 15
     containers scrolling horizontally with no tabindex, no role and no
     label: a keyboard reader could not reach the right-hand columns of a
     table 6.4 phone-screens wide. Widening had the mirror defect — tab
     stops left behind on blocks that no longer scrolled anywhere.

     One observer on the article, not one per block. The article's box
     changes whenever the window does, and also when late content lands
     (highlighting, a Mermaid diagram, a font), which is the other moment
     scrollWidth stops being what we measured. */

  let scrollRoot = null;
  let scrollObserver = null;
  let scrollTimer = null;

  /* A drag-resize fires the observer continuously and re-measuring every
     block is a forced layout each time, so coalesce to one pass after the
     resize settles. */
  function queueRefresh() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (scrollRoot && document.contains(scrollRoot)) refreshScrollables(scrollRoot);
    }, 120);
  }

  /* Chapter navigation replaces the article's innerHTML wholesale — and in
     the guided engine the root element itself. One observer with one target
     at a time, so 56 navigations do not leave 56 observations behind. */
  function watchScrollables(root) {
    scrollRoot = root;
    if (typeof ResizeObserver === "undefined") return;   // the resize listener still covers it
    if (!scrollObserver) scrollObserver = new ResizeObserver(queueRefresh);
    scrollObserver.disconnect();
    scrollObserver.observe(root);
  }

  /* Zoom, orientation change and a window resized while the article's own
     box happens not to move are all outside what the observer sees. */
  window.addEventListener("resize", queueRefresh, { passive: true });

  function prepareContent(root) {
    if (!root) return;
    wrapFigures(root);
    refreshScrollables(root);
    watchScrollables(root);
    /* one more pass once fonts / highlighting / diagrams have landed */
    setTimeout(() => refreshScrollables(root), 350);
    setTimeout(() => refreshScrollables(root), 1200);
  }

  /* ---------------- Mermaid ----------------

     Mermaid is 3.2 MB, and it used to be fetched on every page view of the
     Linux course — including the six chapters that carry no diagram and the
     course home, which carries nothing at all. It is now fetched the first
     time a rendered chapter actually contains one, at most once per session.

     It also lived only in app.js, so the two guided courses had no diagram
     support at all: a ```mermaid fence in distributed/content/ would have
     rendered as a wall of unhighlighted source. Both engines call in here. */

  /* Colours come from the stylesheet, not from hexes copied into JS. The
     copies had already drifted — the paper theme's primaryColor matched no
     token in style.css — and a token that exists in two places is a token
     that will eventually disagree with itself. */
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function mermaidConfig(theme) {
    return {
      startOnLoad: false,
      theme: theme === "paper" ? "neutral" : "dark",
      themeVariables: {
        background: token("--bg"),
        /* the inline-code chip: the one surface the design system defines
           as reading raised above the page in both themes */
        primaryColor: token("--bg-inline"),
        primaryTextColor: token("--text"),
        primaryBorderColor: token("--accent-dim"),
        lineColor: token("--text-faint"),
        fontFamily: token("--mono"),
        fontSize: "14px",
      },
    };
  }

  /* The theme the engine last asked for. Kept even when nothing is loaded,
     so switching to Paper on a chapter with no diagram and then opening one
     does not render it in the dark palette. */
  let mermaidTheme = null;
  let mermaidLoad = null;

  function themeNow() {
    return mermaidTheme ||
           (document.documentElement.dataset.theme === "paper" ? "paper" : "dark");
  }

  function loadMermaid() {
    if (mermaidLoad) return mermaidLoad;
    mermaidLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = vendorUrl("mermaid.min.js");
      s.async = true;
      s.onload = () => resolve(window.mermaid);
      s.onerror = () => reject(new Error("could not load " + s.src));
      document.head.appendChild(s);
    }).catch(err => {
      mermaidLoad = null;      // a failed load must be retryable on the next chapter
      throw err;
    });
    return mermaidLoad;
  }

  /* marked emits a fence as <pre><code class="language-mermaid">; Mermaid
     wants <pre class="mermaid">. dataset.src keeps the source, because the
     colours are baked into the SVG and a theme change has to re-render from
     something. Returns a promise so a caller can wait for the diagrams. */
  function renderMermaid(root) {
    if (!root) return Promise.resolve();
    root.querySelectorAll("pre code.language-mermaid").forEach(code => {
      const holder = document.createElement("pre");
      holder.className = "mermaid";
      holder.dataset.src = code.textContent;
      holder.textContent = code.textContent;
      code.closest("pre").replaceWith(holder);
    });

    const nodes = [...root.querySelectorAll("pre.mermaid")];
    if (!nodes.length) return Promise.resolve();     // nothing to draw, nothing to download

    return loadMermaid().then(mermaid => {
      mermaid.initialize(mermaidConfig(themeNow()));
      return mermaid.run({ nodes });
    }).then(() => {
      /* the diagram is usually the widest thing on the page and only exists
         now: re-measure so its frame becomes a reachable scroll region */
      refreshScrollables(root);
    }).catch(err => {
      /* the source text is still in the <pre>, so the chapter degrades to a
         readable diagram definition rather than a blank box */
      console.warn("Mermaid:", err.message);
    });
  }

  /* Colours are baked into the emitted SVG, so a theme change is a re-render.
     Nothing to do — and nothing to download — until a diagram has been seen. */
  function setMermaidTheme(theme, rerender) {
    mermaidTheme = theme;
    if (!window.mermaid) return;
    window.mermaid.initialize(mermaidConfig(theme));
    if (!rerender) return;
    const nodes = [...document.querySelectorAll("pre.mermaid[data-src]")];
    if (!nodes.length) return;
    nodes.forEach(pre => {
      pre.removeAttribute("data-processed");
      pre.textContent = pre.dataset.src;
    });
    Promise.resolve(window.mermaid.run({ nodes }))
      .then(() => { if (scrollRoot) refreshScrollables(scrollRoot); })
      .catch(err => console.warn("Mermaid:", err.message));
  }

  /* ---------------- inline "on this page" ----------------
     The rail is built on every render and then hidden below 1280px,
     which is every phone, every tablet and plenty of laptops. Same
     data, collapsed, above the text. */

  function buildInlineToc(headings, slug, insertAfter) {
    document.querySelectorAll(".page-toc-inline").forEach(el => el.remove());
    if (!insertAfter || headings.length < 3) return;

    const details = document.createElement("details");
    details.className = "page-toc-inline";
    details.innerHTML =
      `<summary>On this page — ${headings.length} sections</summary><ul>` +
      headings.map(h =>
        `<li class="lvl-${h.tagName === "H2" ? 2 : 3}">` +
        `<a href="#/${slug}@${h.id}">${h.textContent.replace(/¶$/, "")}</a></li>`
      ).join("") + `</ul>`;
    insertAfter.after(details);
  }

  /* ---------------- keyboard guards ----------------
     ←/→ turn the page, but they are also how you scroll a code block
     or a wide table — which are now focusable, so the collision is
     real rather than theoretical. */

  function inScrollRegion() {
    const el = document.activeElement;
    return !!(el && el.closest && el.closest('[role="region"], pre, .table-scroll, .figure-scroll, .inf-stackmap'));
  }

  /* ---------------- modal focus ----------------
     role="dialog" with no aria-modal, no trap and no focus restore
     meant one Tab walked out of the search box into the 60-odd links
     behind the scrim, and Escape dropped focus on the floor. */

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let trapped = null;
  const focusTraps = [];

  /* `display: none` controls still match the focusable selector and
     silently swallow .focus() — the sidebar's collapse button is exactly
     that at the drawer breakpoint, which is why focusing "the first thing
     in the drawer" landed on <body>. */
  function visibleFocusables(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(el => {
      if (el.offsetParent !== null) return true;
      const cs = getComputedStyle(el);
      return cs.position === "fixed" && cs.visibility !== "hidden" && cs.display !== "none";
    });
  }

  function onTrapKeydown(e) {
    if (e.key !== "Tab" || !trapped) return;
    const items = visibleFocusables(trapped);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* `returnTo` names the control that opened the overlay. Without it,
     closing after a mouse click (which does not always move focus) put
     the reader back on <body> — i.e. at tab stop zero. */
  function trapFocus(el, returnTo) {
    const active = document.activeElement;
    const returnFocusTo = (active && active !== document.body) ? active : (returnTo || null);
    focusTraps.push({ el, returnFocusTo });
    trapped = el;
    if (focusTraps.length === 1) document.addEventListener("keydown", onTrapKeydown, true);
    /* the page must not scroll behind an open overlay */
    document.body.classList.add("modal-open");
  }

  function releaseFocus() {
    const closed = focusTraps.pop();
    const parent = focusTraps[focusTraps.length - 1];
    trapped = parent ? parent.el : null;
    if (!parent) {
      document.removeEventListener("keydown", onTrapKeydown, true);
      document.body.classList.remove("modal-open");
    }
    if (closed && closed.returnFocusTo && document.contains(closed.returnFocusTo)) {
      closed.returnFocusTo.focus({ preventScroll: true });
    }
  }

  /* ---------------- drawer ----------------
     Opening it left focus on <body>; closing it left focus nowhere. */

  function openDrawer(sidebarEl, returnTo) {
    trapFocus(sidebarEl, returnTo);
    const first = visibleFocusables(sidebarEl)[0];
    if (first) first.focus({ preventScroll: true });
  }

  function closeDrawer() {
    releaseFocus();
  }

  configureMarkdown();

  window.ReaderUI = {
    vendorUrl,
    announce,
    focusMain,
    setTopbarTitle,
    prepareContent,
    refreshScrollables,
    renderMermaid,
    setMermaidTheme,
    buildInlineToc,
    inScrollRegion,
    trapFocus,
    releaseFocus,
    openDrawer,
    closeDrawer,
  };
})();
