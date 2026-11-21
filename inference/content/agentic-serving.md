# The Agentic Era

> **The question:** what do agent loops and reasoning models do to a fleet's
> prefill load, KV occupancy and cache economics — and why does Halden's phase 2
> fit on its node only if the prefix cache keeps hitting?
>
> **You'll be able to:** count the prefill, decode and KV an agent loop costs with
> and without prefix caching, and check it in the `usage` of each call; keep an
> agent's prompt cache-stable and test it in CI; price agent traffic under a
> provider's caching rules (read discount, write surcharge, lifetime); predict what
> a thinking budget does to decode load and to latency promises.

<div class="inf-widget inf-stackmap" data-widget="stackmap" data-highlight="client,router,kv"></div>

An Ask Halden question reads 3,000 tokens and writes 250. The ticket agent of phase 2,
to finish one user request, reads **47,000** tokens and writes about 850 — and it
has already read most of the 47,000 before, one call earlier.

An **agent** is a model in a loop: read the task, call a tool — search, query, API —
read the result, call another, and answer when done. Every call sends the whole
conversation so far again: system prompt, tool definitions, every earlier step. A
**reasoning model** ([Reading a Model Card](#/reading-a-model-card)) writes a private
chain of "thinking" tokens before its answer, often thousands of them. The first
workload multiplies prefill; the second multiplies decode. This chapter counts both.

## An agent loop, in tokens

Take a coding agent that starts with 20,000 tokens of context — system prompt, tool
schemas, the files it has read — and runs 30 iterations. Each iteration appends a
~200-token tool call and ~1,000 tokens of tool output, so the context grows by 1,200
tokens a step.

> [!predict] Before you read on
> If every iteration is prefilled from scratch, how many prompt tokens does the task
> process? With perfect prefix caching, how many — about 2×, 10× or 20× fewer?

Without caching, iteration *i* prefills `20,000 + 1,200 × i` tokens:
`30 × 20,000 + 1,200 × (0 + 1 + … + 29) = 600,000 + 522,000 ≈` **1.12 million**,
against 6,000 output tokens — 190 to 1. With [prefix
caching](#/paged-kv-cache), each iteration reuses everything up to the previous one's
end and prefills only what is new: `20,000 + 29 × 1,200 ≈` **55,000**. That is
**20× less**, and the gap widens with every iteration: uncached work grows with the
square of the loop's length, cached work linearly. One small leak: only full blocks
hit (64 tokens in vLLM v0.34), so each call also recomputes up to 63 tokens of the
previous prompt's partial last block.

## Halden's phase 2, in tokens

Phase 2 (the case's fixed inputs): at the peak, 0.5 agent requests/s alongside 1.0
Q&A request/s. Each agent request is four model calls with tool waits between them,
contexts of 3.5K → 9K → 14.5K → 20K tokens, the first 3,000 — system prompt and tool
definitions — identical for every session. The case does not fix the output, so this
chapter assumes ~200-token tool calls and a ~250-token final answer (the phase-1
median): **~850 output tokens per agent request**.

**Prefill.** Uncached, a request prefills `3.5K + 9K + 14.5K + 20K = 47K` tokens.
Cached, call 1 finds the 3K preamble and prefills ~0.5K; each later call finds the
previous call's prompt and prefills its 5.5K delta: `0.5K + 3 × 5.5K ≈` **17K**.
vLLM reports the split per call when launched with `--enable-prompt-tokens-details`.
Here are the final usage chunks of one session's four streamed calls; predict the
four `cached_tokens` values before reading them.

```plaintext
call 1  data: {"id":"chatcmpl-7a1e…","object":"chat.completion.chunk",…,"choices":[],"usage":{"prompt_tokens":3500,"total_tokens":3700,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":2944}}}
call 2  data: {"id":"chatcmpl-91c4…",…,"choices":[],"usage":{"prompt_tokens":9000,"total_tokens":9200,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":3456}}}
call 3  data: {"id":"chatcmpl-c03b…",…,"choices":[],"usage":{"prompt_tokens":14500,"total_tokens":14700,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":8960}}}
call 4  data: {"id":"chatcmpl-e58d…",…,"choices":[],"usage":{"prompt_tokens":20000,"total_tokens":20250,"completion_tokens":250,"prompt_tokens_details":{"cached_tokens":14464}}}
```

*Real format, illustrative values — `usage` fields from vLLM v0.34.0
`vllm/entrypoints/serve/engine/protocol.py` and `openai/chat_completion/serving.py`
(`prompt_tokens_details` only with `--enable-prompt-tokens-details`; `None` fields
dropped from the usage chunk); token counts computed from the case with 64-token
blocks, not measured.*

Every `cached_tokens` is a multiple of 64. Call 1's 2,944 is the preamble's 46 full
blocks; its 47th block mixes the preamble's tail with this user's request. Call 2
reuses 3,456 tokens — call 1's prompt, rounded down — and not the 200 tokens the
model wrote: the template re-renders the tool call as an assistant message, and
unless those tokens match what the model generated, the hit ends there. Summing
`prompt_tokens − cached_tokens` over the four calls gives 17,176: the 17K, from the
wire. Log both fields per call; they are the cheapest hit-rate monitor you have.

**Prefill load at the peak.** Cached: `0.5 × 17K + 1.0 × 2.2K ≈ 10.7K` tokens/s
(each Q&A request prefills ~2.2K beyond the shared 800-token prompt). At 1.4 × 10¹¹
FLOPs per token that is 1.5 × 10¹⁵ FLOP/s, **~47%** of the two FP8 replicas'
3.2 × 10¹⁵. Uncached: `0.5 × 47K + 1.0 × 3K ≈ 26.5K` tokens/s, 3.7 × 10¹⁵ FLOP/s —
**more than the node can do**. The hit rate is not an optimisation here; it is the
difference between fitting and not.

**Decode.** `0.5 × 850 + 1.0 × 250 = 675` output tokens/s, ~340 per replica. On the
case's step model ([Inference Arithmetic](#/inference-arithmetic)), each replica
prefills 5,350 tokens/s in 512-token chunks: ~10 hybrid steps a second at ~48 ms
(`520 × 0.089 ms` plus KV reads), about half of every second. The rest are
decode-only steps at ~16 ms (rung 4: ~8 sequences decoding, ~70K context tokens of
KV reads ≈ 2 ms). Mean step ≈ 24 ms, so TPOT averages ~25 ms, and a token that
rides a hybrid step waits ~48 ms — inside the 60 ms promise, with ~12 ms to spare.
Phase 2's decode is light; what it pays in TPOT is its *prefill*.

**KV occupancy.** By Little's law, `0.5/s × ~80 s ≈ 40` sessions are open at the
peak. Each spends ~23 s in the engine (850 tokens at ~25 ms, plus ~2 s of chunked
prefill) and ~57 s in three tool waits of ~19 s. So at any moment ~12 sessions are
running and ~28 are parked — and a parked session, to the engine, is just evictable
prefix-cache blocks. With the preamble stored once, the whole working set is
~61 GB of the node's 132 GB of FP8 pool; [The KV Fabric](#/the-kv-fabric) worked out
what happens to the parked 70% when a replica fails.

**Per session.** A session's latency is the sum over its calls,
`Σ (TTFT + output × TPOT) + tool time` ≈ 23 s of model time plus 57 s of tools. A
per-session promise ("ticket filed in under 2 minutes") is the one users feel, and
it does not decompose into per-call p95s — the slow tail of four calls compounds.
Set per-call targets from the session budget, and measure the session.

## What agents demand of the fleet

**Routing that remembers.** A hit happens only if call `N + 1` reaches the replica
holding calls `1 … N`. Round-robin scatters them; agent traffic is what made
session- and prefix-aware routing non-optional ([The KV Fabric](#/the-kv-fabric)).

**Room for parked sessions.** Halden parks ~28 sessions at the peak, each holding
~1.3 GB of unique history; an engine evicts the oldest released blocks first, which
are exactly those. A host-memory tier catches them.

**Prompts built for caching.** A cache only hits if the prefix is identical, token
for token, from position zero. Reorder tool definitions between calls, put a
timestamp near the top, or edit the middle of the history, and every block after
the change misses. **Context engineering** on the application side — a byte-stable
head, an append-only body, volatile content last — exists largely to keep the
server's cache warm.

**Tool calls that parse.** A malformed call costs a retry: one more prefill and
decode round in the session. In vLLM v0.34, `tool_choice="required"` or a named
function decodes the call under the tool's JSON schema — the grammar mask from
[Anatomy of a Serving Engine](#/anatomy-of-an-engine) — while `"auto"` lets the
model write freely unless a tool sets `strict: true` or the server sets
`--tool-strict-level`. Most agent frameworks never set `strict`.

> [!trap] "Reused KV always gives the same result"
> *Exact* prefix reuse is exact: identical tokens from position zero give identical
> keys and values. Some systems go further and reuse KV computed in a *different*
> context — for example, each candidate answer's KV computed on its own, then
> spliced into an LLM judge's prompt that compares the candidates. That is an
> approximation, and a 2026 study found that end-task accuracy can look stable while
> the judge's choices diverge from those made with full prefill
> ([arXiv 2601.08343](https://arxiv.org/abs/2601.08343)). Know which kind of reuse
> your stack performs.

## Cache hits on an invoice

Hosted APIs pass the prefix cache through to the price sheet as a separate,
cheaper line for cached input — and some charge extra to write the cache.

> [!predict] Before you read on
> The 1.12M-token coding task above runs on an API at $3 per million fresh input
> tokens and $0.30 per million cached ones. What does its input cost uncached, and
> at its 95% hit rate: more or less than 10× cheaper?

Less: about 7×. Uncached, `1.12M × $3 ≈ $3.37`. Cached, the 55K fresh tokens cost
`$0.16` and the 1.07M cached ones `$0.32`: **$0.48**. A 10× discount on 95% of the
tokens leaves the 5% at full price carrying a third of the bill. If the provider
charges 1.25× to write what it caches, the fresh tokens cost $0.21 and the total
$0.53.

The rules differ by provider and change often. As of November 2026, cached input is
**10–40× cheaper** than fresh on the major APIs (0.1× at Google and on older models,
0.05× on Anthropic's and OpenAI's current mid and top tiers, 0.025× on Anthropic's
priciest models). Anthropic charges 1.25× the input price to write a 5-minute cache entry and
2× for a 1-hour one; OpenAI charges 1.25× and 2.5× for 30-minute and 12-hour
retention on GPT-5.6 and later, and nothing on earlier models. The lifetime is the
operational trap: a provider's cache entry lives a fixed time from its last use
(Anthropic's default is 5 minutes, refreshed on each hit), so an agent whose tool
waits outlast it pays the write again on the next call. A self-hosted engine has no
lifetime at all — blocks live until eviction pressure takes them, which is why
Halden watches `vllm:kv_block_idle_before_evict_seconds` instead.

## Reasoning models pull the other way

Thinking tokens are **output tokens**: decoded one step each, billed at the output
price, and held in KV while the request runs — 164 KB each in FP8 KV for Halden's
model, so 4,000 tokens of thinking is 0.66 GB per call in flight. vLLM reports them
as `usage.completion_tokens_details.reasoning_tokens` when a reasoning parser is
configured. In vLLM v0.34 a request can cap them:

```bash
curl -sN http://reasoning-llm:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "Qwen/Qwen3-32B",
       "messages": [{"role": "user", "content": "Which open tickets block release 4.2?"}],
       "thinking_token_budget": 4000,
       "max_tokens": 5000,
       "stream": true,
       "stream_options": {"include_usage": true}}'
```

*Real format, illustrative values — `thinking_token_budget` from vLLM v0.34.0
`vllm/entrypoints/openai/chat_completion/protocol.py` and `sampling_params.py`
(a non-negative integer, `-1` for unlimited; the server needs `--reasoning-parser`,
e.g. `qwen3`); host, model choice and prompt invented.*

When the count of thinking tokens reaches the budget, vLLM forces the model's
end-of-reasoning string (`reasoning_end_str` in `--reasoning-config`) and the answer
begins. The budget sits *inside* `max_tokens`, which still caps everything the
request writes. Dynamo v1.6 accepts the same root-level field and passes it to vLLM
or SGLang.

Two consequences for an SLO. TTFT as clients usually measure it — the first chunk
with text — now times the first *thinking* token, which says nothing about what the
user waits for. The promise has to be **time to first answer token**: TTFT plus
thinking tokens × TPOT. And a fleet serving reasoning shifts toward decode: thousands
of memory-bound steps per request, a KV footprint that grows *during* decode, and,
mixed with agent prefill bursts on the same replicas, inter-token latency spikes for
every thinking request that shares a hybrid step — which is why mixed fleets route
the two shapes to differently tuned pools ([Disaggregated
Serving](#/disaggregation)).

Two other workloads that stretch the same engines — many fine-tuned adapters over
one base model, and reinforcement-learning rollouts generated inside a training
loop — are the subject of [Beyond Chat](#/beyond-chat).

In the simulator, choose the **agent** workload and toggle prefix caching: TTFT p50
moves between rebuilding the whole context every call and prefilling only the new
tool result.

<div class="inf-widget" data-widget="engine-simulator">
<p class="inf-widget-fallback">Interactive serving-engine simulator — needs JavaScript enabled.</p>
</div>

> **State of play (November 2026):** agent traffic now has a public hardware
> benchmark: SemiAnalysis's AgentX, part of InferenceX, replays agentic traces and
> reports tokens per dollar against P90 interactivity (its September 2026 Rubin
> results are vendor-hardware comparisons on pre-release software). Provider cache
> prices and lifetimes moved twice this year; recheck the pricing pages before you
> quote one. Thinking budgets are request fields in vLLM, in Dynamo v1.6 (October)
> and, experimentally, in TensorRT-LLM v1.3 (November).

> [!dashboard] The prefix cache as a business metric
> **Utilisation:** token-weighted hit rate = `rate(vllm:prompt_tokens_cached_total[5m]) ÷
> rate(vllm:prompt_tokens_total[5m])`, host-tier reloads included
> (`vllm:prefix_cache_hits_total ÷ vllm:prefix_cache_queries_total` counts HBM alone). **Saturation:**
> `rate(vllm:prompt_tokens_by_source_total{source="local_compute"}[5m])` against the
> replica's prefill capacity (~11K tokens/s per FP8 replica for Halden).
> **Errors:** none in the engine — derive it from the application's per-call log of
> `usage.prompt_tokens_details.cached_tokens`: a second or later call of a session
> that hits only the preamble lost its history.

> [!case] The case: phase 2 lands
> Derived above from the case's inputs: per agent request 47K prompt tokens
> uncached, ~17K cached; ~850 output tokens (this chapter's assumption). At the
> peak, cached prefill is ~10.7K tokens/s (**47%** of the two replicas), uncached
> ~26.5K (**over capacity**); decode is 675 tokens/s, TPOT ~25 ms on average and
> ~48 ms in hybrid steps against the 60 ms promise; ~40 sessions open, ~28 of them
> parked as evictable blocks.
>
> **What this settles:** the prefix-cache hit rate is a capacity metric, not a
> nicety. It goes on the dashboard with an alert — token-weighted hit rate below 50%
> over ten minutes ([Operating It](#/operating-it)) — because at the ~60% the case expects,
> the node fits, and at ~3% it does not. The agent's prompt template becomes an
> interface reviewed for cache stability (byte-stable preamble, tools in a fixed
> order, history append-only) with a CI test (Exercise 2), and every call logs
> `cached_tokens`. **The stake:** the TPOT margin is ~12 ms. Swapping the agent's
> model for a reasoning model, even one with a modest thinking budget, spends it
> (Exercise 3).

## Exercises

<div class="exercise">

**Exercise 1.** A coding agent runs on a hosted API at $3 per million input tokens,
with Anthropic's published cache multipliers: writes 1.25× (5-minute lifetime) or 2×
(1-hour lifetime), reads 0.1×. Each call carries ~50K tokens, of which ~2K are new.
Tool waits are spread evenly between 3 and 8 minutes. What does an average call's
input cost with the 5-minute cache, with the 1-hour cache, and with no caching?

<details>
<summary>Reveal answer</summary>

With a 5-minute lifetime refreshed on use, a wait of 3–5 minutes keeps the entry
(2 of the 5 minutes of the spread: 40%) and a longer one loses it (60%).

- Hit: read 48K × $0.30/M + write 2K × $3.75/M = $0.0144 + $0.0075 ≈ **$0.022**.
- Miss: write all 50K × $3.75/M ≈ **$0.19**.
- 5-minute average: `0.4 × 0.022 + 0.6 × 0.19` ≈ **$0.12** per call.
- 1-hour: every wait fits; read 48K × $0.30/M + write 2K × $6/M ≈ **$0.026**.
- No caching: 50K × $3/M = **$0.15**.

The 5-minute cache saves only ~20% here, because most calls pay the write premium
on the whole context; the 1-hour cache, at the higher write price, is ~4.5× cheaper
than it. Price caching against the distribution of tool waits, not the hit rate the
dashboard shows on fast sessions.

</details>

</div>

<div class="exercise">

**Exercise 2 — diagnosis.** After a release of the agent framework, Ask Halden's
prefix hit rate falls from ~60% to ~3%, TTFT climbs through the morning and
`vllm:num_requests_waiting` never drains. The release diff touches the preamble:

```diff
 def build_preamble(tools, now):
-    head = "You are Halden's ticket agent. Follow the rules below.\n"
-    tool_defs = sorted(tools, key=lambda t: t["name"])
+    head = f"Current time: {now:%H:%M:%S}\nYou are Halden's ticket agent. Follow the rules below.\n"
+    names = {t["name"] for t in tools}               # de-duplicate tool names
+    tool_defs = [t for n in names for t in tools if t["name"] == n]
     return head + RULES + json.dumps(tool_defs)
```

*Real format, illustrative values — a unified diff of an invented agent template;
the numbers are the case's (below).*

Which change broke the cache, why is the residual hit rate 3% and not 0, why does
the node fall behind, and what test do you ask for?

<details>
<summary>Reveal answer</summary>

Both. The timestamp in the first block changes every second, and block hashes chain
from position zero, so no agent call — not even a session's next call — reuses
anything. A Python `set` of strings iterates in an order that depends on the
process's hash seed, so the tool definitions change order between workers and
restarts. What still hits is Q&A's 800-token system prompt: ~0.8K of the 26.5K
prompt tokens per second, 3%. Prefill demand rises from 10.7K to ~25.7K tokens/s,
past the two replicas' ~22.6K: the queue grows without bound. Ask for the time to
move to the end of the context and tools in a sorted order, and for this CI test,
which renders the preamble twice in time and in eight interpreters with different
hash seeds:

```python
import json, os, subprocess, sys
from datetime import datetime, timedelta
TOOLS = [{"name": n, "parameters": {"type": "object"}}
         for n in ("create_ticket", "update_ticket", "search_kb", "get_user")]

def preamble_v2(now):                       # the release under suspicion
    names = {t["name"] for t in TOOLS}      # a set: its order follows the hash seed
    tools = [t for n in names for t in TOOLS if t["name"] == n]
    return f"Current time: {now:%H:%M:%S}\nYou file Halden tickets.\n" + json.dumps(tools)

def preamble_fixed(now):                    # the time moves to the end of the context
    tools = sorted(TOOLS, key=lambda t: t["name"])
    return "You file Halden tickets.\n" + json.dumps(tools, sort_keys=True)

def render_in_child(name, seed):            # a fresh interpreter, another hash seed
    env = dict(os.environ, PYTHONHASHSEED=str(seed))
    return subprocess.run([sys.executable, __file__, name], env=env,
                          capture_output=True, text=True, check=True).stdout
T0 = datetime(2026, 11, 21, 9, 0, 0)
if len(sys.argv) > 1:
    print(globals()[sys.argv[1]](T0), end="")
else:
    for name in ("preamble_v2", "preamble_fixed"):
        render = globals()[name]
        same_later = render(T0) == render(T0 + timedelta(seconds=20))
        variants = len({render_in_child(name, seed) for seed in range(8)})
        ok = same_later and variants == 1
        print(f"{name:15} same 20 s later: {same_later!s:5} "
              f"distinct bytes over 8 hash seeds: {variants}  {'PASS' if ok else 'FAIL'}")
```

*Runnable — Python 3 standard library only (save it as a file: it re-runs itself);
output shown is from an actual run with Python 3.13.*

```plaintext
preamble_v2     same 20 s later: False distinct bytes over 8 hash seeds: 6  FAIL
preamble_fixed  same 20 s later: True  distinct bytes over 8 hash seeds: 1  PASS
```

*Runnable — output of the program above, pasted from a real run with `python3`.*

Identical bytes give identical tokens, so the test needs no tokenizer. Run it on
the real template in CI; one red line here is cheaper than one morning at 3%.
[When It Breaks](#/when-it-breaks) (incident 2) lives that morning from the
on-call's side, with another trigger and the same numbers.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** A team proposes replacing Halden's agent model with a
reasoning model of the same size and memory shape, calling it with
`thinking_token_budget: 4000` on each of the four calls. Assume it uses most of the
budget and the rest of phase 2 is unchanged. What happens to decode demand, to
session length and live sessions, to the KV the engine must hold, and to the latency
promises — and what would you measure or change?

<details>
<summary>Reveal answer</summary>

- **Decode demand:** each agent request writes up to `4 × 4,000 + 850 ≈ 16,850`
  tokens instead of 850. At 0.5 requests/s that is ~8,400 tokens/s plus Q&A's 250:
  ~8,700 on the node, ~4,300 per replica — about 13× today's 340.
- **Session length:** 16,000 thinking tokens at even today's ~25 ms a step is 400 s
  of decode per session: sessions grow from ~80 s to ~480 s, and Little's law takes
  open sessions from ~40 to ~240.
- **KV:** each running call grows by 0.66 GB as it thinks, and six times as many
  sessions are open. At ~4,300 tokens/s per replica and a 60 ms step, ~260
  sequences would decode at once — far past the effective knee of ~160 tokens per
  step, so steps lengthen, and far past what a 66 GB pool holds at 10–20K tokens of
  context each. The plan does not fit; preemption would start before the SLOs break.
- **Latency:** TPOT can no longer be met at 60 ms, and per-call TTFT stops meaning
  anything to the agent: its real latency is time to first answer token,
  ~0.3 s + 4,000 × TPOT ≈ 100 s per call even at 25 ms.

Measure `usage.completion_tokens_details.reasoning_tokens` on real tickets before
deciding: if the model needs a few hundred thinking tokens, the budget is the
control; if it needs thousands, the agent needs its own decode-heavy replicas.

</details>

</div>

## What to remember

- An agent resends its growing context every call: uncached prefill grows with the
  square of the loop's length, cached prefill linearly — 20× apart after 30 steps.
- Halden's phase 2 is ~47% of the node's prefill capacity at a ~60% hit rate and
  over capacity without it; its decode is light, but its prefill chunks set TPOT.
- `usage.prompt_tokens_details.cached_tokens` (with `--enable-prompt-tokens-details`)
  shows every call's hit, in multiples of the block size.
- Cache-stable prompts are an interface: stable head, sorted tools, volatile content
  last, enforced by a test that renders the preamble twice.
- Hosted caches discount reads 10–40× but may charge 1.25–2.5× to write and expire
  after minutes; tool waits longer than the lifetime pay the write again.
- Thinking tokens are output tokens: they multiply decode, KV and session length,
  and the latency promise becomes time to first answer token.

```quiz
[
  {
    "q": "A support agent makes 6 calls per ticket. Its context starts at 5,000 tokens and grows by 2,000 tokens per call. How many prompt tokens are prefilled per ticket with no caching, and with perfect session caching?",
    "choices": [
      "30,000 uncached and 5,000 cached: the context is built once",
      "60,000 uncached and 15,000 cached: a 4× reduction",
      "42,000 uncached and 15,000 cached: a 2.8× reduction",
      "60,000 uncached and 12,000 cached: only the deltas are new"
    ],
    "answer": 1,
    "explain": "Uncached: 6 × 5,000 + 2,000 × (0 + 1 + … + 5) = 30,000 + 30,000 = 60,000. Cached: the first call prefills 5,000, each later call its 2,000 new tokens: 5,000 + 5 × 2,000 = 15,000. The 12,000 choice forgets that the first call still builds the starting context; the 30,000 choice treats the context as constant."
  },
  {
    "q": "A reasoning model streams its thinking as reasoning content, which the chat UI hides. The client logs TTFT as the first chunk with text. The dashboard shows TTFT p95 of 0.6 s while users report 40-second waits before any answer appears. What is the most likely explanation?",
    "choices": [
      "The prefill of long prompts is slow, and TTFT is sampled too rarely to catch it",
      "The stream is buffered by a proxy, so tokens arrive in one burst at the end",
      "The engine preempts reasoning requests, so they restart from the beginning",
      "TTFT times the first thinking token; users wait thinking × TPOT longer"
    ],
    "answer": 3,
    "explain": "With thinking streamed as reasoning content, the first chunk carrying text is a thinking token, so TTFT stays at the prefill time. The user waits for the first answer token: TTFT + thinking tokens × TPOT, e.g. 0.6 s + 1,600 × 25 ms ≈ 40 s. Slow prefill would show in TTFT itself; a buffering proxy would delay the first chunk too."
  },
  {
    "q": "An agent's calls log usage per call. Call 2 of a session showed cached_tokens 3,456; call 3, after a 20 s tool wait, shows cached_tokens 2,944 — just the shared preamble. The template is byte-stable in CI, routing is by session, and vllm:kv_block_idle_before_evict_seconds has a median of 8 s at the peak. What happened?",
    "choices": [
      "Its history was evicted during the 20 s tool wait, under pool pressure",
      "The call landed on another replica, which only holds the preamble",
      "The template inserted a timestamp, which changed the session's history",
      "The 64-token block size truncated the hit back to the preamble's end"
    ],
    "answer": 0,
    "explain": "Blocks are being evicted after ~8 s idle, and this session sat idle 20 s, so its history was reclaimed while the always-hot preamble survived. Session routing rules out another replica; a byte-stable template rules out a timestamp, which would also break the preamble; block rounding costs at most 63 tokens, not 5,500. Add pool (FP8 KV) or a host tier."
  },
  {
    "q": "A nightly batch sends 10,000 different 20,000-token documents to a hosted API, each exactly once, and the team turns on prompt caching at a provider that charges 1.25× the input price for cache writes and 0.1× for reads. What happens to the input bill?",
    "choices": [
      "It falls about 10×, since every cached token is read at 0.1×",
      "It is unchanged, because the provider bills only cache reads, not writes",
      "It rises 25%: every token is written at 1.25×, and none is read",
      "It falls about 2×, because half the documents share a common prefix"
    ],
    "answer": 2,
    "explain": "Caching pays only when a prefix is read again. Each document is sent once, so every token is written at 1.25× and never read: the bill rises by a quarter. Enable caching for prefixes you will reuse within the entry's lifetime, such as an agent's preamble, not for one-shot documents."
  },
  {
    "q": "On vLLM v0.34 with default block settings, an agent's call 5 has a 10,000-token prompt; call 4's prompt was 7,050 tokens, and the template re-renders call 4's output differently from how the model wrote it. What is the most cached_tokens call 5 can report?",
    "choices": [
      "7,050 tokens, the whole of call 4's prompt",
      "6,976 tokens, one full block short of call 4's prompt",
      "7,049 tokens, all but the logits token",
      "7,040 tokens, the prompt in whole 64-token blocks"
    ],
    "answer": 3,
    "explain": "Hits land on full blocks: 7,050 ÷ 64 = 110 full blocks = 7,040 tokens; the last 10 tokens share a block with call 4's re-rendered output, which differs, so that block's hash differs. The 'all but one token' rule applies when a request's whole prompt is cached, which is not the case here."
  }
]
```
