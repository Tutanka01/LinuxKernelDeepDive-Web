/* The GPU–Kernel Track.
   =====================

   This page holds no course content — only an ordering of chapters that live
   in the three courses, grouped into phases, each closed by a deliverable.

   Two different kinds of progress meet here, and keeping them apart is the
   whole point of the page:

     - Chapters are ticked by the *courses*. All three keep their reading
       progress in localStorage on this same origin, so this page can read it
       without owning it: `ldd-read` is a JSON array of Linux slugs, while the
       two guided courses store `{ completed: { slug: true }, last }`. We never
       write those keys — a track is a view over the courses, not a second
       source of truth.
     - Deliverables are ticked *here*, by hand, under our own key. They are the
       part a reading tracker cannot infer, and the part that makes this a
       programme rather than a list.

   Link shapes, from this directory: `../#/slug` for Linux, and
   `../distributed/#/slug` / `../inference/#/slug` for the guided courses. Those
   are the same forms the chapters use to link across courses, which is why
   tests/tier1/links.test.js can resolve them.

   The page runs in the same shell as the three courses — rail, drawer, theme
   switch, search modal, progress bar — so the shell behaviours are wired here
   the way app.js and course.js wire them. They are not shared code: those two
   files each own a router, a chapter cache and a full-text index that this page
   has no use for. What *is* shared is the markup and the CSS, so a phase reads
   as a module of a course and a step as a chapter card, because that is what
   they are. */

"use strict";

/* ---------- where the courses keep their progress ---------- */

const COURSE_META = {
  linux:       { label: "The Linux Deep Dive", href: s => `../#/${s}` },
  distributed: { label: "Distributed Systems", href: s => `../distributed/#/${s}` },
  inference:   { label: "Inference Engineering", href: s => `../inference/#/${s}` },
};

const DELIVERABLE_KEY = "path-gpu-kernel-deliverables-v1";

/* Read-only views over the three courses' own storage. Every one of these is
   defensive: a reader with storage blocked gets a track with nothing ticked,
   which is correct, rather than a page that throws. */
function linuxRead() {
  try { return new Set(JSON.parse(localStorage.getItem("ldd-read") || "[]")); }
  catch { return new Set(); }
}
function guidedRead(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    return new Set(raw && raw.completed ? Object.keys(raw.completed) : []);
  } catch { return new Set(); }
}

function readSets() {
  return {
    linux:       linuxRead(),
    distributed: guidedRead("ds-course-progress-v1"),
    inference:   guidedRead("inf-course-progress-v1"),
  };
}

function doneDeliverables() {
  try { return new Set(JSON.parse(localStorage.getItem(DELIVERABLE_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveDeliverables(set) {
  try { localStorage.setItem(DELIVERABLE_KEY, JSON.stringify([...set])); }
  catch { /* storage blocked: the tick is a session-only affordance */ }
}

/* ---------- the track ---------- */

const PHASES = [
  {
    id: "read",
    n: 0,
    title: "Read without getting lost",
    months: "Months 1–2",
    thesis:
      "The barrier is reading C and kernel source, and it falls to repetition " +
      "rather than talent. Everything after this phase assumes you can open an " +
      "unfamiliar file and not drown. Nothing else in the track is worth " +
      "starting until that is true.",
    steps: [
      ["linux", "prereq-c",           "Just Enough C to Read the Kernel"],
      ["linux", "prereq-programs",    "From Source Code to Running Process"],
      ["linux", "prereq-tools",       "Reading the Evidence: man, /proc & Kernel Source"],
      ["linux", "kernel-vs-userspace","Kernel, User Space & Syscalls"],
      ["linux", "processes",          "Processes & Threads"],
      ["linux", "memory",             "Virtual Memory"],
    ],
    deliverable: {
      id: "d0",
      title: "Two annotated functions, a month apart",
      detail:
        "Annotate pipe_read line by line, as the C chapter's capstone asks. " +
        "Then, weeks later, do the same to a function you pick yourself out of " +
        "CRIU's source — no guide, no chapter holding your hand. The second " +
        "one is the deliverable; the first is practice for it.",
    },
  },
  {
    id: "state",
    n: 1,
    title: "The process as kernel state",
    months: "Months 2–4",
    thesis:
      "Before a GPU process can be checkpointed, an ordinary one has to be — " +
      "and you have to know, concretely, what a process is made of that can be " +
      "serialized at all. This phase is where CRIU stops being a tool you have " +
      "heard of and becomes a thing you can read.",
    steps: [
      ["linux", "process-state",     "The Anatomy of Process State"],
      ["linux", "criu-dump",         "CRIU: Dumping a Live Process"],
      ["linux", "criu-restore",      "CRIU: The Restore"],
      ["linux", "lab-criu",          "Lab: Checkpoint & Restore a Real Process"],
      ["linux", "live-migration",    "Live Migration: Iterative, Lazy & TCP Repair"],
      ["linux", "lab-userfaultfd",   "Lab: Serve Page Faults from Userspace"],
      ["linux", "snapshot-taxonomy", "The Snapshot Taxonomy: CRIU, gVisor & microVMs"],
    ],
    deliverable: {
      id: "d1",
      title: "A checkpoint you measured, not just performed",
      detail:
        "Dump time, total image size, pages-*.img size, restore time — on your " +
        "own machine, for a process whose working set you chose. Plus a CRIT " +
        "autopsy that says what is actually inside the images. This is the " +
        "baseline every later number on this track is compared against.",
    },
  },
  {
    id: "memory",
    n: 2,
    title: "The memory of the machine",
    months: "Months 4–6",
    thesis:
      "The hardest phase, and the one that does not exist anywhere else. " +
      "Everything the checkpoint story runs aground on is here: what an address " +
      "means once a device is involved, what a page is when it lives on an " +
      "accelerator, and what \"unified memory\" actually denotes — which is at " +
      "least three different arrangements people routinely conflate.",
    steps: [
      ["linux", "arm64-memory",          "Memory on arm64: Page Tables, ASIDs & Cache Maintenance"],
      ["linux", "dma-and-iommu",         "DMA, Coherence & the IOMMU"],
      ["linux", "devices-modules",       "Devices, Drivers & Modules"],
      ["linux", "gpu-drivers",           "The GPU Driver Under Linux: DRM, GEM & dma-buf"],
      ["linux", "hmm-and-mmu-notifiers", "Device Memory in the Kernel: HMM, MMU Notifiers & migrate_vma"],
      ["linux", "unified-memory",        "Unified & Coherent Memory: UVM, Grace-Blackwell & GB10"],
    ],
    deliverable: {
      id: "d2",
      title: "An annotated address space of a real CUDA process",
      detail:
        "Take /proc/<pid>/maps of a live CUDA process on your hardware and " +
        "explain every line: which are device mappings, which is the managed " +
        "reservation, what pagemap reports for each, and which of them CRIU " +
        "could serialize. Where you cannot answer, write down the question — " +
        "several of them have no published answer.",
    },
  },
  {
    id: "instrument",
    n: 3,
    title: "Instrumentation",
    months: "Months 6–8",
    thesis:
      "The daily production skill: being the person who answers \"here is what " +
      "is actually happening\" while everyone else speculates. Host side and " +
      "GPU side both, because the interesting failures live exactly at the " +
      "boundary between them, where neither community's tools look.",
    steps: [
      ["linux",     "observability",         "/proc, strace, perf & eBPF"],
      ["linux",     "ftrace",                "ftrace: The Kernel's Built-in Tracer"],
      ["linux",     "ebpf-internals",        "eBPF Internals"],
      ["linux",     "lab-ebpf",              "Lab: Answer a Real Question with eBPF"],
      ["linux",     "perf-methodology",      "Performance Analysis Methodology"],
      ["linux",     "gpu-memory-allocation", "Where VRAM Goes: Allocators, the VMM API & Engine Memory"],
      ["linux",     "gpu-observability",     "Instrumenting the GPU: NVML, DCGM, CUPTI & Nsight"],
      ["inference", "operating-it",          "Operating It"],
    ],
    deliverable: {
      id: "d3",
      title: "A profile of one VRAM release-and-reacquire cycle",
      detail:
        "End to end: what the framework's allocator did, what the driver saw at " +
        "the ioctl boundary, what nvidia-smi claimed, and where those three " +
        "accounts disagree. Built with your own eBPF tool from the lab, not " +
        "with a screenshot of a profiler.",
    },
  },
  {
    id: "frontier",
    n: 4,
    title: "The frontier",
    months: "Months 8–10",
    thesis:
      "Now the questions with no answers. Suspending, migrating and observing " +
      "GPU workloads is a nearly empty niche, and the chapters here are honest " +
      "about where the public record stops. This is the phase that produces " +
      "something nobody else has.",
    steps: [
      ["linux",       "gpu-checkpoint",         "GPU Checkpointing: cuda-checkpoint & CRIU Plugins"],
      ["linux",       "lab-gpu-checkpoint",     "Lab: Checkpoint a CUDA Process"],
      ["inference",   "anatomy-of-an-engine",   "Anatomy of a Serving Engine"],
      ["inference",   "paged-kv-cache",         "PagedAttention & Prefix Caching"],
      ["inference",   "the-kv-fabric",          "The KV Fabric"],
      ["inference",   "agentic-serving",        "The Agentic Era"],
      ["distributed", "the-network-is-hostile", "The Network Is Hostile"],
      ["distributed", "failure-models",         "Failure Models & Detection"],
    ],
    deliverable: {
      id: "d4",
      title: "The unified-memory results table, filled in and published",
      detail:
        "The lab's protocol, executed on unified-memory hardware, with the " +
        "results table completed — including the failures, with their exact " +
        "error text and driver version. As of 2026-07 not one cell of it has a " +
        "published value. This is the deliverable the whole track exists for.",
    },
  },
  {
    id: "patch",
    n: 5,
    title: "The patch",
    months: "Months 10–12",
    thesis:
      "The skill nobody lists as a skill. A measurement in a private notebook " +
      "changes nothing; the same measurement in a project the world uses changes " +
      "what people think you know. Note that the target is CRIU, cuda-checkpoint " +
      "and vLLM — not a new repository of your own.",
    steps: [
      ["linux", "kernel-governance",     "How the Kernel Is Made: Process & Governance"],
      ["linux", "kernel-dev",            "Reading & Building the Kernel"],
      ["linux", "contributing-upstream", "Getting a Patch Accepted: Kernel, CRIU & vLLM"],
    ],
    deliverable: {
      id: "d5",
      title: "A patch sent. Then a patch accepted.",
      detail:
        "Two ticks in one, and the gap between them is the education. Send " +
        "something small and real to CRIU, vLLM or the kernel — a test that " +
        "encodes a bug you reproduced, a documentation fix you verified, a " +
        "plugin, a measurement nobody had. Then survive the review.",
    },
  },
];

const TOTAL_STEPS = PHASES.reduce((n, p) => n + p.steps.length, 0);

/* ---------- DOM handles ---------- */

const trackEl   = document.getElementById("track");
const tocEl     = document.getElementById("toc");
const sidebarEl = document.getElementById("sidebar");
const toggleEl  = document.getElementById("sidebar-toggle");
const scrimEl   = document.getElementById("sidebar-scrim");
const barEl     = document.getElementById("progress-bar");

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- theme: terminal (dark) / paper (light) ----------
   Byte-for-byte the behaviour of course.js, minus the highlight.js sheet and
   the Mermaid repaint, neither of which this page has anything to apply to.
   The `.active` class matters: the shell's rail styles the pressed button on
   the class, so a track page that only set aria-pressed had a theme switch
   that looked permanently unset. */

const THEME_KEY = "ldd-theme";

function currentTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "paper" || saved === "dark") return saved;
  } catch {}
  return window.matchMedia &&
         window.matchMedia("(prefers-color-scheme: light)").matches ? "paper" : "dark";
}

function applyTheme(theme) {
  if (theme === "paper") document.documentElement.setAttribute("data-theme", "paper");
  else document.documentElement.removeAttribute("data-theme");
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

/* ---------- the page ----------

   Built once; refresh() then edits only what state changes, so ticking a
   deliverable does not tear down the button that was just clicked (which took
   focus with it) or blow away the reader's place in a 6,000px page. */

const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

function stepsMarkup(phase) {
  return phase.steps.map(([course, slug, title], i) => {
    const meta = COURSE_META[course];
    return `
      <a class="chapter-card" href="${meta.href(slug)}"
         data-course="${course}" data-slug="${slug}">
        <span class="card-check" aria-hidden="true"></span>
        <span class="card-num">${phase.n}.${i + 1}</span>
        <span class="card-body">
          <span class="card-title">${escapeHtml(title)}</span>
          <span class="card-desc">${escapeHtml(meta.label)}</span>
        </span>
        <span class="card-arrow" aria-hidden="true">&rarr;</span>
      </a>`;
  }).join("");
}

function phaseMarkup(phase) {
  const d = phase.deliverable;
  return `
    <section class="module phase" id="phase-${phase.id}" data-phase="${phase.id}">
      <header class="module-head">
        <span class="module-index">${String(phase.n).padStart(2, "0")}</span>
        <div>
          <h2>Phase ${phase.n} — ${escapeHtml(phase.title)}</h2>
          <p class="module-blurb">${escapeHtml(phase.months)} · <span
             class="phase-count" data-count="${phase.id}"></span></p>
        </div>
        <span class="lvl-badge">${phase.steps.length} chapters</span>
      </header>

      <p class="phase-thesis">${escapeHtml(phase.thesis)}</p>

      <div class="chapter-grid">${stepsMarkup(phase)}</div>

      <div class="deliverable">
        <button class="deliverable-tick" type="button"
                data-deliverable="${d.id}" aria-pressed="false">
          <span class="sr-only">Mark this deliverable done</span>
        </button>
        <div class="deliverable-body">
          <p class="deliverable-label">Deliverable</p>
          <p class="deliverable-title">${escapeHtml(d.title)}</p>
          <p class="deliverable-detail">${escapeHtml(d.detail)}</p>
        </div>
      </div>
    </section>`;
}

function buildPage() {
  trackEl.innerHTML = `
    <header class="hero">
      <div class="hero-text">
        <p class="hero-kicker">A guided track · six phases · ${TOTAL_STEPS} chapters</p>
        <h1>The GPU–Kernel Track</h1>
        <p class="hero-lede">
          Everything on this page lives somewhere else. This is not a course —
          it holds no chapters of its own. It is a route through the three that
          exist, ordered for one specific ambition: <strong>to know exactly what
          happens between a GPU and the Linux kernel</strong>, and to turn that
          into work other people can use.
        </p>
        <p class="hero-lede">
          What makes it a programme rather than a reading list is the last row of
          every phase. Each one closes on a <strong>deliverable</strong> — a
          measurement, an annotated map, a tool, a patch. Chapters tick
          themselves off as you read them in the courses. The deliverables you
          tick yourself, and they are the only ones that count.
        </p>
        <div class="hero-actions">
          <a class="btn-primary" id="track-continue" href="#phase-read">Start the track</a>
          <span class="hero-hint" id="track-hint"></span>
        </div>
      </div>
      <div class="hero-ring" id="track-ring" role="img" aria-label="Track progress">
        <svg viewBox="0 0 120 120" width="132" height="132">
          <circle cx="60" cy="60" r="${RING_R}" class="ring-track"/>
          <circle cx="60" cy="60" r="${RING_R}" class="ring-fill" id="track-ring-fill"
                  stroke-dasharray="${RING_C.toFixed(1)}"
                  stroke-dashoffset="${RING_C.toFixed(1)}"
                  transform="rotate(-90 60 60)"/>
        </svg>
        <div class="ring-label"><strong id="track-ring-pct">0%</strong><span>read</span></div>
      </div>
    </header>

    <p class="path-legend">A chapter here ticks itself off when you read it in
      its own course — this page never writes to their progress, it only looks.
      The deliverable at the foot of each phase is the one thing you tick by
      hand, because no reading tracker can tell whether you actually did it.</p>

    ${PHASES.map(phaseMarkup).join("")}

    <section class="module track-omits">
      <header class="module-head">
        <span class="module-index">··</span>
        <div>
          <h2>What this track deliberately leaves out</h2>
          <p class="module-blurb">A route is defined as much by what it skips.</p>
        </div>
      </header>
      <p class="phase-thesis">
        The three courses contain a great deal of excellent material that is not
        on the way to this particular destination — CPU vulnerability
        mitigations, power management, trusted computing, Rust in the kernel,
        TCP congestion control, most of consensus and replication, and the
        economics half of the inference course. None of it is filler. It is
        simply not this road, and a track that pretended otherwise would be a
        table of contents wearing a costume.
      </p>
      <p class="phase-thesis">
        Read them afterwards, or when a problem sends you there. Not first.
      </p>
    </section>`;

  tocEl.innerHTML = `
    <p class="toc-part">Six phases</p>
    <ul class="toc-list">
      ${PHASES.map(p => `
        <li>
          <a href="#phase-${p.id}" data-phase="${p.id}">
            <span class="toc-num">${String(p.n).padStart(2, "0")}</span>
            <span class="toc-title">${escapeHtml(p.title)}</span>
            <span class="toc-check" aria-hidden="true">✓</span>
          </a>
        </li>`).join("")}
    </ul>`;
}

/* ---------- state onto the page ---------- */

function refresh() {
  const read = readSets();
  const done = doneDeliverables();
  let readTotal = 0;
  let firstUnread = null;

  PHASES.forEach(phase => {
    const section = document.getElementById(`phase-${phase.id}`);
    let phaseRead = 0;

    phase.steps.forEach(([course, slug], i) => {
      const isRead = read[course].has(slug);
      if (isRead) { phaseRead += 1; readTotal += 1; }
      else if (!firstUnread) firstUnread = phase.steps[i];
      const card = section.querySelector(`.chapter-card[data-slug="${slug}"][data-course="${course}"]`);
      if (card) card.classList.toggle("done", isRead);
    });

    const counter = section.querySelector(`[data-count="${phase.id}"]`);
    if (counter) counter.textContent = `${phaseRead} of ${phase.steps.length} read`;

    const delivered = done.has(phase.deliverable.id);
    section.classList.toggle("is-delivered", delivered);
    const tick = section.querySelector("[data-deliverable]");
    tick.setAttribute("aria-pressed", String(delivered));
    tick.querySelector(".sr-only").textContent =
      delivered ? "Deliverable done — mark it not done" : "Mark this deliverable done";

    /* A phase is "read" in the rail once every chapter in it is; the amber
       tick beside it is the deliverable, which is the harder half. */
    const tocLink = tocEl.querySelector(`a[data-phase="${phase.id}"]`);
    if (tocLink) {
      tocLink.classList.toggle("read", phaseRead === phase.steps.length && delivered);
      tocLink.querySelector(".toc-check").style.opacity = delivered ? "0.7" : "";
    }
  });

  const pct = TOTAL_STEPS ? Math.round((readTotal / TOTAL_STEPS) * 100) : 0;
  const fill = document.getElementById("track-ring-fill");
  if (fill) fill.setAttribute("stroke-dashoffset", (RING_C - (pct / 100) * RING_C).toFixed(1));
  document.getElementById("track-ring-pct").textContent = `${pct}%`;
  document.getElementById("track-ring").setAttribute(
    "aria-label",
    `${readTotal} of ${TOTAL_STEPS} track chapters read, ` +
    `${done.size} of ${PHASES.length} deliverables done`);

  /* Where to send someone who presses the one button in the hero: the next
     chapter they have not read, or — once the reading is done — the first
     phase whose deliverable is still open, because that is what is left. */
  const cta = document.getElementById("track-continue");
  const openPhase = PHASES.find(p => !done.has(p.deliverable.id));
  if (firstUnread) {
    const [course, slug, title] = firstUnread;
    cta.href = COURSE_META[course].href(slug);
    cta.textContent = readTotal ? `Continue — ${title}` : `Start — ${title}`;
  } else if (openPhase) {
    cta.href = `#phase-${openPhase.id}`;
    cta.textContent = `Next deliverable — phase ${openPhase.n}`;
  } else {
    cta.href = "#phase-patch";
    cta.textContent = "Track complete";
  }

  document.getElementById("track-hint").textContent =
    `${readTotal} of ${TOTAL_STEPS} chapters · ${done.size} of ${PHASES.length} deliverables`;

  const summary = document.getElementById("progress-summary");
  if (summary) {
    summary.innerHTML =
      `<span class="progress-count">${readTotal} / ${TOTAL_STEPS} chapters read</span>` +
      `<span class="progress-track"><span class="progress-fill" style="width:${pct}%"></span></span>` +
      `<span class="progress-count" style="margin:0.5rem 0 0">` +
      `${done.size} / ${PHASES.length} deliverables done</span>`;
  }
}

trackEl.addEventListener("click", e => {
  const btn = e.target.closest("[data-deliverable]");
  if (!btn) return;
  const set = doneDeliverables();
  const id  = btn.dataset.deliverable;
  if (set.has(id)) set.delete(id); else set.add(id);
  saveDeliverables(set);
  refresh();
  if (window.ReaderUI) {
    ReaderUI.announce(set.has(id) ? "Deliverable marked done." : "Deliverable marked not done.");
  }
});

/* Coming back from a course should show the chapter you just finished ticked,
   and bfcache restores do not re-run the script. */
window.addEventListener("pageshow", refresh);

/* ---------- the rail: drawer, collapse, scroll spy ---------- */

let drawerWasOpen = false;

function setSidebar(open) {
  sidebarEl.classList.toggle("open", open);
  document.body.classList.toggle("nav-open", open);
  toggleEl.setAttribute("aria-expanded", String(open));
  if (open === drawerWasOpen || !window.ReaderUI) return;
  drawerWasOpen = open;
  if (open) ReaderUI.openDrawer(sidebarEl, toggleEl);
  else ReaderUI.closeDrawer();
}

toggleEl.addEventListener("click", () => setSidebar(!sidebarEl.classList.contains("open")));
if (scrimEl) scrimEl.addEventListener("click", () => setSidebar(false));

/* A phase link closes the drawer behind itself — on a phone the target is
   under the sheet that was just tapped. */
tocEl.addEventListener("click", e => {
  if (e.target.closest("a")) setSidebar(false);
});

/* ---------- jumping to a phase ----------

   The browser would handle #phase-<id> on its own, and the scroll-margin-top
   in path.css would even land it clear of the sticky bar. The reason not to
   let it: `html { scroll-behavior: smooth }` is set site-wide, and this page
   is ~7,000px tall, so a jump from the hero to phase 5 becomes a long
   animated ride through four phases you did not ask to see. Both course
   engines already override that for the same reason — app.js and course.js
   each scroll to an anchor with `behavior: "instant"`. This is that, for
   phases, with our own history entry so Back walks back through the jumps.

   The landing point clears the sticky bar, measured rather than read off the
   --sticky-h token: the token is authored in rem and parseFloat gives 3.25,
   not 52px, which is why course.js's own stickyOffset() lands a heading
   33px too high on a phone. */

function stickyOffset() {
  const bar = document.getElementById("topbar");
  /* zero above the drawer breakpoint, where the bar is display:none */
  return (bar ? bar.getBoundingClientRect().height : 0) + 16;
}

function scrollToPhase(id, push = true) {
  const el = document.getElementById(id);
  if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - stickyOffset();
  window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
  if (push && location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
  updateSpy();
}

document.addEventListener("click", e => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href^="#phase-"]');
  if (!a) return;
  e.preventDefault();
  scrollToPhase(a.getAttribute("href").slice(1));
});

window.addEventListener("popstate", () => {
  if (location.hash.startsWith("#phase-")) scrollToPhase(location.hash.slice(1), false);
});

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

/* The rail highlights the phase you are standing in, the way it highlights the
   chapter you are reading in a course, and the sticky bar names it — that bar
   is the only orientation a phone reader has once the hero has scrolled away. */

let spyPhase = null;

function updateSpy() {
  const offset = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue("--sticky-h")) || 0;
  let current = null;
  for (const p of PHASES) {
    const el = document.getElementById(`phase-${p.id}`);
    if (el && el.getBoundingClientRect().top <= offset + 96) current = p;
  }
  const id = current ? current.id : null;
  if (id === spyPhase) return;
  spyPhase = id;
  tocEl.querySelectorAll("a[data-phase]").forEach(a => {
    a.classList.toggle("active", a.dataset.phase === id);
  });
  if (window.ReaderUI) {
    ReaderUI.setTopbarTitle(current ? `Phase ${current.n} — ${current.title}`
                                    : "The GPU–Kernel Track");
  }
}

/* The sticky bar slides out of the way on a sustained scroll down and comes
   straight back on any upward move — same accumulator as the courses, so the
   bar behaves identically on every page of the site. */

let toggleLastY = 0;
let toggleAcc   = 0;

function updateToggleBar() {
  const y = Math.max(0, window.scrollY);
  const delta = y - toggleLastY;
  toggleLastY = y;

  const bar = document.getElementById("topbar");
  if (!bar) return;

  if (y < 64 || sidebarEl.classList.contains("open")) {
    toggleAcc = 0;
    bar.classList.remove("hide");
    return;
  }
  if ((delta > 0 && toggleAcc < 0) || (delta < 0 && toggleAcc > 0)) toggleAcc = 0;
  toggleAcc += delta;

  if (toggleAcc > 48) { bar.classList.add("hide"); toggleAcc = 48; }
  else if (toggleAcc < -24) { bar.classList.remove("hide"); toggleAcc = -24; }
}

window.addEventListener("scroll", () => {
  const h = document.documentElement.scrollHeight - window.innerHeight;
  if (barEl) barEl.style.width = h > 0 ? (window.scrollY / h) * 100 + "%" : "0%";
  updateSpy();
  updateToggleBar();
}, { passive: true });

/* ---------- search ----------

   The same modal, the same keys and the same result rows as the three courses.
   The corpus is different because the page is: the track owns no prose, so
   what can be found here is its own steps, phases and deliverables. A hit on a
   step leaves for that chapter in its course; a hit on a phase or a deliverable
   scrolls to it. */

const searchModal = document.getElementById("search-modal");
const searchInput = document.getElementById("search-input");
const searchList  = document.getElementById("search-results");
let searchSel = 0;

const CORPUS = PHASES.flatMap(p => [
  {
    title: `Phase ${p.n} — ${p.title}`,
    part: p.months,
    text: p.thesis,
    href: `#phase-${p.id}`,
  },
  {
    title: p.deliverable.title,
    part: `Deliverable · phase ${p.n}`,
    text: p.deliverable.detail,
    href: `#phase-${p.id}`,
  },
  ...p.steps.map(([course, slug, title]) => ({
    title,
    part: `Phase ${p.n} · ${COURSE_META[course].label}`,
    text: slug.replace(/-/g, " "),
    href: COURSE_META[course].href(slug),
  })),
]);

function searchQuery(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t);
  if (!terms.length) return [];
  return CORPUS
    .map(doc => {
      const hay = `${doc.title} ${doc.part} ${doc.text}`.toLowerCase();
      if (!terms.every(t => hay.includes(t))) return null;
      /* a hit in the title outranks one buried in the prose */
      const inTitle = terms.filter(t => doc.title.toLowerCase().includes(t)).length;
      return { doc, score: inTitle * 10 - hay.indexOf(terms[0]) / 1000 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function highlight(text, terms) {
  let out = escapeHtml(text);
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(${escaped})`, "ig"), "<mark>$1</mark>");
  }
  return out;
}

function renderSearchResults(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  searchSel = 0;
  if (!q.trim()) {
    searchList.innerHTML =
      `<li class="search-hint">Type to search this track — ${TOTAL_STEPS} chapters, ` +
      `six phases and their deliverables. Full-text search of a course lives in that course.</li>`;
    return;
  }
  const results = searchQuery(q);
  if (!results.length) {
    searchList.innerHTML = `<li class="search-hint">No results for “${escapeHtml(q)}”.</li>`;
    return;
  }
  searchList.innerHTML = results.map((r, i) =>
    `<li id="sr-${i}" class="search-result${i === 0 ? " selected" : ""}"
         role="option" aria-selected="${i === 0}" data-href="${r.doc.href}">
       <span class="sr-title">${highlight(r.doc.title, terms)}</span>
       <span class="sr-part">${escapeHtml(r.doc.part)}</span>
       <span class="sr-snippet">${highlight(r.doc.text.slice(0, 160), terms)}…</span>
     </li>`).join("");
  searchList.querySelectorAll(".search-result").forEach(li => {
    li.addEventListener("click", () => go(li.dataset.href));
  });
  syncSearchSelection();
  if (window.ReaderUI) {
    ReaderUI.announce(`${results.length} result${results.length === 1 ? "" : "s"} for ${q}.`);
  }
}

function syncSearchSelection() {
  const items = [...searchList.querySelectorAll(".search-result")];
  items.forEach((li, i) => {
    const on = i === searchSel;
    li.classList.toggle("selected", on);
    li.setAttribute("aria-selected", String(on));
  });
  const active = items[searchSel];
  if (active) searchInput.setAttribute("aria-activedescendant", active.id);
  else searchInput.removeAttribute("aria-activedescendant");
}

/* An in-page phase anchor and a chapter in another course are two different
   navigations wearing the same result row. */
function go(href) {
  closeSearch();
  if (href.startsWith("#phase-")) scrollToPhase(href.slice(1));
  else location.href = href;
}

function openSearch() {
  if (searchModal.classList.contains("open")) return;
  searchModal.hidden = false;
  searchModal.classList.add("open");
  searchInput.value = "";
  if (window.ReaderUI) ReaderUI.trapFocus(searchModal, document.getElementById("search-open"));
  searchInput.focus();
  renderSearchResults("");
}

function closeSearch() {
  if (!searchModal.classList.contains("open")) return;
  searchModal.classList.remove("open");
  searchModal.hidden = true;
  searchInput.removeAttribute("aria-activedescendant");
  if (window.ReaderUI) ReaderUI.releaseFocus();
}

searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));
searchInput.addEventListener("keydown", e => {
  const items = [...searchList.querySelectorAll(".search-result")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    searchSel = (searchSel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    syncSearchSelection();
    items[searchSel].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && items[searchSel]) {
    go(items[searchSel].dataset.href);
  }
});

searchModal.addEventListener("click", e => {
  if (e.target === searchModal) closeSearch();
});
document.getElementById("search-open").addEventListener("click", openSearch);

/* ---------- keyboard: the same three keys the courses answer to ---------- */

document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
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
  }
});

/* ---------- boot ---------- */

document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeValue));
});
applyTheme(currentTheme());

buildPage();
refresh();
updateSpy();

/* A link into a phase, opened cold: the sections are injected by buildPage()
   above, so at the moment the browser looked for the fragment there was
   nothing under that id yet. */
if (location.hash.startsWith("#phase-")) scrollToPhase(location.hash.slice(1), false);
