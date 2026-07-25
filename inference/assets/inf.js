/* ============================================================
   Inference Engineering — A Guided Course.

   Course data only: the module → chapter tree and the strings that
   make this course itself. The engine that renders it — router,
   quizzes, search, progress, scroll memory — is shared with the
   Distributed Systems course and lives in ../../assets/course.js,
   which the page loads immediately after this file.
   ============================================================ */

const COURSE = [
  {
    module: "Module 1 — The Physics",
    level: "beginner",
    levelLabel: "Beginner",
    blurb: "Start from zero: what happens when you call an LLM, how a GPU actually works, and the arithmetic that rules the whole field.",
    chapters: [
      { slug: "what-is-inference", title: "What Actually Happens When You Call an LLM",
        desc: "Tokens, the autoregressive loop, prefill vs decode — and why serving is a systems problem." },
      { slug: "gpu-mental-model", title: "The GPU Mental Model",
        desc: "SMs, HBM, tensor cores and the roofline: the two numbers that explain everything." },
      { slug: "inference-arithmetic", title: "Inference Arithmetic",
        desc: "KV-cache math, batching, critical batch size, TTFT/TPOT — and what a token really costs." },
    ],
  },
  {
    module: "Module 2 — The Engine",
    level: "beginner",
    levelLabel: "Beginner+",
    blurb: "How a serving engine turns that arithmetic into a machine: scheduling, memory management, and the full life of a request.",
    chapters: [
      { slug: "continuous-batching", title: "Continuous Batching & Scheduling",
        desc: "Iteration-level scheduling, chunked prefill, and the prefill/decode interference problem." },
      { slug: "paged-kv-cache", title: "PagedAttention & Prefix Caching",
        desc: "Virtual memory rediscovered on a GPU: block tables, copy-on-write, RadixAttention." },
      { slug: "anatomy-of-an-engine", title: "Anatomy of a Serving Engine",
        desc: "Inside vLLM and SGLang: schedulers, samplers, structured output, the engine landscape." },
    ],
  },
  {
    module: "Module 3 — Squeezing the Model",
    level: "intermediate",
    levelLabel: "Intermediate",
    blurb: "Make the model itself cheaper to run: smaller caches, smaller numbers, and tokens that arrive before they're computed.",
    chapters: [
      { slug: "attention-for-serving", title: "Attention Architectures for Serving",
        desc: "MHA to GQA to MLA, sliding windows, sparse attention and SSM hybrids." },
      { slug: "quantization", title: "Quantization",
        desc: "FP8, INT4, FP4 — the formats, the methods, and the evaluation traps." },
      { slug: "speculative-decoding", title: "Speculative Decoding",
        desc: "Draft models, EAGLE, MTP — provably lossless speedup, and when it backfires." },
    ],
  },
  {
    module: "Module 4 — Under the Hood",
    level: "advanced",
    levelLabel: "Advanced",
    blurb: "Down to the metal: the kernels that move the bytes, and the compilers and graphs that keep the GPU fed.",
    chapters: [
      { slug: "flashattention", title: "FlashAttention & Decode Kernels",
        desc: "Online softmax, tiling, FlashAttention 1→4, FlashDecoding and FlashInfer." },
      { slug: "kernels-and-compilation", title: "Kernels, Graphs & Compilation",
        desc: "CUDA graphs, torch.compile, Triton vs CUTLASS, MoE kernels, Blackwell." },
    ],
  },
  {
    module: "Module 5 — Serving at Scale",
    level: "advanced",
    levelLabel: "Advanced+",
    blurb: "Beyond one GPU: parallelism, rack-scale MoE, disaggregated fleets — and the agentic traffic that reshaped it all.",
    chapters: [
      { slug: "parallelism-for-inference", title: "Parallelism for Inference",
        desc: "TP, PP, EP and context parallelism — and why inference isn't training." },
      { slug: "moe-serving", title: "Serving MoE at Scale",
        desc: "DeepSeek's inference system, wide expert parallelism and rack-scale NVLink." },
      { slug: "disaggregation", title: "Disaggregated Serving & the KV Fabric",
        desc: "Prefill/decode split, Mooncake, Dynamo, KV tiering and cache-aware routing." },
      { slug: "agentic-serving", title: "The Agentic Era",
        desc: "Agent traffic, cache-hit economics, RL rollouts and multi-LoRA." },
    ],
  },
  {
    module: "Module 6 — The Big Picture",
    level: "intermediate",
    levelLabel: "Perspective",
    blurb: "Zoom out: the silicon, the money, the benchmarks that lie — and the frontier as of mid-2026.",
    chapters: [
      { slug: "hardware-and-economics", title: "Hardware & Economics",
        desc: "GPUs, TPUs and SRAM silicon; token prices, margins, benchmarks, energy." },
      { slug: "frontier", title: "The Frontier (mid-2026)",
        desc: "A dated snapshot: test-time compute, diffusion LLMs, and what might be next." },
    ],
  },
];

/* ---------------- course identity ---------------- */

const COURSE_META = {
  storeKey:  "inf-course-progress-v1",    /* localStorage: completion (do not rename) */
  scrollKey: "inf-scroll",                /* sessionStorage: scroll positions */
  name:      "Inference Engineering",
  homeTitle: "Inference Engineering — A Guided Course",
  heroTitle: "Inference Engineering,<br>from first principles",
  heroLede:  `Every answer an LLM streams back is a fight against physics: a
              model too big for its GPU, generating one token at a time, for
              thousands of users at once. This course builds the whole
              discipline up carefully — from "what is a token" to the roofline
              arithmetic, the engines, the kernels, and the rack-scale systems
              behind ChatGPT, Claude and DeepSeek. Each chapter stands on the
              previous one; no GPU or ML background assumed.`,
  timeEstimate: "7–8 hours",
  servePath: "/inference/",
  footer:    "Inference Engineering — a guided course. Tip: use ← and → to move between chapters.",
};
