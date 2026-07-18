---
level: internals
kernel: 6.12
verified: 2026-07
minutes: 22
requires: memory, live-migration
---

# Lab: Serve Page Faults from Userspace

> **Goal:** build a small C program that hands a slice of its own address
> space over to a *userspace* fault handler — so that when the main thread
> reads a **mapped but missing** page, the kernel does not zero-fill it; it
> sends you a message and *waits* for you to supply the bytes. This is
> `userfaultfd`, the
> exact primitive [CRIU](#/lab-criu) uses for lazy restore and post-copy
> [live migration](#/live-migration). By the end you will have watched a page
> fault turn into a file-descriptor read plus an `ioctl`, timed it, and broken
> it on purpose.

The [Virtual Memory](#/memory) chapter established the normal contract: touch
an anonymous page that has no physical backing and the kernel's fault handler
transparently allocates a zero page for you. You never notice. `userfaultfd`
rewrites that contract for a chosen range: the fault is *parked*, delivered to
another thread as an event on a file descriptor, and stays parked until that
thread explicitly fills the page with an `ioctl`. The faulting instruction
does not resume until you say so.

"Missing" does **not** mean "unmapped." The `mmap()` has already created a
valid VMA, so the virtual address belongs to the process; what is missing is a
present page-table entry and physical backing for that address. A genuinely
unmapped address belongs to no VMA, cannot be registered with userfaultfd, and
normally faults with `SIGSEGV` instead.

That single capability is what makes post-copy migration possible. In
[Live Migration](#/live-migration) we described how a task can start running on
the destination host *before* all its memory has arrived: the destination
registers the restored memory with `userfaultfd`, lets the process run, and
when it touches a page that hasn't been transferred yet, the fault becomes a
network request back to the source. The page arrives, `UFFDIO_COPY` installs
it, the process resumes. This lab builds that machine in miniature — the
source of the pages is just a `memset` in the same process, but the syscall
choreography is identical to what `criu restore --lazy-pages` performs across a
socket.

Three facts to carry in: `userfaultfd` is *a process serving another region's
page faults from userspace*; the fault becomes a **message you read from an
fd**; the resolution is an **ioctl you issue back down the same fd**. Everything
below is those three facts, made concrete.

## What you need

- Any Linux machine or VM with a kernel ≥ 5.11 (any 6.x, certainly 6.12). Real
  hardware, a cloud instance, a `multipass`/QEMU VM — anything. Unlike the
  [kernel-module lab](#/lab-kernel-module) this runs entirely in userspace, so
  it cannot panic the box; a plain laptop is fine.
- `gcc` (or `clang`) and `make`/`pthread`. On Debian/Ubuntu:
  `sudo apt install -y build-essential`.
- **Root is *not* required**, thanks to one flag. On a modern kernel the
  default is:

```bash
sysctl vm.unprivileged_userfaultfd
```

```text
vm.unprivileged_userfaultfd = 0
```

`0` means an unprivileged process may **not** create a userfaultfd that can
trap *kernel-mode* faults (a hardening measure — userfaultfd has been a
building block in several kernel exploits, because parking a fault lets an
attacker freeze the kernel mid-operation and win a race). But since Linux 5.11
there is an escape hatch that is perfectly safe: pass **`UFFD_USER_MODE_ONLY`**
when creating the fd. The resulting object handles only *userspace* faults
(exactly our case — our main thread reads the pages from userspace), and any
kernel-originated fault on the range gets a `SIGBUS` instead. The kernel doc is
explicit: *"Any user can always create a userfaultfd which traps userspace page
faults only."* Our program uses that flag, so it runs as an ordinary user.

If you ever need to handle kernel faults (a real CRIU restore does), you would
instead run as root, or set `sudo sysctl vm.unprivileged_userfaultfd=1`. We
don't need either here.

## Stage 1 — Build the fault server

Here is the whole program. It mmaps `N` anonymous pages, registers them with a
userfaultfd, spawns a handler thread that waits on the fd and fills each
missing page with a recognizable string, and then — in the main thread —
touches the pages one at a time and prints what it finds. Read the comments;
the syscall sequence is the entire point.

Save as `uffd_demo.c`:

```c
#define _GNU_SOURCE
#include <err.h>
#include <fcntl.h>
#include <linux/userfaultfd.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Older headers may lack this (added in Linux 5.11); define it defensively. */
#ifndef UFFD_USER_MODE_ONLY
#define UFFD_USER_MODE_ONLY 1
#endif

static int    page_size;
static long   uffd;        /* the userfaultfd, shared with the handler thread */
static char  *region;      /* start of the range we serve faults for */
static size_t num_pages;

/* The server thread. It owns fault resolution: wait for a fault, read the
   event, build a page in userspace, and install it with UFFDIO_COPY. */
static void *
fault_handler_thread(void *arg)
{
    (void) arg;
    static struct uffd_msg msg;   /* one fault event, read from the fd */
    int   fault_cnt = 0;
    char *page;

    /* A scratch page we copy FROM. mmap hands back page-aligned, page-sized
       memory, which is exactly what UFFDIO_COPY's source must be. */
    page = mmap(NULL, page_size, PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (page == MAP_FAILED)
        err(EXIT_FAILURE, "mmap scratch");

    for (;;) {
        struct pollfd pollfd = { .fd = uffd, .events = POLLIN };

        /* Block until the kernel has parked a fault for us. Because the fd is
           O_NONBLOCK, we rely on poll() to tell us data is ready. */
        if (poll(&pollfd, 1, -1) == -1)
            err(EXIT_FAILURE, "poll");

        /* Drain exactly one fault event. */
        ssize_t n = read(uffd, &msg, sizeof(msg));
        if (n == 0)
            errx(EXIT_FAILURE, "EOF on userfaultfd");
        if (n == -1)
            err(EXIT_FAILURE, "read");
        if (n != (ssize_t) sizeof(msg))
            errx(EXIT_FAILURE, "short read from userfaultfd: %zd bytes", n);
        if (msg.event != UFFD_EVENT_PAGEFAULT)
            errx(EXIT_FAILURE, "unexpected event 0x%x", msg.event);

        /* The faulting address, rounded DOWN to a page boundary — UFFDIO_COPY
           operates on whole pages, never sub-page offsets. */
        unsigned long dst = (unsigned long) msg.arg.pagefault.address
                            & ~(page_size - 1);
        unsigned long idx = ((char *) dst - region) / page_size;

        /* Compose the page contents in userspace. This string is the proof
           that the bytes came from US, not from a kernel zero-fill. */
        memset(page, 0, page_size);
        snprintf(page, page_size,
                 "PAGE %lu was served by the handler (fault #%d) at %p\n",
                 idx, fault_cnt, (void *) dst);
        fault_cnt++;

        /* Resolve the fault: atomically place our page at dst and wake the
           faulting thread. This is the one ioctl that ends the wait. */
        struct uffdio_copy copy = {
            .src  = (unsigned long) page,
            .dst  = dst,
            .len  = page_size,
            .mode = 0,
            .copy = 0,
        };
        if (ioctl(uffd, UFFDIO_COPY, &copy) == -1)
            err(EXIT_FAILURE, "ioctl-UFFDIO_COPY");

        printf("  [handler] fault on page %lu (%p) -> copied %lld bytes\n",
               idx, (void *) dst, (long long) copy.copy);
    }
    return NULL;   /* not reached */
}

int
main(int argc, char *argv[])
{
    struct uffdio_api      api = { .api = UFFD_API, .features = 0 };
    struct uffdio_register reg;
    pthread_t thr;

    num_pages = (argc > 1) ? strtoull(argv[1], NULL, 0) : 4;
    page_size = sysconf(_SC_PAGE_SIZE);

    /* 1. Create the userfaultfd. O_NONBLOCK + poll() so a read never hangs;
          UFFD_USER_MODE_ONLY so we can run without root (see the intro). */
    uffd = syscall(SYS_userfaultfd,
                   O_CLOEXEC | O_NONBLOCK | UFFD_USER_MODE_ONLY);
    if (uffd == -1)
        err(EXIT_FAILURE, "userfaultfd (try: sysctl vm.unprivileged_userfaultfd=1)");

    /* 2. API handshake: agree on the ABI version with the kernel. Nothing
          works before this succeeds. */
    if (ioctl(uffd, UFFDIO_API, &api) == -1)
        err(EXIT_FAILURE, "ioctl-UFFDIO_API");

    /* 3. A private anonymous mapping: demand-zero, no physical pages attached
          yet. Every first touch will fault. */
    size_t size = num_pages * page_size;
    region = mmap(NULL, size, PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (region == MAP_FAILED)
        err(EXIT_FAILURE, "mmap region");
    printf("region = %p .. %p  (%zu pages of %d bytes)\n",
           (void *) region, (void *) (region + size), num_pages, page_size);

    /* 4. Register the range, asking to be told about MISSING pages — the
          first-touch case. (Other modes: WP for write-protect, MINOR.) */
    reg.range.start = (unsigned long) region;
    reg.range.len   = size;
    reg.mode        = UFFDIO_REGISTER_MODE_MISSING;
    if (ioctl(uffd, UFFDIO_REGISTER, &reg) == -1)
        err(EXIT_FAILURE, "ioctl-UFFDIO_REGISTER");

    /* 5. Spawn the server. From here on, faults on `region` are its job. */
    if (pthread_create(&thr, NULL, fault_handler_thread, NULL) != 0)
        err(EXIT_FAILURE, "pthread_create");

    /* 6. Touch each page. The first read of each page traps into the kernel,
          becomes a message on the fd, and blocks HERE until the handler's
          UFFDIO_COPY lands and wakes us. */
    for (size_t i = 0; i < num_pages; i++) {
        char *p = region + i * page_size;
        printf("main: about to read page %zu at %p\n", i, (void *) p);
        printf("main: page %zu contains: %s", i, p);   /* <-- faults here */
    }

    printf("main: all %zu pages touched; done.\n", num_pages);
    exit(EXIT_SUCCESS);
}
```

Compile it — one line, link pthread:

```bash
gcc -Wall -O2 -o uffd_demo uffd_demo.c -lpthread
```

```text
(no output; clean compile)
```

Run it over four pages:

```bash
./uffd_demo 4
```

```text
region = 0x7f3c8a4b0000 .. 0x7f3c8a4b4000  (4 pages of 4096 bytes)
main: about to read page 0 at 0x7f3c8a4b0000
  [handler] fault on page 0 (0x7f3c8a4b0000) -> copied 4096 bytes
main: page 0 contains: PAGE 0 was served by the handler (fault #0) at 0x7f3c8a4b0000
main: about to read page 1 at 0x7f3c8a4b1000
  [handler] fault on page 1 (0x7f3c8a4b1000) -> copied 4096 bytes
main: page 1 contains: PAGE 1 was served by the handler (fault #1) at 0x7f3c8a4b1000
main: about to read page 2 at 0x7f3c8a4b2000
  [handler] fault on page 2 (0x7f3c8a4b2000) -> copied 4096 bytes
main: page 2 contains: PAGE 2 was served by the handler (fault #2) at 0x7f3c8a4b2000
main: about to read page 3 at 0x7f3c8a4b3000
  [handler] fault on page 3 (0x7f3c8a4b3000) -> copied 4096 bytes
main: page 3 contains: PAGE 3 was served by the handler (fault #3) at 0x7f3c8a4b3000
main: all 4 pages touched; done.
```

### What just happened

Look at the interleaving, because it *is* the mechanism:

1. `main` prints "about to read page 0", then evaluates `region[0]` to hand it
   to `printf`. That read touches an address inside a valid VMA whose page is
   not present yet — a **missing page**, not an unmapped address.
2. Normally the kernel would allocate a zero page and return. But this range is
   registered `MODE_MISSING`, so instead the kernel **parks the faulting
   thread** inside `handle_userfault()` and posts a `UFFD_EVENT_PAGEFAULT` on
   the fd.
3. The handler thread, blocked in `poll()`, wakes. It `read()`s the event,
   sees the faulting address, `memset`s a page with our string, and calls
   `ioctl(UFFDIO_COPY)`. That copy is atomic: the page becomes present *and*
   the parked thread is woken in one operation.
4. `main` resumes exactly where it stopped — the same `region[0]` read now
   returns the byte the handler wrote — and prints the served string.

The bytes in every page were composed by ordinary userspace code. The kernel
never chose their contents; it only delivered the *question* and applied your
*answer*. That inversion — the kernel asking userspace to resolve a fault — is
the whole of userfaultfd.

## Stage 2 — Watch the syscall dance with strace

Claims about "a fault becomes an fd read plus an ioctl" are cheap. Let's see
the actual system calls. `strace -f` follows the handler thread; we trace only
the calls that matter.

```bash
strace -f -e trace=userfaultfd,ioctl,poll,ppoll,read ./uffd_demo 2
```

Trimmed and annotated (your PIDs and addresses will differ):

```text
userfaultfd(O_CLOEXEC|O_NONBLOCK|UFFD_USER_MODE_ONLY) = 3          ← the fd is born
ioctl(3, UFFDIO_API, {api=UFFD_API, features=0} => {...}) = 0      ← handshake
ioctl(3, UFFDIO_REGISTER, {range={start=0x7f.., len=8192},
        mode=UFFDIO_REGISTER_MODE_MISSING} => {ioctls=...}) = 0    ← range handed over
strace: Process 5177 attached                                      ← the handler thread
[pid  5177] poll([{fd=3, events=POLLIN}], 1, -1) = 1 ([{fd=3, revents=POLLIN}])
[pid  5177] read(3, {event=UFFD_EVENT_PAGEFAULT, arg.pagefault={
              flags=0, address=0x7f..000}}, 32) = 32               ← the fault, as data
[pid  5177] ioctl(3, UFFDIO_COPY, {dst=0x7f..000, src=0x7f..,
              len=4096, mode=0} => {copy=4096}) = 0                ← the resolution
[pid  5177] poll([{fd=3, events=POLLIN}], 1, -1) = 1 ([{fd=3, revents=POLLIN}])
[pid  5177] read(3, {event=UFFD_EVENT_PAGEFAULT, arg.pagefault={
              flags=0, address=0x7f..1000}}, 32) = 32              ← page 1's fault
[pid  5177] ioctl(3, UFFDIO_COPY, {dst=0x7f..1000, ...} => {copy=4096}) = 0
+++ exited with 0 +++
```

Read it top to bottom and the story is unambiguous:

- **`userfaultfd(...) = 3`** — the object is a file descriptor, number 3. Note
  `strace` decodes the flags, including our `UFFD_USER_MODE_ONLY`.
- **The two `UFFDIO_*` ioctls before any fault** — API handshake, then
  register. `strace` even shows the returned `ioctls=` bitmask telling you
  which operations the kernel will accept on this range.
- **`poll(...)` or `ppoll(...)`** — the exact syscall used by the `poll()`
  wrapper depends on the libc and architecture, so the command traces both.
  The handler is asleep here until a fault arrives; `revents=POLLIN` is the
  wakeup.
- **`read(3, {event=UFFD_EVENT_PAGEFAULT, ... address=0x7f..000}, 32) = 32`** —
  *this line is the entire thesis.* The packed Linux UAPI `struct uffd_msg` is
  32 bytes: a page fault has become a fixed-size record read from a file
  descriptor. The kernel handed you the faulting address as ordinary data.
- **`ioctl(3, UFFDIO_COPY, {dst=..., copy=4096})`** — and the resolution is an
  ioctl back down the same fd. `copy=4096` is the kernel reporting how many
  bytes it installed.

Notice what is *absent*: there is no syscall in the *main* thread at the moment
of the fault. The fault is a CPU exception, not a syscall, so `strace` shows
nothing for the toucher — it simply blocks between two `printf`s. Remember that
silence; it comes back in Stage 4.

## Stage 3 — Measure it

How expensive is serving a fault from userspace, and how does it compare to a
page that is already present? This is an **illustration, not a benchmark**: one
fault is a noisy scheduling event, while one resident load is too short to time
meaningfully between two clock calls. We will therefore measure the clock-call
baseline, time each first touch, and average a large batch of repeated resident
loads.

Copy `uffd_demo.c` to `uffd_timing.c`, add `#include <time.h>` near the top,
and add this helper above `main`:

```c
static long
elapsed_ns(struct timespec start, struct timespec end)
{
    return (end.tv_sec - start.tv_sec) * 1000000000L
         + (end.tv_nsec - start.tv_nsec);
}
```

Then replace the touch loop in `main` (step 6) with:

```c
    const size_t repeats = 1000000;

    for (size_t i = 0; i < num_pages; i++) {
        volatile unsigned char *p =
            (volatile unsigned char *) region + i * page_size;
        struct timespec b0, b1, f0, f1, r0, r1;
        volatile unsigned long sink = 0;

        /* Baseline: the measurement floor of two adjacent clock reads. */
        clock_gettime(CLOCK_MONOTONIC, &b0);
        clock_gettime(CLOCK_MONOTONIC, &b1);

        /* One first touch: this is the userfaultfd path. */
        clock_gettime(CLOCK_MONOTONIC, &f0);
        sink += p[0];
        clock_gettime(CLOCK_MONOTONIC, &f1);

        /* The page is resident now. Repeat the load so clock overhead is not
           larger than the operation being observed. */
        clock_gettime(CLOCK_MONOTONIC, &r0);
        for (size_t j = 0; j < repeats; j++)
            sink += p[0];
        clock_gettime(CLOCK_MONOTONIC, &r1);

        long baseline = elapsed_ns(b0, b1);
        long served_raw = elapsed_ns(f0, f1);
        long batch_raw = elapsed_ns(r0, r1);
        long served = served_raw > baseline ? served_raw - baseline : 0;
        long batch = batch_raw > baseline ? batch_raw - baseline : 0;

        printf("page %zu: served ~= %6ld ns   clock-pair = %4ld ns   "
               "resident loop ~= %.2f ns/load\n",
               i, served, baseline, (double) batch / repeats);
        (void) sink;
    }
```

Build and run:

```bash
gcc -Wall -O2 -o uffd_timing uffd_timing.c -lpthread
./uffd_timing 16
```

One run might look roughly like this; your values can be materially different:

```text
region = 0x7f21c4d70000 .. 0x7f21c4d80000  (16 pages of 4096 bytes)
  [handler] fault on page 0 (0x7f21c4d70000) -> copied 4096 bytes
page 0: served ~=  21480 ns   clock-pair =   28 ns   resident loop ~= 2.61 ns/load
  [handler] fault on page 1 (0x7f21c4d71000) -> copied 4096 bytes
page 1: served ~=  10370 ns   clock-pair =   27 ns   resident loop ~= 2.57 ns/load
  [handler] fault on page 2 (0x7f21c4d72000) -> copied 4096 bytes
page 2: served ~=   9380 ns   clock-pair =   27 ns   resident loop ~= 2.60 ns/load
...
```

Interpret only the shape of the result:

- The served-fault samples are noisy because they include a kernel trap,
  parking and waking threads, scheduler latency, a `read`, page preparation,
  an `ioctl`, and the 4 KiB copy. The first sample is often especially cold.
- `clock-pair` shows why timing one ordinary load directly would be misleading:
  the measurement machinery can cost more than the load. The repeated-load
  number amortizes that floor, but it still includes loop and dependency
  overhead; it is **not** a claim about the CPU's exact cache-hit latency.
- After `UFFDIO_COPY`, the page is an ordinary resident page. The userfaultfd
  machinery is paid on the missing-page fault, not on every later access.

Run at least a few dozen pages, repeat the whole program several times, and
look at the distribution rather than quoting one sample or a universal ratio.

Now extrapolate to the real use case. In post-copy [live migration](#/live-migration),
the handler does not `memset` a local buffer — it sends the faulting address
over a socket to the *source* host and waits for the page to come back. The
observed fault then includes local handling, network RTT, queueing, and page
transfer; on a LAN the network component will often dominate, but there is no
portable fixed multiplier. That is precisely the tradeoff `criu restore
--lazy-pages` makes: the process resumes on the destination quickly, then pays
a first-touch penalty only for pages reached before the background copy. See
[CRIU restore](#/criu-restore) for how the lazy-pages daemon wires a
userfaultfd to a page-fault-over-TCP protocol, and
[Observability](#/observability) for measuring the resulting fault latency in
production.

## Stage 4 — Break it, on purpose

Three deliberate failures, each teaching one edge of the mechanism.

### 4a — Touch a page *outside* the registered range

`userfaultfd` only intercepts faults on ranges you registered. Prove it by
adding an *unregistered* mapping and touching that. Add this just before the
touch loop in a scratch copy of the program:

```c
    /* A second mapping we DO NOT register with the uffd. */
    char *unreg = mmap(NULL, page_size, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    printf("main: unregistered page %p first byte = %d (no handler involved)\n",
           (void *) unreg, unreg[0]);
```

```text
main: unregistered page 0x7f88b2e10000 first byte = 0 (no handler involved)
```

No `[handler]` line appears. The kernel served this fault the normal way — a
demand-zero page, first byte `0` — because the range was never handed to the
userfaultfd. **Registration is per-range and opt-in:** faults outside it follow
the ordinary [virtual-memory](#/memory) path and never become messages.

### 4b — Leave a registered fault without a working handler

This is the lesson worth the whole lab. Make a copy that **never spawns the
handler** — comment out the `pthread_create` line (step 5) — then rebuild. Run
it in the background so the shell gives you the exact PID in `$!`; do not use a
name search that might select your editor, compiler, or another copy:

```bash
gcc -Wall -O2 -o uffd_nohandler uffd_nohandler.c -lpthread
( trap - INT; exec ./uffd_nohandler 2 ) &
UFFD_PID=$!
printf 'uffd_nohandler PID=%s\n' "$UFFD_PID"
sleep 0.2
```

The small wrapper resets `SIGINT` to its default disposition before `exec`
(some shells otherwise start asynchronous commands with it ignored), while
`exec` ensures `$!` remains the PID of `uffd_nohandler` itself.

```text
region = 0x7f4a1b2c0000 .. 0x7f4a1b2c2000  (2 pages of 4096 bytes)
main: about to read page 0 at 0x7f4a1b2c0000
```

…and the toucher stops making progress: no "page 0 contains" appears. Inspect
the exact process you launched:

```bash
cat "/proc/$UFFD_PID/status" | grep State
sudo cat "/proc/$UFFD_PID/stack"
```

```text
State:  S (sleeping)
[<0>] handle_userfault+0x1d3/0x760
[<0>] do_anonymous_page+0x458/0x6b0
[<0>] handle_mm_fault+0x2a8/0x330
[<0>] do_user_addr_fault+0x1a4/0x640
[<0>] exc_page_fault+0x7e/0x180
[<0>] asm_exc_page_fault+0x26/0x30
```

The kernel call stack says it plainly: the thread is parked inside
`handle_userfault()`, called from the page-fault handler, waiting for a
`UFFDIO_COPY` that will never come because nobody is reading the fd. And recall
Stage 2 — a fault is not a syscall, so `strace -p "$UFFD_PID"` attached now prints
**nothing**: there is no syscall in flight to trace, just a thread frozen on a
memory access.

Keep three cases separate:

1. **The handler is absent or blocked, but some process still holds the uffd
   open.** The range remains registered and a missing-page fault can remain
   parked indefinitely. In this toy, the faulting process itself still owns
   `uffd`; a thread exiting would not close it because threads share the same fd
   table.
2. **The last reference to the userfaultfd is closed.** Kernel cleanup
   unregisters all ranges attached to that context and wakes pending waiters.
   Subsequent faults use the ordinary VMA rules again — for this private
   anonymous mapping, that means demand-zero. This prevents a leaked uffd from
   hanging a task forever, but it is not a valid migration recovery: zeroes are
   not a substitute for the application's missing bytes.
3. **The target receives a terminating signal.** `Ctrl-C` normally sends
   `SIGINT`, whose default action terminates this program even while the thread
   is parked. Because we launched it in the background, send the equivalent
   signal explicitly and reap that exact child:

```bash
kill -INT "$UFFD_PID"
wait "$UFFD_PID" 2>/dev/null || true
unset UFFD_PID
```

**This is what "post-copy failure loses the task" means in
[Live Migration](#/live-migration).** Once a process is running against
userfaultfd-backed memory, the *kernel is now depending on a userspace daemon*
to supply the correct bytes. A stalled daemon can leave faults parked while the
uffd remains open; losing the final uffd reference unregisters the ranges but
does not magically recover the missing application state. A migration
controller must therefore reconnect, retry from a surviving source, or fail
the restored task rather than treat ordinary zero-fill as successful recovery.
That fragility is the price of post-copy's low downtime, and it is why
production migration keeps the source alive until the destination confirms
every page has landed.

### 4c — What this lab does *not* do: non-cooperative mode

Our handshake used `features = 0`. A real CRIU restore does not. When the
migrated process `fork()`s, `mremap()`s, or `madvise(MADV_DONTNEED)`s a
region, the memory map changes *underneath* the fault handler, and a handler
that only knows about the original mmap would install pages at stale
addresses. The fix is **non-cooperative mode**: during the second `UFFDIO_API`
call you enable event features so the kernel tells you about those changes too:

- `UFFD_FEATURE_EVENT_FORK` — the child inherits a duplicated uffd context; you
  get a `UFFD_EVENT_FORK` and start serving the child too.
- `UFFD_FEATURE_EVENT_REMAP` — an `mremap()` becomes a `UFFD_EVENT_REMAP` so
  you can track the moved range.
- `UFFD_FEATURE_EVENT_REMOVE` / `UFFD_FEATURE_EVENT_UNMAP` — `MADV_DONTNEED`,
  `MADV_REMOVE`, and unmaps are reported so you stop trying to serve pages that
  no longer exist.

Enabling those is exactly the gap between this ~150-line toy and a real lazy
restore. The
[CRIU lab](#/lab-criu) and [CRIU restore](#/criu-restore) chapters pick the
story up from here; the primitive you just built is the foundation the rest of
it stands on.

## Cleanup

Nothing persistent was created — no cgroups, no kernel modules, no files beyond
the binaries you compiled. If the exact Stage 4b child is still alive in this
shell, terminate and reap it, then remove the binaries if you like:

```bash
if [ -n "${UFFD_PID:-}" ] && kill -0 "$UFFD_PID" 2>/dev/null; then
    kill -TERM "$UFFD_PID"
    wait "$UFFD_PID" 2>/dev/null || true
fi
unset UFFD_PID
rm -f uffd_demo uffd_timing uffd_nohandler *.o
```

## Follow the code (kernel v6.12)

The whole subsystem is one file:
[fs/userfaultfd.c](https://elixir.bootlin.com/linux/v6.12/source/fs/userfaultfd.c).
The path you exercised:

1. `userfaultfd(2)` lands in
   [userfaultfd()](https://elixir.bootlin.com/linux/v6.12/C/ident/userfaultfd),
   which allocates a `struct userfaultfd_ctx` and returns an fd backed by
   `userfaultfd_fops`. `UFFD_USER_MODE_ONLY` sets a flag on that context.
2. Your `UFFDIO_REGISTER` runs through
   [userfaultfd_register()](https://elixir.bootlin.com/linux/v6.12/C/ident/userfaultfd_register),
   which marks the VMAs in the range with `VM_UFFD_MISSING` and points their
   `vm_userfaultfd_ctx` at your context.
3. When the main thread faults, the generic fault handler
   ([handle_mm_fault()](https://elixir.bootlin.com/linux/v6.12/C/ident/handle_mm_fault))
   sees the `VM_UFFD_MISSING` flag and diverts into
   [handle_userfault()](https://elixir.bootlin.com/linux/v6.12/C/ident/handle_userfault),
   which enqueues the event and sleeps the task — the `handle_userfault` frame
   you saw in `/proc/PID/stack`.
4. Your `read()` is served by
   [userfaultfd_read()](https://elixir.bootlin.com/linux/v6.12/C/ident/userfaultfd_read),
   which dequeues one `uffd_msg`.
5. Your `UFFDIO_COPY` runs
   [mfill_atomic()](https://elixir.bootlin.com/linux/v6.12/C/ident/mfill_atomic)
   (formerly `mcopy_atomic`), which installs the page *and* wakes the sleeping
   faulting thread — the atomicity that makes the resume race-free.
6. Closing the final fd enters
   [userfaultfd_release()](https://elixir.bootlin.com/linux/v6.12/C/ident/userfaultfd_release),
   which marks the context released, removes its registrations from the VMAs,
   and wakes pending faults — the cleanup path distinguished in Stage 4b.

## Check your understanding

1. In Stage 1, the main thread reads `region[0]` and gets the string
   `"PAGE 0 was served by the handler..."`. Where did those bytes come from,
   and what would the read have returned on an ordinary anonymous mapping?

<details><summary>Show answer</summary>

The bytes came from the handler thread's `memset`/`snprintf` into its scratch
page, installed at the faulting address by `UFFDIO_COPY`. On an ordinary
anonymous mapping the kernel would have served a demand-zero page and the read
would have returned `0` — no message, no handler involvement. Registering the
range `MODE_MISSING` is what diverts the fault to userspace.

</details>

2. Under `strace`, the moment the main thread faults, the toucher shows no
   syscall at all — only the handler thread makes syscalls. Why?

<details><summary>Show answer</summary>

A page fault is a CPU exception, not a system call. The main thread simply
executes a memory access; the CPU traps into the kernel's fault handler
directly, without the thread issuing a syscall. `strace` traces syscalls, so it
sees nothing from the toucher — the thread just blocks between two `printf`s.
The handler, by contrast, does everything through real syscalls (`poll` or
`ppoll`, `read`, `ioctl`), which is why they appear.

</details>

3. Why does Stage 3 time a first-touch fault once but use many repetitions for
   the resident-page comparison, and what work appears only on first touch?

<details><summary>Show answer</summary>

A single resident load is shorter than, or comparable to, the clock calls used
to measure it, so a one-load result would mostly describe the timer. Repeating
the load amortizes that measurement floor, though the average still includes
loop and dependency overhead and is not an exact cache-latency measurement.
The first touch uniquely pays for the page-fault trap, parking and waking the
threads, scheduler delay, `read`, page preparation, `UFFDIO_COPY`, and the 4 KiB
copy. After that ioctl installs the page, later accesses use the ordinary
resident-page path.

</details>

4. Extrapolate the Stage 3 result to post-copy live migration. What replaces
   the local `memset`, and why is there no portable fixed multiplier for the
   resulting fault latency?

<details><summary>Show answer</summary>

In post-copy migration the handler sends the faulting address to the *source*
host over a socket and waits for the page to be sent back, so the local
`memset` is replaced by a request, network queueing, page transfer, and reply.
Latency therefore depends on local scheduling, RTT, congestion, page-server
load, batching/prefetch, and whether background copying delivered the page
first. The stable conclusion is qualitative: the network often dominates a
post-copy miss, and that penalty disappears for pages already resident.

</details>

5. In Stage 4b, with no handler running but the uffd still open, the toucher
   waits in `handle_userfault`. What changes when the final uffd reference is
   closed, and why is that cleanup not a successful migration recovery?

<details><summary>Show answer</summary>

The kernel parked the faulting thread inside `handle_userfault()` and is
waiting for a `UFFDIO_COPY` (or `UFFDIO_ZEROPAGE`) from the userspace handler
to supply the page. While any process still holds the uffd, registration
remains and a stalled handler can leave that wait unresolved. Closing the final
reference releases the context, unregisters its ranges, and wakes waiters so
ordinary VMA fault handling can resume. For this anonymous mapping that can
mean demand-zero — useful kernel cleanup, but corrupted state for a migrated
process whose missing page should contain real bytes from the source. The
migration controller must recover those bytes or fail the task.

</details>

6. Our program used `features = 0`. What class of program *must* enable
   non-cooperative events, and name two of those events and what triggers them.

<details><summary>Show answer</summary>

A fault handler that must stay correct while the target process *changes its
own memory map* — CRIU's lazy-restore daemon is the canonical case. Without
these events, a `fork()` or `mremap()` would move memory out from under the
handler. Examples: `UFFD_FEATURE_EVENT_FORK` (delivered on `fork()`, so the
child's inherited uffd context can be served) and `UFFD_FEATURE_EVENT_REMAP`
(delivered on `mremap()`, so the handler tracks the relocated range).
`UFFD_FEATURE_EVENT_REMOVE`/`_UNMAP` similarly report `MADV_DONTNEED` and
unmaps.

</details>

7. Why can this lab run without root, and what changes if you need to handle
   *kernel-mode* faults on the range?

<details><summary>Show answer</summary>

Because it passes `UFFD_USER_MODE_ONLY`, which restricts the uffd to userspace
faults — and any user is always permitted to create such an object, even with
`vm.unprivileged_userfaultfd = 0` (the modern default). Our faults are all
userspace reads, so this suffices. To also trap kernel-mode faults (e.g. a
syscall that touches the range with `copy_to_user`), you must drop
`UFFD_USER_MODE_ONLY` and run as root, or set
`vm.unprivileged_userfaultfd = 1`; otherwise a kernel-mode fault on the range
delivers `SIGBUS` instead of a uffd message.

</details>

## Sources & further reading

- [userfaultfd(2)](https://man7.org/linux/man-pages/man2/userfaultfd.2.html) — the syscall, its flags (`UFFD_USER_MODE_ONLY`, `O_NONBLOCK`), the API handshake, and the canonical example program this lab is modelled on.
- [ioctl_userfaultfd(2)](https://man7.org/linux/man-pages/man2/ioctl_userfaultfd.2.html) — the full set of operations: `UFFDIO_API`, `UFFDIO_REGISTER`, `UFFDIO_COPY`, `UFFDIO_ZEROPAGE`, `UFFDIO_CONTINUE`, `UFFDIO_WRITEPROTECT`, and their structs.
- [Userfaultfd — kernel admin guide](https://docs.kernel.org/admin-guide/mm/userfaultfd.html) — `MODE_MISSING` vs write-protect vs minor faults, the `vm.unprivileged_userfaultfd` sysctl, and the non-cooperative event features for following `fork`/`mremap`/`madvise`.
- [CRIU: lazy migration](https://criu.org/Lazy_migration) — how the lazy-pages daemon wires a userfaultfd to a page-fault-over-network protocol; the production version of this lab.
- [fs/userfaultfd.c in v6.12](https://elixir.bootlin.com/linux/v6.12/source/fs/userfaultfd.c) — `handle_userfault()`, `userfaultfd_read()`, and the registration path, all in one file.

---

**Next:** you now have the primitive; see it carrying real process state in the
[CRIU restore](#/criu-restore) chapter and the [CRIU lab](#/lab-criu), or push
the same "fault into userspace" idea onto accelerators in
[GPU Checkpointing](#/gpu-checkpoint).
