# Devices, Drivers & Kernel Modules

> **Goal:** see how the kernel turns silicon into files — drivers, `/dev`,
> `/sys`, udev — and how kernel modules let you extend a running kernel.

## Drivers: translators for hardware

A **driver** is kernel code that speaks one device's dialect and exposes a
standard interface upward. The kernel ships thousands of them — that's a large
share of its ~40 M lines — which is why Linux boots on nearly anything.

The kernel splits the world into a few device classes:

| Class | Examples | Interface |
|---|---|---|
| **Character** | terminals, `/dev/null`, GPUs (mostly via ioctl) | byte stream, read/write |
| **Block** | disks: `/dev/sda`, `/dev/nvme0n1` | fixed-size blocks, random access, goes through the block layer & page cache |
| **Network** | `eth0`, `wlan0` | **not a file!** — interfaces, used via sockets |

### USB as a cross-section

USB devices appear through a tree of buses and endpoints. Plug in a device:

```text
USB host controller (driver: xhci_hcd)
  └── bus → device → configuration → interface → endpoints
                                                 ├── endpoint 0x81 (IN, bulk)
                                                 └── endpoint 0x02 (OUT, bulk)
```

The kernel probes: reads the device descriptor (vendor ID, product ID),
matches against the `usb_device_id` table in every registered USB driver,
calls `probe()` for the winner. After probe, the driver registers interfaces,
possibly a character device, a block device, or a network device.

```bash
lsusb -v | head -40              # full descriptor tree
cat /sys/kernel/debug/usb/devices  # the kernel's USB topology
```

## /dev: devices as files

```bash
ls -l /dev/sda /dev/null /dev/tty
```

```text
brw-rw---- 1 root disk 8, 0  /dev/sda    ← b = block, major 8, minor 0
crw-rw-rw- 1 root root 1, 3  /dev/null   ← c = char,  major 1, minor 3
```

The **major number** selects the driver; the **minor** selects which device
that driver instance handles. `open("/dev/null")` routes straight to the null
driver's `open` function — the VFS function-pointer trick again. Writing to
`/dev/sda` writes to the raw disk (bypassing the filesystem — this is how
`dd` images a drive, and how you destroy one with a typo).

`/dev` is a `devtmpfs` — populated by the kernel as devices appear, polished
by **udev** (systemd-udevd), which applies naming rules, permissions, and the
convenient stable symlinks in `/dev/disk/by-uuid/` and friends:

```bash
ls -l /dev/disk/by-uuid/
ls -l /dev/disk/by-id/
ls -l /dev/disk/by-path/
```

## /sys: the kernel's object model on display

While `/dev` gives you *data paths* to devices, **sysfs** (`/sys`) exposes the
kernel's internal *object graph* — every device, driver, bus, and their
relationships — as directories, with attributes as one-value-per-file:

```bash
cat /sys/class/net/eth0/speed                 # link speed
cat /sys/block/nvme0n1/queue/rotational      # 0 = SSD
echo 0 | sudo tee /sys/class/leds/*/brightness  # writing = poking the kernel
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
```

This is "everything is a file" used as a *control plane*: shell scripts can
tune kernel behaviour with `echo` and `cat`. (`/proc` was supposed to be about
processes; `/sys` is the tidy successor for everything device-related —
organized around the kernel's device model, not per-process scraps.)

### The kernel's device model

The kernel organizes devices into:

```text
bus (PCI, USB, platform, ...)
  ├── driver (nvme, xhci_hcd, e1000e, ...)
  ├── device (a specific NVMe SSD, a specific NIC)
  │     ├── attributes (files in sysfs — vendor, model, power state)
  │     └── class (block, net, tty — groups devices by function)
  └── class (something like "net" or "block")
        └── class_device (eth0, sda)
```

This graph is what `systemd`, `udev`, and the desktop environment query to
react to hardware changes. When a device appears, the kernel sends a `uevent`;
udev receives it, consults its rules, and creates `/dev` entries, sets
permissions, runs scripts. The desktop shows "new USB drive" because it
listened to the same uevent.

```bash
udevadm monitor        # plug in a USB stick and watch events flow
udevadm info -a -n /dev/sda | head -30  # the device tree, in udev's view
```

The flow when you plug something in:

```text
hardware event → kernel enumerates device → matches driver (modprobe)
       → /sys entries appear → uevent to udev → udev consults rules
       → names it, sets perms, creates /dev nodes
       → runs scripts → desktop notices → auto-mounts
```

## Kernel modules: extending the kernel at runtime

The kernel would be absurdly bloated if every driver were compiled in.
Instead, most are **loadable kernel modules** (`.ko` files) — object code
linked into the *running* kernel on demand:

```bash
lsmod | head                      # what's loaded right now
modinfo ext4 | head -15           # metadata of one module
sudo modprobe dummy               # load (resolving dependencies via modules.dep)
sudo modprobe -r dummy            # unload
sudo modprobe -v <module>         # verbose: see what's being loaded and why
ls /lib/modules/$(uname -r)/kernel/drivers | head
```

`modprobe` is triggered automatically: plug in hardware → the device
advertises IDs → the kernel creates a uevent → udev receives it → udev
calls `modprobe` with a modalias string → modprobe consults `modules.alias`
to find which module claims those IDs → `insmod` runs inside.

Cracking the magic: the `modules.alias` file maps PCI/USB vendor+device IDs
to module names:

```bash
grep -i 'nvidia' /lib/modules/$(uname -r)/modules.alias
# alias pci:v000010DEd... nvidia
```

Two facts with security weight:

- A module runs **in kernel space with total power**. There is no sandbox.
  A buggy module = crashes; a malicious module = game over (rootkits are
  usually modules). This is why **Secure Boot** setups enforce module
  *signing*, and why containers are **never** allowed to load modules.
- The kernel↔module interface is *not* stable across versions — modules are
  built per-kernel (that's what **DKMS** automates for out-of-tree drivers
  like NVIDIA's).

Module loading is gated by `CAP_SYS_MODULE`. Containers lack it (unless
`--privileged`), which is one of the strongest container security boundaries.
Without `CAP_SYS_MODULE`, you cannot load kernel code from user space.

### A taste of writing one

A minimal module is genuinely small:

```c
// hello.c
#include <linux/module.h>
#include <linux/init.h>

static int __init hello_init(void) {
    pr_info("hello: loaded\n");
    return 0;
}
static void __exit hello_exit(void) {
    pr_info("hello: bye\n");
}
module_init(hello_init);
module_exit(hello_exit);
MODULE_LICENSE("GPL");
MODULE_AUTHOR("Me");
MODULE_DESCRIPTION("Minimal kernel module");
```

```makefile
# Makefile (the Kbuild system, not a plain Makefile)
obj-m += hello.o
all:
	make -C /lib/modules/$(shell uname -r)/build M=$(PWD) modules
clean:
	make -C /lib/modules/$(shell uname -r)/build M=$(PWD) clean
```

`make && sudo insmod hello.ko && sudo dmesg | tail -1` → `hello: loaded`.
Congratulations, you've run your own code in ring 0. The kernel-dev chapter
goes further.

```bash
sudo rmmod hello        # unload; dmesg → "hello: bye"
modinfo hello.ko        # read the metadata you embedded
```

## Interrupts and the bottom-half idea

How does a driver learn its device needs attention? **Interrupts** (chapter 3
introduced them). One refinement worth knowing: interrupt handlers must be
*fast* — they run with interrupts disabled on that IRQ line, and potentially
with other IRQs masked. So Linux splits the work:

- **top half**: the actual IRQ handler — acknowledge the device (read
  interrupt status register, or the interrupt is re-fired endlessly), grab
  the data pointer, schedule the rest, return in microseconds;
- **bottom half**: the real processing (e.g. pushing a packet through the
  TCP/IP stack), deferred to *softirqs* / tasklets / workqueues that run
  later, with interrupts enabled.

The bottom-half mechanisms:

| Mechanism | When it runs | Characteristics |
|---|---|---|
| **softirq** | After IRQ handler returns, or in `ksoftirqd` thread | Fast, per-CPU, can't block. Used by networking (NET_RX, NET_TX) and block I/O |
| **tasklet** | Also from softirq context | Simpler API than raw softirq, but deprecated in favor of threaded IRQs |
| **workqueue** | Dedicated kernel threads (`[kworker/*]`) | Can sleep, can block, general-purpose. Device drivers use this for most heavy work |

```bash
cat /proc/interrupts | head     # IRQ counts per CPU per device
cat /proc/softirqs              # bottom-half counts per CPU
ps aux | grep '\[ksoftirqd\]'   # the softirq daemon threads
```

For very fast devices, interrupt-per-event is too slow — NVMe and modern NICs
use polling hybrids (NAPI for networking: one interrupt, then the driver
polls for a batch of packets) and multiple hardware queues spread across CPUs.

## DMA: how devices touch memory directly

Devices don't ask the CPU to copy data for them. They use **DMA** (Direct
Memory Access): the driver programs the device with a physical memory address
and length, the device reads from or writes to RAM directly, and rings a
doorbell or fires an interrupt when done.

The kernel's DMA API handles the complexity:
- Translating virtual addresses to physical (DMA addresses) for
  non-IOMMU-using devices.
- Ensuring cache coherency (flushing CPU caches before DMA reads, invalidating
  after DMA writes).
- Working with IOMMU (VT-d/AMD-Vi) for address translation and isolation —
  devices see I/O virtual addresses, not real physical addresses. IOMMU is
  critical for security: it prevents a rogue device from DMA'ing to arbitrary
  kernel memory.

```bash
dmesg | grep -i iommu          # IOMMU initialization
cat /sys/kernel/iommu_groups/*/devices/*  # IOMMU group topology
```

## udev rules, one practical example

The classic real-world task — stable permissions for some gadget:

```bash
# /etc/udev/rules.d/99-myboard.rules
SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", ATTRS{idProduct}=="0043", \
    MODE="0666", SYMLINK+="arduino"
```

Reload (`sudo udevadm control --reload`), replug, and your Arduino is always
`/dev/arduino`, writable without sudo. Most "device permission denied"
problems end with a udev rule or joining a group (`dialout`, `video`, `plugdev`).

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger       # re-trigger rules on already-connected devices
udevadm info -a -n /dev/ttyUSB0 | grep -E 'ATTRS{idVendor}|ATTRS{idProduct}'
```

## Try it yourself

```bash
lsblk; lspci | head; lsusb                      # the hardware inventory
ls -l /dev/disk/by-uuid/                        # udev's stable names
lsmod | wc -l                                    # how many modules right now
cat /proc/interrupts | head
cat /proc/softirqs | head
udevadm info /dev/sda | head -15
sudo udevadm monitor --kernel --udev             # watch real-time events (then plug USB)
```

## Check your understanding

1. What do major/minor numbers select, respectively?
2. Why is loading a kernel module a root-equivalent (and container-forbidden)
   operation?
3. Why are interrupt handlers split into top and bottom halves?
4. What's the difference between /dev/sda and /sys/block/sda? What does each
   give you?
5. Why is IOMMU important for security?

*(Answers: major selects the driver, minor selects which device that driver
handles; modules run in ring 0 with full privilege — a malicious module owns
the kernel, which is why CAP_SYS_MODULE is required and containers are
forbidden from loading them; the top half runs with interrupts partially
disabled and must return immediately — the bottom half does the real work
deferred, with interrupts re-enabled, often in a kernel thread; /dev/sda is
a block device file for reading/writing raw disk blocks, /sys/block/sda is
sysfs exposing the device's attributes (queue depth, rotational, scheduler,
I/O stats); IOMMU translates DMA addresses so devices can only access memory
explicitly mapped for them — without it, a malicious or buggy device could
DMA to arbitrary kernel memory and compromise the system.)*

---

**Next:** the networking stack — sockets, TCP/IP inside the kernel, and the
plumbing (veth, bridges, iptables) containers will reuse.
