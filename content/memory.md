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

### How the hardware does it (x86-64)

The MMU walks page tables on every memory access:

```text
virtual address = 48 bits (256 TiB usable)

[ 9 bits: PGD ] [ 9 bits: PUD ] [ 9 bits: PMD ] [ 9 bits: PTE ] [ 12 bits: offset ]
   (level 4)       (level 3)       (level 2)       (level 1)      (4 KB page)

Huge pages shortcut the walk:
- 2 MB pages: skip the PTE level (PMD points directly to the 2 MB frame)
- 1 GB pages: skip PTE + PMD (PUD points directly to the 1 GB frame)
```

The **TLB** (Translation Lookaside Buffer) caches recent translations, making
the multi-level walk unnecessary for hot pages. Each core has its own L1 TLB
(~64 entries for data, ~64 for instructions) and a shared L2 TLB
(~1500 entries). A TLB miss costs ~10-100 cycles; the page walker fetches
the translation while the core continues speculatively.

This is why huge pages matter: mapping 1 GB with 2 MB pages uses 512 TLB
entries instead of 262,144.

### 5-level paging (kernel 4.14+)

x86-64 added a 5th level (P4D above PGD) for 57-bit virtual addresses
(128 PiB). Most systems still use 4-level. Check yours:

```bash
grep -E 'address sizes|page table' /proc/cpuinfo | head -2
```

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
7fff...                r-xp   [vdso]              ← kernel-injected fast syscalls
```

Key observations:

- The C library appears in *every* process's maps — but it's the **same
  physical pages**, mapped into everyone. Shared libraries are "shared" in the
  most literal sense.
- `malloc()` is **not a syscall** — it's a glibc allocator managing the heap,
  asking the kernel for big chunks via `brk`/`mmap` only when necessary.
  Small `malloc(16)` = heap sbrk; large `malloc(1 MiB)` = anonymous mmap.
- Each mapping has permissions (`r`,`w`,`x`). Jump into a non-executable page
  or write to a read-only one → CPU exception → `SIGSEGV`. Segfault =
  **the MMU catching you touching a page in a way the page tables forbid.**

```bash
cat /proc/self/maps | awk '{print $2}' | sort | uniq -c  # count permission combos
```

## Page faults: the engine, not the error

The kernel is *lazy*. When you `mmap()` a file or `malloc()` 1 GB, it doesn't
allocate physical memory — it just records the promise in the VMA list
("this range is valid, file-backed at offset X" or "anonymous zero-fill").
Physical pages appear on demand:

1. You touch an address with no physical page behind it.
2. The MMU faults into the kernel (**page fault**).
3. The kernel checks: is this address part of a promise (a VMA)?
   - **Yes** → allocate/fetch a page, fix the page table, resume the process.
     It never notices. This is a *normal* event — millions per minute.
   - **No** → `SIGSEGV`.

Two flavours:

- **minor fault** — fixed without disk I/O (fresh zero page, or the page was
  already in RAM, e.g. a shared library someone else loaded, or a COW page
  that needed copying).
- **major fault** — required reading from disk (first touch of a file page,
  or swapped-out memory coming back). These are the slow ones.

```bash
ps -o min_flt,maj_flt,comm -p $$       # your shell's fault counts
/usr/bin/time -v ls 2>&1 | grep -i fault
grep pgfault /proc/vmstat              # system-wide since boot
```

This laziness has a famous consequence, **overcommit**: Linux happily promises
more memory than physically exists (`malloc` virtually never fails), betting
that most promises aren't fully used. Mostly the bet pays. When it doesn't…
see "OOM killer" below.

The `vm.overcommit_memory` sysctl controls this:
- `0` (default): heuristic overcommit — guess if there's enough memory.
- `1`: always overcommit (for workloads that know what they're doing).
- `2`: never overcommit — `malloc` fails when out of *committable* memory
  (RAM + swap × overcommit_ratio). Used on very conservative systems.

```bash
cat /proc/sys/vm/overcommit_memory
cat /proc/sys/vm/overcommit_ratio
```

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
- `mmap` of a file = the same page cache, just mapped into user space. No
  second copy. `read()`/`write()` use the same pages as `mmap`.

```bash
grep -E 'Dirty|Writeback|Cached|Buffers' /proc/meminfo
free -h -w         # more detail on buff/cache split
```

### The writeback process

The kernel has background threads (`[kworker]`, `[writeback]`) that flush
dirty pages to disk. The parameters that control urgency:

```bash
cat /proc/sys/vm/dirty_ratio          # % of RAM as dirty before synchronous writeback blocks
cat /proc/sys/vm/dirty_background_ratio  # % of RAM where background flush starts
cat /proc/sys/vm/dirty_expire_centisecs  # pages older than this get written
```

A server with heavy writes and `dirty_ratio` too high will see latency spikes
when the synchronous flush kicks in — gigabytes of dirty pages hitting disk
at once.

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

The `swappiness` parameter (0–200, default 60) controls the *relative
balance* between reclaiming file-backed pages vs swapping anonymous pages.
Lower = prefer file cache eviction, higher = prefer swap.

```bash
swapon --show; vmstat 1 5     # si/so columns = swap in/out per second
cat /proc/sys/vm/swappiness
```

## Physical memory: zones, NUMA, and allocators

Virtual memory is the interface processes see; physical memory is the machine
the kernel must actually manage. RAM is divided into **page frames**, and each
frame has a `struct page` describing its state.

Physical pages are grouped by constraints:

```text
node 0                         node 1              ← NUMA locality
├── DMA / DMA32 zones           ├── DMA / DMA32
├── Normal zone                 ├── Normal
└── Movable / device zones      └── Movable / device
```

The **buddy allocator** manages free physical pages in power-of-two blocks
(orders 0–10: 4 KB to 4 MB). It is excellent for page-sized and multi-page
allocations, but kernel objects are usually smaller: dentries, inodes,
sockets, `task_struct`, VMAs. Those come from **SLUB**, the slab allocator
used by modern Linux, which keeps caches of pre-initialized objects.

You can see this world directly:

```bash
cat /proc/buddyinfo             # fragmentation by zone/order
cat /proc/pagetypeinfo          # movable/unmovable/reclaimable split
sudo slabtop                    # kernel object caches
numactl --hardware              # NUMA nodes and distances
cat /proc/slabinfo | head       # slab caches (deprecated, slabtop is better)
```

This is where some "mysterious" memory usage lives. Kernel memory is not
process RSS, but it is real RAM. Millions of sockets, dentries, inodes,
iptables/nftables state, or BPF maps can consume memory outside the simple
"application heap" story. Look at `Slab:` and `SReclaimable:` in
`/proc/meminfo` for the kernel's own consumption.

## Transparent Huge Pages

The page size you meet first is 4 KB. The CPU translates virtual addresses
through the TLB, and TLB reach matters. **Transparent Huge Pages** try to
promote suitable anonymous memory regions into huge pages automatically:

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
grep -E 'AnonHugePages|FilePmdMapped|ShmemPmdMapped' /proc/meminfo
```

Huge pages can improve throughput by reducing TLB misses. They can also hurt
latency when the kernel spends time compacting memory (to create contiguous
2 MB regions) or when COW splits huge pages. Databases, JVMs, and
latency-sensitive services often disable THP (`never`) and use explicit huge
pages instead (`HugePages_Total` in `/proc/meminfo`). The production rule:
measure TLB misses and compaction stalls for your workload, don't guess.

```bash
perf stat -e dTLB-load-misses,dTLB-store-misses -p <pid> -- sleep 30
```

## KSM: deduplicating identical pages

**Kernel Same-page Merging** scans anonymous memory for identical pages and
merges them into a single COW page. Two VMs running the same OS, two
containers from the same image, or even two copies of the same process can
share pages. KSM is the hypervisor's secret (QEMU/KVM enables it by default
for VM memory):

```bash
cat /sys/kernel/mm/ksm/pages_shared    # pages deduplicated
cat /sys/kernel/mm/ksm/pages_sharing   # pages saved (× page_size = real savings)
```

## The OOM killer

If reclaim fails — every page squeezed and still not enough — the kernel must
choose: panic, or kill something. It kills something: the **Out-Of-Memory
killer** picks the process with the highest "badness" score (mostly: memory
used, adjustable via `/proc/<pid>/oom_score_adj`) and SIGKILLs it.

```bash
sudo dmesg | grep -i "out of memory"     # the OOM killer's confession log
cat /proc/<pid>/oom_score                # badness score (higher = more likely to die)
echo -1000 > /proc/<pid>/oom_score_adj   # make this process OOM-immune (e.g. SSH)
```

> **Container link:** memory limits via cgroup (`docker run -m 512m`) create a
> *per-group* OOM: exceed the limit and the OOM killer fires *inside the
> cgroup*, killing your container's biggest process even though the host has
> plenty of free RAM. Exit code 137 = 128 + SIGKILL(9) — the telltale
> signature of an OOM-killed container.

## Measuring memory honestly

"How much memory does my process use?" is genuinely ambiguous:

| Metric | Meaning | Catch |
|---|---|---|
| **VSZ** (virtual) | All promises | Mostly meaningless — includes untouched mappings |
| **RSS** (resident) | Physical pages currently mapped | Double-counts shared pages across processes |
| **PSS** (proportional) | RSS with shared pages split among users | The honest one — see `/proc/<pid>/smaps_rollup` |
| **USS** (unique) | Pages not shared with anyone | What freeing this process would actually reclaim |

```bash
ps -o vsz,rss,comm -p $$
grep -E 'Pss|Rss|Swap' /proc/$$/smaps_rollup
# PSS: 45821 kB  ← honest per-process memory
```

## Try it yourself

```bash
cat /proc/self/maps                     # an address space, live
free -h && cat /proc/meminfo | head -5
# watch the page cache work:
time grep -r "main" /usr/include > /dev/null     # cold
time grep -r "main" /usr/include > /dev/null     # hot — compare!
grep -E 'pgfault|pgmajfault' /proc/vmstat  # fault counters system-wide
sudo slabtop -o                          # kernel memory consumers, sorted
```

## Check your understanding

1. Why is a page fault usually *not* an error?
2. A machine shows 200 MB "free" — is it out of memory? What number tells you?
3. Your container died with exit code 137 while the host had 20 GB free. What
   happened?
4. Why does `ps` show a process using 8 GB VSZ but only 50 MB RSS?
5. How does THP help a database workload, and when does it hurt?

*(Answers: demand paging — the kernel lazily allocates physical pages only
when memory is actually touched, so most faults are "fixable page table
update" not "invalid access"; no — check `available` in free -h, which
accounts for reclaimable page cache; the container had a cgroup memory.max
limit (e.g. 512m) and its own local OOM killer fired, exit code 137 = 128+9;
VSZ counts all mmap'd/brk'd virtual regions including untouched ones — the
process allocated 8 GB worth of address space but only dirtied 50 MB of
physical pages; THP reduces TLB misses (good for large working sets) but the
compaction kernel threads and COW splitting add latency — measure don't
presume.)*

---

**Next:** how a pile of disk blocks becomes `/home/you/notes.txt` — the VFS
and filesystems.
