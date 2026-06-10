# Build a Container by Hand

> **Goal:** the payoff. Using only stock Linux tools — no Docker, no podman —
> we assemble a real container: root filesystem, namespaces, pivot_root,
> cgroup limits, dropped capabilities, seccomp. Every line explained by a
> previous chapter.
>
> **Setup:** any Linux box/VM you can root. Everything lives in `/tmp`, but
> read each command before running it — this is real root surgery.

## Step 0 — A root filesystem

A container needs a user space for its `/`. Alpine publishes theirs as a
5 MB tarball (this is literally what's inside the `alpine` image):

```bash
export R=/tmp/ctr/rootfs
mkdir -p $R && cd /tmp/ctr
curl -sLo alpine.tgz https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz
tar xzf alpine.tgz -C $R
ls $R     # bin etc home lib … a complete tiny user space. No kernel — of course.
```

*(For full fidelity you could mount this as an overlay — lowerdir = this
tarball, upperdir = scratch — exactly as in the previous chapter. We skip it
here to keep the focus on isolation.)*

### Inspect what you'll be using

```bash
du -sh $R                     # ~8 MB — that's all a base container needs
file $R/bin/busybox           # statically linked (musl), no host dependencies
```

## Step 1 — Namespaces + pivot_root

The core move. One `unshare` invocation creates the namespaces; the inner
script swaps the root and mounts the virtual filesystems:

```bash
sudo unshare --pid --fork --mount --uts --ipc --net \
  sh -c '
    hostname handmade                       # UTS ns: our own hostname
    mount --bind '$R' '$R'                  # pivot_root needs a mount point
    cd '$R'
    mkdir -p old_root
    pivot_root . old_root                   # OUR / is now the alpine rootfs
    cd /

    mount -t proc  proc /proc               # fresh procfs for OUR pid ns
    mount -t tmpfs dev  /dev                # minimal private /dev
    mknod /dev/null    c 1 3; chmod 666 /dev/null
    mknod /dev/zero    c 1 5
    mknod /dev/random  c 1 8
    mknod /dev/urandom c 1 9

    umount -l /old_root && rmdir /old_root  # cut the rope to the host
    exec /bin/sh                            # PID 1 execs the "entrypoint"
  '
```

You're in. Verify the lies, one namespace at a time:

```bash
ps aux          # two processes in the universe; sh is PID 1   (pid ns)
hostname        # handmade                                      (uts ns)
ls /            # alpine's root — and /old_root is gone         (mnt ns + pivot)
ip addr         # only a dead loopback                          (net ns)
cat /etc/os-release   # Alpine — while the host is whatever it is
# Verify the kernel is shared:
uname -r        # same as the host. The kernel is not namespaced.
```

Meanwhile, from another terminal on the host:

```bash
ps aux | grep 'bin/sh'    # there's your "container": an ordinary process
sudo ls -l /proc/<that-pid>/ns/   # its namespace inodes differ from yours
sudo lsns -p <that-pid>            # all its namespaces, tree view
```

Every concept from chapters past is on stage: `unshare`/`clone` flags,
PID 1 duties, per-namespace mount tables, `pivot_root` vs chroot, procfs as
a window into the pid namespace.

## Step 2 — A cgroup around it

Limits, from a host terminal (cgroups chapter, applied):

```bash
sudo mkdir /sys/fs/cgroup/handmade
echo 100M | sudo tee /sys/fs/cgroup/handmade/memory.max
echo "50000 100000" | sudo tee /sys/fs/cgroup/handmade/cpu.max     # 0.5 CPU
echo 50 | sudo tee /sys/fs/cgroup/handmade/pids.max                # fork fence
echo <container-pid> | sudo tee /sys/fs/cgroup/handmade/cgroup.procs
```

Test from inside: a fork bomb fizzles at 50 processes
(`sh: can't fork`); a memory hog gets `Killed` at 100 MB. The jail holds.

```bash
# Inside the container, verify:
cat /proc/self/cgroup            # see the handmade cgroup
# Outside, check cgroup stats:
cat /sys/fs/cgroup/handmade/memory.current
cat /sys/fs/cgroup/handmade/memory.events
```

## Step 3 — Drop capabilities

Our container's root is still *real* root (we used sudo, no user namespace).
The filesystems chapter introduced **capabilities** — root's power split into
~40 flags. A runtime's job is to shed almost all of them:

```bash
# inside the container (alpine: apk add libcap to inspect; or from host:)
grep Cap /proc/<pid>/status        # CapEff: 000001ffffffffff = god mode
```

Docker's default keeps ~14 of 41 (`CAP_CHOWN`, `CAP_DAC_OVERRIDE`,
`CAP_FOWNER`, `CAP_FSETID`, `CAP_KILL`, `CAP_SETGID`, `CAP_SETUID`,
`CAP_SETPCAP`, `CAP_NET_BIND_SERVICE`, `CAP_NET_RAW`, `CAP_SYS_CHROOT`,
`CAP_MKNOD`, `CAP_AUDIT_WRITE`, `CAP_SETFCAP`) and drops the dangerous rest:
`CAP_SYS_ADMIN` (the "new root" catch-all), `CAP_SYS_MODULE` (load kernel
code!), `CAP_NET_ADMIN` (reconfigure network), `CAP_SYS_PTRACE` (inspect
other processes)…

Relaunching our shell with the same policy:

```bash
sudo apt install -y libcap2-bin    # capsh
# Drop the dangerous caps, keep the Docker-default subset:
sudo capsh --drop=cap_sys_admin,cap_sys_module,cap_net_admin,cap_sys_ptrace,cap_sys_rawio,cap_sys_boot,cap_sys_time,cap_sys_resource \
     -- -c '/usr/sbin/chroot /tmp/ctr/rootfs /bin/sh'
# inside:  mount -t tmpfs x /mnt  →  permission denied. Root, defanged.
```

Check which caps are actually present:

```bash
capsh --print       # inside the defanged shell — shows current caps
cat /proc/self/status | grep Cap  # hex mask of effective/permitted/inheritable sets
```

(The clean way — UID-remapped *user namespaces*, where container-root is
structurally powerless on the host — you already met in the namespaces
chapter; rootless runtimes lean entirely on it.)

## Step 4 — seccomp: filter the syscalls

Last fence, guarding the deepest layer. The syscalls chapter called the
syscall boundary "a perfect choke point"; **seccomp-BPF** is the filter
installed on it. A process declares: "from now on, for me and all my
children, only these syscalls" — irrevocably.

Docker's default profile disables ~44 syscalls out of more than 300,
denying the exotic and dangerous: `mount`, `reboot`, `init_module`,
`kexec_load`, `ptrace` (old kernels), `open_by_handle_at` (the 2014
"Shocker" container escape used it), `bpf` (load eBPF programs), `unshare`
to create new namespaces…

See it working with off-the-shelf tools:

```bash
docker run --rm alpine unshare --pid sh -c id
# unshare: Operation not permitted        ← seccomp said no
docker run --rm --security-opt seccomp=unconfined alpine unshare --pid sh -c id
# works — you just removed the filter (don't, in production)
# See what the default profile allows:
docker run --rm alpine cat /proc/1/status | grep Seccomp  # 2 = filter installed
```

In code, it's one library call before `exec`:

```c
scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ERRNO(EPERM)); // default: deny
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(read), 0);
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(write), 0);
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(openat), 0);
/* … allow the ~300+ safe syscalls, block the ~44 dangerous ones … */
seccomp_load(ctx);          // point of no return
execve(entrypoint, …);
```

Defense in depth, fully assembled: namespaces bound the *view*, cgroups the
*consumption*, capabilities the *privileges*, seccomp the *kernel attack
surface*, plus an LSM profile (AppArmor/SELinux) on top in real runtimes.

## Step 5 — Bringing it all together (the proper launch)

The real runc launch script (conceptually):

```bash
# 1. Prepare overlayfs
mkdir -p /tmp/ctr/{lower,upper,work,merged}
# lower = the extracted alpine tarball
sudo mount -t overlay overlay -o lowerdir=$R,upperdir=/tmp/ctr/upper,workdir=/tmp/ctr/work /tmp/ctr/merged

# 2. Launch with all isolation
sudo unshare --pid --fork --mount --uts --ipc --net \
  --mount-proc=/tmp/ctr/merged/proc \
  capsh --drop=cap_sys_admin,cap_sys_module,cap_net_admin,... \
  -- -c '
    pivot_root /tmp/ctr/merged /tmp/ctr/merged/old_root
    cd /
    mount -t tmpfs dev /dev
    mknod /dev/null c 1 3
    mknod /dev/zero c 1 5
    mknod /dev/random c 1 8
    mknod /dev/urandom c 1 9
    umount -l /old_root && rmdir /old_root
    exec /bin/sh
  ' &

# 3. Apply cgroup limits
CONTAINER_PID=$!
mkdir /sys/fs/cgroup/handmade
echo 100M > /sys/fs/cgroup/handmade/memory.max
echo "50000 100000" > /sys/fs/cgroup/handmade/cpu.max
echo 50 > /sys/fs/cgroup/handmade/pids.max
echo $CONTAINER_PID > /sys/fs/cgroup/handmade/cgroup.procs
```

## The whole recipe on one page

What `docker run -m 100m --cpus .5 alpine sh` does, demystified end-to-end:

```text
1. fetch image layers; mount overlayfs        (images & overlayfs)
2. clone(CLONE_NEWPID|NEWNS|NEWNET|NEWUTS|NEWIPC|…)   (namespaces)
3. child: pivot_root onto merged dir; mount /proc, /dev   (this chapter)
4. create cgroup; write memory.max, cpu.max; add pid      (cgroups)
5. setup veth pair → bridge; NAT                          (next chapter)
6. drop capabilities                                       (this chapter)
7. install seccomp profile                                 (this chapter)
8. execve(entrypoint)               ← an ordinary process, thoroughly lied to
```

Eight steps, all of them ordinary syscalls you have now performed or read.
There is no step nine. **That's all a container is.**

Cleanup:

```bash
exit   # leave the container shell (PID 1 exits → namespace dies)
sudo rmdir /sys/fs/cgroup/handmade
sudo umount /tmp/ctr/merged
sudo rm -rf /tmp/ctr
```

## Check your understanding

1. Why must `/proc` be remounted *after* pivot_root rather than inherited?
2. Our step-1 container ran as real root. Rank the three mechanisms that
   tame container-root and what each removes.
3. `unshare` failed *inside* a default Docker container but works on the
   host as root. Which fence stopped it?
4. Recite the eight steps of `docker run` from memory. (Seriously — it's the
   exam question for this whole site.)
5. What would happen if we forgot `--fork` when creating the PID namespace?

*(Answers: the host's /proc shows the host's process table — a new procfs
must be mounted for the PID namespace to show only the container's processes;
(1) capabilities: remove specific powers (SYS_ADMIN, SYS_MODULE, etc.) while
retaining needed ones, (2) user namespaces: remap root to unprivileged UID on
the host, (3) seccomp: filter syscalls so many are unreachable regardless of
creds; Docker's default seccomp profile denies the unshare syscall — it's in
the blocked list to prevent nested namespace creation from opening new
escape paths; without --fork, the unshare call moves the current shell into
the new PID namespace but the shell can't function because its PID is now
invisible to itself — --fork creates a child that becomes PID 1 in the new
namespace.)*

---

**Next:** so who actually performs these steps in production — Docker?
containerd? runc? Time to meet the cast.
