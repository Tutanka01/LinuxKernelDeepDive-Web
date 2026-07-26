# Modular Handbook Comparison — Claude Opus 5 Analysis
# 2026-07-26
# Full analysis comparing Inference Engineering course vs Modular's LLM Inference Handbook

## VERDICT

Tu les écrases en profondeur, ils t'écrasent en praticité.

## SCOPE GAPS (what Modular has that we don't)

| Domain | Modular | Us |
|---|---|---|
| Déploiement (serverless vs self-hosted, BYOC, on-prem, sizing) | ~7 pages | RIEN |
| Choix pratiques (quel GPU, modèle, framework) | Pages dédiées | RIEN |
| Observabilité & opérations | Couvert | Une phrase |
| Outils interactifs (calculateurs) | Plusieurs widgets | ZÉRO |
| Inference routing, KV offloading, offline batch | Pages dédiées | RIEN |

## WHAT WE HAVE THAT MODULAR DOESN'T

- Roofline model (they stop before it)
- Attention architectures deep dive (MHA→MQA→GQA→MLA)
- Online softmax derived by hand
- Speculative decoding losslessness proof + batch-size inversion
- MoE serving at scale (EP32/EP144, DeepSeek case study)
- Calibrated epistemics ([consensus]/[directional])
- Voice & analogical bridging from systems knowledge
- Quiz-gated completion + retention architecture

## PRIORITY DIAGRAMS (7)

1. Roofline with ridge at 295, memory/compute-bound zones (ch2, reused in 3,8,10,11) — Precise SVG
2. Prefill vs decode on roofline + batch trail to B_crit (ch3) — Precise SVG
3. PagedAttention: fragmented slabs → block pool + block tables (ch5) — Excalidraw
4. MHA/MQA/GQA/MLA 4-panel wiring with bytes/token (ch7) — Excalidraw
5. Static vs continuous batching Gantt (ch4) — Excalidraw
6. Agent loop: cached prefix vs new delta over 30 iterations (ch15) — Excalidraw
7. Parallelism 4-panel: TP/PP/EP/CP cuts (ch12) — Excalidraw

Secondary diagrams needed for: ch1 (timeline), ch2 (memory hierarchy pyramids, chip→SM→warp), ch3 (KV growth curves, batching knee), ch6 (engine architecture, token budget), ch8 (FP8 vs INT8 spacing, block+scale, perplexity chart), ch9 (draft/verify timeline, speedup vs batch size), ch10 (naive vs tiled dataflow, online softmax accumulator, FlashDecoding split-KV), ch11 (CPU/GPU launch-gap trace, fusion, piecewise graph), ch12 (interconnect island map, all-reduce vs p2p), ch13 (all-to-all vs all-reduce, MoE layer, straggler barrier, DeepSeek topology), ch14 (system architecture, KV tiering pyramid, crossover chart), ch16 (Pareto curve, price S-curve, buyer checklist), ch17 (2×2 map, autoregressive vs diffusion)

## STRUCTURAL CHANGES

1. ADD attention primer (Q/K/V sketch) into ch3 before KV formula
2. SPLIT quantization → formats+mechanics + "did it break your model?"
3. SPLIT disaggregation → PD disaggregation + "the KV fabric"
4. ADD Module 3.5 "Running It" (3 chapters): Sizing, Choosing, Operating
5. ADD chapter 0: "How to read a number in this field" (6 rules)
6. ADD glossary + per-chapter FAQ + in-course search
7. ADD calculation exercises alongside MCQs
8. ADD recurring "serving stack map" with chapter-highlighted pieces
9. ADD cross-course bridge callouts ("You already know this →")
10. TRIM frontier chapter to ~2200 words

## INTERACTIVE TOOLS (client-side JS, no build)

1. KV cache + memory-fit calculator
2. Roofline explorer (interactive dot on the roofline)
3. Cost & cache-hit calculator
4. Speculative-decoding calculator
5. Parallelism planner
6. Quantization decision tool

## KILLER FEATURE

Live serving-engine simulator in the browser: requests arriving, batch slots filling/draining, KV block pool allocating/freeing, prefix cache hits lighting up, live TTFT/ITL/tokens-per-sec meters. Controls: static/continuous batching, chunk size, prefix caching on/off, B_crit, KV pool size, speculative decoding on/off with α slider, arrival rate. Pure client-side canvas + vanilla JS.

## LAB TRACK (5 labs)

a) Run vLLM, measure TTFT/TPOT, plot P50/P99 (ch3)
b) Drive concurrency 1→64, watch the knee (ch4)
c) Toggle prefix_caching on agent workload (ch5/15)
d) Serve FP8 vs BF16, measure speedup + accuracy delta (ch8)
e) Turn on spec-dec, find your own batch-size crossover (ch9)
