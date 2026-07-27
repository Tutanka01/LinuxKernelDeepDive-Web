---
level: core
kernel: 6.12
verified: 2026-07
minutes: 33
requires: prereq-hardware, prereq-programs
---

# Just Enough C to Read the Kernel

> **Goal:** give you exactly the C you need to *read* the kernel — signatures,
> pointers, structs, function-pointer tables, macros, and bit flags — so that
> every code snippet, struct field table, and "Follow the code" section in the
> rest of this book becomes legible. Not to make you a C programmer. To make you
> a fluent kernel reader.

The Linux kernel is roughly **40 million lines of code**, and the
overwhelming majority of it is C. This book quotes that C constantly: a struct
definition here, a five-line helper there, a table of fields lifted straight
out of `include/linux/sched.h`. If those quotes look like noise to you, half
the book is closed.

Here is the good news, and it is the whole reason this chapter exists:
**reading C is a far smaller skill than writing it.** A writer has to get the
semicolons, the memory management, the undefined behavior, and the build system
all correct. A reader only has to answer one question per line: *what is this
saying?*

You already read shell scripts and probably some Python; you will find that
most of C is boringly familiar. The genuinely new ideas are a short list —
pointers, structs, function pointers, and a handful of macros — and this
chapter is organized around exactly that list, in the order that makes each one
prepare the next.

We build directly on two earlier chapters. From
[The Machine Underneath](#/prereq-hardware) you should remember that **RAM is
one enormous array of bytes**, each with a numeric **address**, and that we
write those addresses in **hex**. From
[From Source Code to Running Process](#/prereq-programs) you should remember
that a C source file is **compiled** into machine code and that a running
process has its memory laid out into regions (text, data, heap, stack).

Those two facts are the ground everything here stands on. If either feels
shaky, go back — this chapter leans on them hard.

## The shape of C

Before the hard parts, a fast tour of the parts that are easy because they
match what you already know.

### Variables and types

Every variable in C has a **type** fixed at compile time. The type says two
things: how many bytes the variable occupies, and how to interpret them. Unlike
a shell variable (always text) or a Python variable (type attached to the
value, not the name), a C variable's type is nailed down where it's declared:

```c
int    count = 0;        // a signed integer
char   letter = 'A';     // a single byte
long   offset = 4096;    // a wider signed integer
unsigned int flags = 0;  // an integer that is never negative
```

The sizes matter because the kernel talks to hardware, where a "32-bit
register" means exactly 32 bits. On x86-64 (the `LP64` model), the plain types
have these sizes:

| Type | Bytes | Bits | Typical use |
|---|---|---|---|
| `char` | 1 | 8 | a byte, or one ASCII character |
| `short` | 2 | 16 | small counters |
| `int` | 4 | 32 | the default integer |
| `long` | 8 | 64 | pointers-sized quantities, offsets |
| `long long` | 8 | 64 | guaranteed-at-least-64-bit |

`unsigned` in front of any of these removes the sign: the same bits, but
interpreted as `0 … 2ⁿ−1` instead of a range straddling zero. This matters more
than it sounds — the pipe code in this chapter's capstone keeps its ring indices
in `unsigned int`s precisely because helpers like `pipe_occupancy()` (literally
`head - tail`) stay correct even after both counters wrap around.

A crucial warning for the reader: the sizes above are for **x86-64**. Plain
`int` is 32 bits almost everywhere, but `long` is 64 bits on 64-bit Linux and
32 bits on 32-bit systems. That portability trap is exactly why the kernel
mostly *avoids* these plain types in favor of fixed-width ones (`u32`, `u64`)
we'll meet shortly.

### Functions and how to read a signature

A C function has a **signature**: a return type, a name, and a
parenthesized list of typed parameters. Learning to read a signature word by
word is the single most useful skill in this chapter, because every "Follow the
code" trail is a chain of signatures.

Take one you already half-know — the `read()` system call:

```c
ssize_t read(int fd, void *buf, size_t count);
```

Read it strictly left to right:

- **`ssize_t`** — the return type. What `read` *gives back*: a signed size (the
  number of bytes actually read, or `-1` on error). We'll decode `ssize_t`
  precisely in the kernel-types section; for now, "a signed count."
- **`read`** — the function's name.
- **`int fd`** — first parameter: an `int` named `fd` (the file descriptor).
- **`void *buf`** — second parameter: a **pointer** (that's the `*`) named
  `buf`, pointing at memory of unspecified type (`void`). This is *where the
  bytes go*.
- **`size_t count`** — third parameter: an unsigned size named `count`. How
  many bytes to read.

That's the entire method: return type first, then name, then each parameter as
*type + name*. When a later chapter shows you
`ssize_t vfs_write(struct file *file, const char __user *buf, size_t count, loff_t *pos)`,
you now have the tools to read every token — and by the end of this chapter you
will.

### Control flow you already know

C's `if`, `else`, `while`, `for`, `return`, and `break` behave exactly as they
do in almost every language. `for (i = 0; i < n; i++)` counts from 0 to n−1.
Curly braces group statements; semicolons end them. There is nothing to learn
here. Two small things *do* differ from a scripting background and show up in
kernel code, so meet them now:

**The ternary operator** `?:` is a compact `if`/`else` that produces a value:

```c
int max = (a > b) ? a : b;   // if a > b, max = a, else max = b
```

Read `cond ? x : y` as "if cond then x else y." The kernel uses it constantly
to avoid a five-line `if`.

**`switch` fallthrough.** A `switch` jumps to the matching `case`, and — unlike
most languages — then keeps executing *into the next case* unless a `break`
stops it. This "fallthrough" is deliberate when a `case` has no `break`:

```c
switch (state) {
case A:
    do_a();
    break;        // stop here
case B:
case C:
    do_bc();      // runs for BOTH B and C (B falls through to C)
    break;
}
```

When you see stacked `case` labels with no code between them, that's
intentional sharing, not a typo.

## Pointers: the heart of the chapter

Everything above was warm-up. **Pointers are the one idea that, once it clicks,
makes kernel C readable — and until it clicks, makes it look like line noise.**
So we go slowly, with pictures.

### A variable lives at an address

Recall from [The Machine Underneath](#/prereq-hardware): RAM is a giant array
of bytes, and every byte has a numeric address. When you write `int x = 42;`,
the compiler picks a place in memory for `x` — say, address `0x7ffc1000` — and
stores the value 42 in the four bytes starting there:

```text
     address        contents
   ┌────────────┐
   │ 0x7ffc1000 │  42        ← this is x  (4 bytes: an int)
   └────────────┘
```

A **pointer is just a variable that holds an address.** Nothing more. If `x`
lives at `0x7ffc1000`, then a pointer to `x` is a variable whose *value* is the
number `0x7ffc1000`. Two operators connect a value and its address:

- **`&x`** means "the address of x" (`&` = "address-of"). Here, `&x` is
  `0x7ffc1000`.
- **`*p`** means "the value stored at the address held in p" (`*` =
  "dereference," "follow the pointer"). If `p` holds `0x7ffc1000`, then `*p`
  is `42`.

Declaring a pointer uses `*` in the type: `int *p` means "`p` is a pointer to
an int." Here is the whole dance, worked out in memory:

```c
int  x = 42;
int *p = &x;    // p holds the ADDRESS of x
int  y = *p;    // y gets the VALUE at that address: 42
*p = 99;        // write 99 THROUGH the pointer — x is now 99!
```

```text
     address        contents
   ┌────────────┐
   │ 0x7ffc1000 │  42  →  99     ← x   (*p = 99 wrote here)
   ├────────────┤
   │ 0x7ffc1008 │  0x7ffc1000    ← p  (holds the address of x)
   └────────────┘
                    │
                    └──── *p follows this arrow back to x
```

Read `*p = 99` as "store 99 at the address p points to." The pointer `p` didn't
change — it still holds `0x7ffc1000` — but the *thing it points at* did. That
indirection, writing through a pointer to change something elsewhere, is the
mechanism behind the entire kernel.

### Why C uses pointers everywhere

Two reasons, both of which you'll see on every page of this book:

1. **Passing big things cheaply.** A `struct task_struct` is several *kilobytes*
   (see [What Is Linux, Really?](#/what-is-linux)). Copying that into every
   function that touches a task would be absurd. Instead the kernel passes a
   `struct task_struct *` — an 8-byte address. The function follows the pointer
   to reach the real object. When you see `->` in kernel code (coming up), a
   pointer is being followed.
2. **Linking data structures.** A process's list of open files, the scheduler's
   run queue, the tree of memory regions — all are built by having one struct
   *hold the address of* another. Pointers are the thread that stitches the
   kernel's data structures together.

### NULL and the billion-dollar mistake

A pointer has to point *somewhere*. The special value **`NULL`** (numerically
0) means "points at nothing — deliberately invalid." Kernel code checks for it
constantly:

```c
if (p == NULL)
    return -ENOMEM;   // no memory was allocated; bail out
*p = 5;               // safe only because we checked p above
```

If code **dereferences** a NULL pointer — does `*p` when `p` is `NULL` — it
tries to read or write address 0, which is never mapped. In user space that's
the classic **segmentation fault**.

In the kernel it's a **NULL pointer dereference**, and it produces the **oops**
you met in [What Is Linux, Really?](#/what-is-linux) — the kernel prints a
backtrace and kills the offending context, often taking the machine with it.

When a later chapter says "this path must check for NULL or it's an oops," this
is precisely what it means. Tony Hoare, who invented the null reference in
1965, later called it his "billion-dollar mistake"; the kernel treats every
unchecked pointer as a potential one.

### `void *`: an address of unknown type

You saw `void *buf` in `read()`'s signature. A **`void *`** is "an address,
type unspecified" — a generic pointer that can hold the address of anything.
`read()` uses it because it doesn't care whether you're reading into an array of
chars, a struct, or a network buffer; it just needs somewhere to put bytes.

You cannot dereference a `void *` directly (the compiler doesn't know how many
bytes to read), so code casts it to a concrete pointer type first. Think of
`void *` as "a parcel with an address label but no declared contents."

### Arrays, and `char *` strings

An **array** is a run of same-typed values laid out contiguously in memory.
`int nums[4]` is four ints back to back. The name of an array, used in an
expression, *decays* into a pointer to its first element — which is why arrays
and pointers feel so intertwined in C.

Strings are the important special case. C has **no string type**. A "string" is
just an array of `char` ending in a **NUL byte** (`'\0'`, a zero byte) that
marks where it stops:

```text
   char name[6] = "cat";

   ┌───┬───┬───┬────┬───┬───┐
   │'c'│'a'│'t'│'\0'│ ? │ ? │
   └───┴───┴───┴────┴───┴───┘
     0   1   2   3    4   5      ← array indices
                 ↑
                 the NUL terminator: "the string ends here"
```

This explains a detail you already saw in
[What Is Linux, Really?](#/what-is-linux): `task_struct` has a field
`comm[16]` — the process's short name as shown by `ps`. It's a 16-*byte* array,
but it can only hold a **15-character** name, because one byte must always be
the NUL terminator. That "16 holds 15" quirk is a direct consequence of how C
strings work, and you'll see fixed-size char arrays like this all over kernel
structs.

A `char *` (pointer to char) is how strings are usually passed around: it holds
the address of the first character, and the reader walks forward until it hits
the NUL.

### Pointer arithmetic, in one paragraph

Adding to a pointer moves it by *whole elements*, not bytes: if `p` is an
`int *`, then `p + 1` is the address **4 bytes** later (one int), not one byte
later. The compiler scales by the pointed-to type's size automatically. This is
why `array[i]` is exactly equivalent to `*(array + i)` — indexing *is* pointer
arithmetic. You mostly just need to recognize it: when you see `buf + n` or
`ptr++` in kernel code, something is stepping through memory one element at a
time.

## structs: labeled boxes of fields

An `int` is one number. Real kernel objects have dozens of related pieces of
data, and a **struct** groups them into one named bundle. A struct is a box with
labeled compartments (fields), each at a known, fixed offset from the start of
the box:

```c
struct point {
    int x;    // offset 0
    int y;    // offset 4
};

struct point p;
p.x = 10;     // access a field with a dot
p.y = 20;
```

In memory, `p` is just its fields laid out in order:

```text
   ┌──────────┬──────────┐
   │  x = 10  │  y = 20  │     one struct point, 8 bytes total
   └──────────┴──────────┘
     offset 0   offset 4
```

### `.` versus `->` — and why kernel code is all arrows

There are two ways to reach a field, and the difference is the single most
common source of confusion for new kernel readers:

- **`p.x`** — when you have the struct **directly** (a value), use a dot.
- **`ptr->x`** — when you have a **pointer** to the struct, use an arrow.

`ptr->x` is pure shorthand for `(*ptr).x`: "follow the pointer, then take field
x." That's all `->` ever means: *dereference-then-access*.

Here's the payoff. Because the kernel passes everything by pointer (structs are
big, remember), kernel code lives almost entirely in **pointer-land**. You will
see `->` everywhere and `.` comparatively rarely. `task->pid`, `file->f_pos`,
`pipe->readers` — every one of those is "follow this pointer to the struct, then
read that field." Once `->` reads automatically as "the such-and-such of," you
have crossed the biggest fluency threshold in kernel C.

### Nested and embedded structs

A struct field can itself be a struct, or a pointer to one. This is how the
kernel builds its object graph:

```c
struct task_struct {
    pid_t              pid;
    struct mm_struct  *mm;      // a POINTER to the address-space struct
    struct files_struct *files; // a POINTER to the open-file table
    /* ... hundreds more fields ... */
};
```

So `task->mm->pgd` reads as "follow `task` to the task_struct, follow its `mm`
field to the mm_struct, then read *that* struct's `pgd` field." Chains of arrows
are chains of pointer-follows through the graph. You traced exactly this graph
(`task_struct → files_struct → fdtable → struct file`) in
[What Is Linux, Really?](#/what-is-linux); now you can read the C that walks it.

### How to read a kernel struct field table

This book — and the kernel's own documentation — presents big structs as
**curated field tables**. Here is `struct task_struct`, the "process" object,
shown the way the rest of the book shows it. `task_struct` really has *hundreds*
of fields spanning several kilobytes; nobody reads them all. These five carry
most of the story:

| Field | Type | What it holds |
|---|---|---|
| `pid` | `pid_t` | the task's kernel ID (what `gettid()` returns) |
| `comm[16]` | `char[16]` | the short name in `ps` — 15 chars + NUL |
| `__state` | `unsigned int` | running / sleeping / stopped / zombie |
| `mm` | `struct mm_struct *` | pointer to the address space (threads share one) |
| `files` | `struct files_struct *` | pointer to the open file-descriptor table |

Three rules for reading any such table, so you're never intimidated by the real
thing:

1. **It's curated, and that's fine.** The real
   [`struct task_struct`](https://elixir.bootlin.com/linux/v6.12/C/ident/task_struct)
   is enormous. A field table shows the handful that matter for the point being
   made. You are not missing something by not seeing all of them.
2. **Order and offset don't matter for understanding.** The table lists fields
   for clarity, not in memory order. Where a field physically sits inside the
   struct is the compiler's problem, not yours.
3. **The type column is the map.** A field whose type ends in `*` is a pointer
   to another object — follow it to the next struct. A field with a plain type
   (`pid_t`, `int`) is data that lives right there. Reading the type column
   tells you, at a glance, which fields are *data* and which are *edges to
   other structs*.

That's the entire skill. Every struct table in this book yields to those three
rules.

## typedef and the kernel's type vocabulary

A **`typedef`** gives an existing type a new name. That's the whole feature:

```c
typedef unsigned int   __u32;   // now "__u32" means "unsigned int"
typedef long           loff_t;  // "loff_t" means "long" (a file offset)
```

The kernel uses typedefs heavily to say *what a value is for*, and to pin down
exact sizes regardless of architecture. You must recognize this vocabulary,
because it appears in nearly every signature:

| Type | What it really is | Why it exists |
|---|---|---|
| `u8`, `u16`, `u32`, `u64` | unsigned integers of *exactly* 8/16/32/64 bits | hardware registers and on-disk/on-wire formats need exact widths |
| `s8` … `s64` | the signed versions | same, but signed |
| `size_t` | unsigned, pointer-sized | a **count** or size (never negative): "how many bytes" |
| `ssize_t` | signed, pointer-sized | a size **that can be −1** to signal an error (return of `read`/`write`) |
| `loff_t` | 64-bit signed | a **file offset** — 64-bit even on 32-bit systems, so files can exceed 2 GiB |
| `pid_t` | signed int | a **process/thread ID** |
| `atomic_t` | an int, accessed atomically | a counter safe to modify from multiple CPUs at once (see [Kernel Synchronization](#/kernel-sync)) |
| `bool` | true / false | a truth value (C gained a real bool type in C99) |

The reason for `u32` and friends is worth stating plainly: when the kernel lays
out a network packet header or a filesystem's on-disk structure, "32 bits"
must mean 32 bits on *every* machine, forever. Plain `int` and `long` don't
guarantee that across architectures; `u32` does. Whenever exactness matters —
and in a kernel it usually does — you'll see the fixed-width names.

## Function pointers and ops tables: THE kernel pattern

This section explains more kernel design than any other. Take your time.

You already know a function compiles to machine code that lives *somewhere* in
memory — so a function, like a variable, has an **address**. And if something
has an address, a pointer can hold it. A **function pointer** is a variable that
holds the address of a function, so you can call whatever function it currently
points at:

```c
int add(int a, int b) { return a + b; }

int (*op)(int, int);   // op: a pointer to a function taking (int,int) returning int
op = add;              // point it at add
int r = op(2, 3);      // calls add(2, 3) → 5, THROUGH the pointer
```

The declaration `int (*op)(int, int)` reads: "`op` is a pointer (`*op`) to a
function taking two ints and returning an int." You rarely have to *write*
these; you have to recognize that `op(2, 3)` calls "whatever function op points
at right now."

### A struct full of function pointers is an interface

Now combine the two big ideas — structs and function pointers. Put a bunch of
function pointers into a struct, and you have a **table of operations**: an
interface that different subsystems fill in differently. This is the kernel's
central design pattern, and its flagship example is
[`struct file_operations`](https://elixir.bootlin.com/linux/v6.12/C/ident/file_operations):

```c
struct file_operations {
    ssize_t (*read)(struct file *, char __user *, size_t, loff_t *);
    ssize_t (*write)(struct file *, const char __user *, size_t, loff_t *);
    int     (*open)(struct inode *, struct file *);
    int     (*release)(struct inode *, struct file *);
    __poll_t (*poll)(struct file *, struct poll_table_struct *);
    /* ... many more ... */
};
```

Every field is a function pointer. And here is the magic: **every filesystem
and every device driver creates its own `file_operations` and fills in its own
functions.** An ext4 file's table points `.read` at ext4's read code; a pipe's
table points `.read` at pipe read code; a socket's points somewhere else again.

That one indirection is how a *single* `read()` system call runs completely
different code depending on what you opened. The VFS layer doesn't contain a
giant `if (it's a pipe) … else if (it's ext4) …`. It just does, in effect,
`file->f_op->read(...)` — "follow the file to its operations table, and call
whatever `read` that particular object registered." (You traced this exact
dispatch through `vfs_write` in [What Is Linux, Really?](#/what-is-linux), and
you'll see it again in [Files, Filesystems & the VFS](#/filesystems) and
[Pipes, FIFOs & Unix Sockets](#/ipc-pipes).)

So when any chapter in this book says **"the driver implements `.read`"** or
**"the filesystem provides its own `file_operations`,"** this is what it means:
somewhere there is a `struct file_operations` with that driver's function
addresses plugged into it. Ops tables are how the monolithic kernel stays
modular — polymorphism, built by hand out of structs and function pointers.

## The preprocessor: text substitution before compiling

Before the compiler proper runs, a **preprocessor** rewrites the source text.
Anything starting with `#` is a preprocessor directive. You need to read four
of them.

**`#include`** pastes another file's contents in place. `#include <linux/fs.h>`
means "insert the VFS declarations here." That's how one file sees structs and
functions defined in another.

**`#define`** creates a macro — a text substitution. Two flavors:

```c
#define PIPE_DEF_BUFFERS 16          // a named constant; every PIPE_DEF_BUFFERS → 16
#define min(a, b) ((a) < (b) ? (a) : (b))   // a function-like macro
```

The constant form replaces a magic number with a readable name. The
function-like form looks like a function call but is pasted inline before
compilation. You read `min(x, y)` as "the smaller of x and y" and move on.

**`#ifdef CONFIG_*`** is why kernel source looks the way it does. The kernel is
configured with thousands of options (`CONFIG_SMP`, `CONFIG_PREEMPT`,
`CONFIG_NUMA`…), and code is conditionally *compiled in or out* based on them:

```c
#ifdef CONFIG_NUMA
    /* this code exists ONLY if NUMA support was enabled in the build */
    node = numa_node_id();
#endif
```

When you see `#ifdef CONFIG_SOMETHING`, read it as "this block is present only
in kernels built with that feature." A distro kernel and an embedded kernel are
literally *different C programs* assembled from the same tree by flipping these
switches. This is the source-level face of the modularity you read about in
[What Is Linux, Really?](#/what-is-linux).

**`likely()` / `unlikely()`** are macros you'll see wrapping conditions:

```c
if (unlikely(p == NULL))
    return -ENOMEM;
```

They don't change *what* the code does — `unlikely(x)` is just `x` — they only
hint to the compiler which branch is the common case, so it can lay out the fast
path efficiently. Read `unlikely(cond)` as simply `cond` and note "the authors
expect this to be rare (usually an error path)."

### Two idioms that demystify half the kernel: `container_of` and `list_head`

These two appear so often that recognizing them unlocks a huge amount of code.
You never need to write them; you need to know what they *mean*.

**`container_of`** solves this puzzle: given a pointer to a *field inside* a
struct, recover a pointer to the *whole* struct. Since a field sits at a known,
fixed offset from the start of its struct, you can subtract that offset and get
back to the top:

```text
   struct big {
       int          a;
       struct thing x;   ←── someone handed you a pointer to HERE (&big.x)
       int          b;
   };

   &big  ┌───────────┐
         │     a     │
         ├───────────┤ ← offset of x
   ptr → │     x     │   container_of(ptr, struct big, x)
         ├───────────┤   = ptr − (offset of x)  =  &big
         │     b     │
         └───────────┘
```

[`container_of`](https://elixir.bootlin.com/linux/v6.12/C/ident/container_of)
is a macro that does exactly that subtraction: `container_of(ptr, struct big, x)`
gives you `&big` from `&big.x`. When you see it, read "get the enclosing
struct." That's the whole idea; the macro's guts (a cast and an offset
computation) don't matter for reading.

**`struct list_head`** is why `container_of` exists. The kernel's standard
linked list is **intrusive**: instead of a list holding pointers to your
objects, you embed a small
[`struct list_head`](https://elixir.bootlin.com/linux/v6.12/C/ident/list_head)
node *inside* your struct, and the list threads through those embedded nodes:

```c
struct list_head {
    struct list_head *next;
    struct list_head *prev;
};
```

Picture three tasks chained together through a `list_head` field they each
carry:

```text
   task A                task B                task C
   ┌──────────┐          ┌──────────┐          ┌──────────┐
   │ pid, mm… │          │ pid, mm… │          │ pid, mm… │
   │ ┌──────┐ │  next    │ ┌──────┐ │  next    │ ┌──────┐ │
   │ │ node │─┼────────► │ │ node │─┼────────► │ │ node │ │
   │ │      │◄┼──────────┼─│      │◄┼──────────┼─│      │ │
   │ └──────┘ │  prev    │ └──────┘ │  prev    │ └──────┘ │
   └──────────┘          └──────────┘          └──────────┘
```

The links connect *nodes*, not whole structs. So when the kernel walks the list
and reaches a node, it uses **`container_of`** to jump from "a pointer to the
embedded `node`" back to "a pointer to the whole `task`." That is the pairing:
`list_head` embeds the links, `container_of` recovers the object.

One `list_head` type can chain *any* struct that embeds one — tasks, files,
timers, pages — which is why you'll see this exact pattern hundreds of times.
Recognize the two names together and a huge fraction of kernel data-structure
code stops being mysterious.

## Bits and flags

The kernel is obsessed with packing many yes/no answers into a single integer,
so you must read **bitwise** operators. There are five:

| Operator | Name | What it does |
|---|---|---|
| `<<` | left shift | `1 << 3` = `1000` in binary = 8; moves bits toward higher values |
| `>>` | right shift | moves bits the other way (divide-ish) |
| `\|` | bitwise OR | a bit is set in the result if set in *either* operand — used to **combine** flags |
| `&` | bitwise AND | a bit is set only if set in *both* — used to **test** a flag |
| `~` | bitwise NOT | flips every bit — used to build a mask that **clears** a flag |

A **flag** is a single bit given a name. You define each as `1` shifted into its
own bit position, so no two overlap:

```c
#define O_RDONLY    0        // (special: value 0)
#define O_WRONLY    (1 << 0) // bit 0
#define O_RDWR      (1 << 1) // bit 1
#define O_NONBLOCK  (1 << 11)// bit 11
```

Then a single `int` holds many flags at once, and three idioms manage them:

```c
int flags = O_WRONLY | O_NONBLOCK;   // SET: combine flags with OR

if (flags & O_NONBLOCK)              // TEST: AND isolates the bit;
    ...                              //  non-zero ⇒ the flag is present

flags &= ~O_NONBLOCK;                // CLEAR: AND with the inverse mask
                                     //  (~O_NONBLOCK is "all bits except bit 11")
```

Read `flags & O_NONBLOCK` as "is the O_NONBLOCK bit set in flags?" — this is by
far the most common form you'll meet. A real one, verbatim from 6.12's
`fs/pipe.c`: `is_packetized()` is literally
`return (file->f_flags & O_DIRECT) != 0;` — "does this file's flag word have the
O_DIRECT bit set?" The kernel packs booleans this way because a single 32-bit
word can carry 32 independent options, tested and combined with single CPU
instructions — far cheaper than 32 separate variables.

## The kernel's C dialect

Kernel C is ordinary C used with a distinct house style. A few conventions will
otherwise trip you up.

**`goto`-based cleanup.** In most languages `goto` is forbidden; in the kernel
it's the *idiomatic* way to handle errors, because C has no `try`/`finally`. When
a function acquires several resources and any step can fail, it jumps forward to
a cascade of cleanup labels:

```c
int do_something(void)
{
    int err;

    a = alloc_a();
    if (!a)
        return -ENOMEM;

    b = alloc_b();
    if (!b) {
        err = -ENOMEM;
        goto free_a;        // undo what we've done so far
    }

    if (setup(a, b)) {
        err = -EIO;
        goto free_b;
    }

    return 0;               // success: skip the cleanup

free_b:
    free_b(b);
free_a:
    free_a(a);
    return err;
}
```

Read it as structured unwinding: each label undoes one prior step, and later
failures fall through more labels. This is the kernel's disciplined
`try`/`finally`, and once you see the pattern it's genuinely clean — resources
are released in exactly the reverse order they were taken.

**`static`** on a function or a file-scope variable means **file-private**: it's
not visible outside this `.c` file. Most kernel helper functions are `static`;
it's the default "this is internal." (Confusingly, `static` inside a function
means something unrelated — a variable that persists across calls — but at file
scope, read it as "private to this file.")

**`inline`** asks the compiler to paste a small function's body directly into
each caller instead of making a real call, trading a little code size for speed.
Read `static inline` as "a small, file-private helper meant to be fast" — it's
extremely common for one-line accessors.

**`__user`** is an annotation on pointers: `const char __user *buf` means "this
pointer points into **user-space** memory — do not just dereference it." Kernel
code must copy such memory carefully (with `copy_from_user()`), because a
user-space address is untrusted and may be invalid. To you as a reader, `__user`
is a flag that says "this data crossed the syscall boundary." It compiles to
nothing; it exists for humans and for static checkers.

**No libc — `printk`, not `printf`.** The kernel is a freestanding program: it
does *not* link the C standard library you'd use in a normal program. So there's
no `printf`, no `malloc`, no `fopen`. The kernel has its own equivalents:
`printk()` for logging (with priority levels), `kmalloc()`/`kfree()` for memory,
and so on. When you see `printk` or `pr_info`, that's the kernel's `printf`; the
absence of familiar libc names is a feature, not a mystery.

## Capstone: reading one real kernel function

Time to prove the point. Below is a **real, unmodified function from Linux
6.12**, `fs/pipe.c` — the code that decides whether a pipe currently has
anything worth waking a blocked reader for. It is short, and by now you have
every tool to read every token:

```c
/* Done while waiting without holding the pipe lock - thus the READ_ONCE() */
static inline bool pipe_readable(const struct pipe_inode_info *pipe)
{
	unsigned int head = READ_ONCE(pipe->head);
	unsigned int tail = READ_ONCE(pipe->tail);
	unsigned int writers = READ_ONCE(pipe->writers);

	return !pipe_empty(head, tail) || !writers;
}
```

Walk it line by line:

- **The comment** tells you *why* the code is shaped the way it is: this runs
  without holding the pipe's lock, so it uses `READ_ONCE` (below). You don't
  need the locking details ([Kernel Synchronization](#/kernel-sync) covers
  them) — but notice the kernel documents intent in comments, and reading them
  pays off.
- **`static inline bool pipe_readable(...)`** — read the signature: `static`
  (file-private helper), `inline` (small and fast), returns `bool` (true/false),
  named `pipe_readable`. It answers a yes/no question, as the `bool` promises.
- **`const struct pipe_inode_info *pipe`** — one parameter: a **pointer** to a
  `struct pipe_inode_info` (the pipe object you met in
  [Pipes, FIFOs & Unix Sockets](#/ipc-pipes)), named `pipe`. The `const` says
  "this function won't modify the pipe through this pointer" — it only *reads*.
- **`unsigned int head = READ_ONCE(pipe->head);`** — declare an `unsigned int`
  named `head`, and set it to `pipe->head`. That `->` is a pointer-follow:
  "the `head` field of the struct that `pipe` points at." `READ_ONCE()` is a
  macro meaning "read this memory exactly once, right now" (it stops the
  compiler from caching or reordering the read — important precisely because no
  lock is held). Strip the macro and it's just "read `pipe->head`."
- The next two lines do the same for `tail` and `writers`: snapshot the ring's
  tail index and the count of open write ends. `head`/`tail` are the ring
  indices from the pipes chapter; `writers` is how many write ends are still
  open.
- **`return !pipe_empty(head, tail) || !writers;`** — the payoff, read piece by
  piece:
  - `pipe_empty(head, tail)` is the verified one-line helper
    `return head == tail;` — a pipe is empty when its head and tail indices
    coincide.
  - `!pipe_empty(...)` — the `!` is logical NOT, so this is "the pipe is **not**
    empty," i.e. it has data to read.
  - `!writers` — `writers` is a count; `!writers` is true exactly when the
    count is **zero** (in C, zero is false, non-zero is true, so `!0` is true).
    Zero writers means the write end is closed — end of file.
  - `A || B` — logical OR: the function returns true if **either** holds.

Put together in plain English: **a pipe is "readable" if it has data waiting, OR
if all writers have gone away (so a reader should wake up and get EOF).** That
is exactly the blocking rule stated in
[Pipes, FIFOs & Unix Sockets](#/ipc-pipes) — and you just read it directly out
of the kernel source, every symbol accounted for. That is the entire goal of
this chapter, demonstrated.

(Its mirror image, `pipe_writable`, is the same shape with
`!pipe_full(head, tail, max_usage) || !READ_ONCE(pipe->readers)` — "writable if
there's room, or if all readers are gone." You can now read that one unaided.)

## Try it yourself

You don't need to write kernel code to make these ideas concrete. A tiny
user-space C program exercises a struct, a pointer, and a function pointer — the
same three ideas — and you can compile and run it in seconds.

```bash
# 1. Write a small program: a struct, a pointer to it, and an ops table.
cat > /tmp/readc.c <<'EOF'
#include <stdio.h>

/* A struct: a labeled box of fields (like a mini task_struct). */
struct task {
    int  pid;
    char comm[16];      /* 15 chars + NUL, exactly like the real one */
};

/* Two functions with the SAME signature, so one pointer can hold either. */
int by_pid(struct task *t)  { return t->pid; }
int name_len(struct task *t){ int n=0; while (t->comm[n]) n++; return n; }

int main(void) {
    struct task job = { .pid = 4242, .comm = "compiler" };
    struct task *p = &job;          /* p holds the ADDRESS of job     */

    printf("pid via dot   : %d\n", job.pid);   /* have the struct: .  */
    printf("pid via arrow : %d\n", p->pid);    /* have a pointer: ->  */
    printf("comm          : %s\n", p->comm);

    /* A function pointer: a variable holding a function's address.    */
    int (*op)(struct task *) = by_pid;         /* point it at by_pid   */
    printf("op(job)       : %d\n", op(p));     /* calls by_pid(p)      */
    op = name_len;                             /* re-point the SAME var*/
    printf("op(job)       : %d\n", op(p));     /* now calls name_len   */
    return 0;
}
EOF

# 2. Compile it (this is the source -> machine code step from prereq-programs).
gcc -Wall -o /tmp/readc /tmp/readc.c

# 3. Run it. Watch . vs -> give the same field, and one op variable
#    call two different functions -- exactly the file_operations idea.
/tmp/readc

# 4. See hex and bit flags for real. printf understands %x (hex):
printf 'O_WRONLY|O_NONBLOCK = %d = 0x%x\n' $((1<<0 | 1<<11)) $((1<<0 | 1<<11))
printf 'testing bit 11     : %d\n' $(( (2049 & (1<<11)) != 0 ))

# 5. Finally, just LOOK at real kernel source. Open this page and read the
#    pipe_readable function you dissected above -- every token should now parse:
#    https://elixir.bootlin.com/linux/v6.12/C/ident/pipe_read
```

That last step is the habit this whole chapter is training. The next chapter,
[Reading the Evidence: man, /proc & Kernel Source](#/prereq-tools), turns it
into a workflow: how to look up any function, struct, or syscall the moment you
meet it.

## Check your understanding

1. Read this signature aloud, token by token:
   `ssize_t write(int fd, const void *buf, size_t count)`. What does each part
   tell you?

<details><summary>Show answer</summary>

`ssize_t` is the return type — a signed size, so it can return the byte count
written or `-1` on error. `write` is the name. `int fd` is the first parameter,
an integer file descriptor. `const void *buf` is a pointer (the `*`) to memory
of unspecified type (`void`) that will not be modified (`const`) — the source
bytes. `size_t count` is an unsigned size — how many bytes to write.

</details>

2. `int x = 5; int *p = &x; *p = 9;`. What is `x` afterward, and why?

<details><summary>Show answer</summary>

`x` is `9`. `&x` is the address of `x`, stored in `p`. `*p = 9` means "store 9
at the address `p` holds" — which is `x`'s address. Writing *through* the
pointer changes the thing pointed at. `p` itself (the address) never changed.

</details>

3. Kernel code is full of `->` and rarely uses `.`. Why? What does
   `task->files` mean?

<details><summary>Show answer</summary>

Because the kernel passes big structs by pointer (an 8-byte address) rather than
copying them, so code almost always holds *pointers* to structs, not structs
directly. `->` is the pointer version of field access: `task->files` means
"follow the pointer `task` to its struct, then read the `files` field" — exactly
`(*task).files`. `.` is only for when you hold the struct value itself.

</details>

4. What is a `struct file_operations`, and how does it let one `read()` syscall
   run different code for a pipe versus an ext4 file?

<details><summary>Show answer</summary>

It's a struct whose fields are **function pointers** (`.read`, `.write`,
`.open`, …) — an interface. Each filesystem and driver creates its own instance
and fills in its own functions. The VFS calls `file->f_op->read(...)` — "follow
the file to its ops table and call whatever `read` that object registered" — so
a pipe's table points at pipe-read code and ext4's points at ext4-read code. One
call site, many implementations: polymorphism built from a struct of function
pointers.

</details>

5. A file's flags are in `f_flags`. Write, in words, what
   `if (f_flags & O_NONBLOCK)` tests, and what `f_flags &= ~O_NONBLOCK` does.

<details><summary>Show answer</summary>

`f_flags & O_NONBLOCK` isolates the single O_NONBLOCK bit with bitwise AND; the
result is non-zero (true) exactly when that flag is set — so the `if` runs "if
the file is in non-blocking mode." `~O_NONBLOCK` is a mask with every bit set
*except* that one; `f_flags &= ~O_NONBLOCK` ANDs it in, clearing the O_NONBLOCK
bit while leaving all other flags untouched.

</details>

6. The kernel embeds a `struct list_head` inside objects and uses
   `container_of` when walking the list. Explain the pairing: what does each
   half do?

<details><summary>Show answer</summary>

The kernel's lists are **intrusive**: the `list_head` node lives *inside* your
struct, and the `next`/`prev` links chain the embedded nodes, not the whole
objects. So when a walk lands on a node, it has a pointer to the *field*, not
the object. `container_of(node_ptr, struct task, node)` subtracts the field's
known offset to recover a pointer to the *enclosing* struct. `list_head`
provides the links; `container_of` gets you back from a link to the object that
carries it. One `list_head` type can therefore chain any struct that embeds one.

</details>

## Sources & further reading

- [The C standard library reference — cppreference](https://en.cppreference.com/w/c) —
  authoritative, if terse, on the language itself.
- [How to read the Linux kernel source — kernel docs](https://docs.kernel.org/process/howto.html) —
  the maintainers' own orientation for newcomers.
- [`data_structures` — Linux kernel docs](https://docs.kernel.org/core-api/kernel-api.html) —
  reference for `list_head`, `container_of`, and the intrusive-list API.
- [`task_struct` on Elixir (v6.12)](https://elixir.bootlin.com/linux/v6.12/C/ident/task_struct)
  and [`file_operations`](https://elixir.bootlin.com/linux/v6.12/C/ident/file_operations) —
  browse the real structs whose field tables you now know how to read.
- [`fs/pipe.c` on Elixir (v6.12)](https://elixir.bootlin.com/linux/v6.12/C/ident/pipe_read) —
  the file the capstone `pipe_readable` comes from; a short, readable first
  source file.

---

**Next:** you can now read the code — the last prerequisite is knowing where to
*find* it and how to interrogate a running system.
[Reading the Evidence: man, /proc & Kernel Source](#/prereq-tools) turns
"look it up" into a repeatable workflow, and closes Part 0.
