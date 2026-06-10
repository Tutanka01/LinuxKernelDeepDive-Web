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
(virtual switch), **routes**, **netfilter NAT**.

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
ip netns exec ctr ip addr add 172.18.0.2/24 dev veth-ctr
ip netns exec ctr ip link set veth-ctr up
ip netns exec ctr ip link set lo up
ip netns exec ctr ip route add default via 172.18.0.1

# 5. container ↔ host works already:
ip netns exec ctr ping -c1 172.18.0.1
```

Internet access needs two more things — the host must *forward*, and private
addresses must be *masqueraded* (both straight from the networking chapter):

```bash
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 172.18.0.0/24 ! -o br0 -j MASQUERADE

ip netns exec ctr ping -c1 1.1.1.1        # the box talks to the world
```

That's it. `docker network create` + container attach ≈ these commands with
generated names. Run `ip link`, `bridge link`, and
`iptables -t nat -L POSTROUTING -n` on a Docker host and you'll recognize
every object (Docker is moving its rules to nftables, but the shape is
identical). Cleanup: `ip netns del ctr; ip link del br0;` plus the iptables
rule.

## Port publishing = DNAT

Containers can dial out, but inbound? 172.18.0.2 is invisible to the world.
`docker run -p 8080:80` installs a **DNAT** rule — "TCP to host:8080 →
rewrite destination to 172.17.0.2:80" — in PREROUTING (plus a userland
helper, `docker-proxy`, for edge cases):

```bash
docker run -d -p 8080:80 nginx
sudo iptables -t nat -L -n | grep -E 'DNAT|8080'
# DNAT tcp dpt:8080 to:172.17.0.2:80        ← there's your -p flag
```

Connection tracking (networking chapter) un-rewrites the replies. Note the
security folklore this explains: published ports bypass simple host
firewalls, because DNAT happens in PREROUTING — *before* INPUT rules are
consulted; the packets traverse FORWARD, where Docker manages its own chains.

## The menu of network modes

| Mode | What it is | Trade-off |
|---|---|---|
| `bridge` (default) | everything above | NAT cost; ports must be published |
| `host` | **no net namespace at all** — host's stack | zero overhead, zero isolation; port clashes |
| `none` | the sealed box, kept sealed | for paranoid batch jobs |
| `container:X` / pod | share another container's net ns | "localhost" between them — Kubernetes pods |
| `macvlan/ipvlan` | container appears on the physical LAN with its own MAC/IP | no NAT, but needs a cooperative network |
| rootless (slirp4netns/pasta) | user-space NAT relay | works without root; slower |

`--network host` being literally "skip `CLONE_NEWNET`" is a nice reminder
that every mode is just a different namespace/plumbing decision.

## DNS and service discovery

How does container `web` reach container `db` *by name*?

- Docker writes the container's `/etc/resolv.conf` to point at an embedded
  DNS server (127.0.0.11, inside the container's netns), which answers with
  container IPs on the same user-defined network and forwards the rest.
  (Name resolution on the *default* bridge is legacy-limited — use a created
  network: `docker network create mynet`.)
- `/etc/hosts` and `/etc/hostname` are bind-mounted in, too — mnt namespace
  tricks complementing net namespace plumbing.

Kubernetes scales the same idea: a cluster DNS (CoreDNS) names *Services*,
and a Service's stable virtual IP is translated to pod IPs by — what else —
netfilter/IPVS/eBPF rules programmed by kube-proxy on every node.

## Sixty seconds of Kubernetes networking

The K8s model removes the NAT-between-pods wrinkle: **every pod gets a real,
cluster-routable IP; all pods reach all pods without NAT.** How? A **CNI
plugin** runs the veth dance on each node and then makes pod subnets
routable between nodes:

- **flannel** — VXLAN overlay (L2-over-UDP tunnels, networking chapter);
- **Calico** — no tunnels, just routes (BGP);
- **Cilium** — eBPF datapath, increasingly bypassing netfilter entirely.

Different transports, same endgame: namespaces + veths + routing, at fleet
scale. Nothing you haven't already built by hand today.

## Debugging cheat-sheet

The skills that solve 90% of "container can't reach X":

```bash
PID=$(docker inspect -f '{{.State.Pid}}' ctr)
sudo nsenter -t $PID -n ip addr          # host tools, container's network
sudo nsenter -t $PID -n ss -tlnp         # who listens inside?
sudo nsenter -t $PID -n ping 172.17.0.1  # can it reach its gateway?
sudo tcpdump -i docker0 -n               # watch traffic at the bridge
sudo iptables -t nat -L -n -v            # are the DNAT/MASQ rules there? hits?
docker exec ctr cat /etc/resolv.conf     # who answers its DNS?
```

`nsenter -n` (namespaces chapter) is the star: full host tooling, container
viewpoint, no shell needed in the image.

## Check your understanding

1. List the five kernel objects/rules that connect a bridged container to
   the internet.
2. Why can 50 containers all "listen on port 80" without conflict — and what
   makes one of them reachable from outside?
3. Why might a host firewall rule on INPUT fail to block a published port?
4. What does `--network host` change at container-creation time, in
   clone-flag terms?

---

**Next:** Part IV — the observability toolbox: /proc, strace, perf and eBPF,
i.e. how to *see* everything this site described, live.
