/* ============================================================
   Inference Engineering — the widget host.

   The shared reader (../../assets/course.js) renders a chapter by
   assigning marked's output to #view.innerHTML. That has one
   consequence that shapes this entire file: **a <script> tag
   written into a markdown chapter never runs.** innerHTML parses
   script elements but the HTML spec marks them already-executed,
   so nothing inside them fires. Interactive content therefore
   cannot live in the markdown; the markdown can only carry a
   placeholder, and something outside must find it and fill it in.

   That something is here. A chapter writes

       <div class="inf-widget" data-widget="kv-calculator">
       <p class="inf-widget-fallback">…text shown if JS is off…</p>
       </div>

   and a tool registers itself with

       InfWidgets.define("kv-calculator", (el, opts) => { … });

   We watch #view for the subtree swap course.js performs on every
   navigation, and mount whatever placeholders showed up. Nothing
   in the shared engine had to change to make this work, and if
   this file fails to load the chapters still read correctly —
   they just show the fallback line instead of the tool.
   ============================================================ */

(function () {
  "use strict";

  const registry = new Map();   /* name → mount(el, opts) */
  const MOUNTED = "infMounted"; /* dataset flag, so a rescan is idempotent */

  /* ---------------- public API ---------------- */

  const InfWidgets = {
    /* Register a tool. Safe to call before or after this file's
       own DOM scan: a late definition triggers a rescan, so load
       order between widget scripts never matters. */
    define(name, mount) {
      registry.set(name, mount);
      scan();
    },

    /* True when the reader has asked the OS for no motion. The simulator
       used to autoplay an unbounded rAF loop regardless. */
    reducedMotion() {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    },

    /* "dark" | "paper" — widgets that draw to canvas need this,
       since a canvas cannot inherit a CSS custom property. */
    theme() {
      return document.documentElement.dataset.theme === "paper" ? "paper" : "dark";
    },

    /* The palette the diagrams use, resolved for the live theme.
       Keep in sync with the .svg diagram ground in inf.css. */
    palette() {
      const paper = InfWidgets.theme() === "paper";
      return {
        bg:      paper ? "#f1ebdd" : "#1e1b16",
        panel:   paper ? "#e7dfcc" : "#14110d",
        rule:    paper ? "#ddd3bd" : "#2c2720",
        ink:     paper ? "#221c12" : "#f0e8d8",
        text:    paper ? "#383022" : "#d4cbb7",
        dim:     paper ? "#6b6250" : "#978d7c",
        faint:   paper ? "#877d68" : "#6d6456",
        accent:  paper ? "#8f5d1a" : "#d9a05b",
        good:    paper ? "#4f7d2c" : "#9fbf7f",
        warn:    paper ? "#a4462e" : "#d98a7a",
        cool:    paper ? "#2f6d7d" : "#7fb8c4",
      };
    },

    /* Utility every calculator wants: a number with thousands
       separators and a sensible number of significant digits. */
    fmt(n, digits) {
      if (!isFinite(n)) return "—";
      const d = digits === undefined ? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2) : digits;
      return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    },

    /* Build a control row. Returns the <input>; the caller wires
       its own listener. `opts.format` renders the live value. */
    slider(parent, opts) {
      const wrap = document.createElement("div");
      wrap.className = "inf-control";
      const id = "inf-" + Math.abs(hash(opts.label + parent.childElementCount));
      wrap.innerHTML =
        `<label for="${id}">${esc(opts.label)}<span class="inf-val"></span></label>` +
        `<input id="${id}" type="range" min="${opts.min}" max="${opts.max}" ` +
        `step="${opts.step || 1}" value="${opts.value}">`;
      parent.appendChild(wrap);
      const input = wrap.querySelector("input");
      const out = wrap.querySelector(".inf-val");
      const paint = () => {
        const shown = (opts.format || (v => v))(Number(input.value));
        out.textContent = shown;
        /* Several of these are *index* sliders: the screen says "32K" while
           the raw value is 15. Without aria-valuetext a screen reader reads
           "15 of 18", which is not a number about anything. */
        input.setAttribute("aria-valuetext", String(shown));
      };
      input.addEventListener("input", paint);
      paint();
      return input;
    },

    select(parent, opts) {
      const wrap = document.createElement("div");
      wrap.className = "inf-control";
      const id = "inf-" + Math.abs(hash(opts.label + parent.childElementCount));
      wrap.innerHTML =
        `<label for="${id}">${esc(opts.label)}</label>` +
        `<select id="${id}">` +
        opts.options.map(o =>
          `<option value="${esc(o.value)}"${o.value === opts.value ? " selected" : ""}>${esc(o.label)}</option>`
        ).join("") + `</select>`;
      parent.appendChild(wrap);
      return wrap.querySelector("select");
    },

    toggle(parent, opts) {
      const wrap = document.createElement("label");
      wrap.className = "inf-toggle";
      wrap.innerHTML = `<input type="checkbox"${opts.value ? " checked" : ""}> ${esc(opts.label)}`;
      parent.appendChild(wrap);
      return wrap.querySelector("input");
    },

    /* A canvas that stays sharp on a HiDPI screen and re-lays-out
       with the reading column. Returns {canvas, ctx, size()}. */
    canvas(parent, aspect, label) {
      const wrap = document.createElement("div");
      wrap.className = "inf-canvas-wrap";
      const canvas = document.createElement("canvas");
      /* A canvas is a blank element to assistive tech unless it is told
         what it is; the simulator is a page whose only content is one. */
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label",
        label || "Diagram drawn from the controls above; the figures beside it carry the same values.");
      wrap.appendChild(canvas);
      parent.appendChild(wrap);
      const ctx = canvas.getContext("2d");
      let w = 0, h = 0;
      function size() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        /* the floor used to exceed the real wrapper at <=320px, squashing a
           280-logical-px drawing into 276 CSS px and skewing every computed
           x-coordinate */
        const avail = wrap.clientWidth || parent.clientWidth || 640;
        w = Math.max(240, Math.min(avail || 640, 1400));
        h = Math.round(w * (aspect || 0.5));
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.height = h + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w, h };
      }
      size();
      return { canvas, ctx, size, get w() { return w; }, get h() { return h; } };
    },
  };

  window.InfWidgets = InfWidgets;

  /* ---------------- mounting ---------------- */

  function scan() {
    const view = document.getElementById("view");
    if (!view) return;

    view.querySelectorAll(".inf-widget[data-widget]").forEach(el => {
      if (el.dataset[MOUNTED]) return;
      const mount = registry.get(el.dataset.widget);
      if (!mount) return;                      /* its script may still be loading */
      el.dataset[MOUNTED] = "1";
      try {
        el.innerHTML = "";
        mount(el, { ...el.dataset });
      } catch (err) {
        /* A broken tool must never take the chapter down with it. */
        el.innerHTML = `<p class="inf-widget-fallback">This interactive tool failed to start (${esc(err.message)}). The chapter text stands on its own.</p>`;
        if (window.console) console.error("[inf-widget] " + el.dataset.widget, err);
      }
    });

    decorateCallouts(view);
  }

  /* ---------------- callouts ----------------
     Markdown carries them as a blockquote opening with a GitHub-
     style marker:  > [!bridge] You already know this
     marked renders that literally; we lift the marker out into a
     styled label. Doing it here rather than as raw HTML in the
     markdown keeps the body ordinary markdown, so links, code and
     emphasis inside a callout all still render. */

  const CALLOUTS = {
    bridge: "You already know this",
    prereq: "Prerequisite",
    trap:   "Common trap",
    note:   "Note",
  };

  function decorateCallouts(root) {
    root.querySelectorAll(".article-body blockquote").forEach(bq => {
      if (bq.dataset[MOUNTED]) return;
      const first = bq.firstElementChild;
      if (!first || first.tagName !== "P") return;

      const m = /^\s*\[!([a-z]+)\]\s*([^\n]*)/i.exec(first.textContent || "");
      if (!m) return;
      const kind = m[1].toLowerCase();
      if (!(kind in CALLOUTS)) return;

      bq.dataset[MOUNTED] = "1";
      bq.classList.add("inf-callout", "callout-" + kind);

      /* Strip the marker from the text node it actually sits in,
         so any inline markup after it survives untouched. */
      const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (node) node.nodeValue = node.nodeValue.replace(/^\s*\[![a-z]+\]\s*[^\n]*/i, "").replace(/^\s+/, "");
      if (!first.textContent.trim()) first.remove();

      const title = document.createElement("span");
      title.className = "inf-callout-title";
      title.textContent = (m[2] || "").trim() || CALLOUTS[kind];
      bq.insertBefore(title, bq.firstChild);
    });
  }

  /* ---------------- helpers ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  /* ---------------- lifecycle ----------------
     course.js swaps #view wholesale on every navigation and emits
     no event we could hook, so we watch the subtree instead. The
     rescan is cheap (a querySelectorAll over one article) and
     idempotent, but navigation replaces hundreds of nodes at once,
     so coalesce a burst into one pass. */

  function observe() {
    const view = document.getElementById("view");
    if (!view) return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    }).observe(view, { childList: true, subtree: true });
    scan();
  }

  /* Canvas widgets cannot inherit CSS variables, so tell them when
     the reader flips the theme. The switch lives in course.js and
     only ever touches documentElement.dataset.theme. */
  function watchTheme() {
    new MutationObserver(() => {
      window.dispatchEvent(new CustomEvent("inf-theme", { detail: InfWidgets.theme() }));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { observe(); watchTheme(); });
  } else {
    observe();
    watchTheme();
  }
})();
