# Linux Security & Confinement

> **Goal:** understand Linux security as a stack of kernel decisions, not as a
> checklist. Credentials answer "who are you?", DAC answers "what does the
> inode allow?", capabilities split root, namespaces change the view, cgroups
> meter resources, seccomp cuts syscalls, and LSMs inject policy into security
> hooks.

## The security path

Every sensitive operation eventually reaches a kernel decision point:

```text
process
  ↓ syscall
kernel object lookup
  ↓
credential checks
  ↓
DAC permissions
  ↓
capability checks
  ↓
LSM hooks
  ↓
operation allowed or denied
```

For `openat("/etc/shadow")`, the VFS resolves dentries and inodes, checks
mode bits and ownership, evaluates capabilities such as `CAP_DAC_OVERRIDE`,
then calls LSM hooks that SELinux, AppArmor, Landlock, BPF LSM, or another
module may implement.

For `mount()`, DAC is barely the point. The kernel asks whether the caller has
the right capability in the relevant user namespace, whether the filesystem
type is allowed, whether LSM policy permits it, and whether the operation
crosses namespace boundaries in a dangerous way.

There is no single Linux security mechanism. There is a pipeline.

## Credentials: identity as a kernel object

A task points to a `struct cred`. That object contains the process's security
identity:

```text
struct cred
├── uid, gid                  real identity
├── euid, egid                effective identity used for checks
├── suid, sgid                saved IDs for privilege transitions
├── fsuid, fsgid              filesystem permission identity
├── groups                    supplementary groups
├── cap_*                     capability sets
├── user_ns                   user namespace where caps are interpreted
└── security                  LSM-specific blob
```

The important subtlety: credentials are immutable-ish. The kernel usually
prepares a new credential object, modifies it, then commits the pointer. That
copy-and-replace discipline helps avoid races where another CPU observes a
half-mutated identity.

Inspect your current credential surface:

```bash
grep -E 'Uid|Gid|Groups|Cap|NoNewPrivs|Seccomp' /proc/self/status
```

Those hex capability masks are not decoration. They are often the difference
between "root can do it" and "this process is root-looking but defanged".

## DAC: classic Unix permissions

Discretionary Access Control is the familiar layer:

```text
owner uid + group gid + mode bits + ACLs
```

For files, the inode carries ownership and permissions. For directories, the
execute bit means "may traverse", not "may execute". Write on a directory
means "may create/delete names inside it"; deleting a file is a permission on
the directory entry, not on the file's contents.

This explains old-looking but still lethal details:

```bash
chmod 1777 /tmp
```

The sticky bit on `/tmp` means many users may create files there, but only the
owner of a file, the directory owner, or privileged users may remove/rename
that entry. Without it, world-writable directories are a deletion party.

DAC is necessary, but it is not enough for modern confinement. If a service is
compromised and it runs as a user that can read its own secrets, DAC says
"yes". LSMs and seccomp exist because "same UID" is too coarse.

## Capabilities: root split into bits

Historically, UID 0 bypassed everything. Linux capabilities split that power
into smaller privileges:

| Capability | Allows |
|---|---|
| `CAP_NET_BIND_SERVICE` | bind low ports like 80/443 |
| `CAP_NET_ADMIN` | configure interfaces, routing, firewalling |
| `CAP_SYS_ADMIN` | huge bucket: mounts, namespaces, many admin operations |
| `CAP_SYS_PTRACE` | inspect/control other processes |
| `CAP_DAC_OVERRIDE` | bypass file permission checks |
| `CAP_SYS_MODULE` | load/unload kernel modules |
| `CAP_BPF` | privileged BPF operations on newer kernels |
| `CAP_PERFMON` | privileged performance monitoring |
| `CAP_CHECKPOINT_RESTORE` | checkpoint/restore related powers |

The capability sets matter:

```text
Permitted    what the process may make effective
Effective    what is currently active
Inheritable  what may survive exec via file caps
Bounding     ceiling; caps outside it can never be gained
Ambient      caps preserved across exec for non-setuid programs
```

Container runtimes rely heavily on the bounding set: start as root-like inside
the container, drop dangerous host-level capabilities, then exec the workload.

The uncomfortable truth is `CAP_SYS_ADMIN`. It is so broad that people call it
"the new root". A container with `CAP_SYS_ADMIN` plus writable sensitive
mounts is often no longer meaningfully confined.

## setuid, file capabilities, and `no_new_privs`

Privilege can enter a process through executable metadata:

```bash
ls -l /usr/bin/passwd
# -rwsr-xr-x root root ...
```

The setuid bit makes the executed program run with the file owner's effective
UID. This is how `passwd` can modify privileged password databases while being
invoked by ordinary users.

File capabilities are the more surgical form:

```bash
getcap /usr/bin/ping
# /usr/bin/ping cap_net_raw=ep
```

Instead of making `ping` root, grant only raw socket power.

`no_new_privs` is the brake:

```bash
grep NoNewPrivs /proc/self/status
```

Once set, execve cannot grant new privilege through setuid or file
capabilities. Seccomp filters require this for unprivileged installation,
because a process must not install a filter, exec a privileged binary, and
trick that binary into running under hostile syscall constraints.

## Namespaces: isolate the meaning of global names

Namespaces do not primarily restrict resource usage. They change what names
mean:

| Namespace | Isolates |
|---|---|
| Mount | filesystem mount tree |
| PID | process ID space |
| Network | interfaces, routes, ports, conntrack view |
| UTS | hostname/domainname |
| IPC | SysV IPC and POSIX message queues |
| Cgroup | cgroup path visibility |
| Time | offsets for monotonic/boottime clocks |
| User | UID/GID and capability interpretation |

User namespaces are the conceptual hinge. UID 0 inside a user namespace can be
mapped to an unprivileged UID outside it:

```text
inside userns: uid 0
outside host:  uid 100000
```

Capabilities are evaluated relative to a user namespace. A process may have
`CAP_SYS_ADMIN` inside its own user namespace and still lack host
`CAP_SYS_ADMIN`. This is why rootless containers are possible.

But user namespaces are not magic sandboxes. They expose complex kernel code
paths to unprivileged users. Historically, they have increased attack surface
because operations once reachable only by host root become reachable by a
namespaced root with constrained but nontrivial powers.

## cgroups: security by resource containment

cgroups are not access control, but they are part of security because resource
exhaustion is an attack.

Hardening-relevant controllers:

| Controller | Security angle |
|---|---|
| `pids.max` | fork-bomb containment |
| `memory.max` | memory exhaustion boundary |
| `cpu.max` | CPU abuse cap |
| `io.max` | disk pressure containment |
| `devices` in v1 / BPF device policy | device access control |

A production sandbox without `pids.max` is incomplete. A process that cannot
escape the filesystem but can create 500,000 threads can still destroy service
availability.

## seccomp: shrink the syscall ABI

seccomp-BPF filters system calls. A process installs a filter; every future
syscall number and selected arguments can be checked. The filter returns an
action: allow, errno, kill, trap, log, notify user space, and so on.

A minimal mental model:

```text
workload
  ↓ syscall nr + args
seccomp filter
  ├── allowed: continue into syscall implementation
  └── denied: return EPERM / kill / notify supervisor
```

Docker's default profile blocks many obviously dangerous or rarely needed
syscalls. High-security sandboxes go further: generate a profile from the
actual syscall set of the workload, then deny everything else.

The deep point: seccomp restricts the **kernel API surface**, not filesystem
paths or network destinations. It answers "may this process call `mount()`?"
not "may this process mount this particular directory?" For object-aware
policy, combine seccomp with LSMs and namespaces.

## LSM: policy at kernel security hooks

The Linux Security Module framework places hooks around security-sensitive
operations:

```text
inode_permission
file_open
bprm_check_security
task_kill
socket_connect
ptrace_access_check
...
```

Different LSMs implement policy there:

| LSM | Model |
|---|---|
| SELinux | label-based mandatory access control |
| AppArmor | pathname/profile-oriented confinement |
| Smack | label-based MAC, simpler model |
| Landlock | unprivileged, process-managed sandboxing |
| Yama | extra ptrace restrictions |
| BPF LSM | programmable policy hooks |

DAC asks "does this UID/mode combination allow the operation?" LSMs can ask
"even if DAC allows it, does this domain/profile/label/policy allow it?"

That difference matters after compromise. A web server often needs read access
to its site files. If exploited, DAC still allows those reads. A tight LSM
profile may allow reads under `/srv/www` but deny reads under `/home`,
`/etc/ssh`, and `/var/lib/other-service`, even if Unix permissions would have
permitted them.

## Landlock: unprivileged self-confinement

Landlock is important because it changes who can create a sandbox. Traditional
MAC policy is usually administrator-defined. Landlock lets a process restrict
itself and its future children without privilege.

The model is additive restriction:

```text
process starts with normal rights
  ↓
creates Landlock ruleset
  ↓
adds allowed filesystem actions on selected paths
  ↓
enforces ruleset
  ↓
future actions are limited even if DAC would allow them
```

A build tool, plugin runner, editor extension host, or test harness can use
this to say: "from now on, this child may read the project and write only the
build directory." That is a strong primitive because the sandbox can be
applied by the program that understands intent, not only by global admin
policy.

## Container confinement: what actually protects the host

A container is not protected by one feature. A serious runtime composes:

```text
namespaces       isolated views
cgroups          resource ceilings and accounting
cap drop         reduced root power
seccomp          reduced syscall surface
LSM profile      object-aware policy
readonly mounts  fewer writable host-adjacent paths
userns           root remapped away from host root
no_new_privs     no privilege gain across exec
```

Common dangerous shapes:

| Configuration | Why it is dangerous |
|---|---|
| `--privileged` | disables most meaningful confinement |
| host PID namespace | process visibility/control expands sharply |
| host network namespace | firewall, sniffing, and bind surface change |
| writable Docker socket | usually host root via container creation |
| broad hostPath mounts | path escape becomes data/control-plane compromise |
| `CAP_SYS_ADMIN` | access to a vast admin syscall surface |
| no seccomp profile | larger kernel attack surface |

"Root in a container" is safe only to the extent that root's kernel powers
were removed or mapped away. The UID string is not the security boundary.

## Kernel lockdown and trusted boot chain

On systems using UEFI Secure Boot or stricter integrity modes, Linux may run
with kernel lockdown enabled. Lockdown restricts features that let even root
modify or inspect kernel memory in ways that would break the trust chain:
unsigned module loading, raw kernel memory access, some debug interfaces, and
certain BPF/perf capabilities depending on mode and configuration.

This is a different kind of security boundary: not "protect users from each
other", but "protect kernel integrity from a compromised root account". It is
especially relevant on laptops, regulated fleets, and systems relying on
measured boot or remote attestation.

## Hardening as a design discipline

Useful hardening is not a pile of flags. It is reducing authority along every
dimension:

```text
identity      run as a dedicated UID, not shared service users
filesystem    readonly root, narrow writable dirs, no sensitive mounts
syscalls      seccomp allowlist or strong default profile
kernel caps   drop all, add back only exact capabilities
resources     pids/memory/cpu/io boundaries
network       explicit egress/ingress policy
LSM           profile object access
exec          no_new_privs, minimal PATH, controlled interpreters
observability log denials and pressure before outages
```

The best signal that confinement is real: when the workload is compromised,
the attacker keeps hitting different walls. They cannot see host processes,
cannot mount, cannot ptrace, cannot load BPF, cannot create unlimited children,
cannot read arbitrary host paths, cannot call surprising syscalls, and cannot
gain privilege through exec.

## Source map

| Area | Kernel path |
|---|---|
| credentials | `kernel/cred.c`, `include/linux/cred.h` |
| capabilities | `security/commoncap.c`, `include/uapi/linux/capability.h` |
| exec privilege transitions | `fs/exec.c` |
| seccomp | `kernel/seccomp.c` |
| LSM framework | `security/security.c`, `include/linux/lsm_hook_defs.h` |
| namespaces | `kernel/nsproxy.c`, `kernel/user_namespace.c` |
| VFS permission checks | `fs/namei.c`, `fs/open.c` |
| Landlock | `security/landlock/` |
| AppArmor/SELinux | `security/apparmor/`, `security/selinux/` |

## Two sharp checks

- If a process is UID 0 inside a user namespace, which namespace decides
  whether its `CAP_SYS_ADMIN` is meaningful for a mount operation?
- Which layer blocks an entire syscall like `mount()`, and which layer blocks
  opening a specific path even when Unix permissions allow it?

---

**Next:** security isn't just about blocking attacks — it's about being able to *prove* what ran. Trusted computing: Secure Boot verifies signatures, the TPM measures every boot stage into tamper-proof hardware, and IMA extends measurement into runtime. The plumbing beneath confidential computing.
