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
    module: "Module 1 — Foundations",
    level: "beginner",
    levelLabel: "Beginner",
    blurb: "Start from zero: what happens when you call an LLM, where models come from and how to read one, what one pass computes, how a GPU works, and the arithmetic that rules the field — then measure it on your own machine.",
    chapters: [
      { slug: "what-is-inference", title: "What Actually Happens When You Call an LLM",
        desc: "Tokens, the autoregressive loop, prefill vs decode, TTFT and TPOT — and the case you will carry through the course." },
      { slug: "where-models-come-from", title: "Where a Model Comes From",
        desc: "How an LLM is made, in one sitting and without the math: data, the next-token objective, the checkpoint — and what is frozen by the time you serve it." },
      { slug: "reading-a-model-card", title: "Reading a Model Card",
        desc: "The model landscape, what the sizes mean, dense vs MoE, reasoning models — and every file in a model repository." },
      { slug: "inside-a-forward-pass", title: "Inside a Forward Pass",
        desc: "Embeddings, attention, the MLP: derive a model's size and its KV cache per token from config.json." },
      { slug: "gpu-mental-model", title: "The GPU Mental Model",
        desc: "SMs, HBM, tensor cores and the roofline: the two numbers that explain everything." },
      { slug: "inference-arithmetic", title: "Inference Arithmetic",
        desc: "Decode is bandwidth-bound, prefill is compute-bound: batching, critical batch size, metrics, cost." },
      { slug: "how-to-read-a-number", title: "How to Read a Number in This Field",
        desc: "Six questions that defuse almost every benchmark claim — now that you can derive why." },
      { slug: "lab-first-tokens", title: "Lab: Your First Tokens",
        desc: "Run a model on your laptop, measure TTFT and TPOT, and redo the roofline for a machine that is not an H100." },
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
      { slug: "lab-batching-and-cache", title: "Lab: Batching and the Prefix Cache",
        desc: "Parallel slots, continuous batching and a prefix cache you can watch hit and miss." },
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
        desc: "FP8, INT4, FP4 — the formats, the methods, and what each one buys." },
      { slug: "did-quantization-break-your-model", title: "Did Quantization Break Your Model?",
        desc: "Why perplexity lies, task-hardness scaling, token inflation — and what to measure instead." },
      { slug: "speculative-decoding", title: "Speculative Decoding",
        desc: "Draft models, EAGLE, MTP — provably lossless speedup, and when it backfires." },
      { slug: "lab-squeezing", title: "Lab: Bits, Bytes and Drafts",
        desc: "The same model at three precisions, a quantized KV cache, and speculative decoding with its acceptance counters." },
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
      { slug: "disaggregation", title: "Disaggregated Serving",
        desc: "Splitting prefill from decode: the transfer math, DistServe, and when it doesn't pay." },
      { slug: "the-kv-fabric", title: "The KV Fabric",
        desc: "Mooncake, Dynamo and NIXL, KV tiering, cache-aware routing and the autoscaling traps." },
      { slug: "agentic-serving", title: "The Agentic Era",
        desc: "Agent traffic, reasoning workloads and cache-hit economics." },
      { slug: "beyond-chat", title: "Beyond Chat",
        desc: "Vision and audio encoders, embeddings and rerankers, adapters, RL rollouts: what changes when the workload is not text in, text out." },
    ],
  },
  {
    module: "Module 6 — In Production",
    level: "intermediate",
    levelLabel: "Capstone",
    blurb: "Everything at once, on the running case: will it fit, what will it cost, what should you buy, and how do you run it at 3am.",
    chapters: [
      { slug: "sizing-a-deployment", title: "Sizing a Deployment",
        desc: "The five-term memory budget, inverted: will it fit, and how many users?" },
      { slug: "load-testing", title: "Load Testing: Producing a Number",
        desc: "Open and closed loops, coordinated omission, sweeps and warm-up: how to find the knee instead of estimating it." },
      { slug: "lab-load-test", title: "Lab: Find the Knee",
        desc: "Write a small open-loop load generator, sweep the arrival rate, and check Little's law against a real server." },
      { slug: "hardware-and-economics", title: "Hardware & Economics",
        desc: "GPUs, TPUs and SRAM silicon; what a token costs you, and what it costs the market." },
      { slug: "choosing-model-gpu-framework", title: "Choosing: Model, GPU, Framework",
        desc: "Deployment shape, GPUs in strict order, engine picks — and the real buy-vs-build math." },
      { slug: "operating-it", title: "Operating It",
        desc: "Metrics that are physical, symptoms to causes, autoscaling traps and cold starts." },
      { slug: "when-it-breaks", title: "When It Breaks",
        desc: "Xid errors, hangs, NaNs, OOMs and broken templates: failure modes, three incidents to diagnose, and the runbook." },
    ],
  },
  {
    module: "Epilogue",
    level: "intermediate",
    levelLabel: "Perspective",
    blurb: "A dated snapshot of what is moving, a method for deciding which of it should change your plans — and a final problem set over the whole course.",
    chapters: [
      { slug: "frontier", title: "The Frontier (late 2026)",
        desc: "Test-time compute, diffusion LLMs, and what might be next — read against the case." },
      { slug: "mixed-problems", title: "Mixed Problems, No Labels",
        desc: "Thirty problems from the whole course in shuffled order: the first step is working out which constraint binds." },
    ],
  },
  {
    module: "Reference",
    level: "beginner",
    levelLabel: "Reference",
    blurb: "Not chapters to read in order: the vocabulary of the field in one place, and a review deck that keeps the core calculations fresh.",
    chapters: [
      { slug: "glossary", title: "Glossary",
        desc: "Every acronym in the course, defined once and linked to where it's taught." },
      { slug: "review", title: "Review Deck",
        desc: "Fresh numbers on the course's core calculations, scheduled so that what you learned stays learned." },
    ],
  },
];

/* ---------------- course identity ---------------- */

const COURSE_META = {
  storeKey:  "inf-course-progress-v1",    /* localStorage: completion (do not rename) */
  scrollKey: "inf-scroll",                /* sessionStorage: scroll positions */
  searchKey: "inf-search-index-v1",       /* localStorage: cached search index */
  name:      "Inference Engineering",
  homeTitle: "Inference Engineering — A Guided Course",
  /* No hard <br>: course.css sets `text-wrap: balance` on .hero h1, which
     breaks the line where the width actually wants it. */
  heroTitle: "Inference Engineering, from first principles",
  heroLede:  `Every answer an LLM streams back is a fight against physics: a
              model too big for its GPU, generating one token at a time, for
              thousands of users at once. This course builds the whole
              discipline up carefully — from "what is a token" to the roofline
              arithmetic, the engines, the kernels, and the rack-scale systems
              behind ChatGPT, Claude and DeepSeek. Each chapter stands on the
              previous one; no GPU or ML background assumed.`,
  timeEstimate: "24–30 hours",
  servePath: "/inference/",
  footer:    "Inference Engineering — a guided course. Tip: use ← and → to move between chapters.",
};
