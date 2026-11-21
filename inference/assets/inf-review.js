/* ============================================================
   Inference Engineering — the review deck.

   A spaced-repetition deck that never asks the same thing twice.
   Every card is a *generator*: it draws a fresh model, context
   length or price sheet and asks for one number, so recalling last
   week's answer is useless and only the method transfers. Each
   generator names the chapter that teaches its formula; the deck
   only deals cards from chapters the reader has completed.

     generator = { id, chapter, title, draw(rng) → inputs,
                   solve(inputs) → { prompt, answer, unit,
                                     tolerance, solution },
                   make(rng) = solve(draw(rng)) }

   `solve` is separate from `draw` so a test can feed the running
   case's inputs and pin the formula to inference/research/case.md.
   `rng` is a seeded PRNG; nothing inside make() touches
   Math.random, so a seed reproduces a card exactly.

   Scheduling is Leitner: boxes 1–5, intervals 1, 3, 7, 16, 35 days,
   kept in localStorage under "inf-review-v1" as
   { [generatorId]: { box, due, seen, right } }. A card never seen
   is in box 1 and due now; right → next box, wrong → box 1, due
   tomorrow.

   Two mounts of one widget, `review`:
     data-mode="deck"    the review page (content/review.md)
     data-mode="warmup"  ≤ 3 due cards from earlier chapters, in a
                         collapsed <details> at the top of a chapter.
                         The placeholder is injected here, not
                         authored in the markdown (see the bottom).

   Units, as in inf-calculators.js: GB, MB and KB are decimal.
   The file also loads under plain Node (tests/tier1/review.test.js):
   everything that touches the DOM sits behind a `document` guard.
   ============================================================ */

(function (root) {
  "use strict";

  /* ---------------- number formatting ---------------- */

  function commas(str) {
    var neg = str.charAt(0) === "-";
    if (neg) str = str.slice(1);
    var parts = str.split(".");
    var head = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + head + (parts.length > 1 ? "." + parts[1] : "");
  }

  function trimZeros(s) {
    if (s.indexOf(".") === -1 || /e/i.test(s)) return s;
    return s.replace(/0+$/, "").replace(/\.$/, "");
  }

  /* A result, at the precision a back-of-envelope answer deserves. */
  function n(x) {
    if (!isFinite(x)) return String(x);
    var a = Math.abs(x);
    if (a >= 100) return commas(x.toFixed(0));
    if (a >= 10) return commas(trimZeros(x.toFixed(1)));
    if (a >= 1) return trimZeros(x.toFixed(2));
    if (a === 0) return "0";
    return trimZeros(x.toPrecision(3));
  }

  /* An input, exactly as the generator holds it (inputs are nice values). */
  function v(x) {
    if (Number.isInteger(x)) return commas(String(x));
    return commas(trimZeros(x.toFixed(4)));
  }

  /* A fraction as a percentage input: 0.4 → "40". */
  function pc(f) { return v(Math.round(f * 1e6) / 1e4); }

  /* A price input: $2.50, not $2.5. */
  function usd(x) { return "$" + (Number.isInteger(x) ? commas(String(x)) : commas(x.toFixed(2))); }

  /* "a" or "an" before a number as it is read aloud: an 8B, an 11,000, a 1,100. */
  function a(x) {
    var g = v(x).split(/[,.]/)[0];
    return (g.charAt(0) === "8" || g === "11" || g === "18") ? "an" : "a";
  }
  function A(x) { return a(x) === "an" ? "An" : "A"; }

  function withUnit(x, unit) {
    var s = n(x);
    if (!unit) return s;
    if (unit === "%") return s + "%";
    if (unit === "×") return s + "×";
    if (unit.charAt(0) === "$") return "$" + s + unit.slice(1);
    return s + " " + unit;
  }

  /* ---------------- seeded randomness ---------------- */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function rint(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }

  /* ---------------- shared vocabulary ---------------- */

  /* gpu-mental-model.md's table (dense BF16, nameplate), plus the A100
     inf-calculators.js already uses. */
  var CHIPS = [
    { name: "H100 SXM",  tf: 990,  bw: 3.35, gb: 80 },
    { name: "H200",      tf: 990,  bw: 4.8,  gb: 141 },
    { name: "B200",      tf: 2250, bw: 8.0,  gb: 192 },
    { name: "A100 80GB", tf: 312,  bw: 2.0,  gb: 80 }
  ];
  var BF16 = { name: "BF16", bytes: 2 };
  var FP8 = { name: "FP8", bytes: 1 };
  var INT4 = { name: "4-bit (INT4)", bytes: 0.5 };
  var KV_DTYPES = [BF16, FP8];
  var W_DTYPES = [BF16, FP8, INT4];
  var PARAMS = [8, 14, 32, 70, 123, 405];

  function bytesWord(b) { return b === 1 ? "1 byte" : v(b) + " bytes"; }

  /* Smallest power-of-two TP that leaves a quarter of each GPU for KV. */
  function tpFor(P, bytes, chip) {
    var tps = [1, 2, 4, 8];
    for (var i = 0; i < tps.length; i++) {
      if (P * bytes / tps[i] <= 0.75 * chip.gb) return tps[i];
    }
    return 0;
  }
  /* A (model, dtype, chip, TP) that actually fits on one node. */
  function drawDeployment(rng, dtypes, params) {
    for (var guard = 0; guard < 50; guard++) {
      var P = pick(rng, params || PARAMS), dt = pick(rng, dtypes), chip = pick(rng, CHIPS);
      var tp = tpFor(P, dt.bytes, chip);
      if (tp) return { P: P, dt: dt, chip: chip, tp: tp };
    }
    return { P: 70, dt: BF16, chip: CHIPS[0], tp: 4 };
  }
  function gpusPhrase(tp, chip) {
    return tp === 1 ? "one " + chip.name : tp + " × " + chip.name;
  }

  function lines() { return Array.prototype.slice.call(arguments).filter(Boolean).join("\n"); }

  /* ---------------- the formulas, callable with explicit inputs ----------------
     Every generator below calls into these, and the tier-1 test pins
     them to case.md. Inputs in the units the course quotes. */

  var F = {
    /* what-is-inference: a token is about ¾ of an English word */
    tokensFromWords: function (words) { return words / 0.75; },
    /* inside-a-forward-pass: billions of params × bytes per param = GB */
    weightGB: function (Pb, bytes) { return Pb * bytes; },
    paramCount: function (c) {
      var attn = 2 * c.d * (c.q * c.hd) + 2 * c.d * (c.kv * c.hd);
      var mlp = 3 * c.d * c.ffn;
      return c.layers * (attn + mlp) + 2 * c.vocab * c.d;
    },
    kvBytesPerToken: function (layers, kvHeads, headDim, bytes) {
      return 2 * layers * kvHeads * headDim * bytes;
    },
    /* GB ÷ TB/s = ms */
    decodeFloorMs: function (gbPerGpu, tbps) { return gbPerGpu / tbps; },
    prefillMs: function (Pb, tokens, gpus, tflops, mfu) {
      return 2 * Pb * 1e9 * tokens / (gpus * tflops * 1e12 * mfu) * 1e3;
    },
    /* tokens per step at which decode reaches the ridge */
    criticalBatch: function (tflops, tbps, bytesPerWeight) {
      return (tflops / tbps) * (bytesPerWeight === undefined ? 2 : bytesPerWeight) / 2;
    },
    msPerToken: function (Pb, gpus, tflops, mfu) {
      return 2 * Pb * 1e9 / (gpus * tflops * 1e12 * mfu) * 1e3;
    },
    /* case.md: step ≈ max(t_w, t_c) + t_kv — one model, not two */
    stepMs: function (tw, msPerTok, tokens, tkv) { return Math.max(tw, tokens * msPerTok) + tkv; },
    chunkFromItl: function (itl, msPerTok, decodes, tkv) { return (itl - tkv) / msPerTok - decodes; },
    little: function (rate, seconds) { return rate * seconds; },
    /* vLLM v0.34: --gpu-memory-utilization is a fraction of *total* memory */
    kvPoolGB: function (totalGB, f, weightsGB, otherGB) { return f * totalGB - weightsGB - otherGB; },
    maxSequences: function (poolGB, kvBytesPerTok, tokens) {
      return Math.floor(poolGB * 1e9 / (kvBytesPerTok * tokens) + 1e-9);
    },
    fullBlocks: function (tokens, blockSize) { return Math.floor(tokens / blockSize); },
    specExpected: function (alpha, gamma) { return (1 - Math.pow(alpha, gamma + 1)) / (1 - alpha); },
    specSpeedup: function (alpha, gamma, c) { return F.specExpected(alpha, gamma) / (1 + c * gamma); },
    allReducesPerToken: function (layers) { return 2 * layers; },
    expertsTouched: function (k, N, B) { return 1 - Math.pow(1 - k / N, B); },
    transferMs: function (gb, gbps) { return gb / gbps * 1e3; },
    costPerMillion: function (dollarsPerHour, tokPerS, util) {
      return dollarsPerHour / (tokPerS * 3600 * util) * 1e6;
    },
    breakevenUtil: function (dollarsPerHour, tokPerS, pricePerM) {
      return dollarsPerHour / (tokPerS * 3600 * pricePerM / 1e6);
    },
    /* per-request API cost; `cachedFrac` of input billed at `pCached` */
    apiPerRequest: function (inTok, outTok, pIn, pOut, cachedFrac, pCached) {
      var h = cachedFrac || 0;
      return (inTok * ((1 - h) * pIn + h * (pCached || 0)) + outTok * pOut) / 1e6;
    },
    apiMonthly: function (reqPerDay, inTok, outTok, pIn, pOut, cachedFrac, pCached, days) {
      return reqPerDay * (days || 30) * F.apiPerRequest(inTok, outTok, pIn, pOut, cachedFrac, pCached);
    },
    nodeMonthly: function (gpus, dollarsPerGpuHour) { return gpus * dollarsPerGpuHour * 730; },
    kvReadMs: function (kvBytesPerTokPerGpu, achievedTBps, contextTokens) {
      return kvBytesPerTokPerGpu * contextTokens / (achievedTBps * 1e12) * 1e3;
    }
  };

  /* ---------------- the generators ---------------- */

  var G = [];
  function gen(def) {
    def.make = function (rng) { return def.solve(def.draw(rng)); };
    G.push(def);
  }
  function out(prompt, answer, unit, solution, tolerance) {
    return { prompt: prompt, answer: answer, unit: unit, solution: solution,
             tolerance: tolerance === undefined ? 0.10 : tolerance };
  }

  /* ---- What Actually Happens When You Call an LLM ---- */

  gen({
    id: "words-to-tokens", chapter: "what-is-inference", title: "Words to tokens",
    draw: function (r) {
      return { sys: pick(r, [400, 800, 1200, 2000]), doc: pick(r, [600, 900, 1500, 2400, 3000, 4500]),
               q: pick(r, [15, 30, 45, 60]) };
    },
    solve: function (i) {
      var user = F.tokensFromWords(i.doc + i.q), total = i.sys + user;
      return out(
        "An assistant puts the same " + v(i.sys) + "-token system prompt in front of every request. " +
        "A user pastes a " + v(i.doc) + "-word report and types a " + i.q + "-word question. " +
        "A token is about ¾ of an English word. Roughly how many input tokens does the model see?",
        total, "tokens",
        lines("Tokens are smaller than words, so the count goes up: divide by 0.75 (≈ 1.33 tokens per word).",
              "(" + v(i.doc) + " + " + i.q + ") words ÷ 0.75 ≈ " + n(user) + " tokens",
              "+ " + v(i.sys) + " system-prompt tokens ≈ " + n(total) + " tokens"));
    }
  });

  gen({
    id: "stream-time", chapter: "what-is-inference", title: "How long the answer takes",
    draw: function (r) {
      return { words: pick(r, [150, 300, 450, 600, 900]), ttft: pick(r, [0.3, 0.5, 0.8, 1.2]),
               tpot: pick(r, [20, 25, 40, 50, 60]) };
    },
    solve: function (i) {
      var tok = F.tokensFromWords(i.words), dec = tok * i.tpot / 1000, t = i.ttft + dec;
      return out(
        "A chat answer runs to about " + i.words + " words. The service shows TTFT " + v(i.ttft) +
        " s and TPOT " + i.tpot + " ms. A token is about ¾ of a word. About how many seconds after " +
        "pressing Enter does the last word arrive?",
        t, "s",
        lines("Output tokens ≈ " + i.words + " ÷ 0.75 ≈ " + n(tok),
              "Decode ≈ " + n(tok) + " × " + i.tpot + " ms ≈ " + n(dec) + " s",
              "Total ≈ TTFT + decode = " + v(i.ttft) + " + " + n(dec) + " ≈ " + n(t) + " s"));
    }
  });

  gen({
    id: "percentile-promise", chapter: "what-is-inference", title: "What a percentile promises",
    draw: function (r) {
      return { variant: pick(r, ["count", "user"]), p: pick(r, [95, 99]),
               N: pick(r, [1000, 4000, 12000, 50000]), k: pick(r, [10, 20, 30, 50]),
               x: pick(r, [1, 1.5, 2]), ms: pick(r, [40, 50, 60]) };
    },
    solve: function (i) {
      if (i.variant === "count") {
        var c = i.N * (100 - i.p) / 100;
        return out(
          "A service promises TTFT p" + i.p + " ≤ " + v(i.x) + " s. It handles " + v(i.N) +
          " requests a day. How many of them may be slower than " + v(i.x) + " s with the promise still kept?",
          c, "requests",
          lines("p" + i.p + " ≤ X means " + i.p + "% of requests finish at or under X; up to " + (100 - i.p) + "% may not.",
                v(i.N) + " × " + (100 - i.p) + "% = " + n(c) + " requests",
                "The promise says nothing about how slow those are."));
      }
      var fine = Math.pow(i.p / 100, i.k), pct = (1 - fine) * 100;
      return out(
        "A service keeps its promise TPOT p" + i.p + " ≤ " + i.ms + " ms. An employee sends " + i.k +
        " requests in a day. If slow requests strike independently, what is the chance, in percent, " +
        "that at least one of theirs is slower than " + i.ms + " ms?",
        pct, "%",
        lines("P(one request is fine) = " + (i.p / 100) + "; P(all " + i.k + " fine) = " + (i.p / 100) + "^" + i.k + " ≈ " + n(fine),
              "P(at least one slow) = 1 − " + n(fine) + " ≈ " + n(pct) + "%",
              "A heavy user meets the tail routinely: that is why the promise is a percentile, not a mean."));
    }
  });

  /* ---- Inside a Forward Pass ---- */

  gen({
    id: "param-count", chapter: "inside-a-forward-pass", title: "Parameters from config.json",
    draw: function (r) {
      var d = pick(r, [4096, 5120, 6144, 8192]);
      return { d: d, layers: pick(r, [32, 40, 48, 64, 80]), kv: pick(r, [4, 8]), hd: 128, q: d / 128,
               ffn: d * pick(r, [3, 3.5]), vocab: pick(r, [32768, 128256, 152064]) };
    },
    solve: function (i) {
      var attn = 2 * i.d * (i.q * i.hd) + 2 * i.d * (i.kv * i.hd), mlp = 3 * i.d * i.ffn;
      var emb = 2 * i.vocab * i.d, total = F.paramCount(i) / 1e9;
      return out(
        "A dense decoder's config.json: hidden_size " + i.d + ", num_hidden_layers " + i.layers +
        ", num_attention_heads " + i.q + ", num_key_value_heads " + i.kv + ", head_dim " + i.hd +
        ", intermediate_size " + i.ffn + " (gated MLP: gate, up and down projections), vocab_size " +
        i.vocab + ", tie_word_embeddings false. Ignoring norms and biases, how many parameters does it have, in billions?",
        total, "billion",
        lines("Attention per layer: Q and O are " + i.d + " × " + (i.q * i.hd) + "; K and V are " + i.d + " × " +
                (i.kv * i.hd) + " → " + n(attn / 1e6) + " M",
              "MLP per layer: 3 × " + i.d + " × " + i.ffn + " = " + n(mlp / 1e6) + " M",
              i.layers + " layers × " + n((attn + mlp) / 1e6) + " M = " + n(i.layers * (attn + mlp) / 1e9) + " B",
              "Embedding + LM head (untied): 2 × " + i.vocab + " × " + i.d + " = " + n(emb / 1e9) + " B",
              "Total ≈ " + n(total) + " B parameters"));
    }
  });

  gen({
    id: "weight-bytes", chapter: "inside-a-forward-pass", title: "Weight bytes per GPU",
    draw: function (r) { return drawDeployment(r, W_DTYPES); },
    solve: function (i) {
      var total = F.weightGB(i.P, i.dt.bytes), per = total / i.tp;
      return out(
        A(i.P) + " " + i.P + "B-parameter dense model is stored in " + i.dt.name + " (" + bytesWord(i.dt.bytes) +
        " per weight) and served on " + gpusPhrase(i.tp, i.chip) +
        (i.tp > 1 ? " with tensor parallelism (TP=" + i.tp + ")" : "") +
        ". How many GB of weights does " + (i.tp > 1 ? "each GPU" : "the GPU") + " hold?",
        per, "GB",
        lines(i.P + " × 10⁹ params × " + bytesWord(i.dt.bytes) + " = " + n(total) + " GB in total",
              i.tp > 1 ? "TP splits every weight matrix: ÷ " + i.tp + " = " + n(per) + " GB per GPU"
                       : "One GPU holds all of it: " + n(per) + " GB"));
    }
  });

  gen({
    id: "kv-per-token", chapter: "inside-a-forward-pass", title: "KV bytes per token",
    draw: function (r) {
      var kv = pick(r, [4, 8, 16]);
      return { layers: pick(r, [32, 48, 61, 80]), kv: kv, q: kv * pick(r, [4, 8]),
               hd: pick(r, [64, 128]), dt: pick(r, KV_DTYPES) };
    },
    solve: function (i) {
      var b = F.kvBytesPerToken(i.layers, i.kv, i.hd, i.dt.bytes), kb = b / 1e3;
      return out(
        "A model has " + i.layers + " layers, " + i.q + " query heads, " + i.kv + " key-value heads (GQA) " +
        "and head_dim " + i.hd + ". Its KV cache is stored in " + i.dt.name + ". How many KB of KV cache " +
        "does one token occupy (1 KB = 1,000 bytes)?",
        kb, "KB",
        lines("KV bytes per token = 2 (K and V) × layers × KV heads × head_dim × bytes per element",
              "= 2 × " + i.layers + " × " + i.kv + " × " + i.hd + " × " + i.dt.bytes + " = " + v(b) + " B ≈ " + n(kb) + " KB",
              "Query heads do not appear: only keys and values are cached."));
    }
  });

  gen({
    id: "attention-share", chapter: "inside-a-forward-pass", title: "Attention's share of the arithmetic",
    draw: function (r) {
      var m = pick(r, [{ P: 8, layers: 32, q: 32 }, { P: 32, layers: 64, q: 64 }, { P: 70, layers: 80, q: 64 }]);
      return { P: m.P, layers: m.layers, q: m.q, hd: 128, ctx: pick(r, [1000, 3000, 8000, 32000, 128000]) };
    },
    solve: function (i) {
      var attn = 4 * i.layers * i.q * i.hd * i.ctx, w = 2 * i.P * 1e9, pct = attn / w * 100;
      return out(
        A(i.P) + " " + i.P + "B dense model has " + i.layers + " layers, " + i.q + " query heads and head_dim " + i.hd +
        ". It generates one token with " + v(i.ctx) + " tokens of context. Attention's scores-and-average work " +
        "for that token is what percentage of the arithmetic its weight multiplies cost?",
        pct, "%",
        lines("Weights: ~2 × P = 2 × " + i.P + "e9 = " + n(w / 1e9) + " GFLOPs per token",
              "Attention: ~4 × layers × query heads × head_dim × context = 4 × " + i.layers + " × " + i.q + " × " +
                i.hd + " × " + v(i.ctx) + " = " + n(attn / 1e9) + " GFLOPs",
              "Ratio: " + n(attn / 1e9) + " ÷ " + n(w / 1e9) + " ≈ " + n(pct) + "%",
              "It grows linearly with context; the KV cache removes recomputation, not this work."));
    }
  });

  /* ---- The GPU Mental Model ---- */

  gen({
    id: "chip-speedup", chapter: "gpu-mental-model", title: "Which number moves with the chip",
    draw: function (r) {
      var a = pick(r, CHIPS), b;
      do { b = pick(r, CHIPS); } while (b === a);
      return { a: a, b: b, phase: pick(r, ["decode", "prefill"]) };
    },
    solve: function (i) {
      var mem = i.phase === "decode";
      var s = mem ? i.b.bw / i.a.bw : i.b.tf / i.a.tf;
      return out(
        "A workload's " + (mem ? "batch-1 decode is memory-bound" : "long-prompt prefill is compute-bound") +
        " on " + i.a.name + " (" + v(i.a.tf) + " TFLOP/s dense BF16, " + v(i.a.bw) + " TB/s). You move it to " +
        i.b.name + " (" + v(i.b.tf) + " TFLOP/s, " + v(i.b.bw) + " TB/s). What speedup should you expect, as a multiplier?",
        s, "×",
        lines(mem ? "Memory-bound: time = bytes ÷ bandwidth, so only bandwidth counts."
                  : "Compute-bound: time = FLOPs ÷ FLOP/s, so only compute counts.",
              (mem ? v(i.b.bw) + " ÷ " + v(i.a.bw) : v(i.b.tf) + " ÷ " + v(i.a.tf)) + " ≈ " + n(s) + "×",
              mem ? "The other chip's extra FLOP/s change nothing for this phase."
                  : "Bandwidth does not enter: prefill reuses each weight across the whole prompt."));
    }
  });

  /* ---- Inference Arithmetic ---- */

  gen({
    id: "decode-floor", chapter: "inference-arithmetic", title: "Decode-step floor",
    draw: function (r) { return drawDeployment(r, KV_DTYPES); },
    solve: function (i) {
      var per = F.weightGB(i.P, i.dt.bytes) / i.tp, ms = F.decodeFloorMs(per, i.chip.bw);
      return out(
        A(i.P) + " " + i.P + "B dense model in " + i.dt.name + " runs with TP=" + i.tp + " on " + i.chip.name +
        " GPUs (" + v(i.chip.bw) + " TB/s of HBM bandwidth each). At batch 1, what is the physics floor " +
        "on one decode step, in ms (weights only, nameplate bandwidth)?",
        ms, "ms",
        lines("Each GPU reads its share of the weights once per step: " + i.P + " × " + i.dt.bytes + " ÷ " + i.tp + " = " + n(per) + " GB",
              n(per) + " GB ÷ " + v(i.chip.bw) + " TB/s = " + n(ms) + " ms (GB ÷ TB/s comes out in ms)",
              "Real steps are slower: ~85% of nameplate is achievable, plus all-reduce and launch overhead."));
    }
  });

  gen({
    id: "mbu", chapter: "inference-arithmetic", title: "Model bandwidth utilisation",
    draw: function (r) {
      var d = drawDeployment(r, KV_DTYPES);
      var floor = F.decodeFloorMs(F.weightGB(d.P, d.dt.bytes) / d.tp, d.chip.bw);
      var raw = floor / pick(r, [0.55, 0.6, 0.65, 0.7, 0.75, 0.8]);
      d.measured = raw < 5 ? Math.max(0.1, Math.round(raw * 10) / 10) : Math.round(raw * 2) / 2;
      return d;
    },
    solve: function (i) {
      var per = F.weightGB(i.P, i.dt.bytes) / i.tp, floor = F.decodeFloorMs(per, i.chip.bw);
      var mbu = floor / i.measured * 100;
      return out(
        A(i.P) + " " + i.P + "B dense model in " + i.dt.name + ", TP=" + i.tp + " on " + i.chip.name + " (" + v(i.chip.bw) +
        " TB/s each). At batch 1 you measure " + v(i.measured) + " ms per decode step. What model bandwidth " +
        "utilisation (MBU) is that, in percent?",
        mbu, "%",
        lines("Bytes per GPU per step: " + i.P + " × " + i.dt.bytes + " ÷ " + i.tp + " = " + n(per) + " GB → floor " + n(floor) + " ms",
              "MBU = floor ÷ measured = " + n(floor) + " ÷ " + v(i.measured) + " ≈ " + n(mbu) + "%",
              "MBU is the meter for decode; its MFU would read in single digits and mean nothing."));
    }
  });

  gen({
    id: "prefill-time", chapter: "inference-arithmetic", title: "Prefill time",
    draw: function (r) {
      var d = drawDeployment(r, [BF16], [8, 14, 32, 70]);
      d.T = pick(r, [1000, 2000, 3000, 8000, 16000]);
      d.mfu = pick(r, [0.3, 0.4, 0.5]);
      return d;
    },
    solve: function (i) {
      var flops = 2 * i.P * 1e9 * i.T, rate = i.tp * i.chip.tf * 1e12 * i.mfu;
      var ms = F.prefillMs(i.P, i.T, i.tp, i.chip.tf, i.mfu);
      return out(
        "Prefill " + a(i.T) + " " + v(i.T) + "-token prompt on " + a(i.P) + " " + i.P + "B dense BF16 model running on " +
        gpusPhrase(i.tp, i.chip) + " (" + v(i.chip.tf) + " TFLOP/s dense BF16 each) at " + pc(i.mfu) +
        "% MFU. How long does the prefill take, in ms?",
        ms, "ms",
        lines("FLOPs: 2 × P × tokens = 2 × " + i.P + "e9 × " + v(i.T) + " = " + n(flops / 1e12) + " TFLOP",
              "Achieved rate: " + i.tp + " × " + v(i.chip.tf) + " TFLOP/s × " + pc(i.mfu) + "% = " + n(rate / 1e12) + " TFLOP/s",
              n(flops / 1e12) + " TFLOP ÷ " + n(rate / 1e12) + " TFLOP/s = " + n(ms) + " ms",
              "Prefill is compute-bound: MFU is its meter."));
    }
  });

  gen({
    id: "critical-batch", chapter: "inference-arithmetic", title: "Nameplate critical batch",
    draw: function (r) { return { chip: pick(r, CHIPS), variant: pick(r, ["dense", "sparse", "w4"]) }; },
    solve: function (i) {
      var c = i.chip, b = i.variant === "w4" ? 0.5 : 2;
      var ridge = c.tf / c.bw, B = F.criticalBatch(c.tf, c.bw, b), prompt;
      if (i.variant === "dense") {
        prompt = "A GPU offers " + v(c.tf) + " TFLOP/s of dense BF16 compute and " + v(c.bw) + " TB/s of HBM " +
          "bandwidth. Serving a dense model with BF16 weights, what is the nameplate critical batch size — the " +
          "tokens per step at which decode stops being memory-bound?";
      } else if (i.variant === "sparse") {
        prompt = "A datasheet lists a GPU at " + v(2 * c.tf) + " TFLOP/s BF16 \"with sparsity\" and " + v(c.bw) +
          " TB/s of HBM bandwidth. Serving a dense model with BF16 weights, what is the nameplate critical batch " +
          "size, in tokens per step?";
      } else {
        prompt = "A GPU offers " + v(c.tf) + " TFLOP/s dense BF16 and " + v(c.bw) + " TB/s. You serve 4-bit " +
          "weight-only quantized weights (W4A16: dequantized and multiplied at the BF16 rate). What is the " +
          "nameplate critical batch size, in tokens per step?";
      }
      return out(prompt, B, "tokens/step",
        lines(i.variant === "sparse" ? "Halve the sparse figure first: dense inference gets " + v(c.tf) + " TFLOP/s." : "",
              "Ridge = " + v(c.tf) + "e12 FLOP/s ÷ " + v(c.bw) + "e12 B/s ≈ " + n(ridge) + " FLOP/byte",
              "At batch B each weight byte read serves 2B ÷ " + v(b) + " FLOPs; set that equal to the ridge:",
              "B = ridge × " + v(b) + " ÷ 2 ≈ " + n(B) + " tokens per step",
              i.variant === "w4" ? "Fewer bytes per weight at the same arithmetic rate: the knee moves left."
                                 : "That is the nameplate knee; at achieved efficiencies it sits lower — measure it."));
    }
  });

  gen({
    id: "effective-knee", chapter: "inference-arithmetic", title: "Effective knee",
    draw: function (r) {
      var d = drawDeployment(r, [BF16], [8, 14, 32, 70]);
      var floor = F.decodeFloorMs(F.weightGB(d.P, 2) / d.tp, d.chip.bw);
      d.tw = Math.max(1, Math.round(floor / pick(r, [0.6, 0.7, 0.75]) * 2) / 2);
      d.mfu = pick(r, [0.3, 0.4, 0.5]);
      return d;
    },
    solve: function (i) {
      var t = F.msPerToken(i.P, i.tp, i.chip.tf, i.mfu), knee = i.tw / t;
      return out(
        "On " + gpusPhrase(i.tp, i.chip) + " (" + v(i.chip.tf) + " TFLOP/s dense BF16 each) " + a(i.P) + " " + i.P +
        "B BF16 model reads its weights in t_w = " + v(i.tw) + " ms per step, and the matrix multiplies run at " +
        pc(i.mfu) + "% MFU. With step ≈ max(t_w, t_c), at roughly how many tokens per step does the arithmetic " +
        "t_c overtake t_w?",
        knee, "tokens/step",
        lines("t_c per token = 2 × " + i.P + "e9 ÷ (" + i.tp + " × " + v(i.chip.tf) + "e12 × " + v(i.mfu) + ") ≈ " + n(t) + " ms",
              "Knee = t_w ÷ per-token cost = " + v(i.tw) + " ÷ " + n(t) + " ≈ " + n(knee) + " tokens per step",
              "The nameplate ridge says ~" + n(i.chip.tf / i.chip.bw) + "; achieved efficiencies move it. Measure it."));
    }
  });

  gen({
    id: "kv-per-sequence", chapter: "inference-arithmetic", title: "KV cache of one request",
    draw: function (r) {
      return { layers: pick(r, [32, 48, 61, 80]), kv: pick(r, [4, 8, 16]), hd: pick(r, [64, 128]),
               dt: pick(r, KV_DTYPES), inTok: pick(r, [1000, 2000, 3000, 8000, 32000]),
               outTok: pick(r, [250, 500, 1000, 2000]) };
    },
    solve: function (i) {
      var b = F.kvBytesPerToken(i.layers, i.kv, i.hd, i.dt.bytes), tok = i.inTok + i.outTok, gb = b * tok / 1e9;
      return out(
        "A request carries " + v(i.inTok) + " prompt tokens and generates " + v(i.outTok) + " tokens on a model with " +
        i.layers + " layers, " + i.kv + " KV heads and head_dim " + i.hd + ", KV cache in " + i.dt.name +
        ". How many GB of KV cache does it hold at the end of generation?",
        gb, "GB",
        lines("Per token: 2 × " + i.layers + " × " + i.kv + " × " + i.hd + " × " + i.dt.bytes + " = " + v(b) + " B",
              "Tokens at the end: " + v(i.inTok) + " + " + v(i.outTok) + " = " + v(tok),
              v(b) + " B × " + v(tok) + " ≈ " + n(gb) + " GB"));
    }
  });

  gen({
    id: "kv-read-time", chapter: "inference-arithmetic", title: "KV reads in a decode step",
    draw: function (r) {
      return { kvKB: pick(r, [128, 164, 197, 328]), tp: pick(r, [1, 2, 4, 8]),
               chip: pick(r, CHIPS), seqs: pick(r, [8, 20, 32, 64]), ctx: pick(r, [1000, 3000, 8000]) };
    },
    solve: function (i) {
      var perGpuB = i.kvKB * 1e3 / i.tp, bw = 0.85 * i.chip.bw, ns = perGpuB / (bw * 1e12) * 1e9;
      var tokens = i.seqs * i.ctx, ms = F.kvReadMs(perGpuB, bw, tokens);
      return out(
        "A model stores " + v(i.kvKB) + " KB of KV cache per token, split evenly over TP=" + i.tp + " GPUs (" +
        i.chip.name + ", " + v(i.chip.bw) + " TB/s nameplate, about 85% achievable). A decode step serves " + i.seqs +
        " sequences with " + v(i.ctx) + " tokens of context each. How many ms does reading their KV cache add to the step?",
        ms, "ms",
        lines("Per GPU, per context token: " + v(i.kvKB) + " KB ÷ " + i.tp + " = " + n(perGpuB / 1e3) + " KB",
              "Achievable bandwidth: 0.85 × " + v(i.chip.bw) + " = " + n(bw) + " TB/s → " + n(ns) + " ns per context token",
              i.seqs + " × " + v(i.ctx) + " = " + v(tokens) + " context tokens × " + n(ns) + " ns ≈ " + n(ms) + " ms",
              "This is the t_kv term: it grows with batch × context, unlike the weight read."));
    }
  });

  /* ---- How to Read a Number ---- */
  /* (its skills are qualitative; the percentile card above covers its arithmetic) */

  /* ---- Continuous Batching ---- */

  gen({
    id: "step-time", chapter: "continuous-batching", title: "Hybrid step time",
    draw: function (r) {
      return { tw: pick(r, [10, 12, 14, 16, 20]), tTok: pick(r, [0.045, 0.06, 0.089, 0.12]),
               chunk: pick(r, [0, 256, 512, 1024, 2048]), decodes: pick(r, [8, 16, 20, 32, 64]),
               tkv: pick(r, [0.8, 1.2, 1.7, 2.5, 3.4]) };
    },
    solve: function (i) {
      var tokens = i.chunk + i.decodes, tc = tokens * i.tTok, step = F.stepMs(i.tw, i.tTok, tokens, i.tkv);
      var head = i.chunk
        ? "A hybrid step carries " + a(i.chunk) + " " + v(i.chunk) + "-token prefill chunk plus one decode token for each of " + i.decodes + " running sequences. "
        : "A pure decode step carries one token for each of " + i.decodes + " running sequences. ";
      return out(
        head + "Reading the weights takes t_w = " + v(i.tw) + " ms; arithmetic costs " + v(i.tTok) +
        " ms per token in the step; reading those sequences' KV cache adds t_kv = " + v(i.tkv) +
        " ms. How long is the step, in ms?",
        step, "ms",
        lines("Model: step ≈ max(t_w, t_c) + t_kv — the same multiplies read the weights and do the arithmetic.",
              "Tokens in the step: " + (i.chunk ? v(i.chunk) + " + " : "") + i.decodes + " = " + v(tokens),
              "t_c = " + v(tokens) + " × " + v(i.tTok) + " = " + n(tc) + " ms",
              "max(" + v(i.tw) + ", " + n(tc) + ") = " + n(Math.max(i.tw, tc)) + " ms — " +
                (tc > i.tw ? "the arithmetic binds" : "the weight read binds; the tokens ride along"),
              "+ t_kv " + v(i.tkv) + " = " + n(step) + " ms"));
    }
  });

  gen({
    id: "chunk-from-itl", chapter: "continuous-batching", title: "Chunk size from an ITL budget",
    draw: function (r) {
      for (var g = 0; g < 50; g++) {
        var d = { itl: pick(r, [40, 50, 60, 80, 100]), tTok: pick(r, [0.045, 0.06, 0.089, 0.12]),
                  decodes: pick(r, [16, 20, 32, 48]), tkv: pick(r, [1, 1.7, 2.5]), tw: pick(r, [10, 12, 14]) };
        if (F.chunkFromItl(d.itl, d.tTok, d.decodes, d.tkv) >= 64) return d;
      }
      return { itl: 60, tTok: 0.089, decodes: 20, tkv: 1.7, tw: 14 };
    },
    solve: function (i) {
      var budget = i.itl - i.tkv, fit = budget / i.tTok, C = F.chunkFromItl(i.itl, i.tTok, i.decodes, i.tkv);
      var round = Math.pow(2, Math.floor(Math.log(C) / Math.LN2));
      return out(
        "You promise streaming users an inter-token latency of at most " + i.itl + " ms. Each step reads the " +
        "weights in t_w = " + i.tw + " ms, arithmetic costs " + v(i.tTok) + " ms per token in the step, " + i.decodes +
        " sequences are decoding and their KV reads add t_kv = " + v(i.tkv) + " ms. With step ≈ max(t_w, t_c) + t_kv, " +
        "what is the largest prefill chunk, in tokens, that a hybrid step can carry?",
        C, "tokens",
        lines("Budget for t_c: " + i.itl + " − " + v(i.tkv) + " = " + n(budget) + " ms (above t_w, so t_c is what binds)",
              "Tokens that fit: " + n(budget) + " ÷ " + v(i.tTok) + " ≈ " + n(fit),
              "Minus the " + i.decodes + " decode tokens: ≈ " + n(C) + " tokens of prefill chunk",
              "In practice round down (e.g. " + round + "). Do not add a decode time on top: that double-counts the weight read."));
    }
  });

  gen({
    id: "little-in-flight", chapter: "continuous-batching", title: "Little's law: requests in flight",
    draw: function (r) {
      return { rate: pick(r, [0.5, 1, 1.5, 2, 4, 8]), ttft: pick(r, [0.2, 0.3, 0.5]),
               outTok: pick(r, [150, 250, 400, 800]), tpot: pick(r, [16, 20, 30, 40]) };
    },
    solve: function (i) {
      var W = i.ttft + i.outTok * i.tpot / 1000, L = F.little(i.rate, W);
      return out(
        "Requests arrive at " + v(i.rate) + " per second. Each spends about " + v(i.ttft) + " s before its first " +
        "token, then generates " + v(i.outTok) + " tokens at " + i.tpot + " ms each. On average, how many requests " +
        "are in the system at once?",
        L, "requests",
        lines("Little's law: L = λ × W",
              "W = " + v(i.ttft) + " + " + v(i.outTok) + " × " + v(i.tpot / 1000) + " s = " + n(W) + " s",
              "L = " + v(i.rate) + " × " + n(W) + " ≈ " + n(L) + " requests",
              "An average over everything in the system, queue included — not a p95, and not the batch."));
    }
  });

  gen({
    id: "little-rate", chapter: "continuous-batching", title: "Little's law: the rate a pool sustains",
    draw: function (r) {
      return { N: pick(r, [16, 32, 64, 123, 256]), ttft: pick(r, [0.3, 0.5, 1]),
               outTok: pick(r, [250, 500, 1000]), tpot: pick(r, [16, 20, 30, 40]) };
    },
    solve: function (i) {
      var W = i.ttft + i.outTok * i.tpot / 1000, rate = i.N / W;
      return out(
        "Your KV pool holds " + i.N + " sequences at once. A request spends " + v(i.ttft) + " s queued and in " +
        "prefill, then decodes " + v(i.outTok) + " tokens at " + i.tpot + " ms per token. By Little's law, what arrival " +
        "rate keeps the pool full on average, in requests per second?",
        rate, "requests/s",
        lines("W = " + v(i.ttft) + " + " + v(i.outTok) + " × " + v(i.tpot / 1000) + " s = " + n(W) + " s",
              "λ = L ÷ W = " + i.N + " ÷ " + n(W) + " ≈ " + n(rate) + " requests/s",
              "Plan below it: bursts and long answers push the instantaneous count above the average."));
    }
  });

  /* ---- PagedAttention & Prefix Caching ---- */

  gen({
    id: "prefix-blocks", chapter: "paged-kv-cache", title: "Shareable prefix blocks",
    draw: function (r) { return { prefix: rint(r, 200, 4000), block: pick(r, [16, 16, 32]) }; },
    solve: function (i) {
      var full = F.fullBlocks(i.prefix, i.block), rem = i.prefix - full * i.block;
      return out(
        "Every request starts with the same " + v(i.prefix) + "-token system prompt. The engine uses " + i.block +
        "-token KV blocks and caches prefixes block by block. How many blocks of that prompt can one request " +
        "reuse from another's cache?",
        full, "blocks",
        lines("Only full blocks are hashed and shared: " + v(i.prefix) + " ÷ " + i.block + " = " + n(i.prefix / i.block),
              "→ " + n(full) + " full blocks (" + v(full * i.block) + " tokens)",
              rem ? "The last " + rem + " tokens sit in a partial block that each request computes for itself."
                  : "It divides exactly: no partial block."),
        0.001);
    }
  });

  gen({
    id: "prefix-saved", chapter: "paged-kv-cache", title: "Prefill saved by a prefix cache",
    draw: function (r) {
      return { prefix: pick(r, [800, 1000, 1500, 2050, 3000]), rate: pick(r, [0.5, 1, 1.5, 2, 5, 10]),
               hit: pick(r, [0.5, 0.7, 0.9, 1]) };
    },
    solve: function (i) {
      var cached = F.fullBlocks(i.prefix, 16) * 16, saved = i.rate * i.hit * cached;
      return out(
        A(i.prefix) + " " + v(i.prefix) + "-token system prompt opens every request; " + v(i.rate) + " requests arrive per " +
        "second and " + pc(i.hit) + "% of them find it still in the cache. With 16-token blocks, how many prefill " +
        "tokens per second does the prefix cache save?",
        saved, "tokens/s",
        lines("Cached per hit: floor(" + v(i.prefix) + " ÷ 16) × 16 = " + v(cached) + " tokens (full blocks only)",
              v(cached) + " × " + v(i.rate) + " req/s × " + v(i.hit) + " ≈ " + n(saved) + " tokens/s not recomputed"));
    }
  });

  gen({
    id: "pool-blocks", chapter: "paged-kv-cache", title: "Blocks in a KV pool",
    draw: function (r) {
      return { pool: pick(r, [54, 66, 132, 211, 400]), kvKB: pick(r, [128, 164, 197, 328]),
               block: pick(r, [16, 16, 32]) };
    },
    solve: function (i) {
      var blockMB = i.block * i.kvKB / 1e3, blocks = i.pool * 1e3 / blockMB;
      return out(
        "A KV pool of " + i.pool + " GB, " + i.block + "-token blocks, and a model that needs " + v(i.kvKB) +
        " KB of KV per token. How many blocks does the pool hold?",
        blocks, "blocks",
        lines("One block: " + i.block + " × " + v(i.kvKB) + " KB = " + n(blockMB) + " MB",
              i.pool + " GB ÷ " + n(blockMB) + " MB ≈ " + n(blocks) + " blocks"));
    }
  });

  /* ---- Anatomy of a Serving Engine ---- */

  gen({
    id: "mem-util-flag", chapter: "anatomy-of-an-engine", title: "Setting --gpu-memory-utilization",
    draw: function (r) {
      for (var g = 0; g < 50; g++) {
        var d = drawDeployment(r, KV_DTYPES, [8, 14, 32, 70]);
        d.gpus = d.tp;
        d.other = pick(r, [3, 4, 5]);
        var total = d.gpus * d.chip.gb, f = pick(r, [0.8, 0.85, 0.88, 0.9, 0.92, 0.95]);
        d.pool = Math.round(f * total - F.weightGB(d.P, d.dt.bytes) - d.other * d.gpus);
        if (d.pool >= 0.1 * total) return d;
      }
      return { P: 70, dt: BF16, chip: CHIPS[0], tp: 4, gpus: 4, other: 4, pool: 132 };
    },
    solve: function (i) {
      var total = i.gpus * i.chip.gb, W = F.weightGB(i.P, i.dt.bytes), f = (i.pool + W + i.other * i.gpus) / total;
      return out(
        "You want " + a(i.pool) + " " + i.pool + " GB KV pool on " + gpusPhrase(i.gpus, i.chip) + " (" + i.chip.gb +
        " GB each) serving " + a(i.P) + " " + i.P + "B model in " + i.dt.name + " (" + n(W) + " GB of weights). Everything else the engine holds is about " +
        i.other + " GB per GPU. What --gpu-memory-utilization should you pass to vLLM, as a fraction such as 0.9?",
        f, "fraction",
        lines("vLLM (v0.34) treats the flag as a fraction of total memory: f × " + total + " GB must cover pool + weights + the rest.",
              "(" + i.pool + " + " + n(W) + " + " + i.gpus + " × " + i.other + ") ÷ " + total + " ≈ " + n(f),
              "Not f × (memory left after the weights): that older reading over-states the pool."),
        0.02);
    }
  });

  /* ---- Attention Architectures for Serving ---- */

  gen({
    id: "gqa-saving", chapter: "attention-for-serving", title: "What GQA saves",
    draw: function (r) {
      var kv = pick(r, [4, 8]);
      return { layers: pick(r, [32, 48, 64, 80]), kv: kv, q: kv * pick(r, [4, 8]), hd: 128,
               dt: pick(r, KV_DTYPES), ctx: pick(r, [4096, 8192, 32768, 131072]) };
    },
    solve: function (i) {
      var mha = F.kvBytesPerToken(i.layers, i.q, i.hd, i.dt.bytes), gqa = F.kvBytesPerToken(i.layers, i.kv, i.hd, i.dt.bytes);
      var gb = (mha - gqa) * i.ctx / 1e9;
      return out(
        "A model has " + i.layers + " layers, " + i.q + " query heads and head_dim " + i.hd + ". Version A uses " +
        "multi-head attention (one KV head per query head); version B uses GQA with " + i.kv + " KV heads. KV cache in " +
        i.dt.name + ". For one sequence of " + v(i.ctx) + " tokens, how many GB of KV cache does B save over A?",
        gb, "GB",
        lines("MHA: 2 × " + i.layers + " × " + i.q + " × " + i.hd + " × " + i.dt.bytes + " = " + v(mha) + " B per token",
              "GQA: 2 × " + i.layers + " × " + i.kv + " × " + i.hd + " × " + i.dt.bytes + " = " + v(gqa) + " B per token (" + (i.q / i.kv) + "× smaller)",
              "Saved: " + v(mha - gqa) + " B × " + v(i.ctx) + " tokens ≈ " + n(gb) + " GB"));
    }
  });

  /* ---- Quantization ---- */

  gen({
    id: "quant-floor", chapter: "quantization", title: "Decode floor after quantization",
    draw: function (r) {
      var d = drawDeployment(r, [BF16], [8, 14, 32, 70, 123]);
      d.to = pick(r, [FP8, INT4]);
      return d;
    },
    solve: function (i) {
      var before = F.weightGB(i.P, 2) / i.tp, after = F.weightGB(i.P, i.to.bytes) / i.tp;
      var f0 = F.decodeFloorMs(before, i.chip.bw), f1 = F.decodeFloorMs(after, i.chip.bw);
      return out(
        A(i.P) + " " + i.P + "B dense model runs in BF16 with TP=" + i.tp + " on " + i.chip.name + " (" + v(i.chip.bw) +
        " TB/s each). You quantize the weights to " + i.to.name + " (" + bytesWord(i.to.bytes) + " per weight, ignore " +
        "scales) and keep TP=" + i.tp + ". What is the new batch-1 decode floor (weights only, nameplate bandwidth), in ms?",
        f1, "ms",
        lines("Before: " + i.P + " × 2 ÷ " + i.tp + " = " + n(before) + " GB per GPU → " + n(f0) + " ms",
              "After: " + i.P + " × " + v(i.to.bytes) + " ÷ " + i.tp + " = " + n(after) + " GB per GPU → " + n(f1) + " ms",
              "Small-batch decode is a byte count: fewer bytes, proportionally shorter floor."));
    }
  });

  gen({
    id: "quant-capacity", chapter: "quantization", title: "Sequences that fit after FP8",
    draw: function (r) {
      for (var g = 0; g < 50; g++) {
        var d = { chip: pick(r, [CHIPS[0], CHIPS[1]]), gpus: pick(r, [2, 4]), f: 0.9, other: pick(r, [3, 4]),
                  P: pick(r, [32, 70]), kvKB: pick(r, [128, 196, 328]), ctx: pick(r, [4000, 8000, 16000, 32000]) };
        var pool = F.kvPoolGB(d.gpus * d.chip.gb, d.f, d.P, d.other * d.gpus);
        if (F.maxSequences(pool, d.kvKB * 500, d.ctx) >= 1) return d;
      }
      return { chip: CHIPS[0], gpus: 2, f: 0.9, other: 4, P: 70, kvKB: 327.68, ctx: 8000 };
    },
    solve: function (i) {
      var total = i.gpus * i.chip.gb, pool = F.kvPoolGB(total, i.f, i.P, i.other * i.gpus);
      var kvB = i.kvKB * 1e3 / 2, seq = kvB * i.ctx / 1e9, k = F.maxSequences(pool, kvB, i.ctx);
      return out(
        gpusPhrase(i.gpus, i.chip) + " (" + i.chip.gb + " GB each), vLLM --gpu-memory-utilization " + v(i.f) + ", and " +
        i.other + " GB per GPU of non-KV overhead. " + A(i.P) + " " + i.P + "B dense model's KV cache costs " + v(i.kvKB) +
        " KB per token in BF16. With FP8 weights and an FP8 KV cache, how many " + v(i.ctx) + "-token sequences fit in the pool?",
        k, "sequences",
        lines("FP8 weights: " + i.P + " GB. FP8 KV: " + v(i.kvKB / 2) + " KB per token.",
              "Pool: " + v(i.f) + " × " + total + " − " + i.P + " − " + i.gpus + " × " + i.other + " = " + n(pool) + " GB",
              "Per sequence: " + v(i.kvKB / 2) + " KB × " + v(i.ctx) + " = " + n(seq) + " GB",
              n(pool) + " ÷ " + n(seq) + " → " + n(k) + " sequences (round down)",
              "Both halvings compound: the pool grows and each sequence shrinks."));
    }
  });

  /* ---- Speculative Decoding ---- */

  gen({
    id: "spec-expected", chapter: "speculative-decoding", title: "Tokens per target pass",
    draw: function (r) {
      return { alpha: pick(r, [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9]), gamma: pick(r, [2, 3, 4, 5, 6, 8]) };
    },
    solve: function (i) {
      var p = Math.pow(i.alpha, i.gamma + 1), E = F.specExpected(i.alpha, i.gamma);
      return out(
        "A draft model proposes γ = " + i.gamma + " tokens per round, and each proposed token is accepted with " +
        "probability α = " + v(i.alpha) + " (treat acceptances as independent). How many tokens does one target " +
        "forward pass yield on average?",
        E, "tokens",
        lines("E = (1 − α^(γ+1)) ÷ (1 − α)",
              "= (1 − " + v(i.alpha) + "^" + (i.gamma + 1) + ") ÷ " + v(1 - i.alpha) + " = (1 − " + n(p) + ") ÷ " + v(1 - i.alpha) + " ≈ " + n(E) + " tokens",
              "Ceiling however long you draft: 1 ÷ (1 − α) = " + n(1 / (1 - i.alpha)) + "."));
    }
  });

  gen({
    id: "spec-speedup", chapter: "speculative-decoding", title: "Speculative speedup",
    draw: function (r) {
      return { alpha: pick(r, [0.5, 0.6, 0.7, 0.8, 0.9]), gamma: pick(r, [2, 3, 4, 5, 6]),
               c: pick(r, [0.02, 0.05, 0.1, 0.2, 0.3]) };
    },
    solve: function (i) {
      var E = F.specExpected(i.alpha, i.gamma), cost = 1 + i.c * i.gamma, s = E / cost;
      return out(
        "At low batch, a draft model proposes γ = " + i.gamma + " tokens per round with acceptance α = " + v(i.alpha) +
        ", and each draft step costs " + pc(i.c) + "% of a target forward pass (verifying γ tokens costs about one " +
        "target pass). Roughly what wall-clock speedup over plain decoding should you expect, as a multiplier?",
        s, "×",
        lines("Tokens per round: (1 − " + v(i.alpha) + "^" + (i.gamma + 1) + ") ÷ " + v(1 - i.alpha) + " ≈ " + n(E),
              "Cost per round, in target passes: 1 + c·γ = 1 + " + v(i.c) + " × " + i.gamma + " = " + n(cost),
              "Speedup ≈ " + n(E) + " ÷ " + n(cost) + " ≈ " + n(s) + "×" + (s < 1 ? " — slower than not speculating" : "")));
    }
  });

  /* ---- Parallelism for Inference ---- */

  gen({
    id: "tp-allreduce", chapter: "parallelism-for-inference", title: "All-reduce cost per token",
    draw: function (r) {
      var cross = r() < 0.35;
      return { layers: pick(r, [32, 48, 64, 80, 126]), cross: cross,
               tp: cross ? pick(r, [8, 16]) : pick(r, [2, 4, 8]),
               lat: cross ? pick(r, [30, 40, 50]) : pick(r, [5, 8, 10]) };
    },
    solve: function (i) {
      var count = F.allReducesPerToken(i.layers), ms = count * i.lat / 1000;
      return out(
        A(i.layers) + " " + i.layers + "-layer dense model runs with TP=" + i.tp +
        (i.cross ? ", spanning two nodes over InfiniBand" : " inside one NVLink node") + ". Each all-reduce costs about " +
        i.lat + " µs, mostly synchronisation latency. How many milliseconds of all-reduce does each generated token pay?",
        ms, "ms",
        lines("Two all-reduces per layer (after attention, after the MLP): 2 × " + i.layers + " = " + count + " per token — whatever the TP degree",
              count + " × " + i.lat + " µs = " + n(ms) + " ms per token",
              i.cross ? "Across nodes this latency is why TP stops at the node boundary." : "Small next to a ~10 ms step, but not free."));
    }
  });

  /* ---- Serving MoE at Scale ---- */

  gen({
    id: "moe-touched", chapter: "moe-serving", title: "Experts a step touches",
    draw: function (r) {
      return { N: pick(r, [64, 128, 256]), k: pick(r, [2, 4, 8]), B: pick(r, [1, 4, 8, 16, 64, 256]) };
    },
    solve: function (i) {
      var miss = Math.pow(1 - i.k / i.N, i.B), pct = F.expertsTouched(i.k, i.N, i.B) * 100;
      return out(
        "An MoE layer has " + i.N + " routed experts and sends each token to " + i.k + " of them. A decode step " +
        "carries " + i.B + " token" + (i.B > 1 ? "s" : "") + ". With uniform, independent routing, what percentage of " +
        "the experts does the step have to read?",
        pct, "%",
        lines("P(one token misses a given expert) = 1 − " + i.k + "/" + i.N + " = " + n(1 - i.k / i.N),
              "P(all " + i.B + " miss it) = " + n(1 - i.k / i.N) + "^" + i.B + " ≈ " + n(miss),
              "Touched = 1 − " + n(miss) + " ≈ " + n(pct) + "%",
              "MoE's bandwidth advantage is large at batch 1 and mostly gone at serving batches."));
    }
  });

  gen({
    id: "moe-bytes", chapter: "moe-serving", title: "Bytes an MoE step reads",
    draw: function (r) {
      return { E: pick(r, [300, 600, 640]), S: pick(r, [10, 17, 25]), N: pick(r, [64, 128, 256]),
               k: pick(r, [2, 4, 8]), B: pick(r, [1, 8, 32, 128]) };
    },
    solve: function (i) {
      var f = F.expertsTouched(i.k, i.N, i.B), gb = i.S + i.E * f;
      return out(
        "An MoE model stores " + i.E + " GB of routed-expert weights (" + i.N + " experts per layer, top-" + i.k +
        ") and " + i.S + " GB of weights every token uses (attention, shared experts, embeddings). A decode step " +
        "carries " + i.B + " token" + (i.B > 1 ? "s" : "") + ". With uniform routing, roughly how many GB of weights does the step read?",
        gb, "GB",
        lines("Fraction of experts touched: 1 − (1 − " + i.k + "/" + i.N + ")^" + i.B + " ≈ " + n(f),
              i.S + " + " + i.E + " × " + n(f) + " ≈ " + n(gb) + " GB",
              "Memory holds all of it regardless: total parameters size the node, active ones only the batch-1 read."));
    }
  });

  /* ---- Disaggregated Serving ---- */

  var LINKS = [
    { name: "NVLink inside a node", gbps: 900 },
    { name: "InfiniBand NDR", gbps: 50 },
    { name: "100 GbE", gbps: 12.5 },
    { name: "25 GbE", gbps: 3.1 }
  ];

  gen({
    id: "disagg-transfer", chapter: "disaggregation", title: "Move the KV, or recompute it",
    draw: function (r) {
      return { variant: pick(r, ["transfer", "ratio"]), kvKB: pick(r, [164, 328]),
               T: pick(r, [2000, 4000, 8000, 32000, 128000]), link: pick(r, LINKS), flops: pick(r, [400, 1580]) };
    },
    solve: function (i) {
      var gb = i.kvKB * 1e3 * i.T / 1e9, ms = F.transferMs(gb, i.link.gbps);
      if (i.variant === "transfer") {
        return out(
          A(i.T) + " " + v(i.T) + "-token prompt leaves KV cache at " + i.kvKB + " KB per token. How long does shipping it " +
          "from a prefill GPU to a decode GPU over " + i.link.name + " (~" + v(i.link.gbps) + " GB/s) take, in ms?",
          ms, "ms",
          lines("KV to move: " + i.kvKB + " KB × " + v(i.T) + " ≈ " + n(gb) + " GB",
                n(gb) + " GB ÷ " + v(i.link.gbps) + " GB/s ≈ " + n(ms) + " ms",
                "Transfer grows with prompt length; compare it with the TTFT budget, not with zero."));
      }
      var rec = 2 * 70e9 * i.T / (i.flops * 1e12) * 1e3, ratio = rec / ms;
      return out(
        A(i.T) + " " + v(i.T) + "-token prompt to a 70B dense model leaves " + i.kvKB + " KB of KV per token. Shipping it over " +
        i.link.name + " (~" + v(i.link.gbps) + " GB/s), versus recomputing the prefill at " + v(i.flops) +
        " TFLOP/s achieved: how many times longer does recomputing take than transferring?",
        ratio, "×",
        lines("Transfer: " + i.kvKB + " KB × " + v(i.T) + " ≈ " + n(gb) + " GB ÷ " + v(i.link.gbps) + " GB/s ≈ " + n(ms) + " ms",
              "Recompute: 2 × 70e9 × " + v(i.T) + " ÷ " + v(i.flops) + "e12 FLOP/s ≈ " + n(rec) + " ms",
              "Ratio ≈ " + n(rec) + " ÷ " + n(ms) + " ≈ " + n(ratio) + "×" +
                (ratio < 1 ? " — on this link, recomputing is cheaper than moving" : " — KV is expensive to make and cheap to move")));
    }
  });

  /* ---- Sizing a Deployment ---- */

  gen({
    id: "kv-pool", chapter: "sizing-a-deployment", title: "KV pool from the memory budget",
    draw: function (r) {
      for (var g = 0; g < 50; g++) {
        var d = { chip: pick(r, CHIPS), gpus: pick(r, [1, 2, 4, 8]), f: pick(r, [0.85, 0.9, 0.92, 0.95]),
                  P: pick(r, [8, 14, 32, 70, 123]), dt: pick(r, KV_DTYPES), oh: pick(r, [2, 3, 4]), act: pick(r, [1, 2]) };
        var total = d.gpus * d.chip.gb;
        if (F.weightGB(d.P, d.dt.bytes) <= 0.6 * total) return d;
      }
      return { chip: CHIPS[0], gpus: 4, f: 0.9, P: 70, dt: BF16, oh: 3, act: 1 };
    },
    solve: function (i) {
      var total = i.gpus * i.chip.gb, W = F.weightGB(i.P, i.dt.bytes), other = i.gpus * (i.oh + i.act);
      var pool = F.kvPoolGB(total, i.f, W, other), wrong = (total - W - other) * i.f;
      return out(
        gpusPhrase(i.gpus, i.chip) + " (" + i.chip.gb + " GB each) serve " + a(i.P) + " " + i.P + "B model in " + i.dt.name +
        " (" + n(W) + " GB of weights in total). vLLM runs with --gpu-memory-utilization " + v(i.f) + "; framework " +
        "overhead is " + i.oh + " GB per GPU and activations " + i.act + " GB per GPU. How many GB are left for the KV pool across the replica?",
        pool, "GB",
        lines("vLLM (v0.34): the flag is a fraction of total memory → " + v(i.f) + " × " + total + " = " + n(i.f * total) + " GB budget",
              "− weights " + n(W) + " − overhead " + i.gpus + " × " + i.oh + " − activations " + i.gpus + " × " + i.act + " = " + n(pool) + " GB",
              "Not " + v(i.f) + " × (what is left after the weights): that would give " + n(wrong) + " GB."));
    }
  });

  gen({
    id: "max-concurrency", chapter: "sizing-a-deployment", title: "Concurrent sequences in a pool",
    draw: function (r) {
      for (var g = 0; g < 50; g++) {
        var d = { pool: pick(r, [20, 54, 66, 132, 211, 400]), kvKB: pick(r, [128, 164, 197, 328]),
                  ctx: pick(r, [2000, 3250, 4000, 8000, 16000, 32000]) };
        if (F.maxSequences(d.pool, d.kvKB * 1e3, d.ctx) >= 1) return d;
      }
      return { pool: 132, kvKB: 327.68, ctx: 3250 };
    },
    solve: function (i) {
      var seq = i.kvKB * 1e3 * i.ctx / 1e9, k = F.maxSequences(i.pool, i.kvKB * 1e3, i.ctx);
      return out(
        "A KV pool of " + i.pool + " GB serves a model whose KV cache costs " + v(i.kvKB) + " KB per token. Requests " +
        "reach " + v(i.ctx) + " live tokens at p95. How many such sequences can be resident at once?",
        k, "sequences",
        lines("Per sequence: " + v(i.kvKB) + " KB × " + v(i.ctx) + " ≈ " + n(seq) + " GB",
              i.pool + " ÷ " + n(seq) + " = " + n(i.pool / seq) + " → " + n(k) + " sequences (round down)",
              "Size with the p95 live context, not max_model_len: a paged pool holds blocks for tokens that exist."));
    }
  });

  gen({
    id: "kv-per-gpu-batch", chapter: "sizing-a-deployment", title: "KV per GPU for a batch",
    draw: function (r) {
      return { kvKB: pick(r, [128, 164, 197, 328]), B: pick(r, [8, 16, 32, 64]),
               ctx: pick(r, [2000, 4000, 8000, 16000]), tp: pick(r, [2, 4, 8]) };
    },
    solve: function (i) {
      var total = i.kvKB * 1e3 * i.B * i.ctx / 1e9, per = total / i.tp;
      return out(
        "A model's KV cache costs " + i.kvKB + " KB per token. A replica with TP=" + i.tp + " serves " + i.B +
        " concurrent sequences of " + v(i.ctx) + " live tokens each, and TP splits the KV heads evenly across its GPUs. " +
        "How many GB of KV does each GPU hold?",
        per, "GB",
        lines("Total: " + i.kvKB + " KB × " + i.B + " × " + v(i.ctx) + " ≈ " + n(total) + " GB",
              "÷ " + i.tp + " GPUs ≈ " + n(per) + " GB per GPU"));
    }
  });

  /* ---- Hardware & Economics ---- */

  gen({
    id: "cost-per-million", chapter: "hardware-and-economics", title: "Cost per million tokens",
    draw: function (r) {
      return { gpus: pick(r, [1, 2, 4, 8]), price: pick(r, [1.4, 2, 2.5, 3.44, 4]),
               tps: pick(r, [1500, 2000, 5000, 12000]), util: pick(r, [0.3, 0.5, 0.7, 0.9]) };
    },
    solve: function (i) {
      var hourly = i.gpus * i.price, perHour = i.tps * 3600 * i.util, c = F.costPerMillion(hourly, i.tps, i.util);
      return out(
        "A replica of " + i.gpus + " GPU" + (i.gpus > 1 ? "s" : "") + " at " + usd(i.price) + " per GPU-hour sustains " +
        v(i.tps) + " output tokens/s while busy, and is busy " + pc(i.util) + "% of the hours you pay for. " +
        "What does a million output tokens cost you?",
        c, "$ per 1M tokens",
        lines("Hourly cost: " + i.gpus + " × " + usd(i.price) + " = $" + n(hourly),
              "Tokens per paid hour: " + v(i.tps) + " × 3,600 × " + v(i.util) + " ≈ " + n(perHour / 1e6) + " M",
              "$" + n(hourly) + " ÷ " + n(perHour / 1e6) + " M ≈ $" + n(c) + " per million",
              "Utilisation is in the denominator: idle hours are paid for too."));
    }
  });

  gen({
    id: "api-bill", chapter: "hardware-and-economics", title: "Monthly API bill",
    draw: function (r) {
      var pin = pick(r, [0.5, 1, 3, 5]);
      return { req: pick(r, [2000, 5000, 12000, 40000]), inTok: pick(r, [1000, 3000, 8000]),
               outTok: pick(r, [150, 250, 500]), pin: pin, pout: pin * pick(r, [4, 5]) };
    },
    solve: function (i) {
      var per = F.apiPerRequest(i.inTok, i.outTok, i.pin, i.pout), m = F.apiMonthly(i.req, i.inTok, i.outTok, i.pin, i.pout);
      return out(
        v(i.req) + " requests a day, each " + v(i.inTok) + " input and " + v(i.outTok) + " output tokens. The API " +
        "charges " + usd(i.pin) + " per million input tokens and " + usd(i.pout) + " per million output tokens. " +
        "What is the monthly bill, for a 30-day month?",
        m, "$ per month",
        lines("Per request: (" + v(i.inTok) + " × " + v(i.pin) + " + " + v(i.outTok) + " × " + v(i.pout) + ") ÷ 1e6 = $" + n(per),
              "× " + v(i.req) + " × 30 days ≈ $" + n(m) + " per month",
              "Input tokens usually dominate a RAG bill even at a fifth of the output price."));
    }
  });

  /* ---- Choosing: Model, GPU, Framework ---- */

  gen({
    id: "breakeven-util", chapter: "choosing-model-gpu-framework", title: "Break-even utilisation",
    draw: function (r) {
      return { hourly: pick(r, [2.5, 5, 10, 20]), tps: pick(r, [1000, 2000, 5000, 12000]),
               p: pick(r, [0.6, 0.9, 2, 3, 10, 15]) };
    },
    solve: function (i) {
      var u = F.breakevenUtil(i.hourly, i.tps, i.p) * 100;
      return out(
        "A replica costs " + usd(i.hourly) + " per hour and sustains " + v(i.tps) + " output tokens/s while busy. " +
        "A hosted API charges " + usd(i.p) + " per million output tokens. Ignoring input tokens, at what utilisation " +
        "does self-hosting break even, in percent?",
        u, "%",
        lines("u* = $ per hour ÷ (tokens/s × 3,600 × price per token)",
              "= " + v(i.hourly) + " ÷ (" + v(i.tps) + " × 3,600 × " + v(i.p) + "e-6) ≈ " + n(u) + "%",
              u > 100 ? "Above 100%: at this price the replica never matches the API on output tokens alone."
                      : "Break-even is a utilisation question; volume matters because it makes utilisation achievable."));
    }
  });

  gen({
    id: "breakeven-volume", chapter: "choosing-model-gpu-framework", title: "Break-even volume",
    draw: function (r) {
      var pin = pick(r, [1, 3]);
      return { gpus: pick(r, [2, 4, 8]), price: pick(r, [2, 2.5, 3]), inTok: pick(r, [1000, 3000, 8000]),
               outTok: pick(r, [250, 500, 1000]), pin: pin, pout: pin * 5 };
    },
    solve: function (i) {
      var node = F.nodeMonthly(i.gpus, i.price), per = F.apiPerRequest(i.inTok, i.outTok, i.pin, i.pout);
      var nDay = node / (30 * per);
      return out(
        A(i.gpus) + " " + i.gpus + "-GPU node rents at " + usd(i.price) + " per GPU-hour, around the clock (730 hours a month). " +
        "The hosted alternative charges " + usd(i.pin) + " per million input and " + usd(i.pout) + " per million output " +
        "tokens; your requests average " + v(i.inTok) + " input and " + v(i.outTok) + " output tokens. Above how many " +
        "requests per day (30-day month) is the node cheaper, assuming it can carry the load?",
        nDay, "requests/day",
        lines("Node: " + i.gpus + " × " + usd(i.price) + " × 730 h = $" + n(node) + " per month",
              "API per request: (" + v(i.inTok) + " × " + v(i.pin) + " + " + v(i.outTok) + " × " + v(i.pout) + ") ÷ 1e6 = $" + n(per),
              "$" + n(node) + " ÷ (30 × $" + n(per) + ") ≈ " + n(nDay) + " requests per day",
              "The node is a fixed price, the API scales with tokens: the curves cross once."));
    }
  });

  /* ---- The Agentic Era ---- */

  gen({
    id: "api-bill-cached", chapter: "agentic-serving", title: "API bill with cached input",
    draw: function (r) {
      var pin = pick(r, [1, 3]);
      return { req: pick(r, [1000, 4000, 10000]), inTok: pick(r, [20000, 60000, 150000]),
               outTok: pick(r, [500, 1000, 2000]), pin: pin, pc: pin / 10, pout: pin * 5,
               hit: pick(r, [0.5, 0.75, 0.9]) };
    },
    solve: function (i) {
      var per = F.apiPerRequest(i.inTok, i.outTok, i.pin, i.pout, i.hit, i.pc);
      var m = F.apiMonthly(i.req, i.inTok, i.outTok, i.pin, i.pout, i.hit, i.pc);
      var none = F.apiMonthly(i.req, i.inTok, i.outTok, i.pin, i.pout);
      return out(
        "An agent product makes " + v(i.req) + " requests a day, each " + v(i.inTok) + " input and " + v(i.outTok) +
        " output tokens. Prices: " + usd(i.pin) + " per million fresh input, " + usd(i.pc) + " per million cached input, " +
        usd(i.pout) + " per million output. " + pc(i.hit) + "% of input tokens are cache hits. What is the monthly bill, for a 30-day month?",
        m, "$ per month",
        lines("Per request: " + v(i.inTok) + " × (" + v(1 - i.hit) + " × " + v(i.pin) + " + " + v(i.hit) + " × " + v(i.pc) + ") + " +
                v(i.outTok) + " × " + v(i.pout) + ", ÷ 1e6 = $" + n(per),
              "× " + v(i.req) + " × 30 ≈ $" + n(m) + " per month",
              "Without the cache it would be ≈ $" + n(none) + ": the hit rate is a line on the invoice."));
    }
  });

  var GENERATORS = G;
  var BY_ID = {};
  G.forEach(function (g) { BY_ID[g.id] = g; });

  /* ---------------- answers ---------------- */

  /* Accepts 1500, 1,500, 1.5e3, 1.5k, $1.5k, ~1500, 64%, "132 GB".
     Returns NaN for anything that is not a number. */
  function parseAnswer(raw) {
    var s = String(raw == null ? "" : raw).trim();
    s = s.replace(/^[~≈≃]\s*/, "").replace(/^\$\s*/, "");
    s = s.replace(/(\d)[,  ](?=\d{3}(?!\d))/g, "$1");
    var m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/i.exec(s);
    if (!m) return NaN;
    var x = parseFloat(m[1]), rest = m[2].trim().toLowerCase();
    if (/^[.,]\d/.test(rest)) return NaN;               /* "1,5" — ambiguous, refuse */
    if (rest === "k") x *= 1e3;
    else if (rest === "m") x *= 1e6;
    else if (rest === "b" || rest === "bn") x *= 1e9;
    return isFinite(x) ? x : NaN;
  }

  function grade(input, answer, tolerance) {
    var tol = tolerance === undefined ? 0.10 : tolerance;
    var x = typeof input === "number" ? input : parseAnswer(input);
    if (!isFinite(x)) return { verdict: "invalid" };
    var rel = Math.abs(x - answer) / Math.abs(answer);
    if (rel <= tol + 1e-9) return { verdict: "right", value: x, rel: rel };
    var scale = 0;
    if (x > 0 && answer > 0) {
      var k = Math.round(Math.log(x / answer) / Math.LN10);
      if (k !== 0 && Math.abs(k) <= 9 && Math.abs(x / Math.pow(10, k) - answer) / answer <= tol + 1e-9) scale = k;
    }
    return { verdict: rel <= Math.max(3 * tol, 0.05) ? "close" : "wrong", value: x, rel: rel, scale: scale };
  }

  /* ---------------- scheduling (Leitner) ---------------- */

  var STORE_KEY = "inf-review-v1";
  var INTERVALS = [1, 3, 7, 16, 35];   /* days, for boxes 1–5 */
  var DAY = 86400000;

  function startOfDay(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

  /* The next state of one card. `practice` = answered while not due:
     a right answer leaves the schedule alone (it was not a review), a
     wrong one is still evidence of forgetting and sends it to box 1. */
  function nextEntry(entry, correct, now, practice) {
    var e = entry ? { box: entry.box || 1, due: entry.due || 0, seen: entry.seen || 0, right: entry.right || 0 }
                  : { box: 1, due: 0, seen: 0, right: 0 };
    e.seen += 1;
    if (correct) {
      e.right += 1;
      if (practice && entry) return e;
      e.box = Math.min(5, e.box + 1);
      e.due = startOfDay(now) + INTERVALS[e.box - 1] * DAY;
    } else {
      e.box = 1;
      e.due = startOfDay(now) + INTERVALS[0] * DAY;
    }
    return e;
  }

  function isDue(entry, now) { return !entry || !(entry.due > now); }

  /* Warm-up: due cards from completed chapters strictly before `current`
     in course order. Reviews already scheduled come first (most overdue
     first), then cards never seen. `order` is the flat slug list. */
  function warmupPicks(opts) {
    var order = opts.order, idx = order.indexOf(opts.current);
    if (idx <= 0) return [];
    var state = opts.state || {}, completed = opts.completed || {}, now = opts.now;
    var pool = (opts.generators || GENERATORS).filter(function (g) {
      var ci = order.indexOf(g.chapter);
      return ci > -1 && ci < idx && completed[g.chapter] && isDue(state[g.id], now);
    });
    pool = (opts.shuffle || function (a) { return a; })(pool.slice());
    pool.sort(function (a, b) {
      var ea = state[a.id], eb = state[b.id];
      if (!!ea !== !!eb) return ea ? -1 : 1;
      return ea ? ea.due - eb.due : 0;
    });
    return pool.slice(0, opts.max || 3);
  }

  var api = {
    generators: GENERATORS,
    byId: BY_ID,
    formulas: F,
    chips: CHIPS,
    parseAnswer: parseAnswer,
    grade: grade,
    nextEntry: nextEntry,
    isDue: isDue,
    warmupPicks: warmupPicks,
    mulberry32: mulberry32,
    fmt: n,
    withUnit: withUnit,
    STORE_KEY: STORE_KEY,
    INTERVALS: INTERVALS
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.InfReview = api;

  /* ============================================================
     Browser only from here on.
     ============================================================ */

  if (typeof document === "undefined" || typeof window === "undefined") return;

  var W = window.InfWidgets;
  if (!W) return;   /* host missing — the chapters still read fine */

  /* Pages that are not read in order get no warm-up. */
  var NO_WARMUP = { glossary: 1, review: 1, "mixed-problems": 1 };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* COURSE and COURSE_META are top-level `const`s in inf.js: global
     bindings, but not properties of window. */
  function courseFlat() {
    try {
      /* global COURSE */
      if (typeof COURSE !== "undefined") {
        return COURSE.reduce(function (acc, m) { return acc.concat(m.chapters); }, []);
      }
    } catch (e) { /* fall through */ }
    return [];
  }
  function courseOrder() { return courseFlat().map(function (c) { return c.slug; }); }
  function chapterTitle(slug) {
    var c = courseFlat().filter(function (x) { return x.slug === slug; })[0];
    return c ? c.title : slug;
  }
  function progressKey() {
    try {
      /* global COURSE_META */
      if (typeof COURSE_META !== "undefined" && COURSE_META.storeKey) return COURSE_META.storeKey;
    } catch (e) { /* fall through */ }
    return "inf-course-progress-v1";
  }

  /* ---------------- storage, every access guarded ---------------- */

  var memState = null;     /* survives a refused write for this page's lifetime */

  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { memState = parsed; return parsed; }
    } catch (e) { /* storage blocked or corrupt */ }
    return memState || (memState = {});
  }
  function saveState(state) {
    memState = state;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); return true; }
    catch (e) { return false; }
  }
  function loadCompleted() {
    try {
      var p = JSON.parse(window.localStorage.getItem(progressKey()) || "null");
      return (p && p.completed && typeof p.completed === "object") ? p.completed : {};
    } catch (e) { return {}; }
  }
  /* returns whether the write landed */
  function record(id, correct, practice) {
    var st = loadState();
    st[id] = nextEntry(st[id], correct, Date.now(), practice);
    return saveState(st);
  }

  function seed() {
    try {
      var a = new Uint32Array(1);
      window.crypto.getRandomValues(a);
      return a[0];
    } catch (e) { return Math.floor(Math.random() * 4294967296); }
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = a[i];
      a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* focus without letting the site-wide smooth scroll animate it */
  function focusQuiet(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    var r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "nearest", behavior: "instant" });
  }

  var uid = 0;

  /* ---------------- one card ---------------- */

  function tolText(tol) {
    return tol < 0.005 ? "Exact answer needed." : "Within " + v(Math.round(tol * 100)) + "% counts.";
  }

  function renderCard(host, g, ctx) {
    var problem = g.make(mulberry32(seed()));
    var id = "infr-" + (++uid);
    var card = document.createElement("div");
    card.className = "inf-review-card";
    card.dataset.generator = g.id;
    /* for the browser tests; never rendered */
    card._infReview = { id: g.id, answer: problem.answer, tolerance: problem.tolerance };

    card.innerHTML =
      (ctx.meta ? "<p class=\"inf-review-meta\">" + esc(ctx.meta) + "</p>" : "") +
      "<p class=\"inf-review-prompt\" id=\"" + id + "-q\">" + esc(problem.prompt) + "</p>" +
      "<form class=\"inf-review-form\" novalidate>" +
        "<label class=\"inf-review-label\" for=\"" + id + "-a\">Your answer</label>" +
        "<div class=\"inf-review-row\">" +
          "<input class=\"inf-review-input\" id=\"" + id + "-a\" type=\"text\" inputmode=\"decimal\" " +
            "autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" " +
            "aria-describedby=\"" + id + "-q " + id + "-u " + id + "-h\">" +
          "<span class=\"inf-review-unit\" id=\"" + id + "-u\">" + esc(problem.unit) + "</span>" +
        "</div>" +
        "<p class=\"inf-review-hint\" id=\"" + id + "-h\">" + tolText(problem.tolerance) +
          " 1500, 1,500, 1.5e3 and 1.5k all work.</p>" +
        "<div class=\"inf-review-buttons\">" +
          "<button type=\"submit\" class=\"inf-btn inf-review-check\">Check</button>" +
          "<button type=\"button\" class=\"inf-btn inf-review-reveal\">Show the answer</button>" +
        "</div>" +
      "</form>" +
      "<div class=\"inf-review-verdict\" role=\"status\" aria-live=\"polite\" aria-atomic=\"true\"></div>" +
      "<div class=\"inf-review-solution\" hidden>" +
        "<p class=\"inf-review-solution-title\">Worked solution</p>" +
        problem.solution.split("\n").map(function (l) { return "<p class=\"inf-review-step\">" + esc(l) + "</p>"; }).join("") +
        "<p class=\"inf-review-source\">Taught in <a href=\"#/" + esc(g.chapter) + "\">" + esc(chapterTitle(g.chapter)) + "</a></p>" +
      "</div>" +
      "<div class=\"inf-review-next-row\" hidden>" +
        "<button type=\"button\" class=\"inf-btn inf-review-next\">" + esc(ctx.nextLabel || "Next") + "</button>" +
        "<span class=\"inf-review-saved\" role=\"status\"></span>" +
      "</div>";

    host.appendChild(card);

    var form = card.querySelector("form"), input = card.querySelector("input");
    var verdict = card.querySelector(".inf-review-verdict");
    var expected = withUnit(problem.answer, problem.unit);
    var answered = false;

    function finish(result, typed) {
      answered = true;
      input.readOnly = true;
      card.querySelector(".inf-review-check").disabled = true;
      card.querySelector(".inf-review-reveal").disabled = true;
      var cls = result.verdict === "right" ? "right" : result.verdict === "close" ? "close" : "wrong";
      card.classList.add("is-" + cls);
      var msg;
      if (result.verdict === "right") {
        msg = "<strong>✓ Right.</strong> Expected " + esc(expected) + "; you said " + esc(typed) + ".";
      } else if (result.verdict === "close") {
        msg = "<strong>≈ Close, not yet.</strong> Expected " + esc(expected) + "; you were " +
              esc(n(result.rel * 100)) + "% off. " + esc(tolText(problem.tolerance));
      } else if (result.verdict === "reveal") {
        msg = "<strong>✗ Not yet.</strong> Expected " + esc(expected) + ".";
      } else {
        msg = "<strong>✗ Not yet.</strong> Expected " + esc(expected) + "; you said " + esc(typed) + ".";
      }
      if (result.scale) {
        msg += " The digits are right but you are off by a factor of 10" + (result.scale > 0 ? "^" : "^−") +
               Math.abs(result.scale) + ": check the unit.";
      }
      verdict.className = "inf-review-verdict " + cls;
      verdict.innerHTML = msg;
      card.querySelector(".inf-review-solution").hidden = false;
      var row = card.querySelector(".inf-review-next-row");
      row.hidden = false;
      var saved = ctx.onGraded ? ctx.onGraded(result.verdict === "right") : true;
      if (saved === false) {
        card.querySelector(".inf-review-saved").textContent =
          "This browser is blocking local storage, so the schedule lasts only until you leave the page.";
      }
      focusQuiet(card.querySelector(".inf-review-next"));
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (answered) return;
      var typed = input.value.trim();
      var r = grade(typed, problem.answer, problem.tolerance);
      if (r.verdict === "invalid") {
        verdict.className = "inf-review-verdict invalid";
        verdict.textContent = typed ? "That is not a number this deck can read — try 1500, 1,500, 1.5e3 or 1.5k."
                                    : "Type a number first.";
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      input.removeAttribute("aria-invalid");
      finish(r, typed);
    });
    card.querySelector(".inf-review-reveal").addEventListener("click", function () {
      if (!answered) finish({ verdict: "reveal" }, "");
    });
    card.querySelector(".inf-review-next").addEventListener("click", function () {
      if (ctx.onNext) ctx.onNext();
    });
    return { card: card, input: input };
  }

  /* ---------------- deck mode ---------------- */

  var BOX_NOTE = ["daily", "every 3 days", "weekly", "every 16 days", "every 35 days"];

  function mountDeck(el) {
    el.classList.add("inf-review", "inf-review-deck");
    el.innerHTML =
      "<div class=\"inf-widget-head\"><h3>Review deck</h3>" +
      "<p>Fresh numbers every time, on calculations from the chapters you have completed.</p></div>" +
      "<div class=\"inf-widget-body\">" +
        "<ul class=\"inf-review-boxes\" aria-label=\"Cards per box\"></ul>" +
        "<p class=\"inf-review-summary\"></p>" +
        "<label class=\"inf-toggle inf-review-include\"><input type=\"checkbox\"> include chapters I have not completed yet</label>" +
        "<div class=\"inf-review-stage\"></div>" +
      "</div>";

    var boxesEl = el.querySelector(".inf-review-boxes"), summaryEl = el.querySelector(".inf-review-summary");
    var stage = el.querySelector(".inf-review-stage"), include = el.querySelector(".inf-review-include input");
    var pile = [], dealt = 0, lastPractice = null;

    function eligible() {
      var done = loadCompleted();
      return GENERATORS.filter(function (g) { return include.checked || done[g.chapter]; });
    }

    function buildPile() {
      var st = loadState(), now = Date.now();
      pile = shuffle(eligible().filter(function (g) { return isDue(st[g.id], now); }));
      dealt = 0;
    }

    function renderStats() {
      var st = loadState(), now = Date.now(), list = eligible();
      var counts = [0, 0, 0, 0, 0, 0], due = 0;
      list.forEach(function (g) {
        var e = st[g.id];
        counts[e ? Math.min(5, Math.max(1, e.box || 1)) : 0] += 1;
        if (isDue(e, now)) due += 1;
      });
      var tiles = [{ label: "New", count: counts[0], note: "never seen" }];
      for (var b = 1; b <= 5; b++) tiles.push({ label: "Box " + b, count: counts[b], note: BOX_NOTE[b - 1] });
      boxesEl.innerHTML = tiles.map(function (t) {
        return "<li><span class=\"inf-result-label\">" + t.label + "</span>" +
               "<span class=\"inf-result-value\">" + t.count + "</span>" +
               "<span class=\"inf-result-note\">" + t.note + "</span></li>";
      }).join("");
      var chapters = {};
      list.forEach(function (g) { chapters[g.chapter] = 1; });
      var nCh = Object.keys(chapters).length;
      summaryEl.innerHTML = "<strong>" + due + " due now</strong>, " + list.length + " card" + (list.length === 1 ? "" : "s") +
        " from " + nCh + " chapter" + (nCh === 1 ? "" : "s") +
        (include.checked ? " (every chapter included)" : " you have completed");
    }

    function nextDueLabel() {
      var st = loadState(), now = Date.now(), soonest = Infinity;
      eligible().forEach(function (g) { var e = st[g.id]; if (e && e.due > now && e.due < soonest) soonest = e.due; });
      if (!isFinite(soonest)) return "";
      var days = Math.max(1, Math.round((soonest - startOfDay(now)) / DAY));
      return days === 1 ? "tomorrow" : "in " + days + " days";
    }

    function renderEmpty(focus) {
      stage.innerHTML = "";
      var box = document.createElement("div");
      box.className = "inf-review-empty";
      var list = eligible();
      if (!list.length) {
        box.innerHTML = "<p>No cards yet. Each card belongs to the chapter that teaches its formula, and it joins the " +
          "deck when you complete that chapter's quiz. Tick the box above to practise everything now.</p>";
        stage.appendChild(box);
        return;
      }
      var when = nextDueLabel();
      box.innerHTML = "<p><strong>Nothing is due.</strong> " +
        (dealt ? "That was the whole pile. " : "") +
        (when ? "The next card comes due " + when + "." : "") + "</p>" +
        "<button type=\"button\" class=\"inf-btn inf-review-practise\">Practise anyway</button>";
      stage.appendChild(box);
      var btn = box.querySelector("button");
      btn.addEventListener("click", function () { practise(true); });
      if (focus) focusQuiet(btn);
    }

    function deal(focus) {
      renderStats();
      stage.innerHTML = "";
      if (!pile.length) { renderEmpty(focus); return; }
      var g = pile.shift(), st = loadState(), e = st[g.id];
      dealt += 1;
      var r = renderCard(stage, g, {
        meta: "Card " + dealt + " of " + (dealt + pile.length) + ", " + (e ? "box " + e.box : "new card"),
        onGraded: function (ok) { var s = record(g.id, ok, false); renderStats(); return s; },
        onNext: function () { deal(true); }
      });
      if (focus) focusQuiet(r.input);
    }

    function practise(focus) {
      renderStats();
      var list = eligible().filter(function (g) { return g !== lastPractice; });
      if (!list.length) list = eligible();
      var g = list[Math.floor(Math.random() * list.length)];
      lastPractice = g;
      stage.innerHTML = "";
      var r = renderCard(stage, g, {
        meta: "Practice: a right answer leaves the schedule alone; a miss sends the card back to box 1",
        onGraded: function (ok) { var s = record(g.id, ok, true); renderStats(); return s; },
        onNext: function () { practise(true); },
        nextLabel: "Another"
      });
      var stop = document.createElement("button");
      stop.type = "button";
      stop.className = "inf-btn inf-review-stop";
      stop.textContent = "Back to the due pile";
      stop.addEventListener("click", function () { buildPile(); deal(true); });
      r.card.querySelector(".inf-review-next-row").insertBefore(stop, r.card.querySelector(".inf-review-saved"));
      if (focus) focusQuiet(r.input);
    }

    include.addEventListener("change", function () { buildPile(); deal(false); });

    buildPile();
    deal(false);   /* never steal focus on mount */
  }

  /* ---------------- warm-up mode ---------------- */

  function mountWarmup(el) {
    var slug = el.dataset.chapter || routeSlug();
    var picks = warmupPicks({
      generators: GENERATORS, order: courseOrder(), current: slug,
      completed: loadCompleted(), state: loadState(), now: Date.now(), max: 3, shuffle: shuffle
    });
    if (!picks.length) { el.remove(); return; }      /* render nothing at all */

    el.classList.add("inf-review", "inf-review-warmup-host");
    var total = picks.length, right = 0, i = 0;
    el.innerHTML =
      "<details class=\"inf-review-warmup\">" +
        "<summary>Warm-up: " + total + " question" + (total === 1 ? "" : "s") + " from earlier chapters</summary>" +
        "<div class=\"inf-review-warmup-body\"></div>" +
      "</details>";
    var body = el.querySelector(".inf-review-warmup-body");

    function step(focus) {
      body.innerHTML = "";
      if (i >= total) {
        var done = document.createElement("p");
        done.className = "inf-review-done";
        done.setAttribute("tabindex", "-1");
        done.textContent = "Warm-up done: " + right + " of " + total + " right. " +
          (right < total ? "The ones you missed come back tomorrow. " : "") + "On to the chapter.";
        body.appendChild(done);
        if (focus) focusQuiet(done);
        return;
      }
      var g = picks[i];
      var r = renderCard(body, g, {
        meta: "Question " + (i + 1) + " of " + total,
        nextLabel: i + 1 < total ? "Next" : "Finish",
        onGraded: function (ok) { if (ok) right += 1; return record(g.id, ok, false); },
        onNext: function () { i += 1; step(true); }
      });
      if (focus) focusQuiet(r.input);
    }
    step(false);
  }

  W.define("review", function (el, opts) {
    if ((opts && opts.mode) === "warmup") mountWarmup(el);
    else mountDeck(el);
  });

  /* ---------------- warm-up injection ----------------
     Chapters are being rewritten, so the warm-up is not authored in the
     markdown. course.js swaps #view on every navigation and emits no
     event; like inf-widgets.js, watch the subtree. The article body
     carries a flag once handled, so the hook is idempotent — and the
     flag dies with the body on the next navigation. The rendered
     chapter is matched against the route through document.title, which
     course.js sets in the same task as the swap: a stale article under
     a fresh hash is left alone until its replacement arrives. */

  function routeSlug() {
    var hash = (window.location.hash || "").replace(/^#\/?/, "").trim();
    return hash.split("@")[0] || "";
  }

  function injectWarmup() {
    var view = document.getElementById("view");
    if (!view) return;
    var body = view.querySelector(".article-body");
    if (!body || body.dataset.infReviewWarmup) return;
    var slug = routeSlug(), order = courseOrder(), idx = order.indexOf(slug);
    if (idx === -1) return;
    var title = chapterTitle(slug);
    if (document.title.indexOf(title) !== 0) return;          /* not this chapter's render yet */
    if (idx === 0 || NO_WARMUP[slug]) { body.dataset.infReviewWarmup = "skip"; return; }
    body.dataset.infReviewWarmup = "1";

    var ph = document.createElement("div");
    ph.className = "inf-widget inf-review-warmup-slot";
    ph.dataset.widget = "review";
    ph.dataset.mode = "warmup";
    ph.dataset.chapter = slug;

    /* after the opening goal blockquote ("The question / You'll be able
       to"); failing that, after the h1; failing that, first */
    var firstH2 = body.querySelector(":scope > h2");
    var goal = body.querySelector(":scope > blockquote");
    if (goal && firstH2 && (goal.compareDocumentPosition(firstH2) & Node.DOCUMENT_POSITION_PRECEDING)) goal = null;
    var anchor = goal || body.querySelector(":scope > h1");
    if (anchor) anchor.insertAdjacentElement("afterend", ph);
    else body.insertBefore(ph, body.firstChild);
  }

  function observe() {
    var view = document.getElementById("view");
    if (!view) return;
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () { queued = false; injectWarmup(); });
    }).observe(view, { childList: true, subtree: true });
    injectWarmup();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe);
  else observe();
})(typeof window !== "undefined" ? window : globalThis);
