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

The default policy (`SCHED_OTHER`) is implemented by **CFS** — the Completely
Fair Scheduler (since 2007; being succeeded by **EEVDF** from kernel 6.6, same
fairness idea with better latency handling). The model:

> Imagine an ideal CPU that could run all N runnable tasks *simultaneously*,
> each at 1/N speed. CFS approximates this ideal on real hardware.

The bookkeeping is one number per task: **vruntime** — the virtual CPU time
it has consumed. The rule is simply:

```text
always run the runnable task with the smallest vruntime
```

- Tasks are kept in a structure ordered by vruntime (a red-black tree);
  the leftmost is next to run.
- While a task runs, its vruntime grows; eventually another task is "owed"
  more, and the running task is preempted.
- A task that **sleeps a lot** (interactive!) accumulates little vruntime, so
  when it wakes, it's far on the left — and runs almost immediately.
  Interactivity falls out of the design for free, with no heuristics.

There are no fixed time slices: the slice is computed from a target period
divided among runnable tasks, with a floor so switching doesn't dominate.

### nice: tilting the scales

`nice` values (−20 … +19, default 0) **weight** vruntime accounting. A nice
+10 task's vruntime grows faster, so it gets less real CPU — it's "nicer" to
others. Each nice step ≈ 1.25× CPU weight difference.

```bash
nice -n 19 ./big_compile.sh        # background drudge work
sudo renice -n -5 -p 1234          # boost an existing process
```

### Other policies, briefly

| Policy | Who uses it |
|---|---|
| `SCHED_OTHER` | Everything normal (CFS/EEVDF) |
| `SCHED_BATCH` | Hint: throughput over latency |
| `SCHED_IDLE` | Run only when nothing else wants the CPU |
| `SCHED_FIFO` / `SCHED_RR` | **Real-time**: fixed priorities 1-99, always beat normal tasks. Audio servers, robotics. A runaway FIFO task can starve the machine — privilege required |

## Multi-core: per-CPU queues and load balancing

Each CPU has its **own run queue** — no global lock fights. The kernel then:

- **load-balances** periodically, migrating tasks from busy to idle CPUs;
- respects **cache affinity**: moving a task away from a CPU discards its warm
  L1/L2 caches, so migration is done reluctantly;
- understands topology (SMT siblings, shared L3, NUMA nodes) and prefers to
  spread or pack accordingly.

You can pin tasks yourself:

```bash
taskset -c 2,3 ./worker        # only CPUs 2 and 3
```

## Context switches: the price of it all

Switching tasks means saving registers, switching the address space, and —
the real cost — losing cache and TLB warmth. Rough order: a microsecond
of direct cost, more in indirect cache misses.

```bash
vmstat 1          # 'cs' column = context switches/sec
pidstat -w 1      # voluntary vs involuntary switches per process
```

- **voluntary** switch: the task blocked (waiting on I/O). Normal.
- **involuntary**: the task was preempted — it wanted to keep running. Lots of
  these = CPU contention.

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
whole quota in the first part of each period, then everything stalls.
We'll see the cgroup files themselves in Part III.

## Try it yourself

```bash
cat /proc/self/sched | head -8          # your shell's scheduler stats
chrt -p $$                              # its policy and priority
stress -c $(nproc) &                    # saturate CPUs, then:
uptime; vmstat 1 5                      # watch load and 'cs' climb
kill %1
```

## Check your understanding

1. Why do interactive tasks get good latency under CFS without any explicit
   "interactivity bonus"?
2. Load average is 8 on a 4-core machine, but CPU usage is 30%. What's the
   likely culprit?
3. Why can a container be throttled while the host's CPUs sit idle?

---

**Next:** the grandest illusion the kernel performs — virtual memory.
