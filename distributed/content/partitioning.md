# Partitioning & Sharding

> **Goal of this chapter:** replication copies data; **partitioning** splits
> it. Learn the two big splitting strategies (range vs hash), why naive
> hashing fails the moment you add a node, how consistent hashing fixes it,
> and the operational realities: rebalancing, hot keys, and secondary
> indexes.

When a dataset or its write load outgrows one machine, you **partition**
(a.k.a. **shard**) it: each node holds only a subset. Replication and
partitioning compose — each partition is itself replicated:

```text
              the full dataset, split into 4 partitions
   ┌──────────┬──────────┬──────────┬──────────┐
   │   P1     │   P2     │   P3     │   P4     │
   └──────────┴──────────┴──────────┴──────────┘
        │            │           │          │  each partition: 3 replicas
   node A,B,C    node B,C,D   node C,D,A  node D,A,B
```

The design problem: **which record lives in which partition?** A good scheme
spreads data *and load* evenly, finds any record fast, and survives nodes
joining and leaving. Each property is harder than it looks.

## Strategy 1: partition by key range

Assign each partition a contiguous range of keys, like encyclopedia volumes
(A–C, D–F, …). Used by HBase, by RethinkDB, and (with auto-splitting) by
Spanner and CockroachDB.

The superpower: **range queries**. Keys sort adjacently, so "all readings
from sensor X in March" or "users 1000–2000" hit one or two partitions.

The curse: **skew from access patterns**. If keys are timestamps and
everyone writes "now", every write lands in the **last** partition — one
node does all the work while the rest idle. Workarounds prefix the key with
something spreading (sensor ID before timestamp), trading away some range-
query convenience.

Range systems also **split and merge** partitions dynamically: a partition
growing past a threshold splits in two (like a B-tree node), keeping
partition sizes bounded regardless of data distribution.

## Strategy 2: partition by hash of key

Run the key through a hash function; the hash decides the partition. Hashing
destroys the relationship between "similar key" and "same partition" — which
is exactly the point: even pathological key patterns (sequential IDs,
timestamps) spread uniformly.

The price is symmetric: **range queries die** — adjacent keys scatter across
all partitions, so a range scan must query everyone. Cassandra's compromise
is worth knowing: a **compound key** — hash the first part to pick the
partition, sort by the rest within it. "All messages of user X in March" →
one partition (hashed user X), efficient sorted scan inside.

### The naive trap: hash mod N

The obvious scheme — `partition = hash(key) mod N` for N nodes — has a
disqualifying flaw: change N and **almost every key changes partition**.
Going from 10 to 11 nodes remaps ~91% of all data; the cluster melts under
its own migration. Elastic systems need locality of change: adding capacity
should move only the data that's actually heading to the new node.

## Consistent hashing: adding nodes without the avalanche

**Consistent hashing** (Karger et al., 1997) arranges the hash space as a
**ring** (0 to 2³²−1, wrapping). Each node is placed at one or more points
on the ring; each key belongs to the **first node clockwise** from its hash.

```text
                    ┌── node A
              ┌─────┴─────┐
        key k1 ─▶ ●        │        key's owner = first node
              │            ├── node B          clockwise
        node D┤            │
              │        ● ◀─ key k2  (owned by D… no, by the
              └─────┬─────┘          next clockwise: node C)
                    └── node C
```

Add node E between B and C: E takes over **only** the arc between them —
every other key stays put. Remove a node: its arc falls to its clockwise
successor. **Only ~1/N of keys move per node change**, the theoretical
minimum.

Two refinements make it production-grade:

- **Virtual nodes:** one physical node = many points on the ring (100+).
  This smooths the statistical unevenness of random placement, lets a
  beefier machine carry more vnodes, and — crucially — spreads a dead
  node's load across *many* successors instead of dumping it all on one
  neighbor.
- **Replication on the ring:** store each key on the next *R* distinct
  nodes clockwise — the natural replica placement in Dynamo, Cassandra and
  Riak.

Consistent hashing is everywhere: distributed caches (it was invented for
web caching; memcached clients use it), Dynamo-style databases, load
balancers, and DHTs like Chord powering BitTorrent's peer discovery.

> Alternative worth knowing: many modern databases skip the ring and keep an
> explicit **partition-assignment table** managed by a coordinator (more in
> the consensus chapters) — e.g. HBase, Kafka, and range-based stores. The
> table gives precise control (and dynamic splitting); the ring gives
> coordination-free placement that any client can compute. Both beat
> `mod N`.

## Rebalancing: moving data without downtime

Whatever the scheme, data eventually must move — new nodes, dead nodes,
grown partitions. Rebalancing well means:

- **Move the minimum** (consistent hashing / fixed partition counts give
  this by construction).
- **Throttle the migration** — rebalancing is a background guest; saturating
  disks and networks during one turns maintenance into an outage.
- **Serve while moving** — the partition stays readable/writable during
  copy, with a cutover handshake at the end (and writes during the copy
  forwarded or double-applied; the consistency guarantees from earlier
  chapters must hold *through* this).
- **Beware automatic rebalancing + failure detection:** a node that's merely
  slow gets declared dead (an imperfect failure detector!), triggering a
  rebalance that loads the remaining nodes, making *them* slow… a cascade.
  Many operators keep a human approval step on big rebalances for exactly
  this reason.

## Hot keys: when one key breaks the model

Partitioning spreads *keys*; it cannot spread *one key*. A celebrity account
with 100M followers, a viral post, a single tenant doing 90% of traffic —
the partition holding that key glows red while others idle. Standard
treatments:

- **Key salting:** split the hot key into `key#1 … key#16` sub-keys spread
  across partitions; readers fan out and merge. Throughput ×16, read
  complexity ×16.
- **Caching in front** — a tiny cache of the hottest items absorbs most of
  the reads (the "power of the cache for power laws" effect).
- **Dedicated handling:** detect heavy hitters and route them to special
  capacity (the approach behind "celebrity sharding" in social systems).

There's no free lunch — only the choice of which lunch to pay for.

## Secondary indexes: querying by something other than the key

Partitioning is organized around the primary key. The moment you ask "find
all red cars" (a **secondary** attribute), you face a choice with sharp
trade-offs:

- **Local indexes** (document-partitioned): each partition indexes its own
  data. Writes stay local (fast — write one partition, update its index);
  reads must **scatter-gather across all partitions** — every search hits
  everyone, and tail latency (chapter 2!) compounds.
- **Global indexes** (term-partitioned): the index itself is partitioned by
  the indexed value — "red" lives on one partition, so a search hits just
  it. Reads are surgical; **writes fan out** — one document update touches
  the index partitions of each indexed field, usually asynchronously…
  meaning the index is *eventually consistent* with the data (and now you
  can name exactly what that implies).

Write-heavy favors local; read-heavy favors global. DynamoDB offers both
(LSI/GSI) so you can pick per index.

## Request routing: who knows where things are?

Last practical piece — a client holds a key; which node does it ask? Three
layouts:

1. **Any node can answer** (forwarding): clients ask anyone; nodes redirect
   or proxy internally. Simple clients (Cassandra, Dynamo-style).
2. **A routing tier:** a proxy keeps the partition map and steers requests
   (e.g. mongos in MongoDB, or HBase clients consulting a metadata service).
3. **Smart clients:** clients cache the partition map and go direct —
   fastest path, with stale-map handling (Kafka clients work this way).

In every layout the partition map itself must be kept consistent somewhere —
historically the job of ZooKeeper or etcd. That "somewhere reliable to keep
small critical facts" keeps recurring… and is exactly what Module 4 builds.

## Key takeaways

- Partitioning splits data across nodes; it composes with replication
  (each partition replicated). The whole game is *which record goes
  where*.
- **Range partitioning:** sorted keys, great range scans, skew danger,
  dynamic splitting. **Hash partitioning:** uniform spread, dead range
  queries, compound keys as the compromise.
- `hash mod N` fails elasticity (~all keys move). **Consistent hashing**
  moves only ~1/N per change; virtual nodes smooth load and failure
  spreading. Explicit assignment tables are the managed alternative.
- Rebalancing must be minimal, throttled, online — and not triggered into
  cascades by false failure suspicion. **Hot keys** need their own playbook
  (salting, caching).
- Secondary indexes: **local** = cheap writes + scatter-gather reads;
  **global** = surgical reads + fan-out, eventually-consistent writes.
- Routing needs a consistent partition map — the small-critical-state
  problem that consensus systems (next module) exist to solve.

```quiz
[
  {
    "q": "Why is `partition = hash(key) mod N` a poor scheme for an elastic cluster?",
    "choices": [
      "The modulo operation is too slow",
      "It cannot handle string keys",
      "Changing N remaps almost every key to a different node, forcing a near-total data migration",
      "It creates hot partitions for sequential keys"
    ],
    "answer": 2,
    "explain": "Going from N to N+1 changes the result of `mod` for ~N/(N+1) of all keys. Consistent hashing fixes this: only ~1/N of keys move when a node joins or leaves."
  },
  {
    "q": "Your keys are timestamps and you use range partitioning. What goes wrong?",
    "choices": [
      "Range queries become impossible",
      "All current writes land on the partition holding the newest range — one node takes the entire write load",
      "Hashes collide because timestamps repeat",
      "Old partitions are deleted automatically"
    ],
    "answer": 1,
    "explain": "Everyone writes 'now', and 'now' lives in the last range. This is the classic skew of range partitioning; the fix is prefixing the key with a spreading component (e.g. sensor ID) at the cost of cross-prefix range scans."
  },
  {
    "q": "What do virtual nodes add to consistent hashing?",
    "choices": [
      "Stronger consistency guarantees for reads",
      "Encryption of the hash ring",
      "Smoother load distribution, capacity weighting, and spreading a failed node's load over many successors",
      "Support for range queries on the ring"
    ],
    "answer": 2,
    "explain": "With one point per node, random placement is lumpy and a dead node's whole arc dumps onto a single neighbor. Hundreds of vnodes per physical node smooth both problems and let heterogeneous machines take proportional shares."
  },
  {
    "q": "A search must consult every partition because each partition only indexes its own documents. Which design is this?",
    "choices": [
      "A global (term-partitioned) secondary index",
      "A local (document-partitioned) secondary index with scatter-gather reads",
      "Consistent hashing with virtual nodes",
      "A covering primary index"
    ],
    "answer": 1,
    "explain": "Local indexes keep writes single-partition but force reads to fan out to all partitions and merge results — with tail latency compounding. Global indexes invert the trade: surgical reads, fan-out (and usually async) writes."
  }
]
```
