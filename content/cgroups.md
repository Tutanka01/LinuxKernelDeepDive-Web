# Control Groups (cgroup v2)

> **Goal:** understand the kernel's resource accounting and limiting
> machinery — the second pillar of containers, and the thing behind
> `docker run -m 512m --cpus 1.5`, Kubernetes requests/limits, and systemd
> service properties.

## The idea

Namespaces change what a process can *see*; **cgroups** (control groups)
change what it can *use*. A cgroup is a named group of processes to which the
kernel attaches **controllers** that meter and limit resources:

| Controller | Governs |
|---|---|
| `cpu` | CPU time (weights and hard quotas) |
| `memory` | RAM + page cache usage, with limits and OOM behaviour |
| `io` | Disk bandwidth and IOPS per device |
| `pids` | Number of processes/threads (fork-bomb fence) |
| plus | `cpuset` (pin to cores), `hugetlb`, `rdma`, `misc` |

Two crucial properties:

- **Hierarchical** — cgroups form a tree; limits cascade. A child can never
  exceed its parent's limit. This enables delegation: give a team 32 GB, let
  them subdivide.
- **Inherited** — a forked process lands in its parent's cgroup
  automatically. No process escapes accounting by forking.

## It's a filesystem (of course it is)

The interface is a virtual filesystem mounted at `/sys/fs/cgroup`. Directories
are cgroups; `mkdir` creates one; control files configure it. No syscalls, no
daemons — `echo` and `cat`:

```bash
mount | grep cgroup2       # cgroup2 on /sys/fs/cgroup (v2 = unified, the modern world)
cat /proc/self/cgroup      # where YOU live: 0::/user.slice/user-1000.slice/…
ls /sys/fs/cgroup/         # the root of the tree
```

> **v1 vs v2 in one line:** v1 had a separate tree per controller (a process
> could be in different groups for cpu vs memory — chaos); v2 has **one
> unified tree**. Everything modern (systemd, Docker, Kubernetes) is v2;
> this site covers only v2.

Note the systemd path in `/proc/self/cgroup`: **systemd organizes the entire
machine into cgroups** (`system.slice` for services, `user.slice` for
sessions) even with zero containers. `systemd-cgls` shows the live tree;
`systemd-cgtop` is "top for cgroups".

## Hands-on: build a memory jail

Watch the whole mechanism in two minutes (as root):

```bash
cd /sys/fs/cgroup
mkdir demo                          # a new cgroup. That's it.
ls demo/ | head                     # control files appeared automatically

echo "100M" > demo/memory.max       # hard memory limit
echo $$ > demo/cgroup.procs         # move THIS shell into the jail

# now blow past the limit:
python3 -c 'x = bytearray(300_000_000)'
# → Killed                          ← the per-cgroup OOM killer

cat demo/memory.events              # oom_kill 1  — the kernel's receipt
echo $$ > /sys/fs/cgroup/cgroup.procs   # escape (move back to root cgroup)
rmdir demo
```

That `Killed` is exactly what happens inside `docker run -m 100m` — recall
the memory chapter: cgroup OOM kill → exit code 137. You've now seen the
machinery naked.

## The control files that matter

### memory

```text
memory.max        hard limit → reclaim, then cgroup-local OOM kill
memory.high       soft limit → heavy reclaim pressure, throttling, no kill
memory.low        best-effort protection from reclaim
memory.min        hard protection, dangerous if overcommitted
memory.oom.group  kill the cgroup as a unit instead of one unlucky task
memory.current    usage right now
memory.events     counts: how often limited (high/max/oom/oom_kill)
memory.stat       breakdown: anon vs file (page cache!), kernel memory
```

Subtlety with production consequences: **page cache counts toward the
limit**. A container reading large files "uses" memory in `memory.current`;
the kernel reclaims cache before OOM-killing, but monitoring that alerts on
`current` alone will lie to you. Read `memory.stat`'s anon vs file split.

The protection knobs are where cgroup v2 becomes more than "limits":

```text
memory.high  pressure valve: slow this group down before it hurts others
memory.max   hard wall: if reclaim fails, kill
memory.low   protect this workload when the machine reclaims memory
memory.min   stronger protection; can force OOM elsewhere if overpromised
```

This is the shape used by serious multi-tenant systems: do not only cap the
noisy neighbor; protect the latency-sensitive neighbor. A database with
`memory.low` gets a reclaim shield for its working set while batch jobs absorb
more cache eviction. `memory.min` is sharper: if every group is promised more
minimum memory than the machine owns, the kernel cannot satisfy reality.

`memory.oom.group=1` is another production-grade detail. Without it, the OOM
killer may kill one large worker and leave a half-broken service limping.
With it, the cgroup is treated as the failure domain: the whole workload dies
and the supervisor restarts it cleanly.

### cpu

```text
cpu.weight    1–10000 (default 100) — proportional share under contention
cpu.max       "150000 100000" = 150ms CPU per 100ms period = 1.5 CPUs, hard cap
cpu.max.burst optional burst budget above the hard period quota
cpu.stat      usage + nr_throttled / throttled_usec ← the smoking gun
```

The scheduling chapter explained the trap: `cpu.max` throttling freezes all
the group's threads for the rest of each 100 ms period once the quota is
burned. `nr_throttled` rising + latency spikes = your container's CPU limit
is biting. `cpu.weight` (Docker's `--cpu-shares`, Kubernetes *requests*) only
divides *contended* CPU and is invisible on an idle host; `cpu.max` (Docker's
`--cpus`, Kubernetes *limits*) caps even an idle one.

`cpu.max.burst` exists because real services are spiky. A strict quota can
create 100 ms rhythm artifacts: request arrives, threads burn quota, group is
throttled, tail latency jumps. Burst lets unused runtime accumulate within a
bounded budget so short spikes complete without permanently raising the CPU
contract. It is not free CPU; it is a latency valve.

### io and pids

```text
io.max     "8:0 rbps=10485760 wiops=1000"   per-device byte/IOPS caps
pids.max   fork-bomb ceiling — docker run --pids-limit
```

The I/O controller is device-oriented because the kernel ultimately schedules
requests against block devices. This matters on hosts with multiple disks:
limiting `8:0` says nothing about `259:0`. Always map major:minor numbers back
to real devices:

```bash
lsblk -o NAME,MAJ:MIN,SIZE,TYPE,MOUNTPOINTS
cat /sys/fs/cgroup/<group>/io.stat
```

`pids.max` is deceptively important. Memory limits do not stop a fork bomb
early enough if thousands of tasks can exist while consuming little memory
each. `pids.max` protects the scheduler, PID allocator, process table pressure,
and every service manager trying to recover the machine.

## How Docker/Kubernetes map onto this

```bash
docker run -d -m 512m --cpus 1.5 --name demo nginx
cat /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' demo).scope/memory.max
# 536870912            ← there's your -m 512m, as a file
docker rm -f demo
```

| You write | Kernel receives |
|---|---|
| `docker run -m 512m` | `memory.max = 536870912` |
| `docker run --cpus 1.5` | `cpu.max = "150000 100000"` |
| `docker run --cpu-shares 512` | `cpu.weight ≈ 20` |
| K8s `resources.requests.cpu` | `cpu.weight` (proportional) |
| K8s `resources.limits.*` | `cpu.max` / `memory.max` (hard) |
| K8s QoS classes | placement in the cgroup tree |

There is no other layer. The entire resource model of the container
ecosystem is file writes into `/sys/fs/cgroup`.

## Accounting: cgroups as a metering system

Even with no limits set, cgroups *measure* — per-group CPU, memory, and I/O
totals, far more usefully than per-process numbers (children included,
nothing escapes):

```bash
cat /sys/fs/cgroup/system.slice/cpu.stat        # all services' CPU, total
systemd-cgtop                                    # live per-group consumption
docker stats                                     # same files, prettier clothes
```

This is what `docker stats`, `kubectl top`, and every container monitoring
agent actually read. When metrics look weird, go read the files yourself.

## cgroups + PSI: knowing when limits hurt

cgroup v2 exposes **Pressure Stall Information** — the percentage of time
tasks in the group were *stalled* waiting for cpu/memory/io:

```bash
cat /sys/fs/cgroup/system.slice/cpu.pressure
# some avg10=0.00 avg60=0.12 …   ← "some tasks stalled 0.12% of the last minute"
cat /proc/pressure/memory        # same idea, machine-wide
```

PSI answers the real question — "is anything actually *suffering*?" — far
better than utilization percentages. Modern autoscalers and OOM-avoiders
(systemd-oomd) are built on it.

The killer combination is:

```text
cpu.stat nr_throttled rising       → quota is actively delaying execution
memory.events high rising          → memory.high is applying pressure
memory.events oom_kill rising      → hard memory failure
io.pressure full rising            → all useful work stalled behind I/O
cpu.pressure some high             → runnable work waiting for CPU
```

Utilization says "the resource is busy". PSI says "tasks are losing time".
For capacity planning, SLOs, and noisy-neighbor debugging, the second signal
is usually closer to user pain.

## Delegation and the no-internal-process rule

cgroup v2 has a structural rule that surprises people building their own
managers: domain controllers distribute resources from a parent to its
children, so a non-root cgroup generally cannot both contain processes and
enable domain controllers for child cgroups. Processes should live at leaves.

The shape is:

```text
service.slice/                  controllers enabled here
└── my.service/                 no workload process here if subdividing
    ├── frontend/               processes live here
    └── workers/                processes live here
```

This avoids ambiguous competition between "the parent itself" and "the
children". It is also why mature systems let systemd own the upper tree and
delegate a subtree to a container manager or user session with carefully
limited write access. Delegation is not just `chown -R`: the delegate must be
able to create children and move its own processes, but not rewrite the
parent's resource contract.

## Try it yourself

```bash
systemd-cgls | head -30                 # the machine's cgroup tree
cat /proc/self/cgroup                   # your own address in it
systemd-run --scope -p MemoryMax=50M stress --vm 1 --vm-bytes 100M
                                        # systemd as a cgroup CLI — watch it die
journalctl -u user@1000 | grep -i oom | tail -3
```

## Check your understanding

1. Why does forking never escape resource limits?
2. `memory.current` is at 90% of `memory.max` — is the container about to
   OOM? What file tells you more?
3. A latency-sensitive service stutters every ~100 ms under load. Which file
   confirms the diagnosis, and which Docker flag caused it?
4. What's the difference between Kubernetes CPU *requests* and *limits*, in
   cgroup file terms?

---

**Next:** the third pillar — where a container's filesystem comes from.
Images, layers, and OverlayFS.
