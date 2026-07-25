/* ============================================================
   Inference Engineering — A Guided Course.
   A small course engine on top of marked + highlight.js:
   - home route with course map & progress
   - chapter route with reading time, quizzes, completion
   - progress persisted in localStorage
   ============================================================ */

const COURSE = [
  {
    module: "Module 1 — The Physics",
    level: "beginner",
    levelLabel: "Beginner",
    blurb: "Start from zero: what happens when you call an LLM, how a GPU actually works, and the arithmetic that rules the whole field.",
    chapters: [
      { slug: "what-is-inference", title: "What Actually Happens When You Call an LLM",
        desc: "Tokens, the autoregressive loop, prefill vs decode — and why serving is a systems problem." },
      { slug: "gpu-mental-model", title: "The GPU Mental Model",
        desc: "SMs, HBM, tensor cores and the roofline: the two numbers that explain everything." },
      { slug: "inference-arithmetic", title: "Inference Arithmetic",
        desc: "KV-cache math, batching, critical batch size, TTFT/TPOT — and what a token really costs." },
    ],
  },
  {
    module: "Module 2 — The Engine",
    level: "beginner",
    levelLabel: "Beginner+",
    blurb: "How a serving engine turns that arithmetic into a machine: scheduling, memory management, and the full life of a request.",
    chapters: [
      { slug: "continuous-batching", title: "Continuous Batching & Scheduling",
        desc: "Iteration-level scheduling, chunked prefill, and the prefill/decode interference problem." },
      { slug: "paged-kv-cache", title: "PagedAttention & Prefix Caching",
        desc: "Virtual memory rediscovered on a GPU: block tables, copy-on-write, RadixAttention." },
      { slug: "anatomy-of-an-engine", title: "Anatomy of a Serving Engine",
        desc: "Inside vLLM and SGLang: schedulers, samplers, structured output, the engine landscape." },
    ],
  },
  {
    module: "Module 3 — Squeezing the Model",
    level: "intermediate",
    levelLabel: "Intermediate",
    blurb: "Make the model itself cheaper to run: smaller caches, smaller numbers, and tokens that arrive before they're computed.",
    chapters: [
      { slug: "attention-for-serving", title: "Attention Architectures for Serving",
        desc: "MHA to GQA to MLA, sliding windows, sparse attention and SSM hybrids." },
      { slug: "quantization", title: "Quantization",
        desc: "FP8, INT4, FP4 — the formats, the methods, and the evaluation traps." },
      { slug: "speculative-decoding", title: "Speculative Decoding",
        desc: "Draft models, EAGLE, MTP — provably lossless speedup, and when it backfires." },
    ],
  },
  {
    module: "Module 4 — Under the Hood",
    level: "advanced",
    levelLabel: "Advanced",
    blurb: "Down to the metal: the kernels that move the bytes, and the compilers and graphs that keep the GPU fed.",
    chapters: [
      { slug: "flashattention", title: "FlashAttention & Decode Kernels",
        desc: "Online softmax, tiling, FlashAttention 1→4, FlashDecoding and FlashInfer." },
      { slug: "kernels-and-compilation", title: "Kernels, Graphs & Compilation",
        desc: "CUDA graphs, torch.compile, Triton vs CUTLASS, MoE kernels, Blackwell." },
    ],
  },
  {
    module: "Module 5 — Serving at Scale",
    level: "advanced",
    levelLabel: "Advanced+",
    blurb: "Beyond one GPU: parallelism, rack-scale MoE, disaggregated fleets — and the agentic traffic that reshaped it all.",
    chapters: [
      { slug: "parallelism-for-inference", title: "Parallelism for Inference",
        desc: "TP, PP, EP and context parallelism — and why inference isn't training." },
      { slug: "moe-serving", title: "Serving MoE at Scale",
        desc: "DeepSeek's inference system, wide expert parallelism and rack-scale NVLink." },
      { slug: "disaggregation", title: "Disaggregated Serving & the KV Fabric",
        desc: "Prefill/decode split, Mooncake, Dynamo, KV tiering and cache-aware routing." },
      { slug: "agentic-serving", title: "The Agentic Era",
        desc: "Agent traffic, cache-hit economics, RL rollouts and multi-LoRA." },
    ],
  },
  {
    module: "Module 6 — The Big Picture",
    level: "intermediate",
    levelLabel: "Perspective",
    blurb: "Zoom out: the silicon, the money, the benchmarks that lie — and the frontier as of mid-2026.",
    chapters: [
      { slug: "hardware-and-economics", title: "Hardware & Economics",
        desc: "GPUs, TPUs and SRAM silicon; token prices, margins, benchmarks, energy." },
      { slug: "frontier", title: "The Frontier (mid-2026)",
        desc: "A dated snapshot: test-time compute, diffusion LLMs, and what might be next." },
    ],
  },
];

const FLAT = COURSE.flatMap(m =>
  m.chapters.map(ch => ({ ...ch, level: m.level, levelLabel: m.levelLabel, module: m.module }))
);

/* ---------------- progress (localStorage) ---------------- */

const STORE_KEY = "inf-course-progress-v1";

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { completed: {}, last: null }; }
  catch { return { completed: {}, last: null }; }
}
/* Returns false when the browser refuses the write (private mode, quota,
   storage disabled). Callers must not claim success on a false. */
function saveProgress(p) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
    return true;
  } catch { return false; }
}

function isComplete(slug) { return !!loadProgress().completed[slug]; }

function setComplete(slug, value) {
  const p = loadProgress();
  if (value) p.completed[slug] = true; else delete p.completed[slug];
  const saved = saveProgress(p);
  refreshProgressUI();          // re-reads storage, so a failed write repaints the truth
  return saved;
}

function setLastVisited(slug) {
  const p = loadProgress();
  p.last = slug;
  saveProgress(p);
}

function completedCount() {
  const p = loadProgress();
  return FLAT.filter(ch => p.completed[ch.slug]).length;
}

function nextUnread() {
  const p = loadProgress();
  return FLAT.find(ch => !p.completed[ch.slug]) || FLAT[0];
}

/* ---------------- DOM handles ---------------- */

const tocEl      = document.getElementById("toc");
const viewEl     = document.getElementById("view");
const sidebarEl  = document.getElementById("sidebar");
const toggleEl   = document.getElementById("sidebar-toggle");
const progressEl = document.getElementById("progress-bar");
const scrimEl    = document.getElementById("sidebar-scrim");

/* ---------------- theme: terminal (dark) / paper (light) ---------------- */

const THEME_KEY   = "ldd-theme";
const hljsThemeEl = document.getElementById("hljs-theme");

const HLJS_THEME_HREF = {
  dark:  "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-dark-medium.min.css",
  paper: "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-light-medium.min.css",
};

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === "paper" ? "paper" : "dark"; }
  catch { return "dark"; }
}

function applyTheme(theme) {
  if (theme === "paper") document.documentElement.setAttribute("data-theme", "paper");
  else document.documentElement.removeAttribute("data-theme");
  if (hljsThemeEl) hljsThemeEl.href = HLJS_THEME_HREF[theme];
  document.querySelectorAll(".theme-btn").forEach(btn => {
    const active = btn.dataset.themeValue === theme;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("theme-switching");
    setTimeout(() => document.documentElement.classList.remove("theme-switching"), 300);
  }
  applyTheme(theme);
}

window.addEventListener("scroll", () => {
  const h = document.documentElement.scrollHeight - window.innerHeight;
  progressEl.style.width = h > 0 ? (scrollY / h) * 100 + "%" : "0%";
}, { passive: true });

marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return code;
  },
});

/* ---------------- reading time ---------------- */

const wordCache = {};
function readingTime(md) {
  const words = md.split(/\s+/).length;
  return Math.max(2, Math.round(words / 210));
}

/* ---------------- sidebar / outline ---------------- */

function buildToc() {
  let n = 0;
  tocEl.innerHTML = COURSE.map(mod => {
    const items = mod.chapters.map(ch => {
      n += 1;
      return `<li><a href="#/${ch.slug}" data-slug="${ch.slug}">
        <span class="toc-num">${String(n).padStart(2, "0")}</span>
        <span class="toc-title">${ch.title}</span>
        <span class="toc-check" aria-hidden="true">✓</span></a></li>`;
    }).join("");
    return `<p class="toc-part">${mod.module}</p>
            <ul class="toc-list">${items}</ul>`;
  }).join("");
}

function refreshProgressUI() {
  const progress = loadProgress();
  tocEl.querySelectorAll("a[data-slug]").forEach(a => {
    a.classList.toggle("read", !!progress.completed[a.dataset.slug]);
  });
}

function markActive(slug) {
  tocEl.querySelectorAll("a").forEach(a => {
    a.classList.toggle("active", a.dataset.slug === slug);
  });
}

/* ---------------- home / course map ---------------- */

function renderHome() {
  markActive(null);
  document.title = "Inference Engineering — A Guided Course";
  const done = completedCount();
  const pct = Math.round((done / FLAT.length) * 100);
  const next = nextUnread();
  const started = done > 0;

  /* progress ring geometry */
  const R = 52, C = 2 * Math.PI * R;
  const offset = C - (pct / 100) * C;

  let n = 0;
  const modules = COURSE.map((mod, mi) => {
    const chapters = mod.chapters.map(ch => {
      n += 1;
      const doneCls = isComplete(ch.slug) ? " done" : "";
      return `
        <a class="chapter-card${doneCls}" href="#/${ch.slug}">
          <span class="card-check" aria-hidden="true"></span>
          <span class="card-num">${String(n).padStart(2, "0")}</span>
          <span class="card-body">
            <span class="card-title">${ch.title}</span>
            <span class="card-desc">${ch.desc}</span>
          </span>
          <span class="card-arrow" aria-hidden="true">&rarr;</span>
        </a>`;
    }).join("");
    return `
      <section class="module">
        <header class="module-head">
          <span class="module-index">${String(mi + 1).padStart(2, "0")}</span>
          <div>
            <h2>${mod.module.replace(/^Module \d+ — /, "")}</h2>
            <p class="module-blurb">${mod.blurb}</p>
          </div>
          <span class="lvl-badge lvl-${mod.level}">${mod.levelLabel}</span>
        </header>
        <div class="chapter-grid">${chapters}</div>
      </section>`;
  }).join("");

  viewEl.innerHTML = `
    <div class="home fade-in">
      <header class="hero">
        <div class="hero-text">
          <p class="hero-kicker">A self-paced course · ${FLAT.length} chapters</p>
          <h1>Inference Engineering,<br>from first principles</h1>
          <p class="hero-lede">
            Every answer an LLM streams back is a fight against physics: a model
            too big for its GPU, generating one token at a time, for thousands of
            users at once. This course builds the whole discipline up carefully —
            from "what is a token" to the roofline arithmetic, the engines, the
            kernels, and the rack-scale systems behind ChatGPT, Claude and
            DeepSeek. Each chapter stands on the previous one; no GPU or ML
            background assumed.
          </p>
          <div class="hero-actions">
            <a class="btn-primary" href="#/${next.slug}">
              ${started ? "Continue — " + next.title : "Start the course"}
            </a>
            ${started ? `<span class="hero-hint">Picking up where you left off</span>` : `<span class="hero-hint">~${totalTimeEstimate()} of reading, at your pace</span>`}
          </div>
        </div>
        <div class="hero-ring" role="img" aria-label="${pct}% of the course completed">
          <svg viewBox="0 0 120 120" width="132" height="132">
            <circle cx="60" cy="60" r="${R}" class="ring-track"/>
            <circle cx="60" cy="60" r="${R}" class="ring-fill"
                    stroke-dasharray="${C.toFixed(1)}"
                    stroke-dashoffset="${offset.toFixed(1)}"
                    transform="rotate(-90 60 60)"/>
          </svg>
          <div class="ring-label"><strong>${pct}%</strong><span>complete</span></div>
        </div>
      </header>

      <p class="path-legend">The path runs from beginner to advanced, and each chapter
        builds on the previous one. Every chapter ends with a short quiz —
        pass it and the chapter is marked complete.</p>

      ${modules}
    </div>
    <footer class="page-footer">
      <p>Part of <a href="../index.html">The Linux Deep Dive</a> — but a journey of its own.</p>
    </footer>`;
  window.scrollTo(0, 0);
}

function totalTimeEstimate() {
  /* rough static estimate before any chapter is fetched */
  return "7–8 hours";
}

/* ---------------- quizzes ---------------- */

function renderQuizzes(slug) {
  viewEl.querySelectorAll("pre code.language-quiz").forEach(codeEl => {
    let data;
    try { data = JSON.parse(codeEl.textContent); } catch { return; }
    const pre = codeEl.parentElement;
    const quiz = document.createElement("div");
    quiz.className = "quiz";
    quiz.innerHTML = `
      <div class="quiz-head">
        <span class="quiz-flag">Checkpoint</span>
        <h3>Check your understanding</h3>
        <p class="quiz-sub">${data.length} question${data.length > 1 ? "s" : ""} — answer them all to complete the chapter.</p>
      </div>
      ${data.map((q, qi) => `
        <fieldset class="quiz-q" data-qi="${qi}" data-answer="${q.answer}">
          <legend>${qi + 1}. ${q.q}</legend>
          ${q.choices.map((c, ci) => `
            <label class="quiz-choice">
              <input type="radio" name="q-${slug}-${qi}" value="${ci}">
              <span>${c}</span>
            </label>`).join("")}
          <p class="quiz-explain" hidden>${q.explain}</p>
        </fieldset>`).join("")}
      <div class="quiz-foot">
        <button class="btn-primary quiz-submit">Check my answers</button>
        <span class="quiz-result" role="status"></span>
      </div>`;
    pre.replaceWith(quiz);

    quiz.querySelector(".quiz-submit").addEventListener("click", () => {
      let correct = 0, answered = 0;
      quiz.querySelectorAll(".quiz-q").forEach(fs => {
        const picked = fs.querySelector("input:checked");
        const explain = fs.querySelector(".quiz-explain");
        fs.classList.remove("right", "wrong");
        if (!picked) return;
        answered += 1;
        const ok = Number(picked.value) === Number(fs.dataset.answer);
        fs.classList.add(ok ? "right" : "wrong");
        explain.hidden = false;
        if (ok) correct += 1;
      });
      const result = quiz.querySelector(".quiz-result");
      if (answered < data.length) {
        result.textContent = `Answer all ${data.length} questions first (${answered}/${data.length}).`;
        result.className = "quiz-result";
        return;
      }
      if (correct === data.length) {
        const saved = setComplete(slug, true);   // write first, report second
        result.textContent = saved
          ? "Perfect — chapter marked as complete ✓"
          : "Perfect — every answer correct. Progress can't be saved: this browser is blocking local storage.";
        result.className = saved ? "quiz-result pass" : "quiz-result warn";
        const btn = viewEl.querySelector(".complete-toggle");
        if (btn) syncCompleteButton(btn, slug);
      } else {
        result.textContent = `${correct}/${data.length} correct — read the explanations and try again.`;
        result.className = "quiz-result fail";
      }
    });
  });
}

/* ---------------- chapter view ---------------- */

function syncCompleteButton(btn, slug) {
  const done = isComplete(slug);
  btn.classList.toggle("done", done);
  btn.innerHTML = done
    ? `<span class="check-ic">✓</span> Completed — tap to undo`
    : `Mark chapter as complete`;
}

async function renderChapter(slug) {
  markActive(slug);
  setLastVisited(slug);
  const i = FLAT.findIndex(ch => ch.slug === slug);
  const ch = FLAT[i], prev = FLAT[i - 1], next = FLAT[i + 1];

  let md;
  try {
    if (!wordCache[slug]) {
      const res = await fetch(`content/${slug}.md`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      wordCache[slug] = await res.text();
    }
    md = wordCache[slug];
  } catch (err) {
    viewEl.innerHTML =
      `<article class="article"><h1>Couldn't load this chapter</h1>
       <p>Failed to fetch <code>content/${slug}.md</code> (${err.message}).</p>
       <p>If you opened this file directly from disk, serve the folder instead:</p>
       <pre><code>cd LinuxKernelDeepDive-Web
python3 -m http.server 8000</code></pre>
       <p>…then visit <a href="http://localhost:8000/inference/">http://localhost:8000/inference/</a>.</p></article>`;
    return;
  }

  const mins = readingTime(md);

  viewEl.innerHTML = `
    <article class="article fade-in">
      <header class="chapter-meta">
        <a class="crumb" href="#/">Course home</a>
        <span class="crumb-sep">/</span>
        <span class="crumb-here">${ch.module.replace(/^Module \d+ — /, "")}</span>
        <span class="meta-right">
          <span class="lvl-badge lvl-${ch.level}">${ch.levelLabel}</span>
          <span class="read-time">${mins} min read</span>
        </span>
      </header>
      <div class="article-body">${marked.parse(md)}</div>
      <div class="chapter-done">
        <button class="complete-toggle"></button>
        <p class="save-warning" role="status" hidden>Progress can't be saved — this browser is blocking local storage.</p>
      </div>
    </article>
    <nav class="pager">
        ${prev ? `<a class="prev" href="#/${prev.slug}">
                    <span class="pager-label">&larr; previous</span>
                    <span class="pager-title">${prev.title}</span></a>` : `<a class="prev" href="#/">
                    <span class="pager-label">&larr; back</span>
                    <span class="pager-title">Course home</span></a>`}
        ${next ? `<a class="next" href="#/${next.slug}">
                    <span class="pager-label">next &rarr;</span>
                    <span class="pager-title">${next.title}</span></a>` : `<a class="next" href="#/">
                    <span class="pager-label">finish &rarr;</span>
                    <span class="pager-title">Back to the course map</span></a>`}
    </nav>
    <footer class="page-footer">
      <p>Inference Engineering — a guided course. Tip: use ← and → to move between chapters.</p>
    </footer>`;

  viewEl.querySelectorAll(".article-body pre code").forEach(el => {
    if (!el.classList.contains("language-quiz")) hljs.highlightElement(el);
  });
  renderQuizzes(slug);

  const btn = viewEl.querySelector(".complete-toggle");
  syncCompleteButton(btn, slug);
  btn.addEventListener("click", () => {
    const saved = setComplete(slug, !isComplete(slug));
    syncCompleteButton(btn, slug);
    const warn = viewEl.querySelector(".save-warning");
    if (warn) warn.hidden = saved;
  });

  document.title = `${ch.title} — Inference Engineering`;
  window.scrollTo(0, 0);
}

/* ---------------- routing ---------------- */

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, "").trim();
  if (!hash) return { kind: "home" };
  if (FLAT.some(ch => ch.slug === hash)) return { kind: "chapter", slug: hash };
  return { kind: "home" };
}

function setSidebar(open) {
  sidebarEl.classList.toggle("open", open);
  document.body.classList.toggle("nav-open", open);
  toggleEl.setAttribute("aria-expanded", String(open));
}

function route() {
  const r = currentRoute();
  if (r.kind === "home") renderHome();
  else renderChapter(r.slug);
  refreshProgressUI();
  setSidebar(false);
}

/* ---------------- full-text search ---------------- */

const searchModal = document.getElementById("search-modal");
const searchInput = document.getElementById("search-input");
const searchList  = document.getElementById("search-results");
let searchIndex   = null;
let searchSel     = 0;

async function buildSearchIndex() {
  if (searchIndex) return searchIndex;
  searchList.innerHTML = `<li class="search-hint">Indexing chapters…</li>`;
  const docs = await Promise.all(FLAT.map(async ch => {
    try {
      const res = await fetch(`content/${ch.slug}.md`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text())
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[#>*_`|\[\]]/g, " ")
        .replace(/\(https?:[^)]*\)/g, " ")
        .replace(/\s+/g, " ");
      return { slug: ch.slug, title: ch.title, text, lower: text.toLowerCase() };
    } catch { return null; }
  }));
  searchIndex = docs.filter(Boolean);
  return searchIndex;
}

function searchQuery(q) {
  if (!searchIndex) return [];
  const terms = q.toLowerCase().split(/\s+/).filter(term => term.length > 1);
  if (!terms.length) return [];
  const results = [];
  for (const doc of searchIndex) {
    let score = 0, firstHit = -1;
    for (const term of terms) {
      let hits = 0, i = doc.lower.indexOf(term);
      if (i === -1) { score = 0; break; }
      if (firstHit === -1 || i < firstHit) firstHit = i;
      while (i !== -1 && hits < 50) {
        hits += 1;
        i = doc.lower.indexOf(term, i + term.length);
      }
      score += hits;
      if (doc.title.toLowerCase().includes(term)) score += 25;
    }
    if (score > 0) results.push({ doc, score, firstHit });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 12);
}

function snippet(doc, firstHit, terms) {
  const start = Math.max(0, firstHit - 60);
  let text = doc.text.slice(start, start + 170);
  if (start > 0) text = "…" + text;
  text += "…";
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(${escaped})`, "ig"), "<mark>$1</mark>");
  }
  return text;
}

function renderSearchResults(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(term => term.length > 1);
  const results = searchQuery(q);
  searchSel = 0;
  if (!q.trim()) {
    searchList.innerHTML = `<li class="search-hint">Type to search all ${FLAT.length} chapters.</li>`;
    return;
  }
  if (!results.length) {
    searchList.innerHTML = `<li class="search-hint">No results for “${q}”.</li>`;
    return;
  }
  searchList.innerHTML = results.map((result, i) =>
    `<li class="search-result${i === 0 ? " selected" : ""}" data-slug="${result.doc.slug}">
       <span class="sr-title">${result.doc.title}</span>
       <span class="sr-snippet">${snippet(result.doc, result.firstHit, terms)}</span>
     </li>`).join("");
  searchList.querySelectorAll(".search-result").forEach(li => {
    li.addEventListener("click", () => {
      closeSearch();
      location.hash = `#/${li.dataset.slug}`;
    });
  });
}

async function openSearch() {
  searchModal.classList.add("open");
  searchInput.value = "";
  searchInput.focus();
  await buildSearchIndex();
  renderSearchResults(searchInput.value);
}

function closeSearch() { searchModal.classList.remove("open"); }

searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));
searchInput.addEventListener("keydown", e => {
  const items = [...searchList.querySelectorAll(".search-result")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    searchSel = (searchSel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items.forEach((li, i) => li.classList.toggle("selected", i === searchSel));
    items[searchSel].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && items[searchSel]) {
    closeSearch();
    location.hash = `#/${items[searchSel].dataset.slug}`;
  } else if (e.key === "Escape") {
    closeSearch();
  }
});

searchModal.addEventListener("click", e => {
  if (e.target === searchModal) closeSearch();
});
document.getElementById("search-open").addEventListener("click", openSearch);

/* ---------------- keyboard navigation ---------------- */

document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === "Escape" && sidebarEl.classList.contains("open")) {
    setSidebar(false);
    return;
  }
  if (e.key === "[" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey &&
      window.matchMedia("(min-width: 901px)").matches) {
    e.preventDefault();
    setNavCollapsed(!document.documentElement.classList.contains("nav-collapsed"));
    return;
  }
  if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key === "k")) {
    e.preventDefault();
    openSearch();
    return;
  }
  if (typing || searchModal.classList.contains("open")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const r = currentRoute();
  if (r.kind !== "chapter") return;
  const i = FLAT.findIndex(ch => ch.slug === r.slug);
  if (e.key === "ArrowLeft" && FLAT[i - 1]) location.hash = `#/${FLAT[i - 1].slug}`;
  if (e.key === "ArrowRight" && FLAT[i + 1]) location.hash = `#/${FLAT[i + 1].slug}`;
});

/* ---------------- boot ---------------- */

document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeValue));
});
applyTheme(currentTheme());

toggleEl.setAttribute("aria-expanded", "false");
toggleEl.addEventListener("click", () => setSidebar(!sidebarEl.classList.contains("open")));
if (scrimEl) scrimEl.addEventListener("click", () => setSidebar(false));

const COLLAPSE_KEY = "ldd-nav-collapsed";
const collapseBtn  = document.getElementById("sidebar-collapse");
const showBtn      = document.getElementById("sidebar-show");

function setNavCollapsed(on) {
  document.documentElement.classList.toggle("nav-collapsed", on);
  try { localStorage.setItem(COLLAPSE_KEY, on ? "1" : "0"); } catch {}
  if (collapseBtn) collapseBtn.setAttribute("aria-expanded", String(!on));
}

if (collapseBtn) collapseBtn.addEventListener("click", () => setNavCollapsed(true));
if (showBtn) showBtn.addEventListener("click", () => setNavCollapsed(false));
setNavCollapsed(document.documentElement.classList.contains("nav-collapsed"));

window.addEventListener("hashchange", route);

buildToc();
route();
