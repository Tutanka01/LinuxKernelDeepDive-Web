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
convenient stable symlinks in `/dev/disk/by-uuid/` and friends.

```bash
udevadm monitor        # plug in a USB stick and watch events flow
```

The flow when you plug something in:

```text
hardware event → kernel enumerates device → loads driver (modprobe)
       → /sys entries appear → uevent to udev → udev names it, sets perms,
       → runs rules → desktop notices and mounts it
```

## /sys: the kernel's object model on display

While `/dev` gives you *data paths* to devices, **sysfs** (`/sys`) exposes the
kernel's internal *object graph* — every device, driver, bus, and their
relationships — as directories, with attributes as one-value-per-file:

```bash
cat /sys/class/net/eth0/speed                 # link speed
cat /sys/block/nvme0n1/queue/rotational      # 0 = SSD
echo 0 | sudo tee /sys/class/leds/*/brightness  # writing = poking the kernel
```

This is "everything is a file" used as a *control plane*: shell scripts can
tune kernel behaviour with `echo` and `cat`. (`/proc` was supposed to be about
processes; `/sys` is the tidy successor for everything device-related.)

## Kernel modules: extending the kernel at runtime

The kernel would be absurdly bloated if every driver were compiled in.
Instead, most are **loadable kernel modules** (`.ko` files) — object code
linked into the *running* kernel on demand:

```bash
lsmod | head                      # what's loaded right now
modinfo ext4 | head -8            # metadata of one module
sudo modprobe dummy               # load (resolving dependencies)
sudo modprobe -r dummy            # unload
ls /lib/modules/$(uname -r)/kernel/drivers | head
```

`modprobe` is triggered automatically: plug in hardware → the device
advertises IDs → the kernel asks user space to load whatever module claims
those IDs. It feels like magic; it's a lookup table (`modules.alias`).

Two facts with security weight:

- A module runs **in kernel space with total power**. There is no sandbox.
  A buggy module = crashes; a malicious module = game over (rootkits are
  usually modules). This is why **Secure Boot** setups enforce module
  *signing*, and why containers are **never** allowed to load modules.
- The kernel↔module interface is *not* stable across versions — modules are
  built per-kernel (that's what **DKMS** automates for out-of-tree drivers
  like NVIDIA's).

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
```

```makefile
# Makefile
obj-m += hello.o
all:
	make -C /lib/modules/$(shell uname -r)/build M=$(PWD) modules
```

`make && sudo insmod hello.ko && sudo dmesg | tail -1` → `hello: loaded`.
Congratulations, you've run your own code in ring 0. The kernel-dev chapter
goes further.

## Interrupts and the bottom-half idea

How does a driver learn its device needs attention? **Interrupts** (chapter 3
introduced them). One refinement worth knowing: interrupt handlers must be
*fast* — they run with the world partly frozen. So Linux splits the work:

- **top half**: the actual IRQ handler — acknowledge the device, grab the
  data pointer, schedule the rest, return in microseconds;
- **bottom half**: the real processing (e.g. pushing a packet through the
  TCP/IP stack), deferred to *softirqs* / kernel threads (you've seen
  `ksoftirqd` in `ps`) that run at a polite time.

```bash
cat /proc/interrupts | head     # IRQ counts per CPU per device
```

For very fast devices, interrupt-per-event is too slow — NVMe and modern NICs
use polling hybrids (NAPI) and multiple hardware queues spread across CPUs.

## udev rules, one practical example

The classic real-world task — stable permissions for some gadget:

```bash
# /etc/udev/rules.d/99-myboard.rules
SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", MODE="0666", SYMLINK+="arduino"
```

Reload (`sudo udevadm control --reload`), replug, and your Arduino is always
`/dev/arduino`, writable without sudo. Most "device permission denied"
problems end with a udev rule or joining a group (`dialout`, `video`…).

## Try it yourself

```bash
lsblk; lspci | head; lsusb                      # the hardware inventory
ls -l /dev/disk/by-uuid/                        # udev's stable names
lsmod | wc -l                                    # how many modules right now
cat /proc/interrupts | head
udevadm info /dev/sda | head -15
```

## Check your understanding

1. What do major/minor numbers select, respectively?
2. Why is loading a kernel module a root-equivalent (and container-forbidden)
   operation?
3. Why are interrupt handlers split into top and bottom halves?

---

**Next:** the networking stack — sockets, TCP/IP inside the kernel, and the
plumbing (veth, bridges, iptables) containers will reuse.
