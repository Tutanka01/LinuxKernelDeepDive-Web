# Kernel Synchronization: Locks, Atomics & RCU

> **Goal:** understand how the kernel coordinates access to shared data
> across multiple CPUs, interrupts, and preempting threads. The locking
> primitives that make parallel kernel code correct — and why read the source
> without knowing them is impossible.

## Why the kernel needs locks everywhere

The kernel is a massively concurrent program:
- Multiple CPUs execute kernel code simultaneously (SMP).
- An interrupt can fire on a CPU that was already inside kernel code.
- A bottom-half (softirq/tasklet) can preempt almost anything.
- Preemption means the kernel can context-switch while holding a lock.

Without synchronization, two CPUs updating the same `task_struct`, page
table entry, or socket buffer simultaneously would produce silent corruption.
The kernel's correctness relies entirely on disciplined locking.

The key insight: **kernel code is shared-memory multithreaded code, but it
also manages hardware constraints** (interrupts, cache coherency, memory
ordering). The locking primitives must work across all of these.

## The lock hierarchy

The kernel provides a stack of synchronization tools, from simplest to most
sophisticated:

| Primitive | What it protects | Can sleep while holding? | Typical user |
|---|---|---|---|
| Atomic operations | Single integer/pointer | No (they're single instructions) | Counters, flags, refcounts |
| Spinlock | Short critical sections | **No** (busy-waits) | IRQ handlers, scheduler, hot paths |
| Mutex | Longer critical sections | **Yes** (sleeps the caller) | Filesystem ops, driver probe, memory allocation |
| RW lock (reader-writer) | Many readers OR one writer | Depends on variant | Page tables, inode tree, networking tables |
| RCU | Read-often-write-rarely data | Yes (read side) | Routing tables, dcache, fd table lookups |
| Seqlock | Write-rarely data with fast readers | No | `jiffies`, `ktime` — timekeeping structures |
| Completion | Thread signaling | Yes (waiter sleeps) | "Wait until this I/O is done" |

## Atomic operations: the building blocks

Sometimes you need to increment a counter or set a flag without a full lock:

```c
atomic_t counter = ATOMIC_INIT(0);
atomic_inc(&counter);      // thread-safe increment
atomic_dec_and_test(&counter);  // decrement, return true if reached zero
atomic_read(&counter);      // read the value

// Bit operations on unsigned long:
set_bit(NR_LOCKED, &flags);
test_and_clear_bit(NR_DIRTY, &flags);
```

These compile to single `LOCK`-prefixed instructions on x86 (`lock inc`,
`lock cmpxchg`), which are atomic across all CPUs. They also act as
full memory barriers on x86 (they flush the store buffer, making all prior
writes visible to other CPUs). On ARM, `atomic_inc()` generates `ldaxr/stlxr`
(load-acquire/store-release exclusive).

The key rule: atomics are for **single-word** operations. If you need to
update two fields together (e.g., a linked list insertion), you need a lock.

Reference counting is so common the kernel has a dedicated type:

```c
struct kref {
    refcount_t refcount;    // = refcount_t, checked variant of atomic_t
};
void kref_init(struct kref *kref);
void kref_get(struct kref *kref);      // increment
void kref_put(struct kref *kref, void (*release)(struct kref *));  // decrement, release if zero
```

`refcount_t` is a hardened `atomic_t` — it detects overflows and
underflows at runtime and refuses (no silent wraparound, unlike raw atomics).

## Spinlocks: the workhorse of hot paths

A spinlock is a single `unsigned int` that says "locked (1) or unlocked (0)".
If someone holds it, the caller **spins in a tight loop**, testing the lock
repeatedly until released:

```c
spinlock_t lock;
spin_lock(&lock);               // busy-wait until lock is available
// ... critical section ...
spin_unlock(&lock);
```

Spinlocks work only when the critical section is **short** (microseconds at
most) and the caller **cannot sleep**. If you sleep while holding a spinlock,
the next person who wants it spins forever on that CPU, deadlocking the
entire core.

The most common variant: `spin_lock_irqsave()` — disables local interrupts
before acquiring. This prevents an interrupt handler on the *same CPU* from
deadlocking (interrupt fires, tries to lock → spin forever since the
interrupted context holds it → deadlock):

```c
unsigned long flags;
spin_lock_irqsave(&lock, flags);   // save irq state, disable irqs, acquire
// ... critical section that might be accessed from IRQ handler ...
spin_unlock_irqrestore(&lock, flags);  // release, restore irq state
```

This is the single most common locking pattern in all of driver code. If you
see a spinlock protecting data that an interrupt handler touches, the
non-irqsave variant is a bug waiting to happen.

Where to find them: the scheduler's run queues, the dentry cache hash table,
network socket lookup tables, the timer wheel, the VMA tree in `mm_struct`.
Anywhere that's hot and can't sleep.

## Mutexes: the sleeping lock

When the critical section is long or may block (memory allocation, disk I/O,
waiting for a network response), use a mutex:

```c
struct mutex lock;
mutex_lock(&lock);              // if locked, sleep until unlocked
// ... long critical section, may call functions that sleep ...
mutex_unlock(&lock);
```

Mutexes use PI (priority inheritance) on PREEMPT_RT kernels — if a high-priority
real-time task blocks on a mutex held by a low-priority task, the holder's
priority is temporarily bumped to the waiter's priority, preventing priority
inversion.

Where to find them: `inode->i_mutex` (but now `inode->i_rwsem`), subsystem
initialization paths, any lock that might be held across a disk operation.

## Reader-writer locks

When many threads only *read* shared data and writes are rare, reader-writer
locks allow simultaneous readers but exclusive writers:

```c
// Spinlock variant (can't sleep):
rwlock_t lock;
read_lock(&lock);     // multiple readers allowed simultaneously
read_unlock(&lock);
write_lock(&lock);    // blocks until all readers have left
write_unlock(&lock);

// Mutex variant (can sleep) — the most common one in modern code:
struct rw_semaphore sem;
down_read(&sem);      // reader lock; may sleep briefly for the rwsem itself
up_read(&sem);
down_write(&sem);     // writer lock; blocks until readers=0
up_write(&sem);
```

Where to find them: `mm_struct→mmap_lock` (protects the VMA tree — page fault
handlers take it as reader while `mmap()` and `munmap()` take it as writer).
Filesystem metadata structures. The tasklist lock (protecting `for_each_process()`
traversals).

> **Writer starvation warning:** under continuous reads, writers may wait
> indefinitely on plain rwlock/rwsem. The kernel has `rwsem` fairness
> improvements (handoff to waiting writer after too many readers), but the
> fundamental tension exists.

## Seqlocks: readers that never wait

For data where reads vastly outnumber writes and the read-side must be
extremely fast (no atomic RMW, no lock acquire), seqlocks are brilliant:

```c
seqlock_t lock;

// Reader:
unsigned seq;
do {
    seq = read_seqbegin(&lock);   // read the sequence number (no lock!)
    // ... read the protected data ...
} while (read_seqretry(&lock, seq));  // if a writer ran in between, retry

// Writer:
write_seqlock(&lock);
// ... modify the data ...
write_sequnlock(&lock);            // increments sequence number
```

The cost: readers must be retry-able (no side effects in the read path).
The benefit: readers never block, never take a lock, never experience cacheline
bouncing.

Where to find them: `jiffies`, the wall-clock time structures, vDSO data
pages (the data that `clock_gettime()` reads from userspace without entering
the kernel).

## RCU: Read-Copy-Update

RCU is Linux's most unique synchronization mechanism and one that defines how
the kernel achieves performance at scale. The insight:

> **Simplified model:** if readers never block and never acquire locks, and
> writers make a copy before modifying, then read-side overhead is extremely
> low — no atomic operations, no cacheline contention, no lock acquire.
>
> **Important nuance:** exactly how low depends on kernel configuration and
> RCU variant. In `CONFIG_PREEMPT_NONE` (non-preemptible kernel), `rcu_read_lock()`
> and `rcu_read_unlock()` may indeed compile to zero instructions. In a
> preemptible kernel (`CONFIG_PREEMPT`), RCU read-side primitives must
> disable/enable preemption, and the cost is real though still low — the
> official kernel documentation notes that there is no single "correct" way
> to summarize RCU because the details vary with configuration.

The RCU API has three parts:

```c
// Reader:
rcu_read_lock();                   // disables preemption on PREEMPT kernels;
                                   // compiles to nothing on PREEMPT_NONE
p = rcu_dereference(shared_ptr);   // read the pointer (compiler barrier)
// ... use p — no lock, no atomic, nothing ...
rcu_read_unlock();                 // re-enables preemption (or nothing)

// Writer (update):
new = kmalloc(sizeof(*new));        // create a new version
*new = *old;                        // copy
new->field = new_value;             // make the change

rcu_assign_pointer(shared_ptr, new);  // atomic pointer swap
synchronize_rcu();                    // wait for all existing readers to finish
kfree(old);                           // now safe — nobody was looking at 'old'

// The wait: synchronize_rcu() blocks until every CPU has passed through
// a quiescent state (context switch, return to user space, or idle).
// This guarantees all pre-existing rcu_read_lock() sections have ended.
```

The key trade-off: `rcu_read_lock()` is cheap because it only disables
preemption (and on `CONFIG_PREEMPT_NONE` kernels, it compiles away entirely).
Preemption is prevented so that the reader cannot be context-switched out
while holding a reference to RCU-protected data. `synchronize_rcu()` then
waits for all CPUs to pass through a quiescent state (context switch, return
to user space, or idle), proving no pre-existing readers remain. The read
path pays at most a preempt disable/enable pair with no atomic operations and
no cacheline contention on the shared pointer. This is why Linux can route
millions of packets per second while simultaneously updating the routing
table.

RCU is used in:
- The **dentry cache** (path lookup reads dentries under RCU — `open()` on a
  cached path acquires no locks at all).
- The **routing table** (packet forwarding happens under RCU read lock, route
  updates use synchronize_rcu).
- The **file descriptor table** (syscalls like `close()` update fd arrays via
  RCU).
- The **task list** (traversing all processes, e.g., `kill -1`, uses RCU).
- The **module list** (loading/unloading modules updates RCU-protected lists).
- **BPF** map lookups are RCU-protected.

RCU variants for different use cases:
- `call_rcu()` — schedule a callback instead of blocking.
- `synchronize_rcu_expedited()` — faster, more expensive (IPI all CPUs).
- `SRCU` (Sleepable RCU) — readers may sleep (used in KVM).
- `Tasks RCU` — tracks voluntary context switches (used for trampoline cleanup).

## Memory ordering: when explicit barriers are needed

On weak-memory-model architectures (ARM, PowerPC), the CPU may reorder memory
accesses. For classical critical sections protected by correctly paired
`spin_lock()` / `spin_unlock()`, the lock itself provides the necessary
acquire and release semantics — the lock already guarantees that stores inside
the critical section are visible to the next lock acquirer.

Explicit barriers become critical for **lockless algorithms** and more complex
ordering relationships that aren't covered by a single lock acquire/release
pair. The kernel provides:

```c
smp_mb();          // full memory barrier: all prior stores visible before any later loads
smp_rmb();         // read barrier: all prior loads complete before any later loads
smp_wmb();         // write barrier: all prior stores complete before any later stores
smp_store_release(&x, val);   // store x=val, all prior stores visible
smp_load_acquire(&x);         // load x, all subsequent loads see updated values
```

On x86, most of these are nearly free (x86 has a strong memory model — stores
are not reordered past stores, loads past loads). On ARM, they become `dmb`
instructions. The kernel abstracts this away: standard locks (`spin_lock`,
`mutex_lock`, etc.) already contain the necessary acquire/release semantics
for the data they protect. Explicit barriers are needed only when you're
writing lockless data structures (like RCU-protected lists, ring buffers, or
novel synchronization primitives). In practice, most kernel developers use
them rarely — sufficiently rarely that the kernel provides the `WRITE_ONCE()`
and `READ_ONCE()` macros as a gentle reminder when volatile-like access
patterns matter.

## Choosing the right lock: a decision tree

```
Is the data accessed from interrupt handlers?
  Yes → spin_lock_irqsave, never sleep, never mutex.
  No  →
    Is the critical section very short (microseconds)?
      Yes → spin_lock (or rwlock for read-heavy)
      No  → mutex or rw_semaphore

Is the data read by thousands of CPUs simultaneously?
  → RCU. The read-side is free.

Is the data a single integer/flag/counter?
  → atomic_t. No lock needed.

Are writes very rare and reads need to be extremely fast?
  → seqlock.

Is a thread waiting for a specific event?
  → completion.
```

## Debugging locks

The kernel's lock validator (lockdep) is enabled in debug kernels. It detects
deadlocks at runtime by tracking the order in which locks are taken and
flagging any reverse ordering:

```bash
grep LOCKDEP /boot/config-$(uname -r)  # CONFIG_LOCKDEP=y → enabled
dmesg | grep "possible circular locking dependency"  # a lockdep report
# These reports are usually correct. Fix the ordering.
```

```bash
# Common lock contention investigation:
perf record -e lock:lock_acquire -e lock:lock_release -a -g -- sleep 10
perf report
cat /proc/lock_stat | head              # spinlock contention statistics
```

## Source map

| Primitive | Kernel path |
|---|---|
| spinlock | `include/linux/spinlock.h`, `kernel/locking/spinlock.c` |
| mutex | `kernel/locking/mutex.c` |
| rwsem | `kernel/locking/rwsem.c` |
| RCU | `kernel/rcu/`, `include/linux/rcupdate.h` |
| atomics | `include/linux/atomic.h`, `arch/<arch>/include/asm/atomic.h` |
| seqlock | `include/linux/seqlock.h` |
| memory barriers | `include/asm-generic/barrier.h` |

RCU in particular has excellent documentation: `Documentation/RCU/` in the
kernel source — `whatisRCU.rst` is the canonical introduction.

## Try it yourself

```bash
# How many spinlocks/mutexes is your system currently holding? (needs lock stat kernel)
cat /proc/lock_stat | head
# Check if RCU is active:
cat /sys/kernel/debug/rcu/rcu_sched/rcugp  # grace period state
dmesg | grep -i "lockdep\|rcu\|spinlock"   # lock debug reports
# TLB shootdowns (a consequence of SMP synchronization for page faults):
perf stat -e irq_vectors:LOCAL_APIC_TLB_SHOOTDOWN -a -- sleep 1
```

## Two sharp checks

1. A kernel module's `probe()` function calls `mutex_lock()`, sleeps 5
   seconds inside, and then calls `schedule()`. Why is this fine — while
   doing the same with `spin_lock()` is a disaster?
2. Why does `rcu_read_lock()` cost zero instructions on the hot path, while
   `synchronize_rcu()` can take milliseconds?

*(Answers: mutex_lock() puts the caller to sleep on the mutex wait queue via
schedule() while another thread holds it — this is safe because the waiter
gives up the CPU; spin_lock() busy-waits — calling schedule() while holding a
spinlock leaves the lock held forever on that CPU and any other CPU trying to
acquire it will spin indefinitely, essentially deadlocking that core;
rcu_read_lock() disables preemption on preemptible kernels and compiles to
nothing on CONFIG_PREEMPT_NONE — in either case, no atomic operations, no
lock, no cacheline bouncing on the shared pointer; the cost is amortized in
synchronize_rcu() which must wait for every CPU to pass through a quiescent
state (context switch, return to userspace, or idle), which can take tens
of milliseconds depending on HZ and workload.)*

---

**Next:** the human side — how the kernel project actually works. The maintainers, the mailing lists, the merge window cadence, the 15,000 contributors, and the unwritten rules that govern the largest software project in history.
