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
```

What TCP itself gives you (all inside the kernel): ordered, reliable delivery
(sequence numbers + retransmission), flow control (don't drown the receiver),
and congestion control (don't drown the network). UDP gives you none of that
— just addressed datagrams — which is why DNS, games and QUIC use it.

## The journey of a packet

**Sending** (`write(fd, "GET /…", n)`):

1. Bytes are copied into the socket's **send buffer**; `write()` returns —
   transmission is asynchronous from your program's view.
2. TCP slices the buffer into segments (respecting MTU), stamps
   ports/sequence numbers.
3. IP adds addresses, consults the **routing table** → which interface, which
   next hop?
4. ARP/neighbour table resolves next hop IP → MAC address.
5. The driver hands the frame to the NIC via a DMA ring buffer; the NIC puts
   it on the wire.

**Receiving** mirrors it: NIC DMAs the frame to RAM → interrupt (NAPI-polled
under load) → IP checks "is this for me?" → TCP matches the 4-tuple, queues
the payload in that socket's **receive buffer** → wakes any process blocked
in `read()`. The packet's whole kernel journey happens in softirq context —
the `ksoftirqd` threads you met last chapter.

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
  10.0.0.5:80". This is `docker run -p 8080:80`, literally.

```bash
sudo iptables -t nat -L -n | head      # spot Docker's MASQUERADE rules, if present
conntrack -L 2>/dev/null | head        # NAT's memory: tracked connections
```

**Connection tracking** (`conntrack`) is the stateful memory making NAT and
"allow established" firewall rules possible — a table of every flow the
kernel has seen.

## Virtual networking: the container toolbox

Everything above used physical NICs. The kernel can also create **virtual**
network devices — this is the LEGO box containers are assembled from:

| Device | What it is |
|---|---|
| `lo` | Loopback — 127.0.0.1, packets U-turn inside the kernel |
| **veth pair** | A virtual patch cable: two interfaces; in one end, out the other. One end goes *inside* a container, one stays outside |
| **bridge** | A virtual L2 switch (`docker0` is one) — veths plug into it |
| vlan / vxlan | L2 segmentation / L2-over-UDP tunnels (Kubernetes overlays) |
| tun/tap | Packets to/from a *user-space program* — VPNs (WireGuard, OpenVPN), QEMU |

A taste (root required) — the exact plumbing `docker network` automates:

```bash
sudo ip link add veth-a type veth peer name veth-b   # create the cable
sudo ip link add br0 type bridge                     # create the switch
sudo ip link set veth-b master br0                   # plug one end in
```

Add the fact that *network interfaces, routes, and firewall rules all live in
a network namespace* (next part!), and you can already guess the whole
container networking recipe: new namespace + veth cable + bridge + NAT.
Chapter "Container Networking" assembles it for real.

## Name resolution, the 30-second version

`curl example.org` first resolves the name: glibc consults
`/etc/nsswitch.conf` → `/etc/hosts`, then DNS via `/etc/resolv.conf`
(on systemd boxes usually pointing at the local `systemd-resolved` cache).
DNS queries are plain UDP/TCP port 53 — ordinary sockets, nothing special in
the kernel. Misbehaving name resolution is user-space 99% of the time.

```bash
resolvectl status | head; getent hosts example.org
```

## Try it yourself

```bash
ip addr; ip route; ip neigh                  # interfaces, routes, ARP cache
ss -tlnp                                     # who is listening on what
ping -c2 192.168.1.1; ip neigh               # watch ARP learn the gateway
sudo tcpdump -i any -n port 53 -c 5 &        # sniff DNS…
getent hosts example.org                     # …while causing some
sudo iptables -L -n -v | head                # your firewall, if any
```

## Check your understanding

1. How does the kernel know which process gets an arriving TCP segment?
2. What does MASQUERADE rewrite, and why does it need connection tracking?
3. Which three virtual devices would you combine to network a container?

---

**Next:** Part III. We take everything so far — processes, mounts, cgroups
hooks, virtual networking — and discover containers were hiding in plain
sight all along.
