---
level: internals
kernel: 6.12
verified: 2026-07
minutes: 23
requires: gpu-checkpoint, lab-criu, criu-dump, criu-restore
---

# Lab: Checkpoint a CUDA Process

> **Goal:** turn the measurement protocol sketched in [GPU
> Checkpointing](#/gpu-checkpoint) into something you actually run and record.
> You will establish a GPU-free baseline, watch stock CRIU refuse a process
> holding a device it does not understand, drive `cuda-checkpoint`'s state
> machine by hand and watch a CUDA process become an ordinary Linux process in
> `/proc`, then — if you have the hardware — walk the unified-memory frontier
> where no public numbers exist at all. You finish with a filled-in results
> table that is publishable, because nobody has published one.

[GPU Checkpointing](#/gpu-checkpoint) ends on an unusual note for a course
chapter: it tells you that whoever runs its protocol carefully and publishes
the numbers is doing original work, because the public record is empty. This
lab is that protocol, made executable.

It is also the only lab in this course that most readers cannot finish, and
pretending otherwise would waste your afternoon. So it is built in **three
tiers**, and each one is complete on its own:

| Tier | Hardware | What you get |
|---|---|---|
| **1** | Any Linux box or VM | The baseline numbers, and CRIU refusing a device it cannot serialize |
| **2** | An NVIDIA GPU, driver r555+ | The full `cuda-checkpoint` round trip and a CRIT autopsy of the images |
| **3** | Unified memory (GB10 / Grace-Blackwell / Jetson) | An experiment whose outcome is genuinely unknown |

Do Tier 1 even if you own the hardware for Tier 3. Every number in Tier 2 and
Tier 3 is only meaningful against a baseline, and the baseline is the thing
people skip.

## Read this before you touch Tier 2 or 3

The chapter's constraint list is not advice, and two items on it will bite you
here:

- **UVM Managed Memory is documented as unsupported** by `cuda-checkpoint`, as
  are MIG and MPS. In Tier 3 you are deliberately poking at that boundary. **An
  error is a valid result** — in fact it is the most likely one. Record it and
  stop; do not escalate.
- **Use a disposable worker.** A process whose death costs you nothing: no
  irreplaceable state, no shared job, nobody else's inference server. If a
  transition fails halfway, the process can be left `locked` or
  `checkpointed`, holding a GPU and refusing to make progress.

The recovery sequence, which you should read now rather than at the moment you
need it:

```bash
cuda-checkpoint --get-state --pid "$PID"
# running       → nothing to do
# locked        → cuda-checkpoint --action unlock  --pid "$PID"
# checkpointed  → cuda-checkpoint --action restore --pid "$PID"
#                 then             --action unlock  --pid "$PID"
```

A `checkpointed` process needs **both** verbs, in that order. Skipping the
`unlock` leaves an application whose CUDA calls block forever, which looks
exactly like a hang and is not one.

---

## Tier 1 — the baseline, on any machine

### What you need

CRIU and CRIT, as in [Lab: Checkpoint & Restore a Real
Process](#/lab-criu) — that lab is the prerequisite, and if you have not done
it, do it first. This tier assumes you already know what `pages-1.img` and
`pagemap-<pid>.img` are.

```bash
criu --version
crit --version
sudo criu check
```

### 1a. Measure an ordinary checkpoint

The point is not the checkpoint — you did that already. The point is to learn
what *your* machine's numbers look like, so that a GPU number later means
something.

Start a process that owns a known, sizeable amount of anonymous memory:

```bash
python3 - <<'EOF' &
import time
buf = bytearray(512 * 1024 * 1024)      # 512 MiB, touched below
for i in range(0, len(buf), 4096):
    buf[i] = 0xA5                        # fault every page in
n = 0
while True:
    n += 1
    print("tick", n, flush=True)
    time.sleep(1)
EOF
PID=$!
```

Record the shape of its address space before you touch it, so you have
something to diff against later:

```bash
grep -E 'rw-p|rw-s' /proc/$PID/maps | head -20 > maps.baseline
ls -l /proc/$PID/fd | wc -l
```

Now dump it, timed, and measure what came out:

```bash
mkdir -p ~/ckpt-baseline
/usr/bin/time -v sudo criu dump -t "$PID" -D ~/ckpt-baseline --shell-job --leave-running 2> dump.time
du -sh ~/ckpt-baseline
ls -lh ~/ckpt-baseline/pages-*.img ~/ckpt-baseline/pagemap-*.img
grep -E 'Elapsed|Maximum resident' dump.time
```

Then restore it, timed:

```bash
kill "$PID"
/usr/bin/time -v sudo criu restore -D ~/ckpt-baseline --shell-job 2> restore.time
grep Elapsed restore.time
```

Write down four numbers: **dump wall time**, **total image size**, **`pages-*.img`
size**, **restore wall time**. On a 512 MiB working set the image is dominated
by the pages, and the restore is dominated by writing them back. That
proportion is the thing you are going to watch change.

### 1b. Watch CRIU refuse a device

This is the part that matters, and it costs thirty seconds. Hold an fd on a
device CRIU does not have a plugin for. Any of these will do — pick one that
exists on your machine:

```bash
ls /dev/dri/renderD* /dev/kvm 2>/dev/null
```

```bash
sh -c 'exec 3< /dev/dri/renderD128; while :; do sleep 1; done' &
DEVPID=$!
ls -l /proc/$DEVPID/fd | grep -E 'dri|kvm'
```

Now ask CRIU to dump it:

```bash
mkdir -p ~/ckpt-device
sudo criu dump -t "$DEVPID" -D ~/ckpt-device --shell-job
echo "exit status: $?"
```

It fails. The exact wording varies with the CRIU version — what you are looking
for is a complaint about an *unsupported* or *unknown* file behind that
descriptor, and a non-zero exit. Read the log CRIU leaves in the images
directory:

```bash
grep -iE 'unsupported|unknown|fd|dri' ~/ckpt-device/dump.log | head
```

Clean up:

```bash
kill "$DEVPID"
```

### What just happened

CRIU walked `/proc/<pid>/fd`, met a descriptor whose backing file it has no
serialization strategy for, and **refused rather than guessed**. That refusal is
the correct behaviour and the entire premise of
[GPU Checkpointing](#/gpu-checkpoint): the fd is a *handle*, and everything it
stands for lives on the far side of an `ioctl()` boundary CRIU cannot cross.
The chapter's argument that a CUDA process is architecturally
un-checkpointable is not an abstraction — you just watched a much simpler
version of it, on hardware you own.

You also now know what CRIU's refusal *looks like*, which means in Tier 2 you
will be able to tell "the plugin is not installed" apart from "the plugin ran
and something else went wrong".

---

## Tier 2 — the round trip, on an NVIDIA GPU

### The gate

Three things must be true, and checking them takes less time than debugging
their absence:

```bash
nvidia-smi --query-gpu=name,driver_version --format=csv
cuda-checkpoint --help 2>&1 | head
sudo criu check
```

**Do not take the driver version from this page.** [GPU
Checkpointing](#/gpu-checkpoint) records the matrix as of 2026-07 — r550 for
the base feature, r555+ for the CRIU integration, 570 splitting `lock` into its
own verb, 580 adding GPU migration, 595 adding aarch64 binaries, 610 adding
CUDA IPC support — and that matrix moves faster than any prose about it. Open
the [cuda-checkpoint README](https://github.com/NVIDIA/cuda-checkpoint) and
check yours against it now. If your driver predates the CRIU integration, you
can still do everything up to the integrated path by driving the utility by
hand.

For the integrated path you also need the CRIU **CUDA plugin** built and
installed; `criu check` output and the plugin's own README are the authority on
whether it is being found.

### 2a. A disposable workload

Small, obviously-stateful, and holding enough device memory that the numbers
are not noise:

```cuda
// ckpt-victim.cu — a disposable CUDA workload with checkable state.
#include <cstdio>
#include <unistd.h>

__global__ void bump(int *counter) { (*counter)++; }

int main() {
    int  *counter = nullptr;
    void *ballast = nullptr;

    cudaMalloc(&counter, sizeof(int));
    cudaMemset(counter, 0, sizeof(int));

    // Enough device memory that the checkpoint has real bytes to move.
    cudaMalloc(&ballast, 512u << 20);          // 512 MiB
    cudaMemset(ballast, 0xA5, 512u << 20);

    for (;;) {
        bump<<<1, 1>>>(counter);
        cudaDeviceSynchronize();

        int host = 0;
        cudaMemcpy(&host, counter, sizeof(int), cudaMemcpyDeviceToHost);
        printf("counter=%d\n", host);
        fflush(stdout);
        sleep(1);
    }
}
```

```bash
nvcc -o ckpt-victim ckpt-victim.cu
./ckpt-victim &
PID=$!
```

The counter lives in **device** memory and is read back every second. If it
survives a checkpoint and resumes from where it stopped, the device state
genuinely came back — a host-side counter would prove nothing.

### 2b. Capture the "before" picture

Take these now; they are half the lab's evidence:

```bash
ls -l /proc/$PID/fd | grep nvidia            > fd.before
grep -E 'nvidia|^[0-9a-f]+-[0-9a-f]+ ---p' /proc/$PID/maps > maps.before
grep VmRSS /proc/$PID/status                 > rss.before
nvidia-smi --query-compute-apps=pid,used_memory --format=csv > smi.before
cuda-checkpoint --get-state --pid "$PID"     # expect: running
```

You should see the five-ish `/dev/nvidia*` descriptors and the `rw-s` device
mappings that [GPU Checkpointing](#/gpu-checkpoint) walks through. This is the
state the rest of the lab is about to make disappear.

### 2c. Drive the state machine by hand

One verb at a time, because the interesting failures happen *between* verbs:

```bash
cuda-checkpoint --get-restore-tid --pid "$PID"
cuda-checkpoint --action lock       --pid "$PID" --timeout 10000
cuda-checkpoint --get-state         --pid "$PID"      # expect: locked
```

The process is now quiesced but **still runnable** — that distinction is the
whole reason the CRIU plugin runs `lock` from `PAUSE_DEVICES`, before the
freeze. Note that the shell's `counter=` output has stopped.

```bash
/usr/bin/time -v cuda-checkpoint --action checkpoint --pid "$PID" 2> ckpt.time
cuda-checkpoint --get-state --pid "$PID"              # expect: checkpointed
```

Now take the "after" picture, and diff it. This is the payoff of the tier:

```bash
ls -l /proc/$PID/fd | grep nvidia            > fd.after
grep -E 'nvidia|^[0-9a-f]+-[0-9a-f]+ ---p' /proc/$PID/maps > maps.after
grep VmRSS /proc/$PID/status                 > rss.after
nvidia-smi --query-compute-apps=pid,used_memory --format=csv > smi.after

diff fd.before fd.after
diff maps.before maps.after
paste rss.before rss.after
```

Three things should be visible, and each one is a claim from the chapter made
concrete: the `/dev/nvidia*` **device mappings are gone**, the process's
**RSS has grown by roughly the device allocation** because those bytes are now
ordinary host pages, and `nvidia-smi` **no longer attributes GPU memory** to
this PID. The process has stopped being a GPU process at the OS level. Record
the RSS delta and the `checkpoint` wall time.

Then reverse it and confirm the counter resumes rather than restarts:

```bash
/usr/bin/time -v cuda-checkpoint --action restore --pid "$PID" 2> restore-gpu.time
cuda-checkpoint --action unlock --pid "$PID"
cuda-checkpoint --get-state     --pid "$PID"          # expect: running
```

### 2d. The integrated path

Restart the workload fresh — do not reuse a process you have already toggled by
hand — and let CRIU and the plugin do the dance:

```bash
./ckpt-victim & PID=$!
sleep 5
mkdir -p ~/ckpt-cuda
/usr/bin/time -v sudo criu dump -t "$PID" -D ~/ckpt-cuda --shell-job 2> cuda-dump.time
du -sh ~/ckpt-cuda
ls -lh ~/ckpt-cuda/pages-*.img ~/ckpt-cuda/pagemap-*.img
```

Autopsy the images with the tool from [Lab: Checkpoint & Restore a Real
Process](#/lab-criu):

```bash
crit decode -i ~/ckpt-cuda/pagemap-$PID.img --pretty | head -60
```

The question worth answering here, and the reason the chapter asks for a CRIT
autopsy: **where did the device bytes land?** The CUDA plugin does not write a
weight-sized image of its own — the driver materializes device contents as
process-owned host allocations, and CRIU stores those in its *ordinary* memory
image families. So `pages-*.img` should be roughly your device allocation
plus the process's normal footprint. Check that arithmetic. If it does not add
up on your setup, that is a finding, not a mistake.

Restore, timed:

```bash
/usr/bin/time -v sudo criu restore -D ~/ckpt-cuda --shell-job 2> cuda-restore.time
```

### What just happened

You watched the two-tool recipe from the chapter execute: `lock` quiesces the
runtime while the process is live; `checkpoint` moves device memory into
ordinary host allocations and releases the GPU; **stock CRIU then dumps what is
now an ordinary Linux process**; and the reverse on restore. Nothing in CRIU's
core learned about CUDA. The transformation happened first, and CRIU was
handed something it already knew how to serialize.

The RSS delta you measured is the mechanism, stated in a number: the device
memory did not vanish, it moved to the host, and that move is the cost that
dominates the whole operation on a discrete GPU.

---

## Tier 3 — unified memory, where the record is empty

Everything above assumed a discrete GPU: the checkpoint's dominant cost is a
device→host copy. On a unified-memory platform there may be no separate VRAM
to copy from — and *what actually happens* is, as of 2026-07, unpublished.

You are not following a recipe here. You are running an experiment. The
instructions are **observe and record**, not "expect X".

### The safety rules, again, because this is where they matter

Disposable worker. No irreplaceable state. UVM Managed Memory is documented
unsupported, so **stop at the first error and inspect state** rather than
retrying. Keep the recovery sequence from the top of this lab open in another
terminal.

### Step 1 — establish which platform you are actually on

[Unified & Coherent Memory](#/unified-memory) separates three different things
that share the name. Answer this before anything else, because the three have
different expected behaviour:

```bash
uname -m                                        # aarch64 on GB10 / Grace / Jetson
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv
getconf PAGE_SIZE                               # see arm64-memory: 4K/16K/64K matters
```

### Step 2 — a workload with a *managed* allocation

The distinction being tested is the allocation type. Build a second victim that
uses `cudaMallocManaged` instead of `cudaMalloc`, keeping everything else
identical, so the only variable is the allocation:

```cuda
    cudaMallocManaged(&ballast, 512u << 20);   // instead of cudaMalloc
    memset(ballast, 0xA5, 512u << 20);         // touched from the HOST side
```

Run both victims in separate experiments. The `cudaMalloc` one is your control:
if it toggles and the managed one does not, you have isolated the variable.

### Step 3 — observe the transition alone, before involving CRIU

```bash
PID=<pid of the disposable worker>
sed -n '1,240p' /proc/$PID/maps > maps.before
cuda-checkpoint --get-state --pid "$PID"
/usr/bin/time -v cuda-checkpoint --toggle --pid "$PID" 2> toggle.time
cuda-checkpoint --get-state --pid "$PID"
sed -n '1,240p' /proc/$PID/maps > maps.after
diff maps.before maps.after
```

Whatever happens — success, refusal, or a partial transition — is data. Keep
`toggle.time`, both maps, and the exact error text. Then return the process to
`running` using the recovery sequence.

Pay particular attention to the large `---p` reservation at a round address
that [GPU Checkpointing](#/gpu-checkpoint) shows in a CUDA process's maps.
**What happens to it across the toggle is one of the chapter's stated open
questions.** You are now in a position to answer it for your platform.

### Step 4 — only on a fresh run, and only if step 3 succeeded

```bash
PID=<pid of a FRESH disposable worker>
sudo criu check
mkdir -p ./ckpt-uma
/usr/bin/time -v sudo criu dump -t "$PID" -D ./ckpt-uma --shell-job 2> uma-dump.time
du -sh ./ckpt-uma
ls -lh ./ckpt-uma/pages-*.img ./ckpt-uma/pagemap-*.img
sudo crit decode -i "./ckpt-uma/pagemap-$PID.img" --pretty | head -80
/usr/bin/time -v sudo criu restore -D ./ckpt-uma --shell-job 2> uma-restore.time
```

The question the CRIT output is being asked: on a platform where host and
device already share memory, **are the pages counted once or twice?** Nobody
has published the answer.

---

## The results template

This is the deliverable. Fill it in for each configuration you test, and keep
the failures — a documented refusal on a named driver and allocation type is
worth as much as a success, and is far more likely.

| Field | Your value |
|---|---|
| Date | |
| Machine / SoC | |
| Architecture (`uname -m`) | |
| Page size (`getconf PAGE_SIZE`) | |
| GPU model, count | |
| Driver version | |
| CUDA version | |
| CRIU version, CUDA plugin present? | |
| Allocation type (`cudaMalloc` / pinned host / `cudaMallocManaged`) | |
| Device bytes allocated | |
| `lock` wall time | |
| `checkpoint` wall time | |
| RSS before → after `checkpoint` | |
| `nvidia-smi` memory attributed, before → after | |
| `criu dump` wall time | |
| Total image size | |
| `pages-*.img` size | |
| `criu restore` wall time | |
| `restore` + `unlock` wall time | |
| Time to first correct output after restore | |
| Outcome (success / refusal + exact error) | |

**Which of these cells has no published value anywhere, as of 2026-07?** For a
discrete GPU, vendor figures exist for end-to-end restore of large models, and
[GPU Checkpointing](#/gpu-checkpoint) cites them with their caveats. For
**unified memory, all of them** — image size, toggle latency, restore latency,
and the CRIT autopsy of what the page images contain. That is the gap the
chapter names, and the reason this lab ends in a table rather than a
congratulation.

Publishing it well is a separate skill, and the course covers it:
[Getting a Patch Accepted](#/contributing-upstream) is about turning exactly
this kind of result into something a project will act on — a reproducible
measurement, in an area with none, is a contribution in its own right.

## Troubleshooting

- **`cuda-checkpoint: command not found`** — it ships separately from the
  driver; get it from the [NVIDIA/cuda-checkpoint](https://github.com/NVIDIA/cuda-checkpoint)
  repository, and note that aarch64 binaries are recent.
- **The toggle times out** — `lock` waits for in-flight work to drain. Raise
  `--timeout`, and check the workload is not in a long-running kernel. A
  timed-out `lock` may leave the process `locked`; query the state.
- **`criu dump` fails with an unsupported-file error naming `/dev/nvidia*`** —
  the plugin is not being loaded. Compare against the Tier 1b failure you
  produced deliberately: that is what a *plugin-less* refusal looks like.
- **Restore fails on a different machine** — GPU count and compatibility are
  part of the checkpoint contract, not a detail. Same count, compatible GPUs,
  compatible driver.
- **The process hangs after a failed experiment** — it is `locked`, not hung.
  Run the recovery sequence.
- **`nvidia-smi` still shows memory after `checkpoint`** — record it. If the
  RSS delta and the `nvidia-smi` delta disagree, that disagreement is a result
  worth reporting, and [Where VRAM Goes](#/gpu-memory-allocation) and
  [Instrumenting the GPU](#/gpu-observability) explain why the two numbers
  measure different things.

## Check your understanding

1. Tier 1b made stock CRIU refuse a process holding `/dev/dri/renderD128`.
   Why is that refusal the *correct* behaviour rather than a missing feature?

<details><summary>Show answer</summary>

Because the descriptor is a handle, not state. Everything it stands for was
created through `ioctl()` calls whose effects live in driver-private
structures and on the device. CRIU can see that the fd exists but has no way to
serialize what is behind it, and reopening it on restore would produce an empty
handle to a driver that has never heard of the original objects. Refusing is
honest; silently dumping a process that cannot be correctly restored would not
be.

</details>

2. In Tier 2c you measured RSS before and after the `checkpoint` action. What
   should have happened to it, and what does the change prove?

<details><summary>Show answer</summary>

RSS should grow by roughly the size of the device allocation. That is the whole
mechanism in one number: `checkpoint` copies device memory out of VRAM into
ordinary host memory owned by the process and releases the GPU-side resources.
The bytes did not disappear, they moved into anonymous host VMAs that
`/proc/<pid>/maps` describes and CRIU dumps routinely — which is precisely why
stock CRIU can take it from there.

</details>

3. Why does the lab insist on `lock` and `checkpoint` as separate steps rather
   than always using `--toggle`?

<details><summary>Show answer</summary>

Because the interesting failures happen between them, and because the split
mirrors what the CRIU plugin does across the freeze boundary: `lock` runs from
`PAUSE_DEVICES` while the process is still running, and `checkpoint` runs from
`CHECKPOINT_DEVICES` after CRIU has seized the process. Driving them by hand
lets you observe the `locked` state — quiesced but runnable — which is the
state the whole orchestration depends on and which `--toggle` hides.

</details>

4. Tier 3 tells you to run a `cudaMalloc` workload as a control alongside the
   `cudaMallocManaged` one. Why does the control matter?

<details><summary>Show answer</summary>

Because it isolates the variable. If both fail, the problem is your driver,
your CRIU build, your plugin installation, or your workload. If the
`cudaMalloc` one toggles and the managed one does not, you have demonstrated
that the allocation type is what the transition rejects — which is the actual
question, and which a single failing run could not distinguish from a broken
setup.

</details>

5. After a failed transition, `--get-state` reports `checkpointed`. What do you
   run, in what order, and why is one verb not enough?

<details><summary>Show answer</summary>

`--action restore` first, then `--action unlock`. `restore` takes the process
from `CHECKPOINTED` back to `LOCKED` — re-acquiring a GPU, reallocating device
memory, copying the saved bytes back and rebuilding contexts. `unlock` then
takes it from `LOCKED` to `RUNNING` by letting the application's CUDA calls
proceed. Stopping after `restore` leaves a process whose CUDA calls still
block, which is indistinguishable from a hang unless you know to check the
state.

</details>

6. On a discrete GPU, the CUDA plugin does not write a large plugin-specific
   image. So where do the device bytes end up in the image directory, and how
   would you check?

<details><summary>Show answer</summary>

In CRIU's ordinary memory image families — `pages-*.img` indexed by
`pagemap-*.img`. The driver materializes device contents as process-owned host
allocations, and CRIU then dumps those as it would any anonymous memory. You
check by comparing the size of `pages-*.img` against your device allocation
plus the process's normal footprint, and by decoding the pagemap with
`crit decode`. If the arithmetic does not work on your setup, that is a
finding worth recording rather than an error to explain away.

</details>

7. Why does this lab ask for a baseline on a machine with no GPU at all, when
   its subject is GPU checkpointing?

<details><summary>Show answer</summary>

Because every Tier 2 and Tier 3 number is a comparison. Dump time, image size
and restore time all depend on the machine's storage, its CPU and its memory
bandwidth as much as on anything GPU-specific. Without a same-machine baseline
for an ordinary process of comparable working-set size, a GPU measurement
cannot be attributed to the GPU. It is also the tier that teaches you what
CRIU's device refusal looks like, which you need in order to diagnose Tier 2.

</details>

8. Which parts of the results table have no published value as of 2026-07, and
   what makes that a statement about the field rather than about your search?

<details><summary>Show answer</summary>

For unified-memory platforms: all of them — toggle latency, dump time, image
size, `pages-*.img` size, restore latency, and any CRIT autopsy of what those
images contain. [GPU Checkpointing](#/gpu-checkpoint) states this explicitly
and dates it. It is a statement about the field because UVM Managed Memory is
documented as unsupported, so there is no supported configuration under which
anyone has had reason to publish the numbers; the measurements do not exist
rather than being hard to find.

</details>

## Sources & further reading

- [NVIDIA/cuda-checkpoint](https://github.com/NVIDIA/cuda-checkpoint) — the
  authority on the CLI verbs, the RUNNING/LOCKED/CHECKPOINTED state machine,
  the driver-version matrix and architecture support. Check it against your
  driver rather than trusting any prose, including this lab's.
- [CRIU CUDA plugin README](https://github.com/checkpoint-restore/criu/blob/criu-dev/plugins/cuda/README.md)
  — the hook-to-action mapping, driver requirements, and the documented
  limitations you are testing against in Tier 3.
- [CRIU plugins](https://criu.org/Plugins) — the plugin API and the
  `-ENOTSUP` enumeration that produced your Tier 1b refusal.
- [GPU Checkpointing: cuda-checkpoint & CRIU Plugins](#/gpu-checkpoint) — the
  theory this lab executes, including the constraint list and the open
  questions the results template is designed to close.
- [Lab: Checkpoint & Restore a Real Process](#/lab-criu) — the CRIU and CRIT
  mechanics this lab assumes you already have.
- [Unified & Coherent Memory](#/unified-memory) — which of the three
  unified-memory platforms you are on, and why that changes what you should
  expect in Tier 3.

**Next:** you now have numbers nobody else has. [Getting a Patch
Accepted](#/contributing-upstream) is about what to do with them.
