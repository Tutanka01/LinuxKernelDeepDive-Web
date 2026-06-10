# Namespaces

> **Goal:** master the kernel feature at the heart of containers. Each
> namespace type virtualizes one global resource; we'll tour all eight with
> hands-on commands, and see how `unshare`/`setns` create and enter them.

## The idea

Many things in a classic Unix system are **global**: the process table, the
hostname, the mount table, the network interfaces, user IDs. Every process
sees the same ones.

A **namespace** wraps one of these globals in a private copy. Processes
inside the namespace see *their* copy and genuinely cannot name, address, or
see anything outside it. It's not hiding (like a permission check) — inside a
PID namespace there simply *is no* PID for an outside process; the outside
world is unaddressable.

Remember `task_struct → nsproxy` from the processes chapter: each task holds
pointers to one namespace of each type. "Being in a container" = those
pointers aim at non-default namespaces. Nothing else.

```bash
ls -l /proc/$$/ns/        # your shell's namespaces — every process has them!
```

```text
cgroup → cgroup:[4026531835]     ipc  → ipc:[4026531839]
mnt    → mnt:[4026531841]        net  → net:[4026531840]
pid    → pid:[4026531836]        time → time:[4026531834]
user   → user:[4026531837]       uts  → uts:[4026531838]
```

You are *already* in namespaces — the initial, default ones. Two processes
are "in the same container", kernel-wise, exactly when these inode numbers
match.

## The eight namespaces

| NS | Virtualizes | Container effect |
|---|---|---|
| **mnt** | the mount table | its own filesystem tree |
| **pid** | the process table | its own PID 1, sees only itself |
| **net** | interfaces, routes, firewall, ports | its own private network stack |
| **uts** | hostname | its own hostname |
| **ipc** | System V/POSIX IPC objects | no shared-memory snooping |
| **user** | UID/GID mappings | "root inside" ≠ root outside |
| **cgroup** | the cgroup tree view | can't see/escape host hierarchy |
| **time** | boot/monotonic clocks | own view of uptime (CRIU restore) |

The three syscalls that drive everything:

- `clone(CLONE_NEW…)` — create a child *in* new namespaces (processes
  chapter's punchline);
- `unshare(CLONE_NEW…)` — move *yourself* into new namespaces;
- `setns(fd, …)` — join an *existing* namespace via its `/proc/…/ns/…` file.
  This is exactly what `docker exec` does: open the target's ns files, setns
  into each, fork your command inside.

The `unshare(1)` and `nsenter(1)` CLI tools wrap these — our lab equipment
for the rest of the chapter. (Everything below needs root or user namespaces.)

### Namespace lifecycle

A namespace exists as long as at least one process is in it (or a file
descriptor points to its /proc/<pid>/ns/… entry). When the last process
exits or releases the fd, the namespace is destroyed. Inside a PID namespace,
when PID 1 exits, the kernel sends SIGKILL to all other processes in the
namespace — the namespace vanishes cleanly.

## UTS: the warm-up

```bash
sudo unshare --uts sh -c 'hostname inside-the-matrix; hostname; sh'
# new shell says: inside-the-matrix
hostname        # from another terminal: unchanged. The lie is contained.
```

One flag, one private hostname. Trivial — but it proves the pattern all the
others follow.

## PID: your own process universe

```bash
sudo unshare --pid --fork --mount-proc sh
ps aux
#   PID  COMMAND
#     1  sh          ← we are PID 1 of a new universe
#     2  ps
```

What's really going on:

- The *first child* in the new PID namespace becomes **PID 1** there, with
  init's duties: reap zombies (remember the chapter on processes — this is
  the `docker run --init` story) and a special signal regime.
- PIDs are **layered**: the same task has PID 1 inside and PID 48213 in the
  parent namespace. The host sees everything (with shifted PIDs); the inside
  sees only itself. Isolation is asymmetric, by design — that's why `docker
  top`, host monitoring, and `kill` from the host all work.
- `--mount-proc` matters: `ps` reads `/proc`, so a fresh procfs must be
  mounted *for this namespace* — otherwise you'd see the host's `/proc` and
  the illusion would leak. Lesson: **namespaces compose**; pid alone isn't
  enough without mnt.
- You can't `unshare` your own PID namespace and stay — hence `--fork`:
  the *next child* enters it.

```bash
# See the layered PIDs from the host:
PID=$(pgrep -f "unshare.*pid")
cat /proc/$PID/status | grep -E 'Pid|NSpid'
# NSpid: 48213  1   ← outer-inner PID mapping
```

## Mount: your own filesystem tree

```bash
sudo unshare --mount sh
mount -t tmpfs none /mnt       # mount something…
ls /mnt                        # visible here
# other terminal: ls /mnt     → empty. Host never saw it.
```

Each mnt namespace has its own mount table. Combined with `pivot_root` — which
swaps the namespace's `/` for a directory of your choosing — this gives
containers their own root filesystem. One subtlety worth knowing: **mount
propagation** (`shared`/`private`/`slave`) controls whether mount events
cross namespace copies. Container runtimes set everything `private` so
container mounts never leak to the host.

```bash
cat /proc/self/mountinfo | awk '{print $NF, $7}'  # see propagation flags
# / private ← no propagation
# /sys shared:1 ← shared with group 1
```

## Net: your own network stack

The richest one. A new net namespace contains: a loopback (down), no other
interfaces, empty routes, empty firewall, **its own port space**:

```bash
sudo unshare --net sh
ip addr          # only lo, and it's DOWN. Total network silence.
ip link set lo up  # bring loopback up first thing
```

Two namespaces can both bind `0.0.0.0:80` without conflict — different port
spaces. This is how every container can listen on "port 80".

Connecting a namespace to the world = the veth-pair-into-bridge plumbing from
the networking chapter; the Container Networking chapter wires it end-to-end.

## User: the cleverest one

User namespaces **remap identities**: a process can be UID 0 *inside* while
being unprivileged UID 100000 *outside*:

```bash
unshare --user --map-root-user sh    # look ma, no sudo!
id        # uid=0(root) … inside
touch /etc/test-file     # Permission denied — root powers stop at the border
```

The mapping is just two files (`/proc/<pid>/uid_map`, `gid_map`):
`0 100000 65536` = "inside UIDs 0–65535 are outside UIDs 100000–165535".

Why this is a big deal:

- It's the only namespace creatable **without privilege** — the foundation of
  **rootless containers** (podman, rootless Docker): full container UX, no
  daemon running as root, container "root" = your own user in disguise.
- Capabilities (next chapters) are evaluated *relative to the user
  namespace*: "root inside" has full caps over namespaced resources but none
  over the host's. A container escape lands as UID 100000 — a nobody.
- The `/etc/subuid` and `/etc/subgid` files configure the ranges for each
  host user.

```bash
cat /etc/subuid
# makhal:100000:65536    ← this user gets a block of 65536 UIDs for remapping
```

## Watching real containers' namespaces

```bash
docker run -d --name web nginx
PID=$(docker inspect -f '{{.State.Pid}}' web)
sudo ls -l /proc/$PID/ns/        # different inodes than your shell = isolated
lsns -p $PID                     # dedicated ns tool: tree view with ownership
sudo nsenter -t $PID -n ip addr  # enter JUST its net ns: see eth0, 172.17.x.x
sudo nsenter -t $PID -a sh       # enter all → this is ~exactly docker exec
docker rm -f web
```

`nsenter -t <pid> -n <cmd>` is a superpower worth memorizing: run *host*
tools (which the slim image lacks!) inside a container's *network* — the
canonical way to debug a distroless container with no shell.

```bash
# Even more specific: enter just mnt and net, leave the rest alone
sudo nsenter -t $PID -m -n -- ip addr
```

## What namespaces do NOT cover

Honesty section. Things that remain shared and visible despite all eight:

- **The kernel itself** — one kernel, all its bugs, shared by everyone.
- `/proc/cpuinfo`, `/proc/meminfo`, load average — containers see *host*
  totals (the classic "my JVM sized its heap from host RAM" bug; runtimes
  paper over it with tricks like lxcfs, or apps read cgroup files instead).
- The clock (time ns covers only boot/monotonic offsets, not wall time).
- Kernel keyrings, `/sys/kernel`, `/dev/kmsg` — the long tail that seccomp
  and LSMs exist to fence off.

Namespaces give the *view*; they don't limit *consumption* — a namespaced
process can still eat all RAM and CPU. For that, the next chapter: cgroups.

## Check your understanding

1. Why does `ps` inside a new PID namespace still show host processes until
   you remount `/proc`?
2. What does `docker exec` do, in syscall terms?
3. Why are user namespaces the key to rootless containers?
4. Two processes — how do you check, from the host, whether they're in the
   same "container"?
5. A namespace is destroyed when its last process exits. How can you keep a
   namespace alive for inspection?

*(Answers: `ps` reads `/proc` which is host-mounted; the host's procfs shows
the host's PID table — remounting proc in the PID namespace gives a procfs
that shows only the namespace's PIDs; it open()s the target process's
/proc/<pid>/ns/ files for each namespace type, calls setns() on each, then
forks a child that exec()s the command inside the joined namespaces; user
namespaces allow unprivileged users to create namespaces where they appear
as root — the container's "root" is mapped to a non-zero UID on the host,
making rootless containers possible with no daemon running as root; compare
the inode numbers in /proc/<pid1>/ns/ and /proc/<pid2>/ns/ — matching inodes
= same namespace; bind-mount /proc/<pid>/ns/<type> to a file — the fd keeps
a reference, or use `unshare --mount=/run/my-ns mount` to persist.)*

---

**Next:** namespaces control what you *see*; cgroups control what you may
*consume*. The other half of containment.
