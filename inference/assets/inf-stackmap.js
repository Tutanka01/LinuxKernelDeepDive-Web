/* ============================================================
   Inference Engineering — the serving stack map.

   The recurring orientation strip at the head of every chapter:
   one small diagram of the whole request path, with this chapter's
   piece lit and everything else dimmed. Seventeen-plus chapters
   each need this, so it is built ONCE here as data + a template
   function, not as seventeen near-identical SVG files — a mount is
   just "stamp the same markup, flip which stages get the .hi
   class." That keeps one source of truth for the whole course's
   sense of place.

   Markdown carries only:
     <div class="inf-widget inf-stackmap" data-widget="stackmap"
          data-highlight="scheduler,kv"></div>

   Unlike the standalone diagrams in assets/diagrams/ (ivory ground,
   fixed palette, must read the same in both themes because they're
   baked <img> files), this widget is inline markup living in the
   page, so it uses the theme's own CSS custom properties and gets
   light/dark for free — no inf-theme listener needed.
   ============================================================ */

InfWidgets.define("stackmap", function (el, opts) {
  const hi = parseHighlight(opts.highlight);
  const capText = opts.caption ? String(opts.caption) : captionFor(hi);
  el.innerHTML = buildSVG(hi, capText) +
    `<p class="inf-stackmap-cap">${esc(capText)}</p>`;
});

/* The pipeline a request walks, left to right, top row. KV cache
   and the multi-GPU fabric are not a further step in that walk —
   they are substrate the runner and kernels sit on — so they're
   drawn as a lower tier directly under those two columns instead
   of inline as a 10th and 11th box. */
const STAGES = [
  { id: "client",    label: "Client",    x: 20,  y: 14, w: 108, h: 40, fs: 18 },
  { id: "router",    label: "Router",    x: 142, y: 14, w: 108, h: 40, fs: 18 },
  { id: "api",       label: "API",       x: 264, y: 14, w: 108, h: 40, fs: 18 },
  { id: "scheduler", label: "Scheduler", x: 386, y: 14, w: 108, h: 40, fs: 18 },
  { id: "batch",     label: "Batch",     x: 508, y: 14, w: 108, h: 40, fs: 18 },
  { id: "runner",    label: "Runner",    x: 630, y: 14, w: 108, h: 40, fs: 18 },
  { id: "kernels",   label: "Kernels",   x: 752, y: 14, w: 108, h: 40, fs: 18 },
  { id: "kv",        label: "KV cache",  x: 630, y: 70, w: 108, h: 34, fs: 16 },
  { id: "fabric",    label: "Fabric",    x: 752, y: 70, w: 108, h: 34, fs: 16 },
];

/* Full names for the caption line — the boxes stay short so they
   fit at 108px wide; the sentence under the strip says the rest. */
const NAMES = {
  client: "the client", router: "the router", api: "the API server",
  scheduler: "the scheduler", batch: "the running batch",
  runner: "the model runner", kernels: "the kernels",
  kv: "the KV cache", fabric: "the multi-GPU fabric",
};

const IDS = new Set(STAGES.map(s => s.id));

/* Unknown ids (a typo in some future chapter's data-highlight, or
   the attribute simply missing) must not throw — they just fail to
   match anything, which the render loop below already treats as
   "dim everything" for free. */
function parseHighlight(raw) {
  return new Set(
    String(raw || "").split(",").map(s => s.trim()).filter(id => IDS.has(id))
  );
}

function joinNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + " and " + names[1];
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

function captionFor(hi) {
  if (hi.size === 0) return "The full request path, end to end.";
  return "Where you are: " + joinNames(STAGES.filter(s => hi.has(s.id)).map(s => NAMES[s.id])) + ".";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* One <g> per stage. Fill/stroke/opacity live in the <style> block
   below via the .hi / .dim class, not inline — so the whole map
   recolours with the light/dark switch through the CSS variables
   those rules reference, same as the rest of the page. */
function stageGroup(s, on) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  return `<g class="inf-sm-stage ${on ? "hi" : "dim"}">` +
    `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="6"/>` +
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="${s.fs}">${esc(s.label)}</text>` +
    `</g>`;
}

const STYLE = `<style>
  .inf-sm-stage rect { stroke-width: 1; }
  .inf-sm-stage.dim { opacity: 0.35; }
  .inf-sm-stage.dim rect { fill: var(--bg-raised); stroke: var(--rule); }
  .inf-sm-stage.dim text { fill: var(--text-dim); font-weight: 400; }
  .inf-sm-stage.hi rect { fill: var(--accent); fill-opacity: 0.16; stroke: var(--accent); stroke-width: 2; }
  .inf-sm-stage.hi text { fill: var(--ink); font-weight: 700; }
  .inf-sm-stage text { font-family: var(--serif); }
</style>`;

function buildSVG(hi, capText) {
  const top = STAGES.slice(0, 7); /* the request-path row, for the connecting arrows */

  /* A small ">" chevron in each gap of the top row — just chrome,
     so it stays a constant colour regardless of what's highlighted. */
  let arrows = "";
  for (let i = 0; i < top.length - 1; i++) {
    const gx = top[i].x + top[i].w + 7;
    arrows += `<path d="M ${gx - 4} 28 L ${gx + 3} 34 L ${gx - 4} 40" fill="none" stroke="var(--text-faint)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  /* The two stems saying "the substrate below is what runner and
     kernels stand on" — fixed geometry, always drawn, regardless
     of which stage happens to be lit this chapter. */
  const stems =
    `<line x1="684" y1="54" x2="684" y2="70" stroke="var(--rule)" stroke-width="1.5"/>` +
    `<line x1="806" y1="54" x2="806" y2="70" stroke="var(--rule)" stroke-width="1.5"/>`;

  const stages = STAGES.map(s => stageGroup(s, hi.has(s.id))).join("");

  return `<svg viewBox="0 0 880 118" width="880" height="118" role="img" aria-label="${esc(capText)}">` +
    STYLE +
    `<rect x="0.5" y="0.5" width="879" height="117" rx="10" fill="var(--bg-raised)" stroke="var(--rule)"/>` +
    arrows + stems + stages +
    `</svg>`;
}
