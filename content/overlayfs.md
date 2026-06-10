# Images & OverlayFS

> **Goal:** understand what a container image really is (a stack of
> tarballs), how OverlayFS fuses the stack into one filesystem, and why this
> design makes pulls fast, storage cheap — and a few behaviours weird.

## An image is a stack of tarballs

Strip away the tooling and a container image is embarrassingly simple:

- an ordered list of **layers** — each one a plain tarball of files
  (a *diff* against the layer below);
- a small JSON **config** — env vars, default command, working dir;
- a **manifest** tying it together, everything addressed by SHA-256 digest.

```bash
docker pull alpine
docker save alpine -o alpine.tar && tar tf alpine.tar
# blobs/sha256/…   ← the layers (tarballs) and config (json). That's all.
```

Layers map to Dockerfile instructions:

```dockerfile
FROM debian:bookworm          # layers of the base image
RUN apt-get install -y nginx  # + layer: files apt added
COPY app/ /srv/app/           # + layer: your files
ENV PORT=8080                 # no layer — config only
```

Why bother with layers instead of one big tarball?

- **Deduplication** — fifty images `FROM debian:bookworm` share one copy of
  Debian, on disk and in the registry.
- **Cache** — rebuilds reuse unchanged layers; `docker push`/`pull` transfer
  only missing ones (that's why pulls say "Already exists" line by line).
- **Immutability** — layers are content-addressed (digest = hash of bytes):
  shareable, verifiable, cacheable forever.

But a running container needs one coherent root filesystem, and layers are
read-only. Enter the kernel.

## OverlayFS: the union

**OverlayFS** is a union filesystem (a VFS implementation like ext4 — the
filesystems chapter's plug-in architecture paying off again). It stacks
directories:

```text
        ┌───────────────────────────────┐
 upper  │  upperdir   (writable)        │  ← all changes land here
        ├───────────────────────────────┤
 lower  │  layer 3: your app            │  read-only ─┐
        │  layer 2: nginx               │  read-only  ├─ the image
        │  layer 1: debian base         │  read-only ─┘
        └───────────────────────────────┘
                    ↓ presented as
        ┌───────────────────────────────┐
        │  merged: one unified view     │  ← the container's /
        └───────────────────────────────┘
```

The rules are simple:

- **Read**: topmost layer that has the file wins.
- **Write**: copy the file up to `upperdir` first (**copy-up**), then modify
  the copy. Lower layers are never touched.
- **Delete**: can't delete from read-only layers — instead a **whiteout**
  marker (a 0/0 character device) is placed in upperdir; the merged view
  hides the file.

Try it with bare directories — no Docker involved:

```bash
mkdir lower upper work merged
echo "from the image" > lower/base.txt
sudo mount -t overlay overlay \
     -o lowerdir=lower,upperdir=upper,workdir=work merged

cat merged/base.txt              # from the image
echo change >> merged/base.txt   # write through the union…
cat lower/base.txt               # untouched! the original is immutable
ls upper/                        # base.txt — the copied-up version
rm merged/base.txt && ls -l upper/   # c--------- base.txt ← a whiteout
sudo umount merged
```

You just performed, by hand, exactly what Docker's storage driver does for
every container.

## What `docker run` assembles

Each container gets a fresh, empty upperdir on top of the image's layer
stack — that's the **container layer**:

```bash
docker run -d --name web nginx
docker inspect web -f '{{json .GraphDriver.Data}}' | python3 -m json.tool
# LowerDir:  /var/lib/docker/overlay2/…/diff:…:…   ← image layers
# UpperDir:  /var/lib/docker/overlay2/<id>/diff    ← this container's writes
# MergedDir: /var/lib/docker/overlay2/<id>/merged  ← its actual /
```

Consequences you now understand from first principles:

- **Starting 100 containers from one image costs ~0 disk and ~0 time** —
  100 empty upperdirs, one shared lower stack.
- **`docker rm` destroys all changes** — deleting a container = deleting its
  upperdir. "Ephemeral by design" isn't a philosophy, it's the data layout.
- **Persistent data needs volumes** — a volume is just a bind mount of a real
  host directory *over* a path in the merged tree, bypassing the overlay
  entirely (and its copy-up cost — also why databases should write to
  volumes, not the container layer).
- **`docker commit` exists** — tar up the upperdir, call it a new layer.

## Dockerfile hygiene, explained by layers

Layer mechanics turn into the build advice everyone repeats but few explain:

```dockerfile
# BAD: 'rm' can't shrink lower layers — the files live on in layer N,
# the whiteouts in layer N+1. Image got BIGGER.
RUN apt-get install -y build-essential
RUN make && make install
RUN apt-get remove -y build-essential && rm -rf /var/lib/apt/lists/*

# GOOD: create-and-delete inside ONE layer → files never get committed
RUN apt-get install -y build-essential \
 && make && make install \
 && apt-get remove -y build-essential && rm -rf /var/lib/apt/lists/*

# BEST: multi-stage — build artifacts cross, build environment doesn't
FROM debian AS build
RUN apt-get install -y build-essential && make
FROM debian:bookworm-slim
COPY --from=build /src/app /usr/local/bin/app
```

Same logic for cache ordering: put rarely-changing instructions (dependency
installs) before frequently-changing ones (`COPY . .`), because a changed
layer invalidates every layer after it.

## pivot_root: making the merged dir become /

Last piece: the runtime must make that merged directory the container's root.
Inside the new **mount namespace**:

1. bind-mount the merged dir;
2. `pivot_root(new_root, old_root)` — swap what `/` means *for this
   namespace*;
3. unmount the old root and mount fresh `/proc`, `/dev` (tmpfs), `/sys`.

Why `pivot_root` and not good old `chroot`? `chroot` only changes path
*lookup* — the old root stays mounted, and a privileged process can escape
(the classic `chroot("..")` double-chroot trick). `pivot_root` *detaches* the
old root from the namespace; there is nothing left to escape to. Runtimes use
pivot_root.

## Storage in the real world, briefly

- `overlay2` is Docker's default and the right answer almost always.
  Alternatives exist for other shapes: `btrfs`/`zfs` snapshot drivers,
  `devicemapper` (block-level, historical), `vfs` (plain copies — slow,
  for tests).
- **containerd snapshotters** are the same concept one abstraction up
  (overlayfs snapshotter by default; `stargz` for lazy-pulling images).
- Where does the space go? `docker system df` knows; dangling build layers
  are the usual suspect (`docker system prune`).
- OverlayFS quirks to recognize on sight: `inotify` watching a lowerdir file
  misses post-copy-up changes; the first write to a huge file pays full
  copy-up latency; hard links across layers break. Each is "copy-up,
  obviously" once you know the model.

## Check your understanding

1. Why is `RUN rm -rf /big-dir` in its own Dockerfile line unable to shrink
   an image?
2. A container writes 2 GB of logs to `/var/log/app.log` (no volume). Where
   exactly do those bytes live on the host, and what happens on `docker rm`?
3. Why do 100 containers from one image start instantly?
4. Why pivot_root instead of chroot?

---

**Next:** the payoff chapter — assemble namespaces, cgroups, pivot_root,
capabilities and seccomp into a working container, by hand, no Docker.
