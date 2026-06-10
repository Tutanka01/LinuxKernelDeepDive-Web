# Power Management: Governors, C-States & ACPI

> **Goal:** understand how the kernel decides when to slow down, sleep, or shut off components — the CPU frequency governors, the idle state hierarchy, suspend-to-RAM and hibernation, and the ACPI machinery that orchestrates it all. Every cloud datacenter and laptop battery depends on this code.

## The three dimensions of power management

Linux power management operates on three orthogonal axes:

| Dimension | What | Knobs |
|---|---|---|
| **Frequency** (P-states) | How fast the CPU runs when active | cpufreq governors, intel_pstate, EPP |
| **Idle states** (C-states) | How deep the CPU sleeps when idle | `/sys/devices/system/cpu/cpuN/cpuidle/` |
| **System states** (S-states) | Suspend (S3), hibernate (S4), power off (S5) | `/sys/power/state`, `/sys/power/mem_sleep` |

They interact: a CPU running at low frequency but never sleeping might use *more* energy than a CPU at full frequency that finishes fast and enters deep sleep. The "race to idle" strategy exploits exactly this.

## CPU frequency scaling: cpufreq vs intel_pstate

The kernel provides a framework (`drivers/cpufreq/`) and per-architecture drivers that control the CPU clock frequency and voltage (DVFS — Dynamic Voltage and Frequency Scaling):

```bash
# What driver are you using?
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# acpi-cpufreq, intel_pstate, intel_cpufreq, amd_pstate, or cppc_cpufreq

# Available frequencies
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_frequencies
# Or: scaling_available_governors

# Current state
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq   # actual frequency (kHz)
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor   # active governor
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq   # hardware max
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq   # hardware min
```

There are two driver architectures:

### Legacy: acpi-cpufreq (firmware-controlled)

The kernel picks a frequency from a fixed table, and the firmware handles the actual voltage/frequency transition. Governors run in the kernel:

| Governor | Behavior |
|---|---|
| **powersave** | Always lowest frequency |
| **performance** | Always highest frequency |
| **ondemand** | Samples load periodically, ramps frequency up/down based on threshold |
| **conservative** | Like ondemand but ramps more gradually |
| **userspace** | User space sets exact frequency via sysfs |
| **schedutil** | Scheduler-driven: picks frequency based on CFS utilization tracking |

### Modern: intel_pstate (hardware-managed, Intel)

Intel's internal power management hardware (HWP — Hardware P-State, available since Skylake) can autonomously select the best P-state based on the Energy Performance Preference (EPP):

```bash
# intel_pstate on modern Intel
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# intel_pstate

# EPP (Energy Performance Preference) — the key knob:
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
# performance, balance_performance, balance_power, power
# Or a raw value 0-255 (0 = max performance, 255 = max power saving)

# Set EPP system-wide
echo balance_performance > /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo balance_performance > $cpu
done

# intel_pstate also has a "passive" mode (intel_cpufreq) where the kernel governor runs
cat /sys/devices/system/cpu/intel_pstate/status
# active: hardware P-state selection with hints
# passive: kernel governor + hardware P-state capability
# off: fall back to acpi-cpufreq
```

The `amd_pstate` driver (AMD Zen 2+, kernel 5.17+) provides similar hardware-managed P-state selection using AMD's CPPC interface.

```bash
# Available EPP profiles on AMD:
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_available_preferences
# Check whether active or guided autonomous selection is supported:
cat /sys/devices/system/cpu/amd_pstate/status
```

### schedutil: the CPU-scheduler-driven governor

`schedutil` (kernel 4.7+, default on many distributions since ~5.10) is unique: it doesn't use a sampling interval. Every time the CFS scheduler updates the per-entity load tracking (PELT), it provides a CPU utilization estimate directly to the frequency governor. The governor then picks:

```
target_freq = max_freq × (util / capacity) × (1.25 headroom)
```

The 1.25× headroom (configurable via `schedutil_up_rate_limit_us`) ensures the CPU has spare capacity for bursts. This is fundamentally better than sampling-based governors: it reacts to load changes within microseconds, not tens of milliseconds.

```bash
# schedutil tuning
cat /sys/devices/system/cpu/cpufreq/schedutil/rate_limit_us    # min time between freq changes
cat /sys/devices/system/cpu/cpufreq/schedutil/up_rate_limit_us  # separate down rate limit

# For latency-sensitive workloads:
echo 200 > /sys/devices/system/cpu/cpufreq/schedutil/up_rate_limit_us
```

## Energy Aware Scheduling (EAS)

On **heterogeneous** ARM SoCs (big.LITTLE and DynamIQ), not all cores have the same power-efficiency curve. A "big" Cortex-X4 core at 1 GHz might be more power-efficient than a "little" Cortex-A520 at 2 GHz for the same task. EAS (merged in 4.12) integrates an energy model into CFS:

```
The scheduler places tasks not just for load balance,
but for minimal total energy consumption.

energy = task_util × cpu_capacity × power_coefficient
```

EAS maintains a per-CPU **energy model** (derived from the device tree or ACPI) that maps frequency to power. When scheduling, CFS evaluates candidate CPUs and picks the one with the lowest predicted energy delta. This is transparent — applications need zero changes.

```bash
# Check if EAS is active
cat /proc/sys/kernel/sched_energy_aware   # 1 = enabled
cat /sys/kernel/debug/energy_model/*/pd*/cs*/cost   # energy costs per OPP
# Only available on CONFIG_ENERGY_MODEL=y kernels
```

## C-states: idle depth

When a CPU has nothing to run, it enters the **idle loop** (PID 0, the "idle task"). On x86, the MWAIT or HLT instruction tells the processor to enter a C-state:

| C-state | Name | Exit latency | Power saving | What sleeps |
|---|---|---|---|---|
| C0 | Active | 0 µs | None | Running |
| C1 | Halt | ~1 µs | Clock gating | Core stops executing |
| C1E | Enhanced Halt | ~2-3 µs | + lower voltage | Core voltage drops |
| C2/C3 | Sleep | ~10-40 µs | + clock stopped | Core clock stops, caches flushed |
| C6 | Deep sleep | ~50-150 µs | + power gate | Core powered off, state saved to SRAM |
| C7+ | Deepest | ~100-500 µs | + package savings | Package-level power gating, L3 may flush |

Each deeper state saves more power but costs more to exit. The kernel's **cpuidle governor** (menu or ladder) decides which state to enter based on the predicted idle duration:

```bash
# Idle state inventory
ls -1 /sys/devices/system/cpu/cpu0/cpuidle/
# state0/  state1/  state2/  state3/  ...

cat /sys/devices/system/cpu/cpu0/cpuidle/state3/name     # actual ACPI C-state
cat /sys/devices/system/cpu/cpu0/cpuidle/state3/usage    # times entered
cat /sys/devices/system/cpu/cpu0/cpuidle/state3/time     # total microseconds spent
cat /sys/devices/system/cpu/cpu0/cpuidle/state3/latency  # exit latency (µs)
cat /sys/devices/system/cpu/cpu0/cpuidle/state3/residency # min duration to be worth it

# Current governor
cat /sys/devices/system/cpu/cpuidle/current_governor     # "menu" or "ladder"
cat /sys/devices/system/cpu/cpuidle/current_driver       # "intel_idle" or "acpi_idle"

# Disable a specific C-state (prevent deep sleep on isolated CPUs)
echo 1 > /sys/devices/system/cpu/cpu8/cpuidle/state2/disable  # disable C3
```

The **menu governor** (default) predicts the next idle duration based on recent history, then picks the deepest state whose `target_residency` is shorter than the prediction. It's conservative: it would rather miss a deep C-state opportunity than induce a latency spike.

```bash
# The intel_idle driver bypasses ACPI entirely on modern Intel
# — it uses a built-in table instead of the ACPI _CST objects
dmesg | grep intel_idle
```

## System sleep states: suspend & hibernate

```bash
cat /sys/power/state
# freeze mem disk
# freeze = suspend-to-idle (S0ix, CPUs idle, platform on)
# mem    = suspend-to-RAM (S3, RAM in self-refresh, almost everything off)
# disk   = hibernate (S4, RAM contents written to swap, full power-off)

# Which suspend modes are actually supported?
cat /sys/power/mem_sleep
# s2idle [deep]   ← shallow = s2idle (S0ix), deep = S3

# Trigger suspend
echo mem > /sys/power/state     # system sleeps until button press or wake event

# Wakeup sources
cat /proc/acpi/wakeup            # devices that can wake the system
echo "LID0" > /proc/acpi/wakeup  # enable lid as wake source
```

### How suspend works (4 phases)

1. **Freeze**: all userspace processes are frozen via freezer cgroup mechanism. Kernel threads that must remain active declare themselves with `set_freezable()`.
2. **Devices suspend**: each driver's `suspend()` callback is called. USB controllers, storage, display, and network go to low-power mode. Drivers must save and restore state.
3. **Non-boot CPUs offline**: all secondary CPUs are taken offline via `cpu_down()`. The boot CPU remains active.
4. **Platform sleep**: ACPI `_S3` or equivalent is invoked. RAM enters self-refresh. Only the power button, wake-on-LAN, and a few GPIOs remain active.

Resume reverses the sequence. The platform wakes → boot CPU restarts → CPUs come online → drivers `resume()` → userspace thawed. The entire operation takes 1-3 seconds on modern NVMe systems.

### Hibernate (suspend-to-disk)

Hibernation writes the *entire* contents of RAM to the swap partition, then powers off completely. On resume, the kernel reads the image back, restores all processes to their exact pre-hibernate state, and continues:

```bash
# Prerequisites: swap partition large enough (≥ RAM size, ideally 1.5×)
swapon --show

# Hibernate
echo disk > /sys/power/state
# Or: systemctl hibernate

# Resume hook in kernel command line (identifies the swap partition):
# resume=/dev/sda2 resume_offset=123456
cat /proc/cmdline | grep resume
```

The hibernation image is compressed (LZO by default, LZ4 available) and written as a contiguous chunk to the swap partition. The kernel marks the image pages with a special signature so the bootloader knows to resume rather than do a clean boot. The `resume=` parameter tells the kernel where to look.

```bash
# Check hibernation image compression algorithm
cat /sys/power/image_size   # target size (0 = auto, usually ~2/5 of RAM)

# Debug hibernation
echo 1 > /sys/power/pm_debug_messages  # verbose kernel logging
journalctl -k | grep -i 'PM:'           # power management messages
```

### Device Runtime PM: fine-grained power gating

Beyond system-wide suspend, individual devices can enter low-power states when idle via the **Runtime PM** framework:

```bash
# Device power state
cat /sys/class/net/eth0/power/runtime_status   # active, suspended, suspending
cat /sys/class/net/eth0/power/control           # on, auto

# Set auto-suspend (kernel suspends device after idle timeout)
echo auto > /sys/class/net/eth0/power/control
```

Drivers implement `runtime_suspend()` and `runtime_resume()` callbacks. A USB controller with no connected devices can power down entirely; a SATA link can enter partial/slumber states; a GPU can clock-gate when no displays are active. This is how modern laptops achieve 10+ hours of battery — hundreds of devices individually power-gated.

## The idling loop: what CPU 0 does when nothing runs

```c
// Simplified: the idle loop (kernel/sched/idle.c)
while (1) {
    // 1. Check if anything needs attention
    if (need_resched()) {
        schedule();   // pick the next task and switch to it
        continue;
    }

    // 2. Pick the best idle state
    struct cpuidle_state *state = cpuidle_select();

    // 3. Enter the idle state (arch-specific)
    cpuidle_enter(state);    // → x86: MWAIT with C-state hint
                             // → ARM: WFI (Wait For Interrupt)

    // 4. CPU wakes up because: interrupt, timer, or NMI
    cpuidle_reflect();       // update prediction model

    // 5. Back to step 1
}
```

The critical insight: the idle task doesn't use CPU time. The scheduler treats it as the lowest-priority entity; it runs only when nothing else is runnable. The moment an interrupt arrives making a task runnable, `need_resched()` returns true and the CPU switches to the real task within microseconds.

## Practical power tuning

```bash
# ─── Server: maximum throughput ───
for c in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $c
done
# Or with intel_pstate:
echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo   # disable turbo for latency
echo performance > /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference

# ─── Laptop: maximize battery ───
echo balance_power > /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference
echo powersave > /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
# Enable deeper C-states:
echo 0 > /sys/devices/system/cpu/cpu*/cpuidle/state*/disable  # ensure C6/C7 enabled

# ─── Mixed: responsive but efficient ───
echo balance_performance > /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference
# Or: schedutil governor with EPP hint
echo schedutil > /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# ─── Monitor power consumption (Intel RAPL) ───
cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj  # total package energy (µJ)
# Read twice, divide delta by time in seconds = average power in microwatts
```

## The ACPI subsystem

ACPI (Advanced Configuration and Power Interface) is the firmware interface that exposes the platform's power capabilities. The kernel's ACPI driver (`drivers/acpi/`) interprets AML (ACPI Machine Language) bytecode from firmware tables:

```bash
# ACPI tables in raw form
ls /sys/firmware/acpi/tables/
cat /sys/firmware/acpi/tables/DSDT > /tmp/dsdt.dat   # DSDT = core platform definition
iasl -d /tmp/dsdt.dat                                 # disassemble to read

# ACPI event handling
acpi_listen   # listen for ACPI events (lid close, power button, battery threshold)
# Capture events:
# lid close → kernel sends LID event → systemd-logind handles it → lock screen or suspend
```

The kernel's ACPI interpreter is a full AML virtual machine — not a simple table parser. It executes AML methods provided by the firmware to:
- Evaluate `_PSS` (P-state table), `_CST` (C-state table), `_SxD` (sleep state requirements)
- Handle thermal zones (`_TMP`, `_PSV`, `_ACx` methods)
- Notify the OS of platform events (AC adapter, battery, thermal trip)

```bash
# Thermal zones
cat /sys/class/thermal/thermal_zone0/temp           # temperature in millidegrees C
cat /sys/class/thermal/thermal_zone0/type           # "x86_pkg_temp" or "acpitz"
cat /sys/class/thermal/cooling_device*/type         # fan, processor, etc.
cat /sys/class/thermal/cooling_device*/cur_state    # active cooling state
```

## Energy efficiency in cloud datacenters

Cloud providers care about power per request, not per machine. Key strategies:

1. **C-state aware scheduling**: group low-utilization VMs on fewer sockets, let the others enter deep C-states
2. **Frequency capping**: cap frequency at 80-90% of max — the final 10% costs disproportionate power for marginal throughput gain (the voltage-frequency curve is superlinear)
3. **SMT-aware placement**: avoid placing latency-sensitive threads on sibling hardware threads; they compete for execution resources and waste power on contention
4. **P-state capping per VM**: via KVM guest P-state visibility, the host can limit guest CPU without the guest knowing

```bash
# Cap the maximum frequency
echo 2800000 > /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq
# 2.8 GHz max, even if hardware supports 3.5 GHz
```

## Try it yourself

```bash
# Profile your power states
turbostat --quiet --show PkgWatt,CorWatt,GFXWatt,PkgTmp,C1,C6,Bzy_MHz -i 1
# From linux-tools-common (or linux-tools-generic) package

# Measure idle state residency
cpupower idle-info    # all C-states and their attributes
cpupower monitor      # live C-state and P-state residency

# Simulate battery behavior on a server
powertop --calibrate  # runtime ~5 min, identifies tuning opportunities
powertop --auto-tune  # apply all power-saving tunables

# Test suspend (VM-safe)
ls /sys/power/state
echo freeze > /sys/power/state  # modern suspend-to-idle, no firmware dependency

# Watch for "wakeup" events
cat /proc/acpi/wakeup
echo enabled > /sys/class/net/eth0/device/power/wakeup  # allow WoL

# Check power capping (RAPL on Intel, similar on AMD)
cat /sys/class/powercap/intel-rapl\:0/constraint_0_power_limit_uw
cat /sys/class/powercap/intel-rapl\:0/constraint_0_time_window_us
```

## Check your understanding

1. The `performance` governor locks the CPU at maximum frequency. Why might this hurt actual performance on a thermal-constrained laptop?
2. A CPU enters C6 sleep. An interrupt for a time-sensitive task arrives. How long until the task runs?
3. You suspend-to-RAM, close the lid, put the laptop in a bag. The bag gets hot. What happened?
4. Why does hibernation write to swap even if swap is on an SSD, and why can this be slow?
5. schedutil integrates with the scheduler. What specific number does it use as its "load" signal, and why is that better than ondemand's sampling?

*(Answers: thermal throttling kicks in — the CPU hits its thermal limit (~100°C), the hardware clamps frequency far below what the governor requested, and the stop-start throttle cycles add jitter; the exit latency for C6 is 50-150 µs (readable at `/sys/.../cpuidle/stateX/latency`) — the CPU must power up the core, restore state from SRAM, reinitialize caches, and re-enable interrupts before the ISR runs, so worst case is ~150 µs; the system woke up inside the bag — a spurious wake event (lid sensor jitter, USB device, wifi firmware) triggered resume, the kernel failed to suspend again (no user interaction to re-trigger), and the CPU ran at full power with zero ventilation; hibernation writes all used RAM pages — typically 5-30 GB even on fast NVMe, and the I/O is sequential but must be synchronous (kernel can't resume halfway through an image write); schedutil uses the PELT (Per-Entity Load Tracking) utilization which is a time-decayed average with ~32ms half-life, updated at every scheduling event, giving sub-millisecond reaction to load changes — ondemand polls every 10-40ms and can't see a burst that begins and ends between samples.)*

---

**Next:** you've seen how the kernel manages power across one physical package. Now we look at what happens when you have *multiple* packages — NUMA architecture, where every memory access has a price tag that depends on which CPU is asking and which DIMM holds the answer.
