# NUMA Deep Dive

> **Goal:** understand the Non-Uniform Memory Access architecture that every multi-socket server uses, how the kernel (partially) hides it, what happens when it fails to, and the profound consequences for application performance — database latency, VM density, and container placement.

## The physical reality

In a single-socket system, one CPU die connects to one set of memory DIMMs. Latency is uniform: every core sees ~80-100 ns to any address. This is **UMA** (Uniform Memory Access).

In a two-socket system, each socket has its own memory controller and its own DIMMs. A core on socket 0 can access socket 0's memory at ~80 ns — but socket 1's memory costs ~140 ns. That 60 ns gap is the **NUMA penalty**. On four-socket systems, remote latency can exceed 300 ns.

```text
    ┌──────────── Socket 0 ────────────┐  ┌──────────── Socket 1 ────────────┐
    │  CPU 0   CPU 1   CPU 2   CPU 3   │  │  CPU 4   CPU 5   CPU 6   CPU 7   │
    │    │       │       │       │     │  │    │       │       │       │     │
    │    └───────┴───┬───┴───────┘     │  │    └───────┴───┬───┴───────┘     │
    │         Memory Controller        │  │         Memory Controller        │
    │         (Node 0, local)          │  │         (Node 1, local)          │
    │            DIMMs 64 GB           │  │            DIMMs 64 GB           │
    └────────────┬─────────────────────┘  └────────────┬─────────────────────┘
                 │                                     │
                 └──────────── UPI / Infinity Fabric ───┘
                         (inter-socket link, ~10-50 ns hop)
```

This isn't exotic. Any server with more than one physical CPU package is NUMA. Cloud instances with many vCPUs run on NUMA hosts. Your 128-core Threadripper workstation? NUMA (even with one socket — AMD uses multiple dies on-package, each with its own memory affinity).

## How the kernel sees NUMA

The kernel represents NUMA topology as **nodes**, each containing CPUs and memory regions. The SLIT (System Locality Information Table) in ACPI gives inter-node distances:

```bash
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
# node 0 size: 64031 MB
# node 0 free: 57912 MB
# node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
# node 1 size: 64497 MB
# node 1 free: 61234 MB
# node distances:
# node   0   1
#   0:  10  21     ← 1.0x local, 2.1x to remote
#   1:  21  10

# The per-node view
ls /sys/devices/system/node/
# node0/ node1/
cat /sys/devices/system/node/node0/cpulist    # CPUs on node 0
cat /sys/devices/system/node/node0/meminfo    # memory breakdown for node 0
cat /sys/devices/system/node/node0/distance   # latency table

# Per-node memory zones
cat /sys/devices/system/node/node0/numastat   # allocation hits/misses
# numa_hit       234567890   ← pages allocated on local node
# numa_miss        1234567   ← pages allocated on remote node
# numa_foreign     9876543   ← pages initially remote, now local
# interleave_hit          0  ← interleave policy allocations
# local_node      234000000  ← processes on this node, allocated here
# other_node         567890  ← processes on other nodes, allocated here
```

## The kernel's memory allocation policy

When a process running on CPU 0 allocates memory with `malloc()` (which calls `mmap()` or `sbrk()`, which fault pages), the kernel must choose which node's memory to use. The default policy:

### Default (local allocation)

```c
// defined in mm/mempolicy.c — MPOL_DEFAULT
// "allocate on the node where the faulting CPU sits"
```

This is called **first-touch policy**. When a page fault occurs, the kernel allocates a physical page from the node where the faulting CPU runs. This is simple and works well when:
- Threads stay on their NUMA node (good affinity)
- The thread that allocates is also the thread that will use the memory

It fails badly when:
- A single thread allocates all memory on node 0, then worker threads on node 1 access it → every access is remote
- The allocator runs on a different CPU than the users (common in initialization)

### Explicit policies

```bash
# Bind: only use node 0 (fails if node 0 is full)
numactl --membind=0 ./myapp

# Preferred: try node 0, fall back to others
numactl --preferred=0 ./myapp

# Interleave: round-robin across nodes 0 and 1
numactl --interleave=0,1 ./myapp

# As a C API:
# #include <numaif.h>
# set_mempolicy(MPOL_BIND, nodemask, maxnode);
# mbind(addr, len, MPOL_INTERLEAVE, nodemask, maxnode, flags);
```

Interleave is the classic answer to "one thread allocates, many use": by striping pages across nodes, every accessor gets some local hits. But it wastes bandwidth with cross-node page table walks and defeats transparent huge pages (THP can't merge pages from different nodes).

### The kernel's response: AutoNUMA

Since Linux 3.13, the kernel has **automatic NUMA balancing** (`CONFIG_NUMA_BALANCING`). A kernel thread scans page tables and moves pages closer to the CPUs that access them, and migrates tasks toward their memory:

```bash
cat /proc/sys/kernel/numa_balancing    # 0=off, 1=on
# How it works (conceptual):
# 1. Unmap a page (set PTE to PROT_NONE) — induces a page fault on next access
# 2. The fault handler records which CPU/NUMA node touched it
# 3. After enough faults, migrate the page to the accessing node
# 4. Also migrate the task if it mostly accesses remote pages
```

The cost: AutoNUMA induces extra page faults (~0.1-1% overhead) and uses CPU time for scanning. The benefit: for multi-threaded workloads with poor initial placement, it can improve throughput by 20-50%. For well-tuned workloads, **disable it**:

```bash
echo 0 > /proc/sys/kernel/numa_balancing
# Or at boot: numa_balancing=disable
```

```bash
# Monitor AutoNUMA activity
grep -E 'numa_pte_updates|numa_huge_pte_updates|numa_hint_faults' /proc/vmstat
# numa_pte_updates: 123456    ← pages scanned for NUMA hints
# numa_hint_faults:  78901    ← faults induced by unmap
# numa_pages_migrated: 1234   ← pages actually moved
cat /proc/sys/kernel/numa_balancing_scan_size_mb      # scan window size
cat /proc/sys/kernel/numa_balancing_scan_period_min_ms # min time between scans
```

## Scheduling and NUMA

The CFS scheduler is NUMA-aware. When a task wakes up, the scheduler tries to place it on the node where its memory is hot — even if that means a slight CPU imbalance (deferred load balancing):

```bash
cat /proc/sys/kernel/sched_numa_balancing      # scheduler NUMA awareness
cat /proc/sys/kernel/sched_domain/...          # domain topology (see cpu-isolation chapter)
```

The scheduler builds **NUMA domains**: groups of CPUs where cross-node migration is acceptable only as a last resort. Within a node, tasks migrate freely. Between nodes, the scheduler imposes a "node imbalance threshold" (default ~25%) — it won't steal a task unless the load difference is significant.

```bash
# Examine scheduler domains
cat /proc/schedstat | head
cat /sys/kernel/debug/sched/domains/cpu0/domain*/name
```

For VMs: KVM pins vCPUs to physical CPUs (often explicitly via `virsh vcpupin` or `cpuset` cgroup) to exploit NUMA locality. A VM whose vCPUs and memory both sit on node 0 performs dramatically better than one spread across nodes.

## The SLIT matrix: what "distance" means

The ACPI SLIT (System Locality Information Table) provides distances in units of 10 (so value 21 = distance 2.1, meaning 2.1× the local latency). The kernel uses this to build the scheduler's NUMA topology:

```bash
# On a 4-socket AMD EPYC (NUMA per quadrant, 4 nodes per socket = 16 total):
# node   0   1   2   3   4   5 ...
#   0:  10  11  11  11  31  31 ...  ← 1.1x = same socket different die
#   4:  31  31  31  31  10  11 ...  ← 3.1x = remote socket

numactl --hardware | tail -n +5   # full distance matrix
```

On multi-die designs (AMD EPYC with chiplets), latency varies within a socket. The kernel models this correctly because ACPI exposes it. The scheduler's load balancer respects these distances.

## Real-world NUMA pathologies

### 1. The single-initializer problem

A main thread allocates all memory during startup, then spawns workers across all nodes. Every worker's access is remote on the "other" nodes.

```bash
# Detect with perf
perf stat -e node-loads,node-load-misses,node-stores,node-store-misses ./myapp
# node-load-misses > 50% → NUMA problem

# Fix: interleave or run with correct binding
numactl --interleave=all ./myapp
```

### 2. The "node imbalance" memory exhaustion

Node 0 has 2 GB free, node 1 has 60 GB free. A process on node 0 tries to allocate 3 GB. The kernel can allocate from node 1, but it resists — default policy is local. The allocation may succeed but the process silently becomes remote for all 3 GB.

```bash
# See the imbalance
numastat -m   # per-node memory breakdown
# Watch for: numa_miss climbing on a busy node while other nodes are idle
```

### 3. The KSM (Kernel Same-page Merging) NUNA trap

KSM scans for identical pages across VMs and merges them. A page shared by VMs on different nodes gets allocated on one node — one VM's access becomes remote.

```bash
# Check KSM NUMA behavior
echo 0 > /sys/kernel/mm/ksm/merge_across_nodes  # disable cross-node merging
```

### 4. The THP anti-pattern

THP merges 512 consecutive 4K pages into a 2 MB page. But if half of those pages are on node 0 and half on node 1, the merge fails. Or worse: the merge splits the page and defeats the purpose.

```bash
# Check THP success rate per node
grep -E 'thp_fault_alloc|thp_collapse_alloc' /sys/devices/system/node/node*/vmstat
```

## NUMA and containers

Kubernetes has a **Topology Manager** (kubelet flag `--topology-manager-policy=single-numa-node`) that aligns CPU and memory allocations to a single NUMA node. When a pod requests:

```yaml
resources:
  requests:
    cpu: "8"
    memory: "16Gi"
```

With `single-numa-node` policy, kubelet finds a NUMA node with ≥8 CPUs and ≥16 GB free, and pins all containers in the pod to that node via cpuset cgroup. The cgroup v1 `cpuset.mems` or cgroup v2 `cpuset.mems` controls which NUMA node the kernel allocates from:

```bash
# The cgroup interface behind Topology Manager
cat /sys/fs/cgroup/cpuset/kubepods/pod-xyz/cpuset.cpus   # CPUs pinned
cat /sys/fs/cgroup/cpuset/kubepods/pod-xyz/cpuset.mems   # NUMA nodes allowed
```

A pod without NUMA alignment on a multi-node server can lose 30-50% of its memory bandwidth — and those microseconds add up to milliseconds in latency-sensitive workloads.

## Try it yourself

```bash
# Map your NUMA topology
numactl --hardware
lstopo --no-io               # from hwloc package — visual topology graph
lscpu | grep -E 'NUMA|Socket'

# Watch NUMA misses in real time
perf stat -e node-loads,node-load-misses,node-stores,node-store-misses -a sleep 5

# Measure local vs remote memory bandwidth
numactl --membind=0 --cpunodebind=0 stream_benchmark   # local only
numactl --membind=1 --cpunodebind=0 stream_benchmark   # forced remote
# (use lmbench or Intel Memory Latency Checker (mlc) for precise numbers)

# See which processes are on which node
for pid in $(pgrep -f myapp); do
    node=$(numactl --show 2>&1 | grep "current node" || true)
    echo "PID $pid → $(cat /proc/$pid/numa_maps | head -1)"
done

# Check a process's per-node page distribution
cat /proc/$(pgrep -n mysqld)/numa_maps | head
# N0=12345 N1=678  ← 12345 pages on node 0, 678 on node 1

# Force a process onto a node
numactl --cpunodebind=0 --membind=0 myapp
taskset -c 0-15 numactl --membind=0 myapp
```

## Check your understanding

1. A 2-socket server has 128 GB per node. A single-threaded process allocates and fills 200 GB. Where do the pages actually land, and what is the performance consequence?
2. AutoNUMA balacing moves pages and tasks. What two things does it try to co-locate, and what metric does it use to decide?
3. You run `perf stat -e node-load-misses`. What threshold indicates a NUMA problem?
4. A Kubernetes pod with `cpuset.mems=0` tries to `mmap()` 20 GB of anonymous memory. Node 0 has only 10 GB free; node 1 has 100 GB. What happens?
5. Why does `numactl --interleave=all` often hurt performance more than expected despite appearing to solve the single-allocator problem?

*(Answers: the kernel's default first-touch policy means ~128 GB lands on the local node (where the process started) and the remaining ~72 GB gets allocated on the remote node when the local node is full — each of those 72 GB-worth of accesses pays the 1.5-2× remote latency penalty; AutoNUMA tries to co-locate pages with the tasks that access them — it uses hint faults as the signal: when a task on node 1 takes a hint fault on a page currently on node 0, that's evidence the page should migrate to node 1; more than ~10-15% node-load-misses on a non-trivial workload suggests a NUMA placement issue — above 30% is a clear problem; the `cpuset.mems` constraint only allows allocations from node 0, so the mmap() fails with ENOMEM despite plenty of free memory on node 1 — the solution is to set `cpuset.mems=0-1` (or use memory.memsw in cgroup v2); interleaving defeats transparent huge pages (THP can't merge pages from different NUMA nodes into a 2 MB huge page), increases TLB pressure 512× for the same working set, and doubles the page table walk cost because each node must walk its own page tables — it's a trade-off, not a silver bullet.)*

---

**Next:** the kernel allocates CPU time and memory across nodes — but what if you want to ban the kernel entirely from certain cores? CPU isolation, `nohz_full`, `rcu_nocbs`, IRQ pinning, and PREEMPT_RT: the tools that turn a general-purpose OS into a deterministic real-time engine.
