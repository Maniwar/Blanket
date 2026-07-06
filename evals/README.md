# Behavior evals

Automated tests for the **concierge's behavior** — the non-deterministic stuff you
can't unit-test: does it show the commission button on a buying signal, avoid the
`[HOLD]` leak, stop looping in discovery, call `get_my_orders` instead of guessing,
and so on. These replay scripted conversations against the **deployed** function and
report a pass rate.

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

## Files
- `scenarios.mjs` — the behavior deck
- `run.mjs` — replay + report (and `--selftest`)
- `judge.mjs` — the pinned binary LLM judge
