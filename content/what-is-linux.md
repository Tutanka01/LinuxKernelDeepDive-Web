# What Is Linux, Really?

> **Goal of this chapter:** before touching any detail, build the correct mental
> model of what "Linux" is, what an operating system actually does, and how the
> pieces you hear about — kernel, shell, distro, GNU — fit together.

Most people say "Linux" and mean a whole operating system: a desktop, a package
manager, a terminal. Technically, **Linux is only the kernel** — a single
program, booted by your firmware, that runs with total control over the
hardware and stays in charge until you power off.

Everything else — your shell, your editor, `ls`, Docker, Firefox — is just
**user-space programs** that politely ask the kernel for services.

## What problem does a kernel solve?

Imagine a computer with no operating system. A program running on it would
have to:

- know the exact model of your disk controller to read a file,
- manage every byte of RAM by hand, hoping no other program touches it,
- own the whole CPU — no other program could run at the same time,
- speak raw Ethernet frames to use the network.

And nothing would stop a buggy program from overwriting another program's
memory, or the disk's partition table. Early personal computers (MS-DOS era)
worked almost exactly like this.

A kernel solves this with three big ideas:

### 1. Abstraction
The kernel hides messy hardware behind clean, uniform interfaces. You don't
read "sector 81,344 of the NVMe drive"; you read `/home/you/notes.txt`. You
don't program a network card; you open a *socket*. Thousands of different
devices, one stable API.

### 2. Multiplexing (sharing)
You have 1 CPU (ok, maybe 8 cores) and hundreds of processes. The kernel slices
CPU time so each process *believes* it has the machine to itself. Same for
memory: every process sees its own private address space, even though they all
share the same RAM. This illusion is called **virtualization of resources** —
and as we'll see, containers are just this idea pushed further.

### 3. Protection
The CPU itself has privilege levels. The kernel runs in **privileged mode**
(ring 0 on x86); normal programs run in **unprivileged mode** (ring 3). A user
program physically *cannot* talk to hardware or touch other processes' memory —
the CPU forbids it. The only way to get anything done is to ask the kernel via
a **system call**. This is the single most important boundary in the whole
system, and chapter 3 is devoted to it.

## The layered picture

Keep this diagram in your head — the entire site is a guided tour of it,
from bottom to top:

```text
┌─────────────────────────────────────────────────────┐
│  Applications: bash, vim, nginx, dockerd, firefox   │   user space
├─────────────────────────────────────────────────────┤
│  Libraries: glibc, libssl, ...                      │   user space
├──────────────────── system calls ───────────────────┤   ← THE boundary
│                                                     │
│   THE LINUX KERNEL                                  │
│   ├─ Process management & scheduler                 │
│   ├─ Memory management (virtual memory)             │
│   ├─ VFS + filesystems (ext4, xfs, btrfs, ...)      │   kernel space
│   ├─ Networking stack (TCP/IP)                      │
│   ├─ Device drivers                                 │
│   └─ Security: permissions, namespaces, cgroups...  │
├─────────────────────────────────────────────────────┤
│  Hardware: CPU, RAM, disks, NIC, GPU                │
└─────────────────────────────────────────────────────┘
```

Two phrases you'll see constantly:

- **Kernel space** — code running with full privileges: the kernel and its
  modules. One bug here can crash the whole machine (a *kernel panic*).
- **User space** (or *userland*) — everything else. A crash here kills one
  process; the kernel shrugs and moves on.

## So what is a "distro"?

The kernel alone is useless to a human — it boots and then needs programs to
run. A **distribution** (Debian, Ubuntu, Fedora, Arch, Alpine…) is the kernel
*plus* a curated user space:

| Piece | Examples | Role |
|---|---|---|
| Kernel | Linux | Manages hardware & processes |
| C library | glibc, musl | Wraps syscalls into functions like `open()` |
| Core utilities | GNU coreutils, busybox | `ls`, `cp`, `cat`, … |
| Init system | systemd, OpenRC | First process; starts everything else |
| Package manager | apt, dnf, pacman, apk | Installs software |
| Shell | bash, zsh | Your command interpreter |

This is why "Linux" feels so different between Ubuntu and Alpine: the kernel is
essentially the same, the user space around it differs. It's also why container
images can be "Alpine-based" or "Debian-based" while running on the *same*
kernel — hold that thought, it becomes central in Part III.

## A tiny bit of history (it explains the culture)

- **1969–70, Bell Labs:** Ken Thompson and Dennis Ritchie create **Unix**, and
  with it the ideas Linux still lives by: *everything is a file*, small tools
  composed through pipes, a hierarchical filesystem, fork/exec.
- **1983:** Richard Stallman launches **GNU**, rewriting the Unix userland as
  free software — compiler (gcc), shell (bash), coreutils. Missing piece: a
  free kernel.
- **1991:** a Finnish student, **Linus Torvalds**, posts: *"I'm doing a (free)
  operating system (just a hobby, won't be big and professional like gnu)"*.
  GNU userland + Linux kernel = a complete free OS.
- **Today:** Linux runs the overwhelming majority of servers, all of the top
  500 supercomputers, every Android phone, and most of the cloud. The kernel
  is ~40 million lines of C (and now some Rust), developed by thousands of
  contributors.

The Unix heritage matters practically: when something in Linux looks odd,
the answer is often "because Unix did it that way in 1975, and it turned out
to be a great idea" (file descriptors) or "…and we're stuck with it" (signal
semantics).

## "Everything is a file"

The most famous Unix idea deserves a first look right now. Linux exposes an
amazing amount of the system as files:

```bash
cat /proc/cpuinfo          # your CPU, as a text file
cat /proc/uptime           # seconds since boot
echo hello > /dev/null     # a device that discards everything
ls -l /dev/sda             # your disk, as a file
cat /sys/class/net/eth0/address   # your MAC address
```

`/proc` and `/sys` aren't real files on disk — they're **virtual filesystems**:
windows directly into live kernel data structures. Reading
`/proc/cpuinfo` executes kernel code that formats CPU information as text, on
the fly. This design means *one* set of tools (`cat`, `grep`, `echo`,
permissions) works on files, devices, kernel tunables, and process info alike.

We'll use `/proc` constantly throughout this site — it's the kernel's own
self-documentation.

## Check your understanding

Try answering before moving on:

1. Your text editor wants to save a file. Can it write to the disk directly?
   What must happen instead?
2. Ubuntu and Alpine both run "Linux". What's actually different between them?
3. Why does a segfault in Firefox not crash your machine, while a bug in a
   device driver can?

*(Answers, in order: no — it must issue `write()` system calls and the kernel's
filesystem + driver code performs the I/O; the user space — C library, init,
utilities, package manager — while the kernel is the same project; Firefox runs
unprivileged in its own address space, a driver runs in kernel space with full
privileges.)*

---

**Next:** we press the power button and follow, step by step, everything that
happens until you get a login prompt.
