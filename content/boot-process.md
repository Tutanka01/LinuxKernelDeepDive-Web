# From Power Button to Login

> **Goal:** follow the machine from electricity to a usable shell, naming every
> actor on the way: firmware → bootloader → kernel → init → your login. After
> this chapter, `dmesg` and "PID 1" will mean something concrete.

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

### Why does the initramfs exist?

A chicken-and-egg problem: to mount your real root filesystem, the kernel may
need modules (disk drivers, filesystem drivers, RAID/LVM/encryption support) —
but those modules live *on* the root filesystem it can't mount yet.

Solution: the **initramfs**, a small CPIO archive containing just enough
drivers and tools, unpacked straight into RAM. The kernel runs a tiny `/init`
script from it which loads the right modules, assembles RAID/decrypts disks if
needed, mounts the real root, and finally **switches root** onto it.

```bash
# peek inside your own initramfs (Debian/Ubuntu):
lsinitramfs /boot/initrd.img-$(uname -r) | head -30
```

## Stage 3 — The kernel wakes up

The kernel decompresses itself, then runs its initialization in a precise
order. You can watch a replay of it any time with `dmesg`:

```bash
sudo dmesg | head -40
```

Roughly, it:

1. **CPU & memory setup** — builds page tables, enables virtual memory,
   detects all RAM, brings up the other CPU cores (SMP).
2. **Core subsystems** — scheduler, interrupt handlers, timers.
3. **Device discovery** — walks PCIe/USB buses, matches each device to a
   **driver**, creating entries in `/dev` and `/sys`.
4. **Mounts the root filesystem** (via the initramfs dance above).
5. **Starts PID 1** — the kernel executes exactly one user-space program,
   traditionally `/sbin/init`, and from this moment the kernel becomes purely
   *reactive*: it only acts when interrupts fire or processes make syscalls.

> That last point is worth repeating: **after boot, the kernel has no "main
> loop" running on your behalf.** It's a library of services invoked by
> hardware interrupts and system calls. The world is driven by user space.

## Stage 4 — PID 1: init (systemd)

The first process gets PID 1 and special status:

- it is the **ancestor of every other process** on the system;
- it **adopts orphans** (when a parent dies before its children);
- if PID 1 dies, the kernel **panics**. (Remember this for containers: the
  process you start in a container becomes that container's PID 1, with the
  same responsibilities and quirks.)

On virtually all modern distros, init is **systemd**. Its job: bring the
system to a desired state by starting **units** (services, mounts, sockets,
timers) with full dependency tracking and parallelism.

```bash
pstree -p | head -15        # everything descends from systemd(1)
systemctl list-units --type=service --state=running
systemd-analyze blame       # who's slow at boot?
journalctl -b               # logs since this boot
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

[Install]
WantedBy=multi-user.target
```

Notably, systemd uses **cgroups** to track every process a service spawns —
the same kernel feature containers use for resource limits. The
container world and the init world are built on identical kernel primitives.

## Stage 5 — Login

For a server: systemd starts `getty` on a terminal, which runs `login`,
which checks your password against `/etc/shadow`, sets your UID/GID, and
finally `exec`s your shell.

For a desktop: a **display manager** (GDM, SDDM) does the same dance
graphically and starts your session.

Either way the result is identical: a process tree rooted at PID 1, with your
shell as a leaf, waiting for you to type. The boot is complete.

## Try it yourself

```bash
cat /proc/cmdline            # what the bootloader told the kernel
sudo dmesg --human | less    # the kernel's own boot diary
systemd-analyze              # how long each boot stage took
pstree -p | head             # the process tree growing from PID 1
ls /boot                     # kernel images and initramfs archives
```

## Check your understanding

1. Why can't the kernel just mount the root filesystem directly — what is the
   initramfs working around?
2. After boot is finished, what causes kernel code to execute at all?
3. What's special about PID 1, and why will this matter for containers?

---

**Next:** the boundary that defines everything — kernel space vs user space,
and the system call mechanism that crosses it.
