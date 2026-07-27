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
   tests/tier1/links.test.js can resolve them. */

"use strict";

/* ---------- where the courses keep their progress ---------- */

const COURSE_META = {
  linux:       { label: "Linux",       href: s => `../#/${s}` },
  distributed: { label: "Distributed", href: s => `../distributed/#/${s}` },
  inference:   { label: "Inference",   href: s => `../inference/#/${s}` },
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
      ["inference",   "anatomy-of-an-engine",   "Anatomy of an Engine"],
      ["inference",   "paged-kv-cache",         "The Paged KV Cache"],
      ["inference",   "the-kv-fabric",          "The KV Fabric"],
      ["inference",   "agentic-serving",        "Agentic Serving"],
      ["distributed", "the-network-is-hostile", "The Network Is Hostile"],
      ["distributed", "failure-models",         "Failure Models"],
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

/* ---------- render ---------- */

const phasesEl   = document.getElementById("phases");
const progressEl = document.getElementById("track-progress");

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render() {
  const read = readSets();
  const done = doneDeliverables();

  let readCount = 0, stepCount = 0;

  phasesEl.innerHTML = PHASES.map(p => {
    const steps = p.steps.map(([course, slug, title]) => {
      const meta = COURSE_META[course];
      const isRead = read[course].has(slug);
      stepCount += 1;
      if (isRead) readCount += 1;
      return `
        <li class="step${isRead ? " is-read" : ""}">
          <span class="step-tick" aria-hidden="true">${isRead ? "✓" : ""}</span>
          <a class="step-link" href="${meta.href(slug)}">${escapeHtml(title)}</a>
          <span class="step-course">${meta.label}</span>
        </li>`;
    }).join("");

    const phaseRead = p.steps.filter(([c, s]) => read[c].has(s)).length;
    const isDone    = done.has(p.deliverable.id);

    return `
      <article class="phase${isDone ? " is-delivered" : ""}" id="phase-${p.id}">
        <header class="phase-head">
          <p class="phase-months">${p.months}</p>
          <h2><span class="phase-n">Phase ${p.n}</span> ${escapeHtml(p.title)}</h2>
          <p class="phase-thesis">${escapeHtml(p.thesis)}</p>
        </header>

        <ol class="steps">${steps}</ol>
        <p class="phase-count">${phaseRead} of ${p.steps.length} chapters read</p>

        <div class="deliverable">
          <button class="deliverable-tick" type="button"
                  data-deliverable="${p.deliverable.id}"
                  aria-pressed="${isDone}">
            <span aria-hidden="true">${isDone ? "✓" : ""}</span>
            <span class="sr-only">Mark deliverable ${isDone ? "not done" : "done"}</span>
          </button>
          <div class="deliverable-body">
            <p class="deliverable-label">Deliverable</p>
            <p class="deliverable-title">${escapeHtml(p.deliverable.title)}</p>
            <p class="deliverable-detail">${escapeHtml(p.deliverable.detail)}</p>
          </div>
        </div>
      </article>`;
  }).join("");

  const pct = stepCount ? Math.round((readCount / stepCount) * 100) : 0;
  progressEl.innerHTML = `
    <div class="bar" role="img"
         aria-label="${readCount} of ${stepCount} track chapters read, ${done.size} of ${PHASES.length} deliverables done">
      <span style="width:${pct}%"></span>
    </div>
    <p class="bar-label">
      <strong>${readCount}</strong> of ${stepCount} chapters read
      &middot; <strong>${done.size}</strong> of ${PHASES.length} deliverables done
    </p>`;
}

phasesEl.addEventListener("click", e => {
  const btn = e.target.closest("[data-deliverable]");
  if (!btn) return;
  const set = doneDeliverables();
  const id  = btn.dataset.deliverable;
  if (set.has(id)) set.delete(id); else set.add(id);
  saveDeliverables(set);
  render();
});

/* Coming back from a course should show the chapter you just finished ticked,
   and bfcache restores do not re-run the script. */
window.addEventListener("pageshow", render);

/* ---------- theme, shared with the courses ---------- */

const THEME_KEY = "ldd-theme";
function applyTheme(theme) {
  if (theme === "paper") document.documentElement.dataset.theme = "paper";
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll(".theme-btn").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.themeValue === theme));
  });
}
document.querySelectorAll(".theme-btn").forEach(b => {
  b.addEventListener("click", () => {
    const t = b.dataset.themeValue;
    try { localStorage.setItem(THEME_KEY, t); } catch {}
    applyTheme(t);
  });
});
applyTheme(document.documentElement.dataset.theme === "paper" ? "paper" : "dark");

render();
