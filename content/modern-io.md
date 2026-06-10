# Modern I/O & io_uring

> **Goal:** understand why Linux I/O has so many APIs, what problem each one
> solves, and why `io_uring` is a structural change rather than another wrapper
> around `read()` and `write()`.

## The old contract: blocking syscalls

The simplest I/O path is synchronous:

```c
n = read(fd, buf, len);
```

The process enters the kernel and does not return until data is available,
an error occurs, or a signal interrupts the call. This is a beautiful API for
local files and small programs. It is also a scalability problem when one
thread must manage thousands of sockets or slow storage operations.

The kernel has three costs to keep in mind:

```text
syscall entry/exit
copying data between user and kernel
sleeping/waking tasks when I/O cannot complete immediately
```

The history of Linux I/O APIs is mostly a history of reducing those costs
without destroying the Unix file descriptor model.

## Readiness APIs: select, poll, epoll

`select()` and `poll()` ask: "which file descriptors are ready right now?"
They do not perform I/O. They tell user space which operation is unlikely to
block.

`epoll` improves the scaling model:

```text
epoll_ctl()  register interest once
epoll_wait() receive readiness events many times
read/write   still perform the actual I/O
```

This is why classic high-concurrency servers are event loops:

```text
epoll_wait()
  ↓
for each ready fd:
    read until EAGAIN
    process
    write until EAGAIN
```

The catch: readiness is not completion. `epoll` says "you can probably read
now"; user space must then call `read()`. That means at least one syscall for
readiness and more syscalls for actual operations. It also handles sockets
beautifully but does not make buffered file I/O truly asynchronous.

## Completion APIs: the better question

For high-performance systems, the more useful question is often:

```text
Here are operations I want. Tell me when each one is done.
```

That is completion-based I/O. Instead of waiting for readiness and then doing
work, user space submits work and later reaps completions.

This matches hardware better. NVMe queues, network cards, and modern storage
devices already speak in producer/consumer rings:

```text
software submits descriptors
device/kernel consumes them
device/kernel writes completion descriptors
software reaps completions
```

`io_uring` brings that shape to the Linux syscall interface.

## io_uring in one diagram

An `io_uring` instance has two shared rings:

```text
user space                                      kernel

SQEs: submission queue entries
  [read fd=4 buf=X len=4096]
  [write fd=7 buf=Y len=128]
  [accept listenfd=3]
        ↓
   submission ring  ─────────────────────────► kernel consumes work

   completion ring  ◄───────────────────────── kernel posts CQEs
        ↓
CQEs: completion queue entries
  [user_data=A result=4096]
  [user_data=B result=128]
  [user_data=C result=new_fd]
```

The rings are memory-mapped into user space. User space fills submission queue
entries (SQEs), tells the kernel they are available, and later reads
completion queue entries (CQEs). The `user_data` field is the application
cookie that connects a completion back to its request.

The basic loop:

```text
prepare SQE
submit
do other work
peek/wait for CQE
handle result
mark CQE seen
```

The important shift: the unit of API is no longer "call this syscall now".
The unit is "enqueue this operation".

## What an SQE describes

An SQE is a compact operation descriptor:

```text
opcode          READV, WRITEV, ACCEPT, CONNECT, TIMEOUT, FSYNC, ...
fd              target file descriptor or fixed-file index
addr/len        buffer, sockaddr, iovec, timeout, depending on opcode
offset          file offset or special value
flags           behavior modifiers
user_data       application-owned completion cookie
```

The CQE returns:

```text
user_data       copied from SQE
res             result: bytes, fd, 0, or negative errno
flags           extra completion metadata
```

`res` is not `errno` via thread-local state. Negative values encode failure:
`-EAGAIN`, `-ECANCELED`, `-ENOENT`, etc. This is friendlier to batched,
asynchronous code because each completion carries its own outcome.

## Why it can be faster

`io_uring` attacks several overheads at once:

| Feature | What it saves |
|---|---|
| Shared rings | less syscall traffic for submission/completion |
| Batching | many operations submitted/reaped together |
| Registered buffers | repeated pin/copy bookkeeping avoided |
| Registered files | repeated fd table lookups reduced |
| SQPOLL | kernel thread polls submissions, fewer syscall entries |
| Linked operations | dependencies expressed without returning to user space |
| Multishot ops | one request can produce multiple completions |

Not every workload wins. If your program does one blocking read at a time,
`io_uring` adds complexity. If your program manages tens of thousands of
sockets, storage requests, timeouts, accepts, sends, and cancels, the ring
model becomes a different class of machine.

## Buffered files vs direct I/O

Linux file I/O has two major personalities.

Buffered I/O:

```text
read file
  ↓
page cache
  ↓
copy to user buffer
```

The page cache gives reuse, readahead, writeback, and normal filesystem
semantics. But buffered file reads may need page faults, cache misses,
allocation, filesystem locks, or disk I/O. Historically, making this fully
asynchronous was hard.

Direct I/O (`O_DIRECT`) bypasses the page cache:

```text
storage DMA ↔ user buffer
```

This avoids cache pollution and extra copies for databases and storage
engines, but requires alignment discipline and gives up many page-cache
benefits. `io_uring` is attractive for both worlds, but the performance model
differs. With direct I/O and registered buffers, it can map closely to storage
queue semantics. With buffered I/O, it improves API structure, batching, and
async behavior, but still interacts with page cache realities.

## Registered buffers and files

Every normal syscall that takes a user pointer or fd forces the kernel to
validate, pin, look up, and account. Some of that is unavoidable; some can be
amortized.

With registered buffers:

```text
setup:  pin these memory ranges for I/O
steady: SQE references buffer id
```

With registered files:

```text
setup:  register this fd table with the ring
steady: SQE references fixed file slot
```

This matters for engines that repeatedly perform I/O against a known set of
connections or files. It is less compelling for one-shot scripts.

The trade-off is lifecycle complexity. Pinned memory is not free; registered
state must be updated when files rotate, connections close, or buffers are
reused. High-performance APIs often buy speed by making lifetime explicit.

## SQPOLL and IOPOLL

`SQPOLL` creates a kernel thread that polls the submission queue. User space
can place SQEs into the ring and, in the hot path, avoid a syscall to notify
the kernel. This is excellent when the ring is busy enough to justify a
polling kernel thread. It is wasteful when the workload is sparse.

`IOPOLL` is for polling capable block devices and direct I/O. Instead of
interrupt-driven completion, completions can be polled. This can reduce
latency and interrupt overhead, at the cost of CPU.

The pattern is familiar from kernel performance work:

```text
interrupts save CPU but add wakeup latency
polling burns CPU but can reduce tail latency
```

There is no universal winner. Latency budgets decide.

## Linked operations and async control flow

`io_uring` can express chains:

```text
accept
  → recv
  → send
  → close on failure
```

Linked SQEs let the kernel understand dependencies between operations. If one
operation fails, later linked operations can be canceled. This reduces the
back-and-forth where user space wakes only to submit the obvious next step.

Timeouts and cancellation are first-class operations too. That is crucial:
large async systems are not just reads and writes. They are reads, writes,
timeouts, retries, accept loops, shutdowns, backpressure, and cancellation.
An I/O API that cannot cancel cleanly eventually leaks complexity into the
application architecture.

## Multishot operations

Some operations naturally produce many events:

```text
accept many connections
receive many datagrams
poll many readiness transitions
```

A multishot request can stay armed and produce multiple CQEs. That reduces the
submit/rearm loop and helps busy servers. It also requires careful CQE
handling because one logical request no longer maps to one completion.

This is a recurring `io_uring` theme: the API lets you move more control flow
into the kernel boundary, but your application state machine must become
precise.

## Zero-copy is not a spell

People often talk about zero-copy as if copies are the only cost. In reality,
zero-copy trades copies for pinning, accounting, fragmentation pressure,
device constraints, and completion complexity.

For network send paths, zero-copy can avoid copying payloads into kernel
buffers, but user memory must remain stable until the kernel/device is done.
That means completion notification becomes part of memory ownership.

For storage, direct I/O can avoid page cache copies, but you lose cache
reuse/readahead and inherit alignment constraints.

The honest rule:

```text
zero-copy helps when copy cost dominates and lifetimes are well controlled
zero-copy hurts when it destroys locality, caching, or simplicity
```

## The hidden fallback problem

Not every operation can complete asynchronously in the exact path you imagine.
The kernel may need worker threads for operations that can block. Filesystems,
metadata operations, buffered cache misses, and locking can force work out of
the immediate submission path.

This does not make `io_uring` fake. It means the implementation is a hybrid:
some operations complete inline, some are queued to async workers, some depend
on filesystem/device support, and some are better suited to direct I/O.

When benchmarking, look for:

```bash
perf top
pidstat -t
cat /proc/pressure/io
cat /proc/pressure/cpu
```

If your "async" system is just moving blocking work onto a hidden worker pool,
tail latency and CPU pressure will tell on you.

## Security implications

`io_uring` expands the shape of the syscall interface. A process can submit
operations indirectly through a ring, use registered files, ask for async
workers, and combine operations in ways that are harder to reason about than
one syscall at a time.

This matters for sandboxes:

- seccomp profiles must understand `io_uring_setup`, `io_uring_enter`, and
  `io_uring_register`;
- policy that only sees those syscalls may miss the operation encoded inside
  SQEs unless additional kernel mediation is present;
- registered files and fixed resources make lifetime and authority tracking
  more subtle;
- some hardened environments disable or restrict `io_uring` for untrusted
  workloads.

The lesson is not "`io_uring` is bad". The lesson is that powerful async
interfaces need policy models that understand submitted operations, not only
syscall numbers.

## Choosing the API

| Workload | Usually sensible |
|---|---|
| simple CLI | blocking `read`/`write` |
| many sockets, portable | nonblocking + `epoll` |
| high-performance Linux server | `io_uring` |
| database/storage engine | `io_uring` + direct I/O + registered buffers, benchmarked |
| cross-platform runtime | abstraction over epoll/kqueue/IOCP/io_uring |
| tiny service with low concurrency | boring blocking I/O may win |

The highest-performance API is not automatically the best architecture.
`io_uring` pays off when batching, completion semantics, and reduced syscall
traffic simplify the hot path enough to justify the state machine.

## Source map

| Area | Kernel path |
|---|---|
| core implementation | `io_uring/` |
| public API | `include/uapi/linux/io_uring.h` |
| VFS read/write path | `fs/read_write.c` |
| file table | `fs/file.c` |
| block layer | `block/` |
| networking send/recv | `net/` |
| page cache | `mm/filemap.c` |

The code is easier to read if you keep the ring model fixed in your head:
SQEs describe work, the kernel turns them into internal requests, CQEs report
results, and registered resources reduce repeated lookup/pinning overhead.

## Two sharp checks

- Why does `epoll` scale readiness notification but still require separate
  syscalls to perform the actual I/O?
- When can zero-copy make latency worse rather than better?

---

**Next:** the toolbox chapter now lands differently: `/proc`, `strace`, `perf`,
and eBPF are not isolated tools, but different windows into the same kernel
machinery.
