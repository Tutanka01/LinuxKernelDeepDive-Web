# Rust in the Linux Kernel

> **Goal:** understand why Rust is entering the kernel after 30 years of
> pure C, what has already been merged (since 6.1), how it interacts with the
> C codebase, and what this means for the future of kernel development and
> security.

## Why Rust in a 40-million-line C codebase?

The kernel's biggest source of vulnerabilities is **memory safety bugs** in
C code: use-after-free, double free, buffer overflows, NULL dereferences,
uninitialized memory. Google's Android team reports that memory safety bugs
are roughly 70% of all high-severity kernel vulnerabilities — and this
percentage hasn't changed in over a decade, despite massive investment in
testing (syzbot, KASAN, KFENCE, KMSAN, KCSAN, lockdep, kmemleak, etc.).

Rust eliminates these entire classes of bugs at compile time:

| Bug class | C mitigations | Rust |
|---|---|---|
| Use-after-free | KASAN (runtime detector) | Ownership + borrow checker — cannot compile |
| Double free | Debug slabs detect it | Ownership — cannot compile |
| Buffer overflow | KASAN, FORTIFY_SOURCE | Bounds-checked by default (unsafe is opt-in) |
| NULL dereference | Static analysis | `Option<T>` — must handle None case |
| Data races | KCSAN | Send/Sync traits — cannot compile data races |
| Uninitialized memory | KMSAN | All values must be initialized |

The game-changer: instead of *detecting* bugs at runtime in production (and
hoping you hit the right code path), the compiler *refuses to emit* the buggy
code at all.

Rust is not replacing C wholesale — that would mean rewriting ~40 million
lines, which is impossible. The strategy is **Rust for new code**,
particularly in the areas with the highest vulnerability density:
**drivers**.

### Why drivers specifically?

Drivers are:
- The majority of kernel code (~60-70% of lines).
- The majority of vulnerabilities (more than core subsystems, which are more
  heavily reviewed).
- Written by hardware vendors, not core kernel developers — the "long tail"
  of less-reviewed code.
- Self-contained — a single driver interacts with the kernel through a
  well-defined API, making Rust wrappers practical.

A Rust NVMe driver, Rust GPU driver (the Asahi Linux Apple M1/M2 GPU driver
is already written in Rust), Rust network drivers — these are the first targets.

## What's been merged (kernel 6.1 → now)

The Rust infrastructure landed in kernel **6.1** (December 2022). Progress
since then:

| Kernel | What landed |
|---|---|
| 6.1 | Rust infrastructure (`rust/` directory), `kernel` crate with basic bindings, `printk` macros, error types |
| 6.2-6.4 | String handling, `Vec`, synchronization primitives (Mutex, SpinLock — wrapped C versions) |
| 6.6 | Workqueue support, improved allocator API |
| 6.7 | First in-tree Rust driver: the **Nova** GPU driver for Apple M1/M2 (Asahi Linux), plus networking PHY driver abstractions |
| 6.8 | LoongArch Rust support, more networking abstractions |
| 6.12 | Block layer abstractions (Android's Binder driver rewrite in Rust in progress) |

The key directory:
```text
rust/
├── kernel/         # bindings to kernel C APIs (safe Rust wrappers)
├── macros/         # proc macros for module declaration, vtable generation
├── bindings/       # auto-generated raw C bindings
├── alloc/          # kernel memory allocator integration
└── Makefile, Kconfig
```

## How Rust and C coexist

Rust doesn't replace the C build system. The kernel build (`make`) compiles
`.rs` files using `rustc` (via `bindgen` to generate C ↔ Rust FFI bindings):

```text
C header files (*.h)
       │
       ▼ bindgen (build time)
Rust bindings (bindings_generated.rs)  ← raw FFI: extern "C" fn, unsafe
       │
       ▼ Rust kernel crate
Safe Rust API (kernel::...)            ← Mutex<T>, spin_lock_irqsave via RAII guard
       │
       ▼ your driver
Safe(ish) Rust driver code
```

The pattern: a thin Rust crate (`kernel`) wraps the unsafe C FFI bindings
in safe abstractions. Driver authors use the safe API. The unsafe code is
concentrated in one reviewed layer, not scattered across every driver.

Example — a kernel mutex in Rust:

```rust
use kernel::sync::Mutex;

struct MyDriverData {
    counter: usize,
}

// Mutex<MyDriverData> wraps the kernel's C mutex.
// Lock returns a RAII guard — automatically unlocks on drop.
// This is safe Rust. No forgetting to unlock, no lock inversion bugs caught
// at runtime — the guard's lifetime enforces the critical section scope.
static MY_DATA: Mutex<MyDriverData> = Mutex::new(MyDriverData { counter: 0 });

fn my_function() {
    let mut guard = MY_DATA.lock();  // acquires the kernel mutex (may sleep)
    guard.counter += 1;
    // guard dropped here → mutex unlocked. Automatic, guaranteed.
}
```

What Rust gives you that C can't:
- The Mutex's content (`MyDriverData`) is *owned* by the Mutex. You cannot
  access it without locking.
- The lock guard's lifetime (`guard`) is the critical section. It literally
  cannot compile code that uses the data after the lock is released.
- For spinlocks in IRQ context, the equivalent spin_lock_irqsave guard
  **restores interrupts on drop**, even in early-return or panic paths. No
  missing `spin_unlock_irqrestore`.

## The challenges (why this is hard)

### Rust's standard library doesn't exist

The kernel can't use the Rust standard library (no `std::Vec`, `std::Box`,
`std::Mutex`). The kernel has its own allocator, its own synchronization
primitives paired with interrupt state, its own error handling (no
`Result<T, E>` that panics on allocation failure — kernel allocation can
fail and must return `-ENOMEM`). The `kernel` crate reimplements these
concepts on top of kernel internals.

### The C binding layer is enormous

The kernel has thousands of functions, types, and macros exported to drivers.
Wrapping them in safe Rust abstractions takes time. The current approach:
wrap on-demand, starting with what's needed for the first in-tree drivers.

### Toolchain requirements

Rust for Linux requires a specific minimum `rustc` version. This complicates
the kernel's already conservative toolchain requirements (typically gcc
~2 versions behind latest). The Rust for Linux team works closely with the
Rust compiler team to stabilize kernel-specific features.

### Cultural resistance

Not every kernel maintainer is enthusiastic. Key objections:
- "Two languages forever" — increases maintenance burden.
- "Rust doesn't support our obscure architecture" — true for some niche
  platforms.
- "The abstractions are leaky" — sometimes you still need `unsafe` for raw
  hardware access.

Linus Torvalds' stance: cautiously pragmatic. He accepted the infrastructure
merge but has said Rust must prove itself with real drivers before it becomes
mandatory for any subsystem.

## What this means for you

### If you want to write kernel code in the future

Learning Rust alongside C is increasingly strategic. For new drivers (the
most accessible entry point for contributors), Rust will eventually be the
preferred language. The kernel's core (scheduler, memory management, VFS)
will remain C indefinitely — but the driver layer is the frontier.

### If you're reading kernel source

You'll increasingly encounter `rust/` and `.rs` files. The concepts are the
same (mutexes, spinlocks, structs, callbacks) — the syntax and safety
guarantees are different.

### The security impact

Google's Android team has publicly stated: "Rust in the kernel is the most
effective thing we can do to reduce Android's vulnerability surface." The
expectation is that over 5-10 years, the graph of memory-safety bugs will
start to bend downward for the first time in Linux history.

## The bigger picture: this has happened before

...kind of. The kernel has absorbed major language changes before:
- From assembly to C in the early 1990s — Linus rewrote the bootloader
  and core start-up path from asm to C. (The kernel was originally in
  Minix-style assembly for task switching.)
- The addition of inline assembly, then compiler intrinsics, then
  `__attribute__` extensions — C itself has been extended for kernel needs.
- The biggest prior tooling change: **Git** — Linus wrote git to manage
  the kernel, and it transformed the project's development speed.
- **BPF** was a new execution substrate inside the kernel, requiring a new
  verifier, JIT, and instruction set — a similarly large infrastructure
  addition, accepted because it proved itself useful.

Rust is different in scale but similar in pattern: a new tool to solve a
persistent problem that existing tools couldn't fix.

## Try it yourself

```bash
# Check if your kernel has Rust support:
zgrep RUST /proc/config.gz 2>/dev/null || grep RUST /boot/config-$(uname -r)
# CONFIG_RUST=y → Rust support compiled in (not enabled in most distro kernels yet)

# Compile a Rust kernel module (needs recent kernel + rust toolchain):
git clone --depth=1 https://github.com/Rust-for-Linux/rust-out-of-tree-module
cd rust-out-of-tree-module && make
# (requires the Rust for Linux toolchain, rustc >= 1.78 nightly-ish)

# Read the state of Rust for Linux:
git log --oneline --since=2024-01-01 -- rust/ | head
```

## Check your understanding

1. Why are drivers the target for Rust rather than the core scheduler or
   memory manager?
2. What does the Mutex RAII guard guarantee that a C `mutex_lock()/unlock()`
   pair cannot?
3. Why can't the kernel use Rust's standard `std::Mutex` from the standard
   library?
4. What is the significance of `unsafe` in kernel Rust — is it a bug?

*(Answers: drivers are the largest code volume, highest vulnerability rate,
and most self-contained (well-defined kernel API boundary), making them the
highest-impact target; the Mutex guard owns the protected data — you cannot
access the data without locking, the lock is automatically released when the
guard goes out of scope (even on early return or panic), and the compiler
catches use-after-free and lock-vs-data mismatches at compile time; the kernel
has its own allocator, its own interrupt-aware spinlock variants
(spin_lock_irqsave), and cannot panic on OOM — the kernel crate wraps the
C primitives in safe Rust abstractions that follow kernel conventions;
`unsafe` is a keyword marking code where the compiler can't verify safety —
it's not a bug but a contract: "I, the programmer, have manually verified
this satisfies the kernel's invariants." The unsafe code is concentrated in
the bindings layer; driver code should be mostly safe Rust.)*

---

**Next:** Part VII — the kernel as hypervisor. KVM turns Linux into the platform that runs every cloud VM on earth. The vCPU execution loop, VM exits, EPT page tables, virtio paravirtualized I/O, and why steal time matters.
