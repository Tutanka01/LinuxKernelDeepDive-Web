---
level: mechanism
kernel: 6.12
verified: 2026-07
minutes: 22
requires: criu-dump, criu-restore, container-runtimes
---

# Lab: Checkpoint & Restore a Real Process

> **Goal:** freeze a running, counting process to a pile of files on disk,
> watch it vanish, then bring it back from those files so it resumes counting
> at the exact number it stopped on — same PID, same stack, same everything.
> Then take it apart with CRIT to see *what* the kernel handed CRIU, break it
> on purpose to learn the failure modes, and finish with the container
> porcelain that ships this same magic across hosts.

The [How CRIU Dumps a Process](#/criu-dump) and [How CRIU Restores a
Process](#/criu-restore) chapters described checkpoint/restore in theory:
CRIU walks a process's `/proc` entries and kernel interfaces, serializes the
register file, the address-space map, the open file descriptors and the dirty
pages into a family of protobuf images, and later reverses the whole thing
from inside a fresh task that reshapes itself into the original. This lab
makes it happen in front of you, on a stock VM, with a process so simple you
can *see* the state that survives — an integer that keeps climbing across a
death and a resurrection.

Everything here builds on [Process State & the Task Struct](#/process-state)
(what "a process" even is that you can serialize) and pays off in
[Live Migration](#/live-migration) and [Container Runtimes](#/container-runtimes),
where the exact same images ride a network to another machine.

## What you need

- **A throwaway VM.** Checkpoint/restore needs `root`, and CRIU pokes deep:
  it uses `ptrace`, parasite-code injection into your target, `/proc/PID/map_files`,
  raw netlink, `CONFIG_CHECKPOINT_RESTORE`, and a fistful of capabilities.
  None of that endangers a healthy machine, but a VM is the comfortable place
  to run a tool whose whole job is stopping other processes and rewriting
  their guts. A recent Fedora or Ubuntu VM with its stock kernel is perfect.
- **The packages.**
  - Fedora: `sudo dnf install criu crit gcc`
  - Ubuntu/Debian: `sudo apt install criu build-essential` — on most releases the `crit`
    command ships inside the `criu` package. If `crit` isn't on your `PATH`
    after that, install `sudo apt install python3-crit` (older packagings
    split the Python decoder out).
  - Confirm both landed:

    ```text
    $ criu --version
    Version: 3.19
    $ crit --version
    crit 3.19
    ```

- **`podman`** for Stage 5 (`sudo dnf install podman` / `sudo apt install podman`).
- **Ten minutes of patience and a scratch directory.** We'll dump into
  `~/ckpt`; make sure it exists and is empty before each dump.

### The gate: `criu check`

Before dumping anything, ask CRIU whether the kernel it's running on actually
supports what it needs. This probes dozens of features (ptrace flavors,
`/proc/PID/map_files`, TCP repair mode, memory-tracking, and so on):

```bash
sudo criu check
```

On a healthy modern kernel:

```text
Looks good.
```

That two-word blessing means every *baseline* feature CRIU needs is present.
A few things worth knowing:

- `sudo criu check --all` (formerly `--extra`) probes the *optional* and
  experimental features too — userfaultfd lazy pages, some netlink diag
  modules, AIO. On these you may see lines like:

  ```text
  Warn  (criu/kerndat.c:1104): CRIU was built without libnftables support
  Looks good.
  ```

  A `Warn` here is not fatal: it means one *advanced* capability is missing,
  not that basic checkpoint/restore won't work. Read the specific feature and
  decide whether your lab needs it (this lab does not).
- If instead you see `Error` lines and a final verdict that is **not**
  "Looks good.", the kernel is missing something baseline — most often
  `CONFIG_CHECKPOINT_RESTORE=y`. Check with
  `zcat /proc/config.gz | grep CHECKPOINT_RESTORE` or
  `grep CHECKPOINT_RESTORE /boot/config-$(uname -r)`. Stock Fedora and Ubuntu
  kernels ship it enabled.

Once you have "Looks good.", proceed.

## Stage 1 — Checkpoint a live process by hand

We need a victim that is (a) trivially observable, (b) holds recognizable
state, and (c) really is **one process**. A shell loop is a poor specimen here:
every `sleep 1` launches a child, turning the demo into a moving process tree.
Use this tiny C counter instead. Its global state contains both a binary
counter and a marker we can find later in the raw memory image.

```bash
cat > ~/criu-counter.c <<'EOF'
#include <stdint.h>
#include <stdio.h>
#include <time.h>

static struct {
    char marker[32];
    uint64_t counter;
} state = { "LDD-CRIU-STATE-v1", 0 };

int main(void)
{
    const struct timespec one_second = { .tv_sec = 1, .tv_nsec = 0 };
    for (;;) {
        printf("%llu\n", (unsigned long long)state.counter++);
        fflush(stdout);
        nanosleep(&one_second, NULL);
    }
}
EOF
gcc -O0 -g -Wall -Wextra -o ~/criu-counter ~/criu-counter.c
```

In **terminal A**, start it in the foreground and watch it climb:

```bash
~/criu-counter
```

```text
0
1
2
3
4
...
```

Let it run. In **terminal B**, save its PID and make a home for the images:

```bash
PID=$(pgrep -n -x criu-counter)
printf 'PID=%s\n' "$PID"
```

```text
6072
```

```bash
mkdir -p ~/ckpt
```

Now dump it. `-t` is the target PID (CRIU checkpoints that task and its
children as a tree if it has any — see [How CRIU Dumps a
Process](#/criu-dump)), `-D` is the
images directory, and `--shell-job` is the flag that matters here:

```bash
sudo criu dump -t "$PID" -D ~/ckpt --shell-job && echo "dump OK"
```

```text
dump OK
```

**Why `--shell-job`?** Your counter was started from an interactive shell, so
its stdin/stdout are the terminal's pseudo-terminal (a pts slave), and it
belongs to that terminal's session and process group — but the *master* side
of the pty, and the session leader (your shell), are **not** part of the dump.
Without `--shell-job`, CRIU refuses:

```text
Error (criu/tty.c:XXXX): tty: Found dangling tty with sid 5940 pgid 6072 (pts) on peer fd 0.
                         Consider using --shell-job option.
```

`--shell-job` tells CRIU: "I know this job's terminal lives outside the dump;
treat the pts as an external inherited fd and let the restoring shell
re-attach it." (More on the fd taxonomy in Stage 4.)

**Now look at terminal A.** The counter is *gone* — the shell prompt is back:

```text
...
41
42
$
```

This surprises everyone the first time. **By default, `criu dump` kills the
process it checkpoints.** The reasoning is that checkpoint is usually the
first half of a *migration*: you froze the process precisely so it can run
*elsewhere*, and leaving the original alive would mean two copies mutating two
divergent futures. If you want the original to keep running after the dump
(useful for periodic snapshots / backups), add **`--leave-running`** (`-R`):

```bash
sudo criu dump -t "$PID" -D ~/ckpt --shell-job --leave-running
```

with that flag, terminal A would keep counting right through the dump.

### What the dump left behind

```bash
ls -la ~/ckpt
```

```text
total 264
drwxr-xr-x. 2 root root  4096 Jul 17 14:03 .
drwx------. 18 you  you  4096 Jul 17 14:02 ..
-rw-r--r--. 1 root root   410 Jul 17 14:03 core-6072.img
-rw-r--r--. 1 root root    82 Jul 17 14:03 creds-6072.img
-rw-r--r--. 1 root root    58 Jul 17 14:03 fdinfo-2.img
-rw-r--r--. 1 root root    78 Jul 17 14:03 files.img
-rw-r--r--. 1 root root    30 Jul 17 14:03 fs-6072.img
-rw-r--r--. 1 root root    46 Jul 17 14:03 ids-6072.img
-rw-r--r--. 1 root root    32 Jul 17 14:03 inventory.img
-rw-r--r--. 1 root root   630 Jul 17 14:03 mm-6072.img
-rw-r--r--. 1 root root  1232 Jul 17 14:03 pagemap-6072.img
-rw-r--r--. 1 root root 90112 Jul 17 14:03 pages-1.img
-rw-r--r--. 1 root root    28 Jul 17 14:03 pstree.img
-rw-r--r--. 1 root root   162 Jul 17 14:03 stats-dump
-rw-r--r--. 1 root root    50 Jul 17 14:03 tty-info.img
```

This is a representative anatomy of a frozen process; exact file sizes and
some auxiliary images vary with architecture and CRIU version. The families
you'll meet again all through this lab:

- **`inventory.img`** — the manifest: CRIU version, image format, page-size,
  the root task's PID. Restore reads this first.
- **`pstree.img`** — the process *tree*: which PIDs exist and their
  parent/child/thread relationships. For our single process it's tiny.
- **`core-<pid>.img`** — the **CPU core** of the task: register file (RIP,
  RSP, general-purpose regs, FPU/SSE state), the task's blocked-signal mask,
  its scheduling policy, its `comm`. This is the "resume here" instruction.
- **`mm-<pid>.img`** — the memory map: every VMA (start, end, protection,
  flags, backing), the brk, the auxv, the exe link. The shape of the address
  space, without the bytes.
- **`pagemap-<pid>.img`** — the index that maps virtual page ranges to offsets
  inside `pages-1.img` (see [Virtual Memory](#/memory)).
- **`pages-1.img`** — the actual **page contents** that cannot be reconstructed
  from a backing file. This is where our modified `state` object lives.
- **`fs-<pid>.img`** — cwd and root.
- **`files.img` / `fdinfo-N.img`** — the open-file table and per-task fd
  index. `fdinfo-2.img` is the fd map for our process.
- **`tty-info.img`** — the pts our `--shell-job` acknowledged.
- **`creds-<pid>.img` / `ids-<pid>.img`** — uids/gids/capabilities, and the
  pid/tid/pgid/sid namespace IDs.
- **`stats-dump`** — timing/telemetry (how long freezing took, pages written).

### What just happened

CRIU seized the task with `ptrace`, injected a small **parasite** blob into
its address space to run code *as the process* (so it could read the process's
own memory maps and credentials from the inside), harvested every scrap of
kernel-visible state through `/proc/$PID/*` and dedicated syscalls, wrote it
all out as the protobuf images above, and then — because we didn't pass
`--leave-running` — killed the original. The process now exists only as ~90 KB
of files in `~/ckpt`. Everything needed to reconstitute it is there.

## Stage 2 — Restore it

Bring it back. Same `-D` directory, same `--shell-job` (the restoring shell
will re-attach the terminal). Run this in a terminal and *watch*:

```bash
sudo criu restore -D ~/ckpt --shell-job
```

```text
43
44
45
46
...
```

**There it is.** It didn't restart from `0` — it resumed at **43**, the next
value in the same global `state.counter`, and kept climbing. If it was inside
`nanosleep`, CRIU arranges for execution to continue correctly across that
interruption. This is the money moment of the whole tool: not "start a fresh
copy" but "continue *this* execution."

Confirm the identity in **another terminal**:

```bash
pgrep -x criu-counter
```

```text
6072
```

**Same PID — 6072.** CRIU didn't just make a lookalike; it restored the
process *with its original PID*. Modern CRIU/kernel combinations can use
`clone3()` with `set_tid`; older compatible paths steer the PID allocator via
`ns_last_pid`. Either way the restored task must land on the saved number. That
matters because plenty
of state refers to a process by PID — pgids, sids, things that stored the PID
somewhere — and a different number would break those references.

> **What if that PID is already taken?** Then restore *fails* — you can't have
> two PID 6072s in the same PID namespace. That's not a bug, it's the reason
> real migration restores into a **fresh PID namespace** (a container),
> where PID 6072 — or even PID 1 — is guaranteed free. We provoke this failure
> deliberately in Stage 4.

### What just happened

`criu restore` read `inventory.img`, forked a task tree matching
`pstree.img` (requesting the saved PID), then each task
morphed itself into the original: it `mmap`'d the VMAs from `mm-6072.img`,
faulted the saved bytes back in from `pages-1.img` using the `pagemap` index,
reopened the files from `files.img`, restored credentials and the signal mask,
and finally loaded the register file from `core-6072.img` and entered the
restorer's architecture-specific final resume path, restoring the saved
instruction and stack pointers. See [How CRIU Restores a
Process](#/criu-restore) for the full
"the restorer eats itself" dance.

## Stage 3 — Autopsy with CRIT

The images are protobuf, not text — but `crit` (the **CRI**U image **T**ool)
decodes them into readable JSON. This stage is the one that turns CRIU from
magic into *understanding*. As the [criu-dump](#/criu-dump) chapter puts it:
an hour with CRIT teaches you more about what a process really *is* than ten
blog posts. The checkpoint files remain immutable after restore, so inspect
the same `~/ckpt` images you just used.

```bash
cd ~/ckpt
```

**The process tree.** Start with the smallest, clearest image:

```bash
crit decode -i pstree.img --pretty
```

```text
{
    "magic": "PSTREE",
    "entries": [
        {
            "pid": 6072,
            "ppid": 5940,
            "pgid": 6072,
            "sid": 5940,
            "threads": [
                6072
            ]
        }
    ]
}
```

One process, one thread, its parent (`ppid`) and session (`sid`) both pointing
at the shell that launched it — exactly the relationships `--shell-job` had to
account for.

**The registers.** Now the core — the CPU state. It's larger, so page it:

```bash
crit decode -i "core-$PID.img" --pretty | less
```

Look inside `thread_info.gpregs` (general-purpose registers). On x86-64 CRIT's
protobuf schema normally exposes the instruction and stack pointers as `ip`
and `sp`; other architectures have architecture-specific register layouts.
Record the two values from **your** decode. Do not infer "it was in
`nanosleep`" from a raw address alone: prove that by mapping the instruction
pointer through the saved VMAs and the matching binary/debug symbols. The
important invariant here is simpler: `core-<pid>.img` contains the CPU context
that the restorer reloads before execution resumes.

**The memory map.** `mm-*.img` is the VMA list — the same regions
`/proc/6072/maps` showed while the process lived:

```bash
crit decode -i "mm-$PID.img" --pretty | less
```

```text
{
    "magic": "MM",
    "entries": [
        {
            "vmas": [
                { "start": "0x563a1c000000", "end": "0x563a1c001000",
                  "prot": "PROT_READ", "flags": "MAP_PRIVATE",
                  "status": "VMA_FILE_PRIVATE", "shmid": 0 },
                { "start": "0x7ffe4d382000", "end": "0x7ffe4d3a3000",
                  "prot": "PROT_READ | PROT_WRITE", "flags": "MAP_PRIVATE | MAP_GROWSDOWN",
                  "status": "VMA_ANON_PRIVATE" }
            ],
            "mm_start_brk": "0x563a1d1f2000",
            "mm_brk": "0x563a1d213000",
            "mm_arg_start": "0x7ffe4d3a1a10",
            "exe_file_id": 3
        }
    ]
}
```

Find the read-write `MAP_GROWSDOWN` VMA — that is the **stack** — and confirm
that the saved stack pointer falls inside its range. Then find the writable
file-private VMA for `~/criu-counter`; our global `state` object began there
and its page became private when the counter was modified.

**Where the bytes live.** `pagemap` is the index into the raw page blob:

```bash
crit decode -i "pagemap-$PID.img" --pretty | head -30
```

```text
{
    "magic": "PAGEMAP",
    "entries": [
        { "pages_id": 1 },
        { "vaddr": "0x7ffe4d382000", "nr_pages": 33 },
        { "vaddr": "0x563a1d1f2000", "nr_pages": 4 }
    ]
}
```

Each entry says "starting at this virtual address, this many contiguous pages
were saved," in order, into the page image selected by `pages_id`.

**Finding known state in raw memory.** `pages-1.img` is unstructured page
content — you can go spelunking. We deliberately embedded a unique marker in
the mutable state object:

```bash
grep -aob 'LDD-CRIU-STATE-v1' ~/ckpt/pages-*.img
```

```text
~/ckpt/pages-1.img:41760:LDD-CRIU-STATE-v1
```

The byte offset and page-image ID vary. Use the reported offset to inspect the
surrounding bytes, for example:

```bash
xxd -s 41760 -l 64 ~/ckpt/pages-1.img
```

```text
0000a320: 4c44 442d 4352 4955 2d53 5441 5445 2d76  LDD-CRIU-STATE-v
0000a330: 3100 0000 0000 0000 0000 0000 0000 0000  1...............
```

You are looking at the process's actual saved memory, on disk. The marker does
not prove a stack location — it lives in a global object — and the adjacent
counter is binary, not an ASCII shell variable. Continuity is established by
both observations together: the known object is present in the page image, and
after restore its counter continues rather than restarting at zero.

### What just happened

Nothing was *changed* here — you just read the images. But you saw the shape
of the thing CRIU serializes: a register file that pins execution to one
instruction, a VMA list that lays out the address space, a pagemap that
indexes the bytes, and the raw bytes themselves. Restore is just this, played
backwards.

## Stage 4 — Break it, on purpose

Failures teach the model. Two classic ones, each mapping to a concept from the
theory chapters.

### 4a. An established TCP connection without `--tcp-established`

Sockets are the hardest fds to checkpoint: an established TCP connection has
*kernel-side* state (sequence numbers, send/receive queues) and a *peer* on
the other end who will send an RST if the connection goes quiet the wrong way.
CRIU can capture and restore it, but only when you *opt in*, because doing so
briefly installs a netfilter rule to silence the peer.

Make a victim with a live connection. In **terminal A**, open a listener and
connect to it, holding the connection open:

```bash
# terminal A: a server that just holds the connection
python3 -c 'import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",7777)); s.listen(1)
c,_=s.accept(); print("connected", flush=True); time.sleep(3600)'
```

```bash
# terminal B: a client that connects and then sleeps, holding it open
python3 -c 'import socket,time
c=socket.socket(); c.connect(("127.0.0.1",7777)); time.sleep(3600)' &
TCP_PID=$!
printf 'TCP_PID=%s\n' "$TCP_PID"
```

```text
6510
```

Give each attempt a fresh, empty image directory, then try to dump the client
**without** acknowledging the connection:

```bash
mkdir -p ~/ckpt-tcp-fail ~/ckpt-tcp-ok
sudo criu dump -t "$TCP_PID" -D ~/ckpt-tcp-fail -R 2>&1 | tail -4
```

```text
Error (criu/sk-inet.c:188): inet: Connected TCP socket, consider using --tcp-established option
Error (criu/cr-dump.c:XXXX): Dump files (pid: 6510) failed with -1
Error (criu/cr-dump.c:XXXX): Dumping FAILED.
```

That first line is CRIU's fd taxonomy talking: it walked the process's open
files, found a socket in `TCP_ESTABLISHED`, and refused to guess whether you
meant to capture it. Now opt in, writing the successful image set to the
other directory:

```bash
sudo criu dump -t "$TCP_PID" -D ~/ckpt-tcp-ok -R \
  --tcp-established && echo "dump OK"
```

```text
dump OK
```

With `--tcp-established`, CRIU puts the socket into **TCP repair mode**
(`TCP_REPAIR`), reads out the sequence numbers and unacked queues, and — on
restore — replays them so the kernel rebuilds the connection in the same
state, with the peer none the wiser. (This is exactly the flag `podman` and
`runc` pass through for you in Stage 5.) The lesson: **fds are not
interchangeable.** A regular file is trivial; a pipe needs its peer; an
established socket needs kernel repair mode and your explicit consent.

### 4b. Restoring onto an occupied PID

Recall Stage 2: the restore reclaims the *original* PID. Prove what happens
when that PID is already in use. The restored counter from Stage 2 is still
running as `$PID`. Take a **new** snapshot into a separate directory while
leaving that original alive, then try to restore a second copy from it:

```bash
mkdir -p ~/ckpt-copy
sudo criu dump -t "$PID" -D ~/ckpt-copy --shell-job \
  --leave-running && echo "dump OK"
sudo criu restore -D ~/ckpt-copy --shell-job 2>&1 | tail -3
```

```text
dump OK
Error (criu/pie/restorer.c:XXXX): Unable to clone 6072: Operation not permitted
Error (criu/cr-restore.c:XXXX): Restoring FAILED.
```

The restorer asked the kernel (via `clone3` + `set_tid`) for PID 6072 and the
kernel said no — that number is taken. (If 6072 happens to be free but you
have another process squatting a PID inside the tree, you get the same class
of failure.) This is not CRIU being fragile; it's the whole reason production
migration restores into a **fresh PID namespace**, where the original numbers
are guaranteed available. Which is the perfect segue to the container
porcelain.

## Stage 5 — The porcelain

Everything so far was CRIU by hand. In production you almost never call `criu`
directly — a container runtime does, wrapping the dump/restore in namespace
and rootfs handling. `podman` (via `runc`/`crun`, which link CRIU) gives you a
one-command checkpoint that produces a single portable tarball. Because the
container has its *own* PID namespace, the occupied-PID problem from Stage 4b
simply cannot happen: inside the container the process might be PID 1, and a
restored container gets a brand-new PID namespace.

Start a small, long-running container that holds visible state. Python stays
as one process while `time.sleep()` blocks, so the image anatomy remains easy
to read:

```bash
sudo podman run -d --name counter docker.io/library/python:3.13-alpine \
  python3 -u -c 'import time
i=0
while True:
    print(i); i += 1; time.sleep(1)'
```

```text
9f1c8b2e7a4d6c05e3f1a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8
```

Watch it count, then note where it is:

```bash
sudo podman logs counter | tail -3
```

```text
25
26
27
```

**Checkpoint it to a tarball.** `--export` (`-e`) writes a single archive you
could copy anywhere:

```bash
sudo podman container checkpoint counter --compress=gzip --export=/tmp/ckpt.tar.gz
```

```text
9f1c8b2e7a4d6c05e3f1a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8
```

The original container is now **stopped** (checkpoint stops it by default — same
philosophy as `criu dump`; add `--leave-running`/`-R` to keep it up). Confirm:

```bash
sudo podman ps -a --filter name=counter --format '{{.Names}} {{.Status}}'
```

```text
counter Exited (0) 4 seconds ago
```

**Inspect the tarball.** This is the payload that a migration would ship over
the wire — let's see what's inside:

```bash
tar tf /tmp/ckpt.tar.gz | head -25
```

```text
checkpoint/
checkpoint/inventory.img
checkpoint/pstree.img
checkpoint/core-1.img
checkpoint/mm-1.img
checkpoint/pagemap-1.img
checkpoint/pages-1.img
checkpoint/files.img
checkpoint/fs-1.img
checkpoint/ids-1.img
checkpoint/fdinfo-2.img
checkpoint/stats-dump
spec.dump
config.dump
rootfs-diff.tar
deleted.files
network.status
```

Look closely — inside `checkpoint/` are **the exact same image families you
dumped by hand in Stage 1** (`inventory.img`, `pstree.img`, `core-1.img`,
`pages-1.img`, …), except the PID is now `1` because the process is PID 1 in
its own namespace. Podman just wraps them with container metadata:

- **`spec.dump` / `config.dump`** — the OCI runtime spec and container config,
  so restore recreates the same namespaces, mounts, and cgroups.
- **`rootfs-diff.tar`** — files the container *wrote* to its root filesystem
  since it started (the copy-on-write delta), so restore rebuilds the exact
  on-disk state, not just memory.
- **`network.status`** — the container's network config to re-establish.

**Restore from the tarball.** The stopped source container still owns the
name `counter`, so give this imported copy a new local identity. The process
state itself still resumes where it stopped:

```bash
sudo podman container restore --import=/tmp/ckpt.tar.gz \
  --name counter-restored
```

```text
9f1c8b2e7a4d6c05e3f1a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8
```

```bash
sleep 3 && sudo podman logs counter-restored | tail -4
```

```text
27
28
29
30
```

It picked up at **28**, right after the `27` it was on when checkpointed — the
same continuity you saw with raw CRIU in Stage 2, now wrapped in a container
and carried in a single file.

This archive is a **cold-migration payload**, not a universal machine image.
Moving it to another host also requires a compatible architecture, CPU and
kernel feature envelope, CRIU/Podman/runtime and cgroup setup, plus matching
external files, images and volumes. Preserving a TCP connection additionally
requires `--tcp-established` at checkpoint and restore, and the destination
must take over the saved address and routing; the flag does not migrate an IP
address by itself. Under those constraints, copy the archive to the
destination and import it there. [Live Migration](#/live-migration) adds
pre-copy, a short final stop, network cutover and rollback discipline to this
basic mechanism.

### Cleanup

```bash
sudo podman rm -f counter counter-restored 2>/dev/null
rm -f /tmp/ckpt.tar.gz
# In terminal A, press Ctrl-C to stop the Stage-4 server.
kill "$TCP_PID" 2>/dev/null
# These are the lab's explicit scratch directories:
rm -rf ~/ckpt ~/ckpt-copy ~/ckpt-tcp-fail ~/ckpt-tcp-ok
```

---

## Check your understanding

1. After `sudo criu dump -t "$PID" -D ~/ckpt --shell-job`, terminal A's counter
   disappeared and the shell prompt returned. Is this a bug? How do you keep
   the process alive across a checkpoint?

<details><summary>Show answer</summary>

Not a bug — it's the default. `criu dump` **kills** the checkpointed process,
because checkpoint is normally the first half of a migration and leaving the
original running would create two divergent copies. To take a snapshot without
killing, add `--leave-running` (`-R`), which leaves the process running after
the images are written.

</details>

2. What does `--shell-job` actually tell CRIU, and what error do you get
   without it when dumping a process started from an interactive shell?

<details><summary>Show answer</summary>

It tells CRIU that the job's controlling terminal (the pts master and the
session leader — your shell) lives *outside* the process set being dumped, so
CRIU should treat the pty as an external inherited fd rather than refusing.
Without it you get `tty: Found dangling tty ... Consider using --shell-job
option.` because CRIU won't guess how to handle a terminal whose other end
isn't in the dump.

</details>

3. In Stage 2 the restored process kept the same PID, 6072. How does CRIU
   force a specific PID, and what happens if that PID is already in use?

<details><summary>Show answer</summary>

On kernels and restore paths that support it, CRIU can use `clone3()` with the
`set_tid` array to request saved PID/TID values. It also has compatibility
paths for older kernels, including carefully steering the namespace PID
allocator. Whichever path is selected, an occupied saved PID makes restore
fail. This is why container restore normally constructs a fresh PID namespace
where the saved namespace-local numbers are available.

</details>

4. Using CRIT, which image holds the saved instruction and stack pointers?
   Why can their field names vary? Which image holds the actual bytes of the
   process's memory?

<details><summary>Show answer</summary>

`core-<pid>.img` holds the architecture-specific register file. On x86-64,
the decoded general-register schema commonly exposes instruction and stack
pointers as `ip` and `sp`; another CRIU version or architecture may present a
different register layout. The restorer reloads this saved CPU context before
resuming execution. Raw memory *contents* live in `pages-<id>.img`, indexed by
virtual address through `pagemap-<pid>.img`.

</details>

5. Dumping a process with an established TCP connection fails with `inet:
   Connected TCP socket, consider using --tcp-established option`. Why does
   CRIU require an explicit opt-in for this, and what does the flag make CRIU
   do?

<details><summary>Show answer</summary>

An established connection has kernel-side state (sequence numbers, send/recv
queues) *and* a live peer that could send an RST if the connection misbehaves
during the freeze. Capturing it safely requires putting the socket into
`TCP_REPAIR` mode and briefly installing a netfilter rule to silence the peer
— side effects CRIU won't perform without your consent. `--tcp-established`
grants that consent; CRIU then reads and later replays the connection state so
the socket is rebuilt intact.

</details>

6. `tar tf /tmp/ckpt.tar.gz` shows a `checkpoint/` directory of `.img` files
   plus `spec.dump`, `config.dump`, and `rootfs-diff.tar`. How does the
   `checkpoint/` content relate to what you dumped by hand in Stage 1, and
   what do the extra files add?

<details><summary>Show answer</summary>

The `checkpoint/` portion contains the *same CRIU image families* you
produced by hand (`inventory.img`, `pstree.img`, `core-*.img`, `pages-*.img`,
etc.) — podman just calls CRIU under the hood. The extras are container-level:
`spec.dump`/`config.dump` recreate the namespaces, mounts, and cgroups;
`rootfs-diff.tar` carries the container's copy-on-write filesystem changes so
on-disk state is restored too, not just memory. Exact archive members depend
on Podman/runtime versions and options; the export is one possible
cold-migration payload, subject to the host and external-resource constraints
described in Stage 5.

</details>

---

## Sources & further reading

- [CRIU — Checkpoint/Restore In Userspace](https://criu.org/Main_Page) — the project's home, with the full command and image documentation.
- [Simple loop — CRIU](https://criu.org/Simple_loop) — the canonical shell-job walkthrough; this lab uses a single-process C victim to make the state unambiguous.
- [CRIT — CRIU Image Tool](https://criu.org/CRIT) — `crit decode`, the image format, and how `--pretty` renders registers and addresses.
- [Images — CRIU](https://criu.org/Images) — the image file format and the meaning of each `.img` family.
- [TCP connection — CRIU](https://criu.org/TCP_connection) — TCP repair mode and why `--tcp-established` is required (Stage 4a).
- [podman-container-checkpoint(1)](https://docs.podman.io/en/latest/markdown/podman-container-checkpoint.1.html) and [podman-container-restore(1)](https://docs.podman.io/en/latest/markdown/podman-container-restore.1.html) — the `--export`, `--import`, `--tcp-established`, and `--leave-running` flags used in Stage 5.
- [criu(8)](https://man7.org/linux/man-pages/man8/criu.8.html) — the full flag reference: `dump`, `restore`, `check`, `-t`, `-D`, `--shell-job`, `--leave-running`.
- [Checkpoint/Restore — kernel docs](https://docs.kernel.org/admin-guide/mm/index.html) and `CONFIG_CHECKPOINT_RESTORE` — the kernel support CRIU depends on.

---

**Next:** CRIU restores saved pages eagerly, but the same kernel feature that
powers its *lazy* page restore — filling memory on demand from userspace — is
worth driving yourself. Serve page faults by hand in
[Lab: Serve Page Faults from Userspace](#/lab-userfaultfd).
