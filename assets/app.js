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
    blurb: "The map before the territory: what this book covers, how a chapter is built, and six ordered paths through the 56 of them.",
    chapters: [
      { slug: "start-here", title: "How to Use This Book: Paths & Prerequisites",
        desc: "What this book is, the level badges, and six ordered paths through it." },
    ],
  },
  {
    part: "Part 0 — Prerequisites",
    blurb: "The optional ground floor for operators: the hardware, the ELF binary, the C, and the man pages every later chapter quietly assumes.",
    chapters: [
      { slug: "prereq-overview", title: "What This Book Assumes",
        desc: "Assumed knowledge, what is not taught here, and a self-assessment for Part 0." },
      { slug: "prereq-hardware", title: "The Machine Underneath: CPU, Memory & Devices",
        desc: "Registers, hex addresses, the memory hierarchy, multicore, MMIO, DMA and firmware." },
      { slug: "prereq-programs", title: "From Source Code to Running Process",
        desc: "ELF, static vs dynamic linking, the dynamic linker, and why a program must ask the kernel." },
      { slug: "prereq-c", title: "Just Enough C to Read the Kernel",
        desc: "Pointers, structs, ops tables, container_of and list_head — enough C to read, not write." },
      { slug: "prereq-tools", title: "Reading the Evidence: man, /proc & Kernel Source",
        desc: "man page sections, /proc and /sys as windows, dmesg, and reading source on Elixir." },
    ],
  },
  {
    part: "Part I — Foundations",
    blurb: "What Linux actually is, how a machine gets from firmware to a login prompt, and the one boundary everything else stands on.",
    chapters: [
      { slug: "what-is-linux", title: "What Is Linux, Really?",
        desc: "Kernel vs distro, the monolithic design, a syscall in slow motion, everything is a file." },
      { slug: "boot-process", title: "From Power Button to Login",
        desc: "UEFI, GRUB, the initramfs, PID 1 and systemd — every actor from power-on to login." },
      { slug: "kernel-vs-userspace", title: "Kernel, User Space & Syscalls",
        desc: "Rings 0 and 3, the syscall entry path, file descriptors, the vDSO, mode vs context switch." },
    ],
  },
  {
    part: "Part II — Core Kernel Subsystems",
    blurb: "The load-bearing walls: processes, the scheduler, virtual memory, interrupts, timers, filesystems, storage, devices and the network stack.",
    chapters: [
      { slug: "processes", title: "Processes & Threads",
        desc: "task_struct, fork and exec, wait() and zombies, and threads as processes that share." },
      { slug: "scheduling", title: "CPU Scheduling",
        desc: "EEVDF fair-share, runqueues, preemption, load balancing, and what load average means." },
      { slug: "memory", title: "Virtual Memory",
        desc: "VMAs, page tables, page faults, the page cache, swap, THP, KSM and the OOM killer." },
      { slug: "interrupts", title: "Interrupts, Exceptions & Softirqs",
        desc: "The IDT, hardirq rules, MSI-X, softirqs, tasklets and workqueues, and IRQ affinity." },
      { slug: "timers", title: "Timers & Time: jiffies, hrtimers & Tickless",
        desc: "clocksource and clockevents, jiffies, the timer wheel, hrtimers, NTP and NO_HZ." },
      { slug: "filesystems", title: "Files, Filesystems & the VFS",
        desc: "The VFS, inodes and dentries, mounts, journaling — and why mounts are per-process." },
      { slug: "storage-stack", title: "The Linux Storage Stack",
        desc: "Page cache, bio, blk-mq, I/O schedulers, device mapper, md-raid, NVMe and I/O cgroups." },
      { slug: "devices-modules", title: "Devices, Drivers & Modules",
        desc: "Drivers as translators, /dev and /sys, loadable modules, DMA, and udev rules." },
      { slug: "networking", title: "The Networking Stack",
        desc: "Sockets, the sk_buff, a packet's journey, routing, netfilter, XDP and the veth toolbox." },
      { slug: "tcp-congestion", title: "TCP Congestion Control & Tuning",
        desc: "cwnd and the ACK clock, CUBIC vs BBR, the sysctls, bufferbloat and FQ-CoDel." },
    ],
  },
  {
    part: "Part III — IPC, Signals & Pipes",
    blurb: "How processes interrupt and talk to each other — signal delivery, pipes, FIFOs and Unix sockets, the plumbing under every shell and runtime.",
    chapters: [
      { slug: "signals", title: "Signals: The Kernel's Asynchronous Notifications",
        desc: "Delivery and the pending mask, handlers, SIGKILL and SIGSTOP, job control, core dumps." },
      { slug: "ipc-pipes", title: "Pipes, FIFOs & Unix Sockets",
        desc: "Anonymous pipes, FIFOs and Unix sockets — the plumbing behind shells and runtimes." },
    ],
  },
  {
    part: "Part IV — Containers, From Scratch",
    blurb: "There is no container object in the kernel: namespaces, cgroups, OverlayFS and pivot_root, assembled by hand before meeting Docker and runc.",
    chapters: [
      { slug: "containers-overview", title: "What a Container Actually Is",
        desc: "No struct container anywhere: just a process the kernel lies to, wearing four disguises." },
      { slug: "namespaces", title: "Namespaces",
        desc: "All eight types — UTS, PID, mount, net, user, time — plus nsproxy, unshare and setns." },
      { slug: "cgroups", title: "Control Groups (cgroup v2)",
        desc: "Controllers and cgroupfs, memory.max and cpu.max, PSI, delegation, the Docker mapping." },
      { slug: "overlayfs", title: "Images & OverlayFS",
        desc: "Layers as tarballs, the overlay union, copy-up cost, whiteouts, and pivot_root." },
      { slug: "build-a-container", title: "Build a Container by Hand",
        desc: "A rootfs, namespaces, pivot_root, a cgroup, dropped capabilities and a seccomp filter." },
      { slug: "container-runtimes", title: "Docker, containerd, runc",
        desc: "The Docker, containerd and runc stack, the OCI specs, podman, and where Kubernetes fits." },
      { slug: "container-networking", title: "Container Networking",
        desc: "veth pairs, a software bridge, NAT and port publishing as DNAT, plus the mode menu." },
    ],
  },
  {
    part: "Part V — Checkpoint/Restore",
    blurb: "Freeze a running process, write it to disk, rebuild it elsewhere — CRIU end to end, live migration, and the GPU case that breaks it.",
    chapters: [
      { slug: "process-state", title: "The Anatomy of Process State",
        desc: "A full inventory of task state, the three visibility tiers, and ptrace as the master key." },
      { slug: "criu-dump", title: "CRIU: Dumping a Live Process",
        desc: "Freezing the tree, harvesting /proc, injecting the parasite, and the protobuf image set." },
      { slug: "criu-restore", title: "CRIU: The Restore",
        desc: "The morphing trick, PID reservation, the fd graph, the restorer blob and rt_sigreturn." },
      { slug: "live-migration", title: "Live Migration: Iterative, Lazy & TCP Repair",
        desc: "Soft-dirty pre-copy, userfaultfd post-copy, TCP repair — and the downtime equation." },
      { slug: "snapshot-taxonomy", title: "The Snapshot Taxonomy: CRIU, gVisor & microVMs",
        desc: "runc checkpoint up to the kubelet, and the four places to draw a snapshot boundary." },
      { slug: "gpu-checkpoint", title: "GPU Checkpointing: cuda-checkpoint & CRIU Plugins",
        desc: "Why CUDA breaks CRIU: the plugin hooks, cuda-checkpoint, and the unified-memory frontier." },
    ],
  },
  {
    part: "Part VI — Hardware & Platform",
    blurb: "Where the kernel meets the silicon: frequency and idle states, NUMA topology, isolated CPUs, and the speculative-execution tax.",
    chapters: [
      { slug: "power-management", title: "Power Management: Governors, C-States & ACPI",
        desc: "cpufreq governors and P-states, C-states and the idle loop, suspend, hibernate, ACPI." },
      { slug: "numa-deep-dive", title: "NUMA Deep Dive",
        desc: "Nodes and the SLIT matrix, allocation policy, NUMA balancing, and the classic pathologies." },
      { slug: "cpu-isolation", title: "CPU Isolation, NO_HZ & Real-Time",
        desc: "isolcpus and nohz_full, cpuset partitions, SCHED_FIFO, PREEMPT_RT and cyclictest." },
      { slug: "cpu-mitigations", title: "CPU Vulnerability Mitigations",
        desc: "Spectre and Meltdown, KPTI, retpolines, L1TF and MDS — and what the mitigations cost." },
    ],
  },
  {
    part: "Part VII — Modern Kernel",
    blurb: "The last decade of kernel change: eBPF as a substrate, the confinement stack, measured boot, io_uring, and Rust in the tree.",
    chapters: [
      { slug: "ebpf-internals", title: "eBPF Internals",
        desc: "Programs, maps, helpers, the verifier and JIT, BTF and CO-RE, XDP and TC, LSM BPF." },
      { slug: "security-hardening", title: "Linux Security & Confinement",
        desc: "Credentials, DAC, capabilities, seccomp, LSMs, Landlock and lockdown as one path." },
      { slug: "trusted-computing", title: "Trusted Computing: Secure Boot, TPM & IMA",
        desc: "Secure Boot, TPM PCRs and measured boot, IMA, LUKS2 with TPM2, confidential computing." },
      { slug: "modern-io", title: "Modern I/O & io_uring",
        desc: "Blocking calls to epoll to io_uring: SQ/CQ rings, registered buffers, SQPOLL, multishot." },
      { slug: "rust-kernel", title: "Rust in the Linux Kernel",
        desc: "Why memory safety, what has merged since 6.1, and how safe abstractions wrap the C." },
    ],
  },
  {
    part: "Part VIII — Virtualization",
    blurb: "How the kernel becomes a hypervisor: the KVM module, the vCPU loop, VM exits, nested page tables and virtio devices.",
    chapters: [
      { slug: "kvm-internals", title: "KVM & Virtualization Internals",
        desc: "The KVM API, the vCPU loop, VM exits, EPT and NPT, virtio, and the steal-time problem." },
    ],
  },
  {
    part: "Part IX — Kernel Engineering",
    blurb: "The craft side: locking and RCU, how a patch actually becomes kernel law, and the tools and methods for finding what is slow.",
    chapters: [
      { slug: "kernel-sync", title: "Kernel Synchronization: Locks, Atomics & RCU",
        desc: "Atomics, spinlocks, mutexes, seqlocks, RCU, and the memory barriers that make them work." },
      { slug: "kernel-governance", title: "How the Kernel Is Made: Process & Governance",
        desc: "The merge window, the maintainer chain, patches on the list, stable and LTS, the culture." },
      { slug: "observability", title: "/proc, strace, perf & eBPF",
        desc: "From /proc reads to strace, perf and bpftrace — with the cost model for each layer." },
      { slug: "perf-methodology", title: "Performance Analysis Methodology",
        desc: "USE and RED, workload characterization, the 60-second checklist, and flame graphs." },
    ],
  },
  {
    part: "Part X — Tools & Going Deeper",
    blurb: "Stop reading about the source and open it: the tree layout, Kconfig and Kbuild, and a kernel built and booted in a throwaway VM.",
    chapters: [
      { slug: "kernel-dev", title: "Reading & Building the Kernel",
        desc: "The tree layout, Kconfig and Kbuild, a kernel built and booted in a VM, a first module." },
    ],
  },
  {
    part: "Part XI — Hands-On Labs",
    blurb: "Six sessions at a real root shell — the OOM killer, the page cache, cgroup throttling, a kernel module, CRIU and userfaultfd.",
    chapters: [
      { slug: "lab-oom-killer", title: "Lab: Trigger & Autopsy the OOM Killer",
        desc: "A cgroup-local OOM kill, the dmesg autopsy line by line, oom_score_adj and PSI." },
      { slug: "lab-page-cache", title: "Lab: Watch the Page Cache Work",
        desc: "Cold vs hot reads, dirty pages draining, mincore, drop_caches, minor vs major faults." },
      { slug: "lab-cgroup-limits", title: "Lab: Throttle a Process with cgroup v2",
        desc: "A cgroup made by hand: cpu.max throttling, cpu.weight sharing, memory.max and reclaim." },
      { slug: "lab-kernel-module", title: "Lab: Write, Build & Load a Kernel Module",
        desc: "hello.c and a kbuild Makefile, insmod and modinfo, module params, seq_file, DKMS." },
      { slug: "lab-criu", title: "Lab: Checkpoint & Restore a Real Process",
        desc: "A counting process frozen and restored mid-count, then autopsied with CRIT." },
      { slug: "lab-userfaultfd", title: "Lab: Serve Page Faults from Userspace",
        desc: "A C fault server that fills missing pages: register, read, ioctl — timed and broken." },
    ],
  },
  {
    part: "Reference",
    blurb: "Roughly seventy terms the book leans on, each defined in a sentence or two and linked to the chapter that treats it properly.",
    chapters: [
      { slug: "glossary", title: "Glossary",
        desc: "About seventy terms, each defined in a sentence and linked to its real chapter." },
    ],
  },
];

/* flat ordered list used for routing and prev/next */
const FLAT = BOOK.flatMap(p => p.chapters);
const TITLE_OF = Object.fromEntries(FLAT.map(ch => [ch.slug, ch.title]));
/* which part a chapter belongs to — search results say where a hit lives */
const PART_OF = Object.fromEntries(
  BOOK.flatMap(p => p.chapters.map(ch => [ch.slug, p.part]))
);

/* scroll-memory keys for the two view-only routes; "@" can never appear in a
   slug because it is the chapter/anchor separator in the hash */
const HOME_KEY     = "@home";
const PLATFORM_KEY = "@platform";

/* The other two courses, for the platform landing page. Counts and blurbs are
   duplicated in each shell's .course-switch markup; tests/tier1 asserts the two
   agree, so this list cannot drift silently. Progress lives in localStorage on
   the same origin, which is the only reason a single page can answer "where am
   I across all three". */
const COURSES = [
  { id: "linux", name: "The Linux Deep Dive", href: "#/course", total: 56,
    blurb: "The machinery under the command line: processes, memory, the " +
           "storage and network stacks, containers, checkpoint/restore.",
    /* Counted the same way the course home counts it — against the chapters
       that exist. Taking the raw size of the stored set let a renamed or
       retired chapter linger in it, and the card then disagreed with the ring
       on the page it links to. */
    time: "20+ hours",
    progress: () => { const set = readSet(); return FLAT.filter(ch => set.has(ch.slug)).length; } },
  { id: "distributed", name: "Distributed Systems", href: "distributed/", total: 13,
    blurb: "What breaks once there is more than one machine: hostile " +
           "networks, clocks that lie, replication, consensus, Raft.",
    time: "4–5 hours", progress: () => countCompleted("ds-course-progress-v1") },
  { id: "inference", name: "Inference Engineering", href: "inference/", total: 24,
    blurb: "Serving large language models on GPUs: rooflines, the KV cache, " +
           "engines, kernels, quantization, rack-scale systems.",
    time: "7–8 hours", progress: () => countCompleted("inf-course-progress-v1") },
];

/* The guided courses store {completed: {slug: true}, last}. Read defensively:
   the engines already refuse localStorage gracefully and the landing page must
   not be the one place that throws when storage is blocked. */
function countCompleted(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    return raw && raw.completed ? Object.keys(raw.completed).length : 0;
  } catch { return 0; }
}

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

/* The highlight.js themes are vendored, not fetched from a CDN. This engine
   and course.js both live in assets/ but are loaded from documents at two
   different depths, so a path relative to the *document* is wrong for two of
   the three courses: ReaderUI resolves it against its own script URL instead.
   The fallback keeps the theme switch working if reader-ui.js failed to load,
   deriving the same base from this file's URL. */
const vendorUrl = window.ReaderUI
  ? ReaderUI.vendorUrl
  : rel => new URL("vendor/" + rel, document.currentScript.src).href;

const HLJS_THEME_HREF = {
  dark:  vendorUrl("hljs/gruvbox-dark-medium.min.css"),
  paper: vendorUrl("hljs/gruvbox-light-medium.min.css"),
};

function currentTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "paper" || saved === "dark") return saved;
  } catch {}
  return window.matchMedia &&
         window.matchMedia("(prefers-color-scheme: light)").matches ? "paper" : "dark";
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
  /* Diagram colours are baked into the SVG, so a theme change repaints them.
     ReaderUI remembers the theme even when Mermaid has not been downloaded
     yet, so a switch made before any diagram is seen still applies. */
  if (window.ReaderUI) ReaderUI.setMermaidTheme(theme, rerenderDiagrams);
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
/* Returns false when the browser refuses the write (private mode, quota,
   storage disabled). Callers must not claim success on a false. */
function saveReadSet(set) {
  const json = JSON.stringify([...set]);
  try {
    localStorage.setItem(READ_KEY, json);
    return true;
  } catch {
    /* Where you are in the book outranks a cache we can rebuild: give up the
       search index and try once more before admitting the write failed. */
    try {
      localStorage.removeItem(INDEX_KEY);
      localStorage.setItem(READ_KEY, json);
      return true;
    } catch { return false; }
  }
}
function markRead(slug, on = true) {
  const set = readSet();
  if (on) set.add(slug); else set.delete(slug);
  const saved = saveReadSet(set);
  /* both refreshes re-read from storage, so a failed write repaints the
     truth rather than the intent */
  refreshReadMarks();
  refreshReadButton(slug);
  return saved;
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

/* The chapter last opened. "Continue" starts its search here rather than at
   chapter one, so reading 1–3 and then jumping to 10 doesn't offer chapter 4. */
const LAST_KEY = "ldd-last";

function lastVisited() {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}
function setLastVisited(slug) {
  try { localStorage.setItem(LAST_KEY, slug); } catch {}
}

function nextUnread() {
  const set = readSet();
  const start = Math.max(0, FLAT.findIndex(ch => ch.slug === lastVisited()));
  return FLAT.slice(start).find(ch => !set.has(ch.slug))
      || FLAT.find(ch => !set.has(ch.slug))
      || FLAT[0];
}

function refreshReadButton(slug) {
  const btn = document.getElementById("mark-read-btn");
  if (!btn) return;
  const isRead = readSet().has(slug);
  btn.textContent = isRead ? "✓ read" : "mark as read";
  btn.classList.toggle("is-read", isRead);
  btn.setAttribute("aria-pressed", String(isRead));
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
    rememberScroll(scrollKey());
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
window.addEventListener("pagehide", () => rememberScroll(scrollKey()));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberScroll(scrollKey());
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

  const bar = document.getElementById("topbar") || toggleEl;

  /* always visible near the top or while the drawer is open */
  if (y < 64 || sidebarEl.classList.contains("open")) {
    toggleAcc = 0;
    bar.classList.remove("hide");
    return;
  }
  /* a change of direction starts the count fresh */
  if ((delta > 0 && toggleAcc < 0) || (delta < 0 && toggleAcc > 0)) toggleAcc = 0;
  toggleAcc += delta;

  if (toggleAcc > 48) { bar.classList.add("hide"); toggleAcc = 48; }         // scrolled down enough → hide
  else if (toggleAcc < -24) { bar.classList.remove("hide"); toggleAcc = -24; } // nudged up → reveal
}

/* auto-mark a chapter read when the reader reaches the end */
let autoReadArmed = false;
window.addEventListener("scroll", () => {
  const h = document.documentElement.scrollHeight - window.innerHeight;
  progressEl.style.width = h > 0 ? (scrollY / h) * 100 + "%" : "0%";
  const slug = currentSlug();
  if (autoReadArmed && slug && h > 400 && scrollY > h - 120) {
    autoReadArmed = false;
    markRead(slug);
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

/* Position in the book, for the breadcrumb. The guided courses have said
   "Course home / Module" at the head of every chapter since they were
   written; the largest of the three courses said nothing at all, and
   nothing anywhere said "chapter N of M". */
function chapterIndex(slug) {
  return FLAT.findIndex(ch => ch.slug === slug);
}

function crumbHtml(slug) {
  const i = chapterIndex(slug);
  const part = PART_OF[slug] || "";
  return `<nav class="chapter-crumb" aria-label="Breadcrumb">` +
    `<a class="crumb" href="#/course">Course home</a>` +
    `<span class="crumb-sep" aria-hidden="true">/</span>` +
    `<span class="crumb-here">${part}</span>` +
    (i >= 0 ? `<span class="crumb-count">Chapter ${i + 1} of ${FLAT.length}</span>` : "") +
    `</nav>`;
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
  return `${crumbHtml(slug)}<div class="chapter-meta">${bits.join("")}</div>${prereqs}`;
}

/* ---------------- chapter source ----------------
   One fetch per chapter per session, shared by the reader and the search
   indexer: building the index warms the whole book, and a chapter already in
   hand renders without touching the network. */

const mdCache = new Map();

async function fetchChapterSource(slug) {
  const cached = mdCache.get(slug);
  if (cached !== undefined) return cached;
  const res = await fetch(`content/${slug}.md`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);   // never read an error page as a chapter
  const text = await res.text();
  mdCache.set(slug, text);
  return text;
}

/* requestIdleCallback where it exists, a plain timer where it does not */
const whenIdle = window.requestIdleCallback
  ? cb => requestIdleCallback(cb, { timeout: 2000 })
  : cb => setTimeout(cb, 500);

/* Fetch the chapters on either side once the browser is quiet, so ←/→ and the
   pager land instantly. This is a guess about where the reader is going next:
   it must never surface an error or delay anything they actually asked for. */
function preloadNeighbours(slug) {
  const i = FLAT.findIndex(ch => ch.slug === slug);
  if (i === -1) return;
  whenIdle(() => {
    [FLAT[i + 1], FLAT[i - 1]].forEach(ch => {
      if (ch && !mdCache.has(ch.slug)) fetchChapterSource(ch.slug).catch(() => {});
    });
  });
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

/* Mermaid rendering — including the lazy download of the library itself —
   lives in ReaderUI, so the guided courses get the same diagrams from the
   same code rather than a second copy of it. */

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
  const line = stickyOffset() + 58;
  for (const h of heads) {
    if (h.getBoundingClientRect().top <= line) active = h.id; else break;
  }
  document.querySelectorAll(".page-toc a, .page-toc-inline a").forEach(a => {
    const on = a.dataset.target === active;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
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

/* Three routes now. An *empty* hash is the platform landing page — "/" used to
   be the Linux course, which meant the other two courses were reachable only
   from the left rail. A hash that names something we don't have still lands on
   the course home rather than the landing page: a stale bookmark to a renamed
   chapter is a Linux reader who mistyped, not a first-time visitor. */
function currentRoute() {
  const { slug, anchor } = parseHash();
  if (slug && FLAT.some(ch => ch.slug === slug)) return { kind: "chapter", slug, anchor };
  if (slug) return { kind: "home" };          // unknown slug: course home
  return { kind: "platform" };                // bare #/ or no hash at all
}

/* the slug being read, or null on the course home */
function currentSlug() {
  const r = currentRoute();
  return r.kind === "chapter" ? r.slug : null;
}

/* The landing page and the course home are two different documents at two
   different hashes, so they must not share one remembered scroll position. */
function scrollKey() {
  const r = currentRoute();
  if (r.kind === "chapter")  return r.slug;
  if (r.kind === "platform") return PLATFORM_KEY;
  return HOME_KEY;
}

/* The left rail is shared by the platform landing page and the Linux course,
   so it has to say which of the two you are reading. Marked up as the Linux
   course, it contradicted the landing page in three places at once: the rail
   title, the "current" course chip, and 56 unattributed chapter links. */
const titleLinkEl = document.getElementById("site-title-link");
const subtitleEl  = document.getElementById("site-subtitle");
const tocLabelEl  = document.getElementById("toc-label");

const SHELL_ID = {
  platform: { href: "#/",       title: "How Systems<br>Really Work",
              subtitle: "three courses, one machine at a time", chip: "all" },
  course:   { href: "#/course", title: "The Linux<br>Deep Dive",
              subtitle: "how your system really works",         chip: "linux" },
};

function setShellContext(kind) {
  const id = SHELL_ID[kind === "platform" ? "platform" : "course"];
  if (titleLinkEl && titleLinkEl.getAttribute("href") !== id.href) {
    titleLinkEl.setAttribute("href", id.href);
    titleLinkEl.innerHTML = id.title;
  }
  if (subtitleEl) subtitleEl.textContent = id.subtitle;
  if (tocLabelEl) tocLabelEl.hidden = id.chip !== "all";

  document.querySelectorAll(".course-switch .course-chip[data-course]").forEach(chip => {
    const on = chip.dataset.course === id.chip;
    chip.classList.toggle("current", on);
    if (on) chip.setAttribute("aria-current", "page"); else chip.removeAttribute("aria-current");
  });
}

function markActive(slug) {
  tocEl.querySelectorAll("a").forEach(a => {
    const on = a.dataset.slug === slug;
    a.classList.toggle("active", on);
    /* the visual active state had no programmatic equivalent, so a
       screen-reader user tabbing 56 entries could not tell where they were */
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
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
            `<span class="pager-title">${prev.title}</span></a>`
          : `<a class="prev" href="#/course">` +
            `<span class="pager-label">&larr; back</span>` +
            `<span class="pager-title">Course home</span></a>`) +
    (next ? `<a class="next" href="#/${next.slug}">` +
            `<span class="pager-label">next &rarr;</span>` +
            `<span class="pager-title">${next.title}</span></a>`
          : `<a class="next" href="#/course">` +
            `<span class="pager-label">finish &rarr;</span>` +
            `<span class="pager-title">Back to the course map</span></a>`);
}

let lastSlug = null;
let renderToken = 0;          // guards against a slow fetch landing after a newer one
let placeholderTimer = null;  // only the current navigation may paint Loading…

async function loadChapter(slug, anchor) {
  markActive(slug);

  if (slug === lastSlug) {                 // in-page anchor jump only
    if (anchor) scrollToAnchor(anchor);
    return;
  }

  const token = ++renderToken;
  /* A previous request may still be fetching. Its delayed placeholder must
     never paint over this navigation. */
  clearTimeout(placeholderTimer);

  /* Only announce the load if it is slow enough to notice: a warm fetch
     lands well inside this and the reader never sees a flash. */
  placeholderTimer = setTimeout(() => {
    if (token !== renderToken) return;
    articleEl.className = "article";
    articleEl.innerHTML = `<p class="loading">Loading ${TITLE_OF[slug]}…</p>`;
    pagerEl.innerHTML = "";
    if (pageTocEl) pageTocEl.innerHTML = "";
  }, 150);

  try {
    const raw = await fetchChapterSource(slug);
    if (token !== renderToken) return;      // a newer navigation already won
    clearTimeout(placeholderTimer);
    placeholderTimer = null;
    const { meta, body } = parseFrontmatter(raw);

    articleEl.className = "article";       // the home view borrows this element
    articleEl.innerHTML = marked.parse(body);

    /* insert the meta banner right after the H1 */
    const h1 = articleEl.querySelector("h1");
    if (h1) {
      h1.insertAdjacentHTML("afterend", metaBannerHtml(meta, slug));
      const btn = document.getElementById("mark-read-btn");
      btn.addEventListener("click", () => {
        if (markRead(slug, !readSet().has(slug))) return;
        btn.textContent = "couldn't save — storage blocked";
        btn.classList.add("save-failed");
      });
      refreshReadButton(slug);
    }

    void articleEl.offsetWidth;
    articleEl.classList.add("fade-in");
    articleEl.querySelectorAll("pre code").forEach(el => {
      if (!el.classList.contains("language-mermaid")) hljs.highlightElement(el);
    });
    decorateHeadings(slug);
    wrapTables();
    buildPageToc();
    renderPager(slug);

    if (window.ReaderUI) {
      /* Diagrams first: it swaps each fence for a <pre class="mermaid">
         synchronously, so the block below measures the element the reader
         will actually get. The 3.2 MB library itself is only fetched if
         this chapter has a diagram at all. */
      ReaderUI.renderMermaid(articleEl);
      /* make every scrollable block reachable and signposted, and give the
         narrow-screen reader the outline the 1280px rail withholds */
      ReaderUI.prepareContent(articleEl);
      const heads = [...articleEl.querySelectorAll("h2, h3")];
      const meta = articleEl.querySelector(".chapter-meta");
      ReaderUI.buildInlineToc(heads, slug, meta || articleEl.querySelector("h1"));
      ReaderUI.setTopbarTitle(TITLE_OF[slug]);
    }

    if (anchor) scrollToAnchor(anchor);
    else if (!booted) restoreScroll(slug);                   // reload: keep your place
    else window.scrollTo({ top: 0, behavior: "instant" });   // new chapter: start at top

    /* A navigation replaced the whole page. Move focus to it so the next
       Tab starts at the chapter rather than 64 stops away, and say so. */
    if (booted && window.ReaderUI) {
      ReaderUI.focusMain();
      ReaderUI.announce(`${TITLE_OF[slug]} loaded.`);
    }
    booted = true;

    autoReadArmed = true;
    document.title = `${TITLE_OF[slug]} — The Linux Deep Dive`;
    lastSlug = slug;              // only a chapter that actually rendered counts as loaded
    preloadNeighbours(slug);      // ←/→ from here should not have to wait
  } catch (err) {
    if (token !== renderToken) return;
    clearTimeout(placeholderTimer);
    placeholderTimer = null;
    lastSlug = null;              // …so clicking the same entry again retries instead of no-oping
    renderLoadError(slug, anchor, err);
  }
}

function renderLoadError(slug, anchor, err) {
  articleEl.className = "article";
  articleEl.innerHTML =
    `<h1>Couldn't load this page</h1>
     <p>Failed to fetch <code>content/${slug}.md</code> (${err.message}).</p>
     <p class="error-actions">
       <button id="retry-load" class="btn-primary" type="button">Try again</button>
       <a class="error-home" href="#/course">Course home</a>
     </p>
     <p>If you opened <code>index.html</code> directly from disk, the browser
     blocks local <code>fetch()</code> calls. Serve the folder instead:</p>
     <pre><code>cd LinuxKernelDeepDive-Web
python3 -m http.server 8000</code></pre>
     <p>…then visit <a href="http://localhost:8000">http://localhost:8000</a>.</p>`;
  document.getElementById("retry-load")
    .addEventListener("click", () => loadChapter(slug, anchor));
  renderPager(slug);              // a dead end otherwise: keep prev/next reachable
  if (pageTocEl) pageTocEl.innerHTML = "";
  if (window.ReaderUI) {
    ReaderUI.setTopbarTitle(TITLE_OF[slug] || "");
    ReaderUI.buildInlineToc([], null, null);
    ReaderUI.announce("This chapter could not be loaded.");
  }
}

/* ---------------- platform landing ----------------
   Reached at the bare "/" (empty hash). Until this existed, "/" *was* the Linux
   course: it owned the domain title, the <title> and the visitor's first
   screen, and the other 37 chapters were discoverable only from the left rail.

   The one thing this page can do that no other page can: all three courses keep
   their completion in localStorage on the same origin, so this is the only
   place that can answer "where am I across the whole site".

   A 0% ring is a hole for a first-time visitor, so a course that has not been
   started shows its size and reading time instead of an empty donut. */

function renderPlatform() {
  renderToken += 1;
  clearTimeout(placeholderTimer);
  placeholderTimer = null;
  markActive(null);
  lastSlug = null;
  autoReadArmed = false;
  document.title = "How Systems Really Work — three courses on Linux, distributed systems and LLM inference";

  const rows = COURSES.map(c => {
    const done  = Math.min(c.progress(), c.total);
    const pct   = Math.round((done / c.total) * 100);
    const R = 26, CIRC = 2 * Math.PI * R;
    const meter = done > 0
      ? `<div class="course-ring" role="img" aria-label="${pct}% of ${c.name} complete">
           <svg viewBox="0 0 64 64" width="64" height="64">
             <circle cx="32" cy="32" r="${R}" class="ring-track"/>
             <circle cx="32" cy="32" r="${R}" class="ring-fill"
                     stroke-dasharray="${CIRC.toFixed(1)}"
                     stroke-dashoffset="${(CIRC - (pct / 100) * CIRC).toFixed(1)}"
                     transform="rotate(-90 32 32)"/>
           </svg>
           <span class="course-ring-label" aria-hidden="true"
             ><b>${pct}<span>%</span></b></span>
         </div>`
      : `<div class="course-meter">
           <span class="course-meter-n">${c.total}</span>
           <span class="course-meter-l">chapters</span>
         </div>`;
    return `
      <a class="course-card" href="${c.href}">
        ${meter}
        <span class="course-card-body">
          <span class="course-card-title">${c.name}</span>
          <span class="course-card-desc">${c.blurb}</span>
          <span class="course-card-meta">${done > 0
            /* the ring shows the share, so the meta line keeps the size of the
               course: "2 of 56 read" left a started card unable to say how big
               it is, which is the one thing an unstarted card does say */
            ? `${done} of ${c.total} chapters read &middot; continue`
            : `~${c.time} of reading`}</span>
        </span>
        <span class="card-arrow" aria-hidden="true">&rarr;</span>
      </a>`;
  }).join("");

  const totalDone = COURSES.reduce((s, c) => s + Math.min(c.progress(), c.total), 0);
  const totalAll  = COURSES.reduce((s, c) => s + c.total, 0);

  articleEl.className = "home platform";
  articleEl.innerHTML = `
      <header class="hero platform-hero">
        <div class="hero-text">
          <p class="hero-kicker">Three self-paced courses &middot; ${totalAll} chapters</p>
          <h1>How systems really work</h1>
          <p class="hero-lede">
            Three courses on the machinery you are allowed to look at, each one
            built from first principles and read in the browser: the Linux
            kernel beneath your command line, the algorithms that keep many
            machines in agreement, and the systems that serve large language
            models on GPUs. No account, no sign-up, no build step — plain
            Markdown, rendered here.
          </p>
          ${totalDone > 0
            ? `<p class="hero-hint">${totalDone} of ${totalAll} chapters read across the three courses.</p>`
            : `<p class="hero-hint">Your place is kept in this browser.</p>`}
        </div>
      </header>

      <div class="course-cards">${rows}</div>

      <p class="path-legend">Each course stands on its own and can be read
        first. They do cross-reference each other where the same problem shows
        up twice &mdash; a page fault, a replicated log, a cache that decides
        how many users fit on one machine.</p>`;

  void articleEl.offsetWidth;
  articleEl.classList.add("fade-in");

  pagerEl.innerHTML = "";
  if (pageTocEl) pageTocEl.innerHTML = "";
  if (window.ReaderUI) {
    ReaderUI.setTopbarTitle("All courses");
    ReaderUI.buildInlineToc([], null, null);
    if (booted) { ReaderUI.focusMain(); ReaderUI.announce("All courses loaded."); }
  }

  if (!booted) restoreScroll(PLATFORM_KEY);
  else window.scrollTo({ top: 0, behavior: "instant" });
  booted = true;
}

/* ---------------- course home ----------------
   What this book is, how far you are through it, and every chapter on one map.
   Reached at #/course — it moved off the bare "/" when the platform landing
   page took that slot. Every #/<slug> chapter link is unaffected. */

function renderHome() {
  /* Returning home is also a navigation: invalidate any chapter fetch and
     its delayed placeholder before either can replace the home view. */
  renderToken += 1;
  clearTimeout(placeholderTimer);
  placeholderTimer = null;
  markActive(null);
  lastSlug = null;                    // the home view replaces the article element
  autoReadArmed = false;
  document.title = "The Linux Deep Dive — How Your System Really Works";

  const set  = readSet();
  const done = FLAT.filter(ch => set.has(ch.slug)).length;
  const pct  = Math.round((done / FLAT.length) * 100);
  const next = nextUnread();
  const started = done > 0;

  /* progress ring geometry */
  const R = 52, C = 2 * Math.PI * R;
  const offset = C - (pct / 100) * C;

  let n = 0;
  const parts = BOOK.map((part, pi) => {
    const chapters = part.chapters.map(ch => {
      n += 1;
      const doneCls = set.has(ch.slug) ? " done" : "";
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
    const count = part.chapters.length;
    return `
      <section class="module">
        <header class="module-head">
          <span class="module-index">${String(pi + 1).padStart(2, "0")}</span>
          <div>
            <h2>${part.part}</h2>
            <p class="module-blurb">${part.blurb}</p>
          </div>
          <span class="lvl-badge">${count} chapter${count > 1 ? "s" : ""}</span>
        </header>
        <div class="chapter-grid">${chapters}</div>
      </section>`;
  }).join("");

  articleEl.className = "home";
  articleEl.innerHTML = `
      <header class="hero">
        <div class="hero-text">
          <p class="hero-kicker">A field guide · ${FLAT.length} chapters · Linux 6.12</p>
          <h1>The Linux Deep Dive</h1>
          <p class="hero-lede">
            Everything above the command line is built on machinery you are
            allowed to look at. This book connects the behaviour you already
            see — a process that hangs, a container that starts, a page fault,
            a checkpointed job coming back on another host — to the kernel code
            responsible for it, naming the structures, quoting the interfaces
            and pointing at the source. Read it in order, or take one of the
            six paths through it.
          </p>
          <div class="hero-actions">
            <a class="btn-primary" href="#/${next.slug}">
              ${started ? "Continue — " + next.title : "Start reading"}
            </a>
            <span class="hero-hint">${started
              ? `${done} of ${FLAT.length} chapters read`
              : "No account, no sign-up — your place is kept in this browser"}</span>
          </div>
        </div>
        <div class="hero-ring" role="img" aria-label="${pct}% of the book read">
          <svg viewBox="0 0 120 120" width="132" height="132">
            <circle cx="60" cy="60" r="${R}" class="ring-track"/>
            <circle cx="60" cy="60" r="${R}" class="ring-fill"
                    stroke-dasharray="${C.toFixed(1)}"
                    stroke-dashoffset="${offset.toFixed(1)}"
                    transform="rotate(-90 60 60)"/>
          </svg>
          <div class="ring-label"><strong>${pct}%</strong><span>read</span></div>
        </div>
      </header>

      <p class="path-legend">Chapters tick themselves off when you reach the end of one,
        and the control at the top of every chapter marks one by hand. (The two guided
        courses in the sidebar work differently: there, a chapter counts as complete once
        you pass its end-of-chapter quiz.)</p>

      ${parts}`;

  /* replay the entrance animation on every visit to the home route */
  void articleEl.offsetWidth;
  articleEl.classList.add("fade-in");

  pagerEl.innerHTML = "";
  if (pageTocEl) pageTocEl.innerHTML = "";
  if (window.ReaderUI) {
    ReaderUI.setTopbarTitle("Course home");
    ReaderUI.buildInlineToc([], null, null);
    if (booted) { ReaderUI.focusMain(); ReaderUI.announce("Course home loaded."); }
  }

  if (!booted) restoreScroll(HOME_KEY);                    // reload: keep your place
  else window.scrollTo({ top: 0, behavior: "instant" });
  booted = true;
}

/* The sticky "Contents" bar is 3.25rem tall on a phone and the old -24px
   offset put every deep-linked heading 33px behind it. --sticky-h is the
   single source for that number now (0 on wide screens). */
function stickyOffset() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--sticky-h");
  return (parseFloat(v) || 0) + 16;
}

function scrollToAnchor(anchor) {
  const el = document.getElementById(anchor);
  if (el) {
    const y = el.getBoundingClientRect().top + window.scrollY - stickyOffset();
    window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
  }
}

/* ---------------- mobile / tablet nav drawer ---------------- */

const scrimEl = document.getElementById("sidebar-scrim");

let drawerWasOpen = false;

function setSidebar(open) {
  sidebarEl.classList.toggle("open", open);
  document.body.classList.toggle("nav-open", open);
  toggleEl.setAttribute("aria-expanded", String(open));
  /* Opening left focus on <body> and closing left it nowhere, so Escape
     out of the drawer restarted the tab order at stop #1. */
  if (open === drawerWasOpen || !window.ReaderUI) return;
  drawerWasOpen = open;
  if (open) ReaderUI.openDrawer(sidebarEl, toggleEl);
  else ReaderUI.closeDrawer();
}

function route() {
  const r = currentRoute();
  setShellContext(r.kind);
  if (r.kind === "platform")   renderPlatform();
  else if (r.kind === "home")  renderHome();
  else loadChapter(r.slug, r.anchor);
  setSidebar(false);
}

/* ---------------- full-text search ----------------
   The index is every word of all 56 chapters, which is far too much to read
   on each visit: 56 fetches used to run on the first "/" press, unreported,
   and again on the next page load. It is now built once behind a progress
   bar and kept in localStorage until the assets change. */

const searchModal  = document.getElementById("search-modal");
const searchInput  = document.getElementById("search-input");
const searchList   = document.getElementById("search-results");
let searchIndex    = null;   // [{slug, title, part, text, lower}]
let searchSel      = 0;
let indexBuild     = null;   // the build in flight, so two openings share one
let indexDone      = 0;      // chapters read so far, for the progress bar

const INDEX_KEY = "ldd-search-index-v1";
/* This script's own ?v=, so a deploy that bumps it rebuilds the index. The TTL
   bounds staleness when a chapter changes without one; titles and parts come
   from BOOK, so only the snippets can ever lag, and never by more than a week. */
const INDEX_VERSION = (/[?&]v=([^&]+)/.exec(document.currentScript?.src || "") || [])[1] || "0";
const INDEX_TTL     = 7 * 24 * 60 * 60 * 1000;
/* A cache is never worth a failed progress write: refuse to store a big one,
   and saveReadSet drops it outright if storage ever fills up. */
const INDEX_BUDGET  = 2_000_000;

/* prose only: no fences, no markup punctuation, no link targets */
function indexDoc(ch, md) {
  const text = parseFrontmatter(md).body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|\[\]]/g, " ")
    .replace(/\(https?:[^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { slug: ch.slug, title: ch.title, part: PART_OF[ch.slug] || "", text };
}

/* the lowercased copy the query walks is derived, never stored: it would
   double the size of the cache to save a few milliseconds once */
function hydrateIndex(docs) {
  return docs.map(doc => ({ ...doc, lower: doc.text.toLowerCase() }));
}

function readCachedIndex() {
  try {
    const cached = JSON.parse(localStorage.getItem(INDEX_KEY) || "null");
    if (!cached || cached.v !== INDEX_VERSION || cached.n !== FLAT.length) return null;
    if (!cached.at || Date.now() - cached.at > INDEX_TTL) return null;
    return hydrateIndex(cached.docs);
  } catch { return null; }
}

function writeCachedIndex(docs) {
  const payload = JSON.stringify({
    v: INDEX_VERSION, n: FLAT.length, at: Date.now(),
    docs: docs.map(({ slug, title, part, text }) => ({ slug, title, part, text })),
  });
  if (payload.length > INDEX_BUDGET) return;      // do without rather than hog storage
  try { localStorage.setItem(INDEX_KEY, payload); }
  catch { try { localStorage.removeItem(INDEX_KEY); } catch {} }
}

/* A few workers over one queue instead of 56 fetches at once: the browser
   serialises them anyway, and this leaves room for what the reader asked for. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function buildSearchIndex() {
  if (searchIndex) return searchIndex;
  if (indexBuild) return indexBuild;
  const cached = readCachedIndex();
  if (cached) { searchIndex = cached; return searchIndex; }

  indexDone = 0;
  showIndexProgress();
  indexBuild = (async () => {
    try {
      const docs = await mapLimit(FLAT, 8, async ch => {
        try { return indexDoc(ch, await fetchChapterSource(ch.slug)); }
        catch { return null; }            // a chapter that will not load is not indexed
        finally { indexDone += 1; showIndexProgress(); }
      });
      searchIndex = hydrateIndex(docs.filter(Boolean));
      writeCachedIndex(searchIndex);
      return searchIndex;
    } finally { indexBuild = null; }      // a build that failed must be retryable
  })();
  return indexBuild;
}

function searchQuery(q) {
  if (!searchIndex) return [];          // still indexing — nothing to match yet
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

/* The hint doubles as the progress bar, borrowing the sidebar's own track and
   fill so a first search looks like the rest of the product rather than a hang. */
function indexingHint() {
  const pct = Math.round((indexDone / FLAT.length) * 100);
  return `<li class="search-hint">Reading the book for the first time — this is kept for next time.
     <span class="progress-count">${indexDone} / ${FLAT.length} chapters indexed</span>
     <span class="progress-track"><span class="progress-fill" style="width:${pct}%"></span></span></li>`;
}

function showIndexProgress() {
  if (!searchIndex && searchModal.classList.contains("open")) {
    searchList.innerHTML = indexingHint();
  }
}

function renderSearchResults(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const results = searchQuery(q);
  searchSel = 0;
  if (!searchIndex) {                    // index still building: never claim "no results"
    searchList.innerHTML = indexingHint();
    return;
  }
  if (!q.trim()) {
    searchList.innerHTML = `<li class="search-hint">Type to search all ${FLAT.length} chapters.</li>`;
    return;
  }
  if (!results.length) {
    searchList.innerHTML = `<li class="search-hint">No results for “${q}”.</li>`;
    return;
  }
  searchList.innerHTML = results.map((r, i) =>
    `<li id="sr-${i}" class="search-result${i === 0 ? " selected" : ""}"
         role="option" aria-selected="${i === 0}" data-slug="${r.doc.slug}">
       <span class="sr-title">${r.doc.title}</span>
       ${r.doc.part ? `<span class="sr-part">${r.doc.part}</span>` : ""}
       <span class="sr-snippet">${snippet(r.doc, r.firstHit, terms)}</span>
     </li>`).join("");
  searchList.querySelectorAll(".search-result").forEach(li => {
    li.addEventListener("click", () => {
      closeSearch();
      location.hash = `#/${li.dataset.slug}`;
    });
  });
  syncSearchSelection();
  /* nothing used to be announced at all: a screen-reader user typed a
     query and heard silence */
  if (window.ReaderUI) {
    ReaderUI.announce(`${results.length} result${results.length === 1 ? "" : "s"} for ${q}.`);
  }
}

/* keep the visual selection, aria-selected and aria-activedescendant in step */
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

async function openSearch() {
  if (searchModal.classList.contains("open")) return;
  searchModal.hidden = false;
  searchModal.classList.add("open");
  searchInput.value = "";
  /* trap first, so the element focus returns to is the one that opened it */
  if (window.ReaderUI) ReaderUI.trapFocus(searchModal, document.getElementById("search-open"));
  searchInput.focus();
  /* Read the cache before the first paint of the modal: a returning reader
     should never see the indexing hint at all. */
  if (!searchIndex) searchIndex = readCachedIndex();
  renderSearchResults("");
  await buildSearchIndex();
  renderSearchResults(searchInput.value);   // honour anything typed while indexing
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
    /* code blocks and wide tables are focusable scroll regions now, and
       ←/→ is how you scroll them — turning the page instead would lose
       the reader's place */
    if (window.ReaderUI && ReaderUI.inScrollRegion()) return;
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
