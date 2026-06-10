/* ============================================================
   The Linux Deep Dive — tiny markdown blog engine.
   No build step: chapters live in /content as plain .md files,
   fetched and rendered client-side with marked + highlight.js.
   ============================================================ */

const BOOK = [
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
      { slug: "filesystems",          title: "Files, Filesystems & the VFS" },
      { slug: "devices-modules",      title: "Devices, Drivers & Modules" },
      { slug: "networking",           title: "The Networking Stack" },
    ],
  },
  {
    part: "Part III — Containers, From Scratch",
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
    part: "Part IV — Modern Kernel Mechanisms",
    chapters: [
      { slug: "ebpf-internals",       title: "eBPF Internals" },
      { slug: "security-hardening",   title: "Linux Security & Confinement" },
      { slug: "modern-io",            title: "Modern I/O & io_uring" },
    ],
  },
  {
    part: "Part V — Tools & Going Deeper",
    chapters: [
      { slug: "observability",        title: "/proc, strace, perf & eBPF" },
      { slug: "kernel-dev",           title: "Reading & Building the Kernel" },
    ],
  },
];

/* flat ordered list used for routing and prev/next */
const FLAT = BOOK.flatMap(p => p.chapters);
const HOME_SLUG = FLAT[0].slug;

const tocEl     = document.getElementById("toc");
const articleEl = document.getElementById("article");
const pagerEl   = document.getElementById("pager");
const sidebarEl = document.getElementById("sidebar");
const toggleEl  = document.getElementById("sidebar-toggle");

marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return code;
  },
});

function buildToc() {
  let n = 0;
  tocEl.innerHTML = BOOK.map(part => {
    const items = part.chapters.map(ch => {
      n += 1;
      return `<li><a href="#/${ch.slug}" data-slug="${ch.slug}">` +
             `<span class="toc-num">${n}</span>${ch.title}</a></li>`;
    }).join("");
    return `<p class="toc-part">${part.part}</p><ul class="toc-list">${items}</ul>`;
  }).join("");
}

function currentSlug() {
  const hash = location.hash.replace(/^#\/?/, "").trim();
  return FLAT.some(ch => ch.slug === hash) ? hash : HOME_SLUG;
}

function markActive(slug) {
  tocEl.querySelectorAll("a").forEach(a => {
    a.classList.toggle("active", a.dataset.slug === slug);
  });
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

async function loadChapter(slug) {
  markActive(slug);
  try {
    const res = await fetch(`content/${slug}.md`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    articleEl.innerHTML = marked.parse(md);
    articleEl.querySelectorAll("pre code").forEach(el => hljs.highlightElement(el));
    renderPager(slug);
    window.scrollTo(0, 0);
    const ch = FLAT.find(c => c.slug === slug);
    document.title = `${ch.title} — The Linux Deep Dive`;
  } catch (err) {
    articleEl.innerHTML =
      `<h1>Couldn’t load this page</h1>
       <p>Failed to fetch <code>content/${slug}.md</code> (${err.message}).</p>
       <p>If you opened <code>index.html</code> directly from disk, the browser
       blocks local <code>fetch()</code> calls. Serve the folder instead:</p>
       <pre><code>cd LinuxKernelDeepDive-Web
python3 -m http.server 8000</code></pre>
       <p>…then visit <a href="http://localhost:8000">http://localhost:8000</a>.</p>`;
  }
}

function route() {
  loadChapter(currentSlug());
  sidebarEl.classList.remove("open");
}

toggleEl.addEventListener("click", () => sidebarEl.classList.toggle("open"));
window.addEventListener("hashchange", route);

buildToc();
route();
