/* ============================================================
   The Linux Deep Dive — tiny markdown book engine, v2.
   No build step: chapters live in /content as plain .md files,
   fetched and rendered client-side with marked + highlight.js.

   v2 adds: frontmatter metadata (level / kernel / minutes /
   requires), heading anchors + deep links (#/slug@heading),
   an "on this page" rail, full-text search (lazy index),
   reading progress in localStorage, Mermaid diagrams, and
   keyboard navigation (←/→, / to search).
   ============================================================ */

const BOOK = [
  {
    part: "Start Here",
    chapters: [
      { slug: "start-here",           title: "How to Use This Book: Paths & Prerequisites" },
    ],
  },
  {
    part: "Part I — Foundations",
    chapters: [
      { slug: "what-is-linux",        title: "What Is Linux, Really?" },
      { slug: "boot-process",         title: "From Power Button to Login" },
      { slug: "kernel-vs-userspace",  title: "Kernel, User Space & Syscalls" },
    ],
  },
  {
    part: "Part II — Core Kernel Subsystems",
    chapters: [
      { slug: "processes",            title: "Processes & Threads" },
      { slug: "scheduling",           title: "CPU Scheduling" },
      { slug: "memory",               title: "Virtual Memory" },
      { slug: "interrupts",           title: "Interrupts, Exceptions & Softirqs" },
      { slug: "timers",               title: "Timers & Time: jiffies, hrtimers & Tickless" },
      { slug: "filesystems",          title: "Files, Filesystems & the VFS" },
      { slug: "storage-stack",        title: "The Linux Storage Stack" },
      { slug: "devices-modules",      title: "Devices, Drivers & Modules" },
      { slug: "networking",           title: "The Networking Stack" },
      { slug: "tcp-congestion",       title: "TCP Congestion Control & Tuning" },
    ],
  },
  {
    part: "Part III — IPC, Signals & Pipes",
    chapters: [
      { slug: "signals",              title: "Signals: The Kernel's Asynchronous Notifications" },
      { slug: "ipc-pipes",            title: "Pipes, FIFOs & Unix Sockets" },
    ],
  },
  {
    part: "Part IV — Containers, From Scratch",
    chapters: [
      { slug: "containers-overview",  title: "What a Container Actually Is" },
      { slug: "namespaces",           title: "Namespaces" },
      { slug: "cgroups",              title: "Control Groups (cgroup v2)" },
      { slug: "overlayfs",            title: "Images & OverlayFS" },
      { slug: "build-a-container",    title: "Build a Container by Hand" },
      { slug: "container-runtimes",   title: "Docker, containerd, runc" },
      { slug: "container-networking", title: "Container Networking" },
    ],
  },
  {
    part: "Part V — Checkpoint/Restore",
    chapters: [
      { slug: "process-state",        title: "The Anatomy of Process State" },
      { slug: "criu-dump",            title: "CRIU: Dumping a Live Process" },
      { slug: "criu-restore",         title: "CRIU: The Restore" },
      { slug: "live-migration",       title: "Live Migration: Iterative, Lazy & TCP Repair" },
      { slug: "snapshot-taxonomy",    title: "The Snapshot Taxonomy: CRIU, gVisor & microVMs" },
      { slug: "gpu-checkpoint",       title: "GPU Checkpointing: cuda-checkpoint & CRIU Plugins" },
    ],
  },
  {
    part: "Part VI — Hardware & Platform",
    chapters: [
      { slug: "power-management",     title: "Power Management: Governors, C-States & ACPI" },
      { slug: "numa-deep-dive",       title: "NUMA Deep Dive" },
      { slug: "cpu-isolation",        title: "CPU Isolation, NO_HZ & Real-Time" },
      { slug: "cpu-mitigations",      title: "CPU Vulnerability Mitigations" },
    ],
  },
  {
    part: "Part VII — Modern Kernel",
    chapters: [
      { slug: "ebpf-internals",       title: "eBPF Internals" },
      { slug: "security-hardening",   title: "Linux Security & Confinement" },
      { slug: "trusted-computing",    title: "Trusted Computing: Secure Boot, TPM & IMA" },
      { slug: "modern-io",            title: "Modern I/O & io_uring" },
      { slug: "rust-kernel",          title: "Rust in the Linux Kernel" },
    ],
  },
  {
    part: "Part VIII — Virtualization",
    chapters: [
      { slug: "kvm-internals",        title: "KVM & Virtualization Internals" },
    ],
  },
  {
    part: "Part IX — Kernel Engineering",
    chapters: [
      { slug: "kernel-sync",          title: "Kernel Synchronization: Locks, Atomics & RCU" },
      { slug: "kernel-governance",    title: "How the Kernel Is Made: Process & Governance" },
      { slug: "observability",        title: "/proc, strace, perf & eBPF" },
      { slug: "perf-methodology",     title: "Performance Analysis Methodology" },
    ],
  },
  {
    part: "Part X — Tools & Going Deeper",
    chapters: [
      { slug: "kernel-dev",           title: "Reading & Building the Kernel" },
    ],
  },
  {
    part: "Part XI — Hands-On Labs",
    chapters: [
      { slug: "lab-oom-killer",       title: "Lab: Trigger & Autopsy the OOM Killer" },
      { slug: "lab-page-cache",       title: "Lab: Watch the Page Cache Work" },
      { slug: "lab-cgroup-limits",    title: "Lab: Throttle a Process with cgroup v2" },
      { slug: "lab-kernel-module",    title: "Lab: Write, Build & Load a Kernel Module" },
      { slug: "lab-criu",             title: "Lab: Checkpoint & Restore a Real Process" },
      { slug: "lab-userfaultfd",      title: "Lab: Serve Page Faults from Userspace" },
    ],
  },
  {
    part: "Reference",
    chapters: [
      { slug: "glossary",             title: "Glossary" },
    ],
  },
];

/* flat ordered list used for routing and prev/next */
const FLAT = BOOK.flatMap(p => p.chapters);
const HOME_SLUG = FLAT[0].slug;
const TITLE_OF = Object.fromEntries(FLAT.map(ch => [ch.slug, ch.title]));

const LEVEL_LABEL = {
  core:      "fundamentals",
  mechanism: "mechanism",
  internals: "internals",
};

const tocEl      = document.getElementById("toc");
const articleEl  = document.getElementById("article");
const pagerEl    = document.getElementById("pager");
const sidebarEl  = document.getElementById("sidebar");
const toggleEl   = document.getElementById("sidebar-toggle");
const progressEl = document.getElementById("progress-bar");
const pageTocEl  = document.getElementById("page-toc");

/* ---------------- theme: terminal (dark) / paper (light) ---------------- */

const THEME_KEY   = "ldd-theme";
const hljsThemeEl = document.getElementById("hljs-theme");

const HLJS_THEME_HREF = {
  dark:  "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-dark-medium.min.css",
  paper: "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-light-medium.min.css",
};

const MERMAID_THEME = {
  dark: {
    startOnLoad: false,
    theme: "dark",
    themeVariables: {
      background: "#1a1714",
      primaryColor: "#262019",
      primaryTextColor: "#d4cbb7",
      primaryBorderColor: "#a4783f",
      lineColor: "#978d7c",
      fontFamily: "SF Mono, Menlo, monospace",
      fontSize: "14px",
    },
  },
  paper: {
    startOnLoad: false,
    theme: "neutral",
    themeVariables: {
      background: "#f6f1e6",
      primaryColor: "#efe8d7",
      primaryTextColor: "#383022",
      primaryBorderColor: "#8f5d1a",
      lineColor: "#6b6250",
      fontFamily: "SF Mono, Menlo, monospace",
      fontSize: "14px",
    },
  },
};

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === "paper" ? "paper" : "dark"; }
  catch { return "dark"; }
}

function applyTheme(theme, rerenderDiagrams = false) {
  if (theme === "paper") document.documentElement.setAttribute("data-theme", "paper");
  else document.documentElement.removeAttribute("data-theme");
  if (hljsThemeEl) hljsThemeEl.href = HLJS_THEME_HREF[theme];
  document.querySelectorAll(".theme-btn").forEach(b => {
    const on = b.dataset.themeValue === theme;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  if (typeof mermaid !== "undefined") {
    mermaid.initialize(MERMAID_THEME[theme]);
    if (rerenderDiagrams) rerenderMermaid();
  }
}

function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("theme-switching");
    setTimeout(() => document.documentElement.classList.remove("theme-switching"), 300);
  }
  applyTheme(theme, true);
}

/* ---------------- reading progress (localStorage) ---------------- */

const READ_KEY = "ldd-read";

function readSet() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveReadSet(set) {
  localStorage.setItem(READ_KEY, JSON.stringify([...set]));
}
function markRead(slug, on = true) {
  const set = readSet();
  if (on) set.add(slug); else set.delete(slug);
  saveReadSet(set);
  refreshReadMarks();
  refreshReadButton(slug);
}

function refreshReadMarks() {
  const set = readSet();
  tocEl.querySelectorAll("a[data-slug]").forEach(a => {
    a.classList.toggle("read", set.has(a.dataset.slug));
  });
  const done = FLAT.filter(ch => set.has(ch.slug)).length;
  const el = document.getElementById("progress-summary");
  if (el) {
    const pct = Math.round((done / FLAT.length) * 100);
    el.innerHTML =
      `<span class="progress-count">${done} / ${FLAT.length} chapters read</span>` +
      `<span class="progress-track"><span class="progress-fill" style="width:${pct}%"></span></span>`;
  }
}

function refreshReadButton(slug) {
  const btn = document.getElementById("mark-read-btn");
  if (!btn) return;
  const isRead = readSet().has(slug);
  btn.textContent = isRead ? "✓ read" : "mark as read";
  btn.classList.toggle("is-read", isRead);
}

/* ---------------- scroll memory: keep your place across reloads ---------------- */

const SCROLL_KEY = "ldd-scroll";
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

let booted = false;              // the first route() is a page (re)load, not a nav
let scrollSaveTimer = null;

function scrollMap() {
  try { return JSON.parse(sessionStorage.getItem(SCROLL_KEY) || "{}"); }
  catch { return {}; }
}
function rememberScroll(slug) {
  if (!slug) return;
  const map = scrollMap();
  map[slug] = Math.max(0, Math.round(window.scrollY));
  try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(map)); } catch {}
}
function queueRememberScroll() {
  if (scrollSaveTimer) return;
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    rememberScroll(currentSlug());
  }, 250);
}

/* Restore a saved position, re-pinning it while late content (Mermaid diagrams,
   syntax highlighting, images) reflows the page — but bailing out the instant
   the reader scrolls, so we never fight them. */
function restoreScroll(slug) {
  const y = scrollMap()[slug] || 0;
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
window.addEventListener("pagehide", () => rememberScroll(currentSlug()));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberScroll(currentSlug());
});

/* ---------------- auto-hiding "Contents" bar (tablet / phone) ----------------
   Slides the sticky toggle out of the way on a sustained scroll down and brings
   it straight back on any upward move. An accumulator (reset when the direction
   flips) absorbs momentum jitter without dulling the response. */

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

  if (toggleAcc > 48) { toggleEl.classList.add("hide"); toggleAcc = 48; }         // scrolled down enough → hide
  else if (toggleAcc < -24) { toggleEl.classList.remove("hide"); toggleAcc = -24; } // nudged up → reveal
}

/* auto-mark a chapter read when the reader reaches the end */
let autoReadArmed = false;
window.addEventListener("scroll", () => {
  const h = document.documentElement.scrollHeight - window.innerHeight;
  progressEl.style.width = h > 0 ? (scrollY / h) * 100 + "%" : "0%";
  if (autoReadArmed && h > 400 && scrollY > h - 120) {
    autoReadArmed = false;
    markRead(currentSlug());
  }
  updatePageTocSpy();
  updateToggleBar();
  queueRememberScroll();
}, { passive: true });

/* ---------------- frontmatter ---------------- */

function parseFrontmatter(md) {
  const meta = {};
  if (!md.startsWith("---")) return { meta, body: md };
  const end = md.indexOf("\n---", 3);
  if (end === -1) return { meta, body: md };
  md.slice(3, end).split("\n").forEach(line => {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return { meta, body: md.slice(end + 4).replace(/^\s*\n/, "") };
}

function metaBannerHtml(meta, slug) {
  const bits = [];
  if (meta.level && LEVEL_LABEL[meta.level]) {
    bits.push(`<span class="meta-level level-${meta.level}">${LEVEL_LABEL[meta.level]}</span>`);
  }
  if (meta.minutes) bits.push(`<span class="meta-item">~${meta.minutes} min</span>`);
  if (meta.kernel)  bits.push(`<span class="meta-item">verified on kernel ${meta.kernel}${meta.verified ? " · " + meta.verified : ""}</span>`);
  bits.push(`<button id="mark-read-btn" class="meta-read-btn" type="button"></button>`);

  let prereqs = "";
  const reqs = (meta.requires || "").split(",").map(s => s.trim()).filter(s => TITLE_OF[s]);
  if (reqs.length) {
    prereqs = `<p class="meta-prereqs">Before this chapter: ` +
      reqs.map(s => `<a href="#/${s}">${TITLE_OF[s]}</a>`).join(" · ") + `</p>`;
  }
  return `<div class="chapter-meta">${bits.join("")}</div>${prereqs}`;
}

/* ---------------- markdown rendering ---------------- */

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 64);
}

/* add ids + ¶ anchors to headings, post-render (marked-version-proof) */
function decorateHeadings(slug) {
  const used = new Set();
  articleEl.querySelectorAll("h2, h3, h4").forEach(h => {
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

/* wrap wide tables so they scroll on their own instead of blowing out the
   page width on phones and tablets */
function wrapTables() {
  articleEl.querySelectorAll("table").forEach(t => {
    if (t.parentElement && t.parentElement.classList.contains("table-scroll")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-scroll";
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });
}

function renderMermaid() {
  const blocks = articleEl.querySelectorAll("pre code.language-mermaid");
  if (!blocks.length || typeof mermaid === "undefined") return;
  blocks.forEach(code => {
    const holder = document.createElement("pre");
    holder.className = "mermaid";
    holder.dataset.src = code.textContent;   // kept for theme re-renders
    holder.textContent = code.textContent;
    code.closest("pre").replaceWith(holder);
  });
  mermaid.run({ nodes: articleEl.querySelectorAll("pre.mermaid") });
}

/* re-render diagrams after a theme change (colours are baked into the SVG) */
function rerenderMermaid() {
  const blocks = articleEl.querySelectorAll("pre.mermaid");
  if (!blocks.length || typeof mermaid === "undefined") return;
  blocks.forEach(p => {
    if (!p.dataset.src) return;
    p.removeAttribute("data-processed");
    p.textContent = p.dataset.src;
  });
  mermaid.run({ nodes: blocks });
}

function buildPageToc() {
  if (!pageTocEl) return;
  const heads = [...articleEl.querySelectorAll("h2, h3")];
  if (heads.length < 3) { pageTocEl.innerHTML = ""; return; }
  const slug = currentSlug();
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
  const heads = [...articleEl.querySelectorAll("h2, h3")];
  let active = null;
  for (const h of heads) {
    if (h.getBoundingClientRect().top <= 90) active = h.id; else break;
  }
  pageTocEl.querySelectorAll("a").forEach(a => {
    a.classList.toggle("active", a.dataset.target === active);
  });
}

/* ---------------- navigation & routing ---------------- */

function buildToc() {
  let n = 0;
  tocEl.innerHTML = BOOK.map(part => {
    const items = part.chapters.map(ch => {
      n += 1;
      return `<li><a href="#/${ch.slug}" data-slug="${ch.slug}">` +
             `<span class="toc-num">${n}</span><span class="toc-title">${ch.title}</span>` +
             `<span class="toc-check" aria-hidden="true">✓</span></a></li>`;
    }).join("");
    return `<p class="toc-part">${part.part}</p><ul class="toc-list">${items}</ul>`;
  }).join("");
  refreshReadMarks();
}

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, "").trim();
  const [slug, anchor] = hash.split("@");
  return { slug, anchor };
}

function currentSlug() {
  const { slug } = parseHash();
  return FLAT.some(ch => ch.slug === slug) ? slug : HOME_SLUG;
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

function renderPager(slug) {
  const i = FLAT.findIndex(ch => ch.slug === slug);
  const prev = FLAT[i - 1];
  const next = FLAT[i + 1];
  pagerEl.innerHTML =
    (prev ? `<a class="prev" href="#/${prev.slug}">` +
            `<span class="pager-label">&larr; previous</span>` +
            `<span class="pager-title">${prev.title}</span></a>` : "<span></span>") +
    (next ? `<a class="next" href="#/${next.slug}">` +
            `<span class="pager-label">next &rarr;</span>` +
            `<span class="pager-title">${next.title}</span></a>` : "<span></span>");
}

let lastSlug = null;

async function loadChapter(slug, anchor) {
  markActive(slug);
  const sameChapter = slug === lastSlug;
  lastSlug = slug;

  if (sameChapter) {                       // in-page anchor jump only
    if (anchor) scrollToAnchor(anchor);
    return;
  }

  try {
    const res = await fetch(`content/${slug}.md`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { meta, body } = parseFrontmatter(await res.text());

    articleEl.classList.remove("fade-in");
    articleEl.innerHTML = marked.parse(body);

    /* insert the meta banner right after the H1 */
    const h1 = articleEl.querySelector("h1");
    if (h1 && (meta.level || meta.minutes || meta.kernel || meta.requires)) {
      h1.insertAdjacentHTML("afterend", metaBannerHtml(meta, slug));
      const btn = document.getElementById("mark-read-btn");
      btn.addEventListener("click", () => markRead(slug, !readSet().has(slug)));
      refreshReadButton(slug);
    }

    void articleEl.offsetWidth;
    articleEl.classList.add("fade-in");
    articleEl.querySelectorAll("pre code").forEach(el => {
      if (!el.classList.contains("language-mermaid")) hljs.highlightElement(el);
    });
    decorateHeadings(slug);
    wrapTables();
    renderMermaid();
    buildPageToc();
    renderPager(slug);

    if (anchor) scrollToAnchor(anchor);
    else if (!booted) restoreScroll(slug);                   // reload: keep your place
    else window.scrollTo({ top: 0, behavior: "instant" });   // new chapter: start at top
    booted = true;

    autoReadArmed = true;
    document.title = `${TITLE_OF[slug]} — The Linux Deep Dive`;
  } catch (err) {
    articleEl.innerHTML =
      `<h1>Couldn't load this page</h1>
       <p>Failed to fetch <code>content/${slug}.md</code> (${err.message}).</p>
       <p>If you opened <code>index.html</code> directly from disk, the browser
       blocks local <code>fetch()</code> calls. Serve the folder instead:</p>
       <pre><code>cd LinuxKernelDeepDive-Web
python3 -m http.server 8000</code></pre>
       <p>…then visit <a href="http://localhost:8000">http://localhost:8000</a>.</p>`;
  }
}

function scrollToAnchor(anchor) {
  const el = document.getElementById(anchor);
  if (el) {
    const y = el.getBoundingClientRect().top + window.scrollY - 24;
    window.scrollTo({ top: y });
  }
}

/* ---------------- mobile / tablet nav drawer ---------------- */

const scrimEl = document.getElementById("sidebar-scrim");

function setSidebar(open) {
  sidebarEl.classList.toggle("open", open);
  document.body.classList.toggle("nav-open", open);
  toggleEl.setAttribute("aria-expanded", String(open));
}

function route() {
  const { anchor } = parseHash();
  loadChapter(currentSlug(), anchor);
  setSidebar(false);
}

/* ---------------- full-text search ---------------- */

const searchModal  = document.getElementById("search-modal");
const searchInput  = document.getElementById("search-input");
const searchList   = document.getElementById("search-results");
let searchIndex    = null;   // [{slug, title, text, lower}]
let searchSel      = 0;

async function buildSearchIndex() {
  if (searchIndex) return searchIndex;
  searchList.innerHTML = `<li class="search-hint">Indexing chapters…</li>`;
  const docs = await Promise.all(FLAT.map(async ch => {
    try {
      const res = await fetch(`content/${ch.slug}.md`, { cache: "no-cache" });
      const { body } = parseFrontmatter(await res.text());
      const text = body
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
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (!terms.length) return [];
  const results = [];
  for (const doc of searchIndex) {
    let score = 0, firstHit = -1;
    for (const t of terms) {
      let hits = 0, i = doc.lower.indexOf(t);
      if (i === -1) { score = 0; break; }
      if (firstHit === -1 || i < firstHit) firstHit = i;
      while (i !== -1 && hits < 50) { hits++; i = doc.lower.indexOf(t, i + t.length); }
      score += hits;
      if (doc.title.toLowerCase().includes(t)) score += 25;
    }
    if (score > 0) results.push({ doc, score, firstHit });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 12);
}

function snippet(doc, firstHit, terms) {
  const start = Math.max(0, firstHit - 60);
  let s = doc.text.slice(start, start + 170);
  if (start > 0) s = "…" + s;
  s += "…";
  for (const t of terms) {
    s = s.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
  }
  return s;
}

function renderSearchResults(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
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
  searchList.innerHTML = results.map((r, i) =>
    `<li class="search-result${i === 0 ? " selected" : ""}" data-slug="${r.doc.slug}">
       <span class="sr-title">${r.doc.title}</span>
       <span class="sr-snippet">${snippet(r.doc, r.firstHit, terms)}</span>
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
  renderSearchResults("");
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
  /* [ toggles the sidebar on wide screens */
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
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const i = FLAT.findIndex(ch => ch.slug === currentSlug());
    const target = FLAT[i + (e.key === "ArrowRight" ? 1 : -1)];
    if (target) location.hash = `#/${target.slug}`;
  }
});

/* ---------------- boot ---------------- */

document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeValue));
});
applyTheme(currentTheme());

toggleEl.setAttribute("aria-expanded", "false");
toggleEl.addEventListener("click", () => setSidebar(!sidebarEl.classList.contains("open")));
if (scrimEl) scrimEl.addEventListener("click", () => setSidebar(false));

/* collapsible sidebar on wide screens (desktop & tablet-landscape) */
const COLLAPSE_KEY = "ldd-nav-collapsed";
const collapseBtn  = document.getElementById("sidebar-collapse");
const showBtn      = document.getElementById("sidebar-show");

function setNavCollapsed(on) {
  document.documentElement.classList.toggle("nav-collapsed", on);
  try { localStorage.setItem(COLLAPSE_KEY, on ? "1" : "0"); } catch {}
  if (collapseBtn) collapseBtn.setAttribute("aria-expanded", String(!on));
}

if (collapseBtn) collapseBtn.addEventListener("click", () => setNavCollapsed(true));
if (showBtn)     showBtn.addEventListener("click", () => setNavCollapsed(false));
setNavCollapsed(document.documentElement.classList.contains("nav-collapsed"));  // sync aria with pre-paint state

window.addEventListener("hashchange", route);

buildToc();
route();
