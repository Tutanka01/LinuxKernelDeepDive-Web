/* ============================================================
   Distributed Systems — A Guided Course.

   Course data only: the module → chapter tree and the strings that
   make this course itself. The engine that renders it — router,
   quizzes, search, progress, scroll memory — is shared with the
   Inference Engineering course and lives in ../../assets/course.js,
   which the page loads immediately after this file.
   ============================================================ */

const COURSE = [
  {
    module: "Module 1 — Foundations",
    level: "beginner",
    levelLabel: "Beginner",
    blurb: "Start from zero: what a distributed system is, why we build them, and why the network will betray you.",
    chapters: [
      { slug: "what-is-a-distributed-system", title: "What Is a Distributed System?",
        desc: "Definitions, motivations, the eight fallacies, and the right mental model." },
      { slug: "the-network-is-hostile", title: "The Network Is Hostile",
        desc: "Messages, latency, partial failure, timeouts, retries and idempotency." },
      { slug: "failure-models", title: "Failure Models & Detection",
        desc: "Crash-stop to Byzantine, heartbeats, and why perfect failure detection is impossible." },
    ],
  },
  {
    module: "Module 2 — Time & Order",
    level: "beginner",
    levelLabel: "Beginner+",
    blurb: "There is no global 'now'. Learn why wall clocks lie and how systems order events without them.",
    chapters: [
      { slug: "time-and-clocks", title: "Time, Clocks & Why They Lie",
        desc: "Clock drift, NTP, monotonic vs wall time, and timestamp pitfalls." },
      { slug: "logical-clocks", title: "Logical & Vector Clocks",
        desc: "Happens-before, Lamport clocks, vector clocks, and causality in practice." },
    ],
  },
  {
    module: "Module 3 — Data at Scale",
    level: "intermediate",
    levelLabel: "Intermediate",
    blurb: "Keeping copies of data on many machines — and the consistency bill that comes due.",
    chapters: [
      { slug: "replication", title: "Replication",
        desc: "Leader-follower, replication lag, multi-leader, leaderless & quorums." },
      { slug: "consistency-models", title: "Consistency Models & CAP",
        desc: "Linearizability to eventual consistency, client guarantees, CAP and PACELC." },
      { slug: "partitioning", title: "Partitioning & Sharding",
        desc: "Hash vs range sharding, consistent hashing, rebalancing, hot keys." },
    ],
  },
  {
    module: "Module 4 — Coordination",
    level: "advanced",
    levelLabel: "Advanced",
    blurb: "Getting machines to agree: the hardest problem in the field, and the algorithms that solve it.",
    chapters: [
      { slug: "consensus", title: "The Consensus Problem",
        desc: "Why agreement is hard, FLP, two-phase commit's flaw, Paxos intuition." },
      { slug: "raft", title: "Raft, Step by Step",
        desc: "Leader election, log replication, the safety argument, snapshots, membership." },
      { slug: "distributed-transactions", title: "Distributed Transactions",
        desc: "2PC in depth, sagas, the outbox pattern, and the exactly-once myth." },
    ],
  },
  {
    module: "Module 5 — Advanced Systems",
    level: "advanced",
    levelLabel: "Advanced+",
    blurb: "Coordination-free convergence, and how the famous real-world systems put it all together.",
    chapters: [
      { slug: "crdts-and-gossip", title: "CRDTs, Gossip & Anti-Entropy",
        desc: "Conflict-free replicated data types, Merkle trees, epidemic protocols." },
      { slug: "real-world-architectures", title: "Real-World Architectures",
        desc: "ZooKeeper/etcd, Kafka, Dynamo, Spanner, Kubernetes — the ideas in the wild." },
    ],
  },
];

/* ---------------- course identity ---------------- */

const COURSE_META = {
  storeKey:  "ds-course-progress-v1",     /* localStorage: completion (do not rename) */
  scrollKey: "ds-scroll",                 /* sessionStorage: scroll positions */
  name:      "Distributed Systems",
  homeTitle: "Distributed Systems — A Guided Course",
  heroTitle: "Distributed Systems,<br>from first principles",
  heroLede:  `One machine is simple. Two machines connected by a wire is a
              different universe — one where messages vanish, clocks disagree
              and half your system can die while the other half keeps going.
              This course builds that universe up carefully: each chapter
              stands on the previous one, from the very basics to consensus,
              transactions and the architectures behind Kafka, Spanner and
              Kubernetes.`,
  timeEstimate: "4–5 hours",
  servePath: "/distributed/",
  footer:    "Distributed Systems — a guided course. Tip: use ← and → to move between chapters.",
};
