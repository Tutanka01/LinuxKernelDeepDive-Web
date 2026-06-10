# Kernel, User Space & System Calls

> **Goal:** understand the single most important boundary in Linux — the line
> between user space and kernel space — and the doorway through it: the
> **system call**. Every later chapter stands on this one.

## Two worlds, enforced by the CPU

Modern CPUs run code at different **privilege levels**. Linux uses two:

- **Kernel mode** (x86 "ring 0"): can execute any instruction, touch any
  memory, talk to any device.
- **User mode** ("ring 3"): a restricted mode. Privileged instructions
  (configuring the MMU, disabling interrupts, doing port I/O) cause the CPU
  itself to trap. The hardware — not a convention, not a permission check in
  software — enforces this.

Every process you launch runs in user mode. When it needs anything from the
outside world — read a file, send a packet, get more memory, even know what
time it is — it must ask the kernel. That request is a **system call**.

```text
   user mode                      kernel mode
─────────────────             ──────────────────
 your program
    │
    │ read(fd, buf, 4096)     ← libc wrapper function
    │
    │ syscall instruction ──────► syscall entry point
                                  • which syscall? (number in a register)
                                  • validate arguments
                                  • run kernel code: VFS → ext4 → disk driver
                                  • copy data into the user buffer
    ◄────────────────────────── return to user mode
    │
    │ read() returns 4096
```

The `syscall` CPU instruction atomically switches to kernel mode **and** jumps
to one fixed kernel entry point. User code chooses *that* it enters the kernel,
never *where* — that's what keeps the boundary safe.

### The syscall ABI, at CPU level

On x86-64, the syscall convention is:

```text
rax  = syscall number (0 = read, 1 = write, 2 = open, ...)
rdi  = arg 1
rsi  = arg 2
rdx  = arg 3
r10  = arg 4 (instead of rcx, because SYSCALL clobbers rcx)
r8   = arg 5
r9   = arg 6
rcx  = return address (set by SYSCALL instruction)
r11  = saved RFLAGS (set by SYSCALL instruction)
rax  = return value (or -errno on failure)
```

The kernel's syscall table lives in `arch/x86/entry/syscalls/syscall_64.tbl`
— all ~450 syscalls, numbered. Look it up: syscall 0 is `read`, 1 is `write`,
59 is `execve`, 231 is `exit_group`. When glibc calls `write(fd, buf, len)`,
what actually executes is:

```asm
mov eax, 1          ; syscall number for write
syscall             ; enter kernel
```

## What system calls look like

There are ~450 syscalls on x86-64. The famous ones form small families:

| Family | Syscalls | Purpose |
|---|---|---|
| Files | `openat` `read` `write` `close` `statx` `lseek` | All file I/O |
| Processes | `clone` `fork` `execve` `exit` `wait4` `kill` | Create/run/end processes |
| Memory | `mmap` `brk` `munmap` `mprotect` `madvise` | Ask for / manage memory |
| Network | `socket` `bind` `connect` `accept4` `sendto` | All networking |
| Info | `getpid` `getuid` `uname` `clock_gettime` | Ask about yourself/system |
| **Containers** | `clone` `unshare` `setns` `pivot_root` | Namespaces — Part III! |

You almost never invoke these directly. The **C library (glibc)** wraps each
one in an ordinary function, and every language runtime (Python, Go, Node…)
ultimately funnels into the same syscalls. `printf()` → `write()`.
Python's `open()` → `openat()`. There is no other road to the hardware.

### Open vs openat: the modern syscall

Most file syscalls now have `*at` variants: `openat`, `statx`, `unlinkat`,
`renameat2`. The difference: `open("/etc/hostname")` resolves the path from
the process's current working directory. `openat(AT_FDCWD, "/etc/hostname")`
resolves from a given directory fd — or from the CWD if `AT_FDCWD` is passed.
The `*at` variants are essential for thread safety (a `chdir` in one thread
doesn't invalidate another's openat), and for containers (pass the container's
root fd instead of the process root).

### The forgotten syscalls

Not every syscall is famous. Some oddball ones worth knowing:

- `getrandom(2)` — ask the kernel for truly random bytes (seeds `/dev/urandom`). No libc buffering.
- `memfd_create(2)` — create an anonymous file in RAM, sealable, sendable over Unix sockets. Chrome uses this heavily.
- `io_uring_setup(2)` — the modern completion-based I/O interface (chapter: Modern I/O).
- `bpf(2)` — the eBPF program/map management syscall. One syscall number, dozens of sub-commands.

## Watch syscalls live: strace

This is the moment to meet the most instructive tool on this entire site:

```bash
strace -c ls          # summary: which syscalls, how many, how long
strace cat /etc/hostname
```

Output of the second command (trimmed):

```text
execve("/usr/bin/cat", ["cat", "/etc/hostname"], ...) = 0
openat(AT_FDCWD, "/etc/hostname", O_RDONLY)           = 3
read(3, "mybox\n", 131072)                            = 6
write(1, "mybox\n", 6)                                = 6
close(3)                                              = 0
exit_group(0)                                         = ?
```

Six lines and you can *see* the anatomy of `cat`: open the file (getting file
descriptor 3), read its bytes, write them to file descriptor 1 (stdout), exit.
When a program misbehaves, `strace` shows you exactly what it asked the kernel
and what the kernel answered. Use it liberally.

Production-grade strace patterns:

```bash
strace -f -tt -T ./myprog          # follow forks, timestamps, syscall durations
strace -e trace=file ls             # only file-related syscalls
strace -e trace=network curl example.org
strace -Z -e trace=openat myprog   # -Z: only FAILED syscalls ← quick debug gold
strace -p 1234 -cw -o report.txt   # attach, count syscalls, write report
```

`-Z` (failed-only) is the forgotten superpower: `strace -Z myapp 2>&1 | grep ENOENT`
shows every missing file path the app is looking for, instantly.

## File descriptors: handles to kernel objects

When `openat()` succeeded above it returned `3`. That number is a **file
descriptor (fd)**: an index into a per-process table, where each entry points
to an open object *inside the kernel*. Your process never holds the object —
only the numbered ticket to it.

Three fds exist by convention in every process:

```text
0  stdin    1  stdout    2  stderr
```

Shell redirection is pure fd manipulation: `ls > out.txt` simply makes fd 1
point at `out.txt` before launching `ls` — `ls` itself never knows. And fds
name much more than files: pipes, sockets, eventfd, signalfd, timerfd, pidfd,
memfd, epoll instances, io_uring instances — all are fds. *Everything is a
file (descriptor).*

```bash
ls -l /proc/self/fd      # the fd table of the process running this very ls
ls -l /proc/$$/fd        # your shell's open file descriptors
```

## vDSO: the syscall the kernel skips

Some "syscalls" never enter the kernel. The kernel injects a tiny shared
library — the **vDSO** (virtual Dynamic Shared Object) — into every process's
address space:

```bash
cat /proc/self/maps | grep vdso
# 7fffdc000000-7fffdc002000 r-xp [vdso]
```

Functions like `clock_gettime()`, `gettimeofday()`, `getcpu()`, and (on some
architectures) `time()` live here. They read data from a read-only page the
kernel maintains and return — no mode switch, no privilege transition. This is
why `clock_gettime(CLOCK_MONOTONIC, &ts)` is fast enough to call in tight
loops.

The general pattern: if the kernel can expose a piece of data to user space as
read-only memory, it avoids a full syscall for every read. vDSO is the
mechanism for CPU- and clock-related fast paths.

Check what your vDSO offers:

```bash
nm /proc/self/exe | grep vdso 2>/dev/null; objdump -T /proc/self/exe | grep LINUX
```

## Mode switch ≠ context switch

Two terms people mix up:

- a **mode switch** is one process going user → kernel → user (every syscall);
  cheap-ish (~hundreds of CPU cycles, but varies with Spectre/Meltdown
  mitigations — the `syscall` entry/exit can be ~200–1000 cycles with KPTI
  page table switching on affected CPUs).
- a **context switch** is the kernel pausing one process and resuming
  *another* — saving registers, switching address spaces. More expensive
  (~microseconds), and the subject of the scheduling chapter.

A syscall like `read()` on an empty pipe causes both: mode switch in, the
kernel sees there's no data, puts your process to sleep, context-switches to
someone else. When data arrives, you're woken and resumed. This
block-and-wake pattern is how Linux appears to do everything at once.

## Interrupts: the other way into the kernel

Syscalls are the *intentional* entry into kernel mode. The other entry is the
**interrupt**: hardware (a network card, a disk, a timer) electrically signals
the CPU, which suspends whatever is running and jumps into a kernel handler.

- Your NIC received a packet → interrupt → kernel processes it.
- The **timer interrupt** fires periodically → the scheduler gets a chance to
  preempt the running process. This is why an infinite loop can't freeze
  Linux: the timer always pulls the CPU back into the kernel.
- **Exceptions** are the third entry: the CPU traps on errors. Touch an
  unmapped address → *page fault* → kernel decides: fix it up (more in the
  memory chapter — page faults are often *normal*!) or kill you with the
  famous `SIGSEGV`, the segfault.

So kernel code runs for exactly three reasons: **a syscall, an interrupt, or
an exception**. Never spontaneously.

### The interrupt flow in more detail

When an interrupt arrives:

1. CPU saves minimal state (instruction pointer, flags) on the kernel stack.
2. CPU looks up the interrupt vector table — each interrupt has a number; the
   kernel registered handlers for them at boot.
3. The IRQ handler runs (the "top half" — must be fast, as further interrupts
   are often disabled during it).
4. The handler acknowledges the device, reads the urgent data, schedules the
   "bottom half" for heavier processing (softirq, tasklet, workqueue — the
   devices chapter covers these).
5. The CPU returns from the interrupt; the scheduler decides whether the
   interrupted process or some newly-woken process should resume.

You can see this live:

```bash
cat /proc/interrupts    # counts per-IRQ per-CPU
watch -n1 cat /proc/softirqs  # bottom-half counters
```

## Why this design wins

The cost of all this ceremony buys enormous benefits:

- **Isolation** — a crashing process can't corrupt others or the kernel.
- **A stable contract** — the syscall interface is famously stable
  ("we do not break user space" — Linus). A binary from 2005 still runs.
- **A perfect choke point** — since *everything* passes through syscalls, you
  can observe everything (`strace`, eBPF), filter what a process may do
  (**seccomp** — Docker uses it on every container), and account/limit
  precisely.

That last point is foreshadowing: containers are not virtual machines with
their own kernel. **Every process in every container talks to the one shared
kernel through these same syscalls** — just with namespaced views and
filtered permissions. Keep that in mind for Part III.

### Syscall overhead: what it costs in the real world

On a modern machine, a trivial syscall (like `getpid()`) costs roughly:

```text
~200–300 cycles on CPUs without mitigations
~800–1500 cycles with KPTI (Meltdown mitigation) enabled
```

That's still fast (~100–500 nanoseconds), but thousands per second on a busy
server. This is why:

- **vDSO** exists for `gettimeofday` and friends.
- **io_uring** batches syscalls to amortize entry/exit overhead.
- **eBPF** moves logic *into* the kernel so events don't cross the boundary at all.
- Languages like Go batch syscalls behind a network poller rather than
  one-epoll_wait-per-goroutine.

The syscall cost is the fundamental tax that the entire I/O architecture (Part
IV) is organized to minimize.

## Try it yourself

```bash
strace -c true                       # the minimal program's syscall bill
strace -e trace=network curl -s example.org > /dev/null
strace -Z myapp 2>&1 | grep ENOENT   # find missing config files instantly
ls -l /proc/$$/fd                    # your shell's open file descriptors
man 2 syscalls                       # the full catalogue (section 2 = syscalls)
cat /proc/self/maps | grep vdso      # the vDSO in your process
cat /proc/interrupts | head          # interrupts since boot
```

## Check your understanding

1. Why can't a user program simply jump into kernel code at an address of its
   choosing?
2. `strace` shows `python script.py` calling `openat`, never "fopen". Why?
3. What are the only three events that cause kernel code to run?
4. Why does `clock_gettime()` not actually enter the kernel?
5. A process is stuck sleeping in `read()`. What has to happen for it to wake
   — and how does the kernel find the right process?

*(Answers: the CPU enforces the boundary in hardware — the SYSCALL instruction
atomically switches to ring 0 and jumps to a fixed kernel entry point; user
code controls THAT it enters, never WHERE; `fopen` is a glibc/libc function
that internally calls `openat()` — strace sees the actual syscall, not the
wrapper; syscalls, interrupts, and exceptions — that's it, the kernel never
runs "spontaneously"; data must arrive at the socket/pipe/file the process is
waiting on — the interrupt handler for that device processes the data, TCP
matches the 4-tuple to find the correct socket, the kernel wakes the process
blocked on that socket's wait queue by marking it runnable.)*

---

**Next:** Part II begins with the kernel's favourite object — the process —
and what `fork()` and `exec()` really do.
