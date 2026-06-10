# Performance Analysis Methodology

> **Goal:** learn a systematic approach to finding what's slow — the USE method, the RED method, the workload characterization, the flame graph, and the signal-to-investigation mapping. Every tool in the observability chapter and every subsystem in this site has a purpose; this chapter is about knowing which to reach for and when.

## Why methodology matters

Linux exposes thousands of metrics: `/proc/slabinfo`, `/proc/net/snmp`, `/sys/kernel/debug/...`, `perf` counters, eBPF hooks. Without a framework, you drown in data. With the right methodology, you ask three questions and know exactly where to look.

The three frameworks every performance engineer should know:

| Framework | Question it answers | Key metric type |
|---|---|---|
| **USE** | Is a resource the bottleneck? | Utilization, Saturation, Errors |
| **RED** | Is the *service* healthy? | Rate, Errors, Duration |
| **Workload Characterization** | What is the system even doing? | Composition, distribution, patterns |

## USE: Utilization, Saturation, Errors

For every physical resource (CPU core, disk, network interface, memory bus, interconnect), ask three questions:

1. **Utilization**: what fraction is busy? (e.g., CPU utilization 90%)
2. **Saturation**: what's waiting for it? (e.g., run queue length > cores)
3. **Errors**: what's failing? (e.g., disk media errors, NIC CRC errors)

```bash
# USE checklist — run these first, always
# ---- CPU ----
mpstat -P ALL 1                     # utilization per CPU
cat /proc/loadavg                   # saturation (load average > cores)
cat /proc/pressure/cpu              # PSI: some/full contention
grep -E 'processor|model name|MHz' /proc/cpuinfo  # inventory

# ---- Memory ----
free -h                             # utilization: total vs available
cat /proc/pressure/memory           # saturation: PSI memory pressure
sar -r 1                           # utilization + saturation over time
grep -E '^SReclaimable|^MemAvailable' /proc/meminfo

# ---- Storage ----
iostat -x 1                         # utilization: %util, saturation: await, errors: nothing
cat /proc/pressure/io               # PSI: IO pressure
cat /sys/block/sda/stat             # raw counts
lsblk && df -h                      # inventory

# ---- Network ----
sar -n DEV 1                        # utilization: rxkB/s, txkB/s
netstat -s | head -30               # errors: retransmits, drops
cat /proc/net/dev                   # raw per-interface stats
ip -s link show                     # detailed error counters per interface
ethtool -S eth0                     # driver-level counters (drops, overruns)
```

### Understanding PSI (Pressure Stall Information)

PSI (`/proc/pressure/*`) is the modern replacement for load average. It tells you *how much* some tasks have been delayed waiting for a resource:

```bash
cat /proc/pressure/cpu
# some avg10=4.50 avg60=1.23 avg300=0.56 total=123456789
# full avg10=1.10 avg60=0.30 avg300=0.12 total=987654321

# "some" = at least one task was stalled on CPU
# "full" = all runnable tasks were stalled (the entire machine)
# avg10 = average over last 10 seconds (percentage)
# total = cumulative stall time in microseconds

cat /proc/pressure/memory
# some avg10=0.03 avg60=0.00 avg300=0.00 total=12345
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
# If full > 0, some task is fully blocked on memory allocation — OOM territory

cat /proc/pressure/io
# some avg10=12.30 avg60=5.40 avg300=2.10 total=1234567890123
# IO pressure is the most common bottleneck on cloud instances
```

PSI > 0% "some" means the resource is saturated; PSI > 0% "full" means the saturation is globally visible.

### Interpreting USE results

| Finding | What it means | Next step |
|---|---|---|
| CPU util > 90%, load avg < cores | Heavily utilized, not saturated | Accept or add capacity |
| CPU util < 90%, load avg > 2× cores | Saturated — threads waiting | Profile: what are they waiting for? Lock? Page fault? |
| Disk %util = 100%, await > 50ms | Disk saturated, requests queued | iostat -x to find the busy disk; iotop to find the process |
| Memory available < 10% total, PSI memory > 0 | Memory-constrained | `slabtop`, `top -o %MEM`, identify the consumer |
| Network drops > 0, rx_missed_errors > 0 | NIC overwhelmed, buffering | `ethtool -g` check ring buffer size; `ethtool -C` adjust coalescing |
| Errors (any counter) > 0 for 5+ minutes | Hardware or driver problem | `dmesg`, `SMART`, cable check |

## RED: Rate, Errors, Duration

USE asks "is the machine healthy?" RED asks "is the service healthy from the user's perspective?"

| Metric | Question | Example |
|---|---|---|
| **Rate** | Requests per second | 500 HTTP req/s |
| **Errors** | Failed requests per second | 3% error rate (500 errors, 500 internal errors) |
| **Duration** | Time to serve a request | p99 = 250ms, p50 = 15ms |

RED works on any service: HTTP endpoints, database queries, RPC calls, even kernel syscalls (rate = syscalls/s, errors = -errno returns, duration = syscall latency).

```bash
# RED for HTTP (using log analysis or tracing proxy)
# Without tools: strace + awk gives a crude RED per syscall
strace -c -p $(pgrep nginx | head -1) -T    # -T = duration per call
# % time     seconds  usecs/call     calls    errors syscall
# ------ ----------- ----------- --------- --------- ----------------
#  42.34    0.123456      1234       100      3     read
#  30.12    0.087654       876       100      0     write
#   ...
# Rate = calls/s, Errors = errors, Duration = usecs/call

# RED for containers using BPF
sudo bpftrace -e \
  'kretprobe:tcp_sendmsg /comm == "nginx"/ { @duration_us = hist((nsecs - @start[tid]) / 1000); }' \
  -e 'kprobe:tcp_sendmsg /comm == "nginx"/ { @start[tid] = nsecs; }'
```

The key insight of RED: you can have 100% CPU utilization (USE problem) but still serve 500 req/s at p99=15ms — that's fine. Or you can have 10% CPU but p99=2000ms — that's a RED problem the USE metrics missed entirely.

## Workload characterization

Before optimizing, you must know what the system is actually doing:

```bash
# Who is using the CPU?
top -o %CPU -n 1 -b | head -20

# What syscalls dominate?
strace -c -f -p $(pgrep -n mysqld) -S calls  # sort by call count
strace -c -f -p $(pgrep -n mysqld) -S time   # sort by wall time

# Which kernel functions take the most time?
perf top -e cycles:k                          # kernel mode only
perf top -e cycles:u                          # user mode only

# What is the disk I/O pattern?
iostat -x 1                                   # watch r/s, w/s, rkB/s, wkB/s
iotop -o -b -d 2                              # which processes, sorted by IO

# What's on the network?
ss -tnp | awk '{print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn  # top remote IPs
tcpdump -i eth0 -nn -c 1000 -w /tmp/sample.pcap  # capture for detailed analysis
```

One of the most important things to understand: is the workload CPU-bound, memory-bound, I/O-bound, or network-bound? A single `vmstat 1` gives the answer:

```bash
vmstat 1
# procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
# r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
# 4  0      0  12345  56789 123456    0    0   100  2000 5000 8000 45 15 30 10  0
#
# r=4 (>cores?) → CPU saturated
# bi=100 kB/s → minimal read I/O (page cache working)
# bo=2000 kB/s → writing ~2 MB/s (moderate write)
# us=45, sy=15 → 60% CPU used, 30% idle, 10% iowait
# This is a CPU-bound workload with moderate writes
```

## The 60-second checklist

Brendan Gregg's famous methodology for the first 60 seconds on an unknown system:

```bash
uptime                     # load averages, how long has it been up?
dmesg -T | tail -20        # kernel errors, OOMs, hardware faults
vmstat 1                   # r/b columns, memory pressure, swap activity
mpstat -P ALL 1            # per-CPU utilization imbalance
pidstat 1                  # per-process CPU usage
iostat -x 1                # disk utilization, await, queue sizes
free -m                    # cached/available memory, not just "free"
sar -n DEV 1               # network throughput and packet rates
sar -n TCP,ETCP 1          # TCP connection rates, retransmits, passive/active opens
top -o %CPU -n 1 -b | head -20  # top processes by CPU
```

This isn't a solution — it's a snapshot that tells you which framework (USE, RED, or workload char) to dive deeper into.

## Flame graphs: from counters to understanding

Perf counters tell you *what* is hot; flame graphs show you *why*. A flame graph visualizes a stack trace profile:

```bash
# Generate a flame graph
perf record -F 99 -a -g -- sleep 30          # sample at 99 Hz for 30s
perf script > out.perf
# (using Brendan Gregg's FlameGraph tools)
./stackcollapse-perf.pl out.perf > out.folded
./flamegraph.pl out.folded > flame.svg
```

```
    Flame graph reading:
    ┌──────────────────────────────────────────┐
    │  main()                              ← wide bar = lots of samples
    │  ┌──────────────────────────────────┐  │
    │  │  process_request()               │  │
    │  │  ┌─────────────────────────────┐ │  │
    │  │  │  parse_json()      write()  │ │  │  ← narrow bar = few samples
    │  │  │  ┌──────────┐               │ │  │
    │  │  │  │ strlen() │               │ │  │
    │  │  │  └──────────┘               │ │  │
    │  │  └─────────────────────────────┘ │  │
    │  └──────────────────────────────────┘  │
    └──────────────────────────────────────────┘
    x-axis = stack proportion (alphabetical sort, not chronological)
    width  = proportion of samples in that code path
    colors = random/arbitrary (one color per function, not semantic)
```

Never look at a flame graph for the wide bars — those are the hot paths, and they're supposed to be wide. **Look at the narrow bars**: they're code paths you didn't expect to see. A `memcpy()` in your packet-processing hot loop or `syslog()` in the critical path — the flame graph reveals them instantly.

## Signals and their investigations

Every symptom has a related kernel subsystem and investigation path:

| Symptom | First check | Deep dive |
|---|---|---|
| High CPU but low throughput | `perf top` | Lock contention, busy-waiting, spin loops |
| High system CPU (sy%) | `perf top -e cycles:k` | Syscall overhead, retpoline/PTI, page faults |
| High iowait (wa%) | `iostat -x 1` | Disk saturation, `blktrace` the offending device |
| Swap activity while free > 0 | `/proc/meminfo` VmallocUsed | Memory fragmentation, zones, NUMA imbalance |
| Application hangs, no CPU | `perf record -e 'sched:sched_switch'` | Blocked on lock, I/O, page fault, or futex |
| high context switch rate | `pidstat -w 1` | Futex contention, excessive `poll()`/`select()` |
| P99 latency spikes | `bpftrace` one-liner on function entry/return | Identify the specific kernel path causing delay |
| Container OOM killed | `dmesg \| grep oom`, cgroup `memory.events` | Memory.max exceeded; check `memory.stat` for cache vs anon |
| Network timeout bursts | `ss -ti`, `nstat -a` | TCP retransmits, zero-window, congestion, bufferbloat |
| Disk latency spikes | `iostat -x 1`, `blktrace` | Scheduler latency, queue depth exhaustion, media errors |

### The investigation pattern

```
Symptom → USE check (is a resource saturated?)
       → RED check (is the service latency/error rate up?)
       → Workload check (what patterns dominate?)
       → Hypothesis → Test with perf/bpftrace → Validate → Fix → Repeat
```

Every layer of this book — processes, scheduling, memory, the storage stack, networking, eBPF — becomes relevant at a different stage of this loop.

## Putting it all together: a real investigation

Scenario: a Kubernetes node shows 80% CPU utilization but the application (a Go web server) reports p99 latency of 500ms (normally 10ms).

```bash
# Step 1: USE
mpstat -P ALL 1
# CPU:  40% user, 40% system (sy%), 20% idle
# sy% is high — the kernel is doing more work than the app. Suspicious.

# Step 2: What syscalls?
perf top -e cycles:k
# 15%  __x64_sys_futex    ← futex contention
# 10%  do_page_fault      ← page faults in kernel
#  5%  __scheduler         ← context switching

# Step 3: Why futex?
bpftrace -e 'kprobe:do_futex { @[comm] = count(); }'
# Shows the app process flooding futex_wait

# Step 4: Combined with flame graph
perf record -F 99 -a -g -- sleep 10
# Flame graph reveals: the Go runtime's channel operations are competing for
# a shared mutex, causing futex contention and involuntary context switches

# Root cause: mutex contention in userspace → kernel futex overhead
# Fix: reduce lock granularity in Go code, not a kernel problem
```

The fix was in userspace — but the investigation path went through six kernel subsystems: scheduling, futex, page faults, context switches, CPU utilization, and perf profiling. This is why you learn the whole stack.

## Try it yourself

```bash
# The USE method in 10 seconds
uptime && \
free -h && \
mpstat -P ALL 1 1 && \
iostat -x 1 1 && \
sar -n DEV 1 1

# PSI — the underused gem
watch -n 1 'grep . /proc/pressure/*'

# RED for your system (crude but effective)
strace -c -S time -f -p $$ &  # run in background
stress-ng --cpu 1 --timeout 5s
kill %1

# Generate a flame graph
sudo perf record -F 99 -a -g -- sleep 30
sudo perf script > out.perf
# Download FlameGraph tools and run:
# stackcollapse-perf.pl out.perf | flamegraph.pl > flame.svg

# Off-CPU flame graph (what blocks tasks, not what consumes CPU)
sudo perf record -e 'sched:sched_switch,sched:sched_wakeup' -a -- sleep 30
sudo perf script > out_offcpu.perf
# (requires special stackcollapse + flamegraph handling for off-CPU events)
```

## Check your understanding

1. CPU utilization is 85% but PSI "some" is 0.2%. How can both be true?
2. iowait (wa%) is 40%. The disk shows %util = 10%. What's actually happening?
3. RED shows p50=5ms, p99=800ms. USE metrics are all normal. Where do you look?
4. A flame graph shows `__x64_sys_read` consuming 30% of samples. Is that suspicious?
5. `vmstat` shows `r=12` on an 8-core machine but `us=30`, `sy=10`, `id=60`. What does `r=12` actually measure?

*(Answers: CPU utilization of 85% means cores are active 85% of the time, but PSI "some" at 0.2% means tasks are only stalled waiting for CPU 0.2% of the time — the CPU is busy but tasks rarely have to wait, meaning the workload is well-tuned with short, frequent CPU bursts; iowait is a misleading metric: on modern multi-core systems, 40% iowait on one core that's waiting for I/O while others are busy gives a misleading percentage — check `iostat -x` for the actual await and queue depth; something is causing tail latency — look for synchronous pauses: VM exit overhead (if virtualized), transparent huge page compaction (khugepaged), cgroup writeback throttling, node.js/Go garbage collection pauses, or a lock in the application that serializes requests; 30% in read() isn't necessarily bad — read() includes copying data from kernel to user space and fetching from page cache; it's expected in I/O-heavy workloads — but if the app is supposed to be CPU-bound (compute), this wide bar suggests unexpected I/O, possibly due to mmap'd file I/O or misconfigured library caching; `r=12` means on average over the last sampling interval, 12 tasks were in the *runnable* state (R state in ps) — waiting to run, not necessarily running — even though total CPU use is 40% (30+10), those 12 tasks are taking turns and blocking frequently (likely on I/O or locks), so many are runnable for short bursts, creating a high averagable count.)*

---

**Next:** the tools chapter — `/proc`, `strace`, `perf`, and eBPF. Everything you've learned across this entire site, now observable on a live system. The theory becomes muscle memory.
