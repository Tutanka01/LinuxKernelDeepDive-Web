# Glossary

This page is a reference, not a chapter — there is no quiz and nothing here is
meant to be read in order. Each entry says what the term does to latency, memory
or cost, or how you would observe it, and links to the chapter that teaches it.
Come back to it when a word in the middle of a paragraph has stopped meaning
anything. To test yourself, use the button above the list: it hides every
definition, and each term then reveals its own.

<dl class="glossary">

<dt>acceptance rate (α)</dt>
<dd>In speculative decoding, the probability that the target keeps a drafted token at one position: α = Σ min(p, q), the overlap of the target's and the draft's distributions. A round of γ drafts yields 1 + α + … + α^γ tokens, never more than 1 ÷ (1 − α); measure it per position as <code>vllm:spec_decode_num_accepted_tokens_per_pos_total</code> ÷ <code>vllm:spec_decode_num_drafts_total</code>, not from the logged average. See <a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>active parameters</dt>
<dd>The parameters one token actually passes through: in a mixture-of-experts model, the shared layers plus the few experts the router chose. Arithmetic per token follows them (about 2 × active FLOPs); memory follows the total — gpt-oss-120b computes like a 5.1B model and stores 117B. See <a href="#/reading-a-model-card">Reading a Model Card</a> and <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>admission</dt>
<dd>The scheduler's decision to move a waiting request into the running set. In vLLM v0.34 a request is admitted only if its whole prompt fits in free KV blocks at that moment and fewer than <code>--max-num-seqs</code> requests run; nothing is reserved for its output, which is why preemption exists. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>all-reduce</dt>
<dd>A collective in which every rank contributes an array and every rank ends with the element-wise sum. Tensor parallelism needs two per layer — 160 per decode step for an 80-layer model — and each costs about α + 2(n − 1)/n × size ÷ per-GPU bandwidth: small decode messages pay the latency α, large prefill messages the bandwidth. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>all-to-all</dt>
<dd>A collective in which every rank sends a different slice to every other rank. Expert parallelism runs two per MoE layer (dispatch tokens to their experts, combine the results); across nodes they can take longer than the expert arithmetic they feed, which is why engines overlap them with compute. See <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>arithmetic intensity</dt>
<dd>FLOPs performed per byte moved to or from HBM. Multiplying a batch of M rows by a large BF16 weight matrix has an intensity of about M; below the chip's ridge point (~295 on an H100) the operation waits on memory and more bandwidth would speed it up, above it more FLOP/s would. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>async scheduling</dt>
<dd>vLLM v0.34's default: the engine process schedules step N+1 while the GPU runs step N, standing in placeholders for tokens step N has not sampled yet. It takes the scheduler's CPU time off the critical path of every step; SGLang's overlap scheduler does the same. See <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>attention sink</dt>
<dd>In models trained with full attention, heads park probability on the first tokens of the sequence. A post-hoc sliding window that evicts those tokens collapses the output (StreamingLLM), so such eviction keeps the first few; models trained with window layers, or with a learned sink term like gpt-oss, do not depend on it. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>AWQ</dt>
<dd>Activation-aware weight quantization: before rounding weights to 4 bits, it scales up the ~1% of channels that meet the largest activations and divides the matching activations by the same factor. A post-training W4A16 method; in the largest public sweep it cost 0.8 points of average accuracy on a 70B model and 2.1 on a 1.5B one. See <a href="#/quantization">Quantization</a>.</dd>

<dt>base model</dt>
<dd>The model pretraining produces: a text continuer with no notion of turns, whose only stop token is end-of-document. Served by mistake, it fails chat requests (its repository has no chat template) and runs completions to <code>max_tokens</code> with <code>finish_reason</code> <code>length</code>. See <a href="#/where-models-come-from">Where a Model Comes From</a>.</dd>

<dt>batch invariance</dt>
<dd>Output that does not depend on batch size or the order of requests in a batch. Ordinary serving lacks it, because batch shape changes the order of floating-point additions; vLLM v0.34's <code>VLLM_BATCH_INVARIANT=1</code> (beta) and SGLang's <code>--enable-deterministic-inference</code> buy it with throughput — for example by forcing one split in decode attention. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a> and <a href="#/flashattention">FlashAttention &amp; Decode Kernels</a>.</dd>

<dt>batch job (offline inference)</dt>
<dd>Work with no interactive promise, measured in tokens per GPU-hour and makespan; the batch grows until the KV pool stops it, about four times the tokens per second of an interactive operating point on the case's node. vLLM runs one from a JSONL file with <code>vllm run-batch</code>; providers sell the same slack at about half price. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>B_crit (critical batch size)</dt>
<dd>The decode batch at which arithmetic catches up with the weight read: nameplate peak FLOP/s ÷ peak bandwidth for two-byte weights, ~295 on an H100 in BF16 and ~153 on an A100, while achieved rates put the effective knee of the case's node near 160 tokens per step. Below it an extra sequence costs only its own KV reads, which never batch away. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>block (KV block) and block size</dt>
<dd>The fixed number of tokens whose keys and values, for every layer, the KV pool allocates and the prefix cache hashes as one unit — 64 tokens by default in vLLM v0.34 (16 before, and still on ROCm). Bytes per block = 2 × block size × KV heads × head_dim × bytes per element, per layer; only full blocks are cached, so an 800-token shared prompt shares 768 tokens. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>block table</dt>
<dd>The per-sequence map from logical KV block numbers to physical blocks in the pool — a page table by another name. It lets a sequence's cache be physically scattered; the attention kernel reads it to find key position t in block t ÷ 64. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a> and <a href="#/flashattention">FlashAttention &amp; Decode Kernels</a>.</dd>

<dt>bonus token</dt>
<dd>In speculative decoding, the extra token a round emits when every draft is accepted: the target's pass already computed the distribution after the last draft, so one more token is sampled from it for free. A round therefore emits between 1 and γ + 1 tokens. See <a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>break-even utilisation (u*)</dt>
<dd>The day-average utilisation at which a fixed-price GPU deployment costs the same per request as an API: u* = ($ per replica-second × work-seconds per request) ÷ API price per request, input tokens included. Ask Halden's is ~2.4% against 1.5% actual in phase 1 — the API would be cheaper, and only the data rule justifies the node. See <a href="#/choosing-model-gpu-framework">Choosing: Model, GPU, Framework</a> and <a href="#/hardware-and-economics">Hardware &amp; Economics</a>.</dd>

<dt>burn rate (error budget)</dt>
<dd>A promise such as "95% of first tokens within 1.5 s" leaves an error budget of 5% bad requests; the burn rate is the bad fraction divided by that budget (1 spends it exactly as it accrues, 6 means 30% of requests are bad). Page when it is high over a long and a short window at once, with a volume guard so a quiet night cannot page. See <a href="#/operating-it">Operating It</a>.</dd>

<dt>cached input (API pricing)</dt>
<dd>The price line for prompt tokens a provider serves from its prefix cache: 0.025× to 0.1× of fresh input in November 2026. Some providers also bill the write that puts a prefix in the cache (1.25× to 2.5× of input) and expire entries minutes after their last use, so an agent whose tool waits outlast the lifetime pays the write again. See <a href="#/agentic-serving">The Agentic Era</a> and <a href="#/hardware-and-economics">Hardware &amp; Economics</a>.</dd>

<dt>cache_salt</dt>
<dd>A per-request field that vLLM mixes into the hash of a prompt's first block, so requests with different salts never share prefix-cache blocks. It closes the timing side channel — a hit returns the first token measurably sooner — at the cost of one cached copy per salt. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>chat template</dt>
<dd>The Jinja template, shipped in <code>tokenizer_config.json</code> or a <code>chat_template.jinja</code> file, that turns a list of messages into the exact token sequence the model was trained on. Another template does not raise an error — answers get worse or do not stop — and whatever the template writes before your system prompt (Llama 3.3's <code>Today Date:</code> line) decides whether the prefix cache can hit. See <a href="#/reading-a-model-card">Reading a Model Card</a> and <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a>.</dd>

<dt>checkpoint (safetensors)</dt>
<dd>The model's files; a safetensors file is an 8-byte header length, a JSON header naming each tensor with its dtype, shape and byte offsets, then the raw numbers — no code, no training text. Its size is parameters × bytes per parameter (141.1 GB for Llama-3.3-70B in BF16), the first memory figure you check. See <a href="#/where-models-come-from">Where a Model Comes From</a>.</dd>

<dt>chunked prefill</dt>
<dd>Processing a long prompt in pieces over several steps, each piece sharing a step with every decoding sequence; on by default in vLLM v0.34, the chunk bounded by <code>--max-num-batched-tokens</code>. Above the effective knee it costs the long prompt almost nothing and caps the gap other users see: on the case's node a 512-token chunk with 20 decodes makes a ~50 ms step instead of one 270 ms freeze. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>closed loop / open loop (load generation)</dt>
<dd>A closed-loop generator runs N users who each wait for an answer before sending again, so its offered load falls exactly when the server slows: it cannot show overload and understates the tail. An open-loop generator sends on a clock, as independent users do — <code>vllm bench serve --request-rate</code> is open, and <code>--max-concurrency</code> adds a closed-loop cap. See <a href="#/load-testing">Load Testing: Producing a Number</a>.</dd>

<dt>cold start</dt>
<dd>The time from launching a replica to serving it: pulling and loading weights (usually the largest part), memory profiling, KV allocation, compilation and CUDA-graph capture. vLLM listens only when all of it is done, and the new replica's prefix cache is empty; read the <code>Loading weights took</code> and <code>init engine … took</code> log lines on every deploy. See <a href="#/operating-it">Operating It</a> and <a href="#/kernels-and-compilation">Kernels, Graphs &amp; Compilation</a>.</dd>

<dt>collective</dt>
<dd>A communication operation involving a whole group of ranks at once — all-reduce, all-gather, all-to-all, reduce-scatter. Collectives synchronise, so the slowest rank sets the pace: one thermally throttled GPU slows every all-reduce of its tensor-parallel group. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>context engineering</dt>
<dd>Building an agent's prompts so the server's prefix cache keeps hitting: a byte-stable head, tools in a fixed order, an append-only history, volatile content (timestamps, user data) last. A change that breaks it shows as a falling token hit rate and rising prefill load, with no error anywhere. See <a href="#/agentic-serving">The Agentic Era</a>.</dd>

<dt>context length</dt>
<dd>The longest sequence a model was trained or extended to handle (<code>max_position_embeddings</code> in its config): a ceiling, not an allowance. KV memory follows the tokens actually in context — one full 131,072-token Llama-3.3-70B request holds ~43 GB. vLLM's <code>--max-model-len</code> is an admission limit, not a reservation, and v0.34 refuses a value above the length it derives from the config unless <code>VLLM_ALLOW_LONG_MAX_MODEL_LEN=1</code> is set. See <a href="#/reading-a-model-card">Reading a Model Card</a> and <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>context parallelism (CP)</dt>
<dd>Splitting one sequence's tokens across GPUs. In prefill, ring attention passes KV blocks around the group while computing; in decode, vLLM's <code>--decode-context-parallel-size</code> shards each sequence's cache along its tokens, removing the replication tensor parallelism forces on MLA caches, at the cost of merging partial attention results every step. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>continuous batching</dt>
<dd>Scheduling at the granularity of one step instead of one request: finished sequences leave after every step and waiting ones join the next. The large matrix multiplies run over every token in the step while one attention kernel walks each sequence's own blocks; static batching, by contrast, idles about half its slots when output lengths vary. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>coordinated omission</dt>
<dd>A load-test error in which the generator waits for the server, so it sends fewer requests exactly while the server is slow and never records the latencies those requests would have had. In the course's toy server at the same offered rate, a closed loop reported a p99 of 0.70 s where an open loop measured 2.04 s. See <a href="#/load-testing">Load Testing: Producing a Number</a>.</dd>

<dt>cost per token</dt>
<dd>$ per 1M tokens = GPU $ per hour ÷ (tokens per second × 3,600 × occupancy) × 10⁶. The same node prices an output token from $39 per million at batch 1 to $0.33 near the knee at full occupancy; before comparing figures, ask which tokens are counted, at what per-user speed and at what occupancy. See <a href="#/inference-arithmetic">Inference Arithmetic</a> and <a href="#/hardware-and-economics">Hardware &amp; Economics</a>.</dd>

<dt>cross-encoder (reranker)</dt>
<dd>A model that reads a query and one document together and returns a relevance score. A request is a prefill with no decode, so its cost is candidates × pair length: Ask Halden's 50 pairs of ~750 tokens are 37,500 tokens per question, ~92 ms of one H100. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>CUDA graph</dt>
<dd>A recorded sequence of GPU kernel launches replayed with one launch, removing per-kernel CPU dispatch. A replay reuses the same kernels, grids and memory addresses, so inputs live in static buffers, batches are padded to captured sizes, and the graph pool comes out of the KV pool — the startup log reports its size after capture. See <a href="#/kernels-and-compilation">Kernels, Graphs &amp; Compilation</a>.</dd>

<dt>CUDA graph modes (vLLM)</dt>
<dd>vLLM v0.34's <code>cudagraph_mode</code>: <code>FULL_AND_PIECEWISE</code> (default — one full graph for decode-only steps, piecewise graphs with attention outside for steps that carry prefill), <code>FULL_DECODE_ONLY</code> (for decode instances of a prefill/decode split), <code>PIECEWISE</code>, <code>NONE</code>. <code>--enforce-eager</code> turns off graphs and compilation together. See <a href="#/kernels-and-compilation">Kernels, Graphs &amp; Compilation</a> and <a href="#/disaggregation">Disaggregated Serving</a>.</dd>

<dt>DCGM utilisation fields</dt>
<dd>NVIDIA's GPU telemetry, under dcgm-exporter 4.9.0's names: <code>DCGM_FI_DEV_GPU_UTIL_RATIO</code> is the fraction of time any kernel ran — ~1 under continuous batching, so never a load signal; <code>DCGM_FI_PROF_DRAM_UTIL_RATIO</code> shows the memory interface decode presses on; <code>DCGM_FI_PROF_TENSOR_UTIL_RATIO</code> shows the tensor pipes prefill uses. Dashboards older than 4.9.0 use <code>DCGM_FI_DEV_GPU_UTIL</code> (percent), <code>DCGM_FI_PROF_DRAM_ACTIVE</code> and <code>DCGM_FI_PROF_PIPE_TENSOR_ACTIVE</code>. See <a href="#/gpu-mental-model">The GPU Mental Model</a> and <a href="#/operating-it">Operating It</a>.</dd>

<dt>decode</dt>
<dd>The phase that produces output tokens, one per step per sequence, each step reading every weight once. Memory-bound: at batch 1 its time is bytes read ÷ bandwidth, ~14 ms for the case's model on four H100s, about 150 times the time of one prefill token. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>decode-time ladder</dt>
<dd>The case's decode step as named refinements: (1) physics floor, 35 GB per GPU ÷ 3.35 TB/s = 10.4 ms; (2) achievable bandwidth, ~85% → 12.3 ms; (3) planning figure at batch 1, plus all-reduces and launches, ~14 ms; (4) ~20 concurrent 3K-token sequences, plus their KV reads, ~16 ms. Name the rung you use, and replace rungs 3 and 4 with <code>vllm bench serve</code> at concurrency 1 and 20. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>deferred</dt>
<dd>In vLLM v0.34, a waiting request blocked by something other than capacity — no free LoRA slot, a KV transfer still in flight — counted in <code>vllm:num_requests_waiting_by_reason</code>{reason="deferred"}. In llama.cpp's server, <code>llamacpp:requests_deferred</code> is simply the queue of requests waiting for a free slot. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a> and <a href="#/lab-batching-and-cache">Lab: Batching and the Prefix Cache</a>.</dd>

<dt>disaggregation (prefill/decode)</dt>
<dd>Running prefill and decode on separate GPU pools, so prefill chunks never lengthen a decode step; each request's KV cache crosses a link between them, inside its TTFT (1.3 GB for a 4,000-token Llama-3.3-70B prompt: ~26 ms through one 50 GB/s NIC). It pays when a per-token gap target is broken by interference, not as a throughput gain; ratios are written 3P1D, 1P4D. See <a href="#/disaggregation">Disaggregated Serving</a>.</dd>

<dt>distillation</dt>
<dd>Training a smaller model to imitate a larger one by learning from its whole next-token distribution rather than only the text's next token (Llama 3.2 1B/3B used the 8B and 70B models' logits as targets). It is why parameter count ranks cost, not quality, across model generations. See <a href="#/where-models-come-from">Where a Model Comes From</a>.</dd>

<dt>DP-attention (data-parallel attention)</dt>
<dd>Running attention data-parallel — each GPU serves its own requests and keeps their whole KV cache — while the MoE layers stay expert-parallel. Needed for MLA models, whose single latent per token tensor parallelism would replicate on every rank; in vLLM <code>--data-parallel-size N --enable-expert-parallel</code>, in SGLang v0.5.23 <code>--attn-dp-size</code>. See <a href="#/attention-for-serving">Attention Architectures for Serving</a> and <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>DP (data parallelism)</dt>
<dd>Independent replicas of the whole model, each with its own batch, KV pool and prefix cache, behind a router. No communication inside a request; the costs are a full copy of the weights per replica and a cache that is cold for any request routed away from where its prefix lives. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>draft model (drafter)</dt>
<dd>Whatever proposes the tokens the target verifies in speculative decoding: a small model of the same family, an EAGLE-3 head on the target's hidden states (4.9 GB for Llama-3.3-70B), MTP heads, an n-gram lookup or a block-diffusion drafter. With draft cost c per target step the speedup at low batch is about E ÷ (1 + c·γ), so a cheap, slightly worse draft usually wins. See <a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>drain</dt>
<dd>Taking a replica out of the router and letting its running requests finish before stopping it. The deadline is set by <code>max_tokens</code> × TPOT — a 2,048-token answer at 60 ms takes ~123 s — so a 30-second termination grace period cuts answers mid-stream. See <a href="#/operating-it">Operating It</a>.</dd>

<dt>DSA (trained sparse attention)</dt>
<dd>DeepSeek Sparse Attention: a cheap indexer scores every earlier token and attention reads only the top 2,048 (<code>index_topk</code>). It stores slightly more per token than plain MLA (an extra indexer key, 132 bytes per layer in vLLM v0.34's layout) and reads far less at long context — a bandwidth design, not a capacity one. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>dtype</dt>
<dd>The number format of a tensor's elements — BF16, FP16, FP8, INT8, FP4. It sets the bytes every decode step reads (FP8 weights halve the weight-read time) and the bytes each cached token holds; arithmetic gets faster only on chips whose tensor cores run that format natively. See <a href="#/quantization">Quantization</a>.</dd>

<dt>ECC errors and row remapping</dt>
<dd>HBM reports correctable and uncorrectable memory errors; uncorrectable ones surface as Xid events and end the CUDA context. A degrading GPU swaps failing rows for spares, effective only after a reset — <code>nvidia-smi -q</code> shows <code>Remapped Rows … Pending : Yes</code> — so the action is a scheduled reset with the replica drained, off-peak. See <a href="#/when-it-breaks">When It Breaks</a>.</dd>

<dt>embedding model</dt>
<dd>A model that maps a text to one vector placed so that similar meanings land close together. A request is one forward pass with no decode, past the knee from the first document, so throughput is FLOP/s ÷ FLOPs per token; for small models the token-embedding table is a large share of the parameters and does no arithmetic. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>encoder cache</dt>
<dd>vLLM's store of vision or audio encoder outputs in GPU memory, keyed by a hash of the media bytes (or a client-supplied <code>uuid</code>), so an image is encoded once even when its prefill is chunked. The same photo re-encoded by the client is new bytes and a miss; hits show in <code>vllm:mm_cache_queries</code> and <code>vllm:mm_cache_hits</code>. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>E/P/D (encode/prefill/decode) disaggregation</dt>
<dd>For multimodal models, a third stage split out: vision or audio encoders run on their own workers and hand their outputs over through encoder-cache connectors (vLLM v0.28 onward), so encoders scale on their own and text-only requests bypass them. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>EP (expert parallelism)</dt>
<dd>Placing whole experts of an MoE model on different GPUs and moving each token to the GPUs holding its chosen experts. Each GPU then sees the pooled batch for its experts — at decode a single replica gives each expert only B·k/N rows — at the price of two all-to-alls per MoE layer. See <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>EPLB (expert-parallel load balancing)</dt>
<dd>Measuring per-expert load and re-placing experts, with redundant copies of the hottest ones. The combine step waits for the busiest rank, so a <code>balancedness</code> (mean ÷ max load per rank) of 0.625 stretches every expert phase 1.6×; in vLLM <code>--enable-eplb</code> with <code>num_redundant_experts</code>. See <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>extensible KV cache</dt>
<dd>vLLM v0.34's default on CUDA and ROCm: it reserves the KV cache's address range with the driver's virtual-memory API and commits physical memory after warm-up and graph capture, sizing the pool from memory actually free. With it, an unset <code>--gpu-memory-utilization</code> means 1.0 (0.92 without); the release notes report a 6–18% TPOT cost on some models, which an explicit value opts out of. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a> and <a href="#/sizing-a-deployment">Sizing a Deployment</a>.</dd>

<dt>FFN (feed-forward network)</dt>
<dd>The per-token block that follows attention in each transformer layer; a synonym for MLP here. It holds about 80% of a dense model's weights (704.6M of 855.6M per Llama-3.3-70B layer) and contributes nothing to the KV cache. See <a href="#/inside-a-forward-pass">Inside a Forward Pass</a>.</dd>

<dt>finished_reason</dt>
<dd>Why a request ended, as a label of <code>vllm:request_success_total</code>: <code>stop</code>, <code>length</code>, <code>abort</code>, <code>error</code>, <code>repetition</code>. A rising <code>length</code> share means answers hitting <code>max_tokens</code> — a wrong stop token or template, lost sampling defaults, or a quantized model thinking longer — while every latency panel stays green. See <a href="#/when-it-breaks">When It Breaks</a> and <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>FlashAttention</dt>
<dd>Exact attention computed tile by tile in on-chip shared memory with online softmax, so the N × N score matrix (~2 GB per head per layer at 32K tokens) is never written to HBM. It removes attention's working memory traffic; it does not shrink the KV cache. vLLM v0.34 runs FlashAttention 3 on Hopper. See <a href="#/flashattention">FlashAttention &amp; Decode Kernels</a>.</dd>

<dt>FlashDecoding (split-KV)</dt>
<dd>Decode attention has one query row per sequence, so at small batch a kernel leaves most SMs idle; FlashDecoding splits each sequence's keys into chunks on separate SMs and merges the partial results with the online-softmax rule. vLLM caps the split count at 32 under full CUDA graphs; batch invariance forces 1. See <a href="#/flashattention">FlashAttention &amp; Decode Kernels</a>.</dd>

<dt>flip</dt>
<dd>A question whose answer changes between two model variants — right to wrong or wrong to right. Equal accuracy can hide many flips, so variants are compared answer by answer, and a candidate's flip count means something only above the flip floor. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>flip floor</dt>
<dd>The flips between two runs of the unquantized model on the same questions under production-like concurrency, caused by batch-dependent floating-point addition order. Ask Halden's gate allows a quantized model at most twice this floor. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>flow control (gateway)</dt>
<dd>Holding requests at the gateway when the pool is saturated instead of committing them to a replica: llm-d v1.0's endpoint picker queues by priority band, then by tenant, then by an ordering policy, and answers sheddable bands with HTTP 429. A request held there costs nothing and can still go anywhere. See <a href="#/the-kv-fabric">The KV Fabric</a>.</dd>

<dt>FLy</dt>
<dd>An opt-in verifier in vLLM v0.33+ (<code>"rejection_sample_method": "fly"</code>) that sometimes keeps drafts the exact rule would reject, for 1.04–1.31× decode throughput in its authors' tests. It is "intentionally lossy": the output no longer follows the target's distribution, so it goes through the same evaluation gate as quantization. See <a href="#/speculative-decoding">Speculative Decoding</a> and <a href="#/frontier">The Frontier (late 2026)</a>.</dd>

<dt>FP8</dt>
<dd>An 8-bit float, usually E4M3 (4 exponent bits, 3 mantissa bits, range ±448), always paired with a scale per tensor, channel, token or block. It halves the bytes of weights or KV; FP8 arithmetic is native on Ada, Hopper and Blackwell (compute capability 8.9 and up), and an A100 runs FP8 checkpoints by dequantizing them, keeping the bandwidth saving but not the compute speedup. See <a href="#/quantization">Quantization</a>.</dd>

<dt>GEMM</dt>
<dd>General matrix–matrix multiply, the operation almost all of a transformer's FLOPs reduce to. In decode a GEMM of B rows against a weight matrix has an intensity of about B, which is why small decode batches leave tensor cores idle. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>generation config</dt>
<dd><code>generation_config.json</code>: the model's default sampling settings and stop tokens (Llama 3.3: temperature 0.6, top-p 0.9). vLLM v0.34 applies them to every request that sets none and logs a warning listing them; <code>--generation-config vllm</code> drops them, which changes answers with no error — send sampling fields from the application. See <a href="#/reading-a-model-card">Reading a Model Card</a> and <a href="#/when-it-breaks">When It Breaks</a>.</dd>

<dt>GGUF</dt>
<dd>llama.cpp's single-file format: weights, tokenizer and chat template together. Its quantization names are recipes — <code>Q8_0</code> stores 32 signed bytes plus an FP16 scale (8.5 bits per weight), <code>Q4_K_M</code> mostly 4.5-bit <code>Q4_K</code> with some tensors promoted to <code>Q6_K</code> (about 4.9–5 bits overall) — and decode speed is roughly bandwidth ÷ file size. See <a href="#/quantization">Quantization</a> and <a href="#/lab-squeezing">Lab: Bits, Bytes and Drafts</a>.</dd>

<dt>goodput</dt>
<dd>Requests per second that met every promise — TTFT and TPOT together — as opposed to all completed requests. <code>vllm bench serve --goodput ttft:1400 tpot:60</code> counts it; in a sweep, the knee is the highest rate at which goodput still keeps up with throughput. See <a href="#/inference-arithmetic">Inference Arithmetic</a> and <a href="#/load-testing">Load Testing: Producing a Number</a>.</dd>

<dt>GPTQ</dt>
<dd>A post-training method that rounds weights one at a time and adjusts the not-yet-rounded weights in the same layer to cancel the error, using second-order information. Accurate at 4 bits, but more sensitive to its calibration set than AWQ (~10 points on one 1.5B model when the set changed). See <a href="#/quantization">Quantization</a>.</dd>

<dt>--gpu-memory-utilization</dt>
<dd>The fraction of each GPU's total memory vLLM may use: KV pool = fraction × total − weights − activation peak − non-torch memory − CUDA-graph memory. It is not applied to what is left after the weights; the case's 0.90 on an 80 GB H100 gives 72 − 35 − 4 = 33 GB of pool per GPU and leaves 8 GB of headroom. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a> and <a href="#/sizing-a-deployment">Sizing a Deployment</a>.</dd>

<dt>GQA (grouped-query attention)</dt>
<dd>Attention in which groups of query heads share one key/value head, dividing the KV cache by the group size: Llama-3.3-70B's 64 query heads share 8 KV heads, 328 KB per token instead of 2.6 MB. It does not reduce attention's arithmetic, and tensor parallelism beyond the KV-head count replicates heads. See <a href="#/attention-for-serving">Attention Architectures for Serving</a> and <a href="#/inside-a-forward-pass">Inside a Forward Pass</a>.</dd>

<dt>grouped GEMM</dt>
<dd>One kernel launch that runs many small matrix multiplies sharing a weight shape — an MoE layer's experts after the step's tokens are sorted by expert. At decode each expert sees only a few rows, so these are bandwidth-bound matrix-vector products. See <a href="#/kernels-and-compilation">Kernels, Graphs &amp; Compilation</a> and <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>HBM</dt>
<dd>High-bandwidth memory, the GPU's main memory: 80 GB at 3.35 TB/s on an H100 SXM, 141 GB at 4.8 TB/s on an H200. Capacity decides what fits — weights plus a useful KV pool; bandwidth decides how fast decode can read it. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>hit rate (prefix cache): per token vs per request</dt>
<dd>vLLM counts prefix-cache hits in tokens: rate = Δ<code>vllm:prefix_cache_hits_total</code> ÷ Δ<code>vllm:prefix_cache_queries_total</code>, the share of prompt tokens not recomputed. A per-request rate (requests with any hit) can read 99% while the token rate is 26%; only the token rate predicts TTFT and prefill load. See <a href="#/how-to-read-a-number">How to Read a Number in This Field</a> and <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>host KV tier (KV offloading)</dt>
<dd>A copy of KV blocks in CPU memory: in vLLM v0.34 <code>--kv-offloading-size</code> (GiB, summed over tensor-parallel ranks) and <code>--kv-offloading-backend native</code>. Blocks are copied as they complete, so the tier adds hits only if it is larger than the GPU pool; it pays when kv bytes per token ÷ link bandwidth is below the time to recompute a token (~0.9 GB/s per GPU for a 70B). See <a href="#/the-kv-fabric">The KV Fabric</a>.</dd>

<dt>hung replica</dt>
<dd>A tensor-parallel replica stuck in a collective — one rank dead or wedged — that still answers <code>/health</code> with 200, because vLLM v0.34 reports 503 only after the engine is marked dead (up to the 300 s execute-model timeout). Detect it by progress: requests running while <code>rate(vllm:generation_tokens_total)</code> is zero. See <a href="#/when-it-breaks">When It Breaks</a>.</dd>

<dt>hybrid step</dt>
<dd>An engine step that carries a prefill chunk plus one token for every decoding sequence. It is one set of matrix multiplies, priced max(t_w, t_c) + t_kv rather than prefill time plus decode time: a 512-token chunk with 20 decodes is ~50 ms on the case's node, and every stream waits that long for its token. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a> and <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>InferencePool and Endpoint Picker (EPP)</dt>
<dd>The Kubernetes Gateway API Inference Extension's objects: an InferencePool is the model-server pods of one model; the EPP, consulted by the gateway's Envoy proxy for every request, scores pods on queue, KV usage and prefix affinity and returns one. Since GAIE v1.6.0 the full EPP lives in llm-d. See <a href="#/the-kv-fabric">The KV Fabric</a>.</dd>

<dt>InfiniBand / RoCE (node-to-node network)</dt>
<dd>The fabric between nodes: a 400 Gb/s NDR port carries ~50 GB/s each way, and a DGX H100 has one such NIC per GPU — about 9× less per GPU per direction than NVLink 4's ~450 GB/s, with several times the latency. Tensor parallelism stays inside an NVLink domain; pipeline stages and KV transfers can cross this network. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>instruction tuning (SFT)</dt>
<dd>Training a base model on example conversations written in one fixed chat template, so it learns whose turn it is and to end its answer with an end-of-turn token (Llama 3's <code>&lt;|eot_id|&gt;</code>). The architecture does not change; the stop tokens and the template do. See <a href="#/where-models-come-from">Where a Model Comes From</a>.</dd>

<dt>ITL (inter-token latency)</dt>
<dd>Each individual gap between two output tokens of a stream (<code>vllm:inter_token_latency_seconds</code>). TPOT averages the gaps; ITL shows the hybrid steps — a median of ~15 ms with a p95 of ~47 ms is decode steps plus 512-token prefill chunks, and the p95 moves with the token budget. See <a href="#/inference-arithmetic">Inference Arithmetic</a> and <a href="#/load-testing">Load Testing: Producing a Number</a>.</dd>

<dt>knee (effective)</dt>
<dd>The number of tokens one step can carry before arithmetic, rather than the weight read, sets its time: t_w ÷ t_c, ~160 tokens on the case's node (14 ms ÷ 0.089 ms) against a nameplate 295. Speculative verification, prefill chunks and large decode batches all count against it; on a laptop it is prompt tokens/s ÷ decode tokens/s. See <a href="#/inference-arithmetic">Inference Arithmetic</a> and <a href="#/lab-first-tokens">Lab: Your First Tokens</a>.</dd>

<dt>knee (load test)</dt>
<dd>The highest offered request rate at which goodput still keeps up with throughput — nearly every request meets its promises. It is the capacity you write down, not the throughput plateau beyond it; GuideLLM's "knee" profile fits a different, closed-loop throughput knee. See <a href="#/load-testing">Load Testing: Producing a Number</a> and <a href="#/lab-load-test">Lab: Find the Knee</a>.</dd>

<dt>KV cache</dt>
<dd>The keys and values every layer stores for every token processed, so later tokens attend to them without recomputing. Its size is 2 × layers × KV heads × head_dim × bytes per token (328 KB for Llama-3.3-70B in BF16, 1.07 GB for a 3,250-token request), it is read in full at every decode step, and it usually — not the weights — caps how many requests run at once. See <a href="#/inside-a-forward-pass">Inside a Forward Pass</a> and <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>--kv-cache-dtype</dt>
<dd>The KV cache's precision, chosen at serving time independently of the weights' format: <code>fp8</code> (<code>fp8_e4m3</code>) halves bytes per token and every step's KV reads. Without calibrated scales vLLM uses 1.0, and some models default to a quantized cache, so read the startup log; FP8 KV needs its own evaluation at the deployed context length. See <a href="#/quantization">Quantization</a> and <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>KV connector (NIXL)</dt>
<dd>vLLM's interface for moving KV blocks between instances. <code>NixlConnector</code>, on NVIDIA's NIXL transfer library over UCX (RDMA between hosts, NVLink inside one), carries prefill/decode splits: by default the decoder pulls the blocks, which the prefiller holds under a 30 s lease; the log line <code>KV Transfer metrics</code> reports transfer times and expired leases. See <a href="#/disaggregation">Disaggregated Serving</a>.</dd>

<dt>KV events</dt>
<dd>Notifications vLLM publishes over ZeroMQ (<code>--kv-events-config</code>) whenever a block is stored or removed, so an indexer can know exactly which prefixes each replica holds — the basis of llm-d's precise prefix routing and Dynamo's router. Exact but not instantaneous: an identical request arriving before the first one's events sees nothing. See <a href="#/the-kv-fabric">The KV Fabric</a>.</dd>

<dt>KV pool</dt>
<dd>The GPU memory left for KV blocks after weights, activations and graph memory within the memory budget, printed per GPU in GiB at startup. Capacity in requests = (pool − shared prefixes stored once) ÷ (KV bytes per token × unique live context per request) — 132 GB on the case's BF16 node, 66 GB per FP8 TP=2 replica. See <a href="#/sizing-a-deployment">Sizing a Deployment</a> and <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>launch overhead</dt>
<dd>The CPU and driver time to launch one GPU kernel, paid whatever the kernel does. A step becomes launch-bound when the average kernel is shorter than the per-launch cost and no long kernel lets the CPU run ahead — rare for a 70B on four GPUs, common for a 1B model at batch 1; CUDA graphs and fusion are the remedies. See <a href="#/kernels-and-compilation">Kernels, Graphs &amp; Compilation</a>.</dd>

<dt>Little's law</dt>
<dd>In any stable system, the average number inside equals arrival rate × average time inside: for an LLM server, requests in flight = request rate × (TTFT + output tokens × TPOT). It gives a mean, queue included — under Poisson arrivals the p95 is about L + 1.65√L — and it checks any benchmark report against its own throughput and latency. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a> and <a href="#/load-testing">Load Testing: Producing a Number</a>.</dd>

<dt>logits</dt>
<dd>The raw score the model assigns to every vocabulary entry for the next token — 128,256 numbers per sequence per step for Llama 3 — before softmax turns them into probabilities. Sampling works on them every step; top-p must find the most probable tokens covering probability p — a sort or its equivalent — which is why greedy decoding, one argmax, is cheaper. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>LoRA adapter</dt>
<dd>Low-rank adaptation: two thin matrices per adapted weight (the layer computes Wx + B(Ax)), a small file next to frozen base weights — 414 MB at rank 16 on all of Llama-3.3-70B's matrices. vLLM reserves <code>--max-loras</code> slots at <code>--max-lora-rank</code> at startup, out of the KV pool, and puts the adapter into every block hash, so the same prompt under two adapters is cached twice. See <a href="#/beyond-chat">Beyond Chat</a> and <a href="#/where-models-come-from">Where a Model Comes From</a>.</dd>

<dt>--max-num-seqs</dt>
<dd>vLLM's cap on requests running at once (1,024 by default on an H100 in v0.34). It reserves no KV memory, but it sizes per-request buffers and the CUDA-graph batch sizes captured at startup; when it binds, requests wait with idle KV memory and the running gauge sits flat at the cap. See <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>max_tokens</dt>
<dd>The request's cap on generated tokens, reasoning tokens included. A request that reaches it ends with <code>finish_reason</code> <code>length</code>; across a fleet it also bounds how long a replica takes to drain. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/operating-it">Operating It</a>.</dd>

<dt>MBU (model bandwidth utilisation)</dt>
<dd>Achieved bytes per second ÷ peak memory bandwidth — the meter for decode. The case plans on ~74% at batch 1 (14 ms against a 10.4 ms floor); Databricks published 50–60% for whole engines, and streaming kernels reach 85–90%. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>McNemar's test</dt>
<dd>A paired test that uses only the discordant questions: b that went right→wrong and c that went wrong→right, asking how unlikely so lopsided a split is if each were a coin flip. The paired difference's standard error is about √(b + c) ÷ n, so 1,500 questions at a 5% flip rate resolve ~1.6 points. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>megakernel</dt>
<dd>A whole forward pass fused into one persistent GPU kernel, removing the gaps between kernels that even replayed graphs leave. It pays where steps are shortest — small models at batch 1 (Hazy Research reported ~2.5× over vLLM on Llama-3.2-1B) — and ships as opt-in, per-model plugins in SGLang v0.5.23. See <a href="#/kernels-and-compilation">Kernels, Graphs &amp; Compilation</a> and <a href="#/frontier">The Frontier (late 2026)</a>.</dd>

<dt>MFU (model FLOPs utilisation)</dt>
<dd>Achieved FLOP/s ÷ peak FLOP/s — the meter for prefill, where the course plans 40% and 35–55% is typical. MFU ÷ MBU = intensity ÷ ridge, so a decode MFU of a few percent describes a healthy memory-bound step, not a broken GPU. See <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>MHA (multi-head attention)</dt>
<dd>The original attention design, one key/value head per query head: 2.6 MB per token for a 70B-class shape in BF16, eight times GQA-8. Decode attention under MHA does about 1 FLOP per byte read. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>MLA (multi-head latent attention)</dt>
<dd>DeepSeek's design: one compressed latent (512 values) plus a 64-value positional key cached per token per layer — ~70 KB per token for DeepSeek-V3 in BF16. Under tensor parallelism the latent cannot be split by heads, so every rank stores all of it; data-parallel attention or decode context parallelism recovers the saving. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>MLP</dt>
<dd>The dense feed-forward block inside each transformer layer (gate, up and down projections in Llama); used interchangeably with FFN. It holds most of a dense model's weights and FLOPs and nothing of its KV cache. See <a href="#/inside-a-forward-pass">Inside a Forward Pass</a>.</dd>

<dt>MoE (mixture of experts)</dt>
<dd>An architecture in which a router sends each token to a few of many expert MLPs, so active parameters are far fewer than total ones. Memory follows the total and arithmetic the active; a decode step touches about 1 − (1 − k/N)^B of the experts, so at realistic batches it reads most of the model. See <a href="#/moe-serving">Serving MoE at Scale</a> and <a href="#/reading-a-model-card">Reading a Model Card</a>.</dd>

<dt>MQA (multi-query attention)</dt>
<dd>Attention with a single key/value head shared by every query head — the smallest dense KV cache (41 KB per token for a 70B-class shape), at a quality cost GQA was designed to recover. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>MTP (multi-token prediction)</dt>
<dd>Extra heads trained with the base model to predict tokens beyond the next one, usable as a built-in drafter: DeepSeek-V3 reports 85–90% acceptance of the second token and 1.8× the tokens per second. See <a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>MXFP4</dt>
<dd>The OCP microscaling 4-bit format: an E2M1 element with one power-of-two (E8M0) scale per 32 elements, 4.25 bits per weight. gpt-oss stores its experts this way (65.25 GB for 117B parameters); on an H100, which has no FP4 tensor cores, it saves memory and bandwidth but not compute. See <a href="#/quantization">Quantization</a>.</dd>

<dt>NCCL</dt>
<dd>NVIDIA's collective communications library, topology-aware across NVLink and InfiniBand. vLLM tries FlashInfer's and its own custom all-reduce first and falls back to NCCL for large messages; a log line reading "via NET/Socket" instead of "via NET/IB/GDRDMA" means traffic is on a slow path. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>needle-in-a-haystack</dt>
<dd>A long-context test: one fact hidden in a long document, then asked for. It caught a Hopper FP8-KV kernel failure invisible at short lengths (91.2% → 13.0% at 128K on Llama-3.1-8B), so it is run at the deployed context length on the deployed attention backend. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>n-gram drafter</dt>
<dd>A drafter with no model: it finds the last few tokens earlier in the text and proposes what followed them there. It costs almost nothing and pays when output copies input — quoted documents, code edits, agent loops; in llama.cpp <code>--spec-type ngram-simple</code>. See <a href="#/speculative-decoding">Speculative Decoding</a> and <a href="#/lab-squeezing">Lab: Bits, Bytes and Drafts</a>.</dd>

<dt>NVFP4</dt>
<dd>NVIDIA's Blackwell-native 4-bit format: an E2M1 element with an FP8 (E4M3) scale per 16 elements plus one FP32 factor per tensor, 4.5 bits per weight. Finer scaling than MXFP4 at more metadata; FP4 arithmetic needs Blackwell or later. See <a href="#/quantization">Quantization</a>.</dd>

<dt>NVLink</dt>
<dd>NVIDIA's GPU-to-GPU link inside a node or rack. An H100's quoted 900 GB/s counts both directions — ~450 GB/s each way, about 9× a 400 Gb/s NIC per GPU — and an NVLink domain is the natural boundary for tensor parallelism; <code>NV18</code> in <code>nvidia-smi topo -m</code> marks a full-speed pair. See <a href="#/parallelism-for-inference">Parallelism for Inference</a> and <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>occupancy</dt>
<dd>In Inference Arithmetic's cost formula, the fraction of paid hours the GPU spends working at the operating point being priced — the same idea Hardware & Economics calls day-average utilisation. Not MFU or MBU, which describe how well busy time is used. See <a href="#/inference-arithmetic">Inference Arithmetic</a> and <a href="#/hardware-and-economics">Hardware &amp; Economics</a>.</dd>

<dt>Offline and Server (MLPerf scenarios)</dt>
<dd>MLPerf Inference's Offline scenario sends every sample at once and measures throughput with no latency bound; Server sends Poisson arrivals and must hold a p99 latency bound. "Up to" headline figures are usually Offline — a ceiling, where Server is a knee. See <a href="#/how-to-read-a-number">How to Read a Number in This Field</a> and <a href="#/load-testing">Load Testing: Producing a Number</a>.</dd>

<dt>online softmax</dt>
<dd>Computing softmax tile by tile while keeping a running maximum m, a running sum ℓ and an unnormalised output o, and rescaling ℓ and o by exp(m_old − m_new) whenever the maximum moves. It is what lets FlashAttention avoid the score matrix, and the same rule merges split-KV partial results. See <a href="#/flashattention">FlashAttention &amp; Decode Kernels</a>.</dd>

<dt>open-weights model</dt>
<dd>A model whose files you can download and run on your own hardware within its licence, as opposed to an API-only model that runs only on its vendor's servers. Open weights is not open source: you get numbers and configuration, rarely the training data or code — and the licence, read in full, may still forbid your use. See <a href="#/reading-a-model-card">Reading a Model Card</a>.</dd>

<dt>p95 / p99 (percentiles)</dt>
<dd>The latency that 95% (99%) of requests do at least as well as. A promise is written on a percentile because averages hide the users who complain; computing one from a Prometheus histogram needs a bucket boundary at the promise, which vLLM's default buckets lack for 1.5 s TTFT and 60 ms TPOT. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/operating-it">Operating It</a>.</dd>

<dt>PagedAttention</dt>
<dd>vLLM's founding idea: store each sequence's KV cache in fixed-size blocks from one shared pool, indexed by a block table, instead of one contiguous worst-case reservation, cutting the 60–80% of KV memory earlier systems wasted. The original kernel was deleted in v0.25; paging lives on as block-table arguments to FlashAttention and FlashInfer. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>parked session</dt>
<dd>An agent session waiting on a tool call. The engine has no notion of a session: the call that ended released its blocks, which stay reusable prefix-cache entries until eviction pressure takes them, oldest released first — so under pressure, parked sessions lose their history and the next call recomputes it. See <a href="#/the-kv-fabric">The KV Fabric</a> and <a href="#/agentic-serving">The Agentic Era</a>.</dd>

<dt>perplexity</dt>
<dd>How surprised a model is, on average, by held-out text. A mean over mostly easy tokens, it barely moves when quantization flips the close decisions that tasks depend on; per-position top-1 agreement and KL divergence against the unquantized model are a better first screen, and only a paired task evaluation decides. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>point-to-point</dt>
<dd>Communication between exactly two ranks, as opposed to a collective. Pipeline-parallel hand-offs (330 KB per stage boundary at batch 20 for a 70B) and KV transfers between disaggregated pools are point-to-point, which is why they tolerate a slower fabric than tensor parallelism. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>pooling model</dt>
<dd>vLLM's class of models that return a vector or a score instead of generated text — embedding models and rerankers — served on <code>/v1/embeddings</code>, <code>/v1/score</code> and <code>/v1/rerank</code>. Decoder-based ones use the KV-backed path and can hit the prefix cache; BERT-style encoders need no KV cache. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>PP (pipeline parallelism)</dt>
<dd>Splitting a model by layers across GPUs, each stage handing activations to the next in one point-to-point transfer — cheap enough to cross nodes. It does not make a token faster: each token passes every stage in turn, and the idle stages (the pipeline bubble) are filled only by keeping several batches in flight. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>preemption</dt>
<dd>Evicting a running sequence because a running request needs a KV block and none is free. In vLLM v0.34 the most recently admitted request (FCFS) loses all its blocks and returns to the head of the queue to be recomputed — there is no swap to CPU; it shows as <code>Preemptions:</code> in the stats log and <code>vllm:num_preemptions_total</code>. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>prefill</dt>
<dd>The phase that processes the whole prompt in one pass (or in chunks), producing the first token and the prompt's KV cache. Compute-bound: about 2 × parameters FLOPs per token plus attention work that grows with length — 0.27 s for 3,000 tokens on the case's node. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>prefix caching</dt>
<dd>Reusing the KV cache of a prompt prefix already computed — a system prompt, tool definitions, an agent's history — so its prefill is skipped. vLLM hashes each full block together with its parent's hash, so only full blocks hit and one differing token invalidates its block and everything after it: stable content goes first. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>pretraining</dt>
<dd>Training a model from random weights to predict the next token over trillions of tokens (Llama 3.3: ~15T tokens, 7.0M H100-hours); the result is a base model. Training costs ~6 × parameters FLOPs per token and ~16 bytes of state per parameter, against ~2 of each for serving. See <a href="#/where-models-come-from">Where a Model Comes From</a>.</dd>

<dt>PTQ (post-training quantization)</dt>
<dd>Quantizing a finished model with no retraining, from a small calibration set or none at all (FP8 with dynamic activation scales needs no data). Sufficient at 8 bits for every model size in the largest public sweep and usually at 4-bit weight-only from ~14B up. See <a href="#/quantization">Quantization</a>.</dd>

<dt>QAT (quantization-aware training)</dt>
<dd>Simulating the rounding during training or fine-tuning so the weights learn to survive it. Expensive; below 4-bit weight-only, ask whether a QAT release exists before trusting a post-training one. See <a href="#/quantization">Quantization</a>.</dd>

<dt>quantization</dt>
<dd>Storing weights, activations or the KV cache in fewer bits, each low-bit element paired with a scale per block. It shrinks the weight read (t_w) and the KV read (t_kv) of every step, frees memory for more sequences, and speeds arithmetic only on chips that run the format natively — and it can change answers, so every format passes an evaluation. See <a href="#/quantization">Quantization</a> and <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>query, key, value (Q, K, V)</dt>
<dd>Three vectors computed from each token in every attention layer: a token's output averages earlier tokens' values, weighted by how well its query matches their keys. Keys and values are reused by every later token and cached; a query is used once — hence a KV cache, not a QKV cache. See <a href="#/inside-a-forward-pass">Inside a Forward Pass</a>.</dd>

<dt>RadixAttention</dt>
<dd>SGLang's prefix cache: a radix tree of token sequences, matched at token granularity (page size one token by default in v0.5.23), evicted from the leaves, with a scheduler that can order the queue by longest cached prefix. A prefix that diverges mid-block still shares everything before the divergence. See <a href="#/paged-kv-cache">PagedAttention &amp; Prefix Caching</a>.</dd>

<dt>real-time factor (RTF)</dt>
<dd>For speech recognition, processing time ÷ audio duration. Above 1 a live stream falls behind and never catches up, which makes it the metric that replaces TTFT and TPOT for transcription. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>reasoning tokens</dt>
<dd>The thinking a reasoning model writes before its answer: ordinary output tokens — one decode step, one KV slot and one output price each. With a reasoning parser, vLLM puts them in a <code>reasoning</code> field and counts them in <code>usage.completion_tokens_details.reasoning_tokens</code>; sizing from visible answers alone can be off several-fold. See <a href="#/where-models-come-from">Where a Model Comes From</a> and <a href="#/agentic-serving">The Agentic Era</a>.</dd>

<dt>replica</dt>
<dd>One complete, independently serving copy of a model, spanning as many GPUs as its tensor (and pipeline) parallelism needs: Ask Halden's FP8 plan is two replicas of two GPUs each. Replicas share nothing at run time — not batches, not KV pools, not prefix caches. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>residual stream</dt>
<dd>The running vector per token — hidden_size numbers, 8,192 for Llama-3.3-70B — that every attention and MLP block reads and adds to. It is what tensor parallelism's all-reduces carry: at batch 20, 20 × 8,192 × 2 bytes ≈ 330 KB per all-reduce. See <a href="#/inside-a-forward-pass">Inside a Forward Pass</a> and <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>ridge point</dt>
<dd>The arithmetic intensity at which a chip stops being memory-bound: peak FLOP/s ÷ peak bytes/s — ~295 FLOP/byte for an H100 in dense BF16, ~206 for an H200, ~208 for Rubin. Because it stays between 200 and 300 across generations, decode stays memory-bound on every new chip. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>rollout (reinforcement learning)</dt>
<dd>A model's own attempt, generated inside a training loop so a trainer can score it. Rollouts come in many continuations of one prompt (vLLM splits <code>n</code> into children that hit the prefix cache), each step waits for its longest one, and the weights change every step, so the engine sleeps and reloads between them. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>roofline</dt>
<dd>The model of attainable FLOP/s against arithmetic intensity: a bandwidth-limited slope meeting a compute-limited ceiling at the ridge point. It predicts whether an operation needs more bandwidth, more FLOP/s, or — for very short kernels — neither. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>RoPE (rotary position embedding)</dt>
<dd>Encodes position by rotating each query and key by an angle that depends on the token's position. Keys are cached after rotation, so a cached key is valid only at the same position behind the same tokens — one reason prefix caching shares prefixes and nothing else. See <a href="#/inside-a-forward-pass">Inside a Forward Pass</a>.</dd>

<dt>sampling (temperature, top-k, top-p, greedy)</dt>
<dd>Turning the step's scores into one token: temperature divides the logits (below 1 sharpens, above 1 flattens), top-k and top-p cut the tail, greedy takes the maximum. Requests that set none get the model's generation config in vLLM v0.34 — or vLLM's neutral defaults if that is switched off, a change users notice as wandering answers. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/reading-a-model-card">Reading a Model Card</a>.</dd>

<dt>shared memory (GPU)</dt>
<dd>An SM's on-chip scratchpad, managed by the kernel itself — up to 228 KB of each H100 SM's 256 KB of L1. Fast kernels stage tiles there; a FlashAttention tile must fit in it. See <a href="#/gpu-mental-model">The GPU Mental Model</a> and <a href="#/flashattention">FlashAttention &amp; Decode Kernels</a>.</dd>

<dt>sliding-window attention</dt>
<dd>A layer that attends only to the last W tokens, so its cache stops growing at W. Models interleave window and full layers, and the saving follows the share of window layers, not the window size (gpt-oss: half → ~50% at 128K); it is real only if the engine frees out-of-window blocks. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>SLO (service-level objective)</dt>
<dd>A latency or quality promise written as a percentile: Ask Halden's are TTFT p95 ≤ 1.5 s and TPOT p95 ≤ 60 ms. Its complement is the error budget burn-rate alerts spend; measure it where the user sits — the engine's TTFT excludes retrieval and the gateway. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/operating-it">Operating It</a>.</dd>

<dt>SM (streaming multiprocessor)</dt>
<dd>The GPU's independent processing unit; an H100 has 132, each with its own registers, shared memory and tensor cores. A kernel that creates fewer thread blocks than SMs leaves the rest idle — decode attention at batch 1 is the standard case, fixed by splitting the keys. See <a href="#/gpu-mental-model">The GPU Mental Model</a> and <a href="#/flashattention">FlashAttention &amp; Decode Kernels</a>.</dd>

<dt>speculative decoding</dt>
<dd>A cheap drafter proposes γ tokens and the target verifies all of them in one pass, accepting with min(1, p/q) and resampling rejections from the residual, which leaves the output distribution exactly the target's. Verification puts B·(γ + 1) tokens in a step: nearly free below the knee, a net loss above it unless long KV reads hold it up. See <a href="#/speculative-decoding">Speculative Decoding</a>.</dd>

<dt>SSM hybrid</dt>
<dd>A model whose layers mostly keep a fixed-size recurrent state per sequence (Mamba-2, linear attention) and only a minority keep a growing KV cache. The fixed state dominates short requests — ~77 MB per sequence for Granite-4.0-H-Small — and prefix caching can reuse it only at positions where the engine saved a copy. See <a href="#/attention-for-serving">Attention Architectures for Serving</a>.</dd>

<dt>stats log (vLLM periodic line)</dt>
<dd>The line the API server prints every few seconds: <code>Avg prompt throughput</code> (computed tokens only, cached ones excluded), <code>Avg generation throughput</code>, <code>Running</code>, <code>Waiting</code>, <code>Preemptions</code> (only when non-zero), <code>GPU KV cache usage</code> (referenced blocks; evictable cached blocks count as free) and the prefix-cache hit rate over recent requests. After an interval of zeros it goes quiet, like an idle engine. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a> and <a href="#/operating-it">Operating It</a>.</dd>

<dt>structured output</dt>
<dd>Constraining generation to a JSON schema or grammar by setting the logits of every token that would break it to −∞ before sampling, so the output is valid by construction. vLLM's default backend compiles the grammar (the first request with a new schema pays for it) and builds each step's mask on the CPU while the GPU runs. See <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>tensor core</dt>
<dd>The matrix-multiply unit inside each SM, which provides nearly all of a GPU's FLOP/s and runs only certain formats natively: FP8 needs Ada, Hopper or Blackwell, FP4 needs Blackwell. Spec-sheet tensor-core figures marked "with sparsity" are twice the dense rate a dense model gets. See <a href="#/gpu-mental-model">The GPU Mental Model</a> and <a href="#/quantization">Quantization</a>.</dd>

<dt>thinking budget</dt>
<dd>A per-request cap on reasoning tokens (<code>thinking_token_budget</code> in vLLM v0.34, with a reasoning parser): at the budget the engine forces the end-of-reasoning string and the answer begins, still inside <code>max_tokens</code>. It bounds decode load and time to first answer token, and it changes answers, so it is evaluated like any model change. See <a href="#/agentic-serving">The Agentic Era</a>.</dd>

<dt>thrash</dt>
<dd>Preemption that feeds itself: requests are admitted, grow, are preempted and recomputed, and the GPU spends its time redoing prefills. The stats log shows KV usage near 100%, a Preemptions field, and prompt throughput rising while generation throughput falls. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a>.</dd>

<dt>time to first answer token</dt>
<dd>For a reasoning model, the wait the user actually feels: TTFT plus thinking tokens × TPOT. Clients that time the first streamed chunk measure the first thinking token instead, which says nothing about the answer. See <a href="#/agentic-serving">The Agentic Era</a>.</dd>

<dt>token</dt>
<dd>The unit a model reads and writes: a piece of text from a fixed vocabulary, about ¾ of an English word. Every speed, price and memory figure in the field is per token. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a>.</dd>

<dt>token budget</dt>
<dd>The cap on tokens one scheduler step may process — <code>--max-num-batched-tokens</code>, 8,192 by default on an 80 GB H100 in vLLM v0.34. Decodes take one token each and prefill chunks the rest, so it sets the worst inter-token gap: Ask Halden's 512 keeps hybrid steps near 50 ms; above the knee a larger budget barely shortens a long prompt's prefill. See <a href="#/continuous-batching">Continuous Batching &amp; Scheduling</a> and <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>token inflation</dt>
<dd>A quantized reasoning model may keep its accuracy by thinking longer, and every extra token costs time and money: net speedup = per-token speedup ÷ inflation, so 2× cheaper tokens with 1.5× the tokens is 1.33×. Measure generated tokens against the baseline and evaluate under the production output cap. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>tokenizer</dt>
<dd>The mapping from text to token IDs in a fixed vocabulary (128,256 entries for Llama 3). Different model families split the same text into different numbers of tokens — Anthropic says its newer tokenizer produces ~30% more — so per-token prices and speeds compare only within one tokenizer. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/load-testing">Load Testing: Producing a Number</a>.</dd>

<dt>tool-call parser / reasoning parser</dt>
<dd>Server components that turn a model's plain-text tool calls and thinking into the API's structured fields: <code>--enable-auto-tool-choice --tool-call-parser llama3_json</code> for Llama 3, <code>--reasoning-parser</code> for reasoning models. A mismatched parser returns the call as ordinary text — no error, broken agents. See <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>TPOT (time per output token)</dt>
<dd>The average gap between output tokens after the first: (end-to-end time − TTFT) ÷ (output tokens − 1). It describes how fast a stream feels once started; at 60 ms (Ask Halden's promise) a reader sees ~17 tokens a second. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>TP (tensor parallelism)</dt>
<dd>Splitting each layer's matrices across GPUs — columns, then rows — so every GPU reads 1/N of the weights per step and holds 1/N of the KV heads, at the price of two all-reduces per layer. It cuts per-token latency and per-GPU memory and belongs inside one NVLink domain; past the KV-head count, heads are replicated. See <a href="#/parallelism-for-inference">Parallelism for Inference</a>.</dd>

<dt>TTFT (time to first token)</dt>
<dd>Time from a request's arrival to its first token with text: queueing plus prefill, plus whatever runs before the engine. vLLM's histograms split it (API-server time + <code>vllm:request_queue_time_seconds</code> + <code>vllm:request_prefill_time_seconds</code>); retrieval and the gateway sit inside the user's TTFT and outside the engine's. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/anatomy-of-an-engine">Anatomy of a Serving Engine</a>.</dd>

<dt>two-level accumulation</dt>
<dd>The fix for Hopper's narrow FP8 tensor-core accumulator in attention: accumulate one tile in the tensor core, then flush it into a true FP32 register. It restored long-context retrieval with an FP8 KV cache for ~5% of FP8 decode speed and is on by default. See <a href="#/did-quantization-break-your-model">Did Quantization Break Your Model?</a>.</dd>

<dt>usage (response field)</dt>
<dd>The token counts every OpenAI-compatible response carries: <code>prompt_tokens</code>, <code>completion_tokens</code>, <code>total_tokens</code>, plus <code>prompt_tokens_details.cached_tokens</code> with <code>--enable-prompt-tokens-details</code> (multiples of the block size) and <code>completion_tokens_details.reasoning_tokens</code> with a reasoning parser. Logging them per call is the cheapest size and hit-rate monitor there is. See <a href="#/what-is-inference">What Actually Happens When You Call an LLM</a> and <a href="#/agentic-serving">The Agentic Era</a>.</dd>

<dt>USE grid</dt>
<dd>The serving stack as rows of resources (queue, KV pool, prefix cache, GPU compute, memory bandwidth, interconnect, CPU, host memory) against Utilisation, Saturation and Errors, each cell a named metric. In vLLM v0.34 five of eight saturation cells have no metric and must be derived — which is the point of writing them down. See <a href="#/operating-it">Operating It</a>.</dd>

<dt>utilisation (cost sense)</dt>
<dd>The share of the hours you pay for that the GPUs spend working, averaged over the day: work-seconds done ÷ replica-seconds paid. Ask Halden's is ~1.5% in phase 1 and ~5.2% in phase 2 — a different number from the prefill load at the morning peak, which answers a latency question, and from MFU or MBU. See <a href="#/hardware-and-economics">Hardware &amp; Economics</a>.</dd>

<dt>vision encoder</dt>
<dd>The second model inside a vision-language model, which turns an image's patches into vectors inserted into the prompt as tokens. An image is priced as prefill once its token count is known — Qwen2.5-VL makes one token per 28 × 28 pixels, ~2,800 for an A4 page at 150 dpi — plus the encoder's own arithmetic. See <a href="#/beyond-chat">Beyond Chat</a>.</dd>

<dt>vllm bench serve</dt>
<dd>vLLM's load generator and report: open-loop with <code>--request-rate</code> (Poisson by default, <code>--burstiness</code> below 1 for bursts), every request at time zero without it; prints TTFT, TPOT and ITL percentiles, output and total token throughput, and goodput with <code>--goodput</code>. Its default <code>--seed</code> replays the same prompts, so a second run measures the prefix cache. See <a href="#/load-testing">Load Testing: Producing a Number</a> and <a href="#/inference-arithmetic">Inference Arithmetic</a>.</dd>

<dt>W4A16, W8A8</dt>
<dd>Shorthand for quantization schemes: bits for weights (W) and activations (A). W4A16 cuts weight bytes 4× but multiplies at BF16 rates, so its nameplate knee falls to ~74 and it wins at low concurrency; FP8 W8A8 halves bytes and doubles the arithmetic rate, keeping the knee at ~295 on an H100 — the better choice near peak load. See <a href="#/quantization">Quantization</a>.</dd>

<dt>warp</dt>
<dd>A group of 32 threads on an SM that execute the same instruction in lockstep. Divergent branches inside a warp serialise, which is why GPU kernels are written as uniform tile programs. See <a href="#/gpu-mental-model">The GPU Mental Model</a>.</dd>

<dt>wide-EP</dt>
<dd>Expert parallelism across many GPUs — DeepSeek's decode runs EP144 with two routed experts and one shared expert per GPU — so each expert's matrix multiply sees enough of the pooled batch to be efficient; attention runs data-parallel, and the all-to-all dominates unless hidden by overlap or kept on a 72-GPU NVLink domain. See <a href="#/moe-serving">Serving MoE at Scale</a>.</dd>

<dt>work-seconds</dt>
<dd>The replica time one request costs on a saturated replica: (uncached prompt tokens + output tokens) × ~0.089 ms on Ask Halden's replica. Summed over a day and divided by the replica-seconds paid, it gives utilisation in the cost sense. See <a href="#/hardware-and-economics">Hardware &amp; Economics</a>.</dd>

<dt>Xid</dt>
<dd>An NVIDIA driver error event in the kernel log, <code>NVRM: Xid (PCI:0000:5a:00): 79, …</code>: the PCI address names the GPU, the number the event, and NVIDIA's catalog gives the action — 43 and 45 are routine, 48, 79, 95 and 119/120 are not, 63 is a row remap waiting for a reset. <code>DCGM_FI_DEV_XID_ERROR</code> is a gauge holding the last Xid seen, so last week's 45 still reads 45. See <a href="#/when-it-breaks">When It Breaks</a>.</dd>

</dl>
