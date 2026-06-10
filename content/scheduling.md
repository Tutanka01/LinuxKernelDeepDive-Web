# CPU Scheduling

> **Goal:** understand how the kernel decides which process runs on which CPU
> and for how long — and what "nice", load average, and the cgroup CPU limits
> used by containers really mean.

## The problem

At any instant you might have 3 runnable processes and 8 cores — or 300 and 4.
The scheduler must pick who runs where, balancing goals that pull in
opposite directions:

- **Fairness** — everyone gets a share.
- **Latency** — when you press a key, the editor should respond *now*.
- **Throughput** — context switches aren't free; switching less gets more
  total work done.

The mechanism enabling all of it is **preemption**: a hardware timer
interrupts the CPU periodically, handing control to the kernel, which may
decide someone else's turn has come. No process can hold a CPU hostage.

## The big insight: most processes are asleep

A typical system has hundreds of processes but a load of nearly zero, because
almost everything is **blocked** — asleep in the kernel, waiting for input,
network data, or a timer. The scheduler only juggles the *runnable* few.

This drives the classic distinction:

- **I/O-bound** processes (editors, shells, most servers): run for microseconds,
  then block again. They crave **low latency** when their event arrives.
- **CPU-bound** processes (compilers, encoders, ML training): would happily
  compute forever. They crave **long uninterrupted slices**.

A good scheduler gives interactive tasks the CPU *quickly when they wake*, and
batch tasks the CPU *in big chunks when nobody interactive needs it*.

## How Linux does it: fair-share scheduling

### CFS: Completely Fair Scheduler (2007–2023)

The default policy (`SCHED_OTHER`) was implemented by **CFS** — the Completely
Fair Scheduler, from 2007 until kernel 6.5. The model:

> Imagine an ideal CPU that could run all N runnable tasks *simultaneously*,
> each at 1/N speed. CFS approximates this ideal on real hardware.

The bookkeeping is one number per task: **vruntime** — the virtual CPU time
it has consumed, *weighted* by its priority. The rule is simply:

```text
always run the runnable task with the smallest vruntime
```

- Tasks are kept in a red-black tree ordered by vruntime; the leftmost node
  is next to run.
- While a task runs, its vruntime grows proportionally to real time, weighted
  by nice value (a nice +10 task's vruntime grows faster, so it gets less
  real CPU — it's "nicer" to others).
- A task that **sleeps a lot** (interactive!) accumulates little vruntime, so
  when it wakes, it's far on the left — and runs almost immediately.
  Interactivity falls out of the design for free, with no heuristics.

There are no fixed time slices: the slice is computed as `sched_period / nr_running`,
with a minimum granularity so the CPU doesn't drown in context switches. On a
system with N running tasks, each gets roughly 1/N of the CPU over time.

### EEVDF: the successor (kernel 6.6+)

From kernel 6.6, CFS is replaced by **EEVDF** — Earliest Eligible Virtual
Deadline First. The fairness idea is the same, but the mechanism changes:

```text
Each task has:
  - vruntime: virtual time consumed
  - eligible time: when it may start its next slice
  - deadline: vruntime + (requested slice / weight)

Scheduler: pick the task with the earliest deadline
           among those whose eligible time has passed
```

EEVDF improves latency for tasks that wake after sleeping (they get an earlier
deadline, so they run sooner), and provides a more predictable model. The
migration from CFS to EEVDF means fewer edge cases where an arriving task
starves, and better integration with complex load balancing.

Practically, for everything you do, EEVDF feels like CFS but snappier — the
same fairness idea, same nice weighting, better handling of the gap between
"wake up" and "run".

```bash
cat /proc/self/sched          # policy, vruntime, time slice, se.exec_start
```

### nice: tilting the scales

`nice` values (−20 … +19, default 0) **weight** vruntime accounting. Each
nice step ≈ 1.25× CPU weight difference:

```bash
nice -n 19 ./big_compile.sh        # background drudge work
sudo renice -n -5 -p 1234          # boost an existing process
ps -eo pid,ni,comm | sort -k2 -n   # sort by niceness
```

The formula: `weight = 1024 / (1.25^nice)`. nice 0 = weight 1024, nice +1 = 819,
nice -1 = 1277. A nice -10 task gets roughly 10× the CPU of a nice +10 task
under contention.

### Other policies, briefly

| Policy | Who uses it |
|---|---|
| `SCHED_OTHER` | Everything normal (EEVDF 6.6+, CFS <6.6) |
| `SCHED_BATCH` | Hint: throughput over latency — don't preempt as aggressively |
| `SCHED_IDLE` | Run only when nothing else wants the CPU (very low priority) |
| `SCHED_FIFO` / `SCHED_RR` | **Real-time**: fixed priorities 1–99, always beat SCHED_OTHER tasks |
| `SCHED_DEADLINE` | Hard real-time: declare runtime, period, deadline; kernel guarantees or refuses |

Real-time classes are a completely different world. A SCHED_FIFO task at
priority 99 that enters an infinite loop **locks that CPU permanently** from
normal tasks — no timer preemption applies. This is why they require
`CAP_SYS_NICE`. SCHED_DEADLINE is the only one with actual admission control:
the kernel sums all deadlines' CPU requirements and rejects configurations
that would violate guarantees.

```bash
chrt -p $$               # check current process's scheduling policy
chrt -f -p 50 1234       # set process to SCHED_FIFO priority 50
chrt -m                  # show min/max priorities for each policy
```

## Multi-core: per-CPU queues and load balancing

Each CPU has its **own run queue** — no global lock fights. The kernel then:

- **load-balances** periodically, migrating tasks from busy to idle CPUs;
- respects **cache affinity**: moving a task away from a CPU discards its warm
  L1/L2 caches, so migration is done reluctantly;
- understands topology (SMT siblings share L1/L2, cores share LLC, NUMA nodes
  have local memory) and prefers to either spread (for throughput) or pack
  (for latency) depending on the situation;
- the `migration/<N>` kernel threads (one per CPU) handle the actual moving.

You can pin tasks yourself:

```bash
taskset -c 2,3 ./worker        # only CPUs 2 and 3
numactl --cpunodebind=0 ./worker  # only CPUs on NUMA node 0
```

### SMT siblings and the security edge

SMT (Hyper-Threading) means two logical CPUs share one physical core. The
scheduler is aware of this and tries not to put unrelated workloads on
siblings (they'd compete for execution units and L1 cache). But the security
implication is that SMT siblings share L1 — which means cache-based
side-channel attacks (Spectre-class) can leak data across them. This is why
security-conscious deployments sometimes disable SMT entirely (`nosmt` boot
parameter).

## Context switches: the price of it all

Switching tasks means saving registers, switching the address space (flush
TLBs, load new page table root — mitigated by PCID/ASID on modern CPUs), and —
the real cost — losing cache and TLB warmth. Rough order: ~1–3 microseconds
of direct cost, more in indirect cache and TLB refill misses later.

```bash
vmstat 1          # 'cs' column = context switches/sec
pidstat -w 1      # voluntary vs involuntary switches per process
perf stat -e context-switches -a -- sleep 1  # total switches/sec
```

- **voluntary** switch: the task blocked (waiting on I/O, called sched_yield,
  or its slice ended). Normal.
- **involuntary**: the task was preempted — it wanted to keep running but the
  timer interrupt decided otherwise. Lots of these = CPU contention.

On a busy server, you might see 50,000–200,000 context switches per second.
That's normal. Above 500,000/sec, the context-switch overhead itself becomes
a significant fraction of total CPU.

## Load average: the most misread number in Linux

```bash
uptime
# 14:11:21 up 12 days,  3:42,  1 user,  load average: 2.41, 1.13, 0.78
```

The three numbers are exponentially-damped averages (1, 5, 15 min) of the
count of tasks **runnable + in uninterruptible sleep (`D`)**. Two readings:

- On a 8-core box, load 2.4 ≈ comfortable; load 9 ≈ saturated; load 50 ≈ pain.
  **Always divide by core count.**
- Because `D`-state tasks count, a load spike can mean *disk/NFS trouble*,
  not CPU at all. Check `vmstat`'s `wa` (iowait) column to tell them apart.

The formula underneath:
```text
load(t) = load(t-1) * exp(-5/60) + active_tasks * (1 - exp(-5/60))
```
(1-minute average, sampled every 5 seconds; 5- and 15-min use different
constants).

```bash
cat /proc/loadavg                   # also shows nr_threads and last PID
cat /proc/pressure/cpu              # PSI: % of time some tasks stalled on CPU
```

PSI (`/proc/pressure/cpu`) is actually more useful than load average: it
reports "some" and "full" stall percentages. If CPU PSI is high, tasks are
actually waiting. Load average can be 16 with all 16 cores happily busy and
zero CPU pressure — they're working, not waiting.

## Scheduling and containers (the bridge to Part III)

Containers don't get a special scheduler. Their CPU limits are **cgroup**
parameters feeding into this very machinery:

- `cpu.weight` (a.k.a. "shares") — fair-share *proportions* between groups:
  only matters under contention. Two groups with weights 200 vs 100 split a
  busy CPU 2:1; on an idle machine both can use 100%.
- `cpu.max` (a.k.a. "quota/period", the thing behind `docker run --cpus=1.5`)
  — a **hard ceiling**: the group gets at most, say, 150 ms of CPU per 100 ms
  period across all cores. Exhaust it and *all* the group's tasks are
  **throttled** — frozen until the next period, even if every core is idle.

That throttling is the classic "my container has CPU limit 1 and mysterious
100 ms latency spikes" production issue: a multi-threaded runtime burns the
whole quota in the first 20 ms of each 100 ms period, then everything stalls
for 80 ms. Check your diagnosis:

```bash
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.stat
# nr_throttled 1234             ← rising → quota is biting
# throttled_usec 98765432       ← cumulative throttle time
```

The fix: either raise the limit, add a burst budget (`cpu.max.burst`), or
reduce concurrency so the workload spreads its work over the full period. The
scheduler's fair-share mechanism is transparent and well-behaved; the
hard-quota mechanism is the one that creates pathological sawtooth latency.

## Try it yourself

```bash
cat /proc/self/sched | head -8          # your shell's scheduler stats
chrt -p $$                              # its policy and priority
stress -c $(nproc) &                    # saturate CPUs, then:
uptime; vmstat 1 5                      # watch load and 'cs' climb
perf stat -e context-switches -a -- sleep 1
cat /proc/pressure/cpu                  # PSI: are tasks actually waiting?
kill %1
# Real-time demo (careful — can lock up; use a test VM):
sudo chrt -f -p 1 stress -c 1  &       # FIFO prio 1, will starve normal tasks
ps -eo pid,comm,cls,rtprio | grep stress
```

## Check your understanding

1. Why do interactive tasks get good latency under EEVDF without any explicit
   "interactivity bonus"?
2. Load average is 8 on a 4-core machine, but CPU usage is 30%. What's the
   likely culprit?
3. Why can a container be throttled while the host's CPUs sit idle?
4. What's the difference between PSI and load average — why is PSI usually
   more useful?
5. A SCHED_FIFO task at priority 99 runs an infinite loop. What happens to
   normal tasks on that CPU?

*(Answers: EEVDF inherits CFS's property — sleeping tasks accumulate little
vruntime, so when they wake they have an earlier deadline and run immediately;
tasks in D-state (uninterruptible sleep) are stuck waiting on disk I/O, NFS,
or device lock — check iostat and /proc/pressure/io; cpu.max is a hard
ceiling — the container burned its quota for the current period and all its
threads are throttled until the next period starts, regardless of idle CPUs;
PSI measures time tasks are actually *stalled* waiting, while load average
counts runnable+D-state tasks — PSI answers "is anything hurting?" rather than
"are things busy?"; normal tasks on that CPU are permanently starved — FIFO
real-time tasks are not preempted by the timer, and priority 99 beats
everything, so that CPU is frozen forever until the task blocks or is killed.)*

---

**Next:** the grandest illusion the kernel performs — virtual memory.
