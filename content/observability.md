# /proc, strace, perf & eBPF

> **Goal:** assemble the observation toolkit — the tools that turn every
> claim on this site into something you can *watch happening* on a live
> system, from quick `/proc` reads to eBPF programs inside the kernel.

## The layered toolbox

```text
"what is the system doing?"
   ├── /proc, /sys ........ raw kernel state, as files       (always there)
   ├── ps/top/free/ss ..... pretty parsers of the above       (always there)
   ├── strace/ltrace ...... one process's syscalls, live      (apt install)
   ├── perf ............... CPU profiling, kernel tracepoints (apt install)
   └── eBPF (bpftrace) .... programmable kernel-side tracing  (modern kernels)
```

Rule of thumb: start at the top; descend only as far as the question requires.

## /proc: the primary source

Everything `top` shows you came from here. The per-process directories are
the ones to internalize — most of them are concepts from earlier chapters
made into files:

```bash
ls /proc/$$/
cat  /proc/$$/status      # state, VmRSS, threads, capabilities, namespaces' seed
cat  /proc/$$/maps        # the address space (memory chapter, live)
ls -l /proc/$$/fd         # open fds (syscalls chapter, live)
ls -l /proc/$$/ns         # namespaces (containers, live)
cat  /proc/$$/cgroup      # cgroup membership
cat  /proc/$$/stack       # where in the KERNEL it's sleeping (root)
```

System-wide: `/proc/meminfo`, `/proc/loadavg`, `/proc/pressure/*` (PSI!),
`/proc/interrupts`, `/proc/net/*. ` When a metric in some dashboard looks
absurd, find which file it came from and read the source of truth.

## strace: the syscall narrative

Already met in the syscalls chapter; here's the production-grade usage:

```bash
strace -f -tt -T -o trace.log myprog     # follow forks, timestamps, durations
strace -e trace=%network curl example.org # filter by syscall family
strace -e trace=openat -Z myprog          # -Z: only FAILED calls ← gold
strace -p 1234 -c                         # attach to a runner, get a tally
```

The killer pattern — **"why doesn't it find its config?"**:

```bash
strace -e trace=openat -Z myapp 2>&1 | grep -E 'conf|ENOENT'
# openat(… "/etc/myapp/conf.yml") = -1 ENOENT
# openat(… "/usr/local/etc/conf.yml") = -1 ENOENT   ← so THAT's where it looks
```

No documentation, no source code — the syscalls cannot lie. Caveats: strace
pauses the target at every syscall (ptrace mechanism: slow — don't leave it
on a busy prod process; that's what eBPF is for) and remember `-f`, since
anything interesting forks.

`ltrace` does the same for *library* calls; `/usr/bin/time -v` gives the
one-shot summary (faults, context switches, peak RSS).

## perf: where does the CPU go?

`perf` answers statistically: it samples the CPU (e.g. 99 times/sec),
recording the full call stack each time — kernel *and* user frames:

```bash
sudo perf top                          # live "what's hot, machine-wide"
sudo perf record -g -F 99 ./myprog     # profile one run…
sudo perf record -g -F 99 -p 1234 -- sleep 30   # …or 30s of a live process
sudo perf report                       # interactive: who burned the cycles
```

Reading results: time in `your_function` → your algorithm; time under
`copy_user…`/`memcpy` → data shoveling; time in `*_lock`/futex → contention;
mostly idle → the bottleneck isn't CPU at all — go look at I/O or locks.

**Flame graphs** turn a million stacks into one readable SVG (wide =
expensive):

```bash
git clone https://github.com/brendangregg/FlameGraph
perf script | FlameGraph/stackcollapse-perf.pl | FlameGraph/flamegraph.pl > out.svg
```

`perf` also counts hardware events (`perf stat`: IPC, cache misses, branch
mispredictions) and hooks **tracepoints** — stable instrumentation points
maintained inside kernel code (`perf list | grep sched:` — every scheduler
event from the scheduling chapter is observable).

## eBPF: programmable kernel observability

The endgame. **eBPF** lets you load small, *verified* programs into the
kernel, attached to almost any event — syscalls, tracepoints, any kernel
function (kprobes), even user functions (uprobes). Programs run in-kernel
(no per-event process switch — this is why it's fast enough for prod),
aggregate into maps, and stream results out. The verifier statically proves
termination and memory-safety before load — this is what makes "run my code
in ring 0" sane, and it's the same technology as seccomp's filters and
Cilium's datapath. Observability, security, and networking converged on one
VM inside the kernel.

**bpftrace** makes it a one-liner language:

```bash
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_openat
                  { printf("%s %s\n", comm, str(args->filename)); }'
# every file open, system-wide, with the opener's name. Try THAT with strace.

sudo bpftrace -e 'tracepoint:sched:sched_process_exec
                  { printf("exec: %s by pid %d\n", str(args->filename), pid); }'
# watch every program execution on the machine

sudo bpftrace -e 'kprobe:vfs_read { @bytes = hist(arg2); }'
# live histogram of read() sizes, aggregated IN the kernel
```

The **bcc tools** package ready-made classics — install and browse them as a
menu of questions you didn't know you could ask: `execsnoop` (every exec),
`opensnoop` (every open), `biolatency` (disk latency histograms), `tcplife`
(every TCP connection with bytes/duration), `offcputime` (what are we
*waiting* on).

```bash
sudo apt install bpfcc-tools
sudo execsnoop-bpfcc        # leave it running; be amazed what your box runs
```

## Observing containers specifically

Everything above works on containers — they're processes (the site's
refrain). The container-aware moves:

```bash
docker stats                              # cgroup files, prettified
PID=$(docker inspect -f '{{.State.Pid}}' ctr)
sudo strace -f -p $PID                    # strace reaches into namespaces fine
sudo nsenter -t $PID -n ss -tlnp          # host tools, container's net view
sudo cat /sys/fs/cgroup/system.slice/docker-*.scope/memory.stat
sudo execsnoop-bpfcc                      # eBPF sees ALL containers at once —
                                          # kernel-side tracing ignores walls
```

That last point is profound: because eBPF lives in the shared kernel, one
tracer observes every container with zero instrumentation inside images —
exactly how modern container security monitors (Falco, Tetragon) work.

## A debugging method, not just tools

When something is wrong and you don't know where:

1. **USE check** (Utilization/Saturation/Errors) per resource:
   `vmstat 1`, `free -h`, `iostat -x 1`, `ss -s`, `dmesg | tail` — 60 seconds.
2. PSI for the suffering signal: `cat /proc/pressure/{cpu,memory,io}`.
3. CPU-bound → `perf top` / flame graph. I/O-bound → `iostat -x`,
   `biolatency`. Stuck → `strace -p` (what syscall?) or
   `cat /proc/<pid>/stack` (where in the kernel?).
4. Form one hypothesis, find the file/tool that can falsify it, repeat.

The tools matter less than the habit: **the kernel will tell you exactly
what's happening if you ask precisely.**

## Check your understanding

1. Pick the right tool: (a) "what files does this program try to read?"
   (b) "which function eats the CPU?" (c) "every new TCP connection,
   machine-wide, for an hour, in prod".
2. Why is strace dangerous on a hot production process while eBPF isn't?
3. Why can a single eBPF tracer see inside all containers at once?

---

**Next (final chapter):** going to the source — reading kernel code,
building your own kernel, and where to go from here.
