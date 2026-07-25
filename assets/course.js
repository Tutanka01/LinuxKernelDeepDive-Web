/* ============================================================
   Guided-course engine — shared by Distributed Systems and
   Inference Engineering.

   The two courses were a fork of each other: ~165 lines of
   difference in ~660, most of it the chapter list, and every
   behaviour fixed in one had to be remembered in the other.
   They are now one engine driven by two data files.

   The per-course file (distributed/assets/ds.js,
   inference/assets/inf.js) is loaded first and defines:

     COURSE       the module → chapter tree
     COURSE_META  storeKey, scrollKey, name, homeTitle, heroTitle,
                  heroLede, timeEstimate, servePath, footer

   Chapters are plain .md under the course's content/, fetched and
   rendered client-side with marked + highlight.js. No build step.
   ============================================================ */

const FLAT = COURSE.flatMap(m =>
  m.chapters.map(ch => ({ ...ch, level: m.level, levelLabel: m.levelLabel, module: m.module }))
);

/* ---------------- progress (localStorage) ---------------- */

const STORE_KEY = COURSE_META.storeKey;

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

/* Where "Continue" should go: the first unfinished chapter at or after the
   one last opened — so finishing 1–3 and then reading 10 does not offer to
   "continue" at 4. p.last is what setLastVisited has always recorded and
   nothing ever read. Falls back to the first gap anywhere, then chapter one. */
function nextUnread() {
  const p = loadProgress();
  const start = Math.max(0, FLAT.findIndex(ch => ch.slug === p.last));
  return FLAT.slice(start).find(ch => !p.completed[ch.slug])
      || FLAT.find(ch => !p.completed[ch.slug])
      || FLAT[0];
}

/* ---------------- DOM handles ---------------- */

const tocEl      = document.getElementById("toc");
const viewEl     = document.getElementById("view");
const sidebarEl  = document.getElementById("sidebar");
const toggleEl   = document.getElementById("sidebar-toggle");
const progressEl = document.getElementById("progress-bar");
const scrimEl    = document.getElementById("sidebar-scrim");
const pageTocEl  = document.getElementById("page-toc");

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

/* ---------------- scroll memory: keep your place across reloads ---------------- */

const SCROLL_KEY = COURSE_META.scrollKey;
/* "@" can never appear in a slug — it is the chapter/anchor separator */
const HOME_KEY   = "@home";

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

let booted = false;              // the first route() is a page (re)load, not a nav
let scrollSaveTimer = null;

function scrollMap() {
  try { return JSON.parse(sessionStorage.getItem(SCROLL_KEY) || "{}"); }
  catch { return {}; }
}
function rememberScroll(key) {
  if (!key) return;
  const map = scrollMap();
  map[key] = Math.max(0, Math.round(window.scrollY));
  try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(map)); } catch {}
}
function queueRememberScroll() {
  if (scrollSaveTimer) return;
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    rememberScroll(scrollKey());
  }, 250);
}

/* Restore a saved position, re-pinning it while late content (syntax
   highlighting, images) reflows the page — but bailing out the instant the
   reader scrolls, so we never fight them. */
function restoreScroll(key) {
  const y = scrollMap()[key] || 0;
  if (y <= 4) return;
  let cancelled = false;
  const stop = () => { cancelled = true; };
  ["wheel", "touchstart", "keydown", "mousedown"].forEach(evt =>
    window.addEventListener(evt, stop, { once: true, passive: true }));
  let frames = 0;
  const pin = () => {
    if (cancelled) return;
    window.scrollTo({ top: y, behavior: "instant" });
    if (++frames < 40) requestAnimationFrame(pin);   // ~0.6s reflow guard
  };
  window.scrollTo({ top: y, behavior: "instant" });
  requestAnimationFrame(pin);
}

/* persist the position before the tab is hidden or reloaded */
window.addEventListener("pagehide", () => rememberScroll(scrollKey()));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberScroll(scrollKey());
});

/* ---------------- auto-hiding outline bar (tablet / phone) ----------------
   Slides the sticky toggle out of the way on a sustained scroll down and
   brings it straight back on any upward move. An accumulator (reset when the
   direction flips) absorbs momentum jitter without dulling the response. */

let toggleLastY = 0;
let toggleAcc   = 0;

function updateToggleBar() {
  const y = Math.max(0, window.scrollY);
  const delta = y - toggleLastY;
  toggleLastY = y;

  /* always visible near the top or while the drawer is open */
  if (y < 64 || sidebarEl.classList.contains("open")) {
    toggleAcc = 0;
    toggleEl.classList.remove("hide");
    return;
  }
  /* a change of direction starts the count fresh */
  if ((delta > 0 && toggleAcc < 0) || (delta < 0 && toggleAcc > 0)) toggleAcc = 0;
  toggleAcc += delta;

  if (toggleAcc > 48) { toggleEl.classList.add("hide"); toggleAcc = 48; }
  else if (toggleAcc < -24) { toggleEl.classList.remove("hide"); toggleAcc = -24; }
}

window.addEventListener("scroll", () => {
  const h = document.documentElement.scrollHeight - window.innerHeight;
  progressEl.style.width = h > 0 ? (scrollY / h) * 100 + "%" : "0%";
  updatePageTocSpy();
  updateToggleBar();
  queueRememberScroll();
}, { passive: true });

/* ---------------- reading time ---------------- */

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
  const el = document.getElementById("progress-summary");
  if (el) {
    const done = completedCount();
    const pct = Math.round((done / FLAT.length) * 100);
    el.innerHTML =
      `<span class="progress-count">${done} / ${FLAT.length} chapters complete</span>` +
      `<span class="progress-track"><span class="progress-fill" style="width:${pct}%"></span></span>`;
  }
}

function markActive(slug) {
  tocEl.querySelectorAll("a").forEach(a => {
    a.classList.toggle("active", a.dataset.slug === slug);
  });
  const active = tocEl.querySelector("a.active");
  if (active && sidebarEl.scrollHeight > sidebarEl.clientHeight) {
    active.scrollIntoView({ block: "nearest" });
  }
}

/* ---------------- heading anchors & the "on this page" rail ---------------- */

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 64);
}

/* Only direct children of the article body: a quiz's own heading is nested
   inside .quiz and has no business in the chapter outline. */
function bodyHeadings() {
  const body = viewEl.querySelector(".article-body");
  return body ? [...body.querySelectorAll(":scope > h2, :scope > h3, :scope > h4")] : [];
}

function decorateHeadings(slug) {
  const used = new Set();
  bodyHeadings().forEach(h => {
    let id = slugify(h.textContent);
    while (used.has(id)) id += "-x";
    used.add(id);
    h.id = id;
    const a = document.createElement("a");
    a.className = "hlink";
    a.href = `#/${slug}@${id}`;
    a.textContent = "¶";
    a.setAttribute("aria-label", "Link to this section");
    h.appendChild(a);
  });
}

function buildPageToc(slug) {
  if (!pageTocEl) return;
  const heads = bodyHeadings().filter(h => h.tagName !== "H4");
  if (heads.length < 3) { pageTocEl.innerHTML = ""; return; }
  pageTocEl.innerHTML =
    `<p class="page-toc-title">On this page</p><ul>` +
    heads.map(h => {
      const text = h.textContent.replace(/¶$/, "");
      return `<li class="lvl-${h.tagName === "H2" ? 2 : 3}">` +
             `<a href="#/${slug}@${h.id}" data-target="${h.id}">${text}</a></li>`;
    }).join("") + `</ul>`;
}

function updatePageTocSpy() {
  if (!pageTocEl || !pageTocEl.firstChild) return;
  let active = null;
  for (const h of bodyHeadings()) {
    if (h.tagName === "H4") continue;
    if (h.getBoundingClientRect().top <= 90) active = h.id; else break;
  }
  pageTocEl.querySelectorAll("a").forEach(a => {
    a.classList.toggle("active", a.dataset.target === active);
  });
}

/* wrap wide tables so they scroll on their own instead of blowing out the
   page width on phones and tablets */
function wrapTables() {
  viewEl.querySelectorAll(".article-body table").forEach(t => {
    if (t.parentElement && t.parentElement.classList.contains("table-scroll")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-scroll";
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });
}

function scrollToAnchor(anchor) {
  const el = document.getElementById(anchor);
  if (el) {
    const y = el.getBoundingClientRect().top + window.scrollY - 24;
    window.scrollTo({ top: y, behavior: "instant" });
  }
}

/* ---------------- home / course map ---------------- */

function renderHome() {
  markActive(null);
  lastSlug = null;                     // the home view replaces the chapter markup
  document.title = COURSE_META.homeTitle;
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
          <h1>${COURSE_META.heroTitle}</h1>
          <p class="hero-lede">${COURSE_META.heroLede}</p>
          <div class="hero-actions">
            <a class="btn-primary" href="#/${next.slug}">
              ${started ? "Continue — " + next.title : "Start the course"}
            </a>
            ${started
              ? `<span class="hero-hint">${done} of ${FLAT.length} chapters complete</span>`
              : `<span class="hero-hint">~${COURSE_META.timeEstimate} of reading, at your pace</span>`}
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
        builds on the previous one. Every chapter ends with a short quiz — pass it and
        the chapter is marked complete. (The Linux Deep Dive in the sidebar works
        differently: there a chapter ticks itself off when you reach the end of it.)</p>

      ${modules}
    </div>
    <footer class="page-footer">
      <p>Part of <a href="../">The Linux Deep Dive</a> — but a journey of its own.</p>
    </footer>`;

  if (pageTocEl) pageTocEl.innerHTML = "";
  if (!booted) restoreScroll(HOME_KEY);                    // reload: keep your place
  else window.scrollTo({ top: 0, behavior: "instant" });
  booted = true;
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

const mdCache = {};
let lastSlug = null;

async function fetchChapter(slug) {
  if (mdCache[slug]) return mdCache[slug];
  const res = await fetch(`content/${slug}.md`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  mdCache[slug] = await res.text();
  return mdCache[slug];
}

async function renderChapter(slug, anchor) {
  markActive(slug);

  if (slug === lastSlug) {              // in-page anchor jump only
    if (anchor) scrollToAnchor(anchor);
    return;
  }

  const i = FLAT.findIndex(ch => ch.slug === slug);
  const ch = FLAT[i], prev = FLAT[i - 1], next = FLAT[i + 1];

  let md;
  try {
    md = await fetchChapter(slug);
  } catch (err) {
    lastSlug = null;                    // …so re-selecting this chapter retries
    renderLoadError(slug, anchor, err);
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
      <p>${COURSE_META.footer}</p>
    </footer>`;

  viewEl.querySelectorAll(".article-body pre code").forEach(el => {
    if (!el.classList.contains("language-quiz")) hljs.highlightElement(el);
  });
  renderQuizzes(slug);
  decorateHeadings(slug);
  wrapTables();
  buildPageToc(slug);

  const btn = viewEl.querySelector(".complete-toggle");
  syncCompleteButton(btn, slug);
  btn.addEventListener("click", () => {
    const saved = setComplete(slug, !isComplete(slug));
    syncCompleteButton(btn, slug);
    const warn = viewEl.querySelector(".save-warning");
    if (warn) warn.hidden = saved;
  });

  document.title = `${ch.title} — ${COURSE_META.name}`;
  lastSlug = slug;                      // only a chapter that actually rendered counts
  setLastVisited(slug);                 // anchors "Continue" on the home page

  if (anchor) scrollToAnchor(anchor);
  else if (!booted) restoreScroll(slug);                   // reload: keep your place
  else window.scrollTo({ top: 0, behavior: "instant" });   // new chapter: start at top
  booted = true;
}

function renderLoadError(slug, anchor, err) {
  viewEl.innerHTML =
    `<article class="article"><h1>Couldn't load this chapter</h1>
     <p>Failed to fetch <code>content/${slug}.md</code> (${err.message}).</p>
     <p class="error-actions">
       <button id="retry-load" class="btn-primary" type="button">Try again</button>
       <a class="error-home" href="#/">Course home</a>
     </p>
     <p>If you opened this file directly from disk, serve the folder instead:</p>
     <pre><code>cd LinuxKernelDeepDive-Web
python3 -m http.server 8000</code></pre>
     <p>…then visit <a href="http://localhost:8000${COURSE_META.servePath}">http://localhost:8000${COURSE_META.servePath}</a>.</p></article>`;
  document.getElementById("retry-load")
    .addEventListener("click", () => renderChapter(slug, anchor));
  if (pageTocEl) pageTocEl.innerHTML = "";
}

/* ---------------- routing ---------------- */

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, "").trim();
  const [slug, anchor] = hash.split("@");
  if (slug && FLAT.some(ch => ch.slug === slug)) return { kind: "chapter", slug, anchor };
  return { kind: "home" };
}

/* the slug being read, or null on the course home */
function currentSlug() {
  const r = currentRoute();
  return r.kind === "chapter" ? r.slug : null;
}

function scrollKey() {
  return currentSlug() || HOME_KEY;
}

function setSidebar(open) {
  sidebarEl.classList.toggle("open", open);
  document.body.classList.toggle("nav-open", open);
  toggleEl.setAttribute("aria-expanded", String(open));
}

function route() {
  const r = currentRoute();
  if (r.kind === "home") renderHome();
  else renderChapter(r.slug, r.anchor);
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
  searchList.innerHTML = indexingHint();
  const docs = await Promise.all(FLAT.map(async ch => {
    try {
      const text = (await fetchChapter(ch.slug))
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

function indexingHint() {
  return `<li class="search-hint">Indexing chapters…</li>`;
}

function searchQuery(q) {
  if (!searchIndex) return [];          // still indexing — nothing to match yet
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
  if (!searchIndex) {                    // index still building: never claim "no results"
    searchList.innerHTML = indexingHint();
    return;
  }
  if (!q.trim()) {
    searchList.innerHTML = `<li class="search-hint">Type to search all ${FLAT.length} chapters of this course.</li>`;
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
  renderSearchResults("");
  await buildSearchIndex();
  renderSearchResults(searchInput.value);   // honour anything typed while indexing
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
  }
});

searchModal.addEventListener("click", e => {
  if (e.target === searchModal) closeSearch();
});
document.getElementById("search-open").addEventListener("click", openSearch);

/* ---------------- keyboard navigation ---------------- */

document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  /* Escape closes the modal from anywhere inside it, not only from the input —
     one click on the results padding used to make the advertised key dead */
  if (e.key === "Escape" && searchModal.classList.contains("open")) {
    e.preventDefault();
    closeSearch();
    return;
  }
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
setNavCollapsed(document.documentElement.classList.contains("nav-collapsed"));  // sync aria with pre-paint state

window.addEventListener("hashchange", route);

buildToc();
route();
