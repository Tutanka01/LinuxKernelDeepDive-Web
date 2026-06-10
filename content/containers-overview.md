# What a Container Actually Is

> **Goal:** dismantle the magic. By the end of this chapter you'll be able to
> state precisely what a container is, what it is *not*, and which kernel
> features (each getting its own chapter next) combine to make one.

## The one-sentence truth

> **A container is just a normal Linux process (or process tree) that the
> kernel is lying to.**

There is no "container" object in the kernel. No container subsystem, no
special execution mode, no hypervisor. If you search the kernel source for a
container data type, you won't find one. What exists is a set of independent
kernel features that, *combined*, give a process:

1. a **restricted view** of the system — it sees its own PIDs, hostname,
   network interfaces, mounts (→ **namespaces**);
2. a **restricted share** of resources — capped CPU, memory, I/O
   (→ **cgroups**);
3. a **different filesystem** as its `/` — assembled from image layers
   (→ **OverlayFS** + `pivot_root`);
4. **reduced privileges** — dropped capabilities, filtered syscalls
   (→ capabilities, **seccomp**, LSMs).

"Container" is the *marketing name for this combination*. Docker's true
innovation wasn't isolation technology — it was packaging (images, layers,
registries) and developer experience.

## A brief history of containerization on Linux

Containers didn't start with Docker. The ingredients accumulated over decades:

- **1979**: `chroot` — change the root directory for a process. The first
  "jail".
- **2000**: FreeBSD Jails — chroot + process isolation + network isolation.
  A real container, before the word existed.
- **2001**: Linux-VServer — OS-level virtualization with separate process
  spaces, before namespaces existed upstream.
- **2005**: Solaris Zones (and later Solaris Containers) — a complete
  container system with resource controls and ZFS snapshots. Years ahead.
- **2006**: Google introduces **cgroups** (then "process containers") to the
  Linux kernel to isolate resource usage in Borg.
- **2007**: Eric Biederman begins upstreaming **namespaces** into mainline.
- **2008**: **LXC (Linux Containers)** — the first full Linux container
  system, using both namespaces and cgroups directly.
- **2013**: **Docker** — LXC under the hood, but adds images, layers, a
  registry, and an elegant UX. "Build, Ship, Run" changes the industry.
- **2015**: **OCI** standardizes the image and runtime formats. Docker
  splits into runc (the OCI runtime) and containerd (the lifecycle manager).
- **2018+**: **Kubernetes** becomes the orchestrator; rootless containers
  (podman), user namespaces, and eBPF-based networking emerge.

The historical arc: the kernel added primitive features; each wave of
tooling composed them more ergonomically. The primitives haven't changed
fundamentally — they only became more powerful and better integrated.

## Prove it to yourself in 30 seconds

Run a container and look at it *from the host*:

```bash
docker run -d --name test nginx
ps aux | grep nginx        # ← there it is. A regular process. On YOUR host.
```

The nginx "inside" the container appears in the host's process list with a
normal host PID. Same kernel, same scheduler, same `task_struct`. From inside
the container it thinks it's PID 1; from outside it's PID 48213. That double
vision — one process, two views — is namespaces at work, nothing more.

```bash
docker exec test ps aux    # inside: nginx is PID 1, alone in the world
uname -r; docker exec test uname -r    # identical: SAME kernel
cat /proc/$(docker inspect -f '{{.State.Pid}}' test)/cgroup  # in the host cgroup tree
docker rm -f test
```

That last command is the punchline: an Alpine container, an Ubuntu container,
and your Fedora host all report the same kernel version, because **the kernel
is never in the image**. Images contain only user space (chapter 1's
distinction paying off): a libc, a shell, some binaries.

## Containers vs virtual machines

The comparison everyone needs once, precisely:

```text
   VIRTUAL MACHINE                    CONTAINER
┌──────────────────┐            ┌──────────────────┐
│ app              │            │ app              │
│ guest user space │            │ image user space │
│ GUEST KERNEL     │            │ (no kernel!)     │
├──────────────────┤            ├──────────────────┤
│ virtual hardware │            │                  │
│ hypervisor       │            │   HOST KERNEL    │  ← shared, namespaced
│ HOST KERNEL      │            │                  │
└──────────────────┘            └──────────────────┘
```

| | VM | Container |
|---|---|---|
| Isolation boundary | virtual *hardware*; guest runs its own kernel | kernel *API*; syscalls filtered & namespaced |
| Startup | seconds (boot a kernel) | milliseconds (fork a process + exec) |
| Overhead | GBs (guest OS), reserved RAM | MBs; just processes + page cache sharing |
| Density | tens per host | hundreds–thousands per host |
| Can run another OS? | yes (Windows on Linux) | no — Linux user space only |
| Security boundary | strong (hardware-assisted, nested EPT) | good but: **one kernel bug from escape** |

That security line deserves honesty: every container on a host talks to one
shared kernel through ~450 syscalls. A kernel vulnerability reachable from
inside a container can mean escape to the host. This is why high-stakes
multi-tenant platforms wrap containers in micro-VMs (**Firecracker**, **Kata
Containers**) or user-space kernels (**gVisor**) — and why defense-in-depth
(seccomp, dropped capabilities, user namespaces) matters rather than being
paranoia.

```text
Container security spectrum:

bare container    (namespaces + limited caps)
  → + seccomp      (reduced syscall surface)
  → + user ns      (root inside ≠ root outside)
  → + gVisor       (user-space kernel, no host syscalls from container)
  → + Kata/Firecracker (each container in its own micro-VM, full kernel isolation)
```

(Fun fact closing the loop: Docker Desktop on macOS/Windows runs a hidden
Linux VM, because containers *are* Linux processes and need a Linux kernel.)

## The ingredient list

Here is the full recipe — and the map of the next six chapters:

| Ingredient | Kernel feature | Gives the container | Chapter |
|---|---|---|---|
| Own PIDs, hostname, mounts, network… | **namespaces** | its private *view* | Namespaces |
| CPU/memory/IO limits | **cgroups v2** | its bounded *share* | Control Groups |
| Its own `/` built from layers | **OverlayFS**, `pivot_root` | its *filesystem* | Images & OverlayFS |
| Reduced root | **capabilities** | no dangerous powers | Build-by-hand |
| Syscall filter | **seccomp-BPF** | smaller kernel attack surface | Build-by-hand |
| MAC policy | AppArmor/SELinux | belt-and-suspenders | (mentioned) |

A useful mental formula:

```text
container = namespaces (view)
          + cgroups    (share)
          + overlayfs  (disk)
          + seccomp/caps (security)
          + a process tree
```

Each ingredient is independent and usable alone — that's the beauty. systemd
uses cgroups for every service with zero namespaces. `unshare -n` gives you a
network namespace with no container in sight. Chrome sandboxes tabs with
namespaces + seccomp. Once you know the ingredients, you see them everywhere.

### A note on pod architecture

A Kubernetes **pod** is a group of containers that share **network** and
**IPC** namespaces (and optionally PID). They reach each other on `localhost`.
This is achieved by: create the shared namespaces, then fork each container
process into them via setns/clone. A "pause" container holds the shared
net/IPC namespaces open (since a namespace dies when its last process exits).
This is why `localhost` works within a pod but not between pods.

## A 10-line container, as a teaser

Everything Part III will explain, compressed (run as root on any Linux box):

```bash
mkdir -p /tmp/rootfs && cd /tmp/rootfs
curl -sL https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.0-x86_64.tar.gz | tar xz

unshare --pid --fork --mount --uts --net --ipc \
        chroot /tmp/rootfs /bin/sh -c '
          mount -t proc proc /proc
          hostname my-container
          ps aux            # ← we are PID 1!
          sh'
```

No Docker installed, and you're inside something that walks and talks like a
container — because `unshare(2)` + a root filesystem *is* a container. The
"Build a Container by Hand" chapter does this properly (pivot_root, cgroups,
caps, seccomp — the full assembly) and explains every line.

## Vocabulary, fixed once and for all

- **Image** — a read-only, layered tarball of a user space + metadata
  (config, env, entrypoint). A *file*, essentially. Defined by the OCI Image
  Spec.
- **Container** — a *running instance*: process(es) + namespaces + cgroup +
  a writable layer on top of an image. Image : container :: program : process.
- **Registry** — an HTTP server implementing the OCI Distribution Spec,
  storing and serving images (Docker Hub, ghcr.io, ECR, GCR…).
- **Runtime** — the program that actually assembles namespaces/cgroups and
  starts the process (`runc`, `crun`). The runtime is NOT a daemon — it runs,
  sets up the container, execs the entrypoint, and exits.
- **Shim** — a tiny process that stays alive as the container's parent after
  the runtime exits, holding stdio and reporting the exit status to containerd.
- **Snapshotter** — manages the layered filesystem (e.g. overlay2, btrfs).
- **Orchestrator** — Kubernetes, Docker Swarm, Nomad: schedules containers
  across nodes.

## Check your understanding

1. Why does `uname -r` report the same thing in every container on a host?
2. Where does a containerized process appear in the host's `ps`? Why?
3. Name the four ingredient groups and what each contributes.
4. Why can't a Linux host run a Windows *container* natively?
5. What's the difference between a runtime, a shim, and containerd?

*(Answers: the kernel is shared — containers run on the host kernel, no guest
kernel exists, so the kernel version is the host's; the container's processes
are regular host processes with different namespaces — they appear in the host
ps because there is one process table, namespaces just give different PIDs for
the same entries; namespaces (restricted view of PIDs, network, mounts, etc.),
cgroups (resource limits and accounting), OverlayFS + pivot_root (layered
filesystem), seccomp + capabilities (privilege reduction); Windows containers
require a Windows kernel — Linux containers are Linux processes that need a
Linux kernel, and vice versa. Docker Desktop runs a VM for the other OS; the
runtime (runc) does the one-shot assembly of namespaces/cgroups and execs the
process, then exits; the shim stays alive as the container's parent for stdio
and exit reporting; containerd manages the lifecycle, pulling images,
supervising shims, and providing the gRPC API.)*

---

**Next:** the first and biggest ingredient — namespaces, the kernel's
machinery for lying to processes about the world.
