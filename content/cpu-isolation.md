# CPU Isolation, NO_HZ & Real-Time Linux

> **Goal:** understand how to carve CPUs out of the kernel's general-purpose scheduler, silence the timer tick on them, pin interrupts elsewhere, and achieve deterministic latency — moving from the default "fair-share for everyone" model to "these cores are mine, nothing touches them."

## Why default scheduling isn't enough

The CFS scheduler (chapter 5) gives every process a fair share. It handles hundreds of tasks per core, migrates work for balance, and fires a timer interrupt 250-1000 times per second (the **scheduler tick**) on every CPU. This is perfect for throughput. It is terrible for latency.

For a high-frequency trading application, a real-time audio pipeline, or a DPDK packet processor, a single timer interrupt at the wrong moment means a 10 µs stall — unacceptable when the budget is 5 µs.

The kernel provides four mechanisms to take CPUs away from general-purpose scheduling:
1. **`isolcpus`**: boot-time CPU isolation
2. **`nohz_full`**: eliminate the periodic scheduler tick
3. **`rcu_nocbs`**: offload RCU callbacks from isolated CPUs
4. **IRQ affinity**: pin hardware interrupts to non-isolated CPUs

Together, they create **housekeeping CPUs** (running the kernel's background chores) and **isolated CPUs** (running one thing and one thing only).

## The boot-time recipe

```bash
# In /etc/default/grub GRUB_CMDLINE_LINUX:
# Reserve CPUs 8-15 as isolated, with tick suppression and RCU offloading.
# CPUs 0-7 become housekeeping.
isolcpus=8-15 nohz_full=8-15 rcu_nocbs=8-15

# Then:
update-grub
reboot
```

What each parameter does:

### `isolcpus=8-15`

Removes CPUs 8-15 from the scheduler's general load-balancing domain. The kernel will not automatically place any task (kernel threads, timers, workqueues) on these CPUs. Only explicit affinity (via `taskset` or `sched_setaffinity()`) can place a task there.

```bash
# Verify isolation
cat /sys/devices/system/cpu/isolated     # "8-15"
cat /sys/devices/system/cpu/present      # all CPUs
cat /proc/schedstat | grep cpu8          # should show near-zero activity

# Check which CPUs handle the timer tick
cat /proc/interrupts | grep -E 'CPU|LOC' | head -2  # LOC = local timer interrupts
# Before nohz_full: every CPU gets ticks
# After:  isolated CPUs show near-zero LOC counts
```

### `nohz_full=8-15`

Eliminates the periodic scheduler tick on CPUs 8-15. Instead of tick-tick-tick every 1-4ms (depending on `CONFIG_HZ`), the kernel enters **adaptive-tick mode**: if only one task is runnable on that CPU, the tick is suppressed entirely. The CPU continues running the task without interruption. The tick only fires when:
- The CPU's only task expires its timeslice (if SCHED_OTHER)
- Another task becomes runnable on that CPU
- A deferred timer needs to fire

```bash
# Check if nohz_full is active
cat /sys/kernel/debug/tracing/per_cpu/cpu8/stats
# nohz_full active: should show minimal tick events

# The kernel config that enables this:
# CONFIG_NO_HZ_FULL=y  (not just CONFIG_NO_HZ_IDLE)
```

The catch: `nohz_full` requires `CONFIG_NO_HZ_FULL=y` in the kernel config, and **at least one CPU outside the `nohz_full` set** must handle the timekeeping duties (the "timekeeper" CPU). Don't put all CPUs in `nohz_full`.

### `rcu_nocbs=8-15`

RCU (Read-Copy-Update) is the kernel's primary synchronization mechanism. It works by having each CPU track "grace periods" — when every CPU has passed through a quiescent state (done with the old version of data), the old data can be freed.

Normally, each CPU processes its own RCU callbacks. This means RCU softirqs fire on every CPU periodically. `rcu_nocbs` offloads callback processing to housekeeping CPUs:

```bash
# RCU callbacks: before vs after
cat /sys/kernel/debug/rcu/rcu_preempt/rcudata | head -20
# n_cbs_invoked: cumulative callbacks processed on this CPU
# With rcu_nocbs, isolated CPUs show near-zero
```

### Additional critical knobs

```bash
# Prevent kernel threads from spawning on isolated CPUs
# In kernel config: CONFIG_NO_HZ_FULL_ALL (applies to all CPUs, less flexible)

# Move all workqueue workers to housekeeping CPUs
echo 0-7 > /sys/devices/virtual/workqueue/cpumask
# Or per-workqueue:
echo 0-7 > /sys/devices/virtual/workqueue/writeback/cpumask

# Prevent the OOM reaper from using isolated CPUs
echo 0-7 > /proc/sys/vm/oom_kill_allocating_task

# Disable machine checks on isolated CPUs (temporarily, only if you know what you're doing)
echo 0 > /sys/devices/system/machinecheck/machinecheck0/check_interval

# Disable watchdog timers on isolated CPUs
echo 0 > /sys/devices/virtual/workqueue/events_unbound/watchdog_cpumask
```

## IRQ affinity: the next layer

Hardware interrupts (NIC, storage controller, USB) fire on all CPUs by default (via `irqbalance` or round-robin). An interrupt on an isolated CPU defeats the purpose. Pin all IRQs to housekeeping CPUs:

```bash
# See current IRQ distribution
cat /proc/interrupts

# Pin all IRQs to housekeeping CPUs 0-7
for irq in $(ls /proc/irq/); do
    [ "$irq" = "default_smp_affinity" ] && continue
    echo 0-7 > /proc/irq/$irq/smp_affinity_list 2>/dev/null || true
done

# Or use the irqbalance service with the right config:
# IRQBALANCE_BANNED_CPUS="8-15"  in /etc/sysconfig/irqbalance
```

For PCIe devices, the relationship between IRQ and MSI-X vector matters:

```bash
# List MSI-X vectors for a NIC
ls /sys/class/net/eth0/device/msi_irqs/
# Each file contains one IRQ number

# Pin NIC receive queues to specific CPUs (for receive-side scaling)
ethtool -X eth0 weight 1 1 1 1 1 1 1 1 0 0 0 0 0 0 0 0
# Sets 8 RX queues on CPUs 0-7, none on 8-15
```

## Real-time scheduling on isolated CPUs

With CPUs isolated, you can place real-time tasks (SCHED_FIFO, SCHED_DEADLINE, or SCHED_OTHER with high nice) that run with minimal interference:

```bash
# Run mysqld pinned to CPUs 8-11
taskset -c 8-11 chrt -f 99 mysqld

# chrt -f 99 = SCHED_FIFO with priority 99 (max)
# chrt -r 99 = SCHED_RR with priority 99 (round-robin variant)
# chrt -d ... = SCHED_DEADLINE
```

But real-time is not automatically determinism. Even with SCHED_FIFO priority 99, the kernel can still:
- Take an NMI (non-maskable interrupt)
- Handle a TLB shootdown from another CPU
- Execute a mandatory RCU callback
- Fence due to a machine check

For *deterministic* latency (worst-case guarantee, not just statistical), you need the full PREEMPT_RT patch set.

## PREEMPT_RT: the real real-time kernel

The mainline kernel is designed for throughput, not latency. Critical sections under spinlocks can be arbitrarily long. Preemption is disabled in hundreds of places.

CONFIG_PREEMPT_RT (merged into mainline progressively since 5.15) changes the rules:

1. **Spinlocks become sleeping mutexes**: every `spin_lock()` can be preempted. No more unbounded non-preemptible sections.
2. **Hard interrupts become threaded**: interrupt handlers run as kernel threads (visible as `[irq/N-...]`), schedulable and preemptible like any task.
3. **Priority inheritance**: if a high-priority RT task blocks on a mutex held by a low-priority task, the low-priority task inherits the high priority until it releases the lock — preventing **priority inversion**.
4. **High-resolution timers**: `CONFIG_HIGH_RES_TIMERS` gives nanosecond-resolution timers instead of the jiffy granularity of standard Linux.

```bash
# Check if you're running PREEMPT_RT
uname -v | grep PREEMPT_RT
# Or:
cat /sys/kernel/realtime     # 1 if RT is active

# Verify IRQ threading
ps aux | grep '\[irq/'       # Each hardware IRQ has a kernel thread

# Set real-time priority on an IRQ thread
chrt -f 80 $(pgrep -f 'irq/24-eth0')
```

The cost: PREEMPT_RT reduces throughput by 10-30% in some workloads because:
- Sleeping mutexes have higher overhead than raw spinlocks
- Interrupt threading adds context switch cost
- The scheduler runs more aggressively

This is a fundamental trade-off: throughput vs worst-case latency. For a web server, vanilla Linux is better. For a robot controller, PREEMPT_RT is mandatory.

## Cyclictest: measuring actual latency

```bash
# Install rt-tests package
cyclictest --mlockall --smp --priority=99 --interval=200 --distance=0 --duration=60m

# Output:
# T: 0 (  1234) P:99 I:200 C: 18000000 Min:      3 Act:    5 Avg:    4 Max:      12
# T: 1 (  1235) P:99 I:200 C: 18000000 Min:      3 Act:    4 Avg:    4 Max:       9
# ...
# Max is the key number: worst-case latency over 60 minutes
```

Cyclictest wakes up every `interval` microseconds, measures the difference between expected and actual wake-up time, and reports min/avg/max. On a properly tuned PREEMPT_RT system, max latency stays under 15-20 µs. On a stock kernel with CPU isolation but no RT, expect 50-200 µs. On a loaded vanilla kernel, 500+ µs.

```bash
# Generate load while testing
stress-ng --cpu 0 --io 2 --hdd 1 --timeout 60m &
# Then run cyclictest — Max is the realistic worst case
```

## Advanced isolation: the complete checklist

```
[kernel command line]
isolcpus=8-15
nohz_full=8-15
rcu_nocbs=8-15
rcu_nocb_poll           ← poll for callbacks instead of waiting for interrupts
nohz=off                 ← not needed; nohz_full handles it
processor.max_cstate=1   ← limit C-states to C1 (no deep sleep on isolated CPUs)
intel_idle.max_cstate=0  ← same, Intel-specific (deeper C-states add exit latency)
idle=poll                ← never enter C-states at all (max power, min latency)
mitigations=off          ← disable speculative execution mitigations (if acceptable)
skew_tick=1              ← offset per-CPU ticks to avoid synchronized wake-ups
irqaffinity=0-7          ← all IRQs to housekeeping CPUs (shortcut for /proc/irq/)

[taskset / cgroup cpuset]
taskset -c 8-15 chrt -f 99 ./myapp
# or via cgroup:
echo 8-15 > /sys/fs/cgroup/cpuset/rt/cpuset.cpus
echo 8-15 > /sys/fs/cgroup/cpuset/rt/cpuset.mems
echo $$ > /sys/fs/cgroup/cpuset/rt/tasks

[sysctl tunables]
kernel.sched_rt_runtime_us = -1         ← remove RT throttling (RT tasks can use 100%)
vm.stat_interval = 120                  ← reduce VM stat timer firing
kernel.watchdog_thresh = 60             ← or disable: kernel.watchdog = 0
kernel.nmi_watchdog = 0                 ← disable the NMI watchdog on isolated CPUs
```

## The DPDK / AF_XDP extreme case

For kernel-bypass networking (DPDK, AF_XDP), you don't even want the kernel scheduler to *think* about those CPUs. The DPDK EAL (Environment Abstraction Layer) combines `isolcpus` + `nohz_full` + huge pages + `intel_idle.max_cstate=0` to achieve < 10 µs latencies from wire to application. The kernel is truly absent on those cores — no ticks, no scheduling decisions, no softirqs. The CPU runs a polling loop that reads packets directly from the NIC.

## Try it yourself

```bash
# Test latency before and after isolation
sudo cyclictest --mlockall --smp --priority=99 --duration=60s
# Note the Max value

# Edit /etc/default/grub to add isolcpus, reboot, retest
# Compare Max latency

# Check tick activity
watch -n 1 'cat /proc/interrupts | grep LOC'
# Isolated CPUs should show no increase over time

# Verify cgroup cpuset isolation
mkdir /sys/fs/cgroup/cpuset/isolated
echo 8-9 > /sys/fs/cgroup/cpuset/isolated/cpuset.cpus
echo 0 > /sys/fs/cgroup/cpuset/isolated/cpuset.mems
echo $$ > /sys/fs/cgroup/cpuset/isolated/tasks
taskset -cp $$  # should show affinity 8-9

# Run a tight loop with clock_gettime to measure perturbation
chrt -f 99 ./check_jitter
# (check_jitter: repeatedly call clock_gettime(CLOCK_MONOTONIC, &ts),
#  measure gaps — any gap > 10 µs is a kernel interruption)
```

## Check your understanding

1. You set `isolcpus=8-15` but `top` still shows some kernel threads on CPU 8. Why?
2. `nohz_full` eliminates the periodic tick, but a CPU still gets timer interrupts. What causes them?
3. A PREEMPT_RT kernel reports a 200 µs latency spike during a `spin_lock` in a filesystem driver. How is this possible if RT makes spinlocks preemptible?
4. Kubernetes node has `isolcpus=8-15`. The kubelet sees 16 CPUs and schedules pods normally. What goes wrong?
5. You disable `kernel.sched_rt_runtime_us` (set to -1). All RT tasks on the system hang. Why?

*(Answers: `isolcpus` only prevents the scheduler from *automatically placing* tasks — per-CPU kernel threads (kworkers, softirq daemons) bound to their CPU are configured elsewhere and may still run; bind them explicitly or use `cpuset` exclusion; `nohz_full` suppresses the periodic tick but timers set by the task itself (via `setitimer()`, `timerfd_create()`, or `hrtimer_start()`) still fire — the kernel must handle those; the filesystem code may be using `raw_spin_lock()` (intentionally non-preemptible) for correctness, or the driver may hold a raw lock across a hardware MMIO access that takes 200 µs to complete — not all locks in the kernel are converted even under PREEMPT_RT; kubelet sees 16 allocatable CPUs and schedules pods across all of them, defeating the isolation — use `--reserved-cpus` in kubelet config to exclude isolated CPUs from allocation, and set `--cpu-manager-policy=static`; RT tasks consume 100% of CPU forever — a runaway RT task with priority 99 preempts everything including kernel housekeeping threads, the kworker that handles `echo` to procfs, and even the NMI watchdog, deadlocking the system; the default `sched_rt_runtime_us=950000` reserves 5% of CPU time for non-RT tasks precisely to prevent this.)*

---

**Next:** the kernel doesn't just orchestrate performance — it actively defends against vulnerabilities in the CPU hardware itself. Spectre, Meltdown, L1TF, MDS, and the cascade of speculative execution mitigations that cost every datacenter measurable throughput.
