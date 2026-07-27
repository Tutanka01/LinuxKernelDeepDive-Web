---
level: core
kernel: 6.12
verified: 2026-07
minutes: 19
requires: prereq-programs, prereq-c
---

# Reading the Evidence: man, /proc & Kernel Source

> **Goal:** learn to read the four kinds of evidence this book cites on every
> page — man pages, `/proc` and `/sys` files, the notation in the prose, and
> kernel source on elixir.bootlin.com — so that "see `open(2)`", "cat
> `/proc/meminfo`", and "here is the 6.12 source" become instructions you can
> actually follow instead of decoration.

## Why a whole chapter on reading

Open any later chapter and you will trip over the same three moves. The text
says *"see `man 2 open`"* and expects you to go read a syscall's contract. It
says *"`cat /proc/meminfo`"* and expects you to know that the file has no
bytes on disk. It says *"in 6.12,
[`task_struct`](https://elixir.bootlin.com/linux/v6.12/C/ident/task_struct)
holds…"* and links you into a hyperlinked copy of the kernel tree.

Each of those is a separate reading skill, and most people who use Linux every
day have never formally learned any of them. You can drive a shell for years
without once reading a man page past the first screen, without ever wondering
why a `/proc` file is zero bytes, and without opening the kernel source at all.

This book leans on all three constantly. This chapter is the decoder ring. It
teaches you nothing about how the kernel *works* — that is the rest of the book
— only how to read the evidence the book keeps pointing at. Think of it as
learning to read the footnotes before reading the argument.

Four kinds of evidence, four short lessons:

| Evidence | Looks like | What it is |
|---|---|---|
| **man page** | `open(2)`, `man 7 signal` | The contract for a command, syscall, or concept |
| **`/proc` / `/sys`** | `cat /proc/meminfo` | The kernel answering a question, live, as a fake file |
| **notation** | `4 KiB`, `0xffff…`, "since 6.6", `vm.swappiness` | The prose's shorthand for units, versions, and knobs |
| **kernel source** | `fs/pipe.c`, an elixir link | The actual code, one function at a time |

## man pages, properly

A man page is a reference contract, not a tutorial. Every command, system call,
and library function on a well-kept Linux box ships one. The trick almost
nobody is taught is that the manual is divided into numbered **sections**, and
the same name can appear in several of them meaning completely different things.

| Section | Contains | Example |
|---|---|---|
| **1** | User commands (things you type in a shell) | `ls(1)`, `grep(1)`, `printf(1)` |
| **2** | System calls (the kernel's API — see [From Source Code to Running Process](#/prereq-programs)) | `open(2)`, `read(2)`, `mmap(2)` |
| **3** | Library functions (libc and friends, not the kernel) | `printf(3)`, `malloc(3)`, `fopen(3)` |
| **4** | Devices and special files (`/dev` entries) | `null(4)`, `random(4)` |
| **5** | File formats and configuration syntax | `passwd(5)`, `proc(5)`, `fstab(5)` |
| **7** | Overviews, conventions, whole concepts | `signal(7)`, `namespaces(7)`, `cgroups(7)` |
| **8** | System administration commands (usually root) | `mount(8)`, `ip(8)`, `iptables(8)` |

### The notation `open(2)` — decoded

That parenthesised number is the section. `open(2)` means *"the manual page for*
`open`*, in section 2"* — so, the `open` **system call**, not some command
called `open`. This book writes syscalls, library functions, and concepts in
exactly this form everywhere: `read(2)` is the syscall, `printf(3)` is the libc
function, `signal(7)` is the concept overview. When you see `foo(N)` in the
prose, it is telling you both *what* to look up and *which drawer* to find it
in. You read it aloud as "open, section two."

To open a specific section, put the number first:

```bash
man 2 open      # the open() system call
man 3 printf    # the C library printf() function
man 1 printf    # the /usr/bin/printf command
```

`man printf` with no number gives you the **lowest-numbered** match, which is
`printf(1)`, the shell command — almost certainly *not* what a C programmer
wanted. That is the whole reason the book always writes the section number.

### Real collisions worth knowing

These names genuinely exist in more than one section on a standard Linux system,
and confusing them will waste your afternoon:

| Name | Lower section | Higher section |
|---|---|---|
| `printf` | `printf(1)` — the coreutils command | `printf(3)` — the libc function |
| `kill` | `kill(1)` — the shell command that sends signals | `kill(2)` — the syscall it calls |
| `write` | `write(1)` — message another logged-in user | `write(2)` — the syscall that writes to an fd |
| `mount` | `mount(8)` — the admin command | `mount(2)` — the syscall it wraps |
| `stat` | `stat(1)` — the command | `stat(2)` — the syscall |

Notice the pattern in most of those rows: the low-section entry is the
*command* you type, the high-section entry is the *syscall* underneath it that
does the actual work. `kill(1)` is a thin wrapper over `kill(2)`; `mount(8)`
ends up calling `mount(2)`. Reading both pages for a pair like that is one of
the fastest ways to see the command/kernel boundary from
[From Source Code to Running Process](#/prereq-programs) in the flesh.

### The skeleton of a man page

Every section-2 and section-3 page has the same fixed headings, in the same
order. Learn the skeleton once and you can read any of them fast:

| Heading | What it tells you |
|---|---|
| **NAME** | One-line "what it is", used by search (below) |
| **SYNOPSIS** | The exact signature — includes, arguments, types |
| **DESCRIPTION** | The prose contract: what it does, flag by flag |
| **RETURN VALUE** | What you get back on success and on failure |
| **ERRORS** | Every `errno` it can set, and what each means |
| **VERSIONS / STANDARDS** | Since when it existed; which standard blesses it |
| **NOTES / BUGS / EXAMPLES / SEE ALSO** | Caveats and neighbours |

The one to slow down on is **SYNOPSIS**, because for a syscall it is a C
function signature — exactly the thing [Just Enough C to Read the Kernel](#/prereq-c) taught you to
read. For `read(2)` it says:

```c
#include <unistd.h>

ssize_t read(int fd, void *buf, size_t count);
```

Read that the way [Just Enough C to Read the Kernel](#/prereq-c) showed you: the function is called
`read`; it takes an `int fd` (a file descriptor — see
[From Source Code to Running Process](#/prereq-programs)), a `void *buf` (a pointer to a chunk of
memory to fill), and a `size_t count` (how many bytes); it returns an
`ssize_t`, a signed size — signed precisely so it can return `-1` on error.

The first `#include` line tells you which header declares it. That single block
tells you everything you need to *call* it; the DESCRIPTION and ERRORS sections
tell you everything you need to *survive* calling it.

### Section 7: where concepts live

Section 7 is the book's secret weapon and the section a shell user has almost
never opened. It holds page-length explanations of whole subsystems, not single
functions. A few this book leans on directly:

```bash
man 7 signal        # the entire signal model, in one page
man 7 namespaces    # what a namespace is and the seven kinds
man 7 cgroups       # control-group hierarchy, v1 vs v2
```

These are dense but authoritative, written by the same people who wrote the
kernel. When a chapter here summarises a concept, the matching `man 7` page is
usually the primary source it is summarising *from*.

### Finding a page when you don't know its name

Two tools search the NAME lines of every installed page:

```bash
apropos signal      # every page whose summary mentions "signal"
man -k signal       # identical: -k is "keyword", apropos is its alias
```

Use these when you know *what* you want but not the exact page name. `man -k
namespace` will surface `namespaces(7)`, `mount_namespaces(7)`,
`user_namespaces(7)`, and more — a table of contents you did not know existed.

> **Depth note.** man pages are the *contract*. When you want to watch a
> syscall actually happen — arguments, return value, timing — that is a job for
> `strace` and friends, covered in the full observability chapter,
> [/proc, strace, perf & eBPF](#/observability). This chapter is only teaching
> you to read; that one teaches you to trace.

## `/proc` and `/sys`: windows, not files

Type `cat /proc/meminfo` and you get a screen of memory statistics. It looks
like a file. It is not a file in any normal sense: **nothing is stored on
disk.** `/proc` and `/sys` are *virtual filesystems* — the kernel pretends to
have files there, and each "read" runs a small piece of kernel code that
generates the answer on the spot.

The content is assembled the instant you read it, which is why it is always
current and why the file's size is reported as **zero** (the kernel cannot know
how many bytes it will produce until it produces them).

*How* a read of a fake file turns into a kernel function call is the whole
subject of [Kernel, User Space & Syscalls](#/kernel-vs-userspace); here you only
need the mental model: **a `/proc` file is a question, and reading it is
asking.**

### The greatest hits

You will meet all of these later. One line each so a path in the text means
something the moment you see it:

| Path | Answers the question |
|---|---|
| `/proc/cpuinfo` | What CPUs do I have, and what can they do? |
| `/proc/meminfo` | Where did all my RAM go, right now? |
| `/proc/[pid]/status` | Human-readable summary of one process (memory, UID, threads) |
| `/proc/[pid]/maps` | Every memory region in that process's address space |
| `/proc/[pid]/fd/` | A symlink per open file descriptor of that process |
| `/proc/self/` | Shorthand for "the process doing the reading" — i.e. you |
| `/proc/sys/…` | The tunable knobs (see sysctl below) |
| `/proc/cmdline` | The kernel's own boot command line |
| `/sys/…` | The device and driver tree (see below) |

`/proc/self` deserves a callout: it is a magic symlink that always points at
the reading process's own PID directory, so `cat /proc/self/status` reports on
*your* shell without you having to know its PID. The book uses `/proc/self`
constantly in `Try it yourself` blocks for exactly that reason.

`/sys` (the *sysfs* filesystem) is the same idea aimed at hardware: it is the
kernel's live tree of devices, drivers, and buses — every disk, NIC, USB
device, and CPU core, exposed as directories of tiny attribute files. Where
`/proc` grew organically into a grab-bag of process and kernel info, `/sys` is
the tidier, newer, one-value-per-file view of the device model. You will walk it
properly in [Devices, Drivers & Modules](#/devices-modules).

### Reading a `/proc` file you have never seen

Most of these files are either whitespace-columns or `key: value` lines, so
`cat` then squint is a fine first move. Two conventions save you every time:

- **Units are usually kB.** Memory figures in `/proc/meminfo` and
  `/proc/[pid]/status` are suffixed `kB`.
- **…but "kB" here actually means KiB.** This is a real, long-standing kernel
  quirk. The label says `kB` (which by the strict SI meaning is 1000 bytes) but
  the number is in **kibibytes** — multiples of **1024** bytes. So `MemTotal:
  16000000 kB` is 16000000 × 1024 bytes, roughly 15.26 GiB, not 16 GB. The
  kernel has printed `kB` for these values for decades and will not change it
  now; just read every `/proc` "kB" as KiB in your head. (The KiB-vs-kB
  distinction itself is the next section.)

When a column is opaque, the file format itself has a man page:
`proc(5)` — or on newer systems the split-out `proc_meminfo(5)`,
`proc_pid_status(5)`, and friends — documents field by field what each line
means.

### The kernel ring buffer: `dmesg`

One special window: the kernel keeps a rolling in-memory log of its own
messages — driver init, hardware errors, the OOM killer firing, USB devices
appearing — called the **ring buffer**. You read it with `dmesg`:

```bash
dmesg | tail          # the most recent kernel messages
dmesg -w              # follow new messages live (like tail -f)
```

On many hardened distributions reading the ring buffer needs root
(`sudo dmesg`), because early boot messages can leak kernel addresses. When a
lab in this book says "check `dmesg`", this buffer is what it means — it is the
first place to look when the kernel did something and you want to know what.

## The book's notation conventions

The prose uses a compact shorthand everywhere. Here is the whole legend.

**Binary vs decimal units — KiB, MiB, GiB.** The book uses the *binary* units
throughout: 1 **KiB** = 1024 bytes, 1 **MiB** = 1024 KiB, 1 **GiB** = 1024
MiB. The plain forms KB, MB, GB strictly mean powers of 1000 and are used only
when a vendor or standard genuinely means decimal (disk manufacturers, network
speeds). Memory, pages, and caches are always binary. The one trap, repeated
from above: `/proc` files print `kB` but mean KiB — the kernel's label is
wrong, the book's `KiB` is right.

**Hexadecimal — the `0x` prefix.** Numbers beginning `0x` are hexadecimal
(base 16), the natural notation for addresses and bit-masks, recalling
[The Machine Underneath](#/prereq-hardware). `0x1000` is 4096, i.e. 4 KiB —
which is why page-aligned addresses end in `000` in hex. When you see a
monster like `0x7ffde4a3c000` in `/proc/[pid]/maps`, that is just a memory
address written in the base that makes its structure visible.

**Version pins — "since 6.6", "as of 6.12".** The kernel changes. A fact that
is true today may have been false two releases ago, so the book pins volatile
facts to a version: *"the scheduler is EEVDF since 6.6"* means don't expect it
on a 6.1 box. Everything here is verified against **6.12** unless a "since"
says otherwise. This is not pedantry — "the kernel does X" without a version is
how you end up debugging a behaviour your kernel simply does not have.

**`struct foo` — a kernel data structure.** When the text writes
`struct task_struct` or `struct file`, it is naming an actual C structure in
the source (the `struct` keyword is C's, see [Just Enough C to Read the Kernel](#/prereq-c)). These are
the real names you can search for on elixir, below.

**`foo(N)` — a man-page reference.** Already covered: name plus section.

**A "sysctl knob".** A **sysctl** is a runtime-tunable kernel parameter. Each
one has two spellings for the same thing: a **dotted name** and a **`/proc/sys`
path**, and you translate between them by swapping dots for slashes:

```text
vm.swappiness   ⇄   /proc/sys/vm/swappiness
net.ipv4.ip_forward   ⇄   /proc/sys/net/ipv4/ip_forward
```

So these two commands read the exact same value:

```bash
sysctl vm.swappiness          # vm.swappiness = 60
cat /proc/sys/vm/swappiness   # 60
```

When a chapter says "set the `vm.swappiness` knob", it means that file. The
`sysctl` command is just a friendlier front-end to the `/proc/sys` tree.

## Reading kernel source without drowning: elixir.bootlin.com

Sooner or later a chapter says "in 6.12, the code does X" and links you to
[elixir.bootlin.com](https://elixir.bootlin.com). Elixir is a free,
hyperlinked web view of the **entire** Linux source tree, for **every** version,
with every identifier turned into a clickable cross-reference. You do not need
to download anything, and you do not need to know C well — you need to know how
to follow a link and read one function.

### The ident link the book uses

The book almost always links to an *identifier* — a function, struct, or
constant name — using this URL shape:

```text
https://elixir.bootlin.com/linux/v6.12/C/ident/<name>
```

For example
[`vm_area_struct`](https://elixir.bootlin.com/linux/v6.12/C/ident/vm_area_struct).
Clicking it lands you on a page that lists, for kernel v6.12:

1. **where the name is defined** (the struct declaration or function body), and
2. **every place it is used**, file by file, each a link.

That "defined here, used in these 340 places" index is the single most useful
thing about Elixir. It turns a name in this book's prose into a live map of how
that thing threads through the kernel.

### The workflow

You almost never read Elixir top-to-bottom. The loop is:

1. Arrive at an identifier (from a book link, or by typing a name into
   Elixir's search box).
2. Click the definition to read *that one function or struct*.
3. Inside it, click the next identifier you don't recognise, and repeat —
   following the one thread you care about.
4. To see a *different* kernel version, change the version in the top-left
   selector (or edit `v6.12` in the URL). The same name may look different, or
   not exist, in another release — which is the "since 6.6" notation made
   visible.

To search a name yourself, use the box at the top of any Elixir page, or just
hand-edit the `ident/<name>` tail of the URL. Both land in the same place.

### The tree's top level, so a path means something

The book cites paths like `fs/pipe.c` and `mm/oom_kill.c` as if they are
addresses — because they are. The top of the kernel tree is organised by
subsystem, and knowing the map lets you place any path instantly:

| Directory | Holds |
|---|---|
| `kernel/` | Core kernel: scheduler, signals, time, the syscall plumbing |
| `mm/` | Memory management: page allocator, virtual memory, the OOM killer |
| `fs/` | Filesystems and the VFS layer (`fs/pipe.c`, `fs/ext4/`, …) |
| `net/` | The whole networking stack (`net/ipv4/`, `net/unix/`, …) |
| `drivers/` | Device drivers — by far the largest directory |
| `include/` | Header files: where most `struct` definitions live |
| `arch/` | Per-CPU-architecture code (`arch/x86/`, `arch/arm64/`, …) |
| `block/` | The block I/O layer, above the storage drivers |
| `ipc/` | System V IPC (message queues, semaphores, shared memory) |
| `security/` | LSMs: SELinux, AppArmor, the capability checks |

Now `fs/pipe.c` reads as "the pipe implementation, in the filesystem layer",
and `mm/` in a path tells you before you read a line that you are in
memory-management territory.

> **Reassurance.** Nobody — not even kernel developers — reads the source
> linearly, and you are not expected to. You open *one* function with *one*
> question in mind ("what does this return when the pipe is full?"), read until
> you have the answer, and close the tab. When you want to grep and build the
> tree on your own machine instead of in a browser,
> [Reading & Building the Kernel](#/kernel-dev) is the chapter for that.

## How this book's own evidence blocks work

Now that you can read all four kinds of evidence, here is how the book packages
them, so you know what each block is promising you.

**A `Try it yourself` block** is meant to be *typed*, not just read. Every one
holds real, read-only shell commands, and the point is to compare *your*
machine's output against the text. When they differ — a different default, a
missing knob, a newer field — you have learned something specific about your
own kernel, which is worth more than agreeing with the book.

**A struct field table is curated, not exhaustive.** When a chapter shows a few
fields of `struct task_struct`, that is a hand-picked handful out of the
hundreds the real struct contains (recall the same warning in
[Just Enough C to Read the Kernel](#/prereq-c)). The `…` is doing honest work: it means "and much more
that does not matter here." To see the whole thing, follow the Elixir link — the
table is a guide, the source is the truth.

**A "Follow the code" section names real 6.12 functions.** Several chapters end
with a numbered walk through an actual code path, naming functions like
[`vfs_write`](https://elixir.bootlin.com/linux/v6.12/C/ident/vfs_write) that you
can open on Elixir and read for yourself. Those names are not illustrative
pseudocode; they are the genuine 6.12 identifiers, verified to exist, so the
walk-through and the source line up one to one.

## Try it yourself

```bash
# The same name, two different manual sections (see both contracts):
man 2 write     # the write() SYSTEM CALL — write bytes to an fd
man 1 write     # the write COMMAND — message another logged-in user
#   ('q' quits the pager each time)

# Search every man page's summary line for a keyword:
man -k namespace | head          # apropos does the same thing

# Read a /proc window on yourself (key: value lines, note the "kB" units):
cat /proc/self/status | head

# Your own open file descriptors, one symlink each:
ls -l /proc/self/fd              # fds 0,1,2 = stdin, stdout, stderr

# A sysctl knob, both spellings — same value from each:
sysctl vm.swappiness
cat /proc/sys/vm/swappiness

# The kernel's own ring buffer (may need sudo on hardened distros):
dmesg | tail

# Proof that a /proc file has no bytes on disk — size is 0:
stat -c %s /proc/meminfo         # prints 0, yet `cat` produces a screenful
```

## Check your understanding

1. The book writes `open(2)`. What exactly does that notation tell you, and how
   would you open that page?

<details><summary>Show answer</summary>

It names the `open` entry in **section 2** of the manual — section 2 being
system calls — so it means the `open()` **syscall**, not any command called
`open`. You open it with `man 2 open`. The section number matters because the
same name can live in several sections; `man open` alone would give you the
lowest-numbered match, which might be the wrong thing entirely.

</details>

2. `stat -c %s /proc/meminfo` reports a size of 0, yet `cat /proc/meminfo`
   prints a full screen. Why is there no contradiction?

<details><summary>Show answer</summary>

`/proc` is a virtual filesystem: the "files" are not stored on disk. Reading
one runs a piece of kernel code that generates the answer on the spot, so the
content is produced only at read time and is always current. The kernel cannot
know the length in advance, so it reports size 0 — the bytes exist only for as
long as it takes you to read them.

</details>

3. `/proc/self/status` shows `VmRSS: 12000 kB`. Roughly how many bytes is that,
   and what is the trap?

<details><summary>Show answer</summary>

Roughly 12000 × 1024 ≈ 12.3 MB (≈ 11.7 MiB). The trap is that `/proc` prints
the label `kB` but the number is really in **KiB** (multiples of 1024), not the
SI 1000. It is a long-standing kernel quirk: read every `/proc` "kB" as KiB.

</details>

4. You want the documentation for the *format* of the `/etc/fstab`
   configuration file, not any command. Which man section, and why?

<details><summary>Show answer</summary>

Section **5**, file formats and configuration syntax: `man 5 fstab`. Section 1
would be commands, section 8 admin commands; the *format* of a config file is
specifically what section 5 documents (`fstab(5)`, `passwd(5)`, `proc(5)`, and
so on).

</details>

5. A chapter cites `mm/oom_kill.c` and links `task_struct` on elixir. From the
   path alone, what subsystem is that file in, and what will the Elixir ident
   link show you?

<details><summary>Show answer</summary>

`mm/` is the **memory-management** subsystem, so `mm/oom_kill.c` is the
out-of-memory killer's code. The Elixir ident link
(`…/v6.12/C/ident/task_struct`) shows, for kernel v6.12, where `task_struct` is
**defined** plus **every place it is used** across the tree — the cross-reference
index that lets you follow one identifier through the source.

</details>

## Sources & further reading

- [man(1) and man(7) — man7.org](https://man7.org/linux/man-pages/man1/man.1.html) — the manual, on the manual, including the section list.
- [man-pages(7) — man7.org](https://man7.org/linux/man-pages/man7/man-pages.7.html) — the conventions every page follows (NAME/SYNOPSIS/… and the `foo(N)` notation).
- [proc(5) — man7.org](https://man7.org/linux/man-pages/man5/proc.5.html) — the field-by-field reference for `/proc`, including `/proc/[pid]/status` and `/proc/[pid]/maps`.
- [sysctl(8) and sysctl.conf(5) — man7.org](https://man7.org/linux/man-pages/man8/sysctl.8.html) — the dotted-name ⇄ `/proc/sys` mapping.
- [elixir.bootlin.com](https://elixir.bootlin.com/linux/v6.12/source) — the hyperlinked v6.12 source tree this book links into.
- [/proc, strace, perf & eBPF](#/observability) — the tooling deep dive that picks up where this reading primer stops.
- [Glossary](#/glossary) — every recurring term (page, PID, namespace, sysctl) in one place.

---

**Next:** that is Part 0 complete — you can read the machine, read a program's
shape, read enough C, and read the evidence. Head back to
[How to Use This Book: Paths & Prerequisites](#/start-here) to pick a path, or
start the book proper with [What Is Linux, Really?](#/what-is-linux) — where the
man pages, `/proc` windows, and struct names you just learned to read start
doing real work.
