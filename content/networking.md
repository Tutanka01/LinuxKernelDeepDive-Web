# The Networking Stack

> **Goal:** follow a byte from `write()` on a socket to electrical signals and
> back, meet the kernel objects involved (sockets, interfaces, routes,
> netfilter), and pre-build every concept container networking will need.

## The layered reality

The kernel implements the classic TCP/IP stack. Mapping the theory to what
Linux actually has:

```text
  application        your process: nginx, curl, ssh        (user space)
──────────────────── socket syscalls ─────────────────────
  transport          TCP / UDP        ← ports, reliability  (kernel)
  network            IP               ← addressing, routing  (kernel)
  link               Ethernet, ARP    ← frames on one LAN    (kernel+driver)
  physical           the NIC          ← bits on a wire       (hardware)
```

Each layer wraps the previous: your HTTP bytes ride in TCP segments, inside
IP packets, inside Ethernet frames. The kernel does all the
wrapping/unwrapping; applications only ever see the socket bytestream.

## Sockets: the API

A **socket** is a kernel object (held via a file descriptor, naturally) that
represents one communication endpoint. The server-side liturgy:

```text
socket() → bind(:80) → listen() → accept() ──► new fd per client
                                                read()/write()
client:   socket() → connect(host:80)        → write()/read()
```

A TCP connection is uniquely identified by the 4-tuple
`(src IP, src port, dst IP, dst port)` — that's how one server on port 80
talks to thousands of clients simultaneously: every connection's tuple
differs, and the kernel demultiplexes incoming segments to the right socket.

```bash
ss -tlnp        # listening TCP sockets and who owns them
ss -tnp | head  # established connections
ss -s           # summary: total TCP/UDP/RAW sockets
ss -t -o        # connections with timers (keepalive, retransmit, etc.)
```

### The socket states (TCP state machine)

Every TCP socket moves through states tracked by the kernel:

```text
LISTEN → SYN_RECV → ESTABLISHED → FIN_WAIT1 → FIN_WAIT2 → TIME_WAIT → CLOSED
                                     ↓
                              CLOSE_WAIT → LAST_ACK → CLOSED

TIME_WAIT lasts 2×MSL (60s typically) — the socket lingers to catch
straggler packets. A server that opens/closes thousands of connections
can accumulate TIME_WAIT sockets; this is normal, not a leak.
```

```bash
ss -tan | awk '{print $1}' | sort | uniq -c  # count by state
cat /proc/net/sockstat           # socket counts system-wide
cat /proc/sys/net/ipv4/tcp_fin_timeout  # TIME_WAIT duration
```

What TCP itself gives you (all inside the kernel): ordered, reliable delivery
(sequence numbers + retransmission), flow control (don't drown the receiver),
and congestion control (don't drown the network). UDP gives you none of that
— just addressed datagrams — which is why DNS, games and QUIC use it.

### Kernel bypass for performance

A normal socket path involves copies, sk_buff allocations, and kernel
processing. For extreme throughput (10Gbps+ with many small packets),
kernel-bypass frameworks like **DPDK** and **AF_XDP** let user space directly
send and receive raw packets from NIC hardware queues, bypassing the kernel
stack entirely. This is how high-frequency trading and carrier-grade load
balancers work — but it's a niche: you lose all kernel TCP/UDP/IP processing
and must implement everything in user space or hardware.

## The journey of a packet

**Sending** (`write(fd, "GET /…", n)`):

1. Bytes are copied into the socket's **send buffer**; `write()` returns —
   transmission is asynchronous from your program's view. (If the buffer
   is full, `write()` blocks or returns EAGAIN.)
2. TCP slices the buffer into segments (respecting MSS — Maximum Segment Size,
   derived from MTU), stamps ports/sequence numbers, sets flags (SYN, ACK,
   PSH).
3. IP adds addresses and TTL, consults the **routing table** → which
   interface, which next hop? Builds the IP header.
4. The neighbour subsystem resolves next hop IP → MAC address via **ARP**
   (IPv4) or **NDP** (IPv6). Cached in the neighbour table.
5. The driver pulls the completed `sk_buff` from the qdisc (queue discipline)
   attached to the interface, hands the frame to the NIC via a DMA ring
   buffer; the NIC puts it on the wire and interrupts when done.

**Receiving** mirrors it: NIC DMAs the frame to RAM (the driver pre-allocated
DMA buffers) → interrupt (or NAPI poll under load) → driver allocates
`sk_buff`, hands to the network stack → IP validates checksum, checks "is
this for me?" (or forward it if routing) → TCP matches the 4-tuple, ACKs the
segment, queues the payload in that socket's **receive buffer** → wakes any
process blocked in `read()`. The whole in-kernel journey happens in softirq
context — `ksoftirqd` on each CPU.

```bash
ip -s link show eth0        # TX/RX bytes, packets, errors, drops
netstat -s | head -40        # kernel TCP/UDP/IP stats ("TcpExt:" section is gold)
ss -m                        # socket memory usage
```

### What the socket buffers really mean

Every socket has an rcvbuf (receive buffer) and sndbuf (send buffer). These
are per-socket, in RAM:

```bash
cat /proc/sys/net/core/rmem_default   # default receive buffer size
cat /proc/sys/net/core/wmem_default   # default send buffer size
cat /proc/sys/net/core/rmem_max       # maximum allowed (CAP_NET_ADMIN can raise)
ss -m | head                          # per-socket buffer usage
```

TCP auto-tuning adjusts these dynamically based on the connection's BDP
(Bandwidth-Delay Product). If you're doing 10 Gbit transfers over 50ms RTT,
the kernel will grow the buffers to fill the pipe. If memory is tight, it
stays small. This is almost always the right default.

## Routing: every Linux box is a router

```bash
ip addr        # interfaces and their IPs
ip route       # the kernel's forwarding logic
```

```text
default via 192.168.1.1 dev wlan0            ← anything else: send to gateway
192.168.1.0/24 dev wlan0  src 192.168.1.42   ← my LAN: deliver directly
```

The kernel picks the **most specific matching prefix**. With
`net.ipv4.ip_forward=1`, it will also forward packets *between* interfaces —
your laptop becomes a router. Container networking (and Kubernetes, and your
home router, which runs Linux) is built on exactly this.

```bash
ip route get 8.8.8.8              # which route and source IP would be used?
ip neigh                           # the ARP/NDP neighbour table
ip -s neigh                        # includes reachability state
```

The routing table supports **policy routing**: `ip rule` creates routing
policies based on source IP, fwmark, or incoming interface. This is used for
multi-homed servers and advanced container networking.

## netfilter: hooks in the packet path

At five points along a packet's path through the kernel, **netfilter** lets
rules inspect/modify/drop it. `iptables` (legacy) and `nftables` (modern)
are the user-space tools that program those hooks.

```text
            ┌─────────► INPUT ───► local process
incoming → PREROUTING                  │
            └─► FORWARD ─┐          OUTPUT
                         ▼             │
                    POSTROUTING ◄──────┘ → outgoing
```

Three things get built on these hooks:

- **Firewalls** — `filter` table: accept/drop per rule.
- **NAT** — `nat` table rewrites addresses. **Masquerade** = "as packets
  leave, replace their private source IP with mine, and un-rewrite the
  replies" — how your whole home shares one public IP, *and* how containers
  reach the internet.
- **Port forwarding** — DNAT in PREROUTING: "port 8080 arriving here →
  pod IP:80". This is `docker run -p 8080:80`, literally.

```bash
sudo nft list ruleset               # nftables replacement for iptables
sudo iptables -t nat -L -n -v       # NAT rules with hit counters
sudo iptables -t filter -L -n -v    # firewall rules with counters
cat /proc/net/netfilter/nf_conntrack | head  # the connection tracking table
conntrack -L 2>/dev/null | head     # same, cleaner
```

**Connection tracking** (`conntrack`) is the stateful memory making NAT and
"allow established" firewall rules possible — a table of every flow the
kernel has seen. It maps each packet to a tracked connection, automatically
applying the right NAT for replies. The size is limited:

```bash
cat /proc/sys/net/netfilter/nf_conntrack_max
dmesg | grep "nf_conntrack: table full"  # the dreaded "dropping packet" log
```

## Virtual networking: the container toolbox

Everything above used physical NICs. The kernel can also create **virtual**
network devices — this is the LEGO box containers are assembled from:

| Device | What it is |
|---|---|
| `lo` | Loopback — 127.0.0.1, packets U-turn inside the kernel, never hit a NIC |
| **veth pair** | A virtual patch cable: two interfaces; in one end, out the other. One end goes *inside* a container, one stays outside |
| **bridge** | A virtual L2 switch (`docker0` is one) — veths plug into it, learns MACs, forwards frames |
| **vlan / vxlan** | L2 segmentation / L2-over-UDP tunnels (Kubernetes overlays — flannel uses vxlan) |
| **tun/tap** | Packets to/from a *user-space program* — VPNs (WireGuard, OpenVPN), QEMU |
| **macvlan / ipvlan** | Give a container its own MAC/IP on the physical LAN — no NAT, direct L2 |
| **bond** | Link aggregation (LACP, round-robin, active-passive) |

A taste (root required) — the exact plumbing `docker network` automates:

```bash
sudo ip link add veth-a type veth peer name veth-b   # create the cable
sudo ip link add br0 type bridge                     # create the switch
sudo ip link set veth-b master br0                   # plug one end in
sudo ip link set veth-b up; sudo ip link set veth-a up
```

Add the fact that *network interfaces, routes, and firewall rules all live in
a network namespace* (next part!), and you can already guess the whole
container networking recipe: new namespace + veth cable + bridge + NAT.
Chapter "Container Networking" assembles it for real.

## eBPF and XDP in the networking stack

The networking chapter of Part IV covers eBPF deeply, but worth a preview
here: eBPF programs can attach at multiple points in the network stack:

- **XDP**: before `sk_buff` allocation, in the NIC driver's receive path.
  Drop, redirect, or pass at line rate. DDoS mitigation, load balancers.
- **TC**: on the qdisc, after the packet is an skb. Traffic shaping, policy.
- **sockets**: per-socket eBPF programs for custom filtering.

This is increasingly how high-performance container networking (Cilium) and
service mesh data planes work: instead of iptables rules, eBPF programs
attached to the relevant kernel hooks handle policy at native speed.

## Name resolution, the 30-second version

`curl example.org` first resolves the name: glibc consults
`/etc/nsswitch.conf` → `/etc/hosts`, then DNS via `/etc/resolv.conf`.
DNS queries are plain UDP/TCP port 53 — ordinary sockets, nothing special in
the kernel. Misbehaving name resolution is user-space 99% of the time.

```bash
resolvectl status | head; getent hosts example.org
cat /etc/nsswitch.conf | grep hosts
dig +short example.org      # raw DNS query, bypasses nsswitch
```

## Try it yourself

```bash
ip addr; ip route; ip neigh                  # interfaces, routes, ARP cache
ss -tlnp                                     # who is listening on what
ss -tan | awk '{print $1}' | sort | uniq -c  # connection state distribution
ping -c2 192.168.1.1; ip neigh               # watch ARP learn the gateway
sudo tcpdump -i any -n port 53 -c 5 &        # sniff DNS…
getent hosts example.org                     # …while causing some
sudo nft list ruleset                        # modern firewall rules
# Trace one packet's kernel path:
cat /proc/net/netfilter/nf_conntrack_count   # connection tracking table size
```

## Check your understanding

1. How does the kernel know which process gets an arriving TCP segment?
2. What does MASQUERADE rewrite, and why does it need connection tracking?
3. Which three virtual devices would you combine to network a container?
4. What does TIME_WAIT mean, and why isn't a socket leak if you have
   thousands of them?
5. Why might a 10 Gbit connection achieve only 500 Mbit when using default
   socket buffer sizes on a cross-continent link?

*(Answers: the kernel matches the 4-tuple (src IP, src port, dst IP, dst port)
to find the correct socket in the established connections table; it rewrites
the source IP to the host's outgoing IP — connection tracking remembers the
original tuple so reply packets can be un-rewritten back to the container's
private IP; veth pair + bridge + NAT (MASQUERADE rule); TIME_WAIT is the
protocol state after closing — the socket waits 2×MSL to catch straggling
packets, this is normal TCP behaviour not a leak, and modern kernels handle
it well; the default socket buffers are too small for large BDP — the
Bandwidth-Delay Product (10Gbps × 100ms RTT = 125MB) exceeds the default
rmem/wmem, and TCP auto-tuning needs room to grow. Set rmem_max/wmem_max
appropriately or use setsockopt(SO_RCVBUF/SO_SNDBUF).)*

---

**Next:** Part III — a crucial piece missing from the picture. Processes are
isolated, but they need to talk. Signals, pipes, and Unix domain sockets — the
kernel's inter-process communication primitives that every shell pipeline and
every daemon depends on.
