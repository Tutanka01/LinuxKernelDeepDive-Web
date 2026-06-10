# From Power Button to Login

> **Goal:** follow the machine from electricity to a usable shell, naming every
> actor on the way: firmware → bootloader → kernel → init → your login. After
> this chapter, `dmesg` and "PID 1" will mean something concrete, and you'll
> understand exactly what your bootloader is doing in those three seconds.

Booting looks like magic because four completely different programs hand
control to each other in under a few seconds. Let's slow it down.

```text
power on
   │
   ▼
[1] Firmware (UEFI/BIOS)         "find something bootable"
   │
   ▼
[2] Bootloader (GRUB, systemd-boot)   "load kernel + initramfs into RAM"
   │
   ▼
[3] Linux kernel                  "initialize hardware, mount root fs"
   │
   ▼
[4] PID 1: init (systemd)         "start services, mounts, network, getty"
   │
   ▼
[5] login / display manager  →  your shell
```

## Stage 1 — Firmware (UEFI)

When power arrives, the CPU starts executing code from a fixed address in a
flash chip on the motherboard: the **firmware**. Older machines used **BIOS**;
everything modern uses **UEFI**.

The firmware:

1. runs **POST** (Power-On Self-Test): checks RAM, enumerates devices;
2. locates a bootable target. UEFI reads boot entries from NVRAM
   (see them with `efibootmgr` on a running system), finds the **EFI System
   Partition** (a small FAT32 partition, usually mounted at `/boot/efi`), and
   loads a `.efi` executable from it — your bootloader.

> **BIOS vs UEFI in one line:** BIOS blindly executed the first 440 bytes of
> the disk (the MBR); UEFI understands partitions and filesystems and runs a
> proper executable. Same job, fewer dark rituals.

### UEFI in slightly more detail

The ESP contains EFI executables — PE/COFF binaries, not ELF. Your bootloader
is one of them. UEFI hands the bootloader:

- a **memory map** (which ranges are usable, reserved, ACPI, etc. — the kernel
  needs this, and the bootloader passes it along);
- access to UEFI **runtime services** (clock, NVRAM variables, capsule
  updates) — the kernel can call these during boot before switching to its own
  drivers;
- the **GOP framebuffer** if you're booting graphically (what lets you see the
  GRUB menu and the early kernel console).

On most distributions you can inspect the boot entries:

```bash
sudo efibootmgr -v
# Boot0000* ubuntu  HD(1,GPT,...)/File(\EFI\ubuntu\shimx64.efi)
```

That `shimx64.efi` is the UEFI shim (for Secure Boot compatibility) which
then loads GRUB. The Secure Boot chain: firmware verifies shim's signature
(using Microsoft's CA, which shim is signed with), shim verifies GRUB (using
the distro's key), GRUB verifies the kernel (signatures embedded in the
vmlinuz). If any link fails, boot halts — this is the "trusted boot" chain
and why unsigned kernels/modules won't load under Secure Boot.

## Stage 2 — Bootloader (GRUB)

The bootloader's job is small but vital:

1. show you a menu (kernels, other OSes) if asked;
2. load two files from `/boot` into RAM:
   - `vmlinuz-…` — the **compressed kernel image**;
   - `initramfs-…` (or `initrd`) — a small **temporary root filesystem** in
     a compressed archive;
3. pass the **kernel command line** (arguments like `root=UUID=… quiet splash`
   — see yours with `cat /proc/cmdline`);
4. jump into the kernel's entry point. The bootloader's job is done forever.

### The kernel command line, decoded

```bash
cat /proc/cmdline
# BOOT_IMAGE=/boot/vmlinuz-6.8.0 root=UUID=abc123 ro quiet splash
```

Each parameter has a role:
- `root=UUID=abc123` — which filesystem becomes `/`
- `ro` — mount root read-only initially (initramfs remounts rw later)
- `quiet` — suppress most kernel log messages at boot
- `splash` — show a graphical splash screen
- `init=/bin/bash` — override PID 1 (single-user recovery!)
- `panic=5` — auto-reboot after 5 seconds if the kernel panics

The kernel itself accepts hundreds of parameters (`modprobe.blacklist`,
`cgroup_no_v1`, `mitigations=off`…). The `Documentation/admin-guide/kernel-parameters.txt`
in the kernel source is the complete reference.

### What's actually in the initramfs?

A chicken-and-egg problem: to mount your real root filesystem, the kernel may
need modules (disk drivers, filesystem drivers, RAID/LVM/encryption support) —
but those modules live *on* the root filesystem it can't mount yet.

Solution: the **initramfs**, a small CPIO archive containing just enough
drivers and tools, unpacked straight into RAM. The kernel runs a tiny `/init`
script from it which loads the right modules, assembles RAID/decrypts disks if
needed, mounts the real root, and finally **switches root** onto it.

```bash
lsinitramfs /boot/initrd.img-$(uname -r) | head -30
# lib/modules/6.8.0/kernel/drivers/nvme/host/nvme.ko.zst
# lib/modules/6.8.0/kernel/fs/ext4/ext4.ko.zst
# scripts/local-block/lvm2_scan
# sbin/blkid
# usr/sbin/cryptsetup
```

You can even unpack it and study the init script:

```bash
mkdir /tmp/initrd && cd /tmp/initrd
zstdcat /boot/initrd.img-$(uname -r) | cpio -idmv 2>/dev/null
cat init       # the script systemd/klibc-based initramfs runs
```

## Stage 3 — The kernel wakes up

The kernel decompresses itself, then runs its initialization in a precise
order. You can watch a replay of it any time with `dmesg`:

```bash
sudo dmesg | head -40
sudo dmesg --human --level=err,warn  # just the trouble
sudo dmesg -H -T                     # human timestamps
```

Roughly, it:

1. **CPU & memory setup** — builds page tables, enables virtual memory,
   detects all RAM (from the UEFI memory map!), brings up the other CPU cores
   via SMP. Each core gets its own stack, its own per-CPU data structures.
2. **Core subsystems** — initializes the scheduler (so kernel threads can
   run), interrupt handlers (so it can respond to hardware), the timer
   subsystem (so preemption works), and the RCU subsystem (lock-free read
   paths used everywhere in the kernel).
3. **Device discovery** — walks PCIe/USB buses, populates the device model.
   The kernel has a built-in table that maps PCI vendor/device IDs to drivers;
   it matches each discovered device and calls `probe()`. `/dev` and `/sys`
   entries appear.
4. **Mounts the root filesystem** — via the initramfs. The initramfs `/init`
   does the heavy lifting: loads needed modules (nvme, ext4, dm-crypt…),
   assembles storage stacks (md-raid, LVM, LUKS unlock), mounts the real root,
   runs `pivot_root` or `switch_root` to make it `/`, then cleans up.
5. **Starts PID 1** — the kernel executes exactly one user-space program,
   traditionally `/sbin/init`. From this moment, the kernel is largely
   *reactive*: most kernel code executes when interrupts fire or processes
   make syscalls.

> **Simplified model:** after boot, the kernel has no single permanent "main
> loop" comparable to a user-space application. It is a library of services
> invoked by hardware interrupts and system calls, and user space drives the
> machine.
>
> **Important nuance:** the kernel is not purely reactive in every sense. It
> also runs **kernel threads** (visible as `[kthreadd]`, `[ksoftirqd/*]`,
> `[kworker/*]` — workqueues handling deferred work, writeback flushing page
> cache, and many others), executes **softirqs** and **timer-driven deferred
> processing**, and wakes itself periodically for housekeeping. The kernel
> is *event-driven* more than it is *passive*, driven by hardware events,
> timer events, and user-space requests rather than by a single blocking main
> loop.

### The dmesg boot story decoded

Here's what key lines in your dmesg actually mean:

```text
[0.000000] Linux version 6.8.0 (buildd@…)      ← kernel version and builder
[0.000000] Command line: BOOT_IMAGE=...         ← the cmdline we discussed
[0.000000] BIOS-provided physical RAM map:       ← what UEFI told the kernel
[0.000000] e820: usable [mem 0x00000000-0x0009ffff]
[0.012345] smpboot: Booting Node 0, CPUs: #1 #2 #3 … ← multi-core bringup
[0.345678] pci_bus 0000:00: root bus resource    ← PCI enumeration begins
[1.234567] EXT4-fs (sda2): mounted filesystem     ← the real root, mounted
[2.345678] systemd[1]: Inserted module 'autofs4'   ← PID 1 now running
```

The timestamps in brackets are seconds since the kernel started (the `[0.000000]` at first log). Diagnose slow boots by looking at large gaps:
`dmesg | awk '{print $1}' | sed 's/[][]//g' | sort -rn | head -1`.

## Stage 4 — PID 1: init (systemd)

The first process gets PID 1 and special status:

- it is the **ancestor of every other process** on the system;
- it **adopts orphans** (when a parent dies before its children);
- if PID 1 of the **initial PID namespace** dies, the kernel **panics** —
  the system is dead at that point. (Remember this for containers: the
  process you start in a container becomes that namespace's PID 1,
  inheriting orphan reaping duties and signal specialness — but its death
  triggers a **SIGKILL cascade to all processes in that PID namespace**,
  not a host panic. Only PID 1 in the initial namespace can panic the
  machine.)

On virtually all modern distros, init is **systemd**. Its job: bring the
system to a desired state by starting **units** (services, mounts, sockets,
timers) with full dependency tracking and parallelism.

```bash
pstree -p | head -15        # everything descends from systemd(1)
systemctl list-units --type=service --state=running
systemd-analyze blame       # who's slow at boot?
systemd-analyze critical-chain  # the longest dependency chain
journalctl -b -0            # logs since THIS boot
journalctl -b -1            # logs from the PREVIOUS boot (gold for crashes)
```

Old-school `sysvinit` ran numbered shell scripts in sequence
(`/etc/rc3.d/S01…`); systemd replaced that with declarative unit files:

```ini
# /usr/lib/systemd/system/nginx.service (simplified)
[Unit]
Description=nginx web server
After=network.target

[Service]
ExecStart=/usr/sbin/nginx -g 'daemon off;'
Restart=on-failure
PrivateTmp=true        ← private /tmp, via mount namespace!
ProtectSystem=strict   ← read-only /usr, /etc
ReadWritePaths=/var/log/nginx

[Install]
WantedBy=multi-user.target
```

Notably, systemd uses **cgroups** to track every process a service spawns —
the same kernel feature containers use for resource limits. The
container world and the init world are built on identical kernel primitives.

## Stage 5 — Login

For a server: systemd starts `getty` on a tty. `getty` opens the terminal,
prints `/etc/issue`, runs `login`. `login` checks your password against
`/etc/shadow` (or PAM), sets your UID/GID/home directory, and finally
`exec`s your shell. At this point you have a session — the kernel doesn't
know or care that you're "logged in"; it just knows the process tree changed.

For a desktop: a **display manager** (GDM, SDDM) does the same dance
graphically: it owns the GPU/input, runs a login screen, authenticates, and
starts your session — which is a regular process tree under systemd's
`user@1000.service`.

Either way the result is identical: a process tree rooted at PID 1, with your
shell as a leaf, waiting for you to type. The boot is complete.

## Boot performance: what slows things down

If your machine boots slowly, here's where to look:

```bash
systemd-analyze                # total time: firmware (red) + loader + kernel + user
systemd-analyze blame          # per-service startup times, descending
systemd-analyze plot > boot.svg # swimlane chart
dmesg -d                       # show delta timestamps between kernel messages
```

Common culprits, by stage:
- **Firmware time** (5-15s) — UEFI POST, memory training, device enumeration. Hard to fix.
- **Loader time** (1-5s) — GRUB's timeout, filesystem drivers loading the kernel image. Trim `GRUB_TIMEOUT` in `/etc/default/grub`.
- **Kernel time** (2-10s) — device probing, firmware loading. Cached and parallelized by the kernel; usually not the problem.
- **Userspace time** (5-30s) — the big one. systemd units waiting on slow services (network-online.target is a classic). `systemd-analyze critical-chain` names the choke point.

## Try it yourself

```bash
cat /proc/cmdline            # what the bootloader told the kernel
sudo dmesg --human | less    # the kernel's own boot diary
sudo dmesg -d | sort -t'<' -k2 -rn | head -5  # where did the kernel spend time?
systemd-analyze              # how long each boot stage took
systemd-analyze critical-chain  # the longest dependency chain
pstree -p | head             # the process tree growing from PID 1
ls -lh /boot                 # kernel images and initramfs archives
lsinitramfs /boot/initrd.img-$(uname -r) | wc -l  # how many files in there?
sudo efibootmgr -v           # UEFI boot entries
```

## Check your understanding

1. Why can't the kernel just mount the root filesystem directly — what is the
   initramfs working around?
2. After boot is finished, what causes kernel code to execute at all?
3. What's special about PID 1, and why will this matter for containers?
4. You see a three-second gap in dmesg between PCI enumeration and the
   "mounted filesystem" message. What was likely happening?
5. What does `ro` on the kernel command line mean, and when does it get
   changed?

*(Answers, in order: the kernel may need modules (disk/filesystem drivers,
encryption support) that live on the root filesystem it cannot yet mount —
the initramfs is a small bootstrapping rootfs that provides those; interrupts,
system calls, kernel threads, workqueues, softirqs, and timer-driven deferred
work — the kernel is event-driven rather than having a single main loop, but
it is not purely passive; PID 1 is the process tree root and orphan adopter —
its death panics the machine if it is PID 1 of the initial PID namespace, but
inside a container PID namespace, PID 1's death sends SIGKILL to all other
processes in that namespace rather than panicking the host; the initramfs
was loading modules and assembling storage stacks before it could mount the
real root; the root filesystem is mounted read-only initially for safety (so
fsck can run if needed), and the initramfs or init system remounts it
read-write later in boot.)*

---

**Next:** the boundary that defines everything — kernel space vs user space,
and the system call mechanism that crosses it.
