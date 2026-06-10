# What Is Linux, Really?

> **Goal of this chapter:** before touching any detail, build the correct mental
> model of what "Linux" is, what an operating system actually does, and how the
> pieces you hear about — kernel, shell, distro, GNU — fit together. By the end
> you'll know what the kernel binary actually contains, how it talks to the
> hardware, and why the whole cloud runs on it.

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

This is deeper than just "wrapping" hardware. The kernel invents entirely new
concepts the hardware doesn't know about:

- **Files and directories** — a disk is just a giant array of sectors; the
  kernel's VFS layer gives you a tree of named files with permissions.
- **Processes** — the CPU has no built-in "process." The kernel creates this
  abstraction: a private address space, a PID, a state (running, sleeping,
  zombie), all tracked in a `struct task_struct`.
- **Pipes and sockets** — the hardware only knows about memory and network
  packets; the kernel invents byte streams between processes.
- **Threads** — to the CPU, they're just instruction streams; the kernel
  schedules them and makes them share memory.

Each abstraction is a kernel subsystem, and Parts II through IV of this site
are a tour of them one by one.

### 2. Multiplexing (sharing)

You have 1 CPU (ok, maybe 8 cores) and hundreds of processes. The kernel slices
CPU time so each process *believes* it has the machine to itself. It does this
by **context switching**: the kernel saves one process's register file, stack
pointer, and program counter, then loads another's — and the CPU resumes as if
it never left. This happens hundreds of times per second, invisible to the
programs.

The same trick applies to memory: every process sees its own private address
space, even though they all share the same RAM. The hardware **MMU** (Memory
Management Unit) rewrites virtual addresses to physical ones on the fly,
page-by-page, under the kernel's control. Two processes can both store data at
"address 0x7ffee000" — and each gets a different physical page. This illusion
is called **virtualization of resources** — and as we'll see, containers are
just this idea pushed further.

### 3. Protection

The CPU itself has privilege levels. The kernel runs in **privileged mode**
(ring 0 on x86); normal programs run in **unprivileged mode** (ring 3). A user
program physically *cannot* talk to hardware or touch other processes' memory —
the CPU forbids it. If a program tries, the CPU raises a trap, the kernel is
notified, and the kernel typically kills the offending process with a
**segmentation fault** (SIGSEGV). Every memory access, every instruction
executed in user mode is policed by this hardware-enforced wall.

The only way for user code to affect the world is to ask the kernel via
a **system call**. This transition is the single most important boundary in the
entire system, and chapter 3 is devoted to it.

## What is the kernel, concretely?

So far we've talked about what the kernel *does*. But what *is* it? If you
open `/boot`, you'll find it:

```bash
ls -lh /boot/vmlinuz-*
# -rw-r--r-- 1 root root 14M Mar 18 12:34 vmlinuz-6.8.0-52-generic
```

This `vmlinuz` file (short for "Virtual Memory LINUx, compressed") is the
kernel image. It's a **single ELF binary** — just like any executable you run,
except it has no external dependencies. No libc. No dynamic linker. It's
self-contained: everything the kernel needs to run is linked statically inside
it.

The bootloader loads this file into RAM and jumps to its entry point. From
that moment until shutdown, the kernel **never exits**. It's not like a regular
program that starts, does work, and terminates. The kernel *is* the environment
in which all other programs exist. It initializes itself, then creates the
first user-space process (PID 1), and from there it's always running — either
servicing a system call, handling an interrupt, or sitting idle waiting for
the next event.

### What happens when the kernel boots

When the kernel takes control from the bootloader, it immediately:

1. **Decompresses itself** — the `vmlinuz` file wraps a compressed kernel (like
   gzip). The very first code the CPU executes extracts the real kernel image
   into memory.
2. **Probes the hardware** — enumerates CPUs, discovers RAM, identifies buses
   (PCIe, USB), finds storage controllers. It doesn't use BIOS calls for this;
   it talks to the hardware directly.
3. **Initializes kernel subsystems** — sets up the page tables for virtual
   memory, configures interrupt handling, initializes the scheduler, mounts the
   initial **root filesystem** (from an initramfs or directly from the disk).
4. **Launches PID 1** — looks for `/sbin/init` (or whatever the `init=` boot
   parameter says) and creates the first user-space process.

We'll walk through this sequence in detail in the next chapter. For now, the
mental picture: the kernel is a big static binary that loads, sets up the
hardware, and then spends the rest of its life reacting to events — system
calls, interrupts, timer ticks.

### Kernel modules — extensibility without rebooting

The kernel image in `/boot` is not the whole story. Linux supports **loadable
kernel modules** (`.ko` files, typically under `/lib/modules/$(uname -r)/`).
These are pieces of kernel code — device drivers, filesystems, network
protocols — that can be loaded and unloaded without rebooting:

```bash
lsmod                          # list loaded modules
modprobe nvidia                # load the nvidia driver on demand
```

Modules run in kernel space with full privileges, exactly like code compiled
into the base image. They're the pragmatic halfway between a pure monolithic
kernel and the microkernel ideal (more on that below). A modern running kernel
might have 200+ modules loaded, but they all share the same address space.

## Monolithic kernel: why everything runs in one address space

Operating systems fall on a spectrum:

| Architecture | Kernel code runs in… | Communication between services | Examples |
|---|---|---|---|
| **Monolithic** | One shared address space, full privilege | Direct function calls | Linux, Windows, BSD |
| **Microkernel** | Small core (IPC, scheduling); services in user space | Inter-process messages | Minix, QNX, seL4 |
| **Hybrid** | Mostly monolithic with some user-space services | Mixed | macOS (XNU), Windows NT |

Linux is a **monolithic kernel**. The scheduler, memory manager, filesystem
stack, networking stack, and device drivers all live in the same address space
and call each other directly — just like functions in any C program.

### Why monolithic?

The debate has raged since the 1990s (Torvalds vs. Tanenbaum — look it up, it's
legendary). The monolithic argument:

**Performance.** A system call from user space to kernel space is already
expensive (the CPU must switch privilege levels, flush parts of the TLB cache).
If the kernel then had to do IPC message-passing to a separate file-system
service... and that service did IPC to a separate disk-driver service... every
`read()` would cost thousands of cycles in context switches. A monolith handles
a `read()` with a dozen function calls inside the same address space.

**Practicality.** Writing drivers that live in separate processes with formal
message-passing APIs is genuinely harder. Linux's internal APIs are C function
calls between subsystems, and thousands of developers contribute drivers
against these APIs. The complexity of a formal IPC protocol between every
subsystem would be enormous.

### The cost

The trade-off: **no isolation**. A buffer overflow in a wifi driver can corrupt
the scheduler's data structures and crash the entire machine. On a microkernel,
a buggy wifi driver would crash only the networking service — the kernel core
would keep running and could restart it.

Linux mitigates this pragmatically: modules can be unloaded and reloaded,
mainline drivers are heavily reviewed, and the kernel community is aggressive
about fixing bugs. But the architectural trade-off is real and permanent.

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

### The numbers behind the boundary

When you run a process on Linux, the kernel reserves the top portion of its
**virtual address space** for itself — a region the process can never touch.
On x86-64:

```text
  0x0000000000000000 ──────────────────
                     │   userspace   │  ~128 TiB (the kernel maps
                     │    (text,     │   only a fraction, on demand)
                     │     heap,     │
                     │     stack,    │
                     │     mmap)     │
  0x00007fffffffffff ├───────────────┤  ← user/kernel boundary
  0xffff800000000000 ├───────────────┤
                     │  kernel space │  ~128 TiB (covers all physical
                     │  (code, data, │   RAM + vmalloc + modules)
                     │   direct map  │
                     │   of all RAM) │
  0xffffffffffffffff └───────────────┘
```

The kernel maps **all physical RAM** into its own half of every process's
address space. This sounds wasteful — doesn't each process duplicate the
kernel? No: the kernel uses the same **page table entries** for every process's
kernel region, so the physical pages are shared. The per-process page tables
simply point to the same physical frames for kernel addresses. This is why a
system call doesn't need to switch page tables — the kernel is always mapped,
ready to serve, from the moment you enter the call.

This split is the mechanism behind the protection: a user-space pointer can
never accidentally alias kernel memory because the addresses are in entirely
different ranges and the CPU enforces the boundary in hardware.

## A system call in slow motion

We'll dedicate all of chapter 3 to this, but seeing one now makes the rest of
this chapter tangible. Let's trace `write(1, "hello\n", 6)` — the code that
prints something to your terminal.

```c
// User-space side (inside glibc):
ssize_t write(int fd, const void *buf, size_t count) {
    // glibc moves arguments into registers and executes SYSCALL
    // fd → rdi, buf → rsi, count → rdx, syscall number (1) → rax
    return syscall(1, fd, buf, count);  // syscall is a libc wrapper
}
```

What happens next, at the CPU level:

```
1. SYSCALL instruction executes in user mode (ring 3)
2. CPU atomically:
   - switches to ring 0
   - saves return address (RIP) into RCX
   - saves RFLAGS into R11
   - jumps to the address stored in MSR_LSTAR (a CPU register the kernel
     programmed at boot — it points to entry_SYSCALL_64)
3. Kernel function entry_SYSCALL_64 runs:
   - saves all user registers on the kernel stack
   - looks up rax (syscall number 1 → sys_write)
   - calls ksys_write(fd, buf, count)
4. ksys_write does the real work:
   - looks up fd in the current process's file table → finds the terminal's
     struct file
   - calls the terminal driver's write function
   - the driver puts bytes into a buffer and kicks the hardware
5. On return: restore user registers, execute SYSRET
6. CPU atomically switches back to ring 3, jumps to RCX

Total cost: typically a few hundred CPU cycles for a simple write.
Complex operations (disk I/O) can take millions of cycles.
```

This dance — user space asks, CPU switches rings, kernel does work, CPU
switches back — is the fundamental rhythm of Linux. Every `malloc`, every
`printf`, every incoming network packet, every timer tick triggers it.

## Inside the kernel source tree

If you clone the kernel source (`git clone https://git.kernel.org/...`) and
run `ls -1`, here's what you'll find and what each top-level directory does:

| Directory | Purpose | You'll find… |
|---|---|---|
| `arch/` | Architecture-specific code | `arch/x86/boot/`, `arch/arm64/mm/`, per-CPU startup, page tables, syscall entry |
| `kernel/` | Core kernel logic | Scheduler (`kernel/sched/`), fork, signals, cgroups, timekeeping |
| `mm/` | Memory management | Page allocation, swapping, demand paging, the page cache |
| `fs/` | Filesystems and VFS | ext4, btrfs, xfs, NFS, VFS core (`fs/namei.c`, `fs/open.c`) |
| `net/` | Networking stack | TCP, UDP, IP, netfilter, socket layer (`net/core/`, `net/ipv4/`) |
| `drivers/` | Device drivers | The overwhelming majority of the code — GPU, disk, WiFi, USB, everything |
| `include/` | Header files | Kernel-internal API definitions, UAPI for user space |
| `lib/` | Kernel-internal library | String functions, checksums, data structures (rbtree, radix tree) |
| `block/` | Block I/O layer | I/O scheduler, bio layer, request queues |
| `scripts/` | Build infrastructure | Makefile helpers, Kconfig, Coccinelle |
| `security/` | Security modules | SELinux, AppArmor, capabilities |
| `sound/` | Audio subsystem | ALSA |
| `init/` | Startup code | The first kernel code after the entry point |
| `ipc/` | Inter-Process Communication | SysV IPC, POSIX message queues |
| `crypto/` | In-kernel cryptography | Used by filesystems, networking, DRM |
| `rust/` | Rust support | Infrastructure for Rust kernel modules (kernel v6.1+) |

Total: roughly **40 million lines** (mostly C, growing amount of Rust), with
over 15,000 active contributors per release. The `drivers/` directory alone is
often 60–70% of a kernel release — Linux's strength is its hardware support.

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

## "Everything is a file" (and some things that break the rule)

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

### Where the metaphor bends

Not everything is literally a file. Processes are **not** files — you can kill
one but you can't `cat` it. The directories in `/proc/<PID>/` expose process
information *as* files, but the process object itself in the kernel is a
`struct task_struct`, not an inode.

Network sockets are file descriptors (you can `write()` and `read()` them), but
you can't `ls` them in a regular directory — they live in the "sockfs"
pseudo-filesystem. System calls like `bind()` and `connect()` do things that
`open()`-of-a-file could never express.

The principle is brilliant but approximate: the kernel uses the file interface
wherever it makes sense, and adds specialized syscalls when it doesn't.

### /proc deep-dive

Every process on your machine has a directory under `/proc/<PID>/`. Try this:

```bash
ls /proc/$$/          # $$ is your current shell's PID
# cmdline  cwd  environ  exe  fd  maps  mountinfo  ns  stat  status  task

cat /proc/$$/status   # memory, UIDs, signal masks...
ls -l /proc/$$/fd     # every open file descriptor — sockets, pipes, files
cat /proc/$$/maps     # raw memory map: where libc, ld, heap, stack live
```

These are not text files the kernel wrote to a spinning disk. They're
**generated on access** — the kernel's `/proc` code reads the relevant
`task_struct` fields and formats them into human-readable output, every time
you `cat`. This is one of the kernel's most elegant ideas: debugging
information and runtime state exposed through the same interface as regular
files.

## Kernel panics, oops, and why Linux is reliable anyway

When kernel code hits an unrecoverable error, you get a **kernel panic** — the
screen freezes, the kernel prints a backtrace, and the machine halts. No
process can run because the very thing that schedules processes has crashed.

A slightly less fatal failure is a **kernel oops** — the kernel detects a
problem (e.g., a driver dereferences a NULL pointer) and kills only the
offending kernel thread, leaving the rest of the system running. After an oops,
the system may survive, but the crashed subsystem (say, a filesystem) may leave
state corrupted and a panic frequently follows.

Why don't you see panics every day? Because:

- **Extensive testing.** Every patch must pass thousands of regression tests.
- **Strict review.** Linus and subsystem maintainers aggressively reject buggy
  code. Code that worked "on my machine" but corrupts memory on someone else's
  won't survive the mailing list.
- **Conservative merging.** The `linux-next` integration tree runs proposed
  changes for weeks before they hit a release.
- **Fault isolation between processes.** Even if a kernel bug corrupts kernel
  state, unrelated processes often survive because their memory is untouched —
  until the corrupted data (a dentry, an inode, a page) is accessed.

The kernel is not bug-free — the
[LKML](https://lkml.org/) sees new bugs daily. But the combination of
monolithic performance, massive testing infrastructure, and aggressive
maintainer culture makes it reliable enough to power the internet.

## A tiny bit of history (it explains the culture)

- **1969–70, Bell Labs:** Ken Thompson and Dennis Ritchie create **Unix**, and
  with it the ideas Linux still lives by: *everything is a file*, small tools
  composed through pipes, a hierarchical filesystem, fork/exec.
- **1983:** Richard Stallman launches **GNU**, rewriting the Unix userland as
  free software — compiler (gcc), shell (bash), coreutils. Missing piece: a
  free kernel.
- **1991:** a Finnish student, **Linus Torvalds**, posts: *"I'm doing a (free)
  operating system (just a hobby, won't be big and professional like gnu)"*.
  GNU userland + Linux kernel = a complete free OS. That same year, the
  **Tanenbaum-Torvalds debate** erupts on Usenet — Linus defends his monolithic
  design against Andrew Tanenbaum's argument that microkernels are structurally
  superior. The thread is still fascinating reading.
- **1996:** Linux 2.0 introduces SMP (multi-CPU) support, loadable kernel
  modules, and the beginning of portability beyond x86.
- **2003:** Linux 2.6 — the kernel that ran the world's servers for over a
  decade. Added preemption, the O(1) scheduler, huge scalability improvements.
- **2011:** Linux 3.0 — a version bump (nothing special broke), reflecting that
  the codebase had outgrown the 2.6.x numbering scheme.
- **2015:** Linux 4.0 — live patching, live kernel upgrades without rebooting.
- **2022:** Linux 6.0 — Rust support lands (for drivers), io_uring matures.
- **Today:** Linux runs the overwhelming majority of servers, all of the top
  500 supercomputers, every Android phone (3 billion+ devices), ChromeOS
  laptops, most embedded devices, and the entire cloud. The kernel is ~40
  million lines of C and Rust, developed by thousands of contributors from
  over 400 companies. A new major release happens every 9–10 weeks.

The Unix heritage matters practically: when something in Linux looks odd,
the answer is often "because Unix did it that way in 1975, and it turned out
to be a great idea" (file descriptors) or "…and we're stuck with it" (signal
semantics).

## The mental model you should have now

Before moving on, here's the picture to carry forward:

- **Linux is the kernel** — a monolithic, privileged binary that owns the
  hardware.
- **It never stops.** From boot to shutdown, it's always present, always in
  charge.
- **It abstracts, multiplexes, and protects.** Files, processes, sockets,
  virtual memory — none of these exist in the hardware; the kernel invents
  them.
- **User space asks, kernel does.** Everything useful (writing to disk, sending
  a packet, allocating memory) crosses the system call boundary, where the CPU
  enforces a privilege switch in hardware.
- **"Everything is a file"** is a powerful pattern, though not literally true.
  `/proc` and `/sys` let you interrogate the running kernel with `cat` and
  `grep`.
- **A distro is the kernel plus a curated userland.** Containers swap out the
  userland while sharing the kernel — which is the central insight of Part III.
- **The kernel source** is 40M lines organized into well-defined subsystems
  (`arch/`, `kernel/`, `mm/`, `fs/`, `net/`, `drivers/`…) that the rest of
  this site explores.

## Check your understanding

Try answering before moving on:

1. Your text editor wants to save a file. Can it write to the disk directly?
   What must happen instead?
2. Ubuntu and Alpine both run "Linux". What's actually different between them?
3. Why does a segfault in Firefox not crash your machine, while a bug in a
   device driver can?
4. The kernel maps all physical RAM into its half of the address space. Why
   doesn't this waste memory for every process?
5. You run `cat /proc/cpuinfo`. Is there a file called `cpuinfo` on your disk?
   Where do the bytes you see come from?
6. Name three things that are *not* files in Linux, even though the "everything
   is a file" philosophy suggests they might be.

*(Answers, in order: no — it must issue `write()` system calls and the kernel's
filesystem + driver code performs the I/O; the user space — C library, init,
utilities, package manager — while the kernel is the same project; Firefox runs
unprivileged in its own address space, a driver runs in kernel space with full
privileges; the kernel region's page table entries point to the same physical
pages across all processes, so the memory is shared, not duplicated; no — it's
a virtual file generated on-the-fly by kernel code that reads CPU data
structures and formats them as text; processes, network sockets (as filesystem
objects), pipes (as named paths), signals, IPC message queues — they're exposed
through file descriptors or /proc entries, but they're not files on a
filesystem.)*

---

**Next:** we press the power button and follow, step by step, everything that
happens until you get a login prompt.
