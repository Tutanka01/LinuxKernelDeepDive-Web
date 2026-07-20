# The Linux Deep Dive

The Linux Deep Dive is a source-level field guide to how Linux works beneath the command line. It connects familiar system behavior to the kernel machinery responsible for it: processes and scheduling, virtual memory, filesystems and storage, networking, containers, checkpoint/restore, virtualization, security, observability, and modern kernel interfaces.

The guide contains **56 chapters** and is pinned to **Linux kernel 6.12**. Discussions name the relevant structures and functions, link into the matching kernel source, call out version-dependent behavior, and pair explanations with commands and labs that let you inspect the mechanisms on a real system.

This repository is also the website. Chapters are plain Markdown files under `content/`; a small client-side application loads and renders them without a framework or build step.

## Features

- A 56-chapter curriculum, from hardware and C prerequisites through kernel internals and hands-on labs
- Source-level explanations and links pinned to Linux 6.12
- A custom client-side Markdown reader built with vanilla HTML, CSS, and JavaScript
- Full-text chapter search (`/` or `Ctrl/Cmd-K`)
- Heading anchors, deep links, an on-page outline, and previous/next keyboard navigation
- Terminal-style dark and paper-style light themes
- Per-chapter metadata for difficulty, reading time, verification date, kernel version, and prerequisites
- Reading progress stored locally in the browser
- Syntax-highlighted code, Mermaid diagrams, and collapsible review answers
- Responsive navigation for desktop and mobile
- Six guided learning paths for different goals, including containers, performance, security, kernel development, and checkpoint/restore
- Six practical labs designed to turn kernel behavior into observable evidence
- Docker deployment with nginx and no application build step
- A separate 13-chapter distributed systems course included in the same deployment

## Run with Docker

You need Docker Engine with Docker Compose available. From the repository root, run:

```bash
docker compose up --build
```

Open <http://localhost:8081> for the Linux course. The distributed systems course is available at <http://localhost:8081/distributed/>.

To run in the background:

```bash
docker compose up --build -d
```

Stop the site with:

```bash
docker compose down
```

The container serves the repository as static files through nginx. The reader loads Markdown with `fetch()`, so opening `index.html` directly through a `file://` URL will not work. An internet connection is also required for the CDN-hosted copies of marked, highlight.js, and Mermaid.

## Curriculum overview

The main curriculum is organized as follows:

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
| Part IX — Kernel Engineering | 4 | Locks, atomics, RCU, kernel governance, observability, and performance methodology |
| Part X — Tools & Going Deeper | 1 | Reading and building the Linux kernel |
| Part XI — Hands-On Labs | 6 | Guided experiments with memory, cgroups, modules, CRIU, and userfaultfd |
| Reference | 1 | A cross-course glossary |

That is **56 entries in total**: the opening guide, five prerequisite chapters, 43 core chapters, six labs, and the glossary.

## Prerequisites

The course assumes basic Linux terminal fluency: navigating files, running commands, reading errors, editing text, using simple pipes and redirection, installing packages, and connecting over SSH. It does not assume prior kernel development experience.

Part 0 provides the bridge into source-level material. It covers:

- how CPUs execute instructions and interact with memory and devices;
- how source becomes an ELF program and a running process;
- the pointers, structs, function pointers, macros, lists, and bit flags needed to read kernel C; and
- how to use man-page sections, `/proc`, `/sys`, tracing tools, and online kernel source.

Readers already comfortable with C, CPU registers, ELF files, hexadecimal addresses, syscalls, and kernel source navigation can skip Part 0.

Reading the text only requires a modern browser. Following the examples requires a Linux system or VM and common command-line tools. Individual chapters and labs list any additional packages they need.

## Hands-on labs

The six labs are:

1. **Trigger and autopsy the OOM killer** — create controlled memory pressure and interpret the kernel's decision.
2. **Watch the page cache work** — observe cached file data, dirty pages, writeback, and cache effects.
3. **Throttle a process with cgroup v2** — apply and inspect CPU and memory controls using the cgroup filesystem.
4. **Write, build, and load a kernel module** — use kbuild, module parameters, `/proc`, and kernel logs.
5. **Checkpoint and restore a real process with CRIU** — dump process state, inspect CRIU images, and resume execution.
6. **Serve page faults from userspace** — build a `userfaultfd` handler and connect it to lazy restore and post-copy migration.

Use a disposable Linux VM for the labs unless a lab explicitly says otherwise. In particular, the OOM and kernel-module exercises can disrupt or crash a system, and privileged containers still share the host kernel. Do not run destructive experiments on a machine whose uptime or data matters.

## Distributed Systems course

The `distributed/` directory contains a standalone course rather than an appendix to the Linux guide. Its **13 chapters** progress through five modules:

- distributed-system fundamentals, hostile networks, partial failure, and failure detection;
- physical time, clock behavior, logical clocks, vector clocks, and causality;
- replication, consistency models, CAP/PACELC, partitioning, and sharding;
- consensus, Paxos intuition, Raft, and distributed transactions; and
- CRDTs, gossip, anti-entropy, and real-world architectures such as etcd, Kafka, Dynamo, Spanner, and Kubernetes.

The course has its own reader, navigation, quizzes, reading-time estimates, and browser-local completion tracking. Its entry point is `distributed/index.html`, and Docker serves it under `/distributed/`.

## Repository layout

```text
.
├── index.html                 Main Linux course shell
├── assets/
│   ├── app.js                 Curriculum, router, renderer, search, and progress
│   └── style.css              Responsive terminal and paper themes
├── content/                   56 Linux course Markdown chapters
├── distributed/
│   ├── index.html             Distributed systems course shell
│   ├── assets/                Course-specific reader and styles
│   └── content/               13 distributed systems chapters
├── Dockerfile                 nginx-based image
├── docker-compose.yml         Local deployment on port 8081
└── nginx.conf                 Static-site nginx configuration
```

## Contributing

Corrections, clearer explanations, stronger diagrams, reproducible examples, and new lab improvements are welcome. Keep contributions concrete and verifiable: this project aims to explain what the kernel actually does, not merely repeat an abstraction.

For a Linux chapter:

1. Edit or add a Markdown file under `content/`.
2. Include the chapter frontmatter fields used by the reader: `level`, `kernel`, `verified`, `minutes`, and `requires`.
3. For a new chapter, register its slug and title in the `BOOK` array near the top of `assets/app.js`.
4. Link kernel identifiers to the Linux 6.12 source where practical, and state clearly when behavior is architecture-, configuration-, or version-dependent.
5. Test commands in a clean environment. Mark privileged or destructive steps prominently and recommend a disposable VM when appropriate.
6. Run the Docker deployment and check navigation, theme behavior, diagrams, links, search, and mobile layout before submitting the change.

For the distributed systems course, chapters live in `distributed/content/` and the course registry is the `COURSE` array in `distributed/assets/ds.js`.

Please keep prose direct, technical, and approachable. Prefer an observable example, named data structure, code path, or primary source over an unsupported generalization.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
