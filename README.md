# The Linux Deep Dive

A personal, book-style website that teaches how Linux really works — from the
boot process and kernel subsystems all the way down to the source code, and
up to how containers are assembled from kernel primitives (namespaces,
cgroups, OverlayFS, seccomp), how CRIU checkpoints and migrates their process
state, and why GPU state needs driver cooperation.

All content is written in plain **Markdown** (`content/*.md`) and rendered
client-side. No build step, no framework, no dependencies to install.

## Run it

Any static file server works. The simplest:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

> Opening `index.html` directly from disk won't work — browsers block
> `fetch()` on `file://` URLs, and the site fetches the Markdown chapters.

## Features

- **Full-text search** across all chapters — press `/` or `Cmd/Ctrl-K`.
- **Deep links** — every heading gets an anchor (`#/memory@the-page-cache`).
- **"On this page" rail** with scroll-spy on wide screens.
- **Reading progress** — chapters are checked off in `localStorage`; a chapter
  marks itself read when you reach the end.
- **Levels & prerequisites** — each chapter declares a level
  (`fundamentals` / `mechanism` / `internals`) and its prerequisite chapters,
  shown as a banner under the title.
- **Quizzes with hidden answers** — every chapter ends with
  "Check your understanding"; answers are collapsed until you click.
- **Follow the code** — chapters trace real code paths with links into the
  kernel source ([elixir.bootlin.com](https://elixir.bootlin.com)), pinned to
  **kernel v6.12 (LTS)**.
- **Hands-on labs** — Part XI breaks things on purpose (OOM killer, page
  cache, cgroup throttling, CRIU, userfaultfd, your first kernel module) in a
  disposable VM.
- **Mermaid diagrams**, keyboard navigation (`←`/`→` between chapters).

## Structure

```
index.html          the single page (sidebar + article shell + search modal)
assets/style.css    dark, warm, slightly retro theme
assets/app.js       chapter list (BOOK) + markdown engine v2
content/*.md        the chapters — one Markdown file each
```

## Add or edit a chapter

1. Create/edit a Markdown file in `content/`, e.g. `content/my-topic.md`.
   Start it with the frontmatter block, then a single `# Title` heading:

   ```markdown
   ---
   level: core | mechanism | internals
   kernel: 6.12
   verified: 2026-07
   minutes: 18
   requires: comma-separated, chapter-slugs
   ---

   # My Topic
   ```

2. Register it in the `BOOK` array at the top of `assets/app.js`
   (slug = filename without `.md`).
3. Refresh. That's it.

House conventions: quiz answers go inside `<details><summary>Show answer</summary>…</details>`
blocks (blank lines around the answer body); kernel identifiers link to
`https://elixir.bootlin.com/linux/v6.12/C/ident/<name>`; cross-chapter links
use `[Title](#/slug)`.

## Curriculum (51 chapters)

- **Start Here (1):** how to use this book — levels, prerequisites, and six
  guided paths (understand your machine · containers & cloud · performance &
  SRE · security · future kernel contributor · runtime internals,
  checkpoint/restore & GPU).
- **Part I — Foundations (3):** what Linux is, the boot process, kernel vs
  user space and system calls.
- **Part II — Core Kernel Subsystems (10):** processes, scheduling, virtual
  memory, interrupts & softirqs, timers & tickless, filesystems/VFS, the
  storage stack, devices & modules, networking, TCP congestion control.
- **Part III — IPC, Signals & Pipes (2):** signals; pipes, FIFOs and Unix
  domain sockets.
- **Part IV — Containers, From Scratch (7):** what a container actually is,
  namespaces, cgroups v2, images & OverlayFS, building a container by hand,
  the runtime stack (Docker/containerd/runc), container networking.
- **Part V — Checkpoint/Restore (6):** process-state anatomy, CRIU dump and
  restore, iterative/lazy live migration and TCP repair, snapshot taxonomy,
  and GPU checkpointing with CUDA/AMDGPU plugins.
- **Part VI — Hardware & Platform (4):** power management, NUMA, CPU
  isolation & real-time, CPU vulnerability mitigations.
- **Part VII — Modern Kernel (5):** eBPF internals, security & confinement,
  trusted computing, io_uring, Rust in the kernel.
- **Part VIII — Virtualization (1):** KVM internals.
- **Part IX — Kernel Engineering (4):** synchronization (locks, atomics,
  RCU), how the kernel is made, observability, and performance methodology.
- **Part X — Tools & Going Deeper (1):** reading & building the kernel.
- **Part XI — Hands-On Labs (6):** trigger & autopsy the OOM killer, watch
  the page cache work, throttle a process with cgroup v2, write & load a
  kernel module, checkpoint/restore a process with CRIU, and serve page faults
  with userfaultfd.
- **Reference (1):** glossary.

Rendering: [marked](https://github.com/markedjs/marked) +
[highlight.js](https://highlightjs.org/) +
[mermaid](https://mermaid.js.org/) from CDN.
