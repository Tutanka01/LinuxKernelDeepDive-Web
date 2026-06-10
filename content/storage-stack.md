# The Linux Storage Stack

> **Goal:** follow an I/O request from `write()` to spinning rust (or flash), understanding every layer in between: the page cache, the bio, the block layer with blk-mq, the I/O scheduler, and the device mapper — and learn why each exists, how to inspect them, and how they shape real-world performance.

## Why a stack?

Applications call `write()`. The kernel needs to turn that into commands the disk controller understands. Between the two sits a pile of abstractions that exist for hard-learned reasons:

```
write() / read()
     ▼
  page cache         ← absorb, delay, coalesce, deduplicate
     ▼
  filesystem (ext4/xfs/btrfs)  ← map file offset → block number
     ▼
  bio layer          ← compose I/O requests as (device, sector, len, pages)
     ▼
  block layer / blk-mq   ← queue, merge, schedule, dispatch
     ▼
  I/O scheduler      ← reorder for rotational/throughput
     ▼
  device driver      ← talk to the hardware
     ▼
  disk / SSD
```

Every layer exists because someone ran a workload, measured, and found a bottleneck. Understanding the stack means understanding *why* each layer is there.

## The page cache: where writes begin

Every `write()` lands in the **page cache** first — a set of 4 KB pages in RAM, indexed by `(inode, offset)`. The write returns to user space the instant the data hits the page cache (that's "buffered I/O"). The kernel writes the data to disk later, asynchronously.

```bash
# How much RAM is page cache right now?
grep -E '^(Cached|Dirty|Writeback):' /proc/meminfo
# Cached:    16234568 kB   ← total page cache
# Dirty:         4872 kB   ← pages modified but not yet on disk
# Writeback:        0 kB   ← pages currently being written to disk
```

Dirty pages are flushed to disk by **kernel writeback threads** (`[kworker/uNN:X-flush-...]`) when:
- The page is older than `/proc/sys/vm/dirty_expire_centisecs` (default 30s)
- The system exceeds `dirty_ratio` (default 20% of RAM) or `dirty_background_ratio` (10%)
- `sync()`, `fsync()`, or `fdatasync()` is called
- The kernel needs the page frame for something else (reclaim)

The writeback controller (cgroup v2 `memory.max`) lets you throttle dirty pages per cgroup, preventing one container from starving another's I/O:

```bash
cat /sys/fs/cgroup/system.slice/docker-abc123/memory.dirty_limit
```

This is the fundamental difference from `O_DIRECT` (`open(..., O_DIRECT)`): direct I/O bypasses the page cache entirely. The kernel DMAs data straight between user-space buffers and the device. Databases use this to manage their own caching; fileservers use buffered I/O to exploit the kernel's page cache. Neither is universally better.

```bash
# See page cache in flight
vmstat 1        # watch bi/bo (block in/out), si/so (swap in/out)
cat /proc/vmstat | grep -E 'pgpgout|pgpgin|pgsteal|pgscan'
```

## The bio: the kernel's I/O request

The filesystem translates a file offset to a **block number** on the device, then creates a `struct bio` — the fundamental unit of I/O in Linux since 2.4.

```c
// simplified mental model — real struct bio defined in include/linux/blk_types.h
struct bio {
    struct block_device  *bi_bdev;     // which device
    sector_t              bi_sector;   // starting sector (512B units)
    struct bio_vec       *bi_io_vec;   // list of physical pages + offsets
    unsigned short        bi_vcnt;     // how many vecs
    unsigned int          bi_size;     // total bytes
    // ... flags, completion callback, error, etc.
};
```

A bio is a "do this I/O on these pages" command. Multiple bios can be merged if they target adjacent sectors — the block layer does this aggressively. The kernel can also **split** a large bio into smaller ones if the hardware's maximum transfer size is limited.

```bash
# Watch bio activity
cat /sys/block/sda/stat        # fields: reads, read_merges, read_sectors, ...
# merge counts tell you how much the block layer is helping
```

A critical optimization: **plug lists**. When the kernel starts a batch of I/O, it holds bios in a temporary "plug" on the current task. When the plug is unplugged, all bios are submitted at once, giving the scheduler a chance to merge adjacent requests and sort. This reduces seeks on rotational disks dramatically.

## blk-mq: the multi-queue block layer

Since Linux 3.13 (2014), the block layer uses **blk-mq** — a multi-queue architecture designed for modern SSDs and NVMe drives that can handle millions of IOPS. The old single-request-queue model became the bottleneck.

```
    CPU 0        CPU 1        CPU 2        CPU 3
      │            │            │            │
  software      software     software     software
  staging       staging      staging      staging
  queue         queue        queue        queue
      │            │            │            │
      └────────────┼────────────┼────────────┘
                   │
          hardware dispatch queue(s)
                   │
              ┌────┴────┐
           NVMe SQ0  NVMe SQ1
```

Each CPU gets its own **software staging queue** — bios are submitted lock-free on the local CPU. From there, they flow to one or more **hardware dispatch queues** that directly map to NVMe submission queues or SCSI tags.

```bash
# See the queue topology
ls /sys/block/nvme0n1/mq/
# 0/  1/  2/  ...  ← one directory per hardware queue

cat /sys/block/nvme0n1/mq/0/cpu_list    # which CPUs feed queue 0
cat /sys/block/nvme0n1/mq/0/nr_tags     # max in-flight commands
cat /sys/block/nvme0n1/mq/0/nr_reserved_tags  # reserved for high-priority
```

NVMe supports up to 65535 I/O queues, each with up to 65536 entries. Linux typically creates one queue per CPU, which is why NVMe throughput scales almost linearly with core count.

## The I/O scheduler

Between the software queues and the hardware dispatch queues sits the I/O scheduler. On rotational disks, this matters enormously. On SSDs, it's mostly about fairness and latency guarantees.

Current schedulers (read from `/sys/block/sda/queue/scheduler`):

```
[mq-deadline] kyber bfq none
```

| Scheduler | Best for | What it does |
|---|---|---|
| **mq-deadline** | General default (since 5.0) | Orders by sector (minimize seeks), enforces per-request deadline (~500ms read, ~5000ms write). Simple and fast. |
| **kyber** | Low-latency SSDs | Token-bucket per sync/async. Limits queue depth to keep latency low. Adapts target latency based on observed completion times. |
| **bfq** | Desktop interactivity, rotational | Proportional-share budget per cgroup/process. Prevents one heavy writer from starving interactive reads. Higher CPU overhead. |
| **none** | NVMe, virtual block devices | No reordering at all. Bypasses the scheduler — bios go straight to the device. This is the right choice when hardware handles queueing. |

```bash
# What scheduler does each device use?
for d in /sys/block/{sd,nvme,vd}*/queue/scheduler; do
    echo "$d: $(cat $d)"
done

# NVMe devices usually show [none] — that's correct.
```

### Understanding mq-deadline in depth

Deadline maintains two sorted trees per hardware queue: one ordered by sector (for merging/seek optimization), one ordered by expiration time (for fairness). Each request gets a deadline:
- Reads: 500ms (configurable via `read_expire`)
- Writes: 5000ms (configurable via `write_expire`)

If the oldest request's deadline is approaching, deadline dispatches from the expiration tree, guaranteeing bounded latency. Otherwise, it dispatches in sector order, maximizing throughput.

```bash
cat /sys/block/sda/queue/iosched/read_expire
cat /sys/block/sda/queue/iosched/write_expire
cat /sys/block/sda/queue/iosched/writes_starved   # how many read batches between write batches
```

### Kyber: what "adaptive" means

Kyber tracks completion latencies and adjusts queue depth targets. If read latency exceeds `read_lat_nsec`, it reduces the number of in-flight reads. Values are self-tuning — no knobs needed for most workloads:

```bash
cat /sys/block/nvme0n1/queue/iosched/read_lat_nsec   # target read latency in ns
cat /sys/block/nvme0n1/queue/iosched/write_lat_nsec
```

## The device mapper (DM): stacking block devices

On top of the block layer sits the **device mapper** (`drivers/md/dm.c`), a framework that creates virtual block devices by stacking transformation layers. Every DM device appears as `/dev/dm-N` and `/dev/mapper/<name>`.

Core DM targets:

| Target | What it does |
|---|---|
| **linear** | Map a range of sectors to another device, possibly at an offset |
| **striped** | Distribute sectors across multiple devices (RAID-0 equivalent) |
| **mirror** | RAID-1: replicate writes to multiple devices |
| **snapshot** | Copy-on-write snapshot of another device |
| **thin-pool** | Allocate blocks on demand from a shared pool; supports snapshots |
| **crypt** | dm-crypt: transparent block-level encryption |
| **cache** | Fast device (SSD) caches slow device (HDD); writeback or writethrough |
| **integrity** | Attach checksums to each block; detect silent data corruption |
| **verity** | Read-only device with per-block Merkle tree verification |
| **multipath** | Aggregate multiple paths to the same storage (SAN) with failover |
| **raid** | Kernel RAID levels 0/1/4/5/6/10 via DM (alternative to md-raid) |

LVM2 is the user-space manager that orchestrates these targets. When you create an LVM logical volume, LVM2 constructs the appropriate DM table and loads it into the kernel:

```bash
dmsetup table          # show all active DM devices and their target tables
dmsetup info           # metadata: open count, event number
dmsetup ls             # device names
dmsetup status         # health: sync progress for mirrors, pool usage for thin
```

### dm-crypt in action

```bash
# The kernel sees the stack:
#   ext4 on /dev/mapper/cryptroot on /dev/dm-0 on /dev/sda3
dmsetup table cryptroot
# 0 976770064 crypt aes-xts-plain64 <key> 0 8:3 4096
# └── start-end, target-type, cipher, key, iv-offset, major:minor, sector-offset
```

Every block written to `/dev/sda3` is encrypted; every block read is decrypted transparently. The kernel's crypto API does the heavy lifting, potentially offloading to AES-NI CPU instructions.

### Thin provisioning: the container link

DM thin-pool is the technology behind Docker's `devicemapper` storage driver (deprecated in favor of overlayfs2) and is extensively used in cloud block storage:

```bash
dmsetup status pool0
# 0 209715200 thin-pool 253:5 253:6 128 32768 12345 67890
#                         data  meta block-size max-threads used-meta used-data
```

A thin-pool allocates blocks on first write, and you can create hundreds of thin volumes from one pool. Snapshots are metadata-only: they share physical blocks with the origin until one diverges. This is how cloud providers give you "instant" volume snapshots — no data copy occurs at snapshot time.

## md-raid: the older sibling

Before DM-raid, Linux had (and still has) the MD (multiple device) subsystem (`drivers/md/md.c`). Both coexist: DM-raid is newer and shares more code with LVM, while md-raid is more mature for some RAID levels.

```bash
cat /proc/mdstat                          # active arrays, status, rebuild progress
mdadm --detail /dev/md0                   # full configuration
echo check > /sys/block/md0/md/sync_action # trigger a consistency check
cat /sys/block/md0/md/sync_completed       # progress of rebuild/check
```

The critical concept in any RAID system: the **write hole**. If power fails mid-stripe-write on RAID-5/6, some disks have new data, some have old, and parity is inconsistent. Solutions:
- Battery-backed write cache (hardware RAID controllers)
- Journal on a separate device (md-raid journal)
- Partial parity log (PPL) — logs parity deltas to each disk's metadata area
- ZFS/btrfs copy-on-write (avoid the hole entirely)

```bash
# Check md raid configuration
mdadm --detail /dev/md0 | grep -E 'Level|State|Journal|PPL'
```

## The NVMe revolution

NVMe (Non-Volatile Memory Express) is a protocol designed from scratch for flash. Unlike SATA's single command queue of 32 entries, NVMe exposes up to 65535 queues, each with 65536 entries — and commands complete out of order.

The NVMe driver (`drivers/nvme/host/pci.c`) creates one submission queue per CPU. Each CPU submits commands to its own queue; completions come back on the same queue via MSI-X interrupts. This is lock-free and scales linearly.

```bash
# NVMe anatomy
nvme list                          # all NVMe controllers
nvme id-ctrl /dev/nvme0           # controller capabilities
nvme list-ns /dev/nvme0           # namespaces
nvme id-ns /dev/nvme0 -n 1        # namespace details (LBA format, capacity)
nvme show-regs /dev/nvme0         # PCIe BAR registers

# Queue count
cat /sys/block/nvme0n1/mq/*/cpu_list | wc -l   # hardware queues
cat /sys/block/nvme0n1/queue/nr_requests         # max requests per queue
```

NVMe also supports:
- **Multiple namespaces**: one physical device, divided into independently manageable logical units (like partitions but at the controller level)
- **Multipath I/O**: access one namespace through multiple controllers for redundancy
- **Scatter-gather lists** and **PRP/SGL**: non-contiguous buffers without bounce buffers
- **End-to-end data protection**: T10 DIF/DIX checksums handled at the NVMe level

## I/O cgroups: who gets the disk?

The blkio cgroup controller (cgroup v1) or the unified I/O controller (cgroup v2) limits and prioritizes block I/O:

```bash
# cgroup v2 interface
cat /sys/fs/cgroup/system.slice/io.max
# 8:0 rbps=104857600 wbps=104857600 riops=max wiops=10000
#  │   └──── read bytes/sec ────┘  └──── write bytes/sec ────┘
# major:minor of block device

# Apply a limit
echo "8:0 wbps=52428800" > /sys/fs/cgroup/system.slice/myapp/io.max

# See actual usage
cat /sys/fs/cgroup/system.slice/io.stat
# 8:0 rbytes=12345678 wbytes=987654 rios=1000 wios=500 ...
```

Unlike CPU scheduling, I/O throttling can be brutal: a process gets its IOPS cap and the kernel simply stops dispatching its bios. No "shares", no gradual ramp — a hard ceiling. Make sure your application can handle `EAGAIN` or hangs before deploying limits.

```bash
# Watch I/O pressure (PSI)
cat /proc/pressure/io
# some avg10=3.45 avg60=1.23 avg300=0.56 total=123456789
# full avg10=7.89 avg60=3.45 avg300=1.23 total=987654321
```

## Try it yourself

```bash
# Trace a single I/O through the stack
echo 1 > /sys/kernel/debug/tracing/events/block/block_bio_queue/enable
echo 1 > /sys/kernel/debug/tracing/events/block/block_bio_complete/enable
cat /sys/kernel/debug/tracing/trace_pipe | head -20

# Stack your own block device (ramdisk → crypt → fs)
modprobe brd rd_nr=1 rd_size=1048576              # 1G RAM disk
cryptsetup luksFormat /dev/ram0                    # encrypt it
cryptsetup open /dev/ram0 crypt-rd
mkfs.ext4 /dev/mapper/crypt-rd
mount /dev/mapper/crypt-rd /mnt/test
echo "hello through the layers" > /mnt/test/msg
cat /mnt/test/msg

# See the full stack
lsblk /dev/ram0                    # shows tree: ram0 → crypt-rd → mount point
dmsetup table crypt-rd             # shows crypt target parameters

# Measure the overhead
dd if=/dev/zero of=/mnt/test/big bs=1M count=1000 oflag=direct  # direct I/O
dd if=/dev/zero of=/mnt/test/big bs=1M count=1000               # buffered
```

## Check your understanding

1. Why does `dd if=/dev/zero of=test bs=1M count=1000` report blazing speed even on a slow disk?
2. An NVMe SSD has 4 hardware queues but the server has 64 CPUs. What happens to the extra 60 CPUs' I/O?
3. Why does the deadline scheduler prioritize reads over writes?
4. A thin-pool runs out of data space. What happens to mounted thin volumes using that pool?
5. You set an IOPS limit of 100 on a container. The application inside starts hanging on `write()`. Why?

*(Answers: the data stays in the page cache — the `dd` completes when the last byte is buffered, not when it reaches disk; the extra CPUs share those 4 hardware queues via the per-CPU software staging queues — blk-mq maps multiple software queues to each hardware queue, the contention is at dispatch time, not submission time; read latency directly impacts application responsiveness — a user clicking "open file" waits for the read, a write can complete in the background thanks to the page cache; all thin volumes using that pool go read-only — writes fail with -ENOSPC, and if the pool metadata also fills, the entire pool becomes inaccessible, which is why monitoring `dmsetup status` pool usage is critical; `write()` blocks by default (buffered I/O) — the process sleeps in the kernel until the I/O scheduler dispatches its bio, and with a hard IOPS cap the scheduler may delay dispatch indefinitely if other groups are also generating I/O, causing apparent hangs.)*

---

**Next:** the storage stack sends I/O to devices — but what are those devices, really? How does the kernel represent hardware, load drivers on demand, and make every printer, disk, and GPU show up as a file in `/dev`?
