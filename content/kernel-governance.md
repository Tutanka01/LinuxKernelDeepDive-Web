# How the Kernel Is Made: Process, Governance & Culture

> **Goal:** understand how the largest collaborative software project in
> history actually works — the people, the process, the mailing lists, the
> merge window, the stable/LTS release model, and the unwritten rules that
> define Linux kernel development culture.

## The scale, in numbers

Before the process, the scale:

- **~40 million lines** of code (C, assembly, Rust, Makefiles, scripts).
- **~15,000 individual contributors** per release (kernel 6.x era).
- **~2,000 companies** appear in `Signed-off-by` lines.
- A new release every **9–10 weeks** without fail, since 2005 (git era).
- ~3,500 patches accepted per week during the merge window.
- ~400 subsystems, each with at least one maintainer.
- **1 person** makes the final decision: Linus Torvalds.

The kernel is not governed by a foundation (unlike Python/Go/Kubernetes).
It's governed by **maintainer hierarchy** — a human chain of trust where
each maintainer decides what enters their subsystem, and Linus decides what
enters mainline.

## The release cycle: merge window + stabilization

The kernel follows a strict two-week-merge, seven-week-stabilize cadence:

```text
Week 1-2:  MERGE WINDOW — Linus accepts pull requests from subsystem
           maintainers. All new features land here. ~12,000 patches.
           Linus releases -rc1 at the end.

Week 3-9:  STABILIZATION — one -rc release per week (rc2, rc3... rc7).
           Only bug fixes, documentation, and small cleanups accepted.
           -rc7 is usually the last; occasionally -rc8 if regressions.

Week 10:   FINAL RELEASE — Linus tags v6.X and the cycle restarts.
```

If a patch misses the merge window, it waits ~10 weeks for the next one.
The rhythm is relentless — the kernel hasn't missed a release since 2005.

The cycle is visible live:

```bash
git log --oneline v6.8..v6.9 --merges | wc -l  # pull requests accepted
git log --oneline v6.9-rc1..v6.9 | wc -l        # total patches in a release
```

### Stable and LTS kernels

After each mainline release, the **stable team** (Greg Kroah-Hartman and
Sasha Levin) maintains a parallel track:

- **Stable kernels** — v6.9.1, v6.9.2, … receive bug fixes backported from
  mainline for the life of that series (~3 months, until the next mainline).
- **LTS (Long-Term Support)** — designated versions supported for 2, 4, or
  6 years. Current LTS: 6.6, 6.12. Used by Android, embedded, enterprise
  distros.

```bash
# See your kernel's stream:
uname -r                 # 6.8.0-52-generic = stable (distro's version)
git tag -l "v6.6*"       # LTS 6.6: v6.6, v6.6.1, v6.6.2...
```

**Stable rules are strict:** patches must be in mainline first (no
"stable-only" fixes), must be small and obvious, must fix a real bug, and
must have a proper `Cc: stable@vger.kernel.org` tag or `Fixes:` tag linking
to the commit that introduced the bug.

### Kernel security

Security fixes follow a different path. The **security team**
(`security@kernel.org`) handles embargoed vulnerabilities. Once fixed,
the patch is fast-tracked to stable. The kernel doesn't do CVE numbering
itself (the CVE system is external). The philosophy: fix the bug, ship
the fix, coordinate disclosure — no marketing.

## The chain of trust: maintainer hierarchy

The kernel is organized as a tree of git repositories:

```text
Linus Torvalds  —  torvalds/linux.git  (mainline)
  │
  ├── Greg KH      — stable, driver core, USB
  ├── Andrew Morton — mm tree (memory management patches land here)
  ├── David Miller — networking
  ├── Jens Axboe   — block layer, io_uring
  ├── Christian Brauner — VFS, mounts
  ├── Tejun Heo     — cgroups, workqueues
  ├── Ingo Molnar   — scheduler, locking
  ├── Thomas Gleixner — timers, x86, interrupt handling
  ├── ...
  └── ~400 subsystem maintainers
        └── reviewers, sub-maintainers
```

A patch's journey:
1. Developer writes patch, runs `scripts/checkpatch.pl`, sends to the
   appropriate mailing list + maintainer (via `scripts/get_maintainer.pl`).
2. Reviewers comment on the list. Developer revises. Repeat.
3. Maintainer applies the patch to their subsystem tree.
4. During the merge window, maintainer sends a **pull request** (a signed git
   tag) to Linus.
5. Linus pulls, merges, and (if it passes his review) the code is in mainline.

The point of no return: once Linus pulls a change, it cannot be reverted
except by an emergency fix in the -rc cycle. "Don't break userspace" means
— among other things — once an API ships, it stays forever.

### The merge window ritual

The two weeks before the merge window, subsystem trees are in `linux-next`
(a daily integration tree maintained by Stephen Rothwell). This catches merge
conflicts between subsystems *before* they hit Linus's tree. During the merge
window:
- Linus reviews every pull request message. He will NAK changes that lack
  justification, break existing systems, or add complexity without value.
- Famous Linus NAK quotes are part of kernel culture ("WE DO NOT BREAK
  USERSPACE!" is real, capitalized, and immutable).

## How patches become kernel law

A patch is a raw email with inline diff:

```text
From: Developer <dev@example.com>
Subject: [PATCH] fs/ext4: fix use-after-free in extent status tree

The extent status tree can race with truncate under heavy writeback load.
Fixes: a1b2c3d4 ("ext4: add extent status tree")
Signed-off-by: Developer <dev@example.com>
---
 fs/ext4/extents_status.c | 4 ++++
 1 file changed, 4 insertions(+)
```

The tags that matter:

| Tag | Meaning |
|---|---|
| `Signed-off-by` | "I wrote this, or I'm passing it upstream, and I have the right to contribute it" (Developer Certificate of Origin). Mandatory. |
| `Reviewed-by` | A reviewer has looked at it and approves. |
| `Acked-by` | A maintainer or domain expert approves (may not be the direct maintainer). |
| `Tested-by` | Someone tested it and it works. |
| `Reported-by` | Credits the bug reporter. |
| `Fixes: <commit>` | Identifies which commit introduced the bug. Critical for stable backports. |
| `Cc: stable@vger.kernel.org` | Mark this for stable kernel inclusion. |

The `Signed-off-by` chain traces the patch from author to Linus:

```text
Signed-off-by: Developer <dev@example.com>
Signed-off-by: Ext4 Maintainer <ext4@kernel.org>
Signed-off-by: Linus Torvalds <torvalds@...>
```

In a single release, this chain might have 8-10 links for a patch originating
from a driver vendor.

## The testing infrastructure (the invisible machinery)

The kernel's quality doesn't come from Linus's review — it comes from
automated testing at scale:

| System | What it does |
|---|---|
| **0-day / Kernel Test Robot** (Intel) | Builds and boots every patch on hundreds of configs/architectures, reports build failures and boot regressions within hours. Tests >200 trees. |
| **syzbot** (Google) | The kernel fuzzer: continuously generates random syscall sequences looking for crashes, use-after-frees, and kernel panics. Files ~500 bugs/month. Reports are public and tracked. |
| **KernelCI** | Builds and boots mainline + stable + next on real hardware across arm, arm64, x86, riscv. |
| **CKI** (Red Hat) | Enterprise-oriented testing of stable and RHEL kernels. |
| **Linaro / ARM testing** | ARM ecosystem hardware testing. |
| **linux-next** integration | Catches subsystem merge conflicts before the merge window. |

A random example of the scale: syzbot has found over 7,600 bugs since 2017,
and roughly half have been fixed. The kernel development model works because
automated testing catches what humans can't, *and* because maintainers act on
reports.

```bash
# The syzbot dashboard:
# syzkaller.appspot.com/upstream  ← real-time, public bug tracking
git log --grep="syzbot" --oneline | wc -l  # patches fixing syzbot-found bugs
```

## The culture: unwritten rules

### "Don't break userspace"

The cardinal rule. If your kernel upgrade breaks a working program, the kernel
is at fault — even if the program was doing something "wrong" by the spec.
Linus' famous rant from 2012 after a `-rc` broke `pulseaudio`:
> "We do not break userspace. The whole *point* of the kernel is to run
> userspace. If we break userspace, we are a BUG."
This is why `uname` gives back-compat info, why `/proc` entries never move,
and why ioctl numbers are permanent.

### "No regressions"

A new kernel must work at least as well as the old kernel on all hardware.
If a Wi-Fi driver works on 6.9 and breaks on 6.10, that's a regression bug
and it blocks the release.

### "Show me the code"

Ideas without patches are worth little. Kernel development is
patch-driven — discussions happen around *proposed changes*, not abstract
design documents. This is simultaneously productive (concrete, testable)
and exclusionary (you must know C well enough to write a working patch to
participate meaningfully).

### "Performance matters; latency is sacred"

The merge window is the time for adding features. The -rc cycle is for
ensuring none of them regressed performance. The kernel carries an enormous
burden: every change must not slow down the millions of systems already
running. The `perf` and latency measurement infrastructure exists because
regressions here are treated as seriously as crashes.

### Linus as benevolent dictator

Linus' role: final arbiter of taste, complexity, and the kernel's design
direction. He doesn't review most patches (impossible at scale) — but he
sets the standards through his rejections, his merge messages, and the
culture he's built over 30+ years. His LKML posts are public, archived, and
worth reading — they're the kernel's constitutional debates.

## Comparison: Linux vs other kernels

Understanding what makes Linux *Linux* requires seeing what other kernels
do differently:

| Dimension | Linux | FreeBSD | Windows NT | XNU (macOS/iOS) |
|---|---|---|---|---|
| **Architecture** | Monolithic + loadable modules | Monolithic + modules (kld) | Hybrid (kernel + user-space services) | Hybrid (Mach microkernel + BSD kernel) |
| **Governance** | Linus + maintainer hierarchy | Core Team election | Microsoft (single company) | Apple (single company, partially open) |
| **Release model** | Time-based (~10 weeks), stable/LTS | Time-based + stable branches | Feature updates ~biannual | Tied to OS releases |
| **Driver model** | In-tree preferred, stable API not guaranteed | In-tree, stable KPI | Stable driver API (WHQL) | In-tree, limited third-party (DriverKit) |
| **License** | GPLv2 | BSD 2-clause | Proprietary | APSL + proprietary |
| **Philosophy** | "We don't break userspace" | "Principle of least astonishment" | "Backward compatibility at all costs" | "Security + performance for Apple hardware" |
| **Rust support** | In progress (6.1+) | No (exploratory) | Yes (kernel-mode Rust drivers) | No |
| **Key strength** | Hardware support, flexibility, ecosystem | Stability, ZFS, network stack | Driver compatibility, enterprise integration | Power efficiency, security model |
| **Key weakness** | Driver quality variance, monolithic risk | Smaller ecosystem, less corporate backing | Closed source, slower innovation | Closed source, limited to Apple hardware |

Why Linux won servers and Android: open source + GPLv2 forced contributions
back (you can't ship a modified kernel without releasing source), creating a
virtuous cycle of hardware support. FreeBSD's permissive license meant
companies (Sony, Netflix, WhatsApp) contributed less back. Windows NT won
desktop enterprise through backward compatibility. XNU won mobile through
vertical integration.

## The mailing list is the town square

Almost everything happens on email:

- **LKML** (linux-kernel@vger.kernel.org) — the high-traffic main list.
  Too much for one human. Subsystem lists are where real work happens.
- **Subsystem lists** — `linux-mm@`, `linux-fsdevel@`, `netdev@`, `linux-btrfs@`...
  Each has its own conventions, its own regulars.
- **lore.kernel.org** — public archive of every list, with threads,
  search, and downloadable mbox.
- **patchwork.kernel.org** — patch tracking, shows what's pending, accepted,
  or rejected per subsystem.

How to follow along without drowning:
- `lwn.net` (Linux Weekly News) — the weekly kernel development summary.
  Subscribe. It's the single best English-language source.
- `kernelnewbies.org/LinuxChanges` — human-readable summaries of each release.

## Check your understanding

1. Why does a patch that misses the merge window have to wait 10 weeks?
2. What's the difference between a stable kernel and an LTS kernel?
3. Why does the kernel have a "no regressions" rule — what would happen
   without it?
4. "Don't break userspace" means a kernel upgrade must still run programs
   compiled in 2005. What practical consequences does this have for kernel
   developers?
5. What's the significance of `Signed-off-by` chains in a kernel commit?

*(Answers: the merge window is the only time new features are accepted —
outside it, only bug fixes enter, so a patch that's "new work" rather than
"fix" must wait for the next cycle 7-8 weeks of stabilization + 2 weeks until
the next merge window opens; stable is the short-term bug-fix stream for
current releases (~3 months), LTS is a designated long-term release supported
for 2-6 years with backported fixes — essential for Android, embedded systems,
and enterprise distros that can't reboot onto a new kernel every 10 weeks;
without it, upgrading the kernel would risk breaking production workloads on
unknown hardware/driver combinations — no one would upgrade, the kernel would
fragment into frozen versions, and the continuous testing infrastructure would
lose relevance; kernel developers can never remove or rename a syscall,
/proc file, or ioctl number — they can only add new ones, wrap the old one
in a compatibility shim, or wait until literally zero users exist (which
takes decades) — this is why Linux has ~450 syscalls and almost no removals;
it's the chain of legal and review custody — each person who handles the
patch signs it, tracing it from original author through subsystem maintainers
to Linus, establishing provenance and confirming Developer Certificate of
Origin compliance.)*

---

**Next:** you've learned every subsystem in isolation. Now we consolidate everything into a systematic performance methodology — USE, RED, the 60-second checklist, flame graphs, and the investigation pattern that finds what's slow in five minutes or less.
