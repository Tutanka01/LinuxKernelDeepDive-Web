# Lab: Find the Knee

> **The question:** at what arrival rate does your server stop keeping its
> promises — and can you predict that rate before you measure it?
>
> **You'll be able to:** build an open-loop load generator and show why a
> closed loop hides overload; predict the saturation rate and the number of
> requests in the system, and check both against the server's gauges; read a
> sweep — where goodput leaves throughput, and why p95 breaks while the mean
> stays calm.

> **Not executed by the author.** Flags, endpoints, metric names and response
> fields come from the llama.cpp server README at build b12608 (2026-11-21);
> Homebrew installs llama.cpp 1.0.0 (2026-11-13) — if a flag is rejected,
> `llama-server --help` is the authority. Expected results against
> `llama-server` are described by shape, never as figures; the results table is
> yours to fill. The scripts were run by the author against two mock servers
> written for this lab, never against `llama-server`. The one output shown in
> full is from the deliberately slow mock of Stage 2, and is labelled so.

[Load Testing](#/load-testing) taught the method; this lab is its practice, on
the server from the first two labs. Four terms from that chapter, in a clause
each. An **open-loop** generator sends requests on a schedule that does not
depend on the answers; a **closed-loop** one runs a fixed set of users, each
waiting for its answer before sending the next. **Coordinated omission** is
what a closed loop does under overload: it slows down with the server, so it
stops sending exactly when the measurement matters. **Goodput** is the rate of
requests that meet every promise, against **throughput**, the rate of requests
completed at all.

**What you need:** [Lab: Your First Tokens](#/lab-first-tokens) and [Lab:
Batching and the Prefix Cache](#/lab-batching-and-cache) done — your prefill
rate on the ~1,100-token prompt and your aggregate tokens/s at N = 8;
`python3`; about 90 minutes, most of it waiting.

---

## Stage 1: write the generator

The generator has one job: send each request at its scheduled time, whatever
the server is doing, and write down what happened. Save it as `loadgen.py`:

```python
#!/usr/bin/env python3
"""Open-loop load generator for llama-server's streaming /completion endpoint.

usage: python3 loadgen.py RATE SECONDS OUT.csv
Arrival times are drawn up front (Poisson, RATE per second). Each request is
sent at its time on its own thread, whether or not earlier ones have answered.
Writes one CSV row per request (times in seconds from the start), and the
server's two request gauges, sampled each second, to OUT.gauges.
"""
import csv, http.client, json, random, re, sys, threading, time

HOST, PORT = "127.0.0.1", 9931
PROMPT = ("The Rotterdam depot ships pallets to Hamburg every Monday and the "
          "trucks come back with empty crates on Wednesday. ") * 14      # ~300 tokens
N_PREDICT = 128
FIELDS = ["id", "sched", "sent", "first", "last", "prompt_n", "predicted_n", "error"]

def one_request(i, sched, t0, rows):
    rec = dict(id=i, sched=sched, sent=time.perf_counter() - t0, first="", last="",
               prompt_n=0, predicted_n=0, error="")
    body = json.dumps({"prompt": f"Request {i}. {PROMPT}\nSummarise the schedule.",
                       "n_predict": N_PREDICT, "ignore_eos": True,
                       "cache_prompt": False, "stream": True})
    try:
        conn = http.client.HTTPConnection(HOST, PORT, timeout=900)
        conn.request("POST", "/completion", body, {"Content-Type": "application/json"})
        resp = conn.getresponse()
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        chunks = 0
        for line in resp:                        # server-sent events: "data: {...}"
            if not line.startswith(b"data: "):
                continue
            now, msg = time.perf_counter() - t0, json.loads(line[6:])
            if msg.get("content"):
                rec["first"] = rec["first"] or now
                rec["last"], chunks = now, chunks + 1
            if msg.get("stop"):                  # the last event carries the timings
                t = msg.get("timings", {})
                rec["prompt_n"], rec["predicted_n"] = t.get("prompt_n", 0), t.get("predicted_n", chunks)
                break
        conn.close()
    except Exception as e:                       # a failed request is data, not a crash
        rec["error"] = repr(e)[:80]
    rows.append(rec)

def sample_gauges(t0, stop, out):
    """Once a second: requests in slots, and requests waiting for one."""
    while not stop.is_set():
        try:
            conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
            conn.request("GET", "/metrics")
            g = dict(re.findall(r"^llamacpp:requests_(\w+) (\S+)$",
                                conn.getresponse().read().decode(), re.M))
            out.append((round(time.perf_counter() - t0, 2), g["processing"], g["deferred"]))
        except Exception:
            pass
        stop.wait(1.0)

def write_csv(rows, path):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, FIELDS)
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r["id"]))

if __name__ == "__main__":
    rate, seconds, out = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
    rng = random.Random(42)                      # same seed, same schedule: runs compare
    # Poisson arrivals, conditioned on their count: uniform times, sorted.
    schedule = sorted(rng.uniform(0, seconds) for _ in range(round(rate * seconds)))
    rows, gauges, threads, stop = [], [], [], threading.Event()
    t0 = time.perf_counter()
    threading.Thread(target=sample_gauges, args=(t0, stop, gauges), daemon=True).start()
    worst_lag = 0.0
    for i, sched in enumerate(schedule):
        time.sleep(max(0.0, t0 + sched - time.perf_counter()))
        worst_lag = max(worst_lag, time.perf_counter() - t0 - sched)
        th = threading.Thread(target=one_request, args=(i, sched, t0, rows))
        th.start()                               # do not wait for it: that is the open loop
        threads.append(th)
    for th in threads:
        th.join()
    stop.set()
    write_csv(rows, out)
    with open(out + ".gauges", "w", newline="") as f:      # e.g. run-0.5.csv.gauges
        csv.writer(f).writerows(gauges)
    errors = sum(1 for r in rows if r["error"])
    print(f"offered {rate}/s for {seconds:.0f} s: sent {len(rows)} ({len(rows) / seconds:.2f}/s), "
          f"worst send lag {worst_lag * 1000:.0f} ms, errors {errors}, "
          f"last answer at {time.perf_counter() - t0:.0f} s")
```

*Runnable — Python 3 standard library only; run by the author against two mock servers that speak the documented llama.cpp streaming format, not against llama-server. Its output on the slow mock is in Stage 2.*

Five decisions to read in it:

- **The schedule is fixed before the first request.** Poisson arrivals at rate
  λ are what independent users produce. Given how many arrive in a window,
  their times are uniform and independent, so the script draws exactly
  `rate × seconds` uniform times and sorts them: the right burstiness, and an
  exact count. The fixed seed makes reruns comparable.
- **Each request gets its own thread and is never waited for.** The main loop
  sleeps until the next scheduled time and launches; that is the open loop.
  `worst send lag` reports whether the generator itself fell behind. If it
  reaches tens of milliseconds, your laptop is the bottleneck, not the server.
- **TTFT is measured from the scheduled time.** If the generator was late, the
  lateness counts against the server, never hides in it. This is how an open
  loop avoids coordinated omission even when it is imperfect.
- **The stream is read as the README describes it.** Until the end, a `data:`
  line carries only `content`, `tokens` and `stop`; the last one brings the
  `timings`. First and last content lines give TTFT and the decode span;
  `predicted_n` gives the token count (or, failing that, the lines counted).
- **The server's gauges are sampled alongside.** Once a second,
  `requests_processing` and `requests_deferred` go to a second file, for the
  Little's-law check in Stage 5.

A failed request is recorded with its error and the run goes on: under overload,
errors are data.

---

## Stage 2: prove it on a server that cannot keep up

> [!predict] Before you read on
> A mock server takes one request at a time, for about one second each:
> capacity, about 1 request per second. You offer it 1.6 per second for 60 s,
> open-loop. Then you run a closed loop with 2 users against it. What send rate
> will each achieve, and what TTFT will each report?

Before trusting a generator with your server, test it on one whose answer you
know. `slowmock.py` speaks the same streaming format and the same two gauges,
and is slow on purpose:

```python
#!/usr/bin/env python3
# A deliberately slow stand-in for llama-server: one slot, about 1 s per request.
import json, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

slot, lock = threading.Semaphore(1), threading.Lock()
state = {"processing": 0, "deferred": 0}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def do_GET(self):                                   # /metrics, with llama.cpp's names
        text = "".join(f"llamacpp:requests_{k} {v}\n" for k, v in state.items())
        self.send_response(200); self.end_headers(); self.wfile.write(text.encode())

    def do_POST(self):                                  # /completion, "stream": true
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock: state["deferred"] += 1
        with slot:                                      # wait for the only slot
            with lock: state["deferred"] -= 1; state["processing"] += 1
            self.send_response(200); self.end_headers()
            for _ in range(20):                         # 20 tokens, 50 ms apart
                time.sleep(0.05)
                self.wfile.write(b'data: {"content": " tok", "stop": false}\n\n'); self.wfile.flush()
            t = {"prompt_n": len(body["prompt"].split()), "predicted_n": 20}
            self.wfile.write(f'data: {json.dumps({"content": "", "stop": True, "timings": t})}\n\n'.encode())
            with lock: state["processing"] -= 1

ThreadingHTTPServer.request_queue_size = 256            # accept every connection at once
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 9931), Handler).serve_forever()
```

*Runnable — Python 3 standard library only; a mock written for this lab. It stands in for llama-server only in format.*

The closed-loop contrast imports the open-loop request function, so the only
difference is when requests are sent:

```python
#!/usr/bin/env python3
# For contrast only: USERS workers, each sending its next request when the last one ends.
import sys, threading, time
from loadgen import one_request, write_csv

users, seconds, out = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
rows, ids, t0 = [], iter(range(10**9)), time.perf_counter()

def user():
    while time.perf_counter() - t0 < seconds:          # "scheduled" = whenever we get round to it
        one_request(next(ids), time.perf_counter() - t0, t0, rows)

workers = [threading.Thread(target=user) for _ in range(users)]
for w in workers: w.start()
for w in workers: w.join()
write_csv(rows, out)
print(f"{users} users for {seconds:.0f} s: sent {len(rows)} ({len(rows) / seconds:.2f}/s)")
```

*Runnable — Python 3 standard library only; run by the author against the slow mock (output below).*

And a summary script, which you will use for the real sweep too. Its arguments
are the two promises (TTFT p95 in seconds, TPOT p95 in milliseconds), the
warm-up to discard, and the CSV files:

```python
#!/usr/bin/env python3
# Summarise loadgen runs.  usage: report.py TTFT_P95_S TPOT_P95_MS WARMUP_S run-*.csv
import csv, statistics, sys

ttft_slo, tpot_slo, warm = float(sys.argv[1]), float(sys.argv[2]) / 1000, float(sys.argv[3])
p95 = lambda xs: sorted(xs)[int(0.95 * (len(xs) - 1))] if xs else float("nan")
print(f"{'run':<16}{'offered':>8}{'done/s':>8}{'good/s':>8}{'TTFT mean':>10}{'p95':>8}"
      f"{'TPOT p95':>10}{'L=λW':>7}{'L seen':>8}")
for path in sys.argv[4:]:
    rows = list(csv.DictReader(open(path)))
    end = max(float(r["sched"]) for r in rows)            # last arrival: load stops here
    span = end - warm
    done = [r for r in rows if r["last"] and warm <= float(r["last"]) <= end]
    mine = [r for r in rows if float(r["sched"]) >= warm and r["first"] and not r["error"]]
    ttft = [float(r["first"]) - float(r["sched"]) for r in mine]      # from the scheduled time
    tpot = [(float(r["last"]) - float(r["first"])) / max(1, int(r["predicted_n"]) - 1) for r in mine]
    good = sum(a <= ttft_slo and b <= tpot_slo for a, b in zip(ttft, tpot))
    lam = sum(float(r["sched"]) >= warm for r in rows) / span
    w = statistics.mean(float(r["last"]) - float(r["sched"]) for r in mine)
    try:
        g = [float(p) + float(d) for t, p, d in csv.reader(open(path + ".gauges"))
             if warm <= float(t) <= end]
        seen = f"{statistics.mean(g):8.1f}"
    except (OSError, statistics.StatisticsError):
        seen = f"{'-':>8}"
    print(f"{path:<16}{lam:8.2f}{len(done) / span:8.2f}{good / span:8.2f}{statistics.mean(ttft):10.2f}"
          f"{p95(ttft):8.2f}{p95(tpot) * 1000:10.0f}{lam * w:7.1f}{seen}")
```

*Runnable — Python 3 standard library only; run by the author on the slow mock's CSVs (output below) and on a batching mock, never on llama-server data.*

`done/s` counts completions while load was applied; `good/s` counts arrivals
that met both promises; `L=λW` is Little's law computed from the client's
clock, and `L seen` is the mean of the server's two gauges. Stop any
`llama-server`, start `python3 slowmock.py` in one terminal, and in another:

```plaintext
$ python3 loadgen.py 1.6 60 open-1.6.csv
offered 1.6/s for 60 s: sent 96 (1.60/s), worst send lag 5 ms, errors 0, last answer at 103 s
$ python3 closedloop.py 2 60 closed-2.csv
2 users for 60 s: sent 57 (0.95/s)
$ python3 loadgen.py 0.95 60 open-0.95.csv
offered 0.95/s for 60 s: sent 57 (0.95/s), worst send lag 5 ms, errors 0, last answer at 62 s
$ python3 loadgen.py 0.5 60 open-0.5.csv
offered 0.5/s for 60 s: sent 30 (0.50/s), worst send lag 5 ms, errors 0, last answer at 59 s
$ python3 report.py 2 100 10 open-0.5.csv open-0.95.csv open-1.6.csv closed-2.csv
run              offered  done/s  good/s TTFT mean     p95  TPOT p95   L=λW  L seen
open-0.5.csv        0.46    0.46    0.46      0.30    0.92        54    0.6     0.6
open-0.95.csv       0.95    0.93    0.17      4.13    6.43        55    4.9     4.8
open-1.6.csv        1.58    0.94    0.00     27.51   41.34        54   45.2    27.7
closed-2.csv        0.93    0.93    0.93      1.13    1.15        55    2.0       -
```

*Runnable — Python 3 standard library only; output shown is from an actual run of the scripts above against `slowmock.py` (a mock, not llama-server), with promises of 2 s TTFT and 100 ms TPOT and 10 s of warm-up.*

**What just happened:** the open loop at 1.6/s kept its schedule — all 96
requests sent within 5 ms of their times — while the server completed under one
per second. The queue grew for the whole minute: TTFT p95 of tens of seconds,
goodput zero, and the last answer arrived long after the last request. The
closed loop with 2 users reports a healthy server: about 1.1 s TTFT, every
request "good", at 0.93 requests per second. Now read the `open-0.95` row: the
same rate, with arrivals that do not wait for each other, gives a mean TTFT of
about 4 s, a p95 over three times the promise, and a fifth of the goodput. The
closed loop was not measuring the server at 0.93 requests per second. It was
measuring two polite users who never arrive at the same moment.

Little's law says the same. In the two stable open runs, `L=λW` and `L seen`
agree, so the client's clock and the server's gauges tell one story. At 1.6/s
they disagree, because Little's law needs a steady state and an overloaded
queue has none: it only grows.

---

## Stage 3: promises, and a prediction

Give your laptop promises with Halden's proportions. Ask Halden's TTFT promise
is 1.5 s against a ~0.27 s idle prefill, about 5.5×; its TPOT promise is 60 ms
against a ~14 ms decode step, about 4×. Measure your idle numbers with the
generator itself, at a rate low enough that requests never overlap:

```bash
python3 loadgen.py 0.05 120 idle.csv && python3 report.py 99 9999 0 idle.csv
```

*Real format, illustrative values — the scripts above; arguments chosen so that no promise can fail.*

Your promises: **TTFT p95 ≤ 5 × idle TTFT**, **TPOT p95 ≤ 4 × idle TPOT**.

> [!predict] Before you read on
> Each request carries ~300 prompt tokens and generates 128. Using your
> aggregate decode rate at N = 8 (`X₈`) from the previous lab and your prefill
> rate (`R`) from the first, at what arrival rate will the server saturate? At
> half that rate, how many requests will be in the system on average, and will
> any be deferred? Which promise will break first?

```text
   server time per request   ≈   128 ÷ X₈   +   300 ÷ R
   saturation rate   λ_sat   ≈   1 ÷ (server time per request)
   Little's law:   L  =  λ × W,   W  ≈  idle TTFT  +  127 × TPOT at that load
```

The first term is the request's share of eight streams decoding together; the
second is its prefill, during which the GPU does little else. Saturation is
where that demand fills every second. Little's law gives the average number in
the system, slots and queue together: up to 8 it is all in slots, beyond 8 the
rest is deferred. As for which promise breaks first, with `-np 8` no step ever
carries more than eight streams, so TPOT is capped near your N = 8 figure,
stretched by the prefills of new arrivals that share the steps. If 4× idle TPOT
sits above that, TPOT can hardly fail, and overload has only one place to go:
the queue, which TTFT measures. The slot count turns overload into waiting.

---

## Stage 4: the sweep

Start the server as in the previous lab:

```bash
llama-server -hf bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M -c 16384 -np 8 --metrics -ngl all
```

*Real format, illustrative values — flags from the llama.cpp server README at b12608.*

Each slot gets 2,048 tokens, room for the ~300 + 128 of every request. Then
sweep six rates around your prediction, 150 s each, and summarise with your
promises and 30 s of warm-up discarded:

```bash
LSAT=1.2                          # your predicted saturation rate, requests per second
for f in 0.3 0.5 0.7 0.85 1.0 1.2; do
  python3 loadgen.py "$(python3 -c "print(round($LSAT * $f, 3))")" 150 "run-$f.csv"
done
python3 report.py 1.5 120 30 run-*.csv    # your TTFT p95 (s) and TPOT p95 (ms) promises
```

*Real format, illustrative values — the scripts above; `LSAT` and the two promises are placeholders for your own numbers.*

Each run returns only when its last request has answered, so the next rate
starts on an idle server. The warm-up is discarded because the first seconds
of a run start from an empty queue, which flatters every number. Expect the
runs above `LSAT` to take much longer than 150 s: that drain time is the queue.

---

## Stage 5: read the knee

> [!predict] Before you read on
> At 0.85 × your predicted λ_sat, the server keeps up on average. Will TTFT p95
> be close to its idle value? Will the mean? And above λ_sat, will `L=λW` and
> `L seen` still agree?

Read your table from the top. **Below the knee**, `done/s` equals the offered
rate, `good/s` equals both, TTFT p95 stays near its idle value, and `L=λW`
matches `L seen`. Reconcile each L with your Stage 3 prediction. **The knee**
is the highest rate at which `good/s` stays within a few percent of `done/s`.
Above it, goodput peels away from throughput: the server still completes
everything, but late. **Past saturation**, `done/s` stops rising — that plateau
is your measured λ_sat, to set beside the predicted one — while `good/s`
falls toward zero, TTFT grows with the length of the run, and the two Ls part
company.

Expect the knee to sit clearly below λ_sat, and expect the mean TTFT to look
calm well after p95 has broken. Poisson arrivals come in clumps. Near
saturation, most requests still arrive to a free slot and start at once, which
holds the mean down; the few that land in a clump wait for several requests
ahead of them, and p95 is made of exactly those. Queueing delay grows like
`ρ ÷ (1 − ρ)` with utilisation ρ: it doubles from ρ = 0.5 to 0.67, and again
from 0.67 to 0.8, and the tail stretches faster than the mean.

One mismatch to diagnose. If `L seen` stays below `L=λW` while the server is
not yet saturated, requests are waiting somewhere the gauges cannot see — most
likely in the server's HTTP layer, before a request is read and counted as
deferred (`--threads-http` sets that thread pool's size). The client's clock is
then the only honest measure of the queue.

---

## Your results

| Measurement | Predicted | Measured |
|---|---|---|
| Idle TTFT and TPOT (rate 0.05) | — | |
| Promises: TTFT p95 / TPOT p95 | — | — |
| `X₈` (previous lab) and `R` (first lab) | — | |
| Saturation rate λ_sat (the `done/s` plateau) | | |
| L at 0.5 × λ_sat: `L=λW` / `L seen` | | |
| L at 0.85 × λ_sat: `L=λW` / `L seen` | | |
| Knee: highest rate with `good/s` ≈ `done/s` | | |
| At the knee: TTFT mean / TTFT p95 / TPOT p95 | | |
| First promise to break | | |
| Generator's worst send lag at the highest rate | — | |

> [!case] The case: the acceptance test, in miniature
> [Sizing a Deployment](#/sizing-a-deployment) ends in an acceptance test, and
> [Load Testing](#/load-testing) specifies it: an open-loop sweep to 1.5
> requests per second and beyond, with the real 3,000-in, 250-out shape, pass or
> fail on TTFT p95 ≤ 1.5 s and TPOT p95 ≤ 60 ms. Your sweep is that test on a
> laptop. Little's law makes the same check on the node: at 1.5 req/s and
> W ≈ 4.3 s, about 6–7 requests should be in the system on average, read on
> vLLM v0.34 as `vllm:num_requests_running` plus `vllm:num_requests_waiting`.
>
> **The stake:** the 1.5 req/s target is already 2.5× the 0.58 req/s average —
> an assumption about bursts. The sweep turns the knee into a measured number.
> If it falls below 1.5 req/s, the plan fails on the node it was sized for, and
> a closed-loop test would never have said so: 20 virtual users can never put
> more than 20 requests in the node, and pace themselves to it, which is Stage 2's
> polite pair at scale. One more term sits outside your miniature: retrieval.
> The embedding model and reranker add their time to the user's TTFT but not to
> the engine's TTFT metric, so Halden's test either drives the application
> endpoint or, as [Load Testing](#/load-testing) does, holds the engine to what
> retrieval leaves of the 1.5 s.
>
> **What this records:** the acceptance test is open-loop, runs past the knee,
> discards warm-up, measures TTFT from the scheduled arrival, and counts only
> if Little's L from the client matches the engine's gauges below the knee.

## Exercises

<div class="exercise">

**Exercise 1 — quantitative.** On an older laptop, the previous labs gave
`X₈` = 320 tokens/s and a prefill rate of 900 tokens/s; idle TTFT is 0.35 s and
idle TPOT 18 ms. (a) Predict λ_sat for this lab's request shape. (b) At
0.7 × λ_sat, with TPOT about 25 ms, how many requests are in the system on
average, and how many are deferred?

<details>
<summary>Reveal answer</summary>

```text
   (a)  128 ÷ 320 + 300 ÷ 900  =  0.40 + 0.33  =  0.73 s   →   λ_sat ≈ 1.36 req/s
   (b)  λ = 0.7 × 1.36 ≈ 0.95 req/s;   W ≈ 0.35 + 127 × 0.025 ≈ 3.5 s
        L  =  0.95 × 3.5  ≈  3.3 requests, all in slots: none deferred on average
```

"On average" carries weight: Poisson clumps will push the instantaneous count
past 8 now and then, and those moments are your p95.

</details>

</div>

<div class="exercise">

**Exercise 2 — find the flaw.** A colleague reports: "The server sustains
2.4 req/s with TTFT p95 under 1 s. Little's law confirms the test: L is exactly
the number of users at every rate." The table:

```plaintext
run             offered  done/s  good/s TTFT mean     p95  TPOT p95   L=λW  L seen
users-4.csv        0.92    0.92    0.92      0.41    0.48        31    4.0       -
users-8.csv        1.71    1.71    1.71      0.52    0.66        38    8.0       -
users-16.csv       2.41    2.41    2.40      0.66    0.95        52   16.0       -
```

*Real format, illustrative values — output format of `report.py` above; numbers invented for the exercise.*

What kind of test was this, what does each claim actually show, and what would
you run instead?

<details>
<summary>Reveal answer</summary>

A closed loop, run with 4, 8 and 16 users: `offered` always equals `done/s`
because each user sends only when its last answer arrives, and `L=λW` equals
the user count by construction — Little's law holds for any closed system, so
it confirms nothing about the server. "Sustains 2.4 req/s" means 16 users,
waiting politely, got 2.4 req/s. TTFT is measured from each send, after the
user's own wait, so queueing is invisible. Real users would arrive
independently; at 2.4 req/s offered open-loop, clumps would queue behind the
eight slots and p95 would be far higher. There is no gauge column either, so
nothing checked the server's own view. Run `loadgen.py` at rates around 2.4.

</details>

</div>

<div class="exercise">

**Exercise 3 — transfer.** On Halden's node, the plan puts W ≈ 4.3 s at the
1.5 req/s peak. (a) What should `vllm:num_requests_running` +
`vllm:num_requests_waiting` average at that rate? (b) A vendor's benchmark ran a
closed loop with 20 users on the same node and reported its rate. Assuming the
same W, what rate did it offer, and why can that test not tell Halden where the
knee is?

<details>
<summary>Reveal answer</summary>

(a) L = 1.5 × 4.3 ≈ 6.5 requests on average, the case's "6–7"; the plan's 20
is headroom for bursts, not the mean. (b) A closed loop offers N ÷ W =
20 ÷ 4.3 ≈ 4.7 req/s while W holds; as the node slows, W grows and the offered
rate falls with it, so the test settles wherever the server is comfortable. It
can never hold more than 20 requests in the system or offer load the server has
not first absorbed, so it cannot show the queue that defines the knee.

</details>

</div>

## What to remember

- An open-loop generator fixes its schedule in advance and never waits for an
  answer; measure TTFT from the scheduled time, so a late generator cannot hide
  a slow server.
- A closed loop paces itself to the server and reports a healthy system at any
  load; Little's law holds for it by construction and proves nothing.
- Predict saturation as `1 ÷ (out ÷ X₈ + in ÷ R)`, and the number in the system
  as `λ × W`; below saturation, check L against processing + deferred.
- The knee is where goodput peels away from throughput, and it sits below
  saturation. Past saturation there is no steady state: p95 grows with the
  length of the test.
- The mean stays calm while p95 breaks, because queueing delay concentrates in
  the clumps of a random arrival stream. Promise percentiles, not means.

```quiz
[
  {
    "q": "A sweep row reads: offered 2.0, done/s 1.4, good/s 0.1, TTFT mean 18 s, p95 41 s. What does it show?",
    "choices": [
      "The server's capacity is about 2.0 req/s, and the TTFT promise is set too tight",
      "The warm-up was too short, so the queue had not yet filled when it was measured",
      "Past saturation: capacity is about 1.4 req/s, and the queue grew all run",
      "The generator fell behind, so only 1.4 of 2.0 requests per second were sent"
    ],
    "answer": 2,
    "explain": "Completions stopped at 1.4/s while 2.0/s arrived, so 0.6 req/s piled up for the whole run: TTFT of tens of seconds, near-zero goodput, and numbers that depend on how long the test ran. The generator's own send lag would reveal a slow client; done/s is the server's plateau, its measured capacity."
  },
  {
    "q": "During a stable open-loop run at 0.6 req/s, the gauges average requests_processing 6.2 and requests_deferred 3.4. About how long does a request spend in the system?",
    "choices": [
      "About 16 s: L ≈ 9.6 divided by λ = 0.6",
      "About 10 s: the processing gauge ÷ λ",
      "About 5.7 s: 3.4 ÷ 0.6, the time spent queued",
      "About 5.8 s: 9.6 × 0.6"
    ],
    "answer": 0,
    "explain": "Little's law, W = L ÷ λ, with L counting everything in the system: slots and queue, 9.6 ÷ 0.6 = 16 s. Leaving out the deferred requests drops their waiting time; multiplying instead of dividing has the units wrong."
  },
  {
    "q": "At 85% of the measured saturation rate, mean TTFT is 0.7 s against an idle 0.4 s, but p95 is 4.9 s. What is the best explanation?",
    "choices": [
      "The p95 is measurement noise, since the mean is the stable statistic",
      "A few requests hit a slow kernel path that the others avoided",
      "TPOT has broken, and slow decoding is delaying the first token",
      "Random arrivals clump; most start at once, the clumped few queue"
    ],
    "answer": 3,
    "explain": "Near saturation, queueing delay is concentrated: most arrivals find a free slot and see near-idle TTFT, while those landing in a clump wait behind several requests. The mean blends them; p95 is the clumps. That is why promises are set on percentiles."
  },
  {
    "q": "loadgen.py prints 'worst send lag 2400 ms' at the highest rate of a sweep. What follows for that row of the report?",
    "choices": [
      "Nothing: send lag is a client detail, and the server's numbers are unaffected",
      "TTFT is charged with the client's lateness; rerun from a faster machine",
      "The open loop has turned into a closed loop, so Little's law no longer applies",
      "The server rejected requests for 2.4 s, so the errors column should be checked"
    ],
    "answer": 1,
    "explain": "TTFT is measured from the scheduled time, so a generator that sent 2.4 s late charges that lateness to the server: the row overstates latency (better than hiding it, which a closed loop would). The generator is still not waiting for answers; its own machine could not keep up. Rerun with a faster client, or split the load across two."
  },
  {
    "q": "You move the lab's method to a vLLM v0.34 server. Which pair of gauges plays the role of requests_processing + requests_deferred in the Little's-law check?",
    "choices": [
      "vllm:kv_cache_usage_perc and vllm:num_preemptions",
      "vllm:prompt_tokens and vllm:generation_tokens",
      "vllm:num_requests_running and vllm:num_requests_waiting",
      "vllm:request_success and vllm:e2e_request_latency_seconds"
    ],
    "answer": 2,
    "explain": "Running requests are those scheduled in the engine's batch; waiting requests are queued for admission. Their sum is the number in the system that Little's law predicts as λ × W. KV usage and preemptions describe memory pressure; token and success counters are rates, not occupancy."
  }
]
```
