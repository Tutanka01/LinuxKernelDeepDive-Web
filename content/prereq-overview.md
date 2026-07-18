---
level: core
kernel: 6.12
verified: 2026-07
minutes: 13
requires:
---

# What This Book Assumes

> **Goal:** figure out, in about ten minutes, whether you should read Part 0 at
> all — and if so, which of its chapters you actually need — before the real
> book begins with [What Is Linux, Really?](#/what-is-linux).

## Who this part is for

You can type `systemctl restart nginx` and it works. You know `docker run -d`
from `docker run -it`, you have SSH'd into a box at 3 a.m. to free up disk, you
have read a log file that told you exactly what was wrong and a dozen that
didn't. You operate Linux systems, sometimes for a living, and you are good at
it.

And yet everything *below* the command line is fog. You know `nginx` is "a
process," but not what a process is made of. You have heard "it ran out of
memory," but the memory in question is an abstraction you have never had to
open. You know a container "isolates" things, without knowing which kernel
feature does the isolating or what it means for that feature to leak. None of
this has stopped you doing your job — operational knowledge is real knowledge —
but it caps how deep you can go when something breaks in a way the runbook
didn't predict.

That is exactly who Part 0 is for. It does not teach you Linux from zero; you
are past zero. It takes the competence you already have and pours a foundation
underneath it, so that when the main book says "the scheduler picks the next
task off the runqueue" or "the page fault handler walks the page tables," those
are sentences about machinery you can picture, not incantations.

**You can skip Part 0 entirely** if you are already comfortable reading C, you
know what a CPU register is, you can say what lives inside a `.so` file, and
`0x7fff` looks like an address to you rather than a typo. If that is you, close
this chapter and start at [What Is Linux, Really?](#/what-is-linux) — Part 0
would only be telling you things you already own. The rest of this chapter helps
everyone in between decide *which* pieces they need.

## Assumed and not taught here

The whole book — Part 0 included — assumes a working relationship with a
terminal. These are the skills you must already have. Part 0 will not teach them,
and it is not the place to acquire them:

| Skill | "Good enough" looks like |
|---|---|
| Navigate a terminal | You move around with `cd`, list with `ls`, understand absolute vs relative paths, and use tab completion without thinking about it. |
| Run commands and read output | You run a command, read its output, and can tell an error message from normal output. `command --help` and exit codes are familiar. |
| Edit a text file | You can open a file in *some* editor (`nano`, `vim`, `vscode`, whatever), change a line, save, and quit. Which editor is irrelevant. |
| Basic shell plumbing (usage level) | You can *use* `|`, `>`, `>>`, and `&&` to chain and redirect. You do not need to know how the kernel implements them — that is [Pipes, FIFOs & Unix Sockets](#/ipc-pipes), later. |
| Install a package | You can install software with your distro's package manager (`apt`, `dnf`, `pacman`, …) and are not surprised when it needs `sudo`. |
| SSH to a machine | You can `ssh user@host`, and you understand you are now typing commands that run *there*, not here. |

If several of those made you wince, stop here and go get them first. That is not
a judgement — it is a sequencing decision. Trying to learn kernel internals
without terminal fluency is like studying engine design before you can drive;
the ideas will keep tripping over mechanics you haven't automated yet. A few
excellent, free resources:

- **"The Linux Command Line" by William Shotts** — a full book, free online at
  [linuxcommand.org](https://linuxcommand.org/). The most thorough of the three;
  read it cover to cover and you will be more than ready.
- **MIT's "The Missing Semester of Your CS Education"** —
  [missing.semester.mit.edu](https://missing.semester.mit.edu/). Short, dense
  lectures on the shell, editors, and the tooling real engineers use daily.
  Best if you want signal fast.
- **Linux Journey** — [linuxjourney.com](https://linuxjourney.com/). A gentle,
  interactive path from "what is a shell" upward. Good if you want structure and
  small wins.

Acquire what you're missing, then come back. The book will still be here.

## Self-assessment: which chapters do you need?

Part 0 has four content chapters. You almost certainly don't need all four. Read
each question below; every "no" or "I'm not sure" points you at the one chapter
that fixes it. Every confident "yes" is a chapter you get to skip.

| If this question stumps you… | …read this Part 0 chapter |
|---|---|
| What does the CPU actually *do* in a loop — and what is a register? | [The Machine Underneath](#/prereq-hardware) |
| What does `0x7fff` mean, and why are memory addresses written in hex? | [The Machine Underneath](#/prereq-hardware) |
| Why is reading from RAM slower than you'd think, and what is a cache? | [The Machine Underneath](#/prereq-hardware) |
| What happens between `gcc hello.c` and a program that runs? | [From Source Code to Running Process](#/prereq-programs) |
| What is inside a `.so` file, and why do programs need it at runtime? | [From Source Code to Running Process](#/prereq-programs) |
| What is a syscall, and how would you *watch* a program make one? | [From Source Code to Running Process](#/prereq-programs) |
| What is a pointer? What does `*p` versus `&x` mean? | [Just Enough C to Read the Kernel](#/prereq-c) |
| Can you read a `struct` definition and a function-pointer field? | [Just Enough C to Read the Kernel](#/prereq-c) |
| What is `man 2 read` telling you that `man read` isn't? | [Reading the Evidence](#/prereq-tools) |
| Where does `/proc` come from, and how do you look up a kernel struct? | [Reading the Evidence](#/prereq-tools) |

Answer honestly and read only the rows you failed. The point of Part 0 is to get
you to the main book *quickly*, not to make you sit through explanations of
things you already understand.

## The four chapters ahead

**[The Machine Underneath: CPU, Memory & Devices](#/prereq-hardware)** builds the
physical picture: the fetch-decode-execute loop, registers, what RAM really is
(a giant array of numbered bytes, addresses written in hex), the cache hierarchy
that makes "memory is slow" true, and how devices announce themselves through
interrupts and move bulk data with DMA. This is the ground floor. Without it the
[boot process](#/boot-process) chapter and all of [Virtual Memory](#/memory)
describe machinery you can't see — with it, "the kernel maps a page" is a
concrete event.

**[From Source Code to Running Process](#/prereq-programs)** follows one C file
from text to a live process: compilation and linking, what an ELF binary
contains, why shared libraries exist and how they load, how a running process
lays out its memory (stack, heap, code, mapped files), and your first real look
at syscalls through `strace` — including the three file descriptors (0, 1, 2)
every process is born with. This is what makes [Processes & Threads](#/processes)
and [Kernel, User Space & Syscalls](#/kernel-vs-userspace) land: they are about
the exact objects this chapter shows you being created.

**[Just Enough C to Read the Kernel](#/prereq-c)** teaches reading, not writing:
pointers, structs, function pointers, the macros the kernel leans on, the
`list_head` idiom that is everywhere, and bit flags. You will not write kernel C.
You *will* be able to read it — which is the whole point of every "Follow the
code" section in this book, where the argument is settled by pointing at the
actual source. Skip this only if C source already reads like prose to you.

**[Reading the Evidence: man, /proc & Kernel Source](#/prereq-tools)** hands you
the instruments: how `man` sections work (and why section 2 is where syscalls
live), how to interrogate a running system through `/proc` and `/sys`, the units
and notation the book uses, and how to navigate the kernel source on
[elixir.bootlin.com](https://elixir.bootlin.com/) — the tool behind nearly every
source link in these pages. Every time the book cites evidence, this chapter is
what lets you go check it yourself instead of taking the author's word.

Notice the shape: hardware and programs give you the *nouns*, C lets you *read*
the definitions, and the tools chapter lets you *verify* everything. Together
they turn the rest of the book from something you memorize into something you can
inspect.

## Where Part 0 leads

When you have read the chapters you need — which may be all four, or just one —
you are ready for the book proper. Two good doors:

- Go to [How to Use This Book: Paths & Prerequisites](#/start-here) to see the
  level badges, the `requires:` system, and the six guided reading paths, then
  pick the one that matches why you're here.
- Or go straight to [What Is Linux, Really?](#/what-is-linux), the true opening
  chapter, and let the paths find you later.

Either way, the fog is about to lift. You already know how to *operate* these
systems. From here on, you start to understand them.

## Try it yourself

No kernel to poke in this chapter — but here is a one-line litmus test for the
"assumed and not taught" skills above. Read this pipeline and, *before running
it*, say out loud what it does and why the output is what it is:

```bash
ps aux | grep -v grep | grep ssh | awk '{print $2}' | head -3
```

If you can narrate it — list every process, drop the `grep` line itself, keep
the lines mentioning `ssh`, pull out the second whitespace-separated column (the
PID), print the first three — then your shell fluency is where it needs to be,
and Part 0 is safe to skim. If any link in that chain was a mystery (not the
*kernel* mechanism of `|`, just what the pipeline *does*), start with the
external resources above, then come back. Nothing here is a race.

## Check your understanding

1. You are completely comfortable with C and you know what a CPU register is,
but you have never used `strace` and couldn't say what's inside a `.so` file.
Which Part 0 chapters should you read, and which can you skip?

<details><summary>Show answer</summary>

Read [From Source Code to Running Process](#/prereq-programs) — it covers shared
libraries (`.so` files) and your first look at syscalls via `strace`. You can
skip [Just Enough C to Read the Kernel](#/prereq-c) and the register/hardware
material in [The Machine Underneath](#/prereq-hardware). Part 0 is à la carte;
take only the rows you failed on the self-assessment.

</details>

2. A colleague says, "I'll just start with the Virtual Memory chapter, I manage
memory limits all the time." Why might that go badly, and what does the book's
structure suggest instead?

<details><summary>Show answer</summary>

Operating memory limits is not the same as understanding memory. Without the
hardware picture (addresses in hex, the cache hierarchy) from
[The Machine Underneath](#/prereq-hardware) and the process-memory layout from
[From Source Code to Running Process](#/prereq-programs), [Virtual Memory](#/memory)
will describe machinery they can't picture. The `requires:` line on each chapter
exists precisely to catch this — a confusing paragraph is usually a missing
prerequisite, not a hard concept.

</details>

3. The book will not teach you how to `cd`, use a text editor, or install a
package. What are you expected to do if you're shaky on those, and why is that
the right call rather than a brush-off?

<details><summary>Show answer</summary>

Acquire them first from an external resource (linuxcommand.org, MIT's Missing
Semester, or linuxjourney.com), then return. It's a sequencing decision, not a
judgement: learning kernel internals without terminal fluency means constantly
tripping over mechanics you haven't automated. The book assumes the operator's
toolkit so it can spend its pages on what's underneath the command line.

</details>

4. What is the single sentence that best captures who Part 0 is *not* for?

<details><summary>Show answer</summary>

Someone already comfortable reading C who knows what a register and an ELF/`.so`
file are, and for whom `0x7fff` reads as an address — they should skip Part 0
and start at [What Is Linux, Really?](#/what-is-linux). (It's also not for an
absolute beginner who can't yet use a terminal — they need the external
resources first.)

</details>

---

**Next:** the ground floor. [The Machine Underneath: CPU, Memory &
Devices](#/prereq-hardware) builds the physical picture every later chapter
quietly assumes — what the CPU does, what memory really is, and how the hardware
talks to the kernel.
