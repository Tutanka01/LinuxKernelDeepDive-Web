# Pipes, FIFOs & Unix Sockets

> **Goal:** understand the kernel's inter-process communication primitives —
> anonymous pipes, named FIFOs, and Unix domain sockets — and see them as the
> hidden plumbing behind shells, systemd, databases, and container runtimes.

## The kernel's IPC toolbox

Processes are isolated by design. The kernel provides three fundamental
byte-stream mechanisms to let them talk:

| Mechanism | Persistent name? | Scope | Bidirectional? |
|---|---|---|---|
| **Anonymous pipe** | No (inherited by fd) | Parent↔child or shared ancestor only | Unidirectional |
| **Named pipe (FIFO)** | Yes (inode in filesystem) | Any process with path access | Unidirectional |
| **Unix domain socket** | Yes (inode in filesystem) | Any process, plus abstract namespace | Bidirectional (or connection-oriented) |

All three use the same kernel implementation (`fs/pipe.c` for pipes/FIFOs,
`net/unix/` for Unix sockets) and share the same syscalls you already know:
`read()`, `write()`, `close()`, `poll()`, `epoll`, `splice()`, `sendfile()`.

## Anonymous pipes: the shell's secret weapon

When you type `ls -l | grep txt`, the shell calls `pipe()` before forking:

```text
shell
  │
  pipe([3, 4])     ← creates two fds: 3=read end, 4=write end
  │
  fork()           ← child 1: ls -l
  │   │
  │   close(3)     ← child doesn't need the read end
  │   dup2(4, 1)   ← redirect stdout (fd 1) to write end
  │   close(4)
  │   exec(ls)
  │
  fork()           ← child 2: grep txt
      │
      close(4)     ← child doesn't need the write end
      dup2(3, 0)   ← redirect stdin (fd 0) to read end
      close(3)
      exec(grep txt)

Result: ls writes → pipe buffer → grep reads. Neither knows the pipe exists.
```

At the kernel level, `pipe()` creates two file descriptors connected to an
internal circular buffer (the **pipe buffer**). The default size is 64 KB
(`/proc/sys/fs/pipe-max-size`). Writes to a full pipe block the writer;
reads from an empty pipe block the reader; writing to a pipe whose read end
is closed → `SIGPIPE` delivered to writer (or `EPIPE` if blocked).

```bash
ls -l /proc/$$/fd           # your shell's open descriptors — pipes show as "pipe:[inode]"
ls -l /proc/$$/fd/1         # stdout is often a pty (pseudo-terminal), also a pipe-like fd
# See a pipe in action:
ls -l /proc/self/fd | grep pipe
```

### `splice()` and `sendfile()`: zero-copy pipe operations

The kernel can move data between a pipe and a file descriptor *without copying
it through user space*:

```c
// Copy from socket to pipe without userspace copy:
splice(sock_fd, NULL, pipe_write_fd, NULL, len, SPLICE_F_MOVE);
// Copy from pipe to file (or socket):
splice(pipe_read_fd, NULL, file_fd, &offset, len, SPLICE_F_MOVE);
```

This is how nginx serves static files with minimal overhead: `sendfile(file_fd,
sock_fd)` copies from page cache to socket buffer entirely in kernel space.

## Named pipes (FIFOs): pipes with a filesystem address

A FIFO is an inode in the filesystem with type "fifo". It behaves exactly like
an anonymous pipe, but any process with path access can open it:

```bash
mkfifo /tmp/myfifo
echo hello > /tmp/myfifo &       # blocks until a reader opens it!
cat /tmp/myfifo                  # unblocks the writer, prints "hello"
ls -l /tmp/myfifo                # prw-r--r--   ← 'p' = fifo
```

In the kernel, `open("/tmp/myfifo", O_WRONLY)` creates a new pipe instance
inside the FIFO inode. Every open creates a new pipe — two readers get
independent streams. The FIFO acts as a **rendezvous point** rather than a
persistent channel.

FIFOs are used by:
- `systemd` — `journald` receives logs from services via FIFOs in `/run/systemd/journal/`
- Legacy syslog — `/dev/log` was traditionally a FIFO (now a Unix socket)
- Cron — some implementations use FIFOs for job output capture
- Build systems — `mkfifo` is sometimes used for parallelizing pipelines

```bash
# Real-world: systemd journal's FIFO (if journald is running):
ls -l /run/systemd/journal/stdout
# prw------- 1 root root ...   /run/systemd/journal/stdout
```

## Unix domain sockets: the workhorse of modern Linux IPC

Unix sockets (`AF_UNIX` / `AF_LOCAL`) are the real show. They're sockets:
same `socket()`, `bind()`, `listen()`, `accept()`, `connect()`, `send()`,
`recv()` API as TCP. But they stay entirely inside the kernel — no network
stack, no IP, no Ethernet. The address is a **pathname in the filesystem**
(or an abstract name in a private kernel namespace):

```c
// Server:
int s = socket(AF_UNIX, SOCK_STREAM, 0);  // like TCP, but local
struct sockaddr_un addr = { .sun_family = AF_UNIX, .sun_path = "/tmp/mysock" };
bind(s, (struct sockaddr*)&addr, sizeof(addr));
listen(s, 5);
int client = accept(s, NULL, NULL);       // new fd per client
```

```bash
# Server snippet (using socat):
socat UNIX-LISTEN:/tmp/mysock,fork - &

# Client:
echo hello | socat - UNIX-CONNECT:/tmp/mysock
```

Unix sockets support **all three socket types**:
- `SOCK_STREAM` — connection-oriented, reliable, sequenced byte stream (like TCP).
- `SOCK_DGRAM` — datagrams, unreliable, preserve message boundaries (like UDP,
  but reliable inside the kernel since there's no network to lose packets).
- `SOCK_SEQPACKET` — connection-oriented, reliable, preserves message boundaries.
  Each `send()` = one `recv()`.

### Key advantages over TCP sockets

| Feature | Unix Socket | TCP Socket |
|---|---|---|
| Address | Filesystem path ("/var/run/mysock") | IP:port ("127.0.0.1:5432") |
| Credential passing | Yes — kernel passes UID/GID/PID of peer | No |
| File descriptor passing | Yes — `sendmsg()` with `SCM_RIGHTS` | No |
| Performance | No TCP overhead, no IP, no Ethernet. ~2–3× faster than localhost TCP | Kernel copies, TCP stack, context switches |
| Security | File permissions. Only processes with filesystem access can connect | Anyone who can reach localhost (unless firewalled) |
| Abstract namespace | `\0myabstract` — no filesystem entry, no cleanup | N/A |

The filesystem-independent "abstract" namespace (path starts with `\0`) is
used by D-Bus, systemd, PulseAudio, X11, and Wayland — no leftover socket
files to clean up.

### File descriptor passing: the kernel superpower

A Unix socket can pass **open file descriptors** between processes. The sender
attaches an fd to a `sendmsg()` call; the receiver gets a *new* fd number that
refers to the *same* kernel `struct file`:

```c
// Sender:
sendmsg(sock, &msg, 0);  // msg.msg_control contains SCM_RIGHTS with fd

// Receiver:
recvmsg(sock, &msg, 0);
// received_fd now refers to the same file (or socket, or pipe, or memfd...)
```

This is how:
- **systemd** passes pre-opened listening sockets to services (socket activation).
  nginx never calls `bind()` — systemd binds the socket and hands it over.
- **Docker** passes the container's stdio fds from dockerd to containerd to shim to container.
- **PostgreSQL**'s `postmaster` passes client connections to freshly-forked backends.
- **Chromium** passes network sockets to the network service process.

### Credential passing

The kernel automatically attaches the sender's credentials to every message:

```c
struct ucred creds;
socklen_t len = sizeof(creds);
getsockopt(sock, SOL_SOCKET, SO_PEERCRED, &creds, &len);
// creds.pid, creds.uid, creds.gid  ← kernel-verified, cannot be faked
```

This is the foundation of D-Bus authentication, polkit, and systemd's
permission model. The kernel guarantees the identity — no user-space spoofing
possible.

## Where you find them in the wild

```bash
# D-Bus (user session): abstract namespace
ls -l /run/user/1000/bus               # symlink or socket
ss -xlpn | grep dbus                   # listen socket

# systemd journal: streaming logs
ss -xlpn | grep systemd-journal

# PostgreSQL:
ls -l /var/run/postgresql/.s.PGSQL.5432  # the Unix socket

# Docker daemon:
ls -l /var/run/docker.sock
# Everyone in the 'docker' group can read/write → root-equivalent!

# X11 (legacy — Wayland uses abstract sockets too):
ls -l /tmp/.X11-unix/X0

# snap / lxd / multipass — all use named sockets for API control
```

The `ss` command shows Unix sockets and their state:

```bash
ss -xpan                         # all Unix sockets, with owning process
ss -xln                          # listening Unix sockets
ss -xp | grep -c ESTAB           # how many active connections
```

## Pipe capacity: the forgotten tuning knob

The default pipe size is 64 KB. For high-throughput local data shuffling
(Gigabytes between a producer and consumer on the same machine), this creates
a ping-pong effect: producer fills 64 KB, blocks, consumer drains, producer
wakes, fills again... context switches dominate.

The fix: `fcntl(fd, F_SETPIPE_SZ, 1048576)` raises the buffer to 1 MB (or
up to `/proc/sys/fs/pipe-max-size`). Larger buffer = fewer context switches =
higher throughput.

```bash
cat /proc/sys/fs/pipe-max-size          # maximum allowed (1048576 by default)
cat /proc/sys/fs/pipe-user-pages-hard   # system-wide limit on pipe memory
```

## Try it yourself

```bash
# Anonymous pipe in action:
strace -f -e trace=pipe,dup2,clone sh -c 'ls | wc -l' 2>&1 | head -10
# Named pipe rendezvous:
mkfifo /tmp/demo && (sleep 2; echo hello > /tmp/demo) & cat /tmp/demo
# Unix sockets in your system RIGHT NOW:
ss -xpan | head -20
ls -l /run/user/$(id -u)/bus          # D-Bus
# Credential passing demo:
socat UNIX-LISTEN:/tmp/credsock,fork - &
socat - UNIX-CONNECT:/tmp/credsock &
ss -xp | grep credsock                # see SO_PEERCRED in action
```

## Check your understanding

1. What happens when a process writes to a pipe whose read end has been
   closed — and why is this a production reliability feature rather than a
   bug?
2. How does systemd's socket activation work at the fd level?
3. What's the security implication of Docker's `/var/run/docker.sock` being a
   Unix socket accessible to the `docker` group?
4. Why are Unix sockets faster than TCP localhost for inter-process
   communication?

*(Answers: kernel sends SIGPIPE (or returns EPIPE) to the writer — this is
the mechanism that kills the left side of `yes | head` so it doesn't run
forever, and it's the signal that makes pipelines self-cleaning; systemd
creates the listening socket (`bind()`+`listen()` on port 80), then passes the
open fd to nginx via Unix socket `SCM_RIGHTS` — nginx receives the pre-bound
fd and starts accepting connections without ever calling `bind()` itself;
anyone in the docker group can write to the socket, and the Docker API on
that socket permits creating privileged containers, mounting host paths, and
running commands as root — access to docker.sock is effectively root access;
no TCP handshake, no IP fragmentation/reassembly, no congestion control, no
NIC driver DMA — data stays entirely in kernel memory and is copied between
buffer caches, bypassing the entire network stack.)*

---

**Next:** Part IV. We take everything so far — processes, signals, pipes, the
networking stack — and discover that containers were hiding in plain sight
all along. Kernel features you already understand, combined to lie to a
process about the world.
