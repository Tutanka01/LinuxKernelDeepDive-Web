# Deep Dive Courses

Three self-paced systems courses served from a single static site: **The Linux Deep Dive**, **Distributed Systems**, and **Inference Engineering**. Together they contain **104 chapters** of source-level, example-driven material — the kernel machinery beneath the command line, the algorithms that keep many machines in agreement, and the systems that serve large language models on GPUs.

| Course | Chapters | URL | Scope |
|---|---:|---|---|
| The Linux Deep Dive | 67 | `/#/course` | Kernel internals from processes and virtual memory through containers, checkpoint/restore, eBPF and KVM, the GPU–kernel boundary and upstream contribution, pinned to Linux 6.12 |
| Distributed Systems | 13 | `/distributed/` | A guided course from partial failure and logical clocks through replication, consensus and CRDTs |
| Inference Engineering | 24 | `/inference/` | A guided course on LLM serving: the roofline, KV cache, batching, quantization, kernels and disaggregated fleets |

This repository is also the website. Chapters are plain Markdown files under each course's `content/` directory; a small client-side application fetches and renders them with no framework and no build step.

The bare `/` route is a landing page listing all three courses with your progress in each; the Linux course's own chapter map sits one hash away at `/#/course`. Each course is standalone — its own outline, reader, search index, and progress. A course switcher sits at the top of every sidebar.

## Run with Docker

You need Docker Engine with Docker Compose available. From the repository root, run:

```bash
docker compose up --build
```

Then open:

- <http://localhost:8081/> — the landing page, with all three courses
- <http://localhost:8081/#/course> — The Linux Deep Dive
- <http://localhost:8081/distributed/> — Distributed Systems
- <http://localhost:8081/inference/> — Inference Engineering

To run in the background:

```bash
docker compose up --build -d
```

Stop the site with:

```bash
docker compose down
```

The container serves the repository as static files through nginx. The readers load Markdown with `fetch()`, so opening `index.html` directly through a `file://` URL will not work — it needs a server, any server. No internet connection is required: marked, highlight.js and Mermaid are vendored under `assets/vendor/` and served from the same origin as everything else.

## The Linux Deep Dive

A source-level field guide to how Linux works beneath the command line. It connects familiar system behavior to the kernel machinery responsible for it: processes and scheduling, virtual memory, filesystems and storage, networking, containers, checkpoint/restore, virtualization, security, observability, and modern kernel interfaces.

The course is pinned to **Linux kernel 6.12**. Discussions name the relevant structures and functions, link into the matching kernel source, call out version-dependent behavior, and pair explanations with commands and labs that let you inspect the mechanisms on a real system. It also defines six guided reading paths for different goals, including containers, performance, security, kernel development, and checkpoint/restore.

### Curriculum

| Section | Chapters | Topics |
|---|---:|---|
| Start Here | 1 | How the book works, learning paths, levels, and prerequisites |
| Part 0 — Prerequisites | 5 | Assumed knowledge; CPU, memory, and devices; compiled programs; enough C to read kernel code; evidence from man pages, `/proc`, `/sys`, and source |
| Part I — Foundations | 3 | What Linux is, boot, kernel/user-space boundaries, and system calls |
| Part II — Core Kernel Subsystems | 10 | Processes, scheduling, virtual memory, interrupts, timers, VFS, storage, devices, networking, and TCP congestion control |
| Part III — IPC, Signals & Pipes | 2 | Signals, pipes, FIFOs, and Unix sockets |
| Part IV — Containers, From Scratch | 7 | Namespaces, cgroup v2, OverlayFS, hand-built containers, OCI runtimes, and container networking |
| Part V — Checkpoint/Restore | 6 | Process state, CRIU dump and restore, live migration, snapshot models, and GPU checkpointing |
| Part VI — Hardware & Platform | 4 | Power management, NUMA, CPU isolation and real-time operation, and CPU vulnerability mitigations |
| Part VII — Modern Kernel | 5 | eBPF, security and confinement, trusted computing, io_uring, and Rust in the kernel |
| Part VIII — Virtualization | 1 | KVM and hardware-assisted virtualization internals |
| Part IX — Kernel Engineering | 5 | Locks, atomics, RCU, kernel governance, observability, ftrace, and performance methodology |
| Part X — Tools & Going Deeper | 2 | Reading and building the Linux kernel, and getting a patch accepted upstream |
| Part XI — The GPU–Kernel Boundary | 7 | arm64 paging, DMA and the IOMMU, DRM drivers, HMM and device memory, unified memory, GPU allocators, and GPU instrumentation |
| Part XII — Hands-On Labs | 8 | Guided experiments with memory, cgroups, modules, CRIU, userfaultfd, eBPF, and a CUDA checkpoint |
| Reference | 1 | A glossary of kernel and systems terms, listed in this course's outline |

That is **67 entries in total**: the opening guide, five prerequisite chapters, 52 core chapters, eight labs, and the glossary.

### Prerequisites

The course assumes basic Linux terminal fluency: navigating files, running commands, reading errors, editing text, using simple pipes and redirection, installing packages, and connecting over SSH. It does not assume prior kernel development experience.

Part 0 provides the bridge into source-level material. It covers:

- how CPUs execute instructions and interact with memory and devices;
- how source becomes an ELF program and a running process;
- the pointers, structs, function pointers, macros, lists, and bit flags needed to read kernel C; and
- how to use man-page sections, `/proc`, `/sys`, tracing tools, and online kernel source.

Readers already comfortable with C, CPU registers, ELF files, hexadecimal addresses, syscalls, and kernel source navigation can skip Part 0.

Reading the text only requires a modern browser. Following the examples requires a Linux system or VM and common command-line tools. Individual chapters and labs list any additional packages they need.

### Hands-on labs

The eight labs are:

1. **Trigger and autopsy the OOM killer** — create controlled memory pressure and interpret the kernel's decision.
2. **Watch the page cache work** — observe cached file data, dirty pages, writeback, and cache effects.
3. **Throttle a process with cgroup v2** — apply and inspect CPU and memory controls using the cgroup filesystem.
4. **Write, build, and load a kernel module** — use kbuild, module parameters, `/proc`, and kernel logs.
5. **Checkpoint and restore a real process with CRIU** — dump process state, inspect CRIU images, and resume execution.
6. **Serve page faults from userspace** — build a `userfaultfd` handler and connect it to lazy restore and post-copy migration.
7. **Answer a real question with eBPF** — escalate from `bpftrace` one-liners to a libbpf CO-RE ioctl tracer, and read a verifier rejection.
8. **Checkpoint a CUDA process** — three tiers: a GPU-free baseline, an NVIDIA GPU round trip, and the unmeasured unified-memory frontier.

Use a disposable Linux VM for the labs unless a lab explicitly says otherwise. In particular, the OOM and kernel-module exercises can disrupt or crash a system, and privileged containers still share the host kernel. Do not run destructive experiments on a machine whose uptime or data matters.

## Distributed Systems

The `distributed/` directory contains a standalone course rather than an appendix to the Linux guide. Its **13 chapters** progress through five modules:

- **Foundations** — what a distributed system is, hostile networks, partial failure, timeouts and idempotency, failure models from crash-stop to Byzantine, and failure detection;
- **Time & Order** — clock drift, NTP, monotonic versus wall time, happens-before, Lamport and vector clocks, and causality;
- **Data at Scale** — leader-follower and leaderless replication, quorums, consistency models from linearizability to eventual, CAP and PACELC, partitioning, consistent hashing, and hot keys;
- **Coordination** — why agreement is hard, FLP, Paxos intuition, Raft end to end, two-phase commit, sagas, and the exactly-once myth; and
- **Advanced Systems** — CRDTs, gossip and anti-entropy, Merkle trees, and real-world architectures including ZooKeeper/etcd, Kafka, Dynamo, Spanner, and Kubernetes.

Its entry point is `distributed/index.html`, served under `/distributed/`.

## Inference Engineering

The `inference/` directory contains a second standalone guided course, built on the same engine. Its **24 chapters** progress through nine modules:

- **Before we start** (1) — how to read a number in this field: six rules that defuse almost every benchmark claim, before you meet any of them;
- **The Physics** (3) — what actually happens when you call an LLM, tokens and the autoregressive loop, prefill versus decode; the GPU mental model of SMs, HBM, tensor cores and the roofline; and inference arithmetic — KV-cache math, batching, critical batch size, TTFT and TPOT;
- **The Engine** (3) — continuous batching and iteration-level scheduling, chunked prefill and prefill/decode interference; PagedAttention and prefix caching with block tables, copy-on-write and RadixAttention; and the anatomy of a serving engine, inside vLLM and SGLang;
- **Squeezing the Model** (4) — attention architectures for serving from MHA to GQA to MLA, sliding-window and sparse attention and SSM hybrids; quantization in FP8, INT4 and FP4 with its evaluation traps; whether quantization broke your model, and why perplexity lies; and speculative decoding with draft models, EAGLE and MTP;
- **Running It** (3) — sizing a deployment from the five-term memory budget; choosing a model, a GPU and a framework, with the buy-versus-build math; and operating it, from physical metrics through symptoms to causes, autoscaling traps and cold starts;
- **Under the Hood** (2) — FlashAttention and decode kernels, online softmax and tiling, FlashDecoding and FlashInfer; and CUDA graphs, `torch.compile`, Triton versus CUTLASS, MoE kernels and Blackwell;
- **Serving at Scale** (5) — tensor, pipeline, expert and context parallelism; MoE at scale with wide expert parallelism and rack-scale NVLink; disaggregated prefill/decode; the KV fabric of Mooncake, Dynamo and NIXL, KV tiering and cache-aware routing; and the agentic era of cache-hit economics, RL rollouts and multi-LoRA;
- **The Big Picture** (2) — hardware and economics across GPUs, TPUs and SRAM silicon, token prices, margins, benchmarks and energy; and a dated snapshot of the frontier as of mid-2026; and
- **Reference** (1) — a glossary of every acronym in the course, each linked to the chapter that teaches it.

Its entry point is `inference/index.html`, served under `/inference/`. It also ships the only interactive material in the three courses: a KV-cache and deployment-sizing calculator, a roofline explorer, a token-cost calculator, a serving-engine simulator (also hosted full-page at `inference/simulator.html`), and a serving-stack orientation map at the head of every chapter. Each is a placeholder `<div class="inf-widget">` in the Markdown, filled in by the scripts under `inference/assets/`, and each carries a plain-text fallback for readers without JavaScript.

## The GPU–Kernel Track

The `path/` directory holds a **guided track**, not a fourth course. It contains no chapters of its own: it is an ordering of chapters that live in the three courses above, grouped into **six phases over twelve months**, aimed at one specific ambition — knowing exactly what happens between a GPU and the Linux kernel, and turning that into work other people can use.

What distinguishes it from the six reading paths inside the Linux course is the **deliverable** that closes each phase: two annotated functions, a measured checkpoint, an annotated CUDA address space, a profile of a VRAM release-and-reacquire cycle, the unified-memory results table, and a patch accepted upstream. A reading path tracks pages; this tracks artifacts.

Progress works in two directions, and keeping them apart is the design:

- **Chapters tick themselves.** All three courses store reading progress in `localStorage` on the same origin, so the track reads `ldd-read`, `ds-course-progress-v1` and `inf-course-progress-v1` directly. It never writes them — a track is a view over the courses, not a second source of truth.
- **Deliverables you tick yourself**, under the track's own `path-gpu-kernel-deliverables-v1` key. They are the part a reading tracker cannot infer.

Its entry point is `path/index.html`, served under `/path/`. It is reachable from the landing page and from the course switcher in every sidebar.

It runs in the same shell as the three courses, and deliberately borrows their vocabulary rather than inventing a second one: a phase is drawn as a course module, a step as a chapter card, and the rail, drawer, theme switch, progress bar and search modal are the ones every other page has. The search here is over the track's own steps, phases and deliverables — the track holds no prose of its own, and the full-text search of a course lives in that course.

## Features

### Shared by all three courses

- A custom client-side Markdown reader built with vanilla HTML, CSS, and JavaScript, with no build step
- A landing page at `/` listing all three courses, each with its own progress ring
- A course home for each course — what it is, a progress ring, and every chapter on one map — at `/#/course`, `/distributed/` and `/inference/`
- Terminal-style dark and paper-style light themes; the choice carries across courses
- A collapsible sidebar with a cross-course switcher at the top
- Full-text search over the current course's chapters (`/` or `Ctrl/Cmd-K`). Search is per-course: it does not index the other two.
- Keyboard shortcuts: `/` or `Ctrl/Cmd-K` to search, `[` to collapse the sidebar, ←/→ for previous and next chapter, `Esc` to close
- Syntax-highlighted code and a reading-position bar
- Heading anchors, deep links of the form `#/slug@heading`, and an on-page outline rail
- Mermaid diagrams, drawn in the current theme's palette and redrawn when the theme changes, and collapsible review answers
- Responsive navigation for desktop and mobile; wide tables, code blocks and diagrams scroll inside their own region rather than widening the page
- Progress kept in browser local storage, tracked separately per course
- Scroll position kept across reloads, so a refresh does not lose your place
- No third-party requests: marked, highlight.js and Mermaid are vendored under `assets/vendor/`
- Docker deployment with nginx and no application build step

### The Linux Deep Dive only

- Per-chapter frontmatter for difficulty, reading time, verification date, kernel version, and prerequisites
- Reading progress: a chapter is marked read automatically when you reach the end of it, or by hand with the control in the chapter's meta line. The sidebar shows how many of the 67 chapters are read.

### The two guided courses (Distributed Systems, Inference Engineering)

- Completion is gated on a quiz: every chapter ends with a short multiple-choice checkpoint, and answering all of its questions correctly marks the chapter complete. A manual completion toggle is also available. (The glossary in the Inference course is reference material and carries no quiz.)
- Reading time estimated from the chapter text rather than declared in frontmatter
- Per-module difficulty badges, from Beginner to Advanced, on the course home

## Repository layout

```text
.
├── index.html                 Linux course shell
├── assets/
│   ├── style.css              Shared shell: themes, sidebar, article, search, responsive
│   ├── course.css             Shared course-home presentation: hero, progress ring, chapter cards, quizzes
│   ├── app.js                 Linux course: curriculum, router, renderer, search, progress
│   ├── course.js              Shared engine for the two guided courses: router, renderer, quizzes, search, progress
│   ├── reader-ui.js           Shared reader layer used by all three: scroll regions, inline TOC, focus, Mermaid
│   └── vendor/                marked, highlight.js, Mermaid and the two hljs themes, served from this origin
├── content/                   67 Linux course Markdown chapters
├── distributed/
│   ├── index.html             Distributed Systems course shell
│   ├── assets/ds.js           Course data (the COURSE array) and config; loads ../assets/course.js
│   └── content/               13 Distributed Systems chapters
├── inference/
│   ├── index.html             Inference Engineering course shell
│   ├── simulator.html         The serving-engine simulator, hosted full-page
│   ├── assets/
│   │   ├── inf.js             Course data (the COURSE array) and config; loads ../assets/course.js
│   │   ├── inf.css            Course-specific styling for the widgets and diagrams
│   │   ├── inf-widgets.js     Widget host: finds the placeholders a chapter leaves and mounts into them
│   │   ├── inf-calculators.js KV-cache/sizing, roofline and token-cost calculators
│   │   ├── inf-simulator.js   The serving-engine simulator
│   │   ├── inf-stackmap.js    The per-chapter serving-stack orientation map
│   │   └── diagrams/          Hand-drawn SVG figures, themed through CSS custom properties
│   ├── content/               24 Inference Engineering chapters
│   └── research/              Source and style notes; excluded from the image by .dockerignore
├── path/
│   ├── index.html             The GPU–Kernel Track, in the same shell as the three courses
│   └── assets/
│       ├── path.js            The six phases, their steps and deliverables; rail, drawer, search, progress
│       └── path.css           Only what the courses have no equivalent of: the deliverable panel
├── tests/                     Test suite; not part of the served site (see Development)
├── docs/                      Audits and design notes
├── Dockerfile                 nginx-based image
├── docker-compose.yml         Local deployment on port 8081
├── nginx.conf                 Static-site nginx configuration
├── .dockerignore              Keeps notes, tests and tooling out of the image
└── LICENSE                    GNU AGPL v3
```

## Development

### Serving the site

There is nothing to build. Any static server over the repository root will do; the readers only need `fetch()` to work, which a `file://` URL does not provide.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/> for the landing page, or go straight to <http://localhost:8000/#/course>, <http://localhost:8000/distributed/> and <http://localhost:8000/inference/>. `docker compose up --build` does the same thing through nginx on port 8081.

### Running the tests

Everything the tests need lives under `tests/`. Nothing is installed at the repository root: the site stays dependency-free and build-free, which is the point of it.

```bash
./tests/run.sh          # both tiers
./tests/run.sh tier1    # structural only
./tests/run.sh tier2    # browser only
```

**Tier 1 — structural.** Plain Node, no packages, no browser, under a second. It parses the site's own files and asserts the invariants that fail silently in a client-side reader:

- every slug in `assets/app.js`, `distributed/assets/ds.js` and `inference/assets/inf.js` resolves to a Markdown file, and every Markdown file is reachable from its course data — an unregistered chapter has no card, no sidebar entry and no search result, but still ships;
- every `](#/slug)`, `](../#/slug)` and `](../inference/#/slug)` link resolves, and every `](#/slug@heading)` deep link names a heading that the engine's own `slugify()` really produces;
- every ` ```quiz ` fence parses as JSON and matches the schema, with `answer` a valid index into `choices` — `renderQuizzes()` swallows a parse error, and a chapter with a broken quiz can never be completed;
- Linux frontmatter is complete and well formed, and every `requires` names a real chapter;
- the chapter counts in the course data, the three shells, the README and the files on disk all agree;
- no chapter, script or shell references a file that does not exist;
- no Mermaid fence hardcodes a colour or overrides the injected theme;
- nothing is loaded from a CDN.

It can be run directly, without the wrapper:

```bash
cd tests && node --test "tier1/*.test.js"
```

**Tier 2 — browser.** Playwright drives headless Chromium against `python3 -m http.server` on an ephemeral port. It renders **all 104 chapters** and asserts, for each one, that the article holds real content and not the loading placeholder, that `document.title` is the chapter's, that there is exactly one `<h1>` and no heading-level skips, and that nothing was logged to the console or failed on the wire. It then exercises search, deep links, the 375 px layout and the theme toggle on one chapter per course. The whole tier takes about fifteen seconds.

The first run installs Playwright and downloads Chromium (~100 MB) into `tests/node_modules` and the shared Playwright cache; `./tests/run.sh tier2` does this for you.

The placeholder assertion exists for a specific reason. A `setTimeout` in `assets/app.js` once scheduled a "Loading …" placeholder 150 ms into a chapter fetch and never cancelled it, so any fetch that resolved faster — every warm navigation, which is to say every navigation the engine works hardest to optimise — had its finished chapter overwritten by the placeholder, taking the pager and the on-page rail with it. Nothing threw and nothing logged. `tests/tier2/detector.spec.js` reproduces that corruption in a live page on every run, purely to prove the detector still detects it.

Both tiers run in CI on every push and pull request (`.github/workflows/tests.yml`).

## Contributing

Corrections, clearer explanations, stronger diagrams, reproducible examples, and new lab improvements are welcome. Keep contributions concrete and verifiable: this project aims to explain what systems actually do, not merely repeat an abstraction.

### For a Linux chapter

1. Edit or add a Markdown file under `content/`.
2. Include the chapter frontmatter fields used by the reader: `level`, `kernel`, `verified`, `minutes`, and `requires`.
3. For a new chapter, register its slug and title in the `BOOK` array near the top of `assets/app.js`.
4. Link kernel identifiers to the Linux 6.12 source where practical, and state clearly when behavior is architecture-, configuration-, or version-dependent.
5. Test commands in a clean environment. Mark privileged or destructive steps prominently and recommend a disposable VM when appropriate.
6. Run `./tests/run.sh` (see [Development](#development)) and then the site itself, and check navigation, theme behavior, diagrams, links, search, and mobile layout before submitting the change.

### For a Distributed Systems or Inference Engineering chapter

1. Edit or add a Markdown file under `distributed/content/` or `inference/content/`. These chapters carry no frontmatter; they open with an `# H1` title and reading time is computed from the text.
2. For a new chapter, register its `slug`, `title`, and `desc` in the `COURSE` array at the top of `distributed/assets/ds.js` or `inference/assets/inf.js`, inside the module it belongs to. The `desc` is what the chapter card shows on the course home.
3. End the chapter with a ` ```quiz ` fenced block holding a JSON array of questions. `answer` is a zero-based index into `choices`, and `explain` is revealed after the reader checks their answers:

   ````markdown
   ```quiz
   [
     {
       "q": "Why are Raft election timeouts randomized?",
       "choices": [
         "To make elections cryptographically unpredictable",
         "So split votes become rare and self-resolving",
         "To spread CPU load across the cluster",
         "Because identical timeouts would violate one-vote-per-term"
       ],
       "answer": 1,
       "explain": "Randomization staggers candidacies, letting one node solicit votes before its rivals wake."
     }
   ]
   ```
   ````

4. Write questions that fail an unprepared reader: every question must be answered correctly to complete the chapter, so avoid choices that are guessable from wording alone.
5. Mermaid is available in all three courses; it is fetched the first time a rendered chapter actually contains a diagram. A fence must not set its own colours — no `%%{init}%%` directive, no `classDef`, no `style … fill:`, no hex literals. The reader injects the current theme's palette and redraws every diagram when the theme changes, and a hardcoded colour breaks one of the two themes for everyone.
6. Run the test suite (see [Development](#development)) and the Docker deployment, and check the course home, the progress ring, quiz grading, search, navigation, and mobile layout before submitting the change.

Please keep prose direct, technical, and approachable. Prefer an observable example, named data structure, code path, or primary source over an unsupported generalization.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
