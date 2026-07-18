---
level: core
kernel: 6.12
verified: 2026-07
minutes: 25
requires: 
---

# The Machine Underneath: CPU, Memory & Devices

> **Goal:** build the hardware mental model that every later chapter silently
> assumes. By the end you'll know what a CPU actually does instruction by
> instruction, what a memory address *is* (and how to read the hexadecimal the
> whole book is written in), why the machine has five kinds of memory instead of
> one, what "multicore" really costs, and how the CPU talks to your disk and
> network card. No C, no prior hardware knowledge — just the physical reality the
> kernel spends its whole life managing.

Every chapter after this one describes the kernel *managing hardware*:
scheduling work onto CPUs, mapping virtual memory onto physical RAM, fielding
interrupts from devices. If you've never looked below the shell, those words are
abstract. This chapter makes them concrete. We're going to look at the actual
machine — the silicon the kernel is standing on — because you cannot understand
the manager without first meeting the thing being managed.

The single most important idea in this whole chapter: **the hardware knows
nothing about processes, files, users, or programs.** Those are all inventions
of the kernel, built on top of a machine that only understands numbers in
memory and a handful of dumb instructions. Hold onto that; we'll come back to it.

## What a CPU actually does

A CPU (central processing unit, the "processor") is, stripped of all mystique,
a machine that repeats one loop billions of times per second:

1. **Fetch** the next instruction from memory.
2. **Decode** it — figure out what operation it names.
3. **Execute** it — do the thing (add two numbers, load a value, jump elsewhere).
4. Repeat.

That's it. That loop — **fetch, decode, execute** — is the entire job. There is
no step where the CPU thinks about "the Firefox process" or "the file
`notes.txt`." It fetches an instruction, does it, fetches the next one. The
sophistication of a modern CPU is all in doing this loop *fast* and *many at
once*, not in doing anything conceptually grander.

### Registers: the CPU's only hands

The CPU cannot compute directly on RAM. To add two numbers, it must first pull
them into **registers** — a few dozen tiny storage slots physically on the CPU
chip, each holding one machine word (64 bits on a modern machine). Registers are
the only things the CPU can operate on directly, and there are shockingly few of
them. Think of registers as the CPU's hands: it can only juggle a handful of
values at a time, and everything else has to be fetched from and put back into
memory.

A few registers have special jobs, and you'll meet these names constantly:

| Register | Role |
|---|---|
| General-purpose (x86-64: `rax`, `rbx`, `rcx`, … / arm64: `x0`–`x30`) | Scratch space for arithmetic and holding values or addresses |
| **Instruction pointer** (x86-64: `rip`, arm64: `pc`) | Holds the memory address of the *next* instruction to fetch |
| **Stack pointer** (x86-64: `rsp`, arm64: `sp`) | Points to the top of the current call stack (local variables, return addresses) |

The **instruction pointer** deserves a special stare. It is just a register
holding an address, and after each instruction the CPU normally bumps it forward
to the next one. That single register *is* "where the program is right now."
Change it — which a jump instruction does — and the CPU is now executing
somewhere else. When the kernel switches from one task to another
([CPU Scheduling](#/scheduling)), the deepest thing it does is save one task's
registers (including the instruction pointer) and load another's. The CPU
resumes and has no idea anything happened — it just keeps fetching from wherever
the instruction pointer now points.

### Machine code vs assembly: one tiny example

The instructions the CPU fetches are **machine code** — raw bytes. A given byte
pattern *means* "add these two registers." Humans can't read raw bytes, so we
write **assembly language**: a one-to-one text spelling of those instructions.
Assembly is still brutally low-level — one line is one CPU instruction — but at
least it has words.

You do not need to read assembly to use this book. But you should see it *once*,
so "the CPU only understands instructions" stops being abstract. Here is what
adding 1 to a variable looks like, in x86-64 assembly, assuming the variable
lives in memory at the address currently held in register `rbx`:

```asm
mov  rax, [rbx]    ; load the value at address rbx into register rax
add  rax, 1        ; add 1 to rax
mov  [rbx], rax    ; store rax back into memory at address rbx
```

Read it top to bottom. The square brackets mean "the memory at this address."
The CPU cannot add 1 to a value sitting in RAM in one step — it must **load** it
into a register, **add**, then **store** it back. Three instructions for
something you'd write as `a = a + 1` in any language. That gap — one line of C
becoming several CPU instructions — is exactly what a compiler bridges, and it's
the subject of the next chapter, [From Source Code to Running Process](#/prereq-programs).

The point is not the syntax. The point is: **this is all a CPU understands.**
Not functions, not variables, not `if` statements — just load, add, store, jump,
compare, one dumb step at a time. Everything richer is built on top by software.

### Clock cycles

The CPU is driven by a **clock** — an electrical signal ticking billions of
times per second. "3 GHz" means three billion ticks (cycles) per second. Simple
instructions take a handful of cycles; a cycle is therefore a fraction of a
nanosecond. This is the CPU's fundamental unit of time, and it's why the latency
numbers later in this chapter are quoted in nanoseconds: at these speeds, *how
far away the data is* dominates everything.

### The CPU knows nothing

Worth repeating now that you've seen the machinery: the CPU has no concept of a
process, a file, a user, or a program. It fetches instructions and executes
them. Left alone, it would run off the end of one program straight into whatever
bytes came next in memory, with no notion that it had crossed a boundary.

Everything that makes a computer *usable* — the idea that Firefox and your shell
are separate processes that can't corrupt each other, that `notes.txt` is a
file, that you are a user with permissions — is invented by the kernel and
enforced using a few hardware features (privilege levels, the memory management
unit) that we'll meet as we go. This is the whole thesis of
[What Is Linux, Really?](#/what-is-linux): the kernel builds a civilized world
on top of a machine that only knows numbers and instructions.

## Memory and addresses

**RAM** (random-access memory, "main memory") is where running programs and
their data live. Picture it as one gigantic array of numbered slots, each slot
holding exactly one **byte** (8 bits, a number from 0 to 255):

```text
 address:   0        1        2        3        4      ...
          ┌────────┬────────┬────────┬────────┬────────┬─────
  byte:   │  0x48  │  0x65  │  0x6C  │  0x6C  │  0x6F  │ ...
          └────────┴────────┴────────┴────────┴────────┴─────
```

An **address** is nothing more mysterious than the *index* of a slot — "byte
number 4,096." When the CPU executes `mov rax, [rbx]`, the value in `rbx` is an
address: an integer saying which numbered slot to read. That's all a pointer is,
all an address is: a number naming a location in the big array. A machine with
16 GiB of RAM has roughly 16 billion of these numbered slots.

The bytes themselves have no inherent meaning. The same byte `0x48` might be part
of a number, a letter (`H` in text), or a piece of a CPU instruction — meaning
comes entirely from how software interprets it. The hardware just stores and
fetches numbers.

### Reading hexadecimal (a real mini-tutorial)

This book — and every kernel tool, every debugger, every `/proc` file — writes
addresses and raw values in **hexadecimal** ("hex"). If hex is fuzzy for you,
this section fixes that permanently, because nothing else will make sense
otherwise.

We normally count in **base 10**: ten digits, `0`–`9`, and each position is
worth ten times the one to its right. Hexadecimal is **base 16**: sixteen
digits. Since we only have ten number symbols, hex borrows the first six letters
for the values ten through fifteen:

| Hex digit | 0 1 2 3 4 5 6 7 8 9 | A | B | C | D | E | F |
|---|---|---|---|---|---|---|---|
| Value | 0–9 | 10 | 11 | 12 | 13 | 14 | 15 |

The `0x` prefix is just a flag meaning "the following digits are hex, not
decimal." So `0x10` is **not** ten — it's `1×16 + 0 = 16`. And `0xFF` is
`15×16 + 15 = 255`.

Why does everyone use hex instead of plain decimal? Because **one hex digit maps
exactly to four bits** (four bits can express 0–15, precisely one hex digit's
range). Four bits is called a **nibble**, and two nibbles — two hex digits —
make exactly one byte (8 bits, 0–255, `0x00` to `0xFF`). This clean alignment is
the whole reason hex won: memory is organized in bytes, and hex lets you read
bytes off at a glance. `0xFF` is one byte, all bits set. `0xFFFF` is two bytes.
Decimal has no such tidy relationship to bytes, so it obscures exactly what
you're trying to see.

To read a longer value like an address, work in nibbles. Books often group the
digits with underscores or spaces for readability:

```text
   0x7ffe_1234
     │      │
     │      └── low bytes: 0x12 0x34
     └───────── high bytes of the address
```

Each pair of hex digits is one byte. You rarely need to convert an address to
decimal by hand — the shell will do it (`printf '%d\n' 0x7ffe1234`). What you
*do* need is fluency at recognizing shapes: `0x1000` is 4096 (one page, as
you'll see), a value starting `0x7ff…` is almost always a user-space stack or
library address on x86-64, and `0xffff…` at the top is kernel territory (you saw
this exact split in [What Is Linux, Really?](#/what-is-linux)). Hex is the
native language of memory; after a few chapters it'll feel natural.

### KiB vs KB, MiB vs MB

You've seen this book write **KiB** and **MiB** rather than KB and MB, and
that's deliberate. There are two different "kilo"s in computing:

| Unit | Meaning | Value |
|---|---|---|
| **KB** (kilobyte) | Decimal, power of 10 | 1,000 bytes |
| **KiB** (kibibyte) | Binary, power of 2 | 1,024 bytes (2¹⁰) |
| **MB** (megabyte) | Decimal | 1,000,000 bytes |
| **MiB** (mebibyte) | Binary | 1,048,576 bytes (2²⁰) |
| **GiB** (gibibyte) | Binary | 1,073,741,824 bytes (2³⁰) |

Memory hardware is organized in powers of two, so a "4 KiB page" is exactly 4,096
bytes — a round number in hex (`0x1000`), a slightly odd one in decimal. This
book uses the **-bi- units (KiB, MiB, GiB)** whenever it means the binary value,
which for memory is almost always. Disk and network vendors, annoyingly, tend to
use the decimal units (a "1 TB" disk is 10¹² bytes, which is why it shows up as
only ~931 GiB in your file manager). Same word, ~7% different number, endless
confusion. The `-i-` makes it unambiguous.

### What "64-bit" means

Your machine is "64-bit." Concretely, that means registers are 64 bits wide and,
crucially, **addresses are 64-bit numbers.** A 64-bit address can in principle
name 2⁶⁴ bytes — 16 *exbibytes*, an absurd amount no machine has. So current
CPUs don't wire up all 64 bits: x86-64 typically uses 48 bits of address (256
TiB), and the top bits are required to be a sign-extension of bit 47 (the
"canonical address" rule that creates the gap in the address-space diagram you
saw in [What Is Linux, Really?](#/what-is-linux)). The important takeaways: a
pointer is a 64-bit number, the address space is vastly larger than your actual
RAM, and — as the next section on the MMU hints and [Virtual Memory](#/memory)
develops fully — the addresses a program uses are *virtual*, translated to
physical RAM slots by hardware under the kernel's control.

## The memory hierarchy: five kinds of memory

Here is a fact that shapes the entire design of both CPUs and the kernel: **fast
memory is small and expensive; big memory is slow and cheap.** You cannot have
all three of fast, big, and cheap. So every computer is built as a *hierarchy* —
a few layers of small-fast memory backed by larger-slower ones, hoping most
accesses hit the fast layers.

From fastest/smallest/closest to the CPU, outward:

| Level | Typical size | Rough latency | What it is |
|---|---|---|---|
| **Registers** | ~dozens of words | <1 ns (part of a cycle) | On-chip, the CPU's hands |
| **L1 cache** | ~32–64 KiB per core | ~1 ns (a few cycles) | Tiny, per-core, split instruction/data |
| **L2 cache** | ~256 KiB–2 MiB per core | ~4 ns (~10–15 cycles) | Bigger, still per-core |
| **L3 cache** | ~a few–tens of MiB | ~15 ns (~40 cycles) | Shared across cores |
| **RAM** | ~8–128 GiB | ~100 ns | Main memory, off-chip |
| **SSD (NVMe)** | ~0.5–4 TiB | ~10–100 µs | Persistent storage |

(All numbers are orders of magnitude, not guarantees — they vary by CPU
generation and workload. The *ratios* are the point.)

The **caches** (L1/L2/L3) are the key characters. They're small, fast copies of
recently-used RAM, kept automatically by the CPU. When the CPU needs a byte, it
checks L1 first; if it's there (a "cache hit"), great, ~1 ns. If not (a "cache
miss"), it looks in L2, then L3, then finally trudges out to RAM at ~100 ns —
roughly **a hundred times slower.** Data moves between levels in fixed chunks
called **cache lines** (typically 64 bytes), which is why accessing memory in
sequential, nearby order is far faster than jumping around randomly: one miss
drags in a whole line, and the next few accesses are then free.

### The "if L1 were 1 second" analogy

Nanoseconds are hard to feel. Scale everything up so that an **L1 hit takes 1
second**, and the hierarchy becomes visceral:

| Access | Real latency | Scaled (L1 = 1 s) |
|---|---|---|
| L1 cache | ~1 ns | **1 second** |
| L2 cache | ~4 ns | ~4 seconds |
| L3 cache | ~15 ns | ~15 seconds |
| RAM | ~100 ns | **~2 minutes** |
| SSD read | ~50 µs | **~14 hours** |

At this scale, a cache miss out to RAM is the difference between answering a
question instantly and walking away for two minutes; reaching an SSD is more than
half a day. This is why the CPU works so hard to keep useful data in cache — and
why the kernel does too.

### Why the kernel cares so much

The kernel obsesses over caches because they silently make or break performance:

- When the scheduler moves a task from one core to another, the task's data is
  cold in the new core's caches — every access is a miss until the caches refill.
  This **cache thrash** is a real cost the scheduler weighs; it prefers to keep
  a task on the same core ("CPU affinity"). See [CPU Scheduling](#/scheduling).
- On big servers with multiple CPU sockets, some RAM is physically attached to
  one socket and is slower to reach from another. This is **NUMA**
  (non-uniform memory access), and the kernel tries to keep a task's memory on
  its local node — an entire subsystem exists for it, covered in
  [NUMA Deep Dive](#/numa-deep-dive).
- A context switch ([What Is Linux, Really?](#/what-is-linux)) costs a microsecond
  of direct work *plus* an invisible tax: the incoming task finds caches full of
  the outgoing task's data. That indirect cost is why the kernel avoids switching
  more than it must.

Every time a later chapter says the kernel "cares about cache locality," this
table is why.

## More than one core

For decades CPUs got faster by ticking faster. Around the mid-2000s that hit
physical limits (heat, mostly), so manufacturers went sideways instead: put
several complete CPUs — **cores** — on one chip. Your laptop likely has 4 to 16.
Each core runs its own fetch-decode-execute loop independently, so the machine
genuinely does several things at literally the same instant.

**SMT / hyperthreading** is a further trick: one physical core pretends to be
two "logical" CPUs, interleaving two instruction streams to keep the core's
execution units busy when one stream stalls (say, waiting on a cache miss). It's
not two real cores — the two threads share the core's caches and execution units
— but it often squeezes out extra throughput. To the kernel, each hardware
thread looks like a schedulable CPU; `lscpu` shows you both the core count and
the thread count.

Multiple cores create a fundamental new problem: **two cores can touch the same
memory at the same time.** If core 0 and core 1 both read a counter, both add 1,
and both write it back, one increment is lost — they raced. Worse, each core has
its own L1/L2 caches, so they can briefly disagree about what a memory location
even contains until the hardware's cache-coherency protocol reconciles them.
Coordinating concurrent access to shared memory is one of the hardest problems in
the kernel, and it has its own chapter: [Kernel Synchronization](#/kernel-sync)
(locks, atomic operations, memory barriers). Much of why the kernel is structured
the way it is comes down to making concurrent access to shared data structures
safe and fast.

Multiple cores are also *the* reason a scheduler exists in the interesting sense:
with more runnable tasks than cores (always true on a real system), the kernel
must decide which task runs on which core, when to move tasks between cores, and
how to balance load — the subject of [CPU Scheduling](#/scheduling).

## Devices and buses

A computer is not just a CPU and RAM. It's a motherboard full of **devices**:
your NVMe SSD, the network card (NIC), USB controllers, the GPU, the sound chip.
They connect to the CPU and memory over **buses** — shared electrical pathways
that carry data between components.

The names you'll meet:

| Bus / interface | Carries | You know it as |
|---|---|---|
| **PCIe** (PCI Express) | The main high-speed bus for internal devices | GPUs, NVMe drives, network cards plug into it |
| **NVMe** | A protocol for fast SSDs, running over PCIe | Your `/dev/nvme0n1` disk |
| **USB** | External peripherals | Keyboards, drives, webcams |
| **Ethernet / Wi-Fi** | Networking | Your NIC, `eth0` / `wlan0` |

You'll see the whole PCIe device list with `lspci`. Each device is a little
computer of its own with its own registers and often its own firmware — the
kernel's job (via **drivers**) is to speak each device's particular language.
Driver internals are [Devices, Drivers & Modules](#/devices-modules); here we
just need the physics of how CPU and device communicate at all.

### Memory-mapped I/O: talking to a device

How does the CPU, which only knows how to read and write memory addresses, tell
a disk to fetch a sector? The dominant answer is elegant: **memory-mapped I/O
(MMIO).** The device's control registers are made to *appear at memory
addresses.* When the CPU writes a value to one of those special addresses, the
write doesn't land in RAM — the hardware routes it to the device's register, and
the device reacts. Reading such an address returns the device's status.

So "tell the NIC to send this packet" becomes, concretely, "write these values
to these magic addresses." The CPU needs no new instructions to control
hardware; it reuses the load/store instructions it already has, pointed at
addresses the firmware and kernel have arranged to belong to devices rather than
RAM. (x86 also has a legacy separate "port I/O" mechanism with dedicated `in`/`out`
instructions, but MMIO is how modern high-speed devices are driven.)

### Interrupts: how a device gets attention

MMIO lets the CPU talk *to* a device. But how does a device talk *back* — how
does your NIC say "a packet arrived" or your SSD say "your data is ready"? The
CPU is busy running programs and cannot afford to constantly poll every device
asking "anything yet? anything yet?"

The answer is the **interrupt**, and it's one of the most important mechanisms in
the whole machine. Think of it as a **doorbell**. You don't stand at the front
door waiting for a delivery — you get on with your life, and when a package
arrives the courier rings the bell. You stop what you're doing, deal with it, and
go back to what you were doing.

An interrupt works exactly like that. When a device needs attention, it raises an
electrical signal. The CPU, between instructions, notices, **stops** what it was
running, saves just enough state to come back, and jumps to a special kernel
function — the **interrupt handler** — registered for that device. The handler
does the urgent bit (grab the packet, note that the disk finished), and then the
CPU resumes exactly where it left off, as if nothing happened. The interrupted
program never knew.

This is why your machine can be running Firefox at full tilt and still react
instantly to a keystroke: the keyboard rings its doorbell, the kernel's handler
runs for a few microseconds, and Firefox resumes. Interrupts are how the whole
system stays responsive without wasting the CPU on polling. The full story —
interrupt controllers, top and bottom halves, softirqs, threaded handlers — is
[Interrupts, Exceptions & Softirqs](#/interrupts). You can watch interrupts
being counted in real time in `/proc/interrupts`.

### DMA: letting devices touch RAM directly

One honest complication. If a disk has 1 MiB of data ready and the CPU had to
copy it in, one register-load at a time, through MMIO, the CPU would waste
enormous effort shuffling bytes. So fast devices use **DMA** (direct memory
access): the kernel tells the device "put your data at physical address X," and
the device — via a DMA controller — **writes directly into RAM itself**, without
the CPU copying anything. When the transfer is done, the device raises an
interrupt to say "it's in memory, go look." The CPU only sets up the transfer and
handles the completion; the bulk data movement happens behind its back. DMA is
why a modern NVMe drive or NIC can move gigabytes per second without pinning the
CPU. It also means the kernel must be careful about *which* memory a device is
allowed to scribble into — a theme that returns in [Devices, Drivers &
Modules](#/devices-modules) and in security discussions of untrusted peripherals.

## Firmware: the code that runs before Linux

When you press the power button, the CPU cannot run Linux yet — the kernel is a
file sitting on a disk the CPU doesn't even know how to read. Something has to
run first, and that something is **firmware**: code stored in a chip on the
motherboard, the very first thing the CPU executes.

On modern machines that firmware is **UEFI** (Unified Extensible Firmware
Interface; the older PC standard it replaced was called **BIOS**, and people
still say "BIOS" loosely). Its job is to bring the machine to life enough to
hand off: initialize RAM and essential hardware, run power-on self-tests, and
then locate and load a **bootloader** or the kernel itself from disk, and jump
into it. From that jump onward, the kernel is in charge and firmware steps back
(though UEFI leaves some runtime services and hardware tables — like ACPI — that
the kernel goes on to use).

That's all you need for now: firmware is the pre-Linux code that sets the table
so the kernel can be loaded and take over. The full sequence — firmware to
bootloader to kernel to PID 1 — is walked step by step in
[From Power Button to Login](#/boot-process). When that chapter opens with "UEFI
hands control to the bootloader," you'll now know exactly what that means.

## The mental model you should have now

- A **CPU** endlessly fetches, decodes, and executes dumb instructions, working
  only on values in a handful of **registers**. The **instruction pointer** says
  where it is; a jump changes it. The CPU knows nothing of processes or files.
- **RAM** is a giant numbered array of bytes. An **address** is just an index
  into it. Addresses and raw values are written in **hex**, where two digits =
  one byte; `0x1000` = 4096.
- Memory is a **hierarchy** — registers → L1/L2/L3 cache → RAM → SSD — spanning
  five orders of magnitude in speed. The kernel obsesses over cache locality
  because a miss to RAM is ~100× slower than a hit.
- **Multiple cores** run truly in parallel, which creates the shared-memory
  coordination problem that motivates locking, and the placement problem that
  motivates scheduling.
- The CPU drives devices with **memory-mapped I/O** (device registers at memory
  addresses), devices get attention via **interrupts** (the doorbell), and bulk
  data moves via **DMA** (devices writing RAM directly).
- **Firmware** (UEFI/BIOS) is the code that runs before Linux and loads it.

With this picture in your head, the rest of the book stops being abstract. When
a chapter says "the MMU translates the virtual address," or "the scheduler
migrated the task to another core and lost cache warmth," or "the NIC raised an
interrupt and DMA'd the frame into a ring buffer" — you now know what every one
of those words physically refers to.

## Try it yourself

Every command here is read-only — it inspects your machine and changes nothing.
Run them and match what you see to the concepts above.

```bash
# Your CPU: core count, threads-per-core (SMT), and the cache hierarchy sizes.
# Look for "L1d", "L1i", "L2", "L3" and "Thread(s) per core".
lscpu

# RAM, human-readable. The "total" column is your big numbered byte array.
free -h

# Block devices (disks). Find your NVMe/SSD — that's the bottom of the hierarchy.
lsblk

# The PCIe bus: every high-speed device plugged into the motherboard.
lspci | head

# Live interrupt counts, per CPU. Re-run after moving the mouse or typing —
# watch the keyboard/mouse/timer rows tick up. This is the doorbell being rung.
head -20 /proc/interrupts

# The size of one memory page, in bytes. Almost certainly 4096 (0x1000).
getconf PAGESIZE

# Convert a hex value to decimal, to check your nibble reading.
printf '%d\n' 0x1000     # -> 4096
printf '%d\n' 0xff       # -> 255
printf '%d\n' 0x7ffe1234 # a typical user-space-looking address

# Go the other way: decimal (or a size) to hex.
printf '0x%x\n' 65536    # -> 0x10000

# Your CPU's own description of itself, straight from the kernel.
grep -m1 'model name' /proc/cpuinfo
```

## Check your understanding

1. What are the three steps of the loop a CPU repeats billions of times per
   second, and what does the CPU know about "processes" or "files" while doing
   it?

<details><summary>Show answer</summary>

Fetch (read the next instruction from memory), decode (work out what it is), and
execute (do it) — then repeat. The CPU knows *nothing* about processes, files,
or users; it just executes instructions on values in registers. Processes and
files are abstractions the kernel invents on top of the raw machine.

</details>

2. Convert `0x2A` to decimal. Roughly, how many bytes does a two-hex-digit value
   represent, and why is hex used for memory instead of decimal?

<details><summary>Show answer</summary>

`0x2A` = `2×16 + 10 = 42`. Two hex digits represent exactly one byte (8 bits),
because each hex digit maps cleanly to 4 bits (a nibble). That tidy alignment —
one digit per nibble, two per byte — is why hex is the natural notation for
byte-organized memory; decimal has no such clean relationship to byte
boundaries.

</details>

3. What is the instruction pointer, and what happens to it during a normal
   instruction versus a jump?

<details><summary>Show answer</summary>

It's a register (`rip` on x86-64, `pc` on arm64) holding the memory address of
the next instruction to fetch — effectively "where the program is right now."
Normally the CPU advances it to the following instruction after each one; a jump
instruction overwrites it with a new address, so execution continues elsewhere.
Saving and restoring it is central to how the kernel switches between tasks.

</details>

4. An L1 cache hit takes ~1 ns and a trip to RAM takes ~100 ns. Why does this
   ~100× gap exist, and name one thing the kernel does because of it.

<details><summary>Show answer</summary>

Fast memory must be small and is expensive, so the machine layers a tiny fast
cache in front of large slow RAM; data the cache doesn't have costs a ~100 ns
round trip to RAM. Because of this the kernel cares about cache locality — e.g.
the scheduler prefers to keep a task on the same core to avoid a cold cache
(CPU affinity), and NUMA-aware allocation keeps memory near the core using it.

</details>

5. What problem does having more than one core create for shared memory, and
   which kernel topic exists to solve it?

<details><summary>Show answer</summary>

Two cores can read and write the same memory location simultaneously, so updates
can race and be lost, and each core's private caches can momentarily disagree
about a value. Coordinating this safely is the job of kernel synchronization —
locks, atomic operations, and memory barriers (see Kernel Synchronization).

</details>

6. Your network card just received a packet. Walk through how it gets the CPU's
   attention and how the data ends up in RAM, using the right two mechanisms.

<details><summary>Show answer</summary>

The card DMAs the packet data directly into RAM at addresses the kernel set up,
without the CPU copying it. Then it raises an **interrupt** — the doorbell — so
the CPU stops what it's running, jumps to the driver's interrupt handler to
process the arrival, and afterward resumes the interrupted program. DMA moves
the bulk data; the interrupt signals completion.

</details>

7. Why does `free -h` show sizes in GiB while your SSD is advertised as, say,
   "1 TB"? What's the unit difference?

<details><summary>Show answer</summary>

RAM tools report binary units: 1 GiB = 2³⁰ = 1,073,741,824 bytes. Storage
vendors advertise in decimal: 1 TB = 10¹² bytes. A "1 TB" disk is therefore only
about 931 GiB. Same-sounding prefixes, ~7% different values — which is exactly
why this book uses the unambiguous KiB/MiB/GiB forms for memory.

</details>

## Sources & further reading

- [lscpu(1)](https://man7.org/linux/man-pages/man1/lscpu.1.html),
  [lspci(8)](https://man7.org/linux/man-pages/man8/lspci.8.html),
  [lsblk(8)](https://man7.org/linux/man-pages/man8/lsblk.8.html) — the tools
  from *Try it yourself*, documented.
- [proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html) — including
  `/proc/cpuinfo` and `/proc/interrupts`.
- Ulrich Drepper, *What Every Programmer Should Know About Memory* (2007) — long,
  dated in specifics, still the definitive tour of caches and the memory
  hierarchy.
- "Latency Numbers Every Programmer Should Know" (Jeff Dean / Peter Norvig,
  widely reproduced) — the source of the scaling-analogy tradition used above.

---

**Next:** we take this raw machine and follow a program onto it — how source
code becomes CPU instructions, how the kernel loads and lays out a running
process in memory, and what actually happens when you type a command —
[From Source Code to Running Process](#/prereq-programs).
