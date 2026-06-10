# Docker, containerd, runc

> **Goal:** untangle the container software stack. "Docker" is four programs
> in a trenchcoat; we'll meet each layer, see who really talks to the kernel,
> and place podman, Kubernetes, and the OCI standards on the map.

## The stack, top to bottom

When you type `docker run nginx`, this is the chain of command:

```text
docker (CLI)                you type here
   │  REST API over /var/run/docker.sock
   ▼
dockerd                     the Docker daemon: API, images, volumes,
   │                        networks, builds, logs
   │  gRPC
   ▼
containerd                  the container lifecycle manager:
   │                        pulls images, manages snapshots (overlayfs),
   │                        starts/stops/supervises containers
   │  spawns (via a thin "shim" per container)
   ▼
runc                        the OCI runtime: performs THE EIGHT STEPS
   │                        (namespaces, cgroups, pivot_root, caps, seccomp)
   │                        then execve()s your process — and EXITS
   ▼
the kernel                  the only thing that was ever "running" containers
```

The division of labour:

| Layer | Job | If it dies… |
|---|---|---|
| `docker` CLI | UX: parse flags, call the API | nothing happens to containers |
| `dockerd` | API server, image builds, volumes, networks | containers keep running (live-restore) |
| `containerd` | image pulls, snapshots, container supervision | containers keep running (shim) |
| `containerd-shim` | tiny per-container babysitter: holds stdio, reports exit | (one per container; if it dies, container is orphaned) |
| `runc` | assemble isolation, exec the process, **exit immediately** | it's already gone |

Two facts that reorganize one's mental model:

- **runc is not a daemon.** It's a short-lived CLI that does the
  build-a-container chapter's work and vanishes. Nothing called "runc" runs
  while your container runs. The previous chapter *was* the runtime chapter.
- **Your container is not "inside" anything.** It's a process, parented by a
  small shim, supervised by containerd. `pstree` makes it concrete:

```bash
docker run -d --name web nginx
pstree -p | grep -A2 containerd
# containerd-shim(…)───nginx(…)───nginx(…)    ← no dockerd in the ancestry!
```

(That's also why `dockerd` can restart — or crash — without killing your
containers: the `live-restore` option, possible only because of the shim
design.)

### Why the shim exists

The shim solves a fundamental disconnect: runc finishes its job, execs the
container, and exits. But someone needs to:
- Be the container's parent (for wait() and exit status collection).
- Hold the container's stdin/stdout/stderr open.
- Report the exit code back to containerd.

Without the shim, containerd itself would need to be the parent — and a
containerd restart would orphan every container. The shim is the decoupling
layer: runc → shim → container. The shim also handles the `docker attach`
protocol (io streams) and the exit event.

```bash
# See the shim's relationship to the container:
ls -l /proc/$(pgrep -f nginx)/fd/1    # stdout is a pty/socket via the shim
cat /proc/$(pgrep containerd-shim)/status | grep PPid  # shim is containerd's child
```

## OCI: the standards that decoupled everything

The **Open Container Initiative** (2015) froze the formats, ending the
docker-or-nothing era:

- **OCI Image Spec** — what an image is: layer tarballs + config + manifest
  (you met it in the overlayfs chapter).
- **OCI Runtime Spec** — what a runtime must do: given a `config.json`
  (namespaces, mounts, caps, seccomp, cgroup values — every knob from the
  previous chapter, as JSON) and a rootfs dir, create the container.
- **OCI Distribution Spec** — the registry HTTP API (push/pull/manifest).

You can drive the bottom layer yourself, no Docker anywhere:

```bash
mkdir -p bundle/rootfs                       # rootfs: e.g. the alpine untar
cd bundle && runc spec                       # generates a default config.json
less config.json     # ← namespaces, capabilities, seccomp… all the knobs, in JSON
sudo runc run mycontainer                    # a container. From a JSON file.
```

Because of OCI, the pieces are swappable:

- **Other OCI runtimes** drop in below containerd: `crun` (C, faster than
  runc's Go), **gVisor**'s runsc (syscalls served by a user-space kernel in
  Go — no host kernel syscalls from the container), **Kata Containers** (each
  container in a lightweight micro-VM with its own kernel) — the
  containers-overview chapter's security spectrum, as products.
- **Other image builders** (buildah, kaniko, bazel, ko) and **registries**
  all interoperate because they all speak OCI.

```bash
# Try crun:
sudo apt install crun
containerd config default | grep "runtime_type"  # see available runtimes
# Run with crun: docker run --runtime=crun alpine echo hello
```

## podman and the daemonless model

**podman** = the Docker UX without the daemon and (optionally) without root:

```text
docker:  CLI → dockerd (root) → containerd → runc → process
podman:  CLI ──────────────────────────────→ runc → process (your child!)
```

- No daemon: containers are children of *your* command (or of a tiny
  per-user service for `-d`/`--restart`); systemd integrates naturally
  (`podman generate systemd`, Quadlet).
- **Rootless**: leaning on user namespaces (namespaces chapter): container
  UID 0 = your UID, unprivileged on the host; networking via a user-space
  packet relay (slirp4netns or pasta) since you can't create veths as
  non-root. The CLI is intentionally identical (`alias docker=podman` mostly
  works).
- Podman's "containers" are regular systemd services under the hood
  (`systemctl --user status <container>`).

Docker has rootless mode too (dockerd-rootless-setuptool.sh), these days.
The architectural lesson matters more than the brand: *the daemon was never
necessary* — the kernel doesn't know what a daemon is.

## Where Kubernetes plugs in

Kubernetes never talked to "Docker" conceptually — it needs only "start these
containers, grouped in pods". The **kubelet** speaks **CRI** (Container
Runtime Interface, gRPC) to:

```text
kubelet ──CRI──► containerd (with its CRI plugin)  ──► runc/crun → processes
            or ► CRI-O (a CRI-native slim alternative) ──► runc/crun
```

The 2020 "Kubernetes drops Docker support!" panic, decoded: kubelet stopped
using the *dockershim* adapter that translated CRI→dockerd. The images are
OCI, identical, built by anything; only a middleman daemon left the call
path. Nothing about anyone's images changed.

A **pod**, kernel-wise, is elegant: containers that **share** net + IPC
(+ optionally PID) namespaces while keeping their own mnt namespaces. The
shared net namespace is held by a parked "pause" container; that's why
containers in a pod reach each other on `localhost`. With the namespaces
chapter behind you, pods are obvious rather than mysterious.

```bash
# See the pause container on a K8s node:
crictl pods             # list pods (via CRI)
crictl inspect <pod-id> | jq '.status.linux.namespaces'
```

## Choosing tools, practically

- **Docker** — ubiquitous, best onboarding, Compose for local dev. Fine
  default on dev machines and simple deployments.
- **podman** — daemonless/rootless; the natural choice on servers managed by
  systemd, and on RHEL-family distros. Play Kube deploys K8s pods locally.
- **containerd + nerdctl** — what you're often *actually* running under
  Docker/K8s; `nerdctl` gives it a Docker-compatible CLI. Lightweight,
  production-grade.
- **crun / gVisor / Kata** — swap-in runtimes for speed / syscall isolation /
  VM-grade isolation respectively.
- **Firecracker + containerd** — the AWS Fargate/Lambda model: micro-VM per
  container, fast as a container, isolated as a VM.

They all converge on the same OCI bundle and the same eight steps against
the same kernel. The differences are ergonomics, trust boundaries, and
performance characteristics — not kinds of magic.

### A real-world profile: what runs on a K8s node

```bash
ps auxf | grep -E 'containerd|runc|shim'
# /usr/bin/containerd
#  \_ containerd-shim-runc-v2 -namespace k8s.io -id <pod-id>
#      \_ /pause                          ← the infrastructure container
#      \_ /usr/local/bin/myapp            ← your workload
# The shim is the parent. Containerd is the grandparent. No dockerd anywhere.
```

## Try it yourself

```bash
docker info | grep -A3 'Runtimes'        # see runc registered, maybe others
pstree -p | grep -B1 -A2 shim            # find your containers' real parents
sudo ctr --namespace moby containers ls  # talk to containerd directly,
                                         # behind dockerd's back
runc spec --help; runc --help            # the OCI runtime CLI, standalone
sudo ctr --namespace moby tasks ls       # list running containers via containerd
# Rootless Docker:
dockerd-rootless-setuptool.sh check      # prerequisites for rootless mode
```

## Check your understanding

1. `dockerd` crashes. What happens to running containers, and which design
   choice makes that possible?
2. What exactly does runc do, and for how long does it run?
3. In kernel terms, what is a Kubernetes pod?
4. Why can podman do its job without any daemon?
5. What is the shim's role — why can't containerd directly be the container's
   parent?

*(Answers: containers keep running — the containerd-shim is their parent and
holds their namespaces open; runc creates namespaces via clone/unshare,
applies cgroup limits, sets up rootfs via pivot_root, drops capabilities,
installs seccomp, then execs the entrypoint and exits — it runs for
milliseconds; a pod is a set of processes sharing net+IPC (and optionally PID)
namespaces, held open by a pause container, each with their own mnt namespace;
podman calls runc directly per-container — there's no persistent process
between the user's command and the container, just like `unshare` doesn't
need a daemon; the shim decouples containerd from the container's lifecycle —
runc exits after setup, the shim becomes the parent to receive exit status
and hold stdio, so containerd can restart without orphaning containers.)*

---

**Next:** the last assembly chapter — wiring containers to the network:
veth, bridges, NAT, port publishing, and DNS.
