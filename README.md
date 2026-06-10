# The Linux Deep Dive

A personal, blog-style website that teaches how Linux really works — from the
boot process and kernel subsystems all the way to how containers are
assembled from kernel primitives (namespaces, cgroups, OverlayFS, seccomp).

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

## Structure

```
index.html          the single page (sidebar + article shell)
assets/style.css    dark, warm, slightly retro theme
assets/app.js       chapter list (BOOK) + tiny markdown router
content/*.md        the chapters — one Markdown file each
```

## Add or edit a chapter

1. Create/edit a Markdown file in `content/`, e.g. `content/my-topic.md`.
   Start it with a single `# Title` heading.
2. Register it in the `BOOK` array at the top of `assets/app.js`
   (slug = filename without `.md`).
3. Refresh. That's it.

## Curriculum

- **Part I — Foundations:** what Linux is, the boot process, kernel vs user
  space and system calls.
- **Part II — Core Kernel Subsystems:** processes, scheduling, virtual
  memory, filesystems/VFS, devices & modules, networking.
- **Part III — Containers, From Scratch:** what a container actually is,
  namespaces, cgroups v2, images & OverlayFS, building a container by hand,
  the runtime stack (Docker/containerd/runc), container networking.
- **Part IV — Tools & Going Deeper:** observability (/proc, strace, perf,
  eBPF) and reading/building the kernel itself.

Rendering: [marked](https://github.com/markedjs/marked) +
[highlight.js](https://highlightjs.org/) from CDN.
