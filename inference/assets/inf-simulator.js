/* ============================================================
   Inference Engineering — the serving-engine simulator.

   Registered as InfWidgets.define("engine-simulator", …), so a
   chapter can carry nothing but

       <div class="inf-widget" data-widget="engine-simulator">
       <p class="inf-widget-fallback">…</p>
       </div>

   and inference/simulator.html can host the same thing full-page.

   This is a *toy*. It is not an engine and it does not pretend to
   be one. Its entire job is to make five claims from the chapters
   visible and true, by simulating the only three things that
   actually set serving performance: what the scheduler admits,
   where the KV blocks go, and how long a step takes.

   The step-cost model is the course's one model — the same
   formula, the same constants and the same ladder as the
   "Derived numbers" in inference/research/case.md — so a number
   the simulator shows is a number a chapter can quote. Nothing is
   tuned to look nice. That matters: if the constants were fudged,
   the "try this" lessons would be theatre. They are not — the
   batch-size inversion for speculative decoding, in particular,
   falls out of the arithmetic and is not special-cased anywhere
   in this file.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- the physics ----------------

     One replica = Llama-3.3-70B, BF16, tensor-parallel over four
     H100s (990 TFLOP/s dense BF16, 3.35 TB/s, 80 GB each). One step
     costs, exactly as case.md prices it:

         step ≈ max(t_w, t_c) + t_kv

     A hybrid step (a prefill chunk riding with decodes) is *not*
     prefill time plus decode time: the same matrix multiplies read
     the weights and do the arithmetic, so the two overlap.

     WEIGHTS, t_w. 140 GB / 4 GPUs = 35 GB per GPU, read once per
     step. The decode-time ladder:
       rung 1  physics floor      35 GB ÷ 3.35 TB/s          = 10.4 ms
       rung 2  achievable BW      ÷ (~85% × 3.35 TB/s)       = 12.3 ms
       rung 3  planning figure    + all-reduce and launches  ≈ 14 ms  ← W_MS
       rung 4  ~20 seqs × 3K ctx  + KV reads (below)         ≈ 16 ms
     t_w is paid *once per scheduler step* no matter how many
     sequences ride on it, which is the entire reason batching is
     nearly free below the knee — and it is the ITL floor. */
  const W_FLOOR_MS = 35e9 / 3.35e12 * 1000;   /* rung 1: 10.45 ms */
  const W_MS = 14;                            /* rung 3 */

  /* KV READS, t_kv. 328 KB of KV per token; split four ways that
     is 82 KB per context token per GPU, read at ~85% of 3.35 TB/s
     (2.85 TB/s): ≈ 29 ns per context token per sequence. It is
     added, not overlapped (case.md rung 4: 20 × 3,000 tokens ≈
     1.7 ms on top of the 14). Per-sequence and proportional to
     context, so unlike the weight read it *never batches away* —
     "attention doesn't batch away", as a line of code. */
  const KV_MS_PER_TOK = 82e3 / (0.85 * 3.35e12) * 1000;   /* 2.88e-5 ms */

  /* COMPUTE, t_c. 2 × 70e9 FLOPs per token on 4 × 990 TFLOP/s,
     at the *achieved* model-FLOPs utilisation (MFU, default 40%:
     1.58e15 FLOP/s → 0.089 ms per token, so a 3,000-token prefill
     is ~0.27 s and an unchunked 10,000-token one ~0.89 s).

     It is expressed through the B_crit control so that slider keeps
     meaning what the chapter says: the *nameplate* critical batch,
     peak FLOP/s ÷ peak byte/s — the token count at which the
     arithmetic at peak FLOPs takes as long as the weight read at
     peak bandwidth (rung 1). 295 on an H100 in BF16. So

         t_c per token = W_FLOOR_MS / (B_crit × MFU)

     and the *effective knee*, where t_c catches up with the real
     t_w of 14 ms, is

         knee = W_MS / t_c per token = B_crit × MFU × W_MS / W_FLOOR_MS
              = 295 × 0.40 × 1.34 ≈ 158 tokens per step.

     "Nameplate ~295, effective ~160 on this node, measure it." (The
     simulator used to price compute as tokens × W_MS / B_crit, which
     silently assumed ~75% MFU and made every prefill half as long as
     the chapters said.) */
  const MFU_DEFAULT = 0.40;
  function tokMs(cfg) { return W_FLOOR_MS / (cfg.bcrit * (cfg.mfu || MFU_DEFAULT)); }
  function knee(cfg) { return W_MS / tokMs(cfg); }

  /* Memory and compute overlap, but not perfectly. A hard max()
     draws the roofline as a corner; a cubic soft-max rounds it by
     ~26% at the knee, which is closer to a measured curve and
     still exactly max() at either extreme. */
  function softmax3(a, b) { return Math.cbrt(a * a * a + b * b * b); }

  /* A draft model ~1/14 the size of the target: its weight read,
     its KV read and its per-token FLOPs all scale together. */
  const DRAFT_FRAC = 0.07;

  const GPUS = 4;
  /* vLLM's default --block-size: 64 tokens since v0.34.0 (16 before;
     vllm/config/cache.py, DEFAULT_BLOCK_SIZE). Prefix caching shares
     only *full* blocks, so the 800-token system prompt is cached as
     12 blocks = 768 tokens and the last 32 are recomputed. */
  const BLOCK = 64;
  const REQ_OVERHEAD_MS = 25;      /* tokenize + admission + wire; TTFT floor */
  const MAX_SLOTS = 64;            /* what fits legibly on the canvas */

  /* One scheduler step, in model-milliseconds. `spec` is passed in
     rather than read from cfg so the caller can price the *same*
     step both ways and show the reader the counterfactual. */
  function stepCost(cfg, nDecode, prefillTok, kvTok, spec) {
    const g = spec ? cfg.gamma : 0;
    const draft = 1 + g * DRAFT_FRAC;
    const tW = W_MS * draft;
    const tKv = kvTok * KV_MS_PER_TOK * draft;
    /* Speculation verifies γ+1 positions per sequence in one pass,
       and burns γ draft-model token-passes on top. Both land in the
       compute term — which is why they are free when memory-bound
       and pure waste when not. */
    const tokens = prefillTok + nDecode * (1 + g) + nDecode * g * DRAFT_FRAC;
    return softmax3(tW, tokens * tokMs(cfg)) + tKv;
  }

  /* Expected tokens per verify: (1 − α^(γ+1))/(1 − α). Computed
     unconditionally, because the widget prices every step *both*
     ways to show the reader what speculation would do right now. */
  function accepted(cfg) {
    const a = cfg.alpha, g = cfg.gamma;
    return a >= 0.999 ? g + 1 : (1 - Math.pow(a, g + 1)) / (1 - a);
  }

  /* ---------------- determinism ----------------
     mulberry32. Math.random would make the presets un-repeatable,
     and a preset you cannot re-run twice is not a lesson. */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Real prompt and output lengths are heavy-tailed: mostly short,
     with a long tail that is exactly what breaks static batching.
     Log-normal via Box–Muller. */
  function lognorm(r, median, sigma) {
    const u = Math.max(r(), 1e-9), v = r();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(8, Math.round(median * Math.exp(sigma * z)));
  }

  /* ---------------- workloads ----------------
     `prefix` returns the cache key and length of the span this
     request shares with others. Sharing is what prefix caching
     eats; "mixed" deliberately shares nothing. */
  const WORKLOADS = {
    chat:  { label: "Chat — 800-token system prompt", tail: [320, 0.9], out: [190, 1.0],
             prefix: function () { return { key: "sys", len: 800 }; } },
    rag:   { label: "RAG — six hot documents", tail: [200, 0.8], out: [220, 0.9],
             prefix: function (s) { return { key: "doc" + Math.floor(s.rng() * 6), len: 3000 }; } },
    agent: { label: "Agent — long growing shared prefix", tail: [420, 0.55], out: [130, 0.8],
             /* The agent loop from the agentic chapter: every
                iteration appends a tool result to a context that
                only ever grows, so the shared prefix creeps toward
                20K while each new request adds a few hundred
                tokens of its own. */
             prefix: function (s) {
               const len = s.agentPrefix;
               s.agentPrefix = Math.min(20000, s.agentPrefix + 600);
               return { key: "agent", len: len };
             } },
    mixed: { label: "Mixed — unique prompts, nothing shared", tail: [900, 1.2], out: [260, 1.1],
             prefix: function () { return { key: null, len: 0 }; } },
  };

  /* ---------------- the simulator ---------------- */

  function Sim(cfg) { this.cfg = cfg; this.reset(); }

  Sim.prototype.reset = function () {
    const c = this.cfg;
    this.rng = makeRng(c.seed || 12345);
    this.t = 0;                 /* model time, ms */
    this.nextArrival = 0;
    this.nextGiant = 3000;
    this.agentPrefix = 2000;
    this.queue = [];
    this.running = [];
    this.nextId = 1;
    this.pool = new Array(c.pool).fill(null);   /* idx → {refs, c, shared, flash} */
    this.free = [];
    for (let i = c.pool - 1; i >= 0; i--) this.free.push(i);
    this.cache = new Map();     /* prefix key → {len, blocks, use} */
    this.clock = 0;             /* LRU stamp */
    this.ttft = []; this.itl = []; this.itlEv = [];
    this.outTokens = 0; this.recompute = 0; this.preempts = 0;
    this.spark = { ttft: [], itl: [], tps: [] };
    this.specGain = 0;
    this.stepMs = W_MS;
    this.tokTok = 0;            /* tokens in the last step, for the regime line */
  };

  Sim.prototype.resizePool = function (n) {
    /* Growing is easy. Shrinking has to evict, which is the point:
       the reader drags the pool down and watches preemption start. */
    const c = this.cfg;
    if (n > this.pool.length) {
      for (let i = this.pool.length; i < n; i++) { this.pool.push(null); this.free.push(i); }
    } else if (n < this.pool.length) {
      for (let i = n; i < this.pool.length; i++) if (this.pool[i]) this.evictBlockOwners(i);
      this.pool.length = n;
      this.free = this.free.filter(function (i) { return i < n; });
      /* Anything still pointing past the end is dropped by the
         owner sweep above, so the free list is authoritative. */
    }
    c.pool = n;
  };

  /* Nuking a block index: drop every sequence and cache entry that
     references it. Only used when the pool shrinks under them. */
  Sim.prototype.evictBlockOwners = function (idx) {
    const self = this;
    this.cache.forEach(function (e, k) { if (e.blocks.indexOf(idx) >= 0) { self.releaseEntry(k); } });
    for (let i = this.running.length - 1; i >= 0; i--) {
      if (this.running[i].blocks.indexOf(idx) >= 0) this.preempt(this.running[i]);
    }
  };

  /* ---- block pool ---- */

  Sim.prototype.allocBlocks = function (n, colour) {
    while (this.free.length < n && this.evictLru()) { /* keep trying */ }
    if (this.free.length < n) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
      const idx = this.free.pop();
      this.pool[idx] = { refs: 1, c: colour, shared: false, flash: 0 };
      out.push(idx);
    }
    return out;
  };

  Sim.prototype.ref = function (idx) { if (this.pool[idx]) this.pool[idx].refs++; };

  Sim.prototype.unref = function (idx) {
    const cell = this.pool[idx];
    if (!cell) return;
    if (--cell.refs <= 0) { this.pool[idx] = null; this.free.push(idx); }
  };

  /* LRU eviction of a *cache entry*. Its blocks only actually come
     back if nothing live still holds them — refcounts, exactly as
     in the chapter. Returns true if it freed anything. */
  Sim.prototype.evictLru = function () {
    let oldest = null, key = null;
    this.cache.forEach(function (e, k) { if (!oldest || e.use < oldest.use) { oldest = e; key = k; } });
    if (!key) return false;
    const before = this.free.length;
    this.releaseEntry(key);
    return this.free.length > before;
  };

  Sim.prototype.releaseEntry = function (key) {
    const e = this.cache.get(key);
    if (!e) return;
    this.cache.delete(key);
    for (let i = 0; i < e.blocks.length; i++) {
      const cell = this.pool[e.blocks[i]];
      if (cell) { cell.shared = false; cell.flash = 1; }
      this.unref(e.blocks[i]);
    }
  };

  /* ---- arrivals ---- */

  Sim.prototype.makeRequest = function (giant) {
    const w = WORKLOADS[this.cfg.workload] || WORKLOADS.chat;
    const p = giant ? { key: null, len: 0 } : w.prefix(this);
    const tail = giant ? 10000 : lognorm(this.rng, w.tail[0], w.tail[1]);
    return {
      id: this.nextId++,
      prefixKey: p.key, prefixLen: p.len,
      prompt: p.len + tail,
      out: giant ? 120 : lognorm(this.rng, w.out[0], w.out[1]),
      arrive: this.t, giant: !!giant,
    };
  };

  /* ---- admission ---- */

  Sim.prototype.admit = function (req) {
    const c = this.cfg;
    let hitTok = 0, borrowed = [];
    if (c.prefixCache && req.prefixKey) {
      const e = this.cache.get(req.prefixKey);
      if (e) {
        const nb = Math.floor(Math.min(e.len, req.prefixLen) / BLOCK);
        for (let i = 0; i < nb; i++) { borrowed.push(e.blocks[i]); this.ref(e.blocks[i]); }
        hitTok = nb * BLOCK;
        e.use = ++this.clock;
        for (let i = 0; i < nb; i++) if (this.pool[e.blocks[i]]) this.pool[e.blocks[i]].flash = 1;
      }
    }
    /* Admission control. Blocks are handed out lazily as the
       context grows, but the scheduler still refuses to *start*
       what it cannot finish — otherwise it admits sixty-four
       sequences on one block each and thrashes them all to death.
       This is the "hold it in the queue" half of the chapter. */
    const need = Math.ceil((req.prompt - hitTok) / BLOCK);
    while (this.free.length < need && this.evictLru()) { /* try harder */ }
    if (this.free.length < need) {
      for (let i = 0; i < borrowed.length; i++) this.unref(borrowed[i]);
      return false;
    }
    const seq = {
      id: req.id, req: req, colour: req.id % 6,
      need: req.prompt,       /* tokens that must be prefilled before decode */
      ctx: hitTok, filled: hitTok, produced: 0,
      blocks: borrowed, state: "prefill", dead: false,
      first: -1, lastTok: this.t, restarts: 0, hit: hitTok,
    };
    /* A borrowed prefix is already resident; only the tail needs
       new blocks, and it needs them now or the request waits. */
    if (!this.grow(seq)) { for (let i = 0; i < borrowed.length; i++) this.unref(borrowed[i]); return false; }
    this.running.push(seq);
    return true;
  };

  /* Make sure the sequence owns enough blocks for its context.
     Returns false if the pool could not be persuaded to yield. */
  Sim.prototype.grow = function (seq) {
    const want = Math.max(1, Math.ceil(seq.ctx / BLOCK));
    if (seq.blocks.length >= want) return true;
    const got = this.allocBlocks(want - seq.blocks.length, seq.colour);
    if (!got) return false;
    for (let i = 0; i < got.length; i++) seq.blocks.push(got[i]);
    return true;
  };

  /* Preempt by recompute — vLLM V1's default. Drop the KV, push
     the request back to the *head* of the queue, and rebuild on
     resume from prompt + everything it has generated so far. With
     prefix caching on, the rebuild reuses the cached prefix and
     only re-runs the tail, which is exactly why recompute is the
     sane default. The recomputed tokens are counted so the cost
     shows up in the meters instead of vanishing. */
  Sim.prototype.preempt = function (seq) {
    for (let i = 0; i < seq.blocks.length; i++) {
      const cell = this.pool[seq.blocks[i]];
      if (cell) cell.flash = 2;
      this.unref(seq.blocks[i]);
    }
    const at = this.running.indexOf(seq);
    if (at >= 0) this.running.splice(at, 1);
    seq.req.resume = { produced: seq.produced, restarts: seq.restarts + 1 };
    this.queue.unshift(seq.req);
    this.preempts++;
  };

  Sim.prototype.release = function (seq) {
    for (let i = 0; i < seq.blocks.length; i++) this.unref(seq.blocks[i]);
    const at = this.running.indexOf(seq);
    if (at >= 0) this.running.splice(at, 1);
  };

  /* ---- one scheduler step ---- */

  Sim.prototype.step = function () {
    const c = this.cfg;

    /* 1. Reap. Continuous batching frees the slot the instant the
          sequence is done. Static batching cannot: the cohort runs
          until the last member finishes, so a finished sequence
          keeps its slot, keeps its KV, and keeps costing a padding
          row in every remaining step. Those are the dead slots. */
    for (let i = this.running.length - 1; i >= 0; i--) {
      const s = this.running[i];
      if (s.state === "done" && c.mode === "continuous") this.release(s);
    }
    if (c.mode === "static" && this.running.length &&
        this.running.every(function (s) { return s.state === "done"; })) {
      for (let i = this.running.length - 1; i >= 0; i--) this.release(this.running[i]);
    }

    /* 2. Admit. FCFS. Static holds the door shut until the whole
          cohort has drained — which is the other half of its cost:
          a request that arrives one step late waits for a drain. */
    const canAdmit = c.mode === "continuous" || this.running.length === 0;
    while (canAdmit && this.queue.length && this.running.length < MAX_SLOTS) {
      if (!this.admit(this.queue[0])) break;
      const r = this.queue.shift();
      if (r.resume) {
        /* Resumed after preemption: re-prefill prompt + generated. */
        const s = this.running[this.running.length - 1];
        s.produced = r.resume.produced;
        s.restarts = r.resume.restarts;
        s.need = r.prompt + r.resume.produced;
        s.first = 0;               /* TTFT was already paid and recorded */
        r.resume = null;
      }
    }

    /* 3. Fill the token budget. A decoding sequence asks for one
          token (γ+1 verify positions under speculation); a
          prefilling one asks for a chunk, or — with chunking off —
          for its whole remaining prompt, which is precisely the
          10K-token megastep the interference section describes. */
    let prefillTok = 0, kvTok = 0, nDecode = 0;
    const budget = c.chunked ? c.chunk : Infinity;
    const starved = [];
    for (let i = 0; i < this.running.length; i++) {
      const s = this.running[i];
      kvTok += s.ctx;
      if (s.state === "decode") {
        nDecode++;
        /* The token it produced last step may have crossed into a new
           block. Decode growth is the classic preemption trigger, so a
           failure here queues it for step 4 like a starved prefill. */
        if (!this.grow(s)) starved.push({ s: s, take: 0 });
        continue;
      }
      if (s.state !== "prefill") continue;              /* done/dead: padding only */
      if (prefillTok >= budget) continue;
      let take = Math.min(s.need - s.filled, budget - prefillTok);
      if (!c.chunked) take = s.need - s.filled;
      if (take <= 0) continue;
      s.ctx += take;
      if (!this.grow(s)) { s.ctx -= take; starved.push({ s: s, take: take }); continue; }
      kvTok += take;
      s.filled += take;
      prefillTok += take;
      if (!c.chunked) break;       /* one giant prefill owns the step */
    }
    /* Static batching pays for its dead rows: they still occupy a
       row of every tensor in the step even though nothing comes
       out of them. */
    let dead = 0;
    for (let i = 0; i < this.running.length; i++) if (this.running[i].state === "done") dead++;

    /* 4. Out of blocks. Preempt the newest running sequence — LIFO,
          so the ones nearest completion survive — until the starved
          ones can grow. */
    for (let k = 0; k < starved.length; k++) {
      const s = starved[k].s, take = starved[k].take;
      /* An earlier starved sequence may already have preempted this
         one. Growing it now would hand blocks to a sequence nobody
         runs — they were never freed, and the pool slowly filled with
         orphans until nothing could be admitted at all. */
      if (this.running.indexOf(s) < 0) continue;
      let guard = 0;
      while (guard++ < 8) {
        s.ctx += take;
        if (this.grow(s)) { s.filled += take; prefillTok += take; kvTok += take; break; }
        s.ctx -= take;
        let victim = null;
        for (let i = this.running.length - 1; i >= 0; i--) {
          if (this.running[i] !== s && this.running[i].state !== "done") { victim = this.running[i]; break; }
        }
        if (!victim) break;                    /* nothing left to sacrifice */
        this.recompute += victim.produced + victim.req.prompt - victim.hit;
        this.preempt(victim);
      }
    }

    /* 5. Price the step — both ways, so the reader can always see
          what speculation would have cost or saved right now.

          The comparison counts every token the step moves, prompt
          and output alike. Counting output alone flattered
          speculation at high load: a busy step always carries a
          prefill chunk, the drafts' extra FLOPs look small next to
          it, and the readout stayed at +100% while the tok/s meter
          fell. Past the knee the drafts' FLOPs are taken from the
          prefill that shares the step — that displacement is the
          cost, and this is where it shows. */
    const E = accepted(c);
    const dt = stepCost(c, nDecode + dead, prefillTok, kvTok, c.spec);
    const other = stepCost(c, nDecode + dead, prefillTok, kvTok, !c.spec);
    const tpsNow = (prefillTok + nDecode * (c.spec ? E : 1)) / dt;
    const tpsAlt = (prefillTok + nDecode * (c.spec ? 1 : E)) / other;
    if (nDecode > 0) {
      const gain = c.spec ? (tpsNow / tpsAlt - 1) : (tpsAlt / tpsNow - 1);
      this.specGain += (gain * 100 - this.specGain) * 0.05;
    }
    this.stepMs = dt;
    this.tokTok = prefillTok + (nDecode + dead) * (c.spec ? c.gamma + 1 : 1);
    this.t += dt;

    /* 6. Advance every sequence by what the step actually bought. */
    for (let i = this.running.length - 1; i >= 0; i--) {
      const s = this.running[i];
      if (s.state === "prefill" && s.filled >= s.need) {
        s.state = "decode";
        if (s.first < 0) { s.first = this.t; this.ttft.push(this.t - s.req.arrive + REQ_OVERHEAD_MS); }
        /* The prefix it just computed is now worth caching. */
        if (c.prefixCache && s.req.prefixKey && s.req.prefixLen >= BLOCK) {
          const nb = Math.floor(s.req.prefixLen / BLOCK);
          const e = this.cache.get(s.req.prefixKey);
          if ((!e || e.len < s.req.prefixLen) && s.blocks.length >= nb) {
            if (e) this.releaseEntry(s.req.prefixKey);
            const blocks = s.blocks.slice(0, nb);
            for (let b = 0; b < nb; b++) {
              this.ref(blocks[b]);
              if (this.pool[blocks[b]]) this.pool[blocks[b]].shared = true;
            }
            this.cache.set(s.req.prefixKey, { len: nb * BLOCK, blocks: blocks, use: ++this.clock });
          }
        }
        s.lastTok = this.t;
        continue;
      }
      if (s.state !== "decode") continue;
      /* Sample acceptance rather than using the mean, so the
         sparklines have the jitter a real engine has. */
      let got = 1;
      if (c.spec) { got = 1; while (got <= c.gamma && this.rng() < c.alpha) got++; }
      s.produced += got;
      s.ctx += got;
      this.outTokens += got;
      this.itl.push(dt / got);
      this.itlEv.push([this.t, dt / got]);
      s.lastTok = this.t;
      /* a failed grow here is resolved at the top of the next step */
      this.grow(s);
      if (s.produced >= s.req.out) { s.state = "done"; if (c.mode === "continuous") this.release(s); }
    }

    if (this.ttft.length > 200) this.ttft.splice(0, this.ttft.length - 200);
    if (this.itl.length > 600) this.itl.splice(0, this.itl.length - 600);
    /* The worst gap in the last two seconds of model time. A p50
       or a mean hides a prefill stall — one 890 ms megastep among
       150 healthy ones barely moves either — and hiding it is
       exactly the wrong thing for lesson 2. */
    while (this.itlEv.length && this.itlEv[0][0] < this.t - 2000) this.itlEv.shift();
  };

  /* Poisson arrivals over an interval of model time. */
  Sim.prototype.arrivals = function (untilT) {
    const c = this.cfg;
    let guard = 0;
    while (this.nextArrival <= untilT && guard++ < 500) {
      this.queue.push(this.makeRequest(false));
      const lam = Math.max(0.1, c.arrival) / 1000;
      this.nextArrival += -Math.log(Math.max(this.rng(), 1e-9)) / lam;
    }
    while (c.giant && this.nextGiant <= untilT) {
      this.queue.push(this.makeRequest(true));
      this.nextGiant += 3000;
    }
    if (!c.giant) this.nextGiant = Math.max(this.nextGiant, untilT + 3000);
  };

  /* ---- meters ---- */

  function pct(arr, p) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  Sim.prototype.meters = function () {
    const used = this.pool.length - this.free.length;
    let itlMax = 0;
    for (let i = 0; i < this.itlEv.length; i++) if (this.itlEv[i][1] > itlMax) itlMax = this.itlEv[i][1];
    return {
      ttft50: pct(this.ttft, 0.5), ttft99: pct(this.ttft, 0.99),
      itl: pct(this.itl, 0.5), itlMax: itlMax,
      tps: this.t > 0 ? this.outTokens / (this.t / 1000) / GPUS : 0,
      queue: this.queue.length, running: this.running.length,
      util: this.pool.length ? used / this.pool.length : 0,
      preempts: this.preempts, recompute: this.recompute,
      specGain: this.specGain, tokens: this.tokTok, step: this.stepMs,
    };
  };

  /* ============================================================
     The widget
     ============================================================ */

  /* Pool sizes are in 64-token blocks: 1,500 blocks = 96K tokens of
     context, about a quarter of the case node's real 132 GB pool
     (~400K tokens), so the squeeze is reachable on a canvas this size. */
  const PRESETS = [
    { name: "1. Static batching",
      cfg: { mode: "static", workload: "chat", arrival: 6, chunked: true, prefixCache: true,
             pool: 1500, bcrit: 295, mfu: 0.40, spec: false, giant: false, chunk: 512 },
      note: "Static: a finished sequence goes grey and still holds its slot until the whole cohort drains, and the queue climbs behind the closed door. Flip Batching back to Continuous and watch both go away." },
    { name: "2. A 10K prompt, unchunked",
      cfg: { mode: "continuous", workload: "chat", arrival: 6, chunked: false, prefixCache: true,
             pool: 1500, bcrit: 295, mfu: 0.40, spec: false, giant: true, chunk: 512 },
      note: "A 10,000-token prompt lands every 3 s with chunking off: one ~0.9 s megastep (10,000 × 0.089 ms at 40% MFU), and every decoder's worst ITL jumps to match it. Tick 'chunked prefill' — the spike flattens into a standing tax of ~50 ms steps while the chunks go through." },
    { name: "3. Agent, no prefix cache",
      cfg: { mode: "continuous", workload: "agent", arrival: 3, chunked: true, prefixCache: false,
             pool: 1250, bcrit: 295, mfu: 0.40, spec: false, giant: false, chunk: 512 },
      note: "Agent traffic re-prefilling its whole growing context every iteration. Tick 'prefix caching' and watch TTFT fall by roughly an order of magnitude as the green shared blocks appear." },
    { name: "4. Squeeze the KV pool",
      cfg: { mode: "continuous", workload: "rag", arrival: 6, chunked: true, prefixCache: true,
             pool: 175, bcrit: 295, mfu: 0.40, spec: false, giant: false, chunk: 512 },
      note: "The pool is too small for the working set: allocation fails, the newest sequences flash rust and restart from their prompt, and the recompute shows up as lost tokens/s. Drag KV pool right until it stops." },
    { name: "5. Cross the knee",
      cfg: { mode: "continuous", workload: "chat", arrival: 24, chunked: true, prefixCache: true,
             pool: 1500, bcrit: 120, mfu: 0.40, spec: false, giant: false, chunk: 64 },
      note: "B_crit is pulled down to 120 here — a what-if chip with less arithmetic per byte than an H100's 295 — so that at 40% MFU the effective knee sits at ~64 tokens per step, which this 64-slot canvas can reach. Drag arrival rate from 2 to 24: ITL sits near the 14 ms floor while the step carries well under the knee, then climbs once it passes it." },
    { name: "6. Speculation past the knee",
      cfg: { mode: "continuous", workload: "chat", arrival: 24, chunked: true, prefixCache: true,
             pool: 1500, bcrit: 120, mfu: 0.40, spec: true, alpha: 0.8, gamma: 4, giant: false, chunk: 64 },
      note: "Speculation on past the knee (same what-if B_crit of 120 as scenario 5): the spec-vs-no-spec readout settles around −10%, because the drafts' FLOPs are taken from the prefill sharing each step. Drop arrival rate to 2 and it swings to about +150%. Nothing special-cases this — the draft FLOPs simply come out of a budget that is already full." },
  ];

  function button(parent, label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    /* 33px tall in a wrapped row of nine was the densest control cluster on
       the site; the hover feedback was also JS-only, so keyboard users got
       none of it. Both now come from a class in inf.css. */
    b.className = "inf-btn";
    b.addEventListener("click", onClick);
    parent.appendChild(b);
    return b;
  }

  function mount(el, opts) {
    const cfg = {
      seed: 20260726, mode: "continuous", workload: opts.workload || "chat",
      arrival: 6, chunked: true, chunk: 512, prefixCache: true,
      bcrit: 295, mfu: MFU_DEFAULT, pool: 1250, spec: false, alpha: 0.8, gamma: 4,
      giant: false, speed: 1,
      /* A reader who asked the OS for no motion should not land on a
         continuously animating canvas and have to find the Pause button.
         Everything still works: Step and the scenario presets drive it. */
      playing: !(window.InfWidgets && InfWidgets.reducedMotion()),
    };
    const sim = new Sim(cfg);

    const headingTag = el.closest(".article-body")?.querySelector("h2") ? "h3" : "h2";
    el.innerHTML =
      '<div class="inf-widget-head"><' + headingTag + '>Serving-engine simulator</' + headingTag + '>' +
      '<p>Requests arrive, the scheduler batches them, the KV pool fills. Turn a knob; watch a chapter\'s claim happen.</p></div>';
    const body = document.createElement("div");
    body.className = "inf-widget-body";
    el.appendChild(body);

    /* --- try this --- */
    const tryWrap = document.createElement("div");
    tryWrap.className = "inf-toggles";
    tryWrap.style.marginTop = "0";
    body.appendChild(tryWrap);
    const caption = document.createElement("p");
    caption.className = "inf-verdict";
    caption.textContent = "Six one-click scenarios above. Each sets the scene; the caption names the knob to turn.";
    body.appendChild(caption);

    /* --- canvases --- */
    const stage = InfWidgets.canvas(body, 0.62,
      "Live view of the serving engine: the request queue, the current batch and the KV block pool. The seven meters below carry the same state as text.");
    const spark = InfWidgets.canvas(body, 0.14,
      "Sparklines of TTFT, worst inter-token latency and throughput over the last two minutes. The meters below carry the current values as text.");

    /* --- meters --- */
    const results = document.createElement("div");
    results.className = "inf-results";
    body.appendChild(results);
    const METERS = [
      ["TTFT p50", "queue + prefill"], ["TTFT p99", "the tail users feel"],
      ["ITL p50", "per-token gap"], ["ITL worst", "last 2 s"],
      ["tok/s/GPU", "output only"], ["queue", "waiting"], ["KV pool", "blocks in use"],
    ];
    const cells = METERS.map(function (m) {
      const d = document.createElement("div");
      d.innerHTML = '<span class="inf-result-label">' + m[0] + '</span>' +
        '<span class="inf-result-value">—</span><span class="inf-result-note">' + m[1] + '</span>';
      results.appendChild(d);
      return d.querySelector(".inf-result-value");
    });
    const verdict = document.createElement("p");
    verdict.className = "inf-verdict";
    body.appendChild(verdict);

    /* --- controls --- */
    const grid = document.createElement("div");
    grid.className = "inf-controls";
    grid.style.marginTop = "1.2rem";
    body.appendChild(grid);

    const wl = InfWidgets.select(grid, {
      label: "workload", value: cfg.workload,
      options: Object.keys(WORKLOADS).map(function (k) { return { value: k, label: WORKLOADS[k].label }; }),
    });
    const mode = InfWidgets.select(grid, {
      label: "batching", value: "continuous",
      options: [{ value: "continuous", label: "Continuous (Orca)" }, { value: "static", label: "Static (request-level)" }],
    });
    const sArr = InfWidgets.slider(grid, { label: "arrival rate", min: 1, max: 40, step: 1, value: cfg.arrival, format: function (v) { return v + " req/s"; } });
    const sChunk = InfWidgets.slider(grid, { label: "prefill chunk", min: 64, max: 2048, step: 64, value: cfg.chunk, format: function (v) { return v + " tok"; } });
    const sB = InfWidgets.slider(grid, { label: "B_crit (nameplate)", min: 24, max: 320, step: 8, value: cfg.bcrit, format: function (v) { return v + " tok/step"; } });
    /* The achieved fraction of peak FLOP/s. 40% is the case's planning
       figure; the old simulator silently ran at ~75%. With B_crit it
       sets the effective knee, which the verdict line reports. */
    const sMfu = InfWidgets.slider(grid, { label: "achieved MFU", min: 20, max: 80, step: 5, value: Math.round(cfg.mfu * 100), format: function (v) { return v + "%"; } });
    const sPool = InfWidgets.slider(grid, { label: "KV pool", min: 40, max: 1500, step: 10, value: cfg.pool, format: function (v) { return InfWidgets.fmt(v, 0) + " blocks · " + InfWidgets.fmt(v * BLOCK / 1000, 0) + "K tok"; } });
    const sAlpha = InfWidgets.slider(grid, { label: "acceptance α", min: 0.4, max: 0.95, step: 0.01, value: cfg.alpha, format: function (v) { return v.toFixed(2); } });
    const sGamma = InfWidgets.slider(grid, { label: "draft length γ", min: 1, max: 8, step: 1, value: cfg.gamma, format: function (v) { return String(v); } });
    const sSpeed = InfWidgets.slider(grid, { label: "speed", min: 0, max: 5, step: 1, value: 2, format: function (v) { return [0.1, 0.25, 1, 2, 4, 8][v] + "×"; } });

    const toggles = document.createElement("div");
    toggles.className = "inf-toggles";
    body.appendChild(toggles);
    const tChunk = InfWidgets.toggle(toggles, { label: "chunked prefill", value: true });
    const tCache = InfWidgets.toggle(toggles, { label: "prefix caching", value: true });
    const tSpec = InfWidgets.toggle(toggles, { label: "speculative decoding", value: false });
    const tGiant = InfWidgets.toggle(toggles, { label: "inject a 10K prompt every 3 s", value: false });

    const actions = document.createElement("div");
    actions.className = "inf-toggles";
    toggles.appendChild(actions);
    const bPlay = button(actions, cfg.playing ? "Pause" : "Play", function () {
      cfg.playing = !cfg.playing;
      bPlay.textContent = cfg.playing ? "Pause" : "Play";
    });
    button(actions, "Step", function () { cfg.playing = false; bPlay.textContent = "Play"; sim.arrivals(sim.t); sim.step(); draw(); });
    button(actions, "Reset", function () { sim.reset(); draw(); });

    function readControls() {
      cfg.workload = wl.value;
      cfg.mode = mode.value;
      cfg.arrival = Number(sArr.value);
      cfg.chunk = Number(sChunk.value);
      cfg.bcrit = Number(sB.value);
      cfg.mfu = Number(sMfu.value) / 100;
      cfg.alpha = Number(sAlpha.value);
      cfg.gamma = Number(sGamma.value);
      cfg.chunked = tChunk.checked;
      cfg.prefixCache = tCache.checked;
      cfg.spec = tSpec.checked;
      cfg.giant = tGiant.checked;
      cfg.speed = [0.1, 0.25, 1, 2, 4, 8][Number(sSpeed.value)];
      const p = Number(sPool.value);
      if (p !== sim.pool.length) sim.resizePool(p);
    }
    [wl, mode, sArr, sChunk, sB, sMfu, sPool, sAlpha, sGamma, sSpeed, tChunk, tCache, tSpec, tGiant]
      .forEach(function (c) { c.addEventListener("input", readControls); c.addEventListener("change", readControls); });

    PRESETS.forEach(function (p) {
      button(tryWrap, p.name, function () {
        Object.keys(p.cfg).forEach(function (k) { cfg[k] = p.cfg[k]; });
        wl.value = cfg.workload; mode.value = cfg.mode;
        sArr.value = cfg.arrival; sChunk.value = cfg.chunk; sB.value = cfg.bcrit;
        sMfu.value = Math.round((cfg.mfu || MFU_DEFAULT) * 100);
        sPool.value = cfg.pool; sAlpha.value = cfg.alpha; sGamma.value = cfg.gamma;
        tChunk.checked = cfg.chunked; tCache.checked = cfg.prefixCache;
        tSpec.checked = cfg.spec; tGiant.checked = cfg.giant;
        [sArr, sChunk, sB, sMfu, sPool, sAlpha, sGamma].forEach(function (s) {
          s.dispatchEvent(new Event("input", { bubbles: true }));
        });
        caption.textContent = p.note;
        /* A preset should configure the paused scene, not override the
           reader's OS-level reduced-motion preference. */
        cfg.playing = !(window.InfWidgets && InfWidgets.reducedMotion());
        bPlay.textContent = cfg.playing ? "Pause" : "Play";
        sim.reset();
        draw();
      });
    });

    /* ---------------- drawing ---------------- */

    /* Six sequence colours per theme. Four hues would be the
       diagram rule, but a block pool needs enough to tell adjacent
       owners apart. None of them is the accent (a prefilling slot) or
       the red (a giant prompt, a preemption), which carry meaning. */
    const SEQ = {
      dark:  ["#c4a7ff", "#5fc6c4", "#7ccf98", "#e5b562", "#f0a6c8", "#b8c4d6"],
      paper: ["#7438b0", "#0b6e75", "#1a7040", "#8d5400", "#a3346e", "#4f5d73"],
    };

    function draw() {
      const P = InfWidgets.palette();
      const seqCols = SEQ[InfWidgets.theme()] || SEQ.dark;
      const ctx = stage.ctx, w = stage.w, h = stage.h;
      const narrow = w < 460;
      ctx.fillStyle = P.panel; ctx.fillRect(0, 0, w, h);
      ctx.font = "500 12px " + P.sans;
      ctx.textBaseline = "alphabetic";

      const pad = narrow ? 8 : 14;
      const m = sim.meters();

      /* --- arrivals queue --- */
      let y = pad + 12;
      ctx.fillStyle = P.dim;
      ctx.fillText("Queue: " + m.queue + " waiting", pad, y);
      y += 6;
      const qh = narrow ? 12 : 16, qw = w - pad * 2;
      ctx.fillStyle = P.bg; ctx.fillRect(pad, y, qw, qh);
      const shown = Math.min(sim.queue.length, Math.floor(qw / 5));
      for (let i = 0; i < shown; i++) {
        const r = sim.queue[i];
        const bh = Math.min(qh, 3 + Math.log2(1 + r.prompt / 100) * 3);
        ctx.fillStyle = r.giant ? P.warn : P.accent;
        ctx.fillRect(pad + i * 5, y + qh - bh, 4, bh);
      }
      y += qh + 16;

      /* --- batch slots --- */
      ctx.fillStyle = P.dim;
      ctx.fillText("Batch: " + m.running + "/" + MAX_SLOTS + " slots, " +
        Math.round(m.tokens) + " tok/step vs knee ~" + Math.round(knee(cfg)) +
        (narrow ? "" : " (B_crit " + cfg.bcrit + " × " + Math.round(cfg.mfu * 100) + "% MFU)"), pad, y);
      y += 6;
      const cols = narrow ? 8 : 16, rows = Math.ceil(MAX_SLOTS / cols);
      const cw = (w - pad * 2) / cols, ch = narrow ? 9 : 13;
      for (let i = 0; i < MAX_SLOTS; i++) {
        const x = pad + (i % cols) * cw, yy = y + Math.floor(i / cols) * (ch + 2);
        ctx.fillStyle = P.bg; ctx.fillRect(x, yy, cw - 2, ch);
        const s = sim.running[i];
        if (!s) continue;
        const prog = s.state === "prefill" ? (s.filled / Math.max(1, s.need))
          : Math.min(1, s.produced / Math.max(1, s.req.out));
        ctx.fillStyle = s.state === "done" ? P.faint
          : s.state === "prefill" ? P.accent : seqCols[s.colour];
        ctx.fillRect(x, yy, Math.max(1, (cw - 2) * prog), ch);
        if (s.state === "prefill" && s.req.giant) { ctx.fillStyle = P.warn; ctx.fillRect(x, yy, cw - 2, 2); }
        if (s.restarts) { ctx.fillStyle = P.warn; ctx.fillRect(x, yy + ch - 2, cw - 2, 2); }
      }
      y += rows * (ch + 2) + 14;

      /* --- KV block pool --- */
      ctx.fillStyle = P.dim;
      ctx.fillText("KV block pool: " + Math.round(m.util * 100) + "% of " + sim.pool.length +
        " blocks, " + sim.cache.size + " cached prefixes, " + m.preempts + " preemptions", pad, y);
      y += 6;
      const ph = h - y - pad;
      const n = sim.pool.length;
      const pcols = Math.max(8, Math.round(Math.sqrt(n * (w - pad * 2) / Math.max(1, ph))));
      const cell = Math.max(1.5, Math.min((w - pad * 2) / pcols, ph / Math.ceil(n / pcols)));
      ctx.fillStyle = P.bg; ctx.fillRect(pad, y, w - pad * 2, ph);
      /* Group by colour so a 1,500-cell pool is a handful of fills,
         not six thousand. */
      const groups = new Map();
      for (let i = 0; i < n; i++) {
        const c = sim.pool[i];
        if (!c) continue;
        const key = c.flash > 0 ? (c.flash > 1 ? "F2" : "F1") : (c.shared ? "S" : "c" + c.c);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
        if (c.flash > 0) c.flash -= 0.08;
      }
      groups.forEach(function (idxs, key) {
        ctx.fillStyle = key === "F1" ? P.good : key === "F2" ? P.warn
          : key === "S" ? P.good : seqCols[Number(key.slice(1))];
        ctx.globalAlpha = key === "S" ? 0.55 : 1;
        ctx.beginPath();
        for (let k = 0; k < idxs.length; k++) {
          const i = idxs[k];
          ctx.rect(pad + (i % pcols) * cell, y + Math.floor(i / pcols) * cell,
            Math.max(1, cell - 0.6), Math.max(1, cell - 0.6));
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      });

      /* --- sparklines --- */
      const sw = spark.w, sh = spark.h;
      spark.canvas.parentNode.style.display = narrow ? "none" : "";
      if (!narrow) {
        const s = spark.ctx;
        s.fillStyle = P.panel; s.fillRect(0, 0, sw, sh);
        const series = [
          ["TTFT p50 (ms)", sim.spark.ttft, P.accent],
          ["ITL worst (ms)", sim.spark.itl, P.cool],
          ["tok/s/GPU", sim.spark.tps, P.good],
        ];
        const bw = (sw - 8) / 3;
        series.forEach(function (ser, i) {
          const x0 = 4 + i * bw;
          s.fillStyle = P.faint;
          s.font = "500 11px " + P.sans;
          s.fillText(ser[0], x0 + 2, 12);
          const d = ser[1];
          if (d.length < 2) return;
          let mx = 0;
          for (let k = 0; k < d.length; k++) if (d[k] > mx) mx = d[k];
          mx = mx || 1;
          s.strokeStyle = ser[2]; s.lineWidth = 1.25; s.beginPath();
          for (let k = 0; k < d.length; k++) {
            const px = x0 + 2 + (bw - 10) * (k / (d.length - 1));
            const py = sh - 5 - (sh - 22) * (d[k] / mx);
            k ? s.lineTo(px, py) : s.moveTo(px, py);
          }
          s.stroke();
        });
      }

      /* --- meters --- */
      const F = InfWidgets.fmt;
      cells[0].textContent = isFinite(m.ttft50) ? F(m.ttft50, 0) + " ms" : "—";
      cells[1].textContent = isFinite(m.ttft99) ? F(m.ttft99, 0) + " ms" : "—";
      cells[2].textContent = isFinite(m.itl) ? F(m.itl, 1) + " ms" : "—";
      cells[3].textContent = m.itlMax ? F(m.itlMax, 0) + " ms" : "—";
      cells[4].textContent = F(m.tps, 0);
      cells[5].textContent = String(m.queue);
      cells[6].textContent = Math.round(m.util * 100) + "%";
      cells[3].className = "inf-result-value" + (m.itlMax > 90 ? " bad" : "");
      cells[6].className = "inf-result-value" + (m.util > 0.95 ? " bad" : "");

      const k = knee(cfg);
      const memBound = m.tokens < k;
      verdict.innerHTML =
        "<strong>" + (memBound ? "Memory-bound" : "Compute-bound") + "</strong> — " +
        Math.round(m.tokens) + " tokens this step against an effective knee of ~" + Math.round(k) +
        " (nameplate B_crit " + cfg.bcrit + " at " + Math.round(cfg.mfu * 100) + "% MFU), so " +
        (memBound ? "another sequence rides along nearly free." : "every extra token now costs latency.") +
        " Step " + F(m.step, 1) + " ms. Speculation right now: <strong>" +
        (sim.specGain >= 0 ? "+" : "") + F(sim.specGain, 0) + "% tokens moved/s</strong>" +
        (cfg.spec ? " (on)" : " (off — this is the counterfactual)") +
        (m.recompute ? ". " + F(m.recompute / 1000, 1) + "K tokens recomputed after preemption." : "");
    }

    /* ---------------- loop & lifecycle ---------------- */

    let raf = 0, last = 0, sparkAcc = 0;

    function frame(ts) {
      /* The one rule that matters: a chapter swap must not leave a
         rAF loop running forever in every subsequent page. */
      if (!el.isConnected) { stop(); return; }
      raf = requestAnimationFrame(frame);
      const dtWall = Math.min(120, ts - (last || ts));
      last = ts;
      if (cfg.playing) {
        let budget = dtWall * cfg.speed;      /* model-ms to consume */
        let guard = 0;
        while (budget > 0 && guard++ < 400) {
          sim.arrivals(sim.t);
          const before = sim.t;
          sim.step();
          budget -= Math.max(0.05, sim.t - before);
        }
        sparkAcc += dtWall;
        if (sparkAcc > 120) {
          sparkAcc = 0;
          const m = sim.meters();
          const push = function (a, v) { a.push(isFinite(v) ? v : 0); if (a.length > 120) a.shift(); };
          push(sim.spark.ttft, m.ttft50); push(sim.spark.itl, m.itlMax); push(sim.spark.tps, m.tps);
        }
      }
      draw();
    }

    function onTheme() { if (!el.isConnected) { stop(); return; } draw(); }
    function onResize() { if (!el.isConnected) { stop(); return; } stage.size(); spark.size(); draw(); }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("inf-theme", onTheme);
      window.removeEventListener("resize", onResize);
    }

    window.addEventListener("inf-theme", onTheme);
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(frame);
  }

  if (typeof window !== "undefined" && window.InfWidgets) window.InfWidgets.define("engine-simulator", mount);

  /* Headless hook: lets the physics above be exercised from node
     while developing. In a browser `module` is undefined and this
     line does nothing. */
  if (typeof module === "object" && module.exports) {
    module.exports = {
      Sim: Sim, stepCost: stepCost, accepted: accepted, knee: knee, tokMs: tokMs,
      W_MS: W_MS, W_FLOOR_MS: W_FLOOR_MS, KV_MS_PER_TOK: KV_MS_PER_TOK, BLOCK: BLOCK,
      MFU_DEFAULT: MFU_DEFAULT, PRESETS: PRESETS,
    };
  }
})();
