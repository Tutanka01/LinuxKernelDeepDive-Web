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

   The same rescan also decorates plain Markdown that needs more than
   marked gives it: [!kind] callouts (including the v3 [!dashboard]
   row), the provenance caption under a real artifact, a lab's
   "Not executed by the author." banner, and the glossary's
   self-test toggle. Each decorator is idempotent and leaves the
   Markdown readable if this file never loads.
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

    /* The palette the canvas widgets draw with, resolved for the live
       theme. A canvas cannot inherit a custom property, so this reads the
       stylesheet's tokens at draw time instead of keeping a copy of them:
       a copy is a palette that eventually disagrees with the page. The
       literals are only a fallback for a page without style.css. */
    palette() {
      const paper = InfWidgets.theme() === "paper";
      const cs = getComputedStyle(document.documentElement);
      const tok = (name, dark, light) => (cs.getPropertyValue(name).trim() || (paper ? light : dark));
      return {
        bg:      tok("--bg-raised",   "#181c22", "#ffffff"),
        panel:   tok("--bg-code",     "#0e1115", "#f0f2f5"),
        rule:    tok("--rule-mid",    "#2f353f", "#d3d8df"),
        ink:     tok("--ink",         "#f1f3f6", "#14171c"),
        text:    tok("--text",        "#d2d7de", "#262b33"),
        dim:     tok("--text-dim",    "#9aa3af", "#555d68"),
        faint:   tok("--text-faint",  "#87909c", "#626a75"),
        accent:  tok("--accent",      "#8fb1ff", "#2747c9"),
        good:    tok("--c-green",     "#7ccf98", "#1a7040"),
        warn:    tok("--c-red",       "#ff8f87", "#b42318"),
        amber:   tok("--c-amber",     "#e5b562", "#8d5400"),
        cool:    tok("--c-teal",      "#5fc6c4", "#0b6e75"),
        sans:    tok("--sans",        "system-ui, sans-serif", "system-ui, sans-serif"),
        mono:    tok("--mono",        "ui-monospace, monospace", "ui-monospace, monospace"),
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
    decorateProvenance(view);
    decorateLabBanners(view);
    mountGlossarySelfTest(view);
  }

  /* ---------------- callouts ----------------
     Markdown carries them as a blockquote opening with a GitHub-
     style marker:  > [!bridge] You already know this
     marked renders that literally; we lift the marker out into a
     styled label. Doing it here rather than as raw HTML in the
     markdown keeps the body ordinary markdown, so links, code and
     emphasis inside a callout all still render. */

  const CALLOUTS = {
    bridge:  "You already know this",
    prereq:  "Prerequisite",
    trap:    "Common trap",
    note:    "Note",
    predict: "Predict first",
    case:    "The case",
    /* STYLE-v3: the chapter's row of the serving USE grid — a small
       utilisation / saturation / errors table of real metric names. */
    dashboard: "On the dashboard",
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

      /* A dashboard row is a table of metric names, which at 320px cannot
         hold three columns of `vllm:kv_cache_usage_perc`-length cells. Give
         every cell its column header as a data-label, so the stylesheet can
         stack each row into labelled lines on a phone. */
      if (kind === "dashboard") {
        bq.querySelectorAll("table").forEach(table => {
          const heads = [...table.querySelectorAll("thead th")].map(th => (th.textContent || "").trim());
          table.querySelectorAll("tbody tr").forEach(tr => {
            [...tr.children].forEach((cell, i) => {
              if (heads[i]) cell.dataset.label = heads[i];
            });
          });
          /* `vllm:num_requests_waiting` should wrap at its separators,
             not mid-word: offer a break after every ":" and "_". */
          table.querySelectorAll("td code").forEach(code => {
            if (code.children.length || !/[:_]/.test(code.textContent)) return;
            const parts = code.textContent.split(/(?<=[:_])/);
            code.textContent = "";
            parts.forEach((part, i) => {
              if (i) code.appendChild(document.createElement("wbr"));
              code.appendChild(document.createTextNode(part));
            });
          });
        });
      }
    });
  }

  /* ---------------- provenance captions ----------------
     STYLE-v3: every real artifact (a fenced block of source, config, log or
     metrics) is followed by one italic line saying where it came from:

       *Verbatim — vLLM v0.34.0, `vllm/v1/metrics/loggers.py`.*

     marked renders that as a <p><em>…</em></p> after the <pre>. Here it is
     tied to its block — small, dim, tight under it — so it reads as the
     block's caption and not as one more paragraph. The label word is kept
     in its own span so the three kinds stay distinguishable at a glance. */

  const PROVENANCE = [
    { label: "Verbatim",                         kind: "verbatim" },
    { label: "Real format, illustrative values", kind: "illustrative" },
    { label: "Runnable",                         kind: "runnable" },
  ];

  function provenanceOf(p) {
    const text = (p.textContent || "").trim();
    return PROVENANCE.find(k => text.startsWith(k.label + " —")) || null;
  }

  function decorateProvenance(root) {
    root.querySelectorAll(".article-body pre").forEach(pre => {
      /* a future wrapper (copy button, scroller) must not break the pairing */
      const parent = pre.parentElement;
      const anchor = parent && parent.tagName === "DIV" && parent.children.length === 1 &&
        !parent.matches(".article-body, .exercise, .inf-widget") ? parent : pre;
      const p = anchor.nextElementSibling;
      if (!p || p.tagName !== "P" || p.classList.contains("inf-provenance")) return;
      const kind = provenanceOf(p);
      if (!kind) return;

      p.classList.add("inf-provenance", "inf-provenance-" + kind.kind);
      anchor.classList.add("inf-has-provenance");

      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.nodeValue.trim()) node = walker.nextNode();
      if (!node) return;
      const lead = node.nodeValue.length - node.nodeValue.replace(/^\s+/, "").length;
      if (node.nodeValue.slice(lead, lead + kind.label.length) !== kind.label) return;
      const labelNode = lead ? node.splitText(lead) : node;
      labelNode.splitText(kind.label.length);
      const span = document.createElement("span");
      span.className = "inf-provenance-kind";
      labelNode.replaceWith(span);
      span.appendChild(labelNode);
    });
  }

  /* ---------------- lab banner ----------------
     A lab opens with "> **Not executed by the author.** …": the commands
     come from a pinned tool version, and the expected results are shapes,
     not measurements. It gets its own sober frame so it is never mistaken
     for an aside. */

  const LAB_BANNER = "Not executed by the author.";

  function decorateLabBanners(root) {
    root.querySelectorAll(".article-body blockquote").forEach(bq => {
      if (bq.classList.contains("inf-lab-banner") || bq.classList.contains("inf-callout")) return;
      const strong = bq.querySelector("strong");
      if (!strong || (strong.textContent || "").trim() !== LAB_BANNER) return;
      bq.classList.add("inf-lab-banner");
      bq.setAttribute("role", "note");
    });
  }

  /* ---------------- glossary self-test ----------------
     The glossary is a <dl class="glossary"> of <dt>/<dd> pairs. On that page
     only, a toggle turns it into flash cards: every definition hidden, each
     term a button that reveals its own. Nothing is persisted — a reload is
     a fresh test, which is what a self-test should be. */

  function onGlossaryRoute() {
    return /^#\/glossary(?:$|[@?/])/.test(location.hash || "");
  }

  function definitionsOf(dt) {
    const out = [];
    for (let n = dt.nextElementSibling; n && n.tagName === "DD"; n = n.nextElementSibling) out.push(n);
    return out;
  }

  function mountGlossarySelfTest(root) {
    const lists = [...root.querySelectorAll(".article-body dl.glossary")];
    if (!lists.length || !onGlossaryRoute()) return;
    if (root.querySelector(".inf-gloss-selftest")) return;

    const bar = document.createElement("div");
    bar.className = "inf-gloss-selftest";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Glossary self-test");
    bar.innerHTML =
      '<button type="button" class="inf-btn inf-gloss-toggle" aria-pressed="false">Self-test: hide definitions</button>' +
      '<button type="button" class="inf-btn inf-gloss-showall" hidden>Show all</button>' +
      '<span class="inf-gloss-status" role="status" aria-live="polite"></span>';
    lists[0].parentNode.insertBefore(bar, lists[0]);

    const toggle = bar.querySelector(".inf-gloss-toggle");
    const showAll = bar.querySelector(".inf-gloss-showall");
    const status = bar.querySelector(".inf-gloss-status");
    let seq = 0;

    const terms = () => lists.flatMap(dl => [...dl.querySelectorAll(":scope > dt, :scope > div > dt")]);

    function count() {
      const btns = [...bar.parentNode.querySelectorAll(".inf-gloss-term")];
      const open = btns.filter(b => b.getAttribute("aria-expanded") === "true").length;
      status.textContent = btns.length ? open + " of " + btns.length + " revealed" : "";
    }

    function setOpen(btn, open) {
      btn.setAttribute("aria-expanded", String(open));
      definitionsOf(btn.closest("dt")).forEach(dd => { dd.hidden = !open; });
    }

    function enable() {
      terms().forEach(dt => {
        if (dt.querySelector(".inf-gloss-term")) return;
        const dds = definitionsOf(dt);
        if (!dds.length) return;
        const ids = dds.map(dd => dd.id || (dd.id = "inf-gloss-def-" + (++seq)));
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "inf-gloss-term";
        btn.setAttribute("aria-controls", ids.join(" "));
        while (dt.firstChild) btn.appendChild(dt.firstChild);
        dt.appendChild(btn);
        btn.addEventListener("click", () => {
          setOpen(btn, btn.getAttribute("aria-expanded") !== "true");
          count();
        });
        setOpen(btn, false);
      });
      toggle.setAttribute("aria-pressed", "true");
      showAll.hidden = false;
      count();
    }

    function disable() {
      bar.parentNode.querySelectorAll(".inf-gloss-term").forEach(btn => {
        const dt = btn.parentNode;
        setOpen(btn, true);
        while (btn.firstChild) dt.insertBefore(btn.firstChild, btn);
        btn.remove();
      });
      toggle.setAttribute("aria-pressed", "false");
      showAll.hidden = true;
      status.textContent = "";
    }

    toggle.addEventListener("click", () => {
      if (toggle.getAttribute("aria-pressed") === "true") disable(); else enable();
    });
    showAll.addEventListener("click", () => {
      bar.parentNode.querySelectorAll(".inf-gloss-term").forEach(btn => setOpen(btn, true));
      count();
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
