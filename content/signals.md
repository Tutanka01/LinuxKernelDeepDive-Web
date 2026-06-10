# Signals: The Kernel's Asynchronous Notifications

> **Goal:** master Linux signals — the kernel's mechanism for asynchronously
> notifying a process of events. Understand delivery, blocking, handlers, the
> special status of SIGKILL and SIGSTOP, and why signals explain almost all
> the weirdness of container lifecycle.

## What a signal actually is

A signal is a **number**. The kernel delivers it to a process by setting a bit
in the process's `task_struct → pending` bitmask. On the next return from
kernel to user space (after any syscall or timer interrupt), the kernel checks
the mask and, if a bit is set, *handles* it. That's it. No queue, no message,
no payload (except `siginfo_t` for a few signals) — just a number and the
fact that it was sent.

```text
sender                         target process
  │                                │
  │ kill(pid, SIGTERM)             │ (running or sleeping)
  │    │                           │
  │    ▼                           │
  │ kernel sets bit 15 in          │
  │   task_struct→pending          │
  │   makes process RUNNABLE       │ ← if it was sleeping
  │                                │
  │                                ▼
  │                          next return from kernel:
  │                          check pending mask
  │                          SIGTERM is pending →
  │                             default: terminate
  │                             or: call the handler
```

Key properties:
- **Blockable** — a process can mask (block) most signals; they stay pending
  until unblocked. Think: "I'll deal with this after the critical section."
- **Unreliable by default** — if the same signal arrives while it's already
  pending, the second may be lost (only one bit per signal number). POSIX
  real-time signals (SIGRTMIN–SIGRTMAX) are queued and don't have this
  problem.
- **Default action** — every signal has a default: terminate, terminate+core,
  stop, continue, or ignore. Processes can override most with a handler.
- **Sent by the kernel too** — not just `kill(1)`. SIGSEGV on bad memory
  access, SIGPIPE on write to broken pipe, SIGCHLD on child exit, SIGALRM
  from timer. The kernel is the actual sender in all these cases.

## The signal list that matters daily

| Signal | Number | Default | Kernel sends when… |
|---|---|---|---|
| `SIGHUP` | 1 | Terminate | Terminal hangup (or container stop signal) |
| `SIGINT` | 2 | Terminate | Ctrl+C (terminal sends to foreground process) |
| `SIGQUIT` | 3 | Core dump | Ctrl+\ |
| `SIGKILL` | 9 | Terminate (uncatchable) | You ask the kernel to destroy the process. Not *sent to* — *enforced on*. |
| `SIGTERM` | 15 | Terminate | Polite "please exit" (default for `kill` and `docker stop`) |
| `SIGSTOP` | 19 | Stop (uncatchable) | `kill -STOP`, job control |
| `SIGCONT` | 18 | Continue | Resume after STOP |
| `SIGCHLD` | 17 | Ignore | Child process exited, stopped, or continued |
| `SIGSEGV` | 11 | Core dump | Invalid memory access (MMU trapped it) |
| `SIGPIPE` | 13 | Terminate | Write to a pipe/socket with no reader |
| `SIGBUS` | 7 | Core dump | Hardware memory error, misaligned access |
| `SIGALRM` | 14 | Terminate | `alarm()` timer expired |
| `SIGUSR1/2` | 10,12 | Terminate | User-defined (daemon reload, custom IPC) |

## The two uncatchable signals

**SIGKILL** and **SIGSTOP** cannot be caught, blocked, or ignored. Period.
The kernel enforces them at the lowest level — the signal handler check
is bypassed entirely. This is why `kill -9` always works (unless the process
is in uninterruptible sleep — D state — where signal delivery is suspended
until the I/O completes).

This is also why `docker stop` has a 10-second timeout then SIGKILL: it first
sends SIGTERM (gives the process a chance to clean up), waits 10 seconds,
then SIGKILL (guaranteed death).

```bash
# Watch the dance:
docker stop --time 30 my-container  # 30-second grace period
# Internally: SIGTERM → wait 30s → SIGKILL
```

## Handlers: catching signals

A process installs a handler with `signal()` (legacy) or `sigaction()` (modern):

```c
#include <signal.h>

void handle_sigterm(int sig) {
    // clean up, close fds, write checkpoint...
    _exit(0);  // safe: limited set of async-signal-safe functions
}
int main() {
    struct sigaction sa = { .sa_handler = handle_sigterm };
    sigaction(SIGTERM, &sa, NULL);  // install handler
    // ... work ...
}
```

The handler runs asynchronously — the kernel hijacks the process's user-space
execution and calls the handler function on the existing stack, right after
returning from kernel mode. This creates the **async-signal-safety** problem:
the handler could be running while the process was in the middle of `malloc()`,
`printf()`, or holding a lock. If the handler calls `malloc()` too, you have
a re-entrant lock → deadlock.

The solution: handlers should only call **async-signal-safe** functions
(write, _exit, close, etc. — `man 7 signal-safety`). Or use `signalfd()` to
receive signals as readable bytes on a file descriptor — no handler at all,
just add the fd to your event loop.

```c
// The modern, safe pattern: receive signals via fd
int sfd = signalfd(-1, &mask, 0);  // read signals from this fd
struct signalfd_siginfo si;
read(sfd, &si, sizeof(si));        // blocks until a signal arrives
if (si.ssi_signo == SIGTERM) { cleanup(); }
```

## Blocking, pending, and the signal mask

Every process has a **signal mask** (blocked set). If a signal is blocked, the
kernel marks it pending but doesn't deliver it until the process unblocks it.
The mask is inherited across fork and preserved across exec (unless the
handler was SIG_IGN, which survives exec).

```c
sigset_t set;
sigemptyset(&set);
sigaddset(&set, SIGTERM);
sigprocmask(SIG_BLOCK, &set, NULL);   // block SIGTERM during critical work
// ... do something that must not be interrupted ...
sigprocmask(SIG_UNBLOCK, &set, NULL); // SIGTERM delivered here if pending
```

```bash
# Shell equivalent:
trap '' INT     # block Ctrl+C (ignore SIGINT)
trap - INT      # restore default
```

Check your signals live:

```bash
cat /proc/$$/status | grep -E 'SigCgt|SigIgn|SigBlk'  # Caught/Ignored/Blocked bitmasks
kill -l                  # list all signal numbers
```

## Signals and containers: the production story

Everything in this chapter explains container lifecycle behaviour:

### `docker stop` internals

```
docker stop my-container
  → dockerd sends SIGTERM to PID 1 inside the container
  → wait for process to exit (timeout = 10s, configurable with -t)
  → if still alive: send SIGKILL (kernel-enforced death)
  → exit code 143 = 128 + SIGTERM(15)   ← clean shutdown
  → exit code 137 = 128 + SIGKILL(9)    ← forced kill
```

If your process does NOT handle SIGTERM, the default is immediate termination —
no cleanup, no graceful shutdown. This is the #1 "my container takes 10 seconds
to stop" bug.

### PID 1 signal specialness

The process chapter noted that PID 1 ignores signals it hasn't installed
handlers for. Consequence inside containers: if your entrypoint is a shell
script (`#!/bin/sh`) and you run `docker stop`, the shell *doesn't* forward SIGTERM
to the background process it launched. You need:

```bash
# entrypoint.sh — good pattern
exec my-server &    # start server in background
trap 'kill -TERM $! && wait' TERM  # forward SIGTERM
wait                # wait for children
```

Or use `docker run --init` (inserts `tini` as PID 1 — a tiny init that reaps
zombies and forwards signals properly).

### SIGPIPE and the broken pipe

`curl ... | head` — curl writes a lot, head reads a little and exits. The
pipe breaks. Kernel sends SIGPIPE to curl. Curl terminates. This is why
"Broken pipe" appears in error logs from pipes and network connections.

## Signals vs other notification mechanisms

| Mechanism | When to use |
|---|---|
| Signals | System events (child died, segfault, shutdown request) — asynchronous |
| `signalfd()` | Same events, but integrated into poll/epoll event loop |
| `eventfd()` | User-space notification between threads/processes |
| `pidfd + waitid()` | Monitor a specific child without SIGCHLD races |
| `timerfd()` | Timer notifications as readable fds |

## Real-time signals

POSIX real-time signals (SIGRTMIN to SIGRTMAX, typically 34-64) have three
differences:
1. **Queued** — the kernel keeps a queue per signal number, so multiple
   deliveries are not merged.
2. **Ordered** — lower-numbered signals delivered first.
3. **Carry a value** — `sigqueue(pid, signo, value)` sends a `union sigval`.

These are what the Linux kernel itself uses for some internal notifications.
For most applications, standard signals + `signalfd()` is cleaner than RT
queues.

## Try it yourself

```bash
# Block Ctrl+C in a subshell
bash -c 'trap "echo caught" INT; sleep 5; echo done'  # press Ctrl+C
# SIGTERM vs SIGKILL
(sleep 100 &); kill -TERM $! && sleep 1 && ps -p $!
(sleep 100 &); kill -KILL $! && sleep 1 && ps -p $!   # gone instantly
# See your shell's signal dispositions:
cat /proc/$$/status | grep Sig
# Watch a container's signal story:
docker run -d --name sigtest alpine sleep 100
docker stop -t 5 sigtest && docker logs sigtest  # exit 143 if clean
```

## Check your understanding

1. Why is SIGKILL uncatchable — what happens in the kernel that's different
   from other signals?
2. A process blocks SIGTERM for a critical section. SIGTERM arrives during
   that section. What happens, and when?
3. `docker stop` takes exactly 10 seconds every time. What's wrong with the
   container's PID 1?
4. Why is calling `printf()` inside a signal handler dangerous?

*(Answers: the kernel skips the signal handler dispatch entirely for SIGKILL
— it directly sets the process as TASK_DEAD at the lowest level without
consulting the handler table; the signal is marked pending in the bitmask and
delivered the moment the process calls sigprocmask(SIG_UNBLOCK, …), which is
after the critical section ends; the process (PID 1 inside the container) is
not handling SIGTERM — it either didn't install a handler or it's a shell
script that doesn't forward signals to child processes, so it ignores SIGTERM
until the 10-second timeout triggers SIGKILL; the handler may interrupt
printf() while it's holding an internal stdio lock — if the handler calls
printf() too, it tries to acquire the same lock and deadlocks. Use write()
(fd 2, msg, len) instead, or use signalfd.)*

---

**Next:** the glue between processes — pipes, FIFOs, and Unix domain sockets.
How the kernel creates byte-streams between processes that let the shell's
pipe operator work, and how systemd, Docker, and PostgreSQL use them under
the hood.
