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

## What system calls look like

There are ~450 syscalls on x86-64. The famous ones form small families:

| Family | Syscalls | Purpose |
|---|---|---|
| Files | `open` `read` `write` `close` `stat` `lseek` | All file I/O |
| Processes | `fork` `execve` `exit` `wait4` `kill` | Create/run/end processes |
| Memory | `mmap` `brk` `munmap` `mprotect` | Ask for / manage memory |
| Network | `socket` `bind` `connect` `accept` `sendto` | All networking |
| Info | `getpid` `getuid` `uname` `clock_gettime` | Ask about yourself/system |
| **Containers** | `clone` `unshare` `setns` `pivot_root` | Namespaces — Part III! |

You almost never invoke these directly. The **C library (glibc)** wraps each
one in an ordinary function, and every language runtime (Python, Go, Node…)
ultimately funnels into the same syscalls. `printf()` → `write()`.
Python's `open()` → `openat()`. There is no other road to the hardware.

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
name much more than files: pipes, sockets, devices, timers, even processes
(`pidfd`) are all fds. *Everything is a file (descriptor).*

```bash
ls -l /proc/self/fd      # the fd table of the process running this very ls
```

## Mode switch ≠ context switch

Two terms people mix up:

- a **mode switch** is one process going user → kernel → user (every syscall);
  cheap-ish (~hundreds of ns).
- a **context switch** is the kernel pausing one process and resuming
  *another* — saving registers, switching address spaces. More expensive,
  and the subject of the scheduling chapter.

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

## Try it yourself

```bash
strace -c true                       # the minimal program's syscall bill
strace -e trace=network curl -s example.org > /dev/null
ls -l /proc/$$/fd                    # your shell's open file descriptors
man 2 syscalls                       # the full catalogue (section 2 = syscalls)
```

## Check your understanding

1. Why can't a user program simply jump into kernel code at an address of its
   choosing?
2. `strace` shows `python script.py` calling `openat`, never "fopen". Why?
3. What are the only three events that cause kernel code to run?

---

**Next:** Part II begins with the kernel's favourite object — the process —
and what `fork()` and `exec()` really do.
