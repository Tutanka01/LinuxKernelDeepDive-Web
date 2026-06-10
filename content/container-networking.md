# Container Networking

> **Goal:** build Docker's default networking with bare `ip` commands —
> namespace, veth, bridge, NAT, port publishing — then map it to what Docker
> and Kubernetes do for you. Pure application of the networking chapter.

## The problem

A new network namespace is a sealed box: one dead loopback, no routes, no
reach. Container networking is the answer to: **how does a sealed box talk
to the world without un-sealing it?**

Docker's default answer (the `bridge` network):

```text
                    HOST
  ┌────────────────────────────────────────────┐
  │              docker0 (bridge, 172.17.0.1)  │
  │              /        \                    │
  │        vethA1          vethB1   ← host ends│
  │           │               │                │
  │  ╔════════╪═══════╗ ╔═════╪══════════╗     │
  │  ║ ctr A  │       ║ ║ ctr B          ║     │
  │  ║  eth0 (vethA2) ║ ║  eth0 (vethB2) ║     │
  │  ║  172.17.0.2    ║ ║  172.17.0.3    ║     │
  │  ╚════════════════╝ ╚════════════════╝     │
  │                                            │
  │  eth0 (host NIC) ←— NAT (MASQUERADE) —→ internet
  └────────────────────────────────────────────┘
```

Every part is a stock kernel object from the networking chapter: **veth
pairs** (virtual patch cables crossing the namespace wall), a **bridge**
(virtual switch that learns MAC addresses and forwards frames), **routes**
(`ip route`), **netfilter NAT** (MASQUERADE rule in POSTROUTING).

## Build it by hand

Reproduce Docker's plumbing in ~15 commands (root, on a test box;
`ip netns` is `unshare --net` with a name attached):

```bash
# 1. a "container": a named network namespace
ip netns add ctr
ip netns exec ctr ip addr                 # the sealed box: only lo, DOWN

# 2. the switch
ip link add br0 type bridge
ip addr add 172.18.0.1/24 dev br0         # host's address ON the bridge
ip link set br0 up

# 3. the patch cable: one end stays, one end goes inside
ip link add veth-host type veth peer name veth-ctr
ip link set veth-host master br0 && ip link set veth-host up
ip link set veth-ctr netns ctr            # ← the magic move

# 4. configure inside
ip netns exec ctr ip link set lo up
ip netns exec ctr ip addr add 172.18.0.2/24 dev veth-ctr
ip netns exec ctr ip link set veth-ctr up
ip netns exec ctr ip route add default via 172.18.0.1

# 5. container ↔ host works already:
ip netns exec ctr ping -c1 172.18.0.1
```

Internet access needs two more things — the host must *forward*, and private
addresses must be *masqueraded* (both straight from the networking chapter):

```bash
sysctl -w net.ipv4.ip_forward=1
nft add table nat
nft add chain nat postrouting { type nat hook postrouting priority 100 \; }
nft add rule nat postrouting ip saddr 172.18.0.0/24 oifname eth0 masquerade
# (or iptables: iptables -t nat -A POSTROUTING -s 172.18.0.0/24 ! -o br0 -j MASQUERADE)

ip netns exec ctr ping -c1 1.1.1.1        # the box talks to the world
```

That's it. `docker network create` + container attach ≈ these commands with
generated names. Run `ip link`, `bridge link`, and
`iptables -t nat -L POSTROUTING -n` on a Docker host and you'll recognize
every object. Cleanup: `ip netns del ctr; ip link del br0;` plus the NAT
rule.

## Port publishing = DNAT

Containers can dial out, but inbound? 172.18.0.2 is invisible to the world.
`docker run -p 8080:80` installs a **DNAT** rule — "TCP to host:8080 →
rewrite destination to 172.17.0.2:80" — in PREROUTING:

```bash
docker run -d -p 8080:80 nginx
sudo iptables -t nat -L PREROUTING -n | grep -E 'DNAT|8080'
# DNAT tcp dpt:8080 to:172.17.0.2:80        ← there's your -p flag
```

Connection tracking (networking chapter) un-rewrites the replies
automatically — the container sees connections from the real client IP
(transparent), and the client sees the host IP (SNAT/MASQUERADE on the
outbound reply, also in POSTROUTING).

Note the security folklore this explains: published ports bypass simple host
firewalls, because DNAT happens in PREROUTING — *before* the INPUT chain
is consulted; the packets traverse the FORWARD chain, where Docker manages
its own rules (DOCKER and DOCKER-USER chains). To filter published ports,
use rules in the FORWARD chain or the DOCKER-USER chain.

```bash
# Docker's NAT + filter rules:
sudo iptables -t nat -L -n -v    # see DNAT rules and hit counters
sudo iptables -L DOCKER-USER -n -v  # place your own rules here (persistent across restarts)
```

## The menu of network modes

| Mode | What it is | Trade-off |
|---|---|---|
| `bridge` (default) | everything above | NAT cost; ports must be published |
| `host` | **no net namespace at all** — host's stack | zero overhead, zero isolation; port clashes |
| `none` | the sealed box, kept sealed — only loopback | for paranoid batch jobs |
| `container:X` / pod | share another container's net ns | "localhost" between them — Kubernetes pods |
| `macvlan/ipvlan` | container appears on the physical LAN with its own MAC/IP | no NAT, but needs a cooperative network (DHCP, VLAN) |
| rootless (slirp4netns/pasta) | user-space NAT relay via TAP device | works without root; ~10× slower for high-throughput |

`--network host` being literally "skip `CLONE_NEWNET`" is a nice reminder
that every mode is just a different namespace/plumbing decision.

### macvlan vs ipvlan

- **macvlan**: each container gets its own MAC address on the physical
  interface. Works with DHCP, looks like a separate physical machine. Most
  cloud networks block multiple MACs per port (anti-spoofing).
- **ipvlan**: containers share the host's MAC but get different IPs. The
  kernel demuxes based on IP. Works where macvlan doesn't. L2 mode vs L3
  mode (routed).

## DNS and service discovery

How does container `web` reach container `db` *by name*?

- Docker's embedded DNS server (127.0.0.11, inside the container's netns via
  iptables redirect rules) answers with container IPs on user-defined
  networks. It resolves container names (and service:alias names in Compose)
  to the correct internal IP.
- On the default `bridge` network, name resolution is via `/etc/hosts`
  injection only — no DNS. Use a user-defined network (`docker network create
  mynet`) for automatic DNS.
- `/etc/resolv.conf` and `/etc/hosts` are bind-mounted into the container
  (mount namespace + net namespace working together).

```bash
docker network create mynet
docker run -d --net mynet --name db postgres
docker run --net mynet alpine ping db     # resolved via internal DNS
docker exec db cat /etc/resolv.conf       # nameserver 127.0.0.11
```

### Kubernetes DNS

Kubernetes scales the same idea: CoreDNS (a cluster DNS service) resolves
Service names to ClusterIPs (stable virtual IPs). kube-proxy (running on
every node) translates the ClusterIP to a pod IP via iptables/IPVS/eBPF
rules:

```text
app → service-name.namespace.svc.cluster.local
  → CoreDNS → ClusterIP (10.96.0.10)
  → iptables/IPVS DNAT → actual pod IP (10.244.1.5)
```

## Sixty seconds of Kubernetes networking

The K8s model removes NAT-between-pods: **every pod gets a real,
cluster-routable IP; all pods reach all pods without NAT.** How? A **CNI
plugin** runs the veth dance on each node and then makes pod subnets
routable between nodes:

- **flannel** — simplest: VXLAN overlay (L2-over-UDP tunnels), or host-gw
  mode (just route entries, needs L2 adjacency).
- **Calico** — no tunnels, BGP routing between nodes. Pod IPs are real,
  routable cluster-wide.
- **Cilium** — eBPF datapath: replaces iptables with eBPF programs attached
  to kernel hooks. Much faster at scale (thousands of services).
- **Weave** — mesh overlay with a user-space router.

Different transports, same endgame: namespaces + veths + routing, at fleet
scale. Nothing you haven't already built by hand today.

## Debugging cheat-sheet

The skills that solve 90% of "container can't reach X":

```bash
PID=$(docker inspect -f '{{.State.Pid}}' ctr)
sudo nsenter -t $PID -n ip addr          # host tools, container's network
sudo nsenter -t $PID -n ss -tlnp         # who listens inside?
sudo nsenter -t $PID -n ip route         # container's routing table
sudo nsenter -t $PID -n ping 172.17.0.1  # can it reach its gateway?
sudo nsenter -t $PID -n nslookup external.com  # DNS working?
sudo tcpdump -i docker0 -n icmp          # watch traffic at the bridge
sudo iptables -t nat -L -n -v            # DNAT/MASQ rules + hit counters
docker exec ctr cat /etc/resolv.conf     # who answers its DNS?
docker network inspect bridge            # configured subnet and containers
```

`nsenter -t <pid> -n <cmd>` is the star: full host tooling, container
viewpoint, no shell needed in the image.

### Common failure modes

| Symptom | Likely cause |
|---|---|
| Container can't reach internet | `ip_forward=0`, MASQUERADE rule missing, or FORWARD chain drops |
| Published port not reachable | DNAT rule missing, or container not listening on 0.0.0.0 |
| Containers can't reach each other by name | Not on a user-defined network (default bridge = /etc/hosts only) |
| Intermittent DNS failures | DNS embedded server overloaded, or DNAT rule conflict |
| Container IP reused after restart | The bridge recycles IPs quickly — use a defined subnet |

## Check your understanding

1. List the five kernel objects/rules that connect a bridged container to
   the internet.
2. Why can 50 containers all "listen on port 80" without conflict — and what
   makes one of them reachable from outside?
3. Why might a host firewall rule on INPUT fail to block a published port?
4. What does `--network host` change at container-creation time, in
   clone-flag terms?
5. Why does a container see `nameserver 127.0.0.11` in /etc/resolv.conf?

*(Answers: net namespace, veth pair (one end inside, one outside), bridge,
route (default via bridge gateway), NAT MASQUERADE (SNAT outbound); each
container has its own network namespace — port 80 in one namespace is
independent of port 80 in another (different port spaces), and port
publishing via DNAT maps a host port to a specific container's
<IP:port>; published ports are DNAT'd in PREROUTING before the INPUT chain
— the packet traverses FORWARD, not INPUT, so INPUT rules don't apply (use
FORWARD or DOCKER-USER chain); --network host skips CLONE_NEWNET entirely —
the container runs in the host's network namespace with no isolation; Docker
runs an embedded DNS server inside the container's network namespace on
127.0.0.11, and iptables redirects DNS queries to it — this provides
automatic service discovery on user-defined networks.)*

---

**Next:** Part IV — modern kernel mechanisms. We start with eBPF: the
programmable substrate underneath observability, networking, and runtime
security.
