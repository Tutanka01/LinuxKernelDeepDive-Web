# KVM & Virtualization Internals

> **Goal:** understand how the Linux kernel itself becomes a hypervisor — the KVM module, the vCPU execution loop, the VM exit handling, the memory virtualization via EPT/NPT, and the virtio paravirtualized device model that makes cloud computing possible.

## The hypervisor taxonomy

Virtualization splits the world in two:

| Type | What | Examples |
|---|---|---|
| **Type 1** | Hypervisor runs on bare metal, VMs on top | VMware ESXi, Xen, Hyper-V |
| **Type 2** | Hypervisor is a process on a host OS, VMs are processes | VirtualBox, QEMU without KVM |

Linux+KVM is **both**: KVM (Kernel-based Virtual Machine) is a kernel module that turns Linux into a Type 1 hypervisor. Each VM is a regular Linux process (visible in `ps`), but inside that process, the CPU runs in **guest mode** — a hardware-enforced execution environment where the guest OS believes it owns the machine.

```bash
# A running VM is a process like any other
ps aux | grep qemu
# user  12345  120.0  50.0  ... qemu-system-x86_64 -enable-kvm -m 4096 ...
ls /proc/12345/fd/     # KVM file descriptors, memory mappings
```

## The three components

1. **KVM** (`/dev/kvm`): the kernel module that exposes hardware virtualization extensions (Intel VT-x, AMD-V) as a character device
2. **QEMU**: userspace that emulates devices (NIC, disk, display) and orchestrates vCPU threads
3. **Guest code**: the unmodified kernel running inside the VM

```text
     ┌─────────────────────────────────────────────┐
     │              Guest VM process                 │
     │  ┌─────────────────────────────────────────┐ │
     │  │            QEMU thread                   │ │
     │  │  • emulates devices (disk, NIC, GPU)    │ │
     │  │  • handles I/O from guest               │ │
     │  │  • uses KVM ioctls to create/manage VM  │ │
     │  └─────────────────────────────────────────┘ │
     │  ┌───────────────┐ ┌───────────────┐         │
     │  │  vCPU thread  │ │  vCPU thread  │  ...    │
     │  │  runs guest   │ │  runs guest   │         │
     │  │  code natively│ │  code natively│         │
     │  └───────┬───────┘ └───────┬───────┘         │
     └──────────┼─────────────────┼─────────────────┘
                │                 │
     ┌──────────┴─────────────────┴─────────────────┐
     │              /dev/kvm (KVM kernel module)    │
     │  • VM entry/exit via VMX/SVM instructions    │
     │  • EPT/NPT (nested page tables)              │
     │  • vCPU state save/restore                   │
     └──────────────────────────────────────────────┘
                │
     ┌──────────┴──────────────────────────────────┐
     │              CPU Hardware (VT-x / AMD-V)    │
     │  • VMXON / VMXOFF                           │
     │  • VMLAUNCH / VMRESUME                      │
     │  • VM exit conditions                       │
     │  • EPT (Extended Page Tables)               │
     └──────────────────────────────────────────────┘
```

## The KVM API

KVM exposes itself as a character device. Userspace creates VMs and vCPUs through file descriptors:

```c
// Conceptual — real code uses the ioctls below
kvm_fd = open("/dev/kvm", O_RDWR);              // 1. connect to KVM
vm_fd  = ioctl(kvm_fd, KVM_CREATE_VM, 0);       // 2. create a VM
// Allocate guest physical memory:
mem = mmap(NULL, mem_size, ..., vm_fd, 0);       // 3. map guest memory
vcpu_fd = ioctl(vm_fd, KVM_CREATE_VCPU, 0);     // 4. create vCPU 0
// Set up vCPU registers (RIP, CR0, CR3, CR4, RAX...) for guest boot
struct kvm_regs regs = { .rip = 0xfffffff0, ... };
ioctl(vcpu_fd, KVM_SET_REGS, &regs);
// Now the loop:
while (running) {
    ioctl(vcpu_fd, KVM_RUN, 0);                  // 5. enter guest, run until exit
    struct kvm_run *run = mmap'd_region;          // exit reason
    switch (run->exit_reason) {
    case KVM_EXIT_IO:          handle_pio(); break;   // in/out instruction
    case KVM_EXIT_MMIO:        handle_mmio(); break;  // memory-mapped I/O
    case KVM_EXIT_HLT:         handle_halt(); break;  // guest did HLT
    case KVM_EXIT_SHUTDOWN:    running = false; break;
    }
}
```

Key insight: the vCPU thread alternates between **guest mode** (running native guest code at full CPU speed) and **KVM mode** (kernel handles the exit, possibly involving userspace).

```bash
# See KVM API usage in a running VM
strace -p $(pgrep -f qemu) 2>&1 | grep -E 'ioctl\([0-9]+, KVM'
# KVM_RUN, KVM_SET_REGS, KVM_GET_VCPU_MMAP_SIZE, ...
```

## The VM exit: the heart of virtualization

Hardware virtualization (VT-x, AMD-V) works by having the CPU run guest code directly on the physical core — **most instructions execute at native speed**. The hardware intervenes only when the guest does something it can't handle alone:

| Trigger | Exit reason | Handled by |
|---|---|---|
| Guest executes HLT | `KVM_EXIT_HLT` | KVM: schedule another vCPU or idle |
| Guest does `inb $0x64` (keyboard port) | `KVM_EXIT_IO` | Userspace: QEMU emulates the port read |
| Guest writes to PCI config space | `KVM_EXIT_MMIO` | Userspace: QEMU emulates PCI config change |
| Guest accesses a page not in EPT | `KVM_EXIT_MMIO` | KVM: page fault, handle or forward to guest |
| Guest writes to CR3 (page table base) | VM exit (CR3 access) | KVM: update shadow page tables |
| Guest executes CPUID | VM exit (CPUID) | KVM: return filtered/hypervisor CPUID values |
| Guest accesses MSR (model-specific register) | VM exit (MSR) | KVM: intercept and emulate specific MSRs |
| Guest executes VMCALL | `KVM_EXIT_HYPERCALL` | KVM: handle hypercall |
| Guest timer interrupt | VM exit (APIC) | KVM: inject virtual interrupt |
| External interrupt arrives for host | VM exit (external) | Host kernel: handle interrupt, resume guest later |

The VM exit cost on modern hardware is 200-500 cycles — far cheaper than a context switch (which many mistakenly compare it to), but still a performance consideration. An exit-heavy workload (disk benchmark, packet flood) can spend >30% of CPU time in exits.

```bash
# VM exit statistics
perf stat -e 'kvm:kvm_exit,kvm:kvm_entry' -a -p $(pgrep qemu) sleep 5
# Compare kvm_exit count to kvm_entry: should be identical

# Detailed exit reasons (requires debugfs)
cat /sys/kernel/debug/kvm/exits          # per-VM exit reason counts
# Or use:
perf kvm stat live                      # live KVM event analysis
```

## EPT/NPT: nested page tables

The hardest part of memory virtualization is the translation:

```text
    Guest process:   virtual address → guest physical address  (guest page tables)
    Hypervisor:      guest physical address → host physical address  (EPT/NPT)

    Combined:        GVA → GPA (guest does this natively)
                     GPA → HPA (hardware EPT walk)
```

Intel EPT (Extended Page Tables) and AMD NPT (Nested Page Tables) let the hardware do both translations in a single walk, triggered by the guest's page table. The host sets up EPT tables that map guest-physical to host-physical, and the hardware handles the rest at full speed.

Without EPT/NPT, KVM must **shadow page table** — maintain a copy of the guest's page tables with GPA→HPA translations baked in, and intercept every CR3 write and INVLPG. EPT eliminates this overhead entirely.

```bash
# Check if EPT/NPT is available
cat /sys/module/kvm_intel/parameters/ept      # Intel
cat /sys/module/kvm_amd/parameters/npt        # AMD

# EPT violation: guest accessed a GPA not in EPT → KVM handles it
perf stat -e 'kvm:kvm_page_fault' -a sleep 5
```

EPT also enables core memory overcommit features: **KSM** (Kernel Same-page Merging) deduplicates identical VM pages, and **KSMBD** (since 5.15) does the same as an in-kernel thread. Cloud providers use this to pack 2-3× more VMs on the same hardware.

```bash
cat /sys/kernel/mm/ksm/pages_shared       # pages KSM merged
cat /sys/kernel/mm/ksm/pages_sharing      # pages saved through merging
```

## Virtio: the paravirtualized I/O standard

Emulating real hardware is slow. Every guest outb/outl to a simulated UART triggers a VM exit → userspace → QEMU emulates → return. For storage and networking, this kills performance.

**Virtio** (`CONFIG_VIRTIO`, `drivers/virtio/`) is the answer: the guest kernel includes paravirtualized drivers that know they're running on KVM. They use shared memory rings (virtqueues) instead of MMIO/PIO for data transfer:

```text
    Guest: virtio-blk driver
      │   (writes request descriptor + buffers to virtqueue)
      ↓
    Host: vhost-user or QEMU virtio-backend
      │   (reads descriptors, processes I/O, posts completions)
      ↓
    Host kernel: actual disk I/O via normal kernel path
```

Key virtio devices:

| Device | Guest driver | Host backend | What it does |
|---|---|---|---|
| virtio-blk | `virtio_blk` | QEMU, vhost-user-blk | Block device → VM sees `/dev/vda` |
| virtio-net | `virtio_net` | QEMU, vhost-net, vhost-vdpa | Network → VM sees `eth0` |
| virtio-scsi | `virtio_scsi` | QEMU, vhost-scsi | SCSI controller for many disks |
| virtio-balloon | `virtio_balloon` | KVM, QEMU | Host reclaims unused guest memory |
| virtio-rng | `virtio_rng` | QEMU | Guest gets host's random numbers |
| virtio-console | `virtio_console` | QEMU | Serial console; multiplexed data channels |
| virtio-fs | `virtio_fs` | virtiofsd | Filesystem passthrough (shared dirs) |
| virtio-gpu | `virtio_gpu` | QEMU, vhost-user-gpu | 3D acceleration in VM |
| virtio-vsock | `vmw_vsock_virtio` | QEMU, vhost-vsock | Socket-based host↔guest communication |

### How virtqueues work

A virtqueue is a ring buffer shared between the guest driver and the host device:

```text
    Descriptor Table          Available Ring          Used Ring
    ┌───┬────┬────┬──┐    ┌───┬───┬───┬───┐       ┌───┬───┬───┬───┐
    │ 0 │addr│len │fl│    │ 0 │idx│...│   │       │ 0 │idx│...│   │
    │ 1 │addr│len │fl│    │   │   │   │   │       │   │   │   │   │
    │...│    │    │  │    └───┴───┴───┴───┘       └───┴───┴───┴───┘
    └───┴────┴────┴──┘
    Guest fills descriptors    Guest adds to avail    Host adds to used
    (addr = GPA of buffer)     (notifies host)       (signals guest)
```

Three rings, not two — a subtle design choice that avoids the ABA problem and allows zero-copy data paths.

### vhost acceleration

Moving virtqueue processing from QEMU to the kernel (vhost) eliminates the QEMU→kernel context switches:

```bash
# vhost-net: kernel processes virtio-net packets directly
ps aux | grep vhost
# /usr/bin/qemu-system-x86_64 ... -netdev tap,vhost=on ...

# vhost-user: virtqueues handled by a separate userspace process (e.g., DPDK)
# Used by Open vSwitch and SPDK for extreme performance
```

The hierarchy: virtio driver ↔ virtqueue ↔ vhost kernel thread ↔ tun/tap or socket ↔ host network stack. For the highest performance, **vhost-vdpa** connects virtqueues directly to hardware virtual data path accelerators (e.g., SmartNICs).

## vCPU scheduling and the steal time problem

KVM vCPUs are regular host threads, scheduled by CFS like any `qemu-system-x86_64` process. The host scheduler has no concept of "this thread runs a guest kernel." This causes a problem:

```text
   Guest's clock keeps ticking while vCPU is descheduled
   Guest measures "the kernel took X µs" but the vCPU wasn't actually running
   Solution: steal time accounting
```

KVM exports **steal time** to the guest via a dedicated per-vCPU page (updated by KVM on every vCPU sleep/wake). The guest kernel accumulates this as `st` in `/proc/stat`:

```bash
# Inside the VM
grep -E 'cpu |steal' /proc/stat
# cpu  123456 789 123456 123456789 456 0 0 56789 0 0
#       user nice system   idle     iowait irq softirq steal guest guest_nice
#                                                     ↑
# "steal" = time the vCPU wanted to run but was descheduled by the host
```

```bash
# On the host: why is steal high?
# Overcommitted CPUs → host scheduler struggles
# VMs pinned to same physical core → contention
# NUMA imbalance → vCPU can't migrate with its memory
```

### Pinning and RT scheduling for VMs

For latency-sensitive VMs (telco, trading), vCPUs are pinned to specific host CPUs with real-time scheduling:

```bash
# Pin vCPUs 0-3 to host CPUs 8-11
virsh vcpupin myvm 0 8
virsh vcpupin myvm 1 9
virsh vcpupin myvm 2 10
virsh vcpupin myvm 3 11

# Pin the emulator and I/O threads separately
virsh emulatorpin myvm 0-7    # emulator on housekeeping CPUs
virsh iothreadpin myvm 0 0-7  # I/O threads on housekeeping CPUs

# Give vCPU threads real-time scheduling
virsh schedinfo myvm --set vcpu_period=100000 --set vcpu_quota=95000
# Or via chrt on the qemu process threads
```

## Try it yourself

```bash
# Create a minimal VM with /dev/kvm directly (no libvirt)
# Check KVM support
egrep -c '(vmx|svm)' /proc/cpuinfo   # >0 means hardware virtualization available
lsmod | grep kvm

# Run QEMU with KVM acceleration
qemu-system-x86_64 \
    -enable-kvm \
    -cpu host \
    -m 2048 \
    -smp 2 \
    -drive file=disk.qcow2,if=virtio \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0

# KVM tracepoints (debugfs)
ls /sys/kernel/debug/tracing/events/kvm/
echo 1 > /sys/kernel/debug/tracing/events/kvm/kvm_exit/enable
cat /sys/kernel/debug/tracing/trace_pipe | head -30

# VM exit profiling
perf kvm stat record -p $(pgrep qemu) sleep 10
perf kvm stat report

# Check nested virtualization (running VMs inside VMs)
cat /sys/module/kvm_intel/parameters/nested     # Y = available
cat /sys/module/kvm_amd/parameters/nested       # Y = available
```

## Check your understanding

1. A vCPU thread spends 80% of CPU time in `KVM_RUN` ioctl and 20% handling exits. Which exit types dominate if the VM is running a network-heavy workload?
2. EPT eliminates the need for KVM to intercept guest page table modifications. What still causes EPT violations?
3. A cloud VM shows 15% steal time. The host has 2× CPU overcommit. Is this expected, and what reduces steal?
4. virtio-blk uses shared memory rings instead of emulated AHCI registers. What is the performance-critical benefit?
5. KVM exports CPUID to the guest. Why does it *filter* the CPUID leaves rather than pass them through?

*(Answers: EPT violations (memory access outside established EPT mappings) and KVM_EXIT_IO (network device register access) dominate, along with external interrupt exits when NIC interrupts arrive for the host while in guest mode; EPT violations occur when the guest accesses a GPA not yet mapped by the host — e.g., newly allocated guest pages (lazy EPT mapping), swapped host pages (EPT entry invalidated), or the guest touching memory-mapped device regions; 15% steal with 2× overcommit is actually decent — CFS does well — reducing overcommit, pinning vCPUs without oversubscribing physical cores, enabling NO_HZ_FULL on vCPU host CPUs, and setting VCPU pinning all help; virtio eliminates the per-register-read/write trap → userspace round-trip: one virtqueue kick (a single VM exit) processes a batch of I/O descriptors, reducing exits per I/O from ~5-10 to ~1-2; the guest must not see features the host doesn't want it to use — CPUID controls critical behavior: if the guest sees AVX2 supported but the host isn't saving AVX state on VM exit, guest context is corrupted; if the guest sees INVPCID but the host doesn't emulate it, the guest panics; the hypervisor presents a carefully curated "virtual CPU" to maintain correctness and security.)*

---

**Next:** Part VIII — how the kernel codebase itself is engineered. Inside the synchronization arsenal that keeps 40 million lines of concurrent code correct: spinlocks, mutexes, RCU, seqlocks, atomics, memory barriers, and the lockdep debugger that catches deadlocks before they ship.
