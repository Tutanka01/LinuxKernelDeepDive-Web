# Implementation spec — Inference Engineering upgrade

**Every agent working on this course must read this file first.** It is the
contract that keeps eight parallel workstreams producing one coherent artefact
rather than eight different-looking ones.

---

## 1. How the site works (and the one trap in it)

- Static site. No build step. `inference/index.html` loads `marked.js`,
  `highlight.js`, `inference/assets/inf.js` (course data), then
  `../assets/course.js` (the shared reader engine).
- A chapter is `inference/content/<slug>.md`. The reader does
  `viewEl.innerHTML = "<div class='article-body'>" + marked.parse(md) + "</div>"`.
- **THE TRAP: a `<script>` tag written into a markdown chapter will never
  execute.** `innerHTML` parses script elements but flags them as
  already-executed. Do not put `<script>` in markdown. Ever. Interactivity goes
  through the widget host described in §5.
- `../assets/course.js` and `../assets/course.css` are **shared with two other
  courses. Do not modify them.** Course-local styling goes in
  `inference/assets/inf.css` (already exists).
- `inference/assets/inf.js` (the `COURSE` array) and `inference/index.html` are
  **owned by the orchestrator**. Do not edit them; report what needs registering
  and it will be wired up.

---

## 2. Markdown conventions

Raw HTML passes through `marked`. Per CommonMark, markdown inside an HTML block
**is** parsed as markdown provided there are blank lines around it. Use that.

### Images

```markdown
![Roofline for an H100, ridge at 295 FLOP/byte](diagrams/roofline-h100.svg)
```

Paths are relative to `inference/index.html`, so always `diagrams/name.svg`
(not `assets/diagrams/...`, not a leading slash). With a caption:

```markdown
<figure>

![alt text](diagrams/name.svg)

<figcaption>The caption, one or two lines, italic and centred.</figcaption>
</figure>
```

### Callouts

Authored as a blockquote opening with a GitHub-style marker. `inf-widgets.js`
strips the marker and applies the styling; the body stays ordinary markdown.

```markdown
> [!bridge] You already know this — from the Linux course
> A block table is a page table. Same problem, same solution: see
> [Virtual Memory](../#/virtual-memory) in The Linux Deep Dive.

> [!prereq] A 60-second attention refresher
> Body, still markdown.

> [!trap] Peak FLOPs are sparse FLOPs
> Body.
```

Available kinds: `bridge`, `prereq`, `trap`, `note`. The text after `[!kind]` on
the first line becomes the label; omit it for the default label.

The existing `> **Common trap — ...**` blockquotes in current chapters are fine
as they are. Do not go and convert them; only use `[!trap]` for new content.

### FAQ (bottom of every chapter, above the quiz)

```markdown
## Frequently asked

<div class="faq">

<details>
<summary>Does a bigger batch always cost me latency?</summary>

No — below `B_crit` the weight bytes are re-read regardless, so extra
sequences ride along nearly free. See [the batching section](#batching).

</details>

<details>
<summary>Second question?</summary>

Answer.

</details>

</div>
```

The blank lines are load-bearing: without them the inner markdown is not parsed.

### Calculation exercises

```markdown
<div class="exercise">

**Exercise 1.** Llama-3-70B, BF16, 32K context. How much KV cache does one
sequence hold?

<details>
<summary>Reveal answer</summary>

`2 × 80 layers × 8 kv_heads × 128 head_dim × 2 bytes = 328 KB/token`.
At 32,768 tokens: **≈ 10.7 GB** for one sequence.

</details>

</div>
```

### Quizzes

Unchanged — a ` ```quiz ` fence containing a JSON array of
`{q, choices, answer, explain}`. Every chapter ends with one. Note that fenced
blocks are stripped from the search index, which is why FAQs are *not* fenced.

---

## 3. Voice

Match the existing chapters exactly. Read `inference-arithmetic.md` and
`paged-kv-cache.md` before writing a word. The register is:

- Second person, present tense, calm. Explains *why* before *what*.
- Opens with a `> **Goal of this chapter:**` blockquote.
- Derives numbers rather than asserting them; every figure is worked.
- Names the trap the reader is about to fall into, in a callout.
- Ends with `## What to remember` (bulleted, bold lead-ins) then the quiz.
- Cross-links other chapters as `[Title](#/slug)`.
- Epistemic markers `[consensus]` / `[directional]` where a claim is contested
  or a number is an order-of-magnitude estimate.
- ~2,800–3,300 words per chapter. British-ish spelling is not used; keep US.
- No emoji. No exclamation marks. No "Let's dive in".

---

## 4. Diagram house style

All diagrams live in `inference/assets/diagrams/`. Hand-author the `.svg`
directly with precise coordinates — it is the artefact the site uses and it must
be exact. For the ones marked "Excalidraw" in the brief, also write a
`.excalidraw` JSON source next to it (schema in §4.4) so the diagram stays
editable.

### 4.1 Canvas

- `viewBox="0 0 880 H"`, and set `width="880" height="H"` so the image has an
  intrinsic size. CSS scales it down responsively.
- Ground: `<rect width="880" height="H" rx="8" fill="#f6f1e6"/>` — the ivory is
  deliberate. Diagrams read as printed insets on the dark theme and as plain
  paper on the light one, so **one** artwork serves both themes.
- Include `<title>` and `<desc>` as the first children, for screen readers.
- Height: keep it under ~520 for a full-width figure; panels can go taller.

### 4.2 Palette (do not improvise)

| role | hex |
|---|---|
| ground | `#f6f1e6` |
| panel / inset fill | `#ece5d4` |
| hairline, grid | `#ddd3bd` |
| ink (labels, headings) | `#221c12` |
| secondary text | `#6b6250` |
| faint text, axis ticks | `#8d8370` |
| **amber** — the subject of the figure | `#b8791f` |
| **rust** — bad, wasted, memory-bound, evicted | `#a4462e` |
| **olive** — good, cached, hit, compute-bound | `#4f7d2c` |
| **teal** — second series, KV, data movement | `#2f6d7d` |
| **indigo** — fourth series | `#3b5a8f` |

Fills of a hue at 18% opacity for zones; the solid hue for strokes and marks.
Never more than four hues in one figure.

### 4.3 Type

- Labels: `font-family="Iowan Old Style, Palatino, Georgia, serif"`, `font-size="14"`.
- Numbers, units, code identifiers: `font-family="SF Mono, Menlo, Consolas, monospace"`, `font-size="12"`.
- Figure title (top-left, `x="24" y="34"`): serif, `font-size="17"`, `font-weight="600"`, fill `#221c12`.
- Axis titles and legend: `font-size="12"`, fill `#6b6250`.
- Never rely on font fallback for layout: leave generous room, no tight boxes.
- Text is `<text>`, not paths. Set `text-anchor` explicitly (`start`/`middle`/`end`).

### 4.4 `.excalidraw` source shape

Minimal valid file; one entry per shape in `elements`:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {"type":"rectangle","version":1,"versionNonce":1,"isDeleted":false,
     "id":"r1","fillStyle":"solid","strokeWidth":1,"strokeStyle":"solid",
     "roughness":1,"opacity":100,"angle":0,"x":40,"y":80,"strokeColor":"#221c12",
     "backgroundColor":"#ece5d4","width":180,"height":60,"seed":1,"groupIds":[],
     "frameId":null,"roundness":{"type":3},"boundElements":[],"updated":1,
     "link":null,"locked":false},
    {"type":"text","version":1,"versionNonce":2,"isDeleted":false,"id":"t1",
     "fillStyle":"solid","strokeWidth":1,"strokeStyle":"solid","roughness":1,
     "opacity":100,"angle":0,"x":52,"y":100,"strokeColor":"#221c12",
     "backgroundColor":"transparent","width":150,"height":20,"seed":2,
     "groupIds":[],"frameId":null,"roundness":null,"boundElements":[],
     "updated":1,"link":null,"locked":false,"fontSize":16,"fontFamily":1,
     "text":"Block pool","textAlign":"left","verticalAlign":"top",
     "containerId":null,"originalText":"Block pool","lineHeight":1.25}
  ],
  "appState": {"gridSize": null, "viewBackgroundColor": "#f6f1e6"},
  "files": {}
}
```

The `.excalidraw` is the editable source of record; the `.svg` is what ships.
They should depict the same thing but need not be pixel-identical.

### 4.5 Verify every SVG

After writing each file, run:

```
node -e 'const s=require("fs").readFileSync(PATH,"utf8");new (require("util"))' # no
python3 -c "import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1]); print('ok')" PATH
```

Any SVG that does not parse as XML is a broken image on the page. Also check
`&` is written `&amp;`, `<` in text is `&lt;`, and that no `<text>` overflows
its viewBox.

---

## 5. Widgets (interactive tools)

The markdown carries only a placeholder:

```markdown
<div class="inf-widget" data-widget="kv-calculator">
<p class="inf-widget-fallback">Interactive KV-cache calculator — needs JavaScript.</p>
</div>
```

Extra `data-*` attributes arrive as the second argument to the mount function.

The tool itself lives in its own file under `inference/assets/` and registers:

```js
InfWidgets.define("kv-calculator", function (el, opts) {
  /* el is the empty placeholder div; build into it */
});
```

`inference/assets/inf-widgets.js` (already written — read it) provides the host
plus helpers: `InfWidgets.slider/select/toggle/canvas/fmt/palette/theme`, and a
`window` event `inf-theme` when the reader flips light/dark. Use the helpers and
the `.inf-*` classes in `inf.css` so every tool looks like the same product.

Rules for widgets:

- Vanilla JS, no dependencies, no build step, no network.
- Must work when re-mounted (the reader can navigate away and back).
- Must not throw; the host catches, but a caught throw shows an error box.
- Canvas: use `InfWidgets.canvas()` for the HiDPI/resize handling, redraw on
  `inf-theme`, and stop any animation loop when the element leaves the document
  (check `el.isConnected`) — a chapter swap must not leak a `requestAnimationFrame`
  loop forever.
- Numbers must be *directionally* right and consistent with the chapters.

Register the new file's name with the orchestrator; do not edit `index.html`.

---

## 6. Reference numbers (use these, consistently, everywhere)

| quantity | value |
|---|---|
| H100 SXM BF16 dense | 990 TFLOP/s |
| H100 HBM3 bandwidth | 3.35 TB/s |
| H100 memory | 80 GB |
| H100 ridge / `B_crit` (BF16) | ≈ 295 FLOP/byte |
| H200 | 990 TFLOP/s, 4.8 TB/s, 141 GB |
| B200 | ≈ 2,250 TFLOP/s dense BF16, 8 TB/s, 192 GB |
| A100 80GB | 312 TFLOP/s, 2.0 TB/s, ridge ≈ 156 (1.5 TB/s on the 40GB part) |
| L40S | 362 TFLOP/s, 0.86 TB/s, 48 GB |
| NVLink 4 (H100, per GPU) | 900 GB/s |
| InfiniBand NDR per node | 400 Gb/s ≈ 50 GB/s → the 20–40× cliff |
| Llama-3-8B | 32 layers, 8 KV heads, head_dim 128 → 131 KB/token BF16 |
| Llama-3-70B | 80 layers, 8 KV heads, head_dim 128 → 328 KB/token BF16 |
| DeepSeek-V3 | 671B total / 37B active, 61 layers, MLA latent 576 → ~70 KB/token |
| 2·P rule | forward pass ≈ 2·P FLOPs per token |
| KV bytes/token | `2 × layers × kv_heads × head_dim × bytes_per_elem` |
| decode intensity, batch 1 | ≈ 1 FLOP/byte, ~300× below the ridge |
| commercial output/input price ratio | ≈ 5–6× |
| cached input discount | ≈ 10× |
| realistic fleet utilisation | 30–60% |

If you need a number not on this list, derive it from these and show the
derivation in the text.

---

## 7. Files, and who owns what

Do not write outside the paths assigned to your workstream. If you believe a
file outside them must change, say so in your report instead of changing it.

- Orchestrator only: `inference/assets/inf.js`, `inference/index.html`,
  `inference/assets/inf.css`, `inference/assets/inf-widgets.js`.
- Never: `assets/course.js`, `assets/course.css`, `assets/style.css`,
  `assets/app.js`, `index.html` at the repo root, anything under `content/` at
  the repo root or under `distributed/`.

## 8. Report back

Finish with a short structured report: files created, files modified, anything
that needs registering in `COURSE` or `index.html`, and anything you could not
do. Do not summarise the content of what you wrote at length.
