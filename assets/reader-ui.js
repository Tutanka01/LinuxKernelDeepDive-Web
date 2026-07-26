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
      el.removeAttribute("aria-label");
      delete el.dataset.overflow;
      return;
    }
    el.dataset.overflow = "1";
    el.tabIndex = 0;
    el.setAttribute("role", "region");
    if (!el.getAttribute("aria-label")) {
      el.setAttribute("aria-label", label + " (scrolls horizontally)");
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

  function prepareContent(root) {
    if (!root) return;
    wrapFigures(root);
    refreshScrollables(root);
    /* one more pass once fonts / highlighting / diagrams have landed */
    setTimeout(() => refreshScrollables(root), 350);
    setTimeout(() => refreshScrollables(root), 1200);
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
    announce,
    focusMain,
    setTopbarTitle,
    prepareContent,
    refreshScrollables,
    buildInlineToc,
    inScrollRegion,
    trapFocus,
    releaseFocus,
    openDrawer,
    closeDrawer,
  };
})();
