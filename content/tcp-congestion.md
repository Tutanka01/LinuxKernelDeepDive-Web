# TCP Congestion Control & Network Tuning

> **Goal:** understand what TCP congestion control actually does in the kernel — not just the algorithm names, but the pacing, the queues, the sysctl knobs, the interaction with packet scheduling, and why changing `tcp_congestion_control` can transform your workload's behavior from terrible to excellent.

## The problem congestion control solves

TCP reliably delivers a stream of bytes. But between the sender and receiver sits a network — a shared resource of unknown capacity. Send too fast, and intermediate routers drop packets. Send too slow, and you waste available bandwidth.

The kernel doesn't know the path capacity. It must **discover** it dynamically by probing, observing packet loss (or delay), and adjusting the **congestion window** (cwnd): the number of unacknowledged bytes in flight.

```text
sender                                    receiver
  │──── seq=1..1000 ─────────────────────→│
  │──── seq=1001..2000 ──────────────────→│
  │──── seq=2001..3000 ────X  (lost)      │
  │                                        │── ack=2001 (expecting 2001)
  │←── ack=2001 ────────────────────────│     "duplicate ack"
  │←── ack=2001 ────────────────────────│     "duplicate ack"
  │←── ack=2001 ────────────────────────│     "triple duplicate ack" = loss signal
  │──── seq=2001..3000 ──────────────────→│  (fast retransmit, cwnd halved)
```

The congestion window is not `socket.send_buffer_size`. It's a dynamic cap on in-flight data managed *per connection* by the kernel. Every ACK increases it slightly; every loss detected decreases it sharply. This loop is the entire game.

```bash
# What algorithm is your host using?
sysctl net.ipv4.tcp_congestion_control
# Available algorithms:
sysctl net.ipv4.tcp_available_congestion_control

# Change it (takes effect for new connections)
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

## The classic: CUBIC

The default in Linux since kernel 2.6.19 (and still the most common default worldwide). CUBIC's key insight: after a loss event, don't grow the window linearly (like classic Reno). Grow it as a cubic function of time since the loss — aggressive probing when the network is likely empty, conservative near the estimated capacity.

```text
window size
    │       ╱╲        ╱╲
    │      ╱  ╲      ╱  ╲      ← cubic probes aggressively in "concave" region
    │     ╱    ╲    ╱    ╲
    │────╱      ╲──╱      ╲─── ← plateaus near estimated capacity
    │   ╱        ╲╱        ╲
    │──╱─────────────────────╲──
    └────────────────────────────→ time
         loss     loss     loss
```

CUBIC works well on long, high-bandwidth paths because the cubic growth rate is independent of RTT. A connection with 200ms RTT probes at the same clock-time rate as one with 5ms RTT. Reno doesn't — each ACK increases cwnd, so high-RTT connections grow slowly (the "RTT unfairness" problem).

But CUBIC has a fundamental issue on modern links: it uses **packet loss** as the congestion signal. On shallow-buffered links, this means it induces loss to find capacity. On deep-buffered links (the "bufferbloat" problem), it inflates queues before seeing loss, causing massive latency under load.

```bash
# CUBIC-specific knobs
sysctl net.ipv4.tcp_congestion_control=cubic
sysctl net.ipv4.tcp_cubic_beta        # 717 (cwnd multiplier after loss, 717/1024 = 0.7)
sysctl net.ipv4.tcp_cubic_fast_convergence  # 1 (more aggressive after idle periods)
```

## BBR: the revolution

BBR (Bottleneck Bandwidth and Round-trip propagation time), developed at Google and merged in kernel 4.9, fundamentally rethinks the problem. Instead of probing for loss, BBR models the path directly:

1. **Estimate bandwidth** by tracking delivery rate over a sliding window (~8 RTTs)
2. **Estimate RTT** by tracking the minimum observed RTT (the propagation delay)
3. **Aim for bandwidth × RTT** worth of data in flight — exactly the BDP (bandwidth-delay product)

```text
CUBIC mental model:  "increase until loss, then back off"
BBR mental model:    "measure the pipe, then fill it exactly"

                                         BBR pacing rate
                                            ╭─────┴──────╮
         sender    │←───── BDP ─────→│   receiver
                   │  bandwidth × RTT │
                   │  worth of bytes  │
```

BBR doesn't need loss to back off. It probes the maximum bandwidth and minimum RTT periodically, keeping the queue at the bottleneck small. Result: high throughput **and** low latency simultaneously — the holy grail that CUBIC can't achieve.

However, BBRv1 has its own issues: in multi-flow scenarios, BBRv1 flows can starve CUBIC flows at deep-buffered bottlenecks. BBRv2 (in development) addresses this with explicit loss and ECN sensitivity.

```bash
# Enable BBR
modprobe tcp_bbr
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Verify it's active
ss -tin | grep bbr       # connections using BBR show "bbr" in info
```

### What "pacing" means

A crucial BBR innovation: **pacing**. Instead of bursting out the entire cwnd when a window of ACKs arrives, BBR spaces packets evenly across an RTT. This requires the kernel's **FQ (Fair Queue)** qdisc or the built-in TCP internal pacing (kernel 5.14+):

```bash
# Classic: use FQ qdisc for BBR pacing (pre-5.14)
tc qdisc replace dev eth0 root fq

# Modern: TCP internal pacing (5.14+)
sysctl net.ipv4.tcp_pacing_ss_ratio=200   # slow-start pacing factor
sysctl net.ipv4.tcp_pacing_ca_ratio=120   # congestion avoidance pacing factor
sysctl net.ipv4.tcp_internal_pacing=1
```

Without pacing, TCP bursts out a cwnd's worth of data the instant an ACK arrives, creating micro-queues at every bottleneck hop. Pacing smooths this into a constant-rate stream.

## Congestion signals beyond loss

Modern congestion control uses multiple signals, not just packet loss:

### ECN (Explicit Congestion Notification)

Instead of dropping packets, a bottleneck router marks them with a CE (Congestion Experienced) bit. The receiver echoes this in the ACK, and the sender reduces cwnd — **without any retransmission**.

```bash
sysctl net.ipv4.tcp_ecn=1         # 0=disable, 1=enable for requested, 2=enable always
ss -tin | grep ecn                # connections using ECN show "ecn" in info
```

ECN avoids the retransmission penalty of loss-based congestion control. For datacenter workloads (small windows, shallow buffers), this can reduce tail latency by orders of magnitude. The catch: some broken middleboxes strip or corrupt ECN bits, which is why it's not universally enabled.

### RTT-based signals (delay-based)

BBR, Vegas, and CDG use increasing RTT as an early congestion signal — before queues overflow. This is the "congestion avoidance" vs "congestion control" distinction: delay-based algorithms try to prevent loss entirely.

## The complete sysctl landscape

TCP is the most configurable subsystem in Linux. The knobs that matter most:

```bash
# Buffers — the single biggest performance lever
sysctl net.ipv4.tcp_rmem           # min default max (bytes, per-socket read buffer)
sysctl net.ipv4.tcp_wmem           # min default max (per-socket write buffer)
sysctl net.core.rmem_max           # hard cap on SO_RCVBUF
sysctl net.core.wmem_max           # hard cap on SO_SNDBUF

# Auto-tuning (on by default since 2.6.17 — almost always keep enabled)
sysctl net.ipv4.tcp_moderate_rcvbuf  # 1: kernel grows rcvbuf based on cwnd

# Timestamps and windows
sysctl net.ipv4.tcp_window_scaling    # 1: enable window scaling (RFC 7323)
sysctl net.ipv4.tcp_timestamps        # 1: RTT measurement + PAWS (Protection Against Wrapped Sequences)

# Fast recovery mechanisms
sysctl net.ipv4.tcp_sack          # 1: selective ACKs (retransmit only lost segments)
sysctl net.ipv4.tcp_dsack         # 1: duplicate SACK (detect spurious retransmits)
sysctl net.ipv4.tcp_fack          # 0: deprecated, use SACK
sysctl net.ipv4.tcp_fastopen      # 3: enable TFO for client + server (saves 1 RTT)

# Connection handling
sysctl net.ipv4.tcp_syn_retries    # 6: SYN retries before giving up
sysctl net.ipv4.tcp_synack_retries # 5: SYN-ACK retries
sysctl net.ipv4.tcp_retries2       # 15: data retries before killing connection (~15 min)
sysctl net.ipv4.tcp_keepalive_time  # 7200: idle before keepalive probes start
sysctl net.ipv4.tcp_tw_reuse        # 2: reuse TIME_WAIT sockets for new connections
sysctl net.ipv4.tcp_fin_timeout     # 60: TIME_WAIT duration in seconds
sysctl net.ipv4.tcp_max_tw_buckets  # cap on TIME_WAIT sockets count
```

### Autotuning in action

Linux auto-tunes socket buffers. The kernel maintains per-destination metrics (sRTT, cwnd) and sizes the receive buffer to be just over the BDP:

```bash
ss -tim | head -5
# skmem:(r0,rb131072,t0,tb87040,f0,w0,o640,bl0,d0)
#           rb = receive buffer (auto-tuned)
#           tb = transmit buffer (auto-tuned by data in flight)
```

The receive buffer auto-tuning algorithm: `rbuf = max(default, min(2 × mem_default × cwnd / MSS, tcp_rmem[2]))`. This keeps the receive window always large enough to absorb a full cwnd.

## Bufferbloat and the FQ-CoDel remedy

**Bufferbloat** is the phenomenon where oversized network buffers (in routers, modems, switches) hide congestion by absorbing bursts, but at the cost of massive latency under load. Your ping goes from 10ms to 2000ms the moment you start a download — that's bufferbloat.

The kernel's answer is the **fq_codel** qdisc (available since 3.5, default for many Linux distributions), and its successor **CAKE** (Common Applications Kept Enhanced, kernel 4.19+):

```bash
# Check current qdisc
tc qdisc show dev eth0
# fq_codel (default on modern distros)

# Switch to CAKE for better bandwidth shaping
tc qdisc replace dev eth0 root cake bandwidth 100mbit

# Add CAKE to a container's veth
tc qdisc add dev vethXXXX root cake bandwidth 10mbit
```

The `fq_codel` algorithm combines fair queuing (each flow gets a separate queue) with controlled delay (co-del: drop packets when queue sojourn time exceeds 5ms). No tuning needed — it's "no knobs" by design.

## The interaction with the network stack

TCP congestion control doesn't operate in isolation. It interacts with:

**TSQ (TCP Small Queues):** limits bytes queued to the NIC to ~1ms worth of data at line rate. Prevents TCP from dumping a full cwnd into the driver queue (which would circumvent pacing/ECN). Configured per-socket:

```bash
cat /proc/sys/net/ipv4/tcp_limit_output_bytes   # default 262144 (256 KB)
```

**Byte Queue Limits (BQL):** the NIC driver equivalent of TSQ. Limits total bytes queued across all sockets to the hardware transmit ring. Dynamically adjusts based on completion rate:

```bash
cat /sys/class/net/eth0/queues/tx-0/byte_queue_limits/
# hold_time, inflight, limit, limit_max, limit_min
```

**GRO/GSO/TSO (offloads):** hardware segmentation offloading merges multiple TCP segments into one large one; the NIC splits them back to wire-size. Reduces per-packet CPU cost dramatically:

```bash
ethtool -k eth0 | grep -E 'tso|gso|gro|sg'
# tcp-segmentation-offload: on    ← TSO
# generic-segmentation-offload: on ← GSO (software TSO)
# generic-receive-offload: on     ← GRO
# scatter-gather: on              ← prerequisite for TSO/GSO
```

TSO can mask congestion signals because the NIC bursts out segments back-to-back without any inter-frame gap. BBR pacing intentionally disables TSO on paced connections to achieve precise packet spacing.

## Practical tuning by workload

```bash
# ─── Public internet server (mixed RTT clients) ───
sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl -w net.core.default_qdisc=fq
sysctl -w net.ipv4.tcp_notsent_lowat=131072  # wake app sooner (for low-latency responses)

# ─── Datacenter (homogeneous low-RTT) ───
sysctl -w net.ipv4.tcp_congestion_control=dctcp   # requires ECN on switches
sysctl -w net.ipv4.tcp_ecn=1
# DCTCP (Data Center TCP) estimates congestion fraction from ECN marks;
# reduces cwnd proportionally instead of by half — ideal for shallow-buffer DC switches

# ─── Lossy networks (WiFi, mobile) ───
sysctl -w net.ipv4.tcp_congestion_control=bbr   # BBR handles non-congestion loss well
sysctl -w net.ipv4.tcp_mtu_probing=1            # discover path MTU to avoid fragmentation

# ─── High-BDP (10 Gbps, 200ms RTT) ───
# Buffer needs: BDP = 10 Gbps × 0.2s = 250 MB
sysctl -w net.core.rmem_max=268435456            # 256 MB max receive buffer
sysctl -w net.core.wmem_max=268435456            # 256 MB max send buffer
sysctl -w net.ipv4.tcp_rmem="4096 87380 268435456"
sysctl -w net.ipv4.tcp_wmem="4096 65536 268435456"
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

## The QUIC future

TCP runs in the kernel; QUIC runs in user space (over UDP). This means QUIC congestion control is implemented in libraries (quiche, lsquic, Chromium) rather than the kernel. It's an architectural shift: application developers can now deploy custom congestion algorithms without kernel patches.

However, the kernel's UDP stack still matters for QUIC performance — specifically GRO for UDP, busy polling, and socket receive buffer sizing. The kernel API that supports high-performance QUIC includes `sendmsg` with multiple iovecs (batching), `SO_INCOMING_CPU` (steering), and `SO_REUSEPORT` with `SO_ATTACH_REUSEPORT_EBPF`.

## Try it yourself

```bash
# Visualize congestion control in action
ss -tin | head -20
# Look for: cwnd, ssthresh, rtt, pacing_rate, bytes_acked
# Open a TCP connection and watch:
curl -o /dev/null https://example.com/large-file &
ss -tipn | grep curl    # watch cwnd grow with each refresh

# Observe kernel TCP metrics
cat /proc/net/tcp       # raw socket table
cat /proc/net/snmp | grep Tcp   # global counters: retransmits, timeouts, etc.

# Start a server, flood it, and observe
python3 -m http.server 8080 &
iperf3 -s &
# From another machine:
iperf3 -c <host> -t 30   # watch cwnd and retransmits during transfer
ss -tin | grep 5201       # (iperf3 default port)

# Flush cached route metrics (RTT, cwnd estimates)
ip route flush cache

# Experiment with congestion algorithms using netem to simulate conditions
tc qdisc add dev lo root netem delay 50ms loss 0.5%      # add delay + loss
ping -c 10 localhost                                        # verify
# Compare CUBIC vs BBR:
sysctl -w net.ipv4.tcp_congestion_control=cubic
iperf3 -c localhost -t 10
sysctl -w net.ipv4.tcp_congestion_control=bbr
iperf3 -c localhost -t 10
tc qdisc del dev lo root                                   # cleanup
```

## Check your understanding

1. A CUBIC connection on a 1 Gbps path with 100ms RTT achieves only 50 Mbps. What's the likely bottleneck?
2. BBRv1 connections get 10× more throughput than CUBIC flows on the same bottleneck. Is this a BBR feature or a bug?
3. You enable ECN on your server but some clients stop connecting. What happened?
4. Why does bufferbloat cause latency spikes *during* a download but not *after*?
5. A Kubernetes node has 5000 active TCP connections. Most are idle. Does this cause memory pressure? What kernel structures matter?

*(Answers: likely the socket buffer is too small — with 1 Gbps × 100ms = 12.5 MB BDP, the default tcp_rmem max (6 MB on older kernels) prevents the window from opening fully; it's a known fairness issue with BBRv1 — at deep-buffered bottlenecks BBRv1 probes losslessly while CUBIC backs off, causing starvation; a broken middlebox or firewall between the client and server strips or blocks IP packets with the ECN bits set, preventing TCP handshake completion — this is why ECN is often disabled on public internet servers; during a download the bottleneck buffer fills with the sender's packets, increasing the queuing delay component of RTT — after the transfer ends the buffer drains in a few RTTs; idle TCP connections consume ~3 KB each (socket, tcp_sock, file descriptor) — 5000 × 3KB ≈ 15 MB, not a memory problem, but the tcp_tw_buckets and the socket lookup hash table size (thash_entries) both matter for connection establishment rate.)*

---

**Next:** Part III — a crucial piece missing from the picture. Processes are isolated, but they need to talk. Signals, pipes, and Unix domain sockets — the kernel's inter-process communication primitives that every shell pipeline and every daemon depends on.
