# Files, Filesystems & the VFS

> **Goal:** understand the path from `open("/etc/passwd")` down to disk
> blocks: the VFS layer, inodes, directory entries, mounts, and why "mount
> namespaces + pivot_root" (Part III) will feel natural afterwards.

## One tree, many filesystems

Unlike Windows' drive letters, Linux presents a **single tree** rooted at `/`.
Different branches of the tree can live on completely different filesystems —
a real disk here, a USB stick there, pure RAM over there:

```bash
findmnt | head -15
```

```text
TARGET        SOURCE          FSTYPE   OPTIONS
/             /dev/nvme0n1p2  ext4     rw,relatime
├─/boot/efi   /dev/nvme0n1p1  vfat     rw
├─/proc       proc            proc     rw          ← kernel data, not disk
├─/sys        sysfs           sysfs    rw          ← kernel data, not disk
├─/dev        devtmpfs        devtmpfs rw          ← devices
├─/tmp        tmpfs           tmpfs    rw          ← RAM-backed
└─/home       /dev/nvme0n1p3  xfs      rw
```

**Mounting** grafts a filesystem onto a directory of the tree. The directory
(`/home`) is just a name; the mount makes its contents come from elsewhere.
This composability is everywhere: the same `cat` works on ext4, on a network
share, on `/proc` — because of the layer that makes them interchangeable.

## The VFS: one interface, many implementations

The **Virtual File System** is the kernel's abstraction layer. It defines the
*concepts* — file, inode, directory entry, mount — and the operations on them
(`open`, `read`, `lookup`…). Each filesystem (ext4, xfs, btrfs, tmpfs, proc,
nfs, overlayfs…) is an implementation plugged in underneath:

```text
        open() read() write() stat() ...        ← syscalls
                     │
              ┌──── VFS ────┐                   ← common model + page cache
              │             │
        ext4  xfs  btrfs  tmpfs  proc  nfs  overlayfs
              │
        block layer → disk driver → hardware
```

It's classic polymorphism, in C: each filesystem provides a table of function
pointers; the VFS calls through them. (OverlayFS — the engine of Docker
images — is "just" another VFS implementation, one that stacks others.)

## Inodes: a file is not its name

The central idea of Unix filesystems, worth engraving:

> **A file is an inode. Names are separate things that point to inodes.**

An **inode** holds a file's metadata: type, permissions, owner, size,
timestamps, and — crucially — where its data blocks live. What it does *not*
hold: the file's name.

A **directory** is itself just a file whose content is a list of
`name → inode number` pairs (these pairs are *directory entries*, "dentries").

```bash
ls -li /etc/hostname        # first column = inode number
stat /etc/hostname
df -i /                     # filesystems can run out of inodes!
```

Consequences, all of which confuse people until they learn about inodes:

- **Hard links** — two names pointing to the same inode. Fully equal; the
  inode has a link count and the data dies only when it hits zero *and* no
  process holds the file open.

```bash
echo hi > a; ln a b; ls -li a b    # same inode, link count 2
```

- **Deleting an open file is safe** — `rm` removes a *name*. A process with
  the file open keeps reading/writing happily; space is freed on last close.
  This is why you can upgrade a running program's binary, and why "disk full
  but `du` finds nothing" happens (a deleted-but-open log file: check
  `lsof +L1`).
- **Renaming is atomic** — `mv` within a filesystem just rewrites a directory
  entry; the inode and its data never move. This is the foundation of every
  "write temp file, then rename over the original" safe-update pattern.
- **Symbolic links** are different: a symlink is its own little file
  containing a *path* as text. It can dangle, cross filesystems, and point at
  directories — all things hard links can't do.

## Permissions, briefly but precisely

Each inode carries `mode` bits — the famous `rwxr-xr-x`: three triplets for
**user (owner), group, other**. For files: read/write/execute. For
directories: `r` = list names, `w` = create/delete entries, `x` = *traverse*
(enter, resolve names through it) — you need `x` on every directory along a
path.

```bash
chmod u+x script.sh         # symbolic
chmod 644 notes.txt         # octal: rw- r-- r--
chown alice:staff file
```

Three special bits: **setuid** (run as the file's owner — how `passwd`
edits `/etc/shadow`), **setgid**, and the **sticky bit** on directories
(`/tmp`: anyone may create, only owners may delete).

Beyond classic bits: **ACLs** (`getfacl`) for finer grants, and
**capabilities** — root's powers chopped into ~40 pieces (`CAP_NET_ADMIN`,
`CAP_SYS_ADMIN`…). Capabilities matter enormously for containers; Part III
returns to them.

## A journey: what `cat /etc/passwd` actually does

1. `openat(AT_FDCWD, "/etc/passwd", O_RDONLY)` enters the VFS.
2. **Path resolution**: starting at `/`, the VFS looks up `etc` in the root
   directory, then `passwd` in `/etc` — each step a dentry lookup, checked
   against your `x` permission, served from the **dentry cache** when hot
   (path lookup is so frequent it has its own dedicated cache).
3. The final dentry yields the **inode**; permission check (`r`); the kernel
   builds a `struct file` (the cursor: position + mode), installs it in your
   fd table → returns `3`.
4. `read(3, buf, …)`: VFS asks the page cache first. Hit → copy to your
   buffer, done. Miss → ext4 maps file offset → disk blocks, the block layer
   queues a request, the NVMe driver fetches it, the page joins the cache,
   then the copy happens.
5. `close(3)` drops the references. Nothing touches the disk.

Every file operation on any filesystem is a variation of this dance.

## Which filesystem should you care about?

| FS | One-liner |
|---|---|
| **ext4** | The dependable default for decades. Journaled, fast, boring (a compliment). |
| **xfs** | Excellent at large files & parallel I/O; RHEL's default. |
| **btrfs** | Copy-on-write: snapshots, checksums, compression, send/receive. |
| **zfs** | The legendary COW filesystem (out-of-tree for licensing reasons). |
| **tmpfs** | RAM-backed, vanishes at reboot — `/tmp`, `/run`, and `/dev/shm`. |
| **overlayfs** | Stacks read-only layers under a writable one. **The engine of container images** — Part III. |

*Journaling*, in one line: the filesystem writes its intent to a log before
modifying structures, so a crash mid-operation replays or discards cleanly —
no more hour-long `fsck` after power loss.

## Mounts are per-process (the seed of containers)

Here's the detail that quietly sets up Part III: the mount table isn't truly
global — each process *references* a **mount namespace**. Today, all your
processes share one. But a process can get its own copy, mount things only
*it* sees, then `pivot_root` so that its `/` is some other directory entirely
— at which point it lives in a different filesystem world. That, plus a few
more namespaces, *is* a container. Hold the thought.

## Try it yourself

```bash
echo data > f1; ln f1 f2; stat f1 f2          # one inode, two names
ln -s f1 s1; ls -li f1 f2 s1                  # symlink = its own inode
rm f1; cat f2; cat s1                          # hard link lives, symlink dangles
findmnt --fstab; cat /proc/filesystems        # what your kernel speaks
strace -e trace=openat,read,close cat /etc/hostname
```

## Check your understanding

1. Why does `mv` within one filesystem take 1 ms for a 100 GB file, while
   `mv` across filesystems takes minutes?
2. Disk is 100% full; `du -sh /` reports half that. What's the classic cause?
3. What does the VFS buy the kernel — and what kind of filesystem is `/proc`?

---

**Next:** devices, drivers and modules — how the kernel talks to actual
hardware, and why everything shows up in `/dev`.
