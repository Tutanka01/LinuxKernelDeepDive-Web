# Virtual Memory

> **Goal:** understand the illusion every process lives in — a private address
> space — and the machinery behind it: pages, page tables, page faults, the
> page cache, swap, and the OOM killer. This chapter explains more everyday
> mysteries ("where did my RAM go?") than any other.

## The illusion

Every process believes it has a private, contiguous memory range starting at
(almost) zero, gigabytes wide, all to itself. All of them believe this
*simultaneously*. None of it is physically true.

The trick: processes only ever use **virtual addresses**. On every single
memory access, the CPU's **MMU** (Memory Management Unit) translates virtual →
physical using **page tables** that the kernel maintains per process.

```text
Process A: virtual 0x4000 ──┐
                            ├─► page tables ─► physical RAM
Process B: virtual 0x4000 ──┘        (different pages!)
```

Two processes can use the *same* virtual address for *different* physical
memory — or for the *same* physical page (that's shared memory and COW).
Translation happens in hardware, cached by the **TLB**, at full speed.

Memory is managed in **pages** of 4 KB. Everything below — mapping, faulting,
swapping, caching — moves in units of pages.

## The address space layout

```bash
cat /proc/self/maps | head -20
```

```text
address range          perms  what
55d0e2a00000-...       r-xp   /usr/bin/cat        ← code (text), read-only+exec
55d0e2c1f000-...       rw-p   /usr/bin/cat        ← globals (data)
55d0e4521000-...       rw-p   [heap]              ← malloc() arena, grows up
7f6f12000000-...       r-xp   /lib/.../libc.so.6  ← shared libraries
7ffd9c8e0000-...       rw-p   [stack]             ← grows down
```

Key observations:

- The C library appears in *every* process's maps — but it's the **same
  physical pages**, mapped into everyone. Shared libraries are "shared" in the
  most literal sense.
- `malloc()` is **not a syscall** — it's a glibc allocator managing the heap,
  asking the kernel for big chunks via `brk`/`mmap` only occasionally.
- Each mapping has permissions (`r`,`w`,`x`). Jump into a non-executable page
  or write to a read-only one → CPU exception → `SIGSEGV`. That's a segfault:
  **the MMU catching you touching a page in a way the page tables forbid.**

## Page faults: the engine, not the error

The kernel is *lazy*. When you `mmap()` a file or `malloc()` 1 GB, it doesn't
allocate physical memory — it just records the promise in the VMA list
("this range is valid"). Physical pages appear on demand:

1. You touch an address with no physical page behind it.
2. The MMU faults into the kernel (**page fault**).
3. The kernel checks: is this address part of a promise?
   - **Yes** → allocate/fetch a page, fix the page table, resume the process.
     It never notices. This is a *normal* event — millions per minute.
   - **No** → `SIGSEGV`.

Two flavours:

- **minor fault** — fixed without disk I/O (fresh zero page, or the page was
  already in RAM, e.g. a shared library someone else loaded).
- **major fault** — required reading from disk (first touch of a file page,
  or swapped-out memory coming back). These are the slow ones.

```bash
ps -o min_flt,maj_flt,comm -p $$       # your shell's fault counts
/usr/bin/time -v ls 2>&1 | grep -i fault
```

This laziness has a famous consequence, **overcommit**: Linux happily promises
more memory than physically exists (`malloc` virtually never fails), betting
that most promises aren't fully used. Mostly the bet pays. When it doesn't…
see "OOM killer" below.

## The page cache: where your RAM "goes"

Run `free -h` and behold the most misunderstood line in Linux:

```text
              total        used        free      buff/cache   available
Mem:           31Gi        8Gi        1.2Gi        22Gi        21Gi
```

Only 1.2 GB free?! Relax — 22 GB is the **page cache**: every file read or
written is kept cached in RAM, because RAM is ~1000× faster than disk and
free RAM is wasted RAM. The cache is evicted *instantly* whenever a process
needs memory. **`available` is the truthful number.**

The page cache explains everyday magic:

- Second `grep` through a big tree is instant — pages already cached.
- `write()` returns immediately: it wrote to cache (the page is now *dirty*);
  the kernel flushes dirty pages to disk in the background seconds later.
  That's why yanking power can lose data, and what `sync`/`fsync` are *for*
  (databases call `fsync` precisely to force durability).

```bash
grep -E 'Dirty|Writeback' /proc/meminfo    # data waiting to hit disk
```

## Swap and reclaim

When memory gets tight, the kernel **reclaims** pages, cheapest first:

1. clean page-cache pages — droppable instantly (re-readable from disk);
2. dirty page-cache pages — flush, then drop;
3. **anonymous** memory (heaps, stacks) — has no file behind it, so the only
   way to reclaim it is to write it to **swap**.

Swap isn't "emergency overflow that means you need more RAM" — modest swap
lets the kernel evict the gigabytes of *never-touched* allocations every
system carries, freeing real RAM for the page cache. Heavy, *sustained*
swapping (thrashing) is the pathology, not swap usage per se.

```bash
swapon --show; vmstat 1 5     # si/so columns = swap in/out per second
```

## The OOM killer

If reclaim fails — every page squeezed and still not enough — the kernel must
choose: panic, or kill something. It kills something: the **Out-Of-Memory
killer** picks the process with the highest "badness" score (mostly: memory
used, adjustable via `/proc/<pid>/oom_score_adj`) and SIGKILLs it.

```bash
sudo dmesg | grep -i "out of memory"     # the OOM killer's confession log
```

> **Container link:** memory limits via cgroup (`docker run -m 512m`) create a
> *per-group* OOM: exceed the limit and the OOM killer fires *inside the
> cgroup*, killing your container's biggest process even though the host has
> plenty of free RAM. Exit code 137 = 128 + SIGKILL(9) — the telltale
> signature of an OOM-killed (or docker-killed) container.

## Measuring memory honestly

"How much memory does my process use?" is genuinely ambiguous:

| Metric | Meaning | Catch |
|---|---|---|
| **VSZ** (virtual) | All promises | Mostly meaningless — includes untouched mappings |
| **RSS** (resident) | Physical pages currently mapped | Double-counts shared pages across processes |
| **PSS** (proportional) | RSS with shared pages split among users | The honest one — see `/proc/<pid>/smaps_rollup` |

```bash
ps -o vsz,rss,comm -p $$
grep Pss: /proc/$$/smaps_rollup
```

## Try it yourself

```bash
cat /proc/self/maps                     # an address space, live
free -h && cat /proc/meminfo | head -5
# watch the page cache work:
time grep -r "main" /usr/include > /dev/null     # cold
time grep -r "main" /usr/include > /dev/null     # hot — compare!
```

## Check your understanding

1. Why is a page fault usually *not* an error?
2. A machine shows 200 MB "free" — is it out of memory? What number tells you?
3. Your container died with exit code 137 while the host had 20 GB free. What
   happened?

---

**Next:** how a pile of disk blocks becomes `/home/you/notes.txt` — the VFS
and filesystems.
