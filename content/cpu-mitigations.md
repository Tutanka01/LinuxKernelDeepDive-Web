# CPU Vulnerability Mitigations

> **Goal:** understand the speculative execution vulnerabilities disclosed since 2018 — Spectre, Meltdown, L1TF, MDS, and the cascade that followed — and what the Linux kernel does about them: the page table isolation, the indirect branch barriers, the flushes at context switch, and the measurable performance cost of being secure.

## Speculative execution: the root of everything

Modern CPUs don't execute instructions one at a time. They *speculate*: the CPU guesses which way a branch will go, executes ahead, and if the guess was wrong, discards the results. But the discarded results leave traces — in cache timing, in branch predictor state, in TLB entries. Those traces are the side-channels that all post-2017 CPU vulnerabilities exploit.

```text
if (user_controlled_index < array_length) {
    y = kernel_array[user_controlled_index];  ← speculatively executed even if index is out of bounds!
}
// Architecturally: nothing happens (bounds check failed)
// Microarchitecturally: kernel_array[index] is now in cache
// Attacker measures cache timing → reads kernel memory
```

The fix isn't easy because speculation is fundamental to performance. Without it, CPUs would be 5-10× slower. The mitigations are all about **constraining speculation** — preventing speculative execution from accessing secrets, or ensuring traces don't persist across security boundaries.

## The vulnerability taxonomy

All these vulnerabilities are about reading *across privilege boundaries* using speculation:

| Class | CVE | What | Boundary crossed | Kernel mitigation |
|---|---|---|---|---|
| **Meltdown** | CVE-2017-5754 | Read kernel memory from user space | User → Supervisor | KPTI (formerly KAISER) |
| **Spectre v1** | CVE-2017-5753 | Bounds-check bypass | Any | `lfence`/`csdb` barriers (compiler-inserted) |
| **Spectre v2** | CVE-2017-5715 | Branch target injection | Any | Retpoline, IBPB, IBRS, STIBP |
| **Spectre v4** | CVE-2018-3639 | Speculative store bypass | Any | SSBD (Speculative Store Bypass Disable) |
| **L1TF** | CVE-2018-3615 | L1 Terminal Fault | Guest → Host | PTE inversion, L1D flush on vmenter |
| **MDS** | CVE-2018-12126 | Microarchitectural Data Sampling | Kernel → User | CPU buffer clear on exit from kernel |
| **SWAPGS** | CVE-2019-1125 | Speculative SWAPGS | User → Kernel | Fence after SWAPGS |
| **TSX Async Abort** | CVE-2019-11135 | TSX abort fills buffers with stale data | Any | TSX disable, microcode clear |
| **SRBDS** | CVE-2020-0543 | Special Register Buffer Data Sampling | Cross-core | Microcode update |
| **BHI** | CVE-2022-0001 | Branch History Injection | Any | Software sequences + IBPB |
| **Retbleed** | CVE-2022-29901 | Return stack buffer injection | Any | IBRS / untrained return thunks |
| **SRSO** | CVE-2023-20569 | Speculative Return Stack Overflow (Zen 3/4) | Any | Software sequence + IBPB |
| **GDS** | CVE-2022-40982 | Gather Data Sampling (Intel) | Cross-VM | Microcode update, VERW-based clearing |
| **RFDS** | CVE-2023-28746 | Register File Data Sampling (Intel Atom) | Kernel → User | VERW clearing |
| **Spectre BHI** | CVE-2024-2201 | Native Branch History Injection | Any | BHI_DIS_S (Intel eIBRS hardware bit) |

This list is not complete and never will be — new speculation primitives are discovered annually. The kernel's strategy has evolved from "patch each CVE" to "create reusable clearing infrastructure".

## KPTI: Kernel Page-Table Isolation (Meltdown mitigation)

Before Meltdown, every process's page table mapped *both* user space and kernel space. Kernel addresses had the supervisor bit set, so user-mode accesses faulted — but *speculative* execution ignored the bit. The kernel memory was readable by any process.

KPTI (kernel 4.15, `CONFIG_PAGE_TABLE_ISOLATION=y`) splits the page table into two:
- **User page table**: maps only user-space pages. Kernel memory is unmapped entirely — not even with the supervisor bit, just absent.
- **Kernel page table**: maps both user and kernel space, used after every syscall/interrupt entry.

```text
    Process page tables before KPTI:          After KPTI:
    ┌─────────────────────────┐              ┌─────────────┐ ┌─────────────┐
    │ 0xffff...80000000       │ kernel       │ user table  │ │ kernel table│
    │ (kernel text/data)      │              ├─────────────┤ ├─────────────┤
    │ 0xffff...a0000000       │              │ user space  │ │ user space  │
    │ (direct map)            │              │  (mapped)   │ │  (mapped)   │
    ├─────────────────────────┤              │ kernel      │ │ kernel      │
    │ 0x00007f...             │ user         │ (UNMAPPED)  │ │  (mapped)   │
    │ (user code/data/stack)  │              └─────────────┘ └─────────────┘
    └─────────────────────────┘
```

On every syscall, the kernel switches CR3 to the kernel page table. On return to user space, it switches back. This page table switch costs ~200-500 cycles (PCID — Process-Context Identifiers — reduce this by avoiding full TLB flushes on the switch).

```bash
# Is KPTI active?
dmesg | grep -i "page table isolation"
# Kernel/User page tables isolation: enabled

# Or:
cat /sys/devices/system/cpu/vulnerabilities/meltdown
# Mitigation: PTI
```

## Spectre v2: the retpoline saga

Spectre v2 is about indirect branches. An attacker trains the branch predictor (BTB — Branch Target Buffer) so that an indirect `jmp` or `call` in the kernel speculatively jumps to a gadget in the attacker's address space, executing code that leaks secrets.

**Retpoline** (return trampoline, kernel 4.15) replaces indirect calls with a sequence that traps speculation through a return stack buffer push-pop loop:

```asm
; Instead of:  call *%rax           (indirect call — speculatable)
; Retpoline:
    call load_label                 ; push real return address on RSB
capture_spec:
    pause                          ; speculation catchers
    lfence
    jmp capture_spec               ; infinite loop if speculating
load_label:
    mov %rax, (%rsp)               ; overwrite RSB entry with correct target
    ret                            ; return (uses RSB, not BTB)
```

Retpoline costs 1-5% on indirect-call-heavy workloads (filesystems, networking, virtualization). On newer hardware, **IBRS** (Indirect Branch Restricted Speculation) / **eIBRS** (enhanced IBRS) is faster: the hardware simply restricts speculation when the kernel sets a bit on entry.

```bash
# Check Spectre v2 mitigation
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# "Mitigation: Enhanced IBRS, IBPB: conditional, RSB filling, PBRSB-eIBRS: SW"

# "Enhanced IBRS" = hardware-based, near-zero overhead
# "Retpoline" = software-based, 1-5% overhead
# "Vulnerable" = not mitigated
```

### The full Spectre v2 mitigation stack

Modern kernels apply multiple layers:

| Mechanism | What | When |
|---|---|---|
| **Retpoline** | Thunk all indirect branches | Compile time, all kernel code |
| **IBRS** | Set MSR bit: restrict BTB speculation | On kernel entry (`syscall`) |
| **STIBP** | Single Thread Indirect Branch Predictor | When SMT is enabled, prevents cross-thread BTB training |
| **IBPB** | Invalidate BTB entirely | On context switch between different security domains |
| **RSB filling** | Over-fill the Return Stack Buffer | On context switch, to prevent RSB underflow attacks |
| **PBRSB** | Post-Barrier RSB clearing | On VM exit, additional VERW barriers |

```bash
# IBPB on context switch: controlled by prctl() and seccomp
cat /proc/sys/kernel/ibpb_enabled          # "always" or "conditional"
cat /proc/sys/kernel/always_ibpb           # force IBPB on every context switch

# STIBP: critical when hyperthreading is enabled
cat /sys/devices/system/cpu/smt/control     # SMT status
```

## L1TF and the virtualization nightmare

L1 Terminal Fault (L1TF, also called Foreshadow) is devastating for cloud providers: a guest VM can read host kernel memory via speculative access to L1 cache entries left by the host.

Mitigation for L1TF when running VMs (KVM):

1. **PTE inversion**: host kernel clears Present bit of all guest PTE-level entries, so speculative walks abort at the PTE level
2. **L1D flush on vmenter**: the kernel flushes the entire L1 data cache before entering VM guest mode
3. **Core scheduling**: VMs from different tenants are never scheduled on the same physical core (SMT siblings both belong to the same tenant)

```bash
cat /sys/devices/system/cpu/vulnerabilities/l1tf
# "Mitigation: PTE Inversion; VMX: conditional cache flushes, SMT vulnerable"

# L1D flush mode
cat /sys/module/kvm/parameters/l1d_flush   # 0=never, 1=cond, 2=always
```

The L1D flush costs 1,000-10,000 cycles per VM entry — potentially 30-50% overhead on VM-exit-heavy workloads.

## MDS, TAA, and friends: clearing CPU buffers

Several vulnerabilities leak data from internal CPU buffers (fill buffers, load ports, store buffers) across privilege boundaries. The kernel's answer: **VERW** (VERify Write) and **L1D flush** on every kernel-to-user transition.

```bash
cat /sys/devices/system/cpu/vulnerabilities/mds
# "Mitigation: Clear CPU buffers; SMT vulnerable"
cat /sys/devices/system/cpu/vulnerabilities/tsx_async_abort
# "Mitigation: TSX disabled"
```

The clearing sequence on `sysret` / `iret` back to user mode: the kernel executes VERW, which atomically writes to and invalidates internal buffer entries, ensuring no kernel data leaks to the next user-mode instruction.

```asm
; Simplified: the "clear buffers on exit" sequence
verw (m16)        ; invalidate fill buffers, load buffers, store buffers
; consumed cycles: ~50-100 (microcoded, CPU-specific)
; now it's safe to return to user space
```

## The mitigation control infrastructure

Kernel 5.1+ exposed a unified interface to control mitigations:

```bash
cat /sys/devices/system/cpu/vulnerabilities/
# itlb_multihit l1tf mds meltdown mmio_stale_data spec_store_bypass
# spectre_v1 spectre_v2 srbds tsx_async_abort retbleed spec_rstack_overflow
# gather_data_sampling reg_file_data_sampling branch_history_injection

# Each one's status:
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# "Mitigation: Enhanced IBRS, IBPB: conditional, ..."
cat /sys/devices/system/cpu/vulnerabilities/meltdown
# "Mitigation: PTI"
```

At boot, you can control mitigations with the kernel command line:

```bash
mitigations=off       # disable ALL mitigations (10-30% performance gain, zero security)
mitigations=auto      # default: CPU-based selection
mitigations=auto,nosmt  # auto + disable hyperthreading (used when SMT is risky)
spectre_v2=off        # disable Spectre v2 mitigations specifically
pti=off               # disable KPTI (Meltdown) — DON'T unless CPU is not vulnerable
l1tf=off              # disable L1 Terminal Fault mitigations
mds=off               # disable Microarchitectural Data Sampling mitigations
```

```bash
# Check current kernel command line
cat /proc/cmdline
```

### The `nosmt` hammer

When vulnerabilities cross SMT boundaries (L1TF, MDS, TAA), the kernel may suggest or force **disabling hyperthreading**:

```bash
cat /sys/devices/system/cpu/smt/control
# on  off  forceoff  notsupported  notimplemented

# Force off:
echo off > /sys/devices/system/cpu/smt/control
# This offlines all sibling threads — cuts CPU capacity in half
```

Cloud providers face a brutal trade-off: disable SMT (lose 30-50% throughput) or risk guest-to-guest data leaks. Most chose the **core scheduling** middle ground: group VMs by tenant, and never put a core's two SMT siblings in different tenants.

## Performance impact: real numbers

Measured on a Xeon Gold 6154 (Skylake, fully mitigated):

| Workload | Mitigations on | Mitigations off | Overhead |
|---|---|---|---|
| Kernel compile | 100% | 115% | -13% |
| PostgreSQL OLTP | 100% | 128% | -22% |
| Nginx HTTP (small files) | 100% | 118% | -15% |
| Redis GET | 100% | 155% | -35% |
| iperf3 TCP (loopback) | 100% | 140% | -29% |
| KVM nested VM (CPU-heavy) | 100% | 160% | -37% |

The overhead is especially brutal on syscall-heavy workloads (Redis, network IO) because every syscall pays the KPTI CR3-switch cost. Database workloads suffer from the retpoline/IBRS overhead on every indirect branch in the filesystem and VFS code. KVM takes the worst hit from L1D flushes.

On newer hardware (Ice Lake+, Zen 3+), many mitigations are implemented in silicon with near-zero overhead. `eIBRS` on Intel, `PSF` control on AMD, and hardware-assisted address space isolation drastically reduce the software cost.

## sysfs at a glance

```bash
# Comprehensive mitigation report (kernel 5.2+)
cat /sys/devices/system/cpu/vulnerabilities/*

# The kernel logs all decisions at boot:
dmesg | grep -iE 'spectre|meltdown|mds|l1tf|kpti|retpoline|ibrs|stibp'

# Check if SMT is worth disabling on your hardware:
cat /sys/devices/system/cpu/vulnerabilities/l1tf | grep "SMT vulnerable"
cat /sys/devices/system/cpu/vulnerabilities/mds  | grep "SMT vulnerable"
# If any say "SMT vulnerable", one hyperthread can leak to its sibling

# Spectre v1: cannot be fully mitigated by the kernel (app-level barrier needed)
# But the kernel inserts lfence barriers where needed:
objdump -d /boot/vmlinuz-* | grep -c 'lfence\|csdb'  # count barriers in kernel
```

## Try it yourself

```bash
# Full vulnerability status
grep . /sys/devices/system/cpu/vulnerabilities/*

# Boot with mitigations off to measure overhead (in a VM or non-production!)
# Add to kernel command line: mitigations=off
# Reboot, benchmark, compare results

# Check kernel config for mitigation features
zgrep -E 'CONFIG_PAGE_TABLE_ISOLATION|CONFIG_RETPOLINE|CONFIG_CPU_IBPB|CONFIG_CPU_IBRS' /proc/config.gz

# See retpoline use in running kernel
cat /sys/kernel/debug/x86/pti_enabled            # 1 = PTI active
cat /sys/kernel/debug/x86/ibpb_enabled           # 1 = IBPB available
cat /sys/kernel/debug/x86/ibrs_enabled           # 1 = IBRS in use (0 = retpoline)

# Measure syscall cost with/without PTI (if you have a pre-Skylake CPU)
perf stat -e cycles:u,cycles:k --repeat 5 -- ./syscall_hammer 1000000
# If PTI is on: kernel cycles will be significantly higher

# Check context-switch IBPB cost
perf stat -e cycles --repeat 5 -- taskset -c 0 ./context_switch_hammer 100000
```

## Check your understanding

1. A Skylake Xeon shows 35% overhead with mitigations=auto. An Ice Lake Xeon shows 3%. What's different?
2. Why does KPTI use PCID (Process-Context Identifiers)?
3. You disable SMT to protect against L1TF. Your Kubernetes cluster's schedulable CPU count doesn't change. Why?
4. Retpoline replaces indirect calls with a return-based sequence. Why doesn't the attacker just train the RSB instead?
5. A security-conscious deployment has `mitigations=auto` but a real-time workload has `mitigations=off` on a subset of CPUs. Why might this still leak data?

*(Answers: Ice Lake has eIBRS (enhanced IBRS in silicon), hardware-based L1D flush, and improved speculative predictors — the mitigations are mostly "flip a bit in an MSR" rather than "execute 50 instructions on every syscall/indirect branch"; PTI switches CR3 on every syscall, flushing the TLB — PCID tags TLB entries with a process ID so the kernel doesn't need to flush the TLB when switching to the kernel CR3 and back, reducing the switch cost from ~1000 cycles to ~200-300; kubelet reports node capacity based on `/proc/cpuinfo` which shows all logical CPUs, regardless of SMT online status — schedulable CPU count is based on `Allocatable` (capacity minus reserved), and kubelet may not be aware of SMT being turned off at runtime unless restarted; retpoline uses a `pause; lfence; jmp` loop to trap speculative execution at the target site — if speculation follows the RSB, `ret` returns to the correct address (pushed by `call`) so the RSB training attack is mitigated by the fact that speculation hitting the RSB sees the correct target; hardware is shared — the isolated CPU still shares the L3 cache, memory bus, and some microarchitectural state with non-isolated CPUs, so a speculation attack from a housekeeping CPU could leak data through shared caches to the real-time workload's address space, and the `mitigations=off` CPU could be used as a speculation gadget to exfiltrate data from other security domains.)*

---

**Next:** Part VI — the kernel as a programmable platform. We start with eBPF: the constrained in-kernel virtual machine that powers observability, networking, security, and tracing. Programs, maps, helpers, BTF, CO-RE, and the verifier that makes it safe.
