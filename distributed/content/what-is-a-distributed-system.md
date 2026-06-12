# What Is a Distributed System?

> **Goal of this chapter:** build the correct mental model before anything else.
> By the end you'll know what makes a system "distributed", why anyone accepts
> the enormous complexity that comes with it, and the eight classic mistakes
> every newcomer makes — so you can skip making them yourself.

Here is the most useful definition in the field, from Leslie Lamport, half
joking and entirely accurate:

> "A distributed system is one in which the failure of a computer you didn't
> even know existed can render your own computer unusable."

A more formal one: a **distributed system** is a set of independent computers
(we'll call them **nodes**) that communicate only by **passing messages over a
network**, and that appear to their users as a single coherent system.

Every word of that definition hides a problem:

- **Independent** — each node has its own CPU, memory, disk and clock. Nothing
  is shared. One node can crash while the others keep running.
- **Messages over a network** — the *only* way nodes learn anything about each
  other. Messages can be delayed, reordered, duplicated, or silently lost.
- **Appear as a single coherent system** — the hard part. Users want one
  logical database, one queue, one filesystem. Physics gives us many
  half-informed machines shouting at each other through an unreliable pipe.

## You already use dozens of them

Distributed systems sound exotic, but you touched several today:

| You did this | The distributed system behind it |
|---|---|
| Loaded a web page | DNS (thousands of cooperating servers), CDNs |
| Sent a message | Message queues, replicated databases |
| Paid for coffee | Payment networks with distributed transactions |
| Pushed to Git | Replicated object storage behind the forge |
| Watched a video | Storage clusters streaming from the nearest replica |

The cloud itself is the biggest one: when you "launch a VM", a scheduler picks
a physical machine among hundreds of thousands, copies an image from a
replicated store, and programs a software-defined network — all distributed
systems stacked on each other.

## Why distribute at all?

Distribution multiplies complexity. Nobody does it for fun. There are exactly
three honest reasons.

### 1. Scale — one machine isn't enough

A single server, however large, has limits: CPU cores, RAM, disk, network
bandwidth. When your workload exceeds the biggest machine you can buy (or
afford), the only way forward is **scaling out**: many machines sharing the
work.

There's a subtlety: *vertical scaling* (a bigger machine) is almost always
simpler and often cheaper than people assume. A modern server can have 192
cores and multiple terabytes of RAM. **The first rule of distributed systems
is: don't build one if a single machine will do.**

### 2. Fault tolerance — one machine isn't reliable enough

Hardware fails. Disks die, power supplies burn out, datacenters lose power,
someone unplugs the wrong cable. If your service must survive the failure of
any single machine — or a whole datacenter — you need copies of your data and
your compute in more than one place. That is, by definition, a distributed
system.

This reason is more fundamental than scale: even a tiny service that must be
highly available needs at least two nodes, and the moment you have two nodes
that must agree on something, you have every problem this course covers.

### 3. Latency — physics says the data must be near the user

Light in fiber travels about 200,000 km/s — about 100 ms for a round trip
between Paris and Sydney, *before* any processing. No software optimization
beats the speed of light. If users on three continents need fast responses,
you need servers (and usually data) on three continents.

> Memorize these three: **scale, fault tolerance, latency.** Whenever you look
> at an architecture decision in a distributed system, ask which of the three
> it serves. If the answer is "none", the complexity is probably unjustified.

## What makes it genuinely hard

On a single machine, the operating system gives you a wonderfully convenient
set of lies: a function call always either runs or doesn't; reading memory
just works; the clock moves forward; if the machine dies, *everything* dies
together, so you never see half a failure.

Distribution takes every one of those guarantees away:

```text
            single machine                 distributed system
   ┌────────────────────────────┐   ┌────────────────────────────────┐
   │ function call:             │   │ remote call:                   │
   │   succeeds or raises       │   │   succeeds, fails, OR…         │
   │                            │   │   *no answer at all* — and you │
   │ shared memory: consistent  │   │   can't tell which one         │
   │ one clock: one "now"       │   │ no shared memory, only msgs    │
   │ fails as a unit            │   │ every node has its own clock   │
   │                            │   │ PARTIAL failure: some nodes    │
   │                            │   │ dead, some alive, some… slow   │
   └────────────────────────────┘   └────────────────────────────────┘
```

Two of these deserve names, because they drive everything else in this course:

### Partial failure

In a distributed system, components fail *independently*. Three of your five
database replicas are up; two are down — or are they just slow? Your code must
produce correct answers while the system is in these in-between states, which
is radically harder than handling "everything works" and "everything is down".

### No common knowledge

A node knows only two things: its own local state, and the messages it has
received. It can *never* directly observe another node's state — only
messages about that state, which were true when sent and may be stale on
arrival. Every algorithm in this field is, at heart, a clever way to act
correctly on stale, incomplete information.

## The eight fallacies of distributed computing

In the 1990s, engineers at Sun Microsystems catalogued the assumptions that
newcomers (and seasoned engineers on bad days) implicitly make. Systems built
on these assumptions fail in production. Learn the list now; the rest of the
course shows the consequences of each.

1. **The network is reliable.** It isn't. Packets are dropped, switches
   reboot, cables get cut by backhoes (really).
2. **Latency is zero.** A local call takes nanoseconds; a same-datacenter call
   takes ~0.5 ms; a cross-continent call takes ~100 ms. That's eight orders
   of magnitude between the first and the last.
3. **Bandwidth is infinite.** Move a terabyte through a 10 Gb/s link and
   you'll wait ~15 minutes — if nothing else is using it.
4. **The network is secure.** Anything you don't encrypt and authenticate,
   someone can read and forge.
5. **Topology doesn't change.** Machines move, IPs change, routes flap,
   autoscalers add and remove nodes constantly.
6. **There is one administrator.** Different teams, companies and cloud
   providers run the pieces; no one sees or controls everything.
7. **Transport cost is zero.** Serialization, copies and egress fees are real
   costs in both milliseconds and dollars.
8. **The network is homogeneous.** Mixed hardware, mixed link speeds, mixed
   protocol versions — always.

> The first two fallacies — reliability and latency — cause more production
> incidents than the other six combined. The next chapter is dedicated
> entirely to them.

## The mental model to carry forward

Picture every distributed system like this, and you'll rarely go wrong:

```text
   ┌─────────┐         messages          ┌─────────┐
   │ node A  │ ─────────────────────────▶│ node B  │
   │ state_A │ ◀───────────────────────── │ state_B │
   │ clock_A │     (delayed, lost,        │ clock_B │
   └─────────┘      duplicated,           └─────────┘
        ▲           reordered)                 ▲
        │                                      │
        └──── each node knows ONLY its own ────┘
              state + messages received
```

- Nodes are honest but ignorant: they act correctly on what they know, and
  what they know is always potentially out of date.
- The network is an adversary on a budget: usually fine, occasionally awful,
  never to be trusted.
- "The system" has no global state you can read — global state is something
  you *reconstruct*, carefully, from local states, and most of the
  difficulty lives in that reconstruction.

## What this course covers, and in what order

The course follows the problems, not the technologies — each chapter exists
because the previous one created a problem that needs solving:

1. **Foundations** (you are here): the network and failures — the raw,
   hostile reality.
2. **Time & order:** without a shared clock, how can we even say one event
   happened "before" another?
3. **Data at scale:** copying data to many nodes (replication), splitting it
   across nodes (partitioning), and what "consistent" even means.
4. **Coordination:** making nodes *agree* — consensus, Raft, distributed
   transactions. The intellectual summit of the field.
5. **Advanced systems:** designs that avoid coordination altogether (CRDTs),
   and how real systems — Kafka, Spanner, Kubernetes — assemble all of it.

## Key takeaways

- A distributed system = independent nodes + message passing + the illusion
  of a single system. Each part of that definition is a problem.
- The only honest reasons to distribute: **scale, fault tolerance, latency.**
  Prefer one big machine when you can get away with it.
- The two demons: **partial failure** (pieces fail independently) and **no
  common knowledge** (every node acts on stale, local information).
- The eight fallacies are the field's catalog of famous last words. The
  network is not reliable, and latency is not zero.

```quiz
[
  {
    "q": "Which of these is NOT one of the three fundamental reasons to build a distributed system?",
    "choices": [
      "Tolerating the failure of individual machines",
      "Serving users with low latency across the globe",
      "Making the codebase easier to understand",
      "Handling load beyond what one machine can do"
    ],
    "answer": 2,
    "explain": "Distribution always makes a system harder to understand, not easier. The three honest motivations are scale, fault tolerance and latency."
  },
  {
    "q": "A node sends a request to another node and receives no response. What can it conclude?",
    "choices": [
      "The remote node has crashed",
      "The network dropped the request",
      "The remote node is slow or overloaded",
      "Nothing for certain — any of the above could be true"
    ],
    "answer": 3,
    "explain": "This ambiguity — crash vs. lost message vs. slowness are indistinguishable from the outside — is the core difficulty of distributed systems, and it reappears in every later chapter."
  },
  {
    "q": "What is 'partial failure'?",
    "choices": [
      "A failure that only corrupts part of a file",
      "Some components of the system fail while others keep running",
      "A failure that resolves itself after a partial retry",
      "A machine that loses only part of its memory"
    ],
    "answer": 1,
    "explain": "On one machine, everything fails together. In a distributed system, components fail independently, and your code must behave correctly in those in-between states."
  }
]
```
