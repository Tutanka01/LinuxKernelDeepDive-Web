# Reading & Building the Kernel

> **Goal:** lose your fear of the source. Where the code lives, how to read
> it without drowning, how to build and boot your own kernel safely in a VM,
> a first real module — and a map for everything after this site.

## The territory

The kernel is ~40 million lines, but the map is friendly — you already know
most of the rooms:

```text
linux/
├── kernel/        core: scheduler (sched/), fork.c, signals, cgroups, time
├── mm/            memory management: page faults, page cache, OOM killer
├── fs/            VFS (namei.c, open.c, read_write.c) + ext4/, btrfs/, overlayfs/, proc/
├── net/           the stack: ipv4/ (tcp*.c!), core/, netfilter/
├── drivers/       >60% of all code — every device driver
├── arch/          per-CPU-architecture code (x86/, arm64/, riscv/…)
├── include/       headers; include/linux/sched.h = task_struct lives here
├── security/      LSMs: selinux/, apparmor/; capabilities.c
├── init/          main.c — start_kernel(), the boot chapter in C
├── tools/         perf lives here, plus selftests
├── scripts/       build infrastructure, Kconfig, Coccinelle
├── lib/           kernel-internal: string, checksums, data structures
├── block/         block layer and I/O scheduler
├── ipc/           SysV IPC and POSIX message queues
├── crypto/        in-kernel crypto API (used by filesystems, networking)
├── rust/          Rust infrastructure (kernel 6.1+)
└── Documentation/ vast, good, underrated — *.rst, rendered at docs.kernel.org
```

Almost every concept this site covered is one file away:

| You learned about | Now read |
|---|---|
| fork & COW | `kernel/fork.c` (`copy_process()` — clone flags handled here!) |
| scheduler | `kernel/sched/fair.c` (EEVDF itself), `kernel/sched/core.c` |
| syscall table | `arch/x86/entry/syscalls/syscall_64.tbl` — all ~450, numbered |
| page faults | `mm/memory.c` (`handle_mm_fault()`) |
| OOM killer | `mm/oom_kill.c` (`oom_badness()` — the "who dies" formula) |
| path lookup | `fs/namei.c` (`link_path_walk()` — the walk) |
| pipes | `fs/pipe.c` (self-contained, clean — a great first read) |
| namespaces | `kernel/nsproxy.c`, `kernel/pid_namespace.c`, `net/core/net_namespace.c` |
| cgroups | `kernel/cgroup/cgroup.c`, `mm/memcontrol.c` |
| TCP | `net/ipv4/tcp_input.c` (famously, one of the hardest — save for last) |
| eBPF verifier | `kernel/bpf/verifier.c` |
| io_uring | `io_uring/io_uring.c` |

## How to actually read it

Don't clone-and-scroll. Use an indexed browser and a strategy:

- **Elixir** — [elixir.bootlin.com](https://elixir.bootlin.com): every
  identifier hyperlinked, every version, full-search. This is *the* way to
  read. Try it now: search `task_struct`, click around — you'll recognize
  `pid`, `mm`, `nsproxy`, `cred` from the processes chapter.
- **Livegrep** — [livegrep.com](https://livegrep.com/search/linux) or
  `cs.brown.edu` mirrors: instant regex search of the entire tree.
- Or locally: `git clone` + `cscope`/`clangd` (for IDE-level navigation),
  and grep like a kernel dev: `git grep -n "SYSCALL_DEFINE" fs/open.c` —
  syscall entry points are declared via `SYSCALL_DEFINE<argc>(name, …)`, so
  this finds `openat`'s actual implementation.

Strategy that works:

1. **Start from a syscall you know.** `SYSCALL_DEFINE3(openat, …)` →
   `do_sys_openat2()` → `do_filp_open()` → `path_openat()` → recognize the
   journey from the filesystems chapter, now in C.
2. **Read data structures before functions** (`struct task_struct`,
   `struct page`, `struct sk_buff`, `struct dentry`). Kernel code is
   comprehensible exactly to the degree you know its structs.
3. **Ignore the error handling and locking on a first pass** — mentally
   delete `unlikely(…)` branches, `goto out`, and `_rcu` suffixes; get the
   happy path first.
4. **Trust `Documentation/`** — e.g. `Documentation/admin-guide/cgroup-v2.rst`
   is the best cgroup text in existence. The networking docs
   (`Documentation/networking/`) explain things the source comments don't.

## Build and boot your own kernel

Deeply worth doing once — the boot chapter becomes physical. Total time:
under an hour on a modern machine. **Do it in a VM** (or accept that GRUB
keeps your old kernel as fallback — it does).

```bash
sudo apt install build-essential flex bison libssl-dev libelf-dev bc \
                 libncurses-dev fakeroot
git clone --depth=1 https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git
cd linux

# start from your distro's known-good configuration:
cp /boot/config-$(uname -r) .config
make olddefconfig          # take defaults for any new options
make localmodconfig        # optional: build only modules YOUR hardware uses
                           # → cuts build time from hours to ~15 min
make menuconfig            # browse! General setup → see EXPERT, namespaces,
                           #   cgroups — the features from Part III are
                           #   literally checkboxes here

make -j$(nproc)            # ☕ — produces arch/x86/boot/bzImage (a vmlinuz!)
sudo make modules_install  # → /lib/modules/<version>/
sudo make install          # → /boot + GRUB entry, initramfs generated (dracut/update-initramfs)
sudo reboot                # pick your kernel in GRUB
uname -r                   # …that's YOUR build running
```

### Troubleshooting common build failures

```bash
# Missing dependencies:
sudo apt build-dep linux   # all build deps in one shot
# Configuration mismatch — start completely fresh:
make defconfig             # then make menuconfig to customize
# Module version magic mismatch:
make -j$(nproc) && sudo make modules_install  # modules must match kernel
```

Faster inner loop, no reboots — boot the fresh kernel in QEMU:

```bash
qemu-system-x86_64 -kernel arch/x86/boot/bzImage \
    -append "console=ttyS0 root=/dev/vda rw" \
    -drive file=rootfs.img,if=virtio -nographic -m 2G -enable-kvm
```

Build a minimal rootfs.img with busybox or debootstrap; the
`virtme-ng` tool automates this whole loop beautifully:

```bash
pip install virtme
vng -b     # build kernel
vng        # boot it, sharing your filesystem (magic!)
```

## A module that does something

The devices chapter showed hello-world. One step further — a module exposing
a file in `/proc`, closing the loop on "everything is a file":

```c
// counter.c — /proc/counter: reads return an incrementing number
#include <linux/module.h>
#include <linux/proc_fs.h>
#include <linux/seq_file.h>

static unsigned long counter;

static int counter_show(struct seq_file *m, void *v)
{
    seq_printf(m, "%lu\n", counter++);
    return 0;
}

static int counter_open(struct inode *inode, struct file *file)
{
    return single_open(file, counter_show, NULL);
}

static const struct proc_ops counter_ops = {
    .proc_open = counter_open,
    .proc_read = seq_read,
    .proc_lseek = seq_lseek,
    .proc_release = single_release,
};

static int __init counter_init(void)
{
    proc_create("counter", 0444, NULL, &counter_ops);
    pr_info("counter: registered /proc/counter\n");
    return 0;
}

static void __exit counter_exit(void)
{
    remove_proc_entry("counter", NULL);
    pr_info("counter: unregistered\n");
}

module_init(counter_init);
module_exit(counter_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("A simple incrementing counter in /proc");
```

Same Kbuild Makefile as before; then:

```bash
make && sudo insmod counter.ko
cat /proc/counter   # 0
cat /proc/counter   # 1  ← kernel code you wrote, invoked by cat
cat /proc/counter   # 2
sudo rmmod counter
```

You now know, end to end, what happens during that `cat`: shell → fork/exec
→ `openat("/proc/counter")` → VFS → procfs → *your* `counter_open()` →
`counter_show()` in ring 0 → `seq_printf` → `read()` returns → `write(1, …)`.
The whole site in one command.

## Debugging a running kernel

When you're working with your own kernel and something goes wrong:

```bash
# Kernel logs (your module's pr_info/pr_err go here):
sudo dmesg -wH            # follow live
# Kernel oops/panic backtrace — decoded:
sudo dmesg | grep -A30 "Call Trace"
# With debug symbols, decode addresses:
./scripts/decode_stacktrace.sh vmlinux < backtrace.txt
# QEMU + GDB for step-through debugging:
qemu -s -S ...  # -s = gdb stub on port 1234, -S = stop at start
gdb vmlinux; target remote :1234
# Dynamic debugging for your module:
echo 'file counter.c +p' | sudo tee /sys/kernel/debug/dynamic_debug/control
```

## Navigating the kernel with git

The kernel uses git at a scale few projects match:

```bash
git log --oneline v6.8..v6.9          # what changed between releases?
git log --oneline -- mm/memory.c       # recent changes to one file
git blame include/linux/sched.h        # who wrote each line of task_struct
# Find which commit introduced a feature:
git log --all --grep="io_uring" --oneline | head
# The -next tree (integration testing for the next merge window):
git remote add next https://git.kernel.org/pub/scm/linux/kernel/git/next/linux-next.git
git fetch next && git log next/master --oneline | head
```

## Joining the actual development

How the kernel project works, in brief:

- Development happens on **mailing lists** (lore.kernel.org archives them
  all) as emailed patches; each subsystem has a **maintainer** who pulls
  patches up the tree toward Linus. Stable releases every ~9 weeks; `-rc1`
  after a two-week merge window, then ~7 release candidates for
  stabilization.
- Realistic first contributions: typo/doc fixes (there are always some),
  `scripts/checkpatch.pl` cleanups in `drivers/staging/`, or — most useful —
  *testing* and *reporting*. Read
  `Documentation/process/submitting-patches.rst` first; the bar for form
  (commit message format, Signed-off-by, `Fixes:` tags) is high and strictly
  enforced.
- The **KernelNewbies** community (kernelnewbies.org) exists precisely for
  this on-ramp. `kernelnewbies.org/Outreachyfirstpatch` is a guided tutorial
  from zero to your first accepted patch.
- `scripts/checkpatch.pl --strict my-patch.patch` will catch 90% of style
  issues before you email.

## Where to go from here — the bookshelf

- **Brendan Gregg — *Systems Performance* & *BPF Performance Tools***: the
  observability chapter, expanded into a career. Learn to answer "why is it
  slow?" with data.
- **Love — *Linux Kernel Development***: dated (2010) but still the
  friendliest tour of kernel internals' big ideas.
- **Kerrisk — *The Linux Programming Interface***: the syscall bible; the
  user-space view of everything here, in 64 chapters. Kerrisk also wrote the
  namespaces man pages — `man 7 namespaces` and the LWN namespaces series
  (lwn.net/Kernel/Index/#Namespaces).
- **lwn.net** — *the* kernel news source; the weekly editions explain new
  kernel work better than anywhere else. Subscribe if it earns its keep.
- **docs.kernel.org** — you'd be surprised how good the kernel documentation
  has gotten.  `Documentation/admin-guide/cgroup-v2.rst`,
  `Documentation/filesystems/overlayfs.rst`, `Documentation/bpf/` — authoritative.
- **OSDev wiki** (wiki.osdev.org) — if you want to go deeper: how to write a
  kernel from scratch.
- And: this site's "try it yourself" blocks, re-run on real problems. The
  durable skill isn't trivia — it's the reflex of *asking the kernel
  directly* and reading the answer.

## Check your understanding

1. Where would you look up: the implementation of `unshare(2)`? The OOM
   badness formula? The list of all x86-64 syscalls?
2. Why does `make localmodconfig` shrink build time so dramatically?
3. Trace `cat /proc/counter` end-to-end, naming each subsystem touched.
4. What does `virtme-ng` do — and why is it a faster development loop than
   reinstalling GRUB?

*(Answers: `kernel/fork.c` for clone/unshare, `mm/oom_kill.c` for
oom_badness(), `arch/x86/entry/syscalls/syscall_64.tbl` for all syscalls;
localmodconfig reads lsmod output and only builds modules your running system
actually uses — from 10,000+ modules to ~200, skipping 98% of the build; fork
→ exec cat → openat("/proc/counter") → VFS namei → procfs → your counter_show
→ seq_printf → copy_to_user → read() returns → write(1,…) → exit_group();
virtme-ng boots your freshly-built kernel in QEMU sharing the host filesystem
— no GRUB install, no reboot, no VM disk image, instant kernel test cycle.)*

---

*That's the tour. You came in with "Linux is a mysterious black box" and
leave with: it's processes all the way down — namespaced views, metered
shares, layered files, one kernel, and every bit of it inspectable from your
shell. Go build something, break it, and strace it back to health.*
