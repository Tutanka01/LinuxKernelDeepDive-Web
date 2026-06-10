# eBPF Internals

> **Goal:** understand eBPF as a kernel execution substrate, not as a magic
> observability brand. The important objects are programs, maps, helpers,
> attach points, BTF, CO-RE, the verifier, and the JIT. Once those are clear,
> tracing, networking, security, and container monitoring become one system.

## The core idea

eBPF is a constrained virtual machine inside the Linux kernel. User space
loads bytecode through the `bpf()` syscall; the kernel verifies that the
program is safe enough to run; then the program is attached to a kernel hook:
a tracepoint, a kprobe, an LSM hook, a socket, TC, XDP, cgroup hooks, and many
others.

The key is not "running scripts in the kernel". The key is:

```text
event happens in kernel
    ↓
attached BPF program runs immediately, in kernel context
    ↓
program reads constrained kernel/user data
    ↓
program updates maps or emits events
    ↓
user space consumes aggregated results
```

This removes the expensive pattern where every event crosses into user space.
A BPF program can count, filter, aggregate, sample, drop packets, enforce
policy, or summarize latency before user space ever wakes up.

## Objects, not commands

Almost every BPF tool is a friendly wrapper around a small set of kernel
objects:

| Object | What it is |
|---|---|
| BPF program | Verified bytecode loaded into the kernel |
| BPF map | Kernel-resident key/value storage shared by programs and user space |
| Link | A durable attachment between a program and a hook |
| Helper | A kernel-provided function callable from BPF |
| BTF | Type metadata describing kernel and program data structures |
| Ring buffer | A high-throughput event channel from kernel to user space |

`bpftool` exposes the real inventory:

```bash
sudo bpftool prog list
sudo bpftool map list
sudo bpftool link list
sudo bpftool btf list
```

If a production host has Cilium, Falco, Tetragon, systemd-oomd, or modern
observability agents, this list is no longer empty. Those systems are not
"watching Linux from the outside"; they have loaded small verified programs
into the kernel.

## Program types: the hook defines the world

A BPF program type determines where the program can attach, what context
pointer it receives, and which helpers it may call. The same bytecode ISA sits
under several very different execution environments:

| Program type | Typical hook | Used for |
|---|---|---|
| `BPF_PROG_TYPE_TRACEPOINT` | stable kernel tracepoints | observability |
| `BPF_PROG_TYPE_KPROBE` | dynamic kernel function probes | debugging internals |
| `BPF_PROG_TYPE_TRACING` | fentry/fexit, typed BTF hooks | low-overhead tracing |
| `BPF_PROG_TYPE_XDP` | NIC driver receive path | packet drop/redirect before skb |
| `BPF_PROG_TYPE_SCHED_CLS` | TC ingress/egress | traffic shaping, service mesh datapaths |
| `BPF_PROG_TYPE_CGROUP_*` | cgroup hooks | per-container network/syscall-ish policy |
| `BPF_PROG_TYPE_LSM` | Linux Security Module hooks | security decisions |

This is why "eBPF" can mean observability, load balancing, firewalling,
runtime security, or packet acceleration. Those are not separate technologies;
they are different attach points around the same verifier, map system, and
runtime.

## The verifier

The verifier is the reason BPF is acceptable in production kernels. Before a
program can attach, the kernel symbolically executes it and proves a set of
properties:

- all paths terminate;
- stack access is within bounds;
- pointer arithmetic stays inside known objects;
- helper arguments have the expected pointer types and permissions;
- uninitialized stack bytes are not leaked;
- packet and context accesses are bounds-checked;
- reference-counted kernel objects are released;
- privileged-only operations require the right capability and kernel policy.

The verifier tracks register state. A register is not just "64 bits"; it may
be "pointer to packet data with range checked up to byte N", "scalar with
known upper bits", "map value pointer", "trusted kernel pointer", or "nullable
reference that must be checked before dereference".

This is why small source changes can decide whether a program loads. The C
compiler may generate bytecode whose safety is obvious to a human but not
provable to the verifier. Serious BPF engineering is partly writing code for
the kernel and partly writing code that the verifier can reason about.

Typical verifier failures are not random:

```text
invalid mem access 'scalar'
R1 min value is negative
R2 unbounded memory access
invalid access to packet, off=54 size=14
R0 leaks addr as return value
Unreleased reference id=...
```

Read them as type errors from a very strict kernel type system.

## Maps: state inside the kernel

BPF programs are intentionally small and event-driven. Maps provide state:
counters, histograms, policy tables, LRU caches, socket maps, stack traces,
per-CPU buffers, and queues.

Common map types:

| Map | Why it exists |
|---|---|
| Hash | general key/value lookup |
| LRU hash | bounded cache with eviction |
| Array | dense numeric indexes, config slots |
| Per-CPU hash/array | no cross-CPU cacheline bouncing for hot counters |
| Ring buffer | event stream to user space |
| Stack trace | folded stacks for profiling |
| Sockmap/Sockhash | steer sockets through BPF |
| LPM trie | IP prefix matching |

The per-CPU variants matter. A global counter updated by every packet or
syscall becomes a cache-coherency bottleneck. A per-CPU counter lets each CPU
write to local storage; user space sums the shards later. That is the kind of
detail that separates "BPF demo works" from "BPF tool survives a production
host at line rate".

## BTF and CO-RE

Old BPF tracing had a painful problem: kernel structs change between versions.
If a program reads `task_struct->pid` or `sock->__sk_common.skc_daddr`, the
offset may differ across kernels.

BTF, the **BPF Type Format**, fixes this by shipping compact type metadata for
kernel types. CO-RE, **Compile Once - Run Everywhere**, uses BTF relocation
records so a program compiled on one kernel can adapt field offsets on another
kernel at load time.

The modern stack looks like:

```text
C source
  ↓ clang -target bpf
ELF object with BPF bytecode + BTF + CO-RE relocations
  ↓ libbpf loader
relocations resolved against target kernel BTF
  ↓ bpf() syscall
verified program + maps + links
```

This is one of the quiet revolutions in Linux tooling. BPF stopped being a
collection of fragile per-kernel scripts and became a deployable artifact.

## Tracepoints, kprobes, fentry/fexit

Not all hooks are equal.

**Tracepoints** are stable instrumentation points maintained by kernel
developers. They are the best default for tooling you expect to keep running
across kernel versions:

```bash
sudo bpftrace -l 'tracepoint:sched:*'
sudo bpftrace -l 'tracepoint:syscalls:sys_enter_*'
```

**Kprobes** can hook almost any kernel function. They are powerful, but tied
to internal names and calling conventions. Use them when you are investigating
a specific kernel path, not as a long-term product API.

**fentry/fexit** attaches at function entry/exit using BTF type information.
It is lower overhead and more type-aware than classic kprobes where supported.
Modern BPF tools increasingly prefer it for deep kernel instrumentation.

The hierarchy is practical:

```text
stable product signal     → tracepoint
deep temporary debugging  → kprobe/kretprobe
modern typed low overhead → fentry/fexit
```

## XDP and TC: two network worlds

Networking BPF has two famous attachment layers:

```text
NIC driver RX
  ↓
XDP       ← earliest hook, before skb allocation
  ↓
skb exists
  ↓
TC ingress / netfilter / routing / sockets
  ↓
TC egress
  ↓
NIC driver TX
```

XDP is brutally early. The packet is still raw driver memory; the program can
drop, pass, redirect, or transmit. This is where DDoS filters, fast load
balancers, and packet steering can operate before the kernel allocates the
full `sk_buff`.

TC BPF runs later, after the packet has become an skb. It has more kernel
context and integrates naturally with qdisc, cgroups, containers, and service
mesh traffic manipulation. Cilium's datapath is built from this family of
ideas: attach policy and routing logic to kernel packet paths instead of
forcing every packet through user-space proxies.

## LSM BPF: policy in the security path

BPF can attach to Linux Security Module hooks. This means programs can inspect
security-sensitive operations and return allow/deny decisions:

```text
process calls openat()
  ↓
VFS path resolution
  ↓
LSM hook: file_open / inode_permission / ...
  ↓
BPF LSM program evaluates policy
  ↓
operation proceeds or fails with -EPERM/-EACCES
```

This is the basis for a class of modern runtime security tools: policy that
knows process identity, cgroup/container membership, file paths, socket
addresses, and kernel event context, without injecting code into workloads.

It is also why BPF privilege is a serious matter. A root-equivalent actor with
the ability to load powerful BPF programs can observe or influence enormous
parts of the machine.

## Performance model

BPF is fast because work happens at the event site, but it is not free.

Costs to understand:

- Program execution adds instructions to the hot path.
- Map lookups can be expensive, especially global hash maps under contention.
- Ring-buffer event emission wakes user space and copies data.
- Stack traces are expensive; sample them deliberately.
- Kprobes on very hot functions can distort the system being measured.
- Per-event `printf()` is usually the wrong design.

The production pattern is:

```text
filter early
aggregate in maps
emit summaries
sample high-frequency paths
prefer per-CPU maps for hot counters
prefer stable hooks for long-running agents
```

Good BPF tools are quiet. They leave the hot path with a small bounded amount
of work and move interpretation to user space.

## Failure modes

The sharp edges are predictable:

| Symptom | Likely cause |
|---|---|
| Program rejected | verifier cannot prove safety |
| Works on one kernel only | missing BTF/CO-RE discipline, unstable kprobe |
| High CPU overhead | hot hook, too much event emission, global map contention |
| Lost events | ring buffer too small or user space not draining fast enough |
| Missing container context | not joining PID/mount namespace view, only seeing host PIDs |
| Permission denied loading BPF | kernel lockdown, capabilities, unprivileged BPF disabled |

On hardened distributions, unprivileged BPF is often disabled. That is a
feature, not an inconvenience: BPF is too close to the kernel to treat as a
normal scripting facility.

## Source map

When you want to go below tools:

| Area | Kernel path |
|---|---|
| syscall entry | `kernel/bpf/syscall.c` |
| verifier | `kernel/bpf/verifier.c` |
| maps | `kernel/bpf/` plus specialized map files |
| BTF | `kernel/bpf/btf.c` |
| tracing attach | `kernel/trace/bpf_trace.c` |
| cgroup hooks | `kernel/bpf/cgroup.c` |
| XDP | `net/core/dev.c`, driver-specific XDP paths |
| LSM BPF | `security/bpf/`, `security/security.c` |

The code is dense, but the object model above is the compass. Programs, maps,
links, helpers, BTF, verifier, JIT. Everything else is a specialization.

## Two sharp checks

- If a BPF program observes every `openat()` on a machine, where should it
  aggregate state to avoid waking user space on every syscall?
- Why is a tracepoint usually a better product hook than a kprobe, even when
  the kprobe gives you a more tempting internal function?

---

**Next:** the same kernel boundary, now from the security side: credentials,
capabilities, seccomp, LSMs, namespaces, and why "root in a container" is not
the same thing as root on the host.
