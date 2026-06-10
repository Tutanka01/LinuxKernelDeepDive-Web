# Images & OverlayFS

> **Goal:** understand what a container image really is (a stack of
> tarballs), how OverlayFS fuses the stack into one filesystem, and why this
> design makes pulls fast, storage cheap — and a few behaviours weird.

## An image is a stack of tarballs

Strip away the tooling and a container image is embarrassingly simple:

- an ordered list of **layers** — each one a plain tarball of files and
  directories (a *diff* against the layer below);
- a small JSON **config** — env vars, default command, working dir, exposed
  ports, volumes;
- a **manifest** tying it together, everything addressed by SHA-256 digest.

```bash
docker pull alpine
docker save alpine -o alpine.tar && tar tf alpine.tar
# blobs/sha256/…   ← the layers (tarballs) and config (json). That's all.
docker image inspect alpine | jq '.[0].RootFS.Layers'
# sha256:a0ea… sha256:7b2e… sha256:…   ← the layer digests
```

Layers map to Dockerfile instructions:

```dockerfile
FROM debian:bookworm          # layers of the base image
RUN apt-get install -y nginx  # + 1 layer: files apt added/modified
COPY app/ /srv/app/           # + 1 layer: your files
ENV PORT=8080                 # metadata only — no layer
CMD ["./start.sh"]            # metadata only — no layer
```

Why bother with layers instead of one big tarball?

- **Deduplication** — fifty images `FROM debian:bookworm` share one copy of
  Debian, on disk and in the registry.
- **Cache** — rebuilds reuse unchanged layers; `docker push`/`pull` transfer
  only missing ones (pulls say "Already exists" line by line).
- **Immutability** — layers are content-addressed (digest = hash of bytes):
  shareable, verifiable, cacheable forever. The same digest *is* the same
  bytes.

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
  marker (a character device with 0/0 major/minor) is placed in upperdir;
  the merged view hides the file.
- **Directory ops**: creating, renaming, and deleting files within directories
  involves opaque directory markers in the upperdir.

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

### OverlayFS mount options that matter

- `lowerdir=dir1:dir2:dir3` — layers from bottom to top. Can stack many.
- `redirect_dir=on` — optimize directory renames (default on modern kernels).
- `metacopy=on` — only copy metadata on first write, not data blocks. Saves I/O.
- `index=on` — ensure inode numbers don't change across copy-up (avoids NFS
  and caching bugs).

The `workdir` must be on the same filesystem as `upperdir` and is used for
atomic copy-up operations. It must be empty.

## What `docker run` assembles

Each container gets a fresh, empty upperdir on top of the image's layer
stack — that's the **container layer**:

```bash
docker run -d --name web nginx
docker inspect web -f '{{json .GraphDriver.Data}}' | python3 -m json.tool
# LowerDir:  /var/lib/docker/overlay2/<id>/diff:…:…   ← image layers
# UpperDir:  /var/lib/docker/overlay2/<id>/diff        ← this container's writes
# MergedDir: /var/lib/docker/overlay2/<id>/merged      ← its actual /
# WorkDir:   /var/lib/docker/overlay2/<id>/work
```

Consequences you now understand from first principles:

- **Starting 100 containers from one image costs ~0 disk and ~0 time** —
  100 empty upperdirs, one shared lower stack.
- **`docker rm` destroys all changes** — deleting a container = deleting its
  upperdir. "Ephemeral by design" isn't a philosophy, it's the data layout.
- **Persistent data needs volumes** — a volume is a bind mount of a real
  host directory *over* a path in the merged tree, bypassing the overlay
  entirely (and its copy-up cost — also why databases should write to
  volumes, not the container layer).
- **`docker commit` exists** — tar up the upperdir, calculate its digest,
  call it a new layer.

```bash
# See a container's real filesystem:
ls -la /var/lib/docker/overlay2/<container-id>/diff/
# Trace overlayfs mounts:
findmnt -t overlay
```

## Copy-up performance: the hidden cost

Copy-up has real performance implications:

- **First write** to a large file in the lower layers copies the entire file
  to the upperdir. Writing 1 byte to a 10 GB lower-layer file = 10 GB copy-up
  (and the space cost — both copies exist until the container is removed).
- **Dockerfile best practice** follows: put rarely-changing, small files early;
  large data in volumes.
- OverlayFS does *not* deduplicate across upperdirs — each container's copy
  of a file is independent. If 10 containers each modify the same 1 GB file,
  they each have their own 1 GB copy in their upperdir.

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
layer invalidates every layer after it — they all get rebuilt.

```dockerfile
# Correct order:
COPY package.json /app/        # change rarely → use cache
RUN npm install                # re-run only if package.json changes
COPY . /app/                   # change often → only this layer rebuilds
```

## pivot_root: making the merged dir become /

Last piece: the runtime must make that merged directory the container's root.
Inside the new **mount namespace**:

1. bind-mount the merged dir at a staging location;
2. `pivot_root(new_root, old_root)` — swap what `/` means *for this
   namespace*. The old root is moved to `/old_root` inside the new tree;
3. unmount/umount the old root (detached from the namespace);
4. mount fresh `/proc` (proc), `/dev` (tmpfs with device nodes), `/sys` (sysfs).

Why `pivot_root` and not `chroot`? `chroot` only changes path *lookup* — the
old root stays mounted, and a privileged process can escape (the classic
`chroot("..")` double-chroot trick, or `/proc/<pid>/root` remaining). `pivot_root`
*detaches* the old root from the namespace's mount table; there is nothing
left to escape to. Runtimes use pivot_root.

## Storage in the real world, briefly

- `overlay2` is Docker's default and the right answer almost always.
  Alternatives exist for other shapes: `btrfs`/`zfs` snapshot-based drivers
  (use filesystem snapshots as layers), `devicemapper` (block-level, historical,
  slow), `vfs` (plain copies — for tests only).
- **containerd snapshotters** are the same concept one abstraction up
  (overlayfs snapshotter by default; `stargz` for lazy-pulling — download
  only the blocks you access).
- Where does the space go? `docker system df` knows; dangling build layers
  and old images are the usual suspects (`docker system prune -a`).
- OverlayFS quirks to recognize on sight: `inotify` watching a lowerdir file
  misses post-copy-up changes (the file moved to upperdir — inotify watches
  the old inode); the first write to a huge file pays full copy-up latency;
  hard links across layers break (OverlayFS doesn't support them); `st_ino`
  may change for directories.
- Running `docker system df -v` shows per-image and per-container space.

```bash
docker system df
docker system df -v | head -40    # detailed breakdown
# Clean up:
docker system prune -a --volumes  # remove everything not in use (careful!)
```

## Check your understanding

1. Why is `RUN rm -rf /big-dir` in its own Dockerfile line unable to shrink
   an image?
2. A container writes 2 GB of logs to `/var/log/app.log` (no volume). Where
   exactly do those bytes live on the host, and what happens on `docker rm`?
3. Why do 100 containers from one image start instantly?
4. Why pivot_root instead of chroot?
5. What happens to disk space when you modify a 10 GB file in a container's
   overlay — and why is this better handled with a volume?

*(Answers: the deleted files are still present in the lower layer — they were
part of the tarball; the Dockerfile line creates a new layer with whiteout
entries, not removal. Image size = sum of all layers, whiteouts don't
subtract; they live in the container's upperdir
(/var/lib/docker/overlay2/<id>/diff/) — docker rm deletes the entire
container directory, including the upperdir, so the logs vanish; lower dirs
are shared across all containers, only an empty upperdir is created per
container — no copy of the image needed; chroot only changes path lookup
and the old root stays mounted (escapable via `chroot("..")` or
/proc/<pid>/root), pivot_root detaches the old root from the namespace
entirely leaving nothing to escape to; the file is copied-up from the lower
layer to the upperdir on first write, so the container now owns its own 10
GB copy — both the original and the copy exist on disk. Volumes bypass the
overlay entirely, so writes don't trigger copy-up.)*

---

**Next:** the payoff chapter — assemble namespaces, cgroups, pivot_root,
capabilities and seccomp into a working container, by hand, no Docker.
