/* ============================================================
   Inference Engineering — the three calculators.

   Three tools, one file, because they share a spine: a preset
   table, a formatter, and the habit of ending every number with
   a link back to the chapter whose formula produced it. That
   back-link is the point. A calculator that just emits a figure
   teaches nothing; one that says "this is 2 × layers × kv_heads
   × head_dim × bytes, and here is where you read about it" turns
   a slider into a second pass over the chapter.

     kv-calculator      → will it fit, and how many users?
     roofline-explorer  → which side of the ridge am I on?
     cost-calculator    → what does a token cost, and why?

   Every figure here is pinned to the reference table in
   implementation-spec.md §6 and to the worked budgets in
   Sizing a Deployment. Where the two differed, the chapter won:
   the memory budget below uses 3 GB/GPU framework overhead,
   1 GB/GPU activations and a ×0.90 headroom factor, which
   reproduces that chapter's ladder table row for row.

   Units, once, so nothing drifts: GB and KB are decimal (1e9,
   1e3), which is how the chapters quote both "140 GB of weights"
   and "328 KB/token". HBM capacities are taken at their
   datasheet number.
   ============================================================ */

(function () {
  "use strict";

  var W = window.InfWidgets;
  if (!W) return; /* host missing — the chapters still read fine */

  /* ---------------- shared vocabulary ---------------- */

  /* implementation-spec.md §6. flops is *dense* BF16: vendor peak
     numbers include 2:4 sparsity and are 2× these. Using the
     sparse figure makes every ridge on this page wrong by 2×. */
  var GPUS = [
    { id: "h100", label: "H100 80GB (SXM)", hbm: 80,  bw: 3.35e12, flops: 990e12 },
    { id: "h200", label: "H200 141GB",      hbm: 141, bw: 4.80e12, flops: 990e12 },
    { id: "b200", label: "B200 192GB",      hbm: 192, bw: 8.00e12, flops: 2250e12 },
    { id: "a100", label: "A100 80GB",       hbm: 80,  bw: 2.00e12, flops: 312e12 },
    { id: "l40s", label: "L40S 48GB",       hbm: 48,  bw: 0.86e12, flops: 362e12 }
  ];

  /* P is total parameters in billions (memory always uses total,
     never active — the MoE trap). q is query heads, kept because
     the GQA group size q/kv is what fixes attention's arithmetic
     intensity in the roofline. `mla` is the latent width for
     DeepSeek's Multi-head Latent Attention, whose cache is one
     compressed vector per token per layer rather than K and V
     per head — a different formula, not a different constant. */
  var MODELS = [
    { id: "llama3-8b",   label: "Llama-3-8B",        P: 8,    layers: 32,  kv: 8, dim: 128, q: 32 },
    { id: "llama3-70b",  label: "Llama-3-70B",       P: 70,   layers: 80,  kv: 8, dim: 128, q: 64 },
    { id: "llama31-405b",label: "Llama-3.1-405B",    P: 405,  layers: 126, kv: 8, dim: 128, q: 128 },
    { id: "qwen3-32b",   label: "Qwen3-32B",         P: 32.8, layers: 64,  kv: 8, dim: 128, q: 64 },
    { id: "mistral-7b",  label: "Mistral-7B",        P: 7.2,  layers: 32,  kv: 8, dim: 128, q: 32 },
    { id: "dsv3",        label: "DeepSeek-V3 (MLA)", P: 671,  layers: 61,  kv: 1, dim: 576, q: 128, mla: true },
    { id: "custom",      label: "Custom…",      P: 70,   layers: 80,  kv: 8, dim: 128, q: 64 }
  ];

  var OVERHEAD_PER_GPU = 3;   /* CUDA context, allocator, NCCL buffers, CUDA graphs */
  var ACTIVATION_PER_GPU = 1; /* decode-time transients; prefill chunks cost more */
  var HEADROOM = 0.90;        /* vLLM's gpu_memory_utilization default */

  var ARITH = '<a href="#/inference-arithmetic">Inference Arithmetic</a>';
  var SIZING = '<a href="#/sizing-a-deployment">Sizing a Deployment</a>';
  var ATTN = '<a href="#/attention-for-serving">Attention Architectures</a>';
  var AGENTIC = '<a href="#/agentic-serving">The Agentic Era</a>';
  var PAGED = '<a href="#/paged-kv-cache">Prefix Caching</a>';

  /* ---------------- small helpers ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function shell(el, title, subtitle) {
    el.innerHTML = "";
    var head = document.createElement("div");
    head.className = "inf-widget-head";
    head.innerHTML = "<h4>" + esc(title) + "</h4><p>" + esc(subtitle) + "</p>";
    el.appendChild(head);
    var body = document.createElement("div");
    body.className = "inf-widget-body";
    el.appendChild(body);
    return body;
  }

  function div(parent, cls) {
    var d = document.createElement("div");
    if (cls) d.className = cls;
    parent.appendChild(d);
    return d;
  }

  /* Tile markup. `value` is escaped; `note` is authored HTML (it
     carries the chapter link), so only ever build it from
     literals plus already-formatted numbers. */
  function tiles(list) {
    return list.map(function (t) {
      return "<div><span class=\"inf-result-label\">" + esc(t.label) + "</span>" +
        "<span class=\"inf-result-value" + (t.cls ? " " + t.cls : "") + "\">" + esc(t.value) + "</span>" +
        "<span class=\"inf-result-note\">" + t.note + "</span></div>";
    }).join("");
  }

  /* A window listener that unhooks itself. course.js replaces the
     whole #view subtree on navigation and emits no event, so a
     widget cannot be told it is dead — it has to notice. */
  function bindWindow(el, type, fn) {
    function h(ev) {
      if (!el.isConnected) { window.removeEventListener(type, h); return; }
      fn(ev);
    }
    window.addEventListener(type, h);
  }

  function numberField(parent, label, value, min, max, step) {
    var wrap = div(parent, "inf-control");
    var id = "infn-" + Math.random().toString(36).slice(2, 9);
    wrap.innerHTML = "<label for=\"" + id + "\">" + esc(label) + "</label>" +
      "<input id=\"" + id + "\" type=\"number\" min=\"" + min + "\" max=\"" + max +
      "\" step=\"" + (step || 1) + "\" value=\"" + value + "\">";
    return wrap.querySelector("input");
  }

  function tokLabel(n) {
    if (n >= 1024 * 1024) return (n / 1048576) + "M";
    if (n >= 1024) return (n / 1024) + "K";
    return String(n);
  }

  function gb(x) { return x >= 1000 ? W.fmt(x / 1000, 2) + " TB" : W.fmt(x, x < 10 ? 2 : 1) + " GB"; }

  function money(x) {
    if (!isFinite(x)) return "—";
    if (x >= 1000) return "$" + W.fmt(x, 0);
    if (x >= 1) return "$" + W.fmt(x, 2);
    return "$" + x.toFixed(3);
  }

  function flopsLabel(f) {
    if (f >= 1e15) return W.fmt(f / 1e15, 2) + " PFLOP/s";
    if (f >= 1e12) return W.fmt(f / 1e12, 1) + " TFLOP/s";
    return W.fmt(f / 1e9, 0) + " GFLOP/s";
  }

  function findBy(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  /* KV bytes per token. Two formulas, not one — MLA stores a
     single compressed latent per layer, so neither the ×2 for K
     and V nor the head count appears. Silently running MLA
     through the GQA formula would overstate DeepSeek-V3's cache
     by ~8×, which is exactly the kind of wrong number a
     calculator makes authoritative. */
  function kvBytesPerToken(m, elemBytes) {
    if (m.mla) return m.layers * m.dim * elemBytes;
    return 2 * m.layers * m.kv * m.dim * elemBytes;
  }

  /* ============================================================
     TOOL 1 — kv-calculator
     ============================================================ */

  W.define("kv-calculator", function (el) {
    var body = shell(el, "Will it fit, and for how many users?",
      "Every byte of HBM, and the concurrency that falls out of what is left.");

    var controls = div(body, "inf-controls");
    var cur = { P: 70, layers: 80, kv: 8, dim: 128, q: 64, mla: false };
    var customMem = null;

    var modelSel = W.select(controls, {
      label: "Model", value: "llama3-70b",
      options: MODELS.map(function (m) { return { value: m.id, label: m.label }; })
    });

    var fLayers = numberField(controls, "layers", 80, 1, 256);
    var fKv = numberField(controls, "kv heads", 8, 1, 128);
    var fDim = numberField(controls, "head_dim", 128, 8, 1024, 8);
    var fP = numberField(controls, "params (B)", 70, 0.1, 2000, 0.1);

    var wDtype = W.select(controls, {
      label: "Weight dtype", value: "2",
      options: [{ value: "2", label: "BF16 (2 B)" }, { value: "1", label: "FP8 (1 B)" }, { value: "0.5", label: "INT4 (0.5 B)" }]
    });
    var kvDtype = W.select(controls, {
      label: "KV dtype", value: "2",
      options: [{ value: "2", label: "BF16 (2 B)" }, { value: "1", label: "FP8 (1 B)" }]
    });

    /* Context in powers of two: the reader thinks in 8K / 32K /
       128K, and a linear slider over 256K would spend nine tenths
       of its travel in territory nobody deploys. */
    var ctxS = W.slider(controls, {
      label: "Working context", min: 10, max: 18, step: 1, value: 15,
      format: function (v) { return tokLabel(Math.pow(2, v)); }
    });

    var CONC = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
    var concS = W.slider(controls, {
      label: "Concurrent sequences", min: 0, max: CONC.length - 1, step: 1, value: 5,
      format: function (v) { return String(CONC[v]); }
    });

    var gpuSel = W.select(controls, {
      label: "GPU", value: "h100",
      options: GPUS.map(function (g) { return { value: g.id, label: g.label }; })
    });
    var countSel = W.select(controls, {
      label: "GPUs", value: "2",
      options: [1, 2, 4, 8].map(function (n) { return { value: String(n), label: "×" + n }; })
    });

    var mlaNote = document.createElement("p");
    mlaNote.className = "inf-result-note";
    mlaNote.style.margin = "0.8rem 0 0";
    body.appendChild(mlaNote);

    var results = div(body, "inf-results");
    var verdict = div(body, "inf-verdict");

    function loadPreset(id) {
      var m = findBy(MODELS, id);
      if (id === "custom" && customMem) m = customMem;
      cur = { P: m.P, layers: m.layers, kv: m.kv, dim: m.dim, q: m.q, mla: !!m.mla };
      fLayers.value = cur.layers;
      fKv.value = cur.kv;
      fDim.value = cur.dim;
      fP.value = cur.P;
    }

    /* Editing any architecture field means the reader has left the
       preset behind — say so rather than showing "Llama-3-70B"
       over numbers that are no longer Llama-3-70B. Leaving MLA
       this way also drops back to the GQA formula, which is
       correct: a hand-entered head count is a per-head cache. */
    function goCustom() {
      cur.layers = Math.max(1, Number(fLayers.value) || 1);
      cur.kv = Math.max(1, Number(fKv.value) || 1);
      cur.dim = Math.max(1, Number(fDim.value) || 1);
      cur.P = Math.max(0.01, Number(fP.value) || 0.01);
      cur.mla = false;
      cur.q = Math.max(cur.kv, cur.q || cur.kv);
      customMem = { P: cur.P, layers: cur.layers, kv: cur.kv, dim: cur.dim, q: cur.q };
      modelSel.value = "custom";
      render();
    }

    function render() {
      var g = findBy(GPUS, gpuSel.value);
      var n = Number(countSel.value);
      var wB = Number(wDtype.value);
      var kB = Number(kvDtype.value);
      var ctx = Math.pow(2, Number(ctxS.value));
      var conc = CONC[Number(concS.value)];

      var hbm = g.hbm * n;
      var weights = cur.P * wB;                       /* P in billions × bytes = GB */
      var fixed = (OVERHEAD_PER_GPU + ACTIVATION_PER_GPU) * n;
      var kvBpt = kvBytesPerToken(cur, kB);           /* bytes */
      var perSeq = kvBpt * ctx / 1e9;                 /* GB */
      var kvBatch = perSeq * conc;
      var pool = Math.max(0, hbm - weights - fixed) * HEADROOM;
      var needed = weights + fixed + kvBatch;
      var maxConc = perSeq > 0 ? Math.floor(pool / perSeq) : 0;
      var bCrit = (g.flops / g.bw) * (wB / 2);        /* ridge scales with bytes/weight */

      var kvFormula = cur.mla
        ? esc(cur.layers + " layers × " + cur.dim + " latent × " + kB + " B") +
          " — MLA keeps one compressed latent per token, so there is no ×2 and no head count. " + ATTN
        : esc("2 × " + cur.layers + " × " + cur.kv + " × " + cur.dim + " × " + kB + " B") +
          " — " + ARITH;

      mlaNote.innerHTML = cur.mla
        ? "<strong>MLA model.</strong> DeepSeek-V3 does not have a per-head KV cache; it stores a single " +
          esc(cur.dim) + "-wide latent per token per layer. This calculator uses that formula, not " +
          "<code>2 × layers × kv_heads × head_dim</code>, which would overstate the cache by about 8×. " +
          "Editing any field below drops back to the ordinary GQA formula."
        : "Memory budget per " + SIZING + ": " + OVERHEAD_PER_GPU + " GB/GPU framework and CUDA overhead, " +
          ACTIVATION_PER_GPU + " GB/GPU decode activations, and a ×" + HEADROOM +
          " headroom factor — vLLM's <code>gpu_memory_utilization</code> default.";

      var fits = needed <= hbm;
      results.innerHTML = tiles([
        { label: "Weights",
          value: gb(weights),
          note: esc(W.fmt(cur.P, cur.P < 10 ? 1 : 0) + "B params × " + wB + " B") + " — total parameters, never active. " + ARITH },
        { label: "KV per token",
          value: W.fmt(kvBpt / 1e3, kvBpt < 1e5 ? 1 : 0) + " KB",
          note: kvFormula },
        { label: "KV for the batch",
          value: gb(kvBatch),
          note: esc(gb(perSeq) + " × " + conc + " sequences at " + tokLabel(ctx) + " context") + ". " + SIZING },
        { label: "HBM needed",
          value: gb(needed) + " / " + gb(hbm),
          cls: fits ? "good" : "bad",
          note: fits
            ? "Fits, with " + esc(gb(hbm - needed)) + " unspent. Pool after headroom: " + esc(gb(pool)) + "."
            : "Over by " + esc(gb(needed - hbm)) + ". This deployment does not start, or starts and preempts forever." },
        { label: "Max concurrency",
          value: String(maxConc),
          cls: maxConc >= bCrit * 0.5 ? "good" : "bad",
          note: "<code>(HBM − weights − overhead − activations) × " + HEADROOM +
            " ÷ (kv/token × context)</code>. Against B_crit ≈ " + esc(W.fmt(bCrit, 0)) +
            " on this GPU. " + SIZING }
      ]);

      verdict.innerHTML = diagnose(g, n, hbm, weights, fixed, wB, kB, ctx, perSeq, pool, maxConc, bCrit);
    }

    /* The diagnosis. A concurrency number is not a verdict: the
       reader needs to know which of the three regimes from Sizing
       a Deployment they are in, and which single change moves the
       number most. So we actually re-run the budget under each
       free lever and rank them, rather than asserting a favourite.
       Adding GPUs is deliberately not a candidate — it always
       wins and it is the one lever that costs money. */
    function diagnose(g, n, hbm, weights, fixed, wB, kB, ctx, perSeq, pool, maxConc, bCrit) {
      var wFrac = weights / hbm;
      var cand = [];

      function concUnder(nextW, nextKvBytes, nextCtx) {
        var w = cur.P * nextW;
        var p = Math.max(0, hbm - w - fixed) * HEADROOM;
        var per = kvBytesPerToken(cur, nextKvBytes) * nextCtx / 1e9;
        return per > 0 ? Math.floor(p / per) : 0;
      }
      if (wB > 0.5) {
        var nw = wB === 2 ? 1 : 0.5;
        cand.push({
          n: concUnder(nw, kB, ctx),
          text: (wB === 2 ? "FP8" : "INT4") + " weights — frees " + gb(weights - cur.P * nw) + " of HBM"
        });
      }
      if (kB > 1) cand.push({ n: concUnder(wB, 1, ctx), text: "FP8 KV cache — halves the per-sequence cost to " + gb(perSeq / 2) });
      if (ctx > 1024) cand.push({
        n: concUnder(wB, kB, ctx / 2),
        text: "sizing for a " + tokLabel(ctx / 2) + " working context instead of " + tokLabel(ctx) +
          " — free, if that is what your p95 live sequence actually holds"
      });
      cand.sort(function (a, b) { return b.n - a.n; });
      var best = cand[0];
      var lever = best && best.n > maxConc
        ? " Biggest lever: <strong>" + best.text + "</strong>, taking you from " + maxConc +
          " concurrent sequence" + (maxConc === 1 ? "" : "s") + " to " + best.n + "."
        : " No single dtype or context change moves this much; the next lever is more GPUs, or a smaller model.";

      if (weights + fixed >= hbm) {
        return "<strong>It does not fit at all.</strong> The weights and fixed overhead alone want " +
          esc(gb(weights + fixed)) + " against " + esc(gb(hbm)) + " of HBM, so there is no KV pool to speak of. " +
          "Quantize the weights or raise the GPU count before you look at anything else." +
          (cur.P > 100 ? " (A 671B MoE occupies like a 671B model even though it computes like a 37B one — memory uses total parameters.)" : "");
      }
      if (wFrac > 0.60) {
        return "<strong>Weight-bound.</strong> The weights alone take " + esc(W.fmt(wFrac * 100, 0)) +
          "% of your HBM, leaving a " + esc(gb(pool)) + " pool against " + esc(gb(perSeq)) +
          " per sequence. Symptoms in production: a tiny running batch, constant preemption, and throughput " +
          "that collapses the moment a second user arrives." + lever;
      }
      if (maxConc < bCrit * 0.5) {
        return "<strong>KV-bound.</strong> Weights are only " + esc(W.fmt(wFrac * 100, 0)) +
          "% of HBM, so the pool is healthy — but one sequence costs " + esc(gb(perSeq)) +
          " and the pool holds " + maxConc + " of them, well below B_crit ≈ " + esc(W.fmt(bCrit, 0)) +
          ". You are memory-bound and cannot batch your way up to the ridge, so you are paying for FLOPs you " +
          "can never reach." + lever;
      }
      return "<strong>Comfortable.</strong> " + maxConc + " concurrent sequences against a B_crit of ≈" +
        esc(W.fmt(bCrit, 0)) + " — the concurrency your capacity allows is in the same neighbourhood as the " +
        "concurrency your FLOPs want, which is what a well-shaped deployment looks like. Stop chasing KV " +
        "capacity: cap the running batch near the ridge and spend surplus HBM on a larger prefix cache (" +
        PAGED + ") rather than a larger batch.";
    }

    modelSel.addEventListener("change", function () { loadPreset(modelSel.value); render(); });
    [fLayers, fKv, fDim, fP].forEach(function (f) { f.addEventListener("input", goCustom); });
    [wDtype, kvDtype, gpuSel, countSel].forEach(function (s) { s.addEventListener("change", render); });
    [ctxS, concS].forEach(function (s) { s.addEventListener("input", render); });

    loadPreset("llama3-70b");
    render();
  });

  /* ============================================================
     TOOL 2 — roofline-explorer
     ============================================================ */

  W.define("roofline-explorer", function (el) {
    var body = shell(el, "Roofline explorer",
      "Llama-3-70B, idealized on one device. Move the controls and watch which roof you are under.");

    var controls = div(body, "inf-controls");

    var gpuSel = W.select(controls, {
      label: "GPU", value: "h100",
      options: GPUS.map(function (g) { return { value: g.id, label: g.label }; })
    });
    var modeSel = W.select(controls, {
      label: "Phase", value: "decode",
      options: [{ value: "decode", label: "Decode (one token per step)" }, { value: "prefill", label: "Prefill (whole prompt at once)" }]
    });
    var precSel = W.select(controls, {
      label: "Weight precision", value: "2",
      options: [{ value: "2", label: "BF16 (2 B)" }, { value: "1", label: "FP8 (1 B)" }, { value: "0.5", label: "INT4 (0.5 B)" }]
    });

    var BATCH = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];
    var batchS = W.slider(controls, {
      label: "Batch size", min: 0, max: BATCH.length - 1, step: 1, value: 0,
      format: function (v) { return String(BATCH[v]); }
    });
    var seqS = W.slider(controls, {
      label: "Sequence length", min: 7, max: 17, step: 1, value: 10,
      format: function (v) { return tokLabel(Math.pow(2, v)); }
    });

    var cv = W.canvas(body, 0.55);
    var caption = div(body, "inf-verdict");
    var results = div(body, "inf-results");

    /* The reference model. Fixed rather than a control, because
       the roofline's shape is a property of the hardware and the
       phase; swapping the model only slides the dot. */
    var M = { P: 70e9, layers: 80, kv: 8, dim: 128, q: 64 };
    var GROUP = M.q / M.kv; /* GQA group size: query heads sharing one KV head */

    /* x: arithmetic intensity, 0.1 → 10,000 FLOP/byte.
       y: attainable FLOP/s, 10 GFLOP/s → 10 PFLOP/s. Both axes
       are fixed so that changing GPU visibly moves the roofs
       rather than silently rescaling underneath them. */
    var X0 = -1, X1 = 4, Y0 = 10, Y1 = 16;

    function state() {
      var g = findBy(GPUS, gpuSel.value);
      var bpp = Number(precSel.value);
      /* KV rarely goes below 8-bit in practice, so INT4 weights
         are paired with an FP8 cache rather than a 4-bit one. */
      var kvB = bpp >= 2 ? 2 : 1;
      var B = BATCH[Number(batchS.value)];
      var T = Math.pow(2, Number(seqS.value));
      var kvBpt = 2 * M.layers * M.kv * M.dim * kvB;
      var wBytes = M.P * bpp;
      var prefill = modeSel.value === "prefill";
      var bytes, flops, perTokenDivisor, kvBytes;

      if (prefill) {
        /* Every weight read serves all T prompt tokens, so
           intensity ≈ 2T/bytes_per_param. Attention's own cost is
           quadratic in T and shows up as pure FLOPs — with
           FlashAttention the KV never leaves SRAM, so the only
           extra bytes are the cache being written once. */
        kvBytes = T * kvBpt;
        var attnFlops = 2 * T * T * M.q * M.dim * M.layers; /* causal, so half of 4·T²·d */
        bytes = wBytes + kvBytes;
        flops = 2 * M.P * T + attnFlops;
        perTokenDivisor = T;
      } else {
        /* Decode. Weight bytes are read once and shared by the
           whole batch, so the weight term's intensity is ≈ 2B/bpp.
           KV bytes are not shared by anything: each sequence reads
           its own cache to serve its own query, so that term grows
           with B×context and never amortizes. Each KV element is
           consumed by GROUP query heads at 4 FLOPs each (QKᵀ then
           PV), which pins attention's intensity at 4·GROUP/kv_bytes
           — 16 FLOP/byte here, far under every ridge on the list.
           That constant is why the dot stops climbing. */
        kvBytes = B * T * kvBpt;
        bytes = wBytes + kvBytes;
        flops = 2 * M.P * B + (kvBytes / kvB) * 4 * GROUP;
        perTokenDivisor = 1;
      }

      var I = flops / bytes;
      var attain = Math.min(g.flops, I * g.bw);
      var ridge = g.flops / g.bw;
      var t = Math.max(bytes / g.bw, flops / g.flops);
      return {
        g: g, I: I, ridge: ridge, attain: attain, bpp: bpp, B: B, T: T,
        prefill: prefill, bytes: bytes, kvBytes: kvBytes, wBytes: wBytes,
        ms: t * 1000 / perTokenDivisor, bcrit: ridge * bpp / 2
      };
    }

    function draw(s) {
      var d = cv.size(), p = W.palette(), ctx = cv.ctx;
      var L = 58, R = 14, T = 16, Bm = 34;
      var pw = d.w - L - R, ph = d.h - T - Bm;
      if (pw <= 10 || ph <= 10) return;

      function px(i) { return L + (Math.log(i) / Math.LN10 - X0) / (X1 - X0) * pw; }
      function py(f) { return T + (Y1 - Math.log(f) / Math.LN10) / (Y1 - Y0) * ph; }
      function clampx(v) { return Math.max(L, Math.min(L + pw, v)); }

      ctx.clearRect(0, 0, d.w, d.h);
      ctx.fillStyle = p.panel;
      ctx.fillRect(L, T, pw, ph);

      var ridgeX = px(s.ridge);

      /* Zones first, so the roof and the grid sit on top. */
      ctx.save();
      ctx.beginPath();
      ctx.rect(L, T, Math.max(0, Math.min(ridgeX, L + pw) - L), ph);
      ctx.clip();
      ctx.fillStyle = p.warn;
      ctx.globalAlpha = 0.10;
      ctx.fillRect(L, T, pw, ph);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(L, Math.min(ridgeX, L + pw)), T, Math.max(0, L + pw - ridgeX), ph);
      ctx.clip();
      ctx.fillStyle = p.good;
      ctx.globalAlpha = 0.10;
      ctx.fillRect(L, T, pw, ph);
      ctx.restore();

      /* Grid + axis labels. */
      ctx.strokeStyle = p.rule;
      ctx.lineWidth = 1;
      ctx.fillStyle = p.faint;
      ctx.font = "11px 'SF Mono', Menlo, Consolas, monospace";
      var xl = ["0.1", "1", "10", "100", "1K", "10K"];
      for (var e = X0; e <= X1; e++) {
        var x = Math.round(px(Math.pow(10, e))) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
        ctx.textAlign = "center";
        ctx.fillText(xl[e - X0], x, T + ph + 15);
      }
      var yl = { 10: "10 G", 11: "100 G", 12: "1 T", 13: "10 T", 14: "100 T", 15: "1 P", 16: "10 P" };
      for (var f = Y0; f <= Y1; f++) {
        var y = Math.round(py(Math.pow(10, f))) + 0.5;
        ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(yl[f], L - 7, y + 4);
      }
      ctx.fillStyle = p.dim;
      ctx.textAlign = "center";
      ctx.font = "11px 'SF Mono', Menlo, Consolas, monospace";
      ctx.fillText("arithmetic intensity (FLOP/byte)", L + pw / 2, T + ph + 29);
      ctx.save();
      ctx.translate(12, T + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("attainable FLOP/s", 0, 0);
      ctx.restore();

      /* The roof: sloped at the bandwidth, flat at the compute
         peak, meeting at the ridge. */
      ctx.strokeStyle = p.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px(0.1), py(0.1 * s.g.bw));
      ctx.lineTo(clampx(ridgeX), py(s.g.flops));
      ctx.lineTo(L + pw, py(s.g.flops));
      ctx.stroke();

      /* Ridge marker. */
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = p.dim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(clampx(ridgeX), py(s.g.flops));
      ctx.lineTo(clampx(ridgeX), T + ph);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = p.dim;
      ctx.textAlign = "left";
      ctx.font = "11px 'SF Mono', Menlo, Consolas, monospace";
      ctx.fillText("ridge " + W.fmt(s.ridge, 0), Math.min(clampx(ridgeX) + 6, L + pw - 74), T + 14);
      ctx.textAlign = "left";
      ctx.fillStyle = p.warn;
      ctx.fillText("memory-bound", L + 8, T + ph - 10);
      ctx.textAlign = "right";
      ctx.fillStyle = p.good;
      ctx.fillText("compute-bound", L + pw - 8, T + ph - 10);

      /* The operating point, with drop lines so it can be read
         off both axes without a tooltip. */
      var dx = clampx(px(Math.max(0.1, Math.min(1e4, s.I))));
      var dy = Math.max(T, Math.min(T + ph, py(s.attain)));
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = p.accent;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(dx, dy); ctx.lineTo(dx, T + ph);
      ctx.moveTo(dx, dy); ctx.lineTo(L, dy);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = p.accent;
      ctx.beginPath();
      ctx.arc(dx, dy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.bg;
      ctx.lineWidth = 2;
      ctx.stroke();

      var tag = (s.prefill ? "prefill" : "decode") + " · I=" + W.fmt(s.I, s.I < 10 ? 2 : 0);
      ctx.fillStyle = p.ink;
      ctx.font = "12px 'SF Mono', Menlo, Consolas, monospace";
      ctx.textAlign = dx > L + pw * 0.6 ? "right" : "left";
      ctx.fillText(tag, dx + (dx > L + pw * 0.6 ? -12 : 12), dy - 10);
    }

    function render() {
      var s = state();
      draw(s);

      var pctPeak = s.attain / s.g.flops * 100;
      var below = s.ridge / s.I;
      var line;
      if (s.I < s.ridge) {
        line = "<strong>Memory-bound</strong> — " + esc(W.fmt(below, below < 10 ? 1 : 0)) +
          "× below the ridge, using " + esc(W.fmt(pctPeak, pctPeak < 10 ? 2 : 1)) +
          "% of peak FLOPs. " + (s.prefill
            ? "Even prefill sits here when the prompt is short: too few tokens share each weight read."
            : "Decode latency here is bytes ÷ bandwidth; adding FLOPs would change nothing.");
      } else {
        line = "<strong>Compute-bound</strong> at " + esc(W.fmt(pctPeak, 0)) +
          "% of peak — you are now FLOP-limited, and each added request costs latency rather than riding " +
          "along free. " + (s.prefill
            ? "This is the normal home of prefill, and why TTFT grows with prompt length."
            : "Past B_crit the free-lunch region of batching is behind you.");
      }
      if (!s.prefill && s.kvBytes > s.wBytes) {
        line += " <strong>KV traffic now exceeds weight traffic</strong> (" + esc(gb(s.kvBytes / 1e9)) +
          " against " + esc(gb(s.wBytes / 1e9)) + " per step): each sequence reads its own cache, so this " +
          "term never amortizes across the batch. The dot has stopped climbing with B — attention does " +
          "not batch away.";
      }
      caption.innerHTML = line;

      results.innerHTML = tiles([
        { label: "Intensity", value: W.fmt(s.I, s.I < 10 ? 2 : 0) + " FLOP/B",
          note: s.prefill
            ? "≈ 2·T ÷ bytes_per_param: each weight read serves the whole prompt. " + ARITH
            : "≈ 2·B ÷ bytes_per_param, dragged back down by unamortized KV reads. " + ARITH },
        { label: "Ridge", value: W.fmt(s.ridge, 0) + " FLOP/B",
          note: "<code>peak FLOP/s ÷ peak byte/s</code> — a hardware constant. At this precision that is a " +
            "critical batch size of ≈" + esc(W.fmt(s.bcrit, 0)) + ". " + ARITH },
        { label: "Attainable", value: flopsLabel(s.attain),
          cls: s.I >= s.ridge ? "good" : "bad",
          note: "<code>min(peak, I × bandwidth)</code> — " + esc(W.fmt(s.attain / s.g.flops * 100, 1)) +
            "% of this GPU's " + esc(flopsLabel(s.g.flops)) + " dense peak." },
        { label: s.prefill ? "Prefill ms/token" : "ms per token",
          value: W.fmt(s.ms, s.ms < 10 ? 2 : 1) + " ms",
          note: s.prefill
            ? "Whole-prompt time ÷ prompt length — multiply by the prompt to get TTFT. " + ARITH
            : "One decode step, i.e. TPOT for every sequence in the batch. " + ARITH }
      ]);
    }

    [gpuSel, modeSel, precSel].forEach(function (s) { s.addEventListener("change", render); });
    [batchS, seqS].forEach(function (s) { s.addEventListener("input", render); });
    bindWindow(el, "inf-theme", render);
    bindWindow(el, "resize", render);
    render();
  });

  /* ============================================================
     TOOL 3 — cost-calculator
     ============================================================ */

  W.define("cost-calculator", function (el) {
    var body = shell(el, "What does a token cost?",
      "The bill is GPU-hours ÷ tokens. Two dials move it more than the sticker price does.");

    var controls = div(body, "inf-controls");

    var priceS = W.slider(controls, {
      label: "$ per GPU-hour", min: 1, max: 12, step: 0.05, value: 2.5,
      format: function (v) { return "$" + v.toFixed(2); }
    });
    var tpsS = W.slider(controls, {
      label: "Tokens/s per GPU", min: 100, max: 5000, step: 50, value: 1500,
      format: function (v) { return W.fmt(v, 0); }
    });
    var utilS = W.slider(controls, {
      label: "Fleet utilisation", min: 5, max: 95, step: 1, value: 40,
      format: function (v) { return v + "%"; }
    });
    var volS = W.slider(controls, {
      label: "Tokens per month", min: 6, max: 10, step: 0.05, value: 10,
      format: function (v) {
        var n = Math.pow(10, v);
        return n >= 1e9 ? W.fmt(n / 1e9, 1) + "B" : n >= 1e6 ? W.fmt(n / 1e6, 0) + "M" : W.fmt(n, 0);
      }
    });
    var hitS = W.slider(controls, {
      label: "Prefix cache hit rate", min: 0, max: 95, step: 1, value: 60,
      format: function (v) { return v + "%"; }
    });
    var RATIOS = [1, 3, 5, 10, 20, 50, 100, 267];
    var ratioS = W.slider(controls, {
      label: "Input : output ratio", min: 0, max: RATIOS.length - 1, step: 1, value: 4,
      format: function (v) { return RATIOS[v] + ":1"; }
    });

    var why = document.createElement("p");
    why.className = "inf-result-note";
    why.style.margin = "0.8rem 0 0";
    why.innerHTML = "The default 20:1 is an agent's shape, not a chat's. An agent re-sends its entire " +
      "growing context every iteration — system prompt, tool schemas, every prior step — while emitting " +
      "one small tool call, so input dwarfs output; ratios as high as 267:1 are reported (" + AGENTIC +
      "). That is also why the hit-rate slider below has more leverage than anything else on this panel.";
    body.appendChild(why);

    var cv = W.canvas(body, 0.30);
    var results = div(body, "inf-results");
    var verdict = div(body, "inf-verdict");

    /* Relative GPU work per token, all from spec §6:
       an output token is ~5× an input token (decode is serial and
       memory-bound where prefill is parallel and compute-bound),
       and a cached input token is ~10× cheaper than a fresh one
       (its KV was computed once and is being re-read). */
    var OUT_PREMIUM = 5;
    var CACHED = 0.10;

    function work(h, r) {
      var fin = r / (r + 1), fout = 1 / (r + 1);
      return fin * ((1 - h) + h * CACHED) + fout * OUT_PREMIUM;
    }

    function state() {
      var price = Number(priceS.value);
      var tps = Number(tpsS.value);
      var util = Number(utilS.value) / 100;
      var vol = Math.pow(10, Number(volS.value));
      var h = Number(hitS.value) / 100;
      var r = RATIOS[Number(ratioS.value)];
      var base = 1e6 * price / (tps * 3600 * util); /* $ per 1M tokens, no cache */
      var scale = work(h, r) / work(0, r);
      var volM = vol / 1e6;
      return {
        price: price, tps: tps, util: util, vol: vol, h: h, r: r,
        base: base, eff: base * scale, scale: scale, volM: volM,
        bill0: base * volM, bill: base * scale * volM,
        outShare: (1 / (r + 1)) * OUT_PREMIUM / work(0, r)
      };
    }

    function draw(s) {
      var d = cv.size(), p = W.palette(), ctx = cv.ctx;
      var L = 54, R = 12, T = 12, Bm = 26;
      var pw = d.w - L - R, ph = d.h - T - Bm;
      if (pw <= 10 || ph <= 10) return;
      var top = s.bill0 * 1.05;
      function px(h) { return L + h / 0.95 * pw; }
      function py(v) { return T + (1 - v / top) * ph; }

      ctx.clearRect(0, 0, d.w, d.h);
      ctx.fillStyle = p.panel;
      ctx.fillRect(L, T, pw, ph);

      ctx.strokeStyle = p.rule;
      ctx.lineWidth = 1;
      ctx.fillStyle = p.faint;
      ctx.font = "11px 'SF Mono', Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      for (var i = 0; i <= 95; i += 19) {
        var x = Math.round(px(i / 100)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
        ctx.fillText(i + "%", x, T + ph + 16);
      }
      ctx.textAlign = "right";
      [0, 0.5, 1].forEach(function (f) {
        var y = Math.round(py(top * f)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
        ctx.fillText(money(top * f), L - 6, y + 4);
      });

      /* The curve. It is not a straight line: past ~80% the
         uncacheable decode share flattens it out, which is the
         honest shape of the lever. */
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var k = 0; k <= 95; k++) {
        var v = s.base * (work(k / 100, s.r) / work(0, s.r)) * s.volM;
        var xx = px(k / 100), yy = py(v);
        if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();

      var cx = px(s.h), cy = py(s.bill);
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = p.dim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, T + ph);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = p.good;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.bg;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = p.dim;
      ctx.font = "11px 'SF Mono', Menlo, Consolas, monospace";
      ctx.textAlign = "left";
      ctx.fillText("monthly bill vs prefix-cache hit rate", L + 8, T + 14);
    }

    function render() {
      var s = state();
      draw(s);
      var mult = s.bill0 / s.bill;
      var ceiling = 1 / (work(1, s.r) / work(0, s.r));

      results.innerHTML = tiles([
        { label: "$ / 1M tokens", value: money(s.base),
          note: "<code>$/GPU-hr ÷ (tok/s × 3600 × utilisation)</code>, no cache. " + ARITH },
        { label: "Effective $ / 1M", value: money(s.eff),
          cls: "good",
          note: "with " + esc(W.fmt(s.h * 100, 0)) + "% of input served from cache at 0.1× the fresh price. " + PAGED },
        { label: "Bill at 0% hit rate", value: money(s.bill0),
          cls: "bad",
          note: esc(W.fmt(s.vol / 1e9, 2)) + "B tokens/month with every prefix recomputed from scratch." },
        { label: "Bill at " + W.fmt(s.h * 100, 0) + "% hit rate", value: money(s.bill),
          cls: "good",
          note: esc(W.fmt(mult, 2)) + "× cheaper, saving " + esc(money(s.bill0 - s.bill)) +
            " a month. The ceiling at this traffic mix is " + esc(W.fmt(ceiling, 1)) + "×. " + AGENTIC },
        { label: "Uncacheable share", value: W.fmt(s.outShare * 100, 0) + "%",
          note: "of the bill is output tokens — decode, at ~5× an input token, and no cache touches it. " +
            "That share is what caps the multiplier on its left." }
      ]);

      /* Rank the levers by what each is actually worth in dollars
         rather than asserting that utilisation always wins. */
      var cand = [];
      if (s.util < 0.60) cand.push({
        save: s.bill - s.bill * s.util / 0.60,
        text: "<strong>fleet utilisation</strong> — lifting it from " + W.fmt(s.util * 100, 0) +
          "% to a realistic 60% cuts the bill to " + money(s.bill * s.util / 0.60) +
          ", because you are already paying for those GPU-hours whether or not they serve anyone"
      });
      if (s.h < 0.85) cand.push({
        save: s.bill - s.base * (work(0.85, s.r) / work(0, s.r)) * s.volM,
        text: "<strong>prefix-cache hit rate</strong> — getting from " + W.fmt(s.h * 100, 0) +
          "% to the 85% that agent loops and repo-QA routinely reach takes the bill to " +
          money(s.base * (work(0.85, s.r) / work(0, s.r)) * s.volM)
      });
      if (s.price > 1.8) cand.push({
        save: s.bill * (1 - 1.8 / s.price),
        text: "<strong>the GPU-hour itself</strong> — a $1.80 neocloud hour instead of $" + s.price.toFixed(2) +
          " saves " + money(s.bill * (1 - 1.8 / s.price)) + "/month, though this is the lever with the least headroom"
      });
      cand.sort(function (a, b) { return b.save - a.save; });

      var v = cand.length
        ? "Biggest lever: " + cand[0].text + " (≈" + money(cand[0].save) + "/month)."
        : "Both dials are already near their practical ceiling; from here the levers are a cheaper GPU-hour, " +
          "a faster serving stack, or a smaller model.";
      if (s.r >= 100 && s.h >= 0.85) {
        v += " Note the shape of the curve: it is nearly flat up here. Hit rate is the strongest lever in " +
          "the system precisely because it is so weak at the far end — the first 60 points buy most of it.";
      }
      verdict.innerHTML = v;
    }

    [priceS, tpsS, utilS, volS, hitS, ratioS].forEach(function (s) { s.addEventListener("input", render); });
    bindWindow(el, "inf-theme", render);
    bindWindow(el, "resize", render);
    render();
  });
})();
