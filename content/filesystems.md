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
├─/run        tmpfs           tmpfs    rw          ← RAM-backed
└─/home       /dev/nvme0n1p3  xfs      rw
```

**Mounting** grafts a filesystem onto a directory of the tree. The directory
(`/home`) is just a name; the mount makes its contents come from elsewhere.
This composability is everywhere: the same `cat` works on ext4, on a network
share, on `/proc` — because of the layer that makes them interchangeable.

```bash
cat /proc/mounts            # the kernel's live mount table
findmnt --types ext4,xfs    # only disk-backed
```

## The VFS: one interface, many implementations

The **Virtual File System** is the kernel's abstraction layer. It defines the
*concepts* — file, inode, directory entry, mount, superblock — and the
operations on them (`open`, `read`, `lookup`…). Each filesystem (ext4, xfs,
btrfs, tmpfs, proc, nfs, overlayfs…) is an implementation plugged in
underneath:

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
pointers (`file_operations`, `inode_operations`, `super_operations`,
`dentry_operations`); the VFS calls through them. OverlayFS — the engine of
Docker images — is "just" another VFS implementation, one that stacks others.

### The VFS objects in the kernel

| Object | Struct | What it represents |
|---|---|---|
| Superblock | `super_block` | A mounted filesystem instance |
| Inode | `inode` | A file (metadata, permissions, data blocks) |
| Dentry | `dentry` | A directory entry: a name → inode mapping |
| File | `struct file` | An open file (cursor, flags, the process's view) |

The dentry cache (dcache) is the kernel's "path lookup accelerator" — a hash
table of recently-resolved `name → inode` mappings. Without it, every `open()`
would read directories from disk. With it, repeated opens of the same file
cost zero I/O.

```bash
sudo slabtop -s name | grep -E 'dentry|inode'  # cache sizes
cat /proc/sys/vm/vfs_cache_pressure             # reclaim aggressiveness for dcache/inode caches
```

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
stat /etc/hostname           # all inode metadata
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

```bash
ln -s a s1; stat s1          # symlink is its own inode, type "symbolic link"
readlink -f s1                # resolve to the final target
```

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

Beyond classic bits: **ACLs** (`getfacl`/`setfacl`) for finer grants:

```bash
getfacl /etc/shadow
# user::rw-
# user:alice:r--     ← Alice can read, even though she's not root
setfacl -m u:bob:rw myfile
```

And **capabilities** — root's powers chopped into ~40 pieces (`CAP_DAC_OVERRIDE`
bypasses permission checks, `CAP_FOWNER` bypasses ownership checks,
`CAP_SYS_ADMIN` does everything else). Capabilities matter enormously for
containers; Part III returns to them.

## A journey: what `cat /etc/passwd` actually does

1. `openat(AT_FDCWD, "/etc/passwd", O_RDONLY)` enters the VFS.
2. **Path resolution**: starting at `/` (the process's root dentry), the VFS
   walks component by component. Each step: find the dentry in the dcache;
   cache miss → call the filesystem's `lookup()` which reads directory blocks
   from disk. Check `x` permission at every directory level. Serve from dcache
   when hot — path lookup is so frequent it has its own dedicated cache.
3. The final dentry yields the **inode**; permission check (`r` on the file);
   the kernel builds a `struct file` (the cursor: position + access mode),
   installs it in your fd table → returns `3`.
4. `read(3, buf, …)`: VFS asks the page cache first. Hit → copy to user
   buffer, done. Miss → filesystem's `read_folio()` maps file offset → disk
   blocks (via the inode's extent map or indirect block tree), the block layer
   queues a request, the NVMe driver fetches it, the page joins the cache,
   then the copy happens.
5. `close(3)` drops the reference count on the `struct file`. Nothing touches
   the disk (unless the file was open O_WRONLY and the filesystem needs to
   update `mtime` on close).

Every file operation on any filesystem is a variation of this dance.

## Journaling and crash consistency

*Journaling*, in one line: the filesystem writes its intent to a log before
modifying structures, so a crash mid-operation replays or discards cleanly.

```text
ext4 journal model:

1. write "I'm going to update inode 45, blocks 200-205" (journal)
2. write actual data blocks (can be skipped: data=writeback mode)
3. write metadata blocks (inode, bitmap, extent tree)
4. write "done" (commit block in journal)
5. write actual metadata to final locations (checkpoint)

Crash after step 1 and before 4 → on boot, discard the partial journal entry.
Crash after step 4 → on boot, replay the journal entries to final locations.
```

The `data=` mount option (`ordered` = default, safest; `writeback` = faster,
data may appear corrupted after crash; `journal` = data also journaled, slow)
controls this trade-off.

## Which filesystem should you care about?

| FS | One-liner |
|---|---|
| **ext4** | The dependable default for decades. Journaled, fast, boring (a compliment). |
| **xfs** | Excellent at large files & parallel I/O; RHEL's default. Allocates inodes dynamically — no `df -i` exhaustion. |
| **btrfs** | Copy-on-write: snapshots, checksums, compression, send/receive. Subvolumes act like mount points. |
| **zfs** | The legendary COW filesystem (out-of-tree for licensing). Built-in RAID, snapshots, dedup. The gold standard for data integrity. |
| **tmpfs** | RAM-backed, vanishes at reboot — `/tmp`, `/run`, and `/dev/shm`. |
| **overlayfs** | Stacks read-only layers under a writable one. **The engine of container images** — Part III. |
| **FUSE** | Filesystem in user space — sshfs, s3fs, rclone. A kernel-to-userspace protocol, slower than in-kernel filesystems. |

### Copy-on-Write filesystems (btrfs/zfs)

COW means: when you modify a block, the filesystem writes it to a new
location and updates pointers. The old block remains until no snapshot
references it. This gives you:

- **Snapshots**: `btrfs subvolume snapshot /home /snaps/home-2024` — instant,
  takes no extra space until files diverge.
- **Checksums**: every data and metadata block has a checksum; bit rot is
  detected and (with redundancy) repaired.
- **Send/receive**: `btrfs send` creates a binary diff from one snapshot to
  the next; `btrfs receive` applies it. Efficient incremental backup.

The trade-off: fragmentation (blocks get scattered), write amplification
(even a small change copies the entire block), and complexity (btrfs RAID5/6
has known bugs in some workloads — test before trusting).

## Mounts are per-process (the seed of containers)

Here's the detail that quietly sets up Part III: the mount table isn't truly
global — each process *references* a **mount namespace**. Today, all your
processes share one. But a process can get its own copy, mount things only
*it* sees, then `pivot_root` so that its `/` is some other directory entirely
— at which point it lives in a different filesystem world. That, plus a few
more namespaces, *is* a container. Hold the thought.

Mount propagation controls how mounts appear across namespace copies:

```bash
cat /proc/self/mountinfo | head  # see "shared", "private", "slave" flags
```

Container runtimes set everything `private` so container mounts never leak to
the host, and host mounts don't flood into containers.

## Try it yourself

```bash
echo data > f1; ln f1 f2; stat f1 f2          # one inode, two names
ln -s f1 s1; ls -li f1 f2 s1                  # symlink = its own inode
rm f1; cat f2; cat s1                          # hard link lives, symlink dangles
findmnt --fstab; cat /proc/filesystems        # what your kernel speaks
strace -e trace=openat,read,close cat /etc/hostname
sudo slabtop -s name | grep dentry            # size of the dentry cache
cat /proc/sys/vm/vfs_cache_pressure           # cache reclaim aggressiveness
```

## Check your understanding

1. Why does `mv` within one filesystem take 1 ms for a 100 GB file, while
   `mv` across filesystems takes minutes?
2. Disk is 100% full; `du -sh /` reports half that. What's the classic cause?
3. What does the VFS buy the kernel — and what kind of filesystem is `/proc`?
4. What's the difference between a hard link and a symbolic link at the inode
   level?
5. Why does `rm` free space when the file is still open?

*(Answers: within one fs, mv only rewrites a directory entry (the name→inode
mapping changes), the data blocks never move; across filesystems it must
copy+delete every data block; a deleted-but-still-open log file — the inode
stays allocated because a process has it open, `du` doesn't see the name
(rm'd), but `df` sees the blocks still allocated — `lsof +L1` finds it; the
VFS provides a uniform interface so `open/read/write` work on any filesystem
without the caller knowing which — `/proc` is a virtual filesystem backed by
kernel data structures, not a physical device; a hard link is a second
directory entry pointing to the same inode, while a symlink is its own inode
containing a path string as data; space is freed only when the inode's link
count drops to zero AND the reference count (open file handles) also drops to
zero — until the last close, the inode exists and its blocks stay allocated,
just invisible to path lookups.)*

---

**Next:** beneath every filesystem sits the storage stack — the page cache, the bio, the block layer with blk-mq, the I/O scheduler, the device mapper, and the queue architecture that decides what hits the disk first and when.
