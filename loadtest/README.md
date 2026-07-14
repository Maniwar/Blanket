# Load testing — pinning the capacity ladder with real numbers

[`docs/scaling-scorecard.svg`](../docs/scaling-scorecard.svg) ranks the scaling
work but marks its capacity bands **order-of-magnitude, architecture-limited —
not load-tested**. This harness replaces those estimates with measured numbers:
run it against a **staging** project, climb the tiers, and record where p95
latency or errors break.

> **Safety first.** Never run this against production or any project with real
> customers. Use a throwaway Supabase project (a free tier is fine for the read
> scenario). The tool is [k6](https://k6.io) — a single static binary, no repo
> dependency.

## What it exercises

| Scenario | What it hits | Cost | Default |
| --- | --- | --- | --- |
| **`read`** | the public GET reads — `?config` `?site` `?tools` `?defaults` `?starters` | none — no LLM, no writes | ✅ yes |
| **`chat`** | the real chat POST (LLM round-trip) | **spends Anthropic tokens**; hits the shared 20/10-min rate limit | opt-in |

The `read` scenario is the one that answers "how far does the edge-function +
Postgres read path go" — exactly the axis the scaling review is about — without
burning tokens. The `chat` scenario is there to *watch blocker #1 work*: under
load it returns `429`s from the shared `rate_hit()` limiter, which the script
treats as expected, not as failures.

## Prerequisites

1. Install k6: `brew install k6` (macOS) · `choco install k6` (Windows) ·
   [other platforms](https://grafana.com/docs/k6/latest/set-up/install-k6/).
2. Get two values from your **staging** project (Supabase → Project Settings):
   - `BASE_URL` — the concierge function URL, e.g.
     `https://<ref>.functions.supabase.co/concierge`
     (the same string the site sets as `FEIER_CONCIERGE_CONFIG.endpoint`).
   - `ANON_KEY` — the project's **publishable / anon** key (never the service-role key).

## Run it

Default read ramp (steady → high → spike, ~4½ min):

```sh
BASE_URL="https://<ref>.functions.supabase.co/concierge" \
ANON_KEY="<publishable-anon-key>" \
k6 run loadtest/k6-concierge.js
```

Tune the tiers to find the knee (climb until the thresholds fail):

```sh
STEADY_VUS=100 HIGH_VUS=600 SPIKE_VUS=1500 HOLD=2m \
BASE_URL=... ANON_KEY=... k6 run loadtest/k6-concierge.js
```

The opt-in chat path (small, staging only — spends tokens):

```sh
SCENARIO=chat CHAT_VUS=5 CHAT_DURATION=1m \
BASE_URL=... ANON_KEY=... k6 run loadtest/k6-concierge.js
```

## Reading the result

k6 prints per-tag summaries. The numbers that matter:

- **`http_req_duration{kind:read}` p95 / p99** — response latency of the read
  path. The default thresholds are p95 < 800 ms, p99 < 1.5 s.
- **`http_req_failed` / `errors` rate** — should stay < 1%.
- **`http_reqs` rate** — throughput (requests/s) sustained at each tier.

Map it back to the ladder: the VU tier where p95 or error rate first breaks the
threshold **is** the reliable ceiling for the read path on this plan. If it never
breaks at `SPIKE`, raise the `*_VUS` and run again — you haven't found the knee
yet. When the limiter (chat scenario) or Supabase connection pool starts
returning 429/`503`s well before latency degrades, that points at items **#1**
(rate limit) or **#5/#8** (pooler / plan limits) as the true constraint, not the
code shape.

## What this does *not* tell you

- **Postgres write ceiling** (blocker #2) — this harness deliberately doesn't
  write. To test the write path you'd exercise the commission/inquiry flow and
  watch table growth + autovacuum; do that only on a disposable project.
- **Real cost at scale** (#8) — token spend is an Anthropic-side measurement;
  estimate it from your cache-hit rate, not from k6.

Record the measured knee back into `SCALING.md` / the scorecard so the bands stop
being estimates.
