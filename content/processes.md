# Processes & Threads

> **Goal:** understand what a process *is* inside the kernel, how `fork()` and
> `exec()` create everything you see running, how processes die and are
> mourned, and why threads are just processes wearing a trenchcoat.

## What a process actually is

To you, a process is "a running program". To the kernel, it's a data
structure: `struct task_struct`, a ~10 KB C structure holding everything
the kernel knows about one thread of execution:

```text
task_struct (one per thread)
├── pid, tgid                  → its identity
├── state                      → Running? Sleeping? Zombie?
├── mm        ──────────────►  the address space (shared by threads)
├── files     ──────────────►  the file descriptor table
├── cred                       → UID, GID, capabilities
├── parent, children, sibling  → its place in the family tree
├── nsproxy   ──────────────►  its namespaces  ← containers live here!
├── cgroups                    → its resource-control groups
├── sched_entity               → scheduler bookkeeping (vruntime…)
├── stack                      → kernel stack (8–16 KB, separate from user stack)
├── thread_info                → flags, preempt count, CPU-local metadata
└── signal_struct              → pending signals, signal handlers
```

Note what's *in* there: the address space, the fd table, the namespaces, the
cgroups. A "process" is really a bundle of references to kernel objects —
and creating processes is largely a question of which of those objects the
child **shares** and which it **copies**. That's the key to understanding
fork, threads, *and* containers, all at once.

## The family tree

Every process has a parent; everything descends from PID 1. Look at yours:

```bash
pstree -p | less
cat /proc/$$/status | head -20    # $$ = your shell's PID
ps -eo pid,ppid,stat,comm | head
```

`/proc/<pid>/` is the kernel's live view of each process — its command line,
environment, fds, memory maps, stack (the kernel stack — root-only; shows
where in the kernel the process is sleeping). The `ps` and `top` commands
are merely pretty parsers of `/proc`.

### Kernel threads

Not every PID belongs to a user program. Kernel threads — processes that run
only in kernel space, with no user-space address — handle background work:

```bash
ps aux | grep '\[.*\]'
# [ksoftirqd/0]    ← bottom-half interrupt processing
# [kworker/u8:1]   ← workqueue worker
# [kswapd0]        ← memory reclaim
# [kcompactd0]     ← memory compaction
# [migration/0]    ← NUMA page migration
```

Kernel threads are `task_struct` instances marked with `PF_KTHREAD`. They have
no `mm` pointer (no userspace), and they're created by `kthread_create()`, not
`fork()`. They exist for the life of the system.

## fork(): creation by cloning

Unix has a famously strange way to create processes: you don't "spawn program
X". Instead, a process **duplicates itself** with `fork()`:

```c
pid_t pid = fork();
if (pid == 0) {
    // child: an almost-perfect copy of the parent
} else if (pid > 0) {
    // parent: pid holds the child's PID
} else {
    // pid == -1: fork failed (errno set)
}
```

One call, **two returns** — once in each process. The child gets a copy of the
parent's memory, fds, working directory, environment, signal dispositions,
resource limits, and cgroup memberships.

"Copy" is a lie the kernel tells, and a brilliant one: **copy-on-write
(COW)**. Fork copies only the page tables, marking all memory read-only in
both processes. They physically share every page until one of them *writes*;
only then does the kernel copy that single page. Forking a 2 GB process is
nearly instant and costs almost no RAM — only the page table structures
themselves, which are a few MB at most.

But COW has a cost if either process writes aggressively: the resulting page
faults (minor faults, fast but not free), the allocated physical pages, and
the TLB shootdowns to synchronize all CPU cores. If a language runtime forks a
huge process and immediately writes to most of it, the "instant" fork
materializes into physical memory line by line.

### fork() and fds: what the child gets

The child inherits open file descriptors — by reference, not copy. Both parent
and child share the same kernel `struct file`. This means:

- If the child reads from fd 3, the parent's fd 3 advances too (shared file
  position).
- To break the sharing, use `O_CLOEXEC` on fds that children shouldn't
  inherit, or explicitly close them in the child between fork and exec.
- This sharing is why `fork() + exec()` is the standard pattern: the exec
  replaces the child's memory and the new program gets fresh state.

## exec(): becoming someone else

The second half of the duo: `execve(path, argv, envp)` **replaces** the
calling process with a new program. Same PID, same fds (by default) — but the
address space is thrown away and rebuilt from the new executable.

So when you type `ls -l` in bash:

```text
bash ──fork()──► bash (child, a clone)
                   │ child sets up redirections (plain fd manipulation)
                   │ child may: dup2("out.txt", 1), chdir(), setenv()...
                   └─execve("/usr/bin/ls", ["ls","-l"], env)
                          ↓
                      ls runs, writes to stdout, exits
bash ──wait()──◄── kernel notifies: child finished with exit code 0
```

This two-step design looks odd but is why shells are so powerful: **between
fork and exec, the child sets up its own world** — redirect output, change
directory, drop privileges, `unshare()` namespaces… — using ordinary code,
before the new program ever starts. Containers exploit exactly this gap.

```bash
strace -f -e trace=process bash -c 'ls' 2>&1 | grep -E 'clone|exec|wait|exit'
```

### The exec lifecycle

What execve actually does, step by step:

1. Kernel verifies the executable exists, is readable, has a valid ELF header.
2. Kernel checks setuid/setgid bits and file capabilities — may change
   credentials if the binary requests it (and no_new_privs isn't set).
3. Kernel destroys the old address space (mm_struct freed, VMA list cleared).
4. Kernel reads the ELF program headers, maps code and data segments at their
   requested addresses (with correct permissions: r-x for .text, rw- for
   .data, rw- for stack, rw- for heap).
5. Kernel sets up the userspace stack: argv, envp, auxiliary vector — and an
   empty signal handler list.
6. Kernel installs the process's seccomp filter (if set) — this is the
   irrevocable security boundary point.
7. Kernel returns to userspace at the ELF entry point. The process is now
   running the new executable.

## Death, wait(), and zombies

When a process exits, it doesn't fully disappear. The kernel keeps a stub of
its `task_struct` — the exit status — until the parent collects it with
`wait()`. Between death and collection, the process is a **zombie**
(state `Z` in `ps`). Zombies hold no memory worth speaking of, just a PID
and an exit code.

- Parent waits → zombie reaped, PID freed. Normal life.
- Parent never waits (buggy daemon) → zombies accumulate.
- Parent dies first → orphaned children are **re-parented to PID 1** (or to
  the nearest sub-reaper in the ancestry), whose sacred duty is to wait for
  them.

> **Container gotcha, years early:** inside a container, *your* process is
> PID 1. If you run something that forks workers (a shell script wrapping a
> server, say) and your PID 1 never calls `wait()`, zombies pile up. This is
> why `docker run --init` (a tiny reaping init) exists. Process semantics
> don't change inside containers — that's the whole point of containers.

### The exit path (what happens on process death)

1. Process calls `exit_group(status)` (or is killed by a signal).
2. Kernel walks the task's threads — signals them all to die, waits for them.
3. Kernel closes all file descriptors (each close may trigger a filesystem
   flush, a socket shutdown, etc.).
4. Kernel reparents children to the nearest sub-reaper or PID 1.
5. Kernel saves the exit status in `task_struct`.
6. Kernel sets state to `TASK_DEAD` (EXIT_ZOMBIE). The address space is freed
   immediately (mm_struct dropped), but the small task_struct stub remains.
7. Kernel sends SIGCHLD to the parent, waking it from wait().

Signals are the other half of process death: `kill -TERM <pid>` asks
politely (catchable — the process can handle SIGTERM and do cleanup),
`kill -KILL` is not a signal *to* the process but an instruction to the kernel
to destroy it (uncatchable). PID 1 is special again: signals it hasn't
installed handlers for are ignored — which is why a naive `docker stop` can
hang 10 seconds then SIGKILL.

```bash
(sleep 100 &) ; ps -o pid,ppid,stat,comm -p $!    # watch re-parenting
sleep 5 & ; grep State /proc/$!/status              # S = interruptible sleep
kill -9 $! ; grep State /proc/$!/status             # Z = zombie (for a moment)
wait $!                                             # wait reaps it
```

## Threads: processes with maximum sharing

Here is Linux's elegant secret: **the kernel has no separate concept of a
thread.** Everything is a `task_struct`. The general creation syscall is
`clone()`, and its flags say what the child shares with the parent:

```c
// fork() is roughly:
clone(SIGCHLD);                                  // share nothing, copy all

// creating a thread (what pthread_create does) is roughly:
clone(CLONE_VM | CLONE_FILES | CLONE_FS | CLONE_SIGHAND | CLONE_THREAD, ...);
//      ↑ share address space, fd table, cwd, signal handlers, thread group
```

Threads are just tasks that **share an address space** (and a few other
things). They get their own PID internally (the kernel calls it `tid`), but
share a **thread group ID (tgid)** — which is what `ps` shows you as "the
PID". All threads in a process share the same `tgid`, and `getpid()` returns
that tgid, not the tid.

```bash
ls /proc/$(pgrep -f firefox | head -1)/task/   # one dir per thread
# pid 1234, 1235, 1236... all threads of the firefox process
cat /proc/$(pgrep firefox | head -1)/status | grep Threads  # thread count
top -H -p $(pgrep firefox | head -1)           # show threads individually
```

And now the punchline you can probably see coming:

> `clone()` has *other* flags too: `CLONE_NEWPID`, `CLONE_NEWNET`,
> `CLONE_NEWNS`… Each one gives the child a **new namespace** instead of
> sharing the parent's. **A container is created with the same syscall as a
> thread — just with the sharing flags flipped the other way.**
> Thread = share everything. Container = share as little as possible.

One mechanism, one spectrum: from threads (maximum sharing) through ordinary
processes (copy) to containers (isolate). This is the single most clarifying
idea in all of Linux internals.

## Process states

You'll see these in `ps`/`top` (`STAT` column):

| State | Letter | Meaning |
|---|---|---|
| Running/runnable | `R` | On a CPU, or in the run queue waiting for one |
| Interruptible sleep | `S` | Waiting for an event (data, timer, lock) — the normal state |
| Uninterruptible sleep | `D` | Waiting on I/O, won't take signals (stuck NFS = `D` forever) |
| Stopped | `T` | Paused by `SIGSTOP`/`Ctrl-Z` or ptrace |
| Zombie | `Z` | Dead, awaiting `wait()` from parent |
| Dead | `X` | Fully reaped, about to vanish (transient, rarely seen) |
| Idle | `I` | Kernel idle thread (not shown in list) |

The transitions that matter:

```text
fork() → R  (runnable, waiting for CPU)
scheduled → running (on CPU)
blocks on I/O → S or D
I/O completes → R
receives signal → handled or terminates
exit() → Z → parent wait() → reaped
```

A healthy system is mostly `S` — hundreds of processes asleep, waiting for
work, costing nothing but memory.

You can map these numerically:

```bash
cat /proc/$$/status | grep State
# State: S (sleeping)
```

The kernel state constants: `TASK_RUNNING` (0, includes "actually on CPU"
and "in run queue"), `TASK_INTERRUPTIBLE` (1), `TASK_UNINTERRUPTIBLE` (2),
`TASK_STOPPED` (4), `EXIT_ZOMBIE` (32), `EXIT_DEAD` (16).

## Try it yourself

```bash
( sleep 100 & ); ps -o pid,ppid,stat,comm -p $!   # watch re-parenting
strace -f -e trace=clone,execve,wait4 sh -c 'date' 2>&1 | tail -10
cat /proc/self/status | grep -E 'Pid|PPid|Threads|State'
top -H -p $(pgrep -f firefox | head -1)            # threads of one process
ls -l /proc/$$/fd                                   # your shell's open descriptors
cat /proc/self/mountinfo | wc -l                    # mount namespace contents
```

## Check your understanding

1. Why is `fork()` cheap even for a huge process?
2. What problem do zombies solve? (Hint: who needs the exit status?)
3. In `clone()` terms, what's the difference between a thread and a container?
4. A process is in `D` state and `kill -9` doesn't work. Why?
5. After `fork()`, the child closes fd 3. Does the parent's fd 3 close too?

*(Answers: copy-on-write — only page tables are copied, physical pages shared
until written to; zombies preserve the exit status so the parent can collect it
with wait() and know how the child died; threads use flags like CLONE_VM to
share address space, containers use CLONE_NEW* flags to isolate namespaces —
same syscall, opposite sharing policy; D state is uninterruptible sleep — the
kernel is waiting on I/O and refuses signals until the device responds, and
kill -9 is also a signal (just uncatchable, but still subject to the
D-state lock); no — fds are reference-counted; the file description is shared
between parent and child, closing in one doesn't affect the other's handle,
though the shared file offset advances if either reads/writes.)*

---

**Next:** ten processes are runnable, four CPUs exist. Who runs? The
scheduler decides — let's see how.
