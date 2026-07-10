# Behavior evals

Automated tests for the **concierge's behavior** — the non-deterministic stuff you
can't unit-test: does it show the commission button on a buying signal, avoid the
`[HOLD]` leak, stop looping in discovery, call `get_my_orders` instead of guessing,
and so on. These replay scripted conversations against the **deployed** function and
report a pass rate.

**Visual map:** [`docs/testing-flows.svg`](../docs/testing-flows.svg) diagrams all
four layers (behavior deck, config conformance, persona evals, runtime reach-out
judge) end-to-end — what each one boots, what it checks, and the exact artifact
each verdict lands in.

**Every test case, enumerated:** [`CATALOG.md`](CATALOG.md) lists all cases
across all four layers — each scenario's setup, its checks verbatim, the
failure it was designed against, the sales-psychology coverage map (technique →
test, with the known gaps named), and the checklist for designing a new case.

## Why it's built this way

LLM output isn't deterministic, so the design follows current LLM-as-judge practice:

- **Deterministic checks first.** Most behaviors are checkable mechanically — a
  reply *contains* `{{action:commission}}`, *never contains* `[HOLD]`, asks *at most
  one* question, or triggered the "Reading the register…" status frame (which proves
  a tool ran). Cheap, stable, and they pinpoint the regression.
- **LLM judge only for the fuzzy ones**, and always as **one concrete, binary
  (yes/no) criterion** — binary is far more self-consistent than a 1–10 score, and a
  specific criterion blunts the judge's verbosity/positional bias. The judge is
  pinned (temperature 0, fixed contract) and told to ignore tone/length.
- **Repeat N times, report a pass *rate*** (e.g. 9/10). One green run doesn't prove
  an LLM won't flake; the rate does. A check below `EVAL_THRESHOLD` fails the run.

Grounding: rubric/binary judging, repetition, and mechanical bias-mitigation are the
recurring recommendations in the 2025–26 LLM-as-judge literature (analytic binary
rubrics, pass-rate aggregation, pinned judge contracts).

## Run it

```bash
# point at your deployed concierge function
export EVAL_ENDPOINT="https://<project-ref>.supabase.co/functions/v1/concierge"

# optional: enables the { judge: ... } checks (uses a cheap Haiku call each)
export ANTHROPIC_API_KEY="sk-ant-…"

# optional: a magic-link access token for a TEST account → runs signed-in scenarios
export EVAL_TOKEN="eyJ…"

node evals/run.mjs                 # all scenarios, 5 reps each
node evals/run.mjs --filter hold   # only scenarios whose name matches
node evals/run.mjs --reps 10       # more reps = tighter signal, more tokens
node evals/run.mjs --selftest      # offline: prove the SSE parser + checks (no network)
```

Exit code is `0` if every check meets the threshold, `1` otherwise — so it drops
straight into CI.

## Run it from the admin panel

The same deck lives in the **`concierge_evals`** table and is editable + runnable
in the studio's **Evals** tab — no CLI needed. Add or edit a scenario, build its
turns and typed checks, hit **Run enabled scenarios**, and each reply, the status
frames, and the pass-rate per behavior render inline (expandable to the full
transcript and the judge's reason). The browser replays scenarios against the
live function; the LLM judge runs server-side behind an **admin-gated
`POST ?judge=1`** endpoint (the Anthropic key never reaches the browser).
Signed-in scenarios use the admin's own session, so they read a real register.

To keep one source of truth, the CLI can pull that DB deck instead of the local
`scenarios.mjs`:

```bash
export EVAL_TOKEN="eyJ…"          # a test-ADMIN access token (see below)
node evals/run.mjs --remote       # fetch the deck from ?evals=1, then run it
```

### Env vars
| var | default | meaning |
| --- | --- | --- |
| `EVAL_ENDPOINT` | — (required) | the concierge function URL |
| `EVAL_TOKEN` | — | test-account access token; signed-in scenarios skip without it |
| `EVAL_REPS` | 5 | repetitions per scenario |
| `EVAL_THRESHOLD` | 0.8 | a check below this pass rate fails the run |
| `ANTHROPIC_API_KEY` | — | enables judge checks (skipped if absent) |
| `EVAL_JUDGE_MODEL` | `claude-haiku-4-5-20251001` | judge model; rotate to sanity-check a verdict |

### Getting `EVAL_TOKEN`
Sign into the storefront as a test account, open the browser console, and run:
```js
(await window.__cxSb?.auth?.getSession?.())?.data?.session?.access_token
```
…or grab it from the Supabase session in devtools → Application → Local Storage
(`sb-…-auth-token`). Tokens are short-lived; refresh before a run.

## Add a scenario
Edit [`scenarios.mjs`](scenarios.mjs). A scenario is `{ name, signedIn, context,
turns }`; each turn has a `user` line and optional `checks`. Check kinds:

| check | passes when |
| --- | --- |
| `{ includes: "x" }` / `{ excludes: "x" }` | reply does / doesn't contain `x` |
| `{ regex: "…" }` / `{ notRegex: "…" }` | reply does / doesn't match |
| `{ maxQuestions: n }` | reply has ≤ n `?` (anti-interrogation) |
| `{ toolCalled: "label" }` | a status frame contained `label` (a tool ran) |
| `{ judge: "criterion" }` | the LLM judge answers yes to the binary criterion |

Keep judge criteria **concrete and binary**. Prefer a deterministic check whenever
the behavior is mechanically observable — reserve the judge for genuine judgment.

Proactive-beat turns: `{ beat: { seconds, count }, checks }` POSTs the
conversation with `context.nudge` — exactly what the widget sends when a
follow-up fires — and `{ held: true|false }` asserts the beat stayed silent /
spoke. Seed the conversation first with `{ user: "...", seed: true }` and
`{ assistant: "..." }` turns (added to the transcript, not sent).

## Config conformance (the "did my settings take effect?" report)
The behavior deck tests what the concierge *says*; **`conformance.mjs`** tests
that the admin's knobs are *connected*. It reads the live `?config=1` payload,
boots the real widget headless against production under a metrics-excluded
`qa-` session key, and checks parameter by parameter that the widget's
effective values (`status()`) and observed timings (opener delay, first
follow-up) match what was configured — dial scaling included. Run it from
**Actions → Config Conformance** after changing Engagement settings (it also
runs weekly); the PASS/FAIL table lands in the job summary and as an artifact.
A FAIL row names the configured value and what the live widget actually ran —
paste the table back to the assistant to diagnose.

## Persona evals (the "live back-and-forth" check)
Scripted turns can't catch failures that only emerge over a real conversation
— interrogation loops, spec-dumping before discovery, pressure creep. So
**`persona.mjs`** has a cheap model PLAY a shopper (a hesitant comparer, a
hurried gift buyer, a happy post-purchase browser) against the deployed
function for a few turns, then grades the whole conversation: mechanical
checks (question density, no plumbing leaks, reply length) plus a binary
conversation-level judge per criterion. **Advisory by design** — two models
improvising means red rows are leads to read (the failing transcript prints
inline), never a gate; the exit code is always 0. Run from **Actions →
Persona Evals** (also weekly), or locally:

```bash
EVAL_ENDPOINT=... ANTHROPIC_API_KEY=... node evals/persona.mjs
node evals/persona.mjs --filter gift    # one persona
```

It lives outside the deploy gauntlet on purpose: its chat turns would eat the
anonymous rate budget the live smoke + behavior deck already share.

## Auditable outputs — where the evidence lives

Every layer is designed to leave a table you can read after the fact — and paste
back to the assistant for diagnosis. This is where each verdict lands:

| suite | auditable output | where to find it |
| --- | --- | --- |
| Unit tests (`beats_test.ts`) | 17 deterministic assertions, red/green | **Deploy Concierge** run → *Beat engine unit tests* step |
| Live smoke | request/response of a real chat turn against the deployed function | **Deploy Concierge** run → *Live smoke* step |
| Behavior deck | pass **rate** per check (e.g. `9/10`) with the judge's reason on misses | **Deploy Concierge** run → job summary table; same deck runnable in the admin **Evals** tab with inline transcripts |
| Beat trend | 7-day spoke/held counts, drift vs the prior week | **Deploy Concierge** run → *Beat trend* step |
| Config conformance | per-parameter PASS/FAIL rows, each tagged with its evidence **method** — *observed live*, *effective value*, or *skipped (reason named)* — plus a summary header counting each | **Config Conformance** run → job summary + `conformance-report.md` artifact |
| Persona evals | per-persona check table; a failing conversation's full transcript prints inline | **Persona Evals** run → job summary |
| Runtime reach-out judge | every proactive line's fate: `beat_action` (spoke), `beat_hold` (arithmetic held it), `beat_veto` (judge killed it, with the line + reason) | `concierge_actions` table; admin **Actions** tab shows the 7-day *spoke · held · vetoed* strip, click a segment to filter rows |
| Live widget diagnostics | `FeierabendConcierge.status()` — armed follow-up (`nudgeArmedWhy` shows the full arithmetic: rung base × dial × spacious, floor, quick override), recent skips with reasons, re-engage state, hold budget | browser console on the storefront |

Two conventions keep the evidence honest: all QA traffic runs under `qa-*`
session keys that the metrics views exclude (test runs never inflate the
dashboard), and a FAIL row always names **both** numbers — what was configured
and what the live system actually did — so a red row is a diagnosis, not just
an alarm.

## Files
- `CATALOG.md` — every test case: setup, checks, design rationale, coverage map
- `scenarios.mjs` — the behavior deck
- `run.mjs` — replay + report (and `--selftest`)
- `judge.mjs` — the pinned binary LLM judge
- `conformance.mjs` — configured ↔ live parameter conformance report
- `persona.mjs` — advisory persona-simulated multi-turn conversations
