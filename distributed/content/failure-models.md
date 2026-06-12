# Failure Models & Detection

> **Goal of this chapter:** learn the vocabulary the entire field uses to
> reason about failure — the hierarchy of failure models — and understand
> failure *detection*: heartbeats, timeouts, and why a perfect failure
> detector cannot exist. These concepts return in every algorithm we'll meet.

"Handle failures" is useless advice until you say *which* failures. An
algorithm that tolerates crashed nodes may be defenseless against a node
that lies. So the field defines precise **failure models** — contracts about
what kinds of misbehavior we design for.

## The hierarchy of failure models

From the most polite failures to the most vicious:

```text
  benign ──────────────────────────────────────────▶ malicious

  crash-stop      crash-recovery     omission        Byzantine
  ┌─────────┐     ┌────────────┐     ┌──────────┐    ┌──────────────┐
  │ dies,   │     │ dies, may  │     │ drops    │    │ ANYTHING:    │
  │ stays   │     │ come back  │     │ some     │    │ lies, forges,│
  │ dead    │     │ (with disk │     │ messages │    │ colludes,    │
  │         │     │  state)    │     │          │    │ acts normal  │
  └─────────┘     └────────────┘     └──────────┘    └──────────────┘
```

### Crash-stop (fail-stop)

A node works correctly, then halts and never returns. It never sends a wrong
message — it just goes silent forever. This is the kindest model and the one
many textbook algorithms assume first, because it isolates the core
difficulty (silence is ambiguous) without extra complications.

### Crash-recovery

A node can crash and **later restart**, typically recovering whatever it had
saved to durable storage before dying, but losing everything in memory. This
is the model that real-world systems (databases, Raft, Kafka) actually
design for. It forces a discipline you'll see everywhere: **write your
critical state to disk *before* acknowledging anything to others** — the
write-ahead log. If you acknowledge first and crash before persisting,
you've made a promise your reborn self won't remember.

### Omission failures

A node is up but some messages to or from it are lost — a flaky NIC, an
overflowing queue, a misconfigured firewall. In practice, omission blends
into the network's normal behavior (the network already loses messages), so
most designs fold this model into their network assumptions rather than
treating it separately.

### Byzantine failures

The node can do **anything**: send contradictory messages to different
peers, lie about its state, collude with other faulty nodes, or behave
perfectly while waiting to strike. Named after the *Byzantine Generals
Problem* (Lamport, Shostak, Pease, 1982).

Byzantine tolerance is expensive: to survive `f` Byzantine nodes you need
**3f + 1** nodes and cryptographic signatures, versus **2f + 1** for crash
faults. So engineers match the model to the environment:

- **Inside one organization's datacenter** (your microservices, your
  database cluster): nodes are trusted; crash-recovery is the standard
  model. Bugs happen, but you don't design the protocol around malice.
- **Across organizations or with anonymous participants** (blockchains,
  cross-bank settlement): Byzantine tolerance is mandatory — some
  participants *will* be adversarial.

> One pseudo-Byzantine failure shows up even in trusted datacenters: **data
> corruption** (bit flips on disk or in transit). It's handled not with
> Byzantine protocols but with checksums at every layer — cheap insurance
> that turns "a lie" back into "a detectable omission".

## A special demon: the network partition

A **partition** splits the network so that groups of nodes can talk within
their group but not across groups. Both sides are alive and processing —
each side just believes the other is dead.

```text
        before                        during partition
   A ── B ── C ── D              A ── B   ╳   C ── D
   all connected                 island 1     island 2
                                 "C,D died!"  "A,B died!"
```

Partitions are nasty because they create **symmetric, mutual suspicion**.
If each side independently decides to carry on (say, each elects its own
leader and accepts writes), you get **split-brain**: two divergent versions
of the truth that someone must painfully reconcile later. Much of the
machinery in later chapters — quorums, consensus, fencing — exists
specifically to make partitions survivable. Keep this picture in mind; it
returns in the CAP theorem chapter.

## Failure detection: the impossible necessity

Every fault-tolerant design needs to answer: *is node X still alive?* The
standard mechanism is the **heartbeat**: every node periodically sends "I'm
alive" to its monitors; if too long passes without one, the node is
*suspected* dead.

```text
  B ──♥──▶ A     t=0       A: fine
  B ──♥──▶ A     t=1s      A: fine
  B   ✗            t=2s      A: hmm…
  B   ✗            t=3s      A: timeout — declare B dead
```

But recall the fundamental ambiguity from the last chapter: silence might
mean B crashed, or the network dropped the heartbeats, or B is paused (a
garbage-collection pause, a VM migration, a snapshot — real things that
freeze a process for *seconds*). The detector must pick a timeout, and:

- **Aggressive timeout** → fast detection, but many **false positives**:
  healthy nodes declared dead. The system churns — work gets reassigned,
  re-replicated, then the "dead" node sheepishly returns.
- **Patient timeout** → few false alarms, but real failures go unnoticed for
  a long time, during which requests are routed to a corpse.

### Why perfection is impossible

In an asynchronous system — one with no upper bound on message delay, i.e.
the real world — a **perfect failure detector cannot exist**. Perfection
would require never falsely accusing a live node (*accuracy*) while always
eventually catching every dead one (*completeness*). But any finite timeout
can be exceeded by a live-but-slow node (breaking accuracy), and an infinite
timeout never detects anything (breaking completeness). This isn't an
engineering limitation; it's logic.

Chandra and Toueg (1996) turned this into a celebrated theory of
**unreliable failure detectors**, classifying how *imperfect* a detector can
be while still allowing consensus to work. The headline result: a detector
that's merely *eventually* accurate is enough. This is the formal escape
hatch from the FLP impossibility theorem we'll meet in the consensus
chapter — real systems work because the network is usually nice *enough*.

### Engineering the gray area

Production systems soften the binary alive/dead in several ways:

- **Phi-accrual detectors** (used by Cassandra and Akka) output a
  *suspicion level* based on the statistical distribution of past heartbeat
  arrivals, instead of a hard yes/no. Applications pick their own threshold:
  routing might divert traffic at low suspicion, while expensive
  re-replication waits for high suspicion.
- **Gossip-based detection** (covered in the CRDTs chapter): nodes share
  what they've heard about each other, so one flaky link doesn't condemn a
  healthy node.
- **Lease + fencing:** a node holds a time-limited **lease** on a role
  ("I am the primary until t=30s") and must renew it. If it's paused past
  expiry, it knows on waking that it may have been replaced and must stand
  down. Fencing **tokens** (a number that increases with each new lease)
  let storage reject stale writes from a deposed primary that doesn't yet
  know it's deposed. Remember fencing — it reappears in the consensus and
  transactions chapters.

> The deep lesson: distributed systems never act on *certainty* about remote
> failure — only on *suspicion*, with machinery (quorums, leases, fencing)
> to keep wrong suspicions from corrupting data.

## Choosing your model: a practical summary

| Environment | Sensible model | Typical machinery |
|---|---|---|
| Single team's services in a datacenter | crash-recovery + partitions | WAL, heartbeats, leases, quorums |
| Multi-region deployment | crash-recovery + frequent partitions | consensus, quorums, fencing |
| Untrusted / multi-party participants | Byzantine | BFT protocols, signatures, 3f+1 replicas |
| Hardware bit-rot (any environment) | corruption | checksums end to end |

## Key takeaways

- Failure models form a hierarchy: **crash-stop → crash-recovery → omission
  → Byzantine**. Tolerating `f` crashes needs 2f+1 nodes; `f` Byzantine
  nodes need 3f+1 plus signatures. Match the model to your trust
  environment — most in-house systems rightly assume crash-recovery.
- Crash-recovery forces the **write-ahead discipline**: persist before you
  promise.
- **Partitions** create mutual suspicion and the split-brain risk; they are
  why quorums and consensus exist.
- Failure detection = heartbeats + timeouts, and it is **provably
  imperfect** in asynchronous networks. The timeout knob trades detection
  speed against false accusations.
- Real systems embrace imperfection: phi-accrual suspicion levels, gossip,
  and **leases with fencing tokens** to neutralize zombies and pauses.

```quiz
[
  {
    "q": "Why do real-world systems mostly design for crash-recovery rather than crash-stop?",
    "choices": [
      "Crash-recovery is easier to implement",
      "Real machines usually come back after crashing, with their disk state intact but memory lost",
      "Crash-stop only applies to Byzantine networks",
      "Crash-recovery requires fewer replicas than crash-stop"
    ],
    "answer": 1,
    "explain": "Servers reboot, processes restart. The crash-recovery model captures this: durable state survives, memory doesn't — which forces the write-ahead rule of persisting state before acknowledging it to others."
  },
  {
    "q": "To tolerate f Byzantine (arbitrarily misbehaving) nodes, how many nodes do you need in total?",
    "choices": [
      "f + 1",
      "2f + 1",
      "3f + 1",
      "2f"
    ],
    "answer": 2,
    "explain": "Byzantine fault tolerance requires 3f+1 nodes (plus signatures), versus 2f+1 for simple crash faults — one reason BFT protocols are reserved for environments with genuinely untrusted participants."
  },
  {
    "q": "Why can no failure detector be perfect in an asynchronous network?",
    "choices": [
      "Heartbeat messages are too small to be reliable",
      "Because any finite timeout can be exceeded by a slow-but-alive node, and an infinite timeout never detects anything",
      "Because nodes refuse to send heartbeats under load",
      "It can be perfect, if the timeout is tuned carefully enough"
    ],
    "answer": 1,
    "explain": "With unbounded message delays, 'slow' and 'dead' are indistinguishable. Any finite timeout risks false accusations; no timeout means no detection. Systems therefore act on suspicion, protected by quorums, leases and fencing."
  },
  {
    "q": "A network partition splits a cluster into two halves, and each half elects its own leader that accepts writes. What is this failure mode called?",
    "choices": [
      "Split-brain",
      "Byzantine collapse",
      "Heartbeat inversion",
      "Crash-recovery"
    ],
    "answer": 0,
    "explain": "Split-brain: two sides each believe they're the legitimate system and diverge. Preventing it is a core job of quorums and consensus protocols, covered in Module 4."
  }
]
```
