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
└── sched_entity               → scheduler bookkeeping (vruntime…)
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
cat /proc/$$/status | head -6     # $$ = your shell's PID
ps -eo pid,ppid,stat,comm | head
```

`/proc/<pid>/` is the kernel's live view of each process — its command line,
environment, fds, memory maps. The `ps` and `top` commands are merely pretty
parsers of `/proc`.

## fork(): creation by cloning

Unix has a famously strange way to create processes: you don't "spawn program
X". Instead, a process **duplicates itself** with `fork()`:

```c
pid_t pid = fork();
if (pid == 0) {
    // child: an almost-perfect copy of the parent
} else {
    // parent: pid holds the child's PID
}
```

One call, **two returns** — once in each process. The child gets a copy of the
parent's memory, fds, working directory, environment.

"Copy" is a lie the kernel tells, and a brilliant one: **copy-on-write
(COW)**. Fork copies only the page tables, marking all memory read-only in
both processes. They physically share every page until one of them *writes*;
only then does the kernel copy that single page. Forking a 2 GB process is
nearly instant and costs almost no RAM.

## exec(): becoming someone else

The second half of the duo: `execve(path, argv, envp)` **replaces** the
calling process with a new program. Same PID, same fds (by default) — but the
address space is thrown away and rebuilt from the new executable.

So when you type `ls -l` in bash:

```text
bash ──fork()──► bash (child, a clone)
                   │ child sets up redirections (plain fd manipulation)
                   └─execve("/usr/bin/ls", ["ls","-l"], env)
                          ↓
                      ls runs, writes to stdout, exits
bash ──wait()──◄── kernel notifies: child finished
```

This two-step design looks odd but is why shells are so powerful: **between
fork and exec, the child sets up its own world** — redirect output, change
directory, drop privileges, `unshare()` namespaces… — using ordinary code,
before the new program ever starts. Containers exploit exactly this gap.

```bash
strace -f -e trace=process bash -c 'ls' 2>&1 | grep -E 'clone|exec|wait|exit'
```

## Death, wait(), and zombies

When a process exits, it doesn't fully disappear. The kernel keeps a stub of
its `task_struct` — the exit status — until the parent collects it with
`wait()`. Between death and collection, the process is a **zombie**
(state `Z` in `ps`). Zombies hold no memory worth speaking of, just a PID.

- Parent waits → zombie reaped, PID freed. Normal life.
- Parent never waits (buggy daemon) → zombies accumulate.
- Parent dies first → orphaned children are **re-parented to PID 1**, whose
  sacred duty is to wait for them.

> **Container gotcha, years early:** inside a container, *your* process is
> PID 1. If you run something that forks workers (a shell script wrapping a
> server, say) and your PID 1 never calls `wait()`, zombies pile up. This is
> why `docker run --init` (a tiny reaping init) exists. Process semantics
> don't change inside containers — that's the whole point of containers.

Signals are the other half of process death: `kill -TERM <pid>` asks
politely (catchable), `kill -KILL` is not a signal *to* the process but an
instruction to the kernel to destroy it (uncatchable). PID 1 is special again:
signals it hasn't installed handlers for are ignored — which is why a naive
`docker stop` can hang 10 seconds then SIGKILL.

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
PID".

```bash
ls /proc/$(pgrep -f firefox | head -1)/task/   # one dir per thread
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
| Running/runnable | `R` | On a CPU, or in the queue for one |
| Interruptible sleep | `S` | Waiting for an event (data, timer) — the normal resting state |
| Uninterruptible sleep | `D` | Waiting on I/O, won't even take signals (stuck NFS = `D` forever) |
| Stopped | `T` | Paused by `SIGSTOP`/`Ctrl-Z` |
| Zombie | `Z` | Dead, awaiting `wait()` |

A healthy system is mostly `S` — hundreds of processes asleep, waiting for
work, costing nothing but memory.

## Try it yourself

```bash
( sleep 100 & ); ps -o pid,ppid,stat,comm -p $!   # watch re-parenting
strace -f -e trace=clone,execve,wait4 sh -c 'date' 2>&1 | tail -5
cat /proc/self/status | grep -E 'Pid|PPid|Threads'
top -H -p $(pgrep -f firefox | head -1)            # threads of one process
```

## Check your understanding

1. Why is `fork()` cheap even for a huge process?
2. What problem do zombies solve? (Hint: who needs the exit status?)
3. In `clone()` terms, what's the difference between a thread and a container?

---

**Next:** ten processes are runnable, four CPUs exist. Who runs? The
scheduler decides — let's see how.
