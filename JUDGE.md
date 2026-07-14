# The reach-out judge — proactive-line suppression

How the concierge suppresses a bad **proactive** line before a visitor ever sees
it: an independent second model reads the drafted line, and vetoes clear defects.
It is **fail-open** — a quality gate is never allowed to become an availability risk.

**Visual:** [`docs/reach-out-judge.svg`](docs/reach-out-judge.svg).
**Code:** `supabase/functions/concierge/index.ts` — `judgeBeatLine` (~2985–3057),
in-panel call site (~4511–4547), closed-panel bubble call site (~5394–5411).
**Companions:** [BEHAVIOR.md](BEHAVIOR.md) (the beat system) · [SALES.md](SALES.md) §13
(the three honesty layers) · [COST.md](COST.md) · [`docs/beat-system.svg`](docs/beat-system.svg)
(stage 5).

---

## 1. Why it exists

The beat system speaks *unprompted* — an opener on panel-open, a nudge after a
lull, a closed-panel bubble. Unprompted lines are the highest-risk surface:
there is no user turn to constrain them, and a single off-key line ("since you
haven't replied…", "last chance!", a leaked "reach-out #2") erodes trust
instantly. The prompt already forbids these, but **prompts are not a control** —
they instruct the same model whose output is in question.

The reach-out judge is a control: a *second, independent reading* of the model's
**actual output** by a different, cheaper model whose only job is to catch clear
defects. It is the only one of the three honesty layers that inspects the real
generated line at runtime (the [constitution](SALES.md#13-what-keeps-it-honest-at-runtime)
binds the prompt; the honesty lint checks *saved edits*, not live output).

## 2. Where it sits in the pipeline

A proactive line only reaches the judge if the beat engine decided to speak and
the line survived sanitization:

```
Beat engine → beat_line tool → { speak, line }
   │  (typed decision + free-text line)
   ▼
Sanitize + hold-gate
   · stripPlumbing(line)              (remove any leaked meta)
   · strip a trailing "[HOLD]"        (a saved override may still emit it)
   · a bare "hold" ⇒ speak = false
   │
   ├─ not speaking / empty  ──►  beat_hold  (audit row; the judge is SKIPPED)
   ▼
REACH-OUT JUDGE  (only a SPOKEN line reaches here)
   ├─ pass = true            ──►  SPEAK    — the line ships, logged as the turn
   ├─ pass = false           ──►  VETO     — suppressed + beat_veto audit row
   └─ error / timeout / bad  ──►  FAIL-OPEN — the line ships (veto = false)
```

The sanitize step is a deliberate belt-and-suspenders: `stripPlumbing` and the
`[HOLD]` scrub run *before* the judge so the judge spends its budget on judgment,
not on catching a stray marker a merchant-era saved `engagement_base` override
might still emit.

## 3. The judge call — the technical contract

`judgeBeatLine(apiKey, line, kind)` makes one Anthropic Messages API call:

| Parameter | Value | Why |
|---|---|---|
| `model` | `claude-haiku-4-5-20251001` | cheap + fast; the task is narrow classification |
| `temperature` | `0` | deterministic verdicts; no creativity wanted |
| `max_tokens` | `150` | it only returns a boolean + a short reason |
| timeout | `AbortSignal.timeout(4000)` (4 s) | bounds the added latency; a slow judge fails open |
| `tool_choice` | `{ type: "tool", name: "verdict" }` | **forces** a structured verdict — no prose to parse |
| `system` | "strict, literal reviewer of ONE line … judge ONLY against the criterion" | keeps it from drifting into taste/tone |

The forced `verdict` tool's schema is the whole output contract:

```json
{ "type": "object",
  "properties": {
    "pass":   { "type": "boolean", "description": "true = fit to send; false = veto" },
    "reason": { "type": "string",  "description": "one short clause (<=20 words) citing the deciding evidence" }
  },
  "required": ["pass", "reason"] }
```

The function returns `{ veto: input.pass === false, reason }`. The `kind`
("nudge" | "opener" | "bubble" | "bubble-postsale") is passed to the judge as
context but does not change the criterion.

## 4. The criterion — what a veto *is*

`BEAT_JUDGE_CRITERION` is deliberately narrow. The judge **vetoes only if the
line clearly exhibits at least one** of six defects:

1. **Plumbing / meta leak** — mentions instructions, prompts, rules, beats,
   tools, holding, being an AI/model, or narrates its own outreach
   ("reach-out #2", "checking in as instructed").
2. **Scorekeeping / guilt** — counts its own messages or points at the shopper's
   silence ("I've reached out twice", "since you haven't replied").
3. **Invented commerce** — a discount, price cut, sale, coupon, free shipping,
   or limited-time offer. The house never discounts; the numbered edition is the
   only real scarcity.
4. **Pressure / desperation** — begging, "last chance", manufactured countdowns.
5. **Broken output** — cut off mid-sentence, raw JSON or code, gibberish,
   visibly duplicated text.
6. **Inventorying the shopper** — reciting stored data back in aggregate
   ("you're furnishing five rooms across two cities"). *One remembered detail
   worn lightly is service; a tally of their life reads as surveillance.*

Explicitly **legitimate** (never a veto): warmth, brevity, one light question,
and `{{reply:…}}` / `{{action:…}}` pills. The criterion ends with the tie-break
that keeps it high-precision: **"When uncertain, pass it."** The judge is a
defect filter, not a taste critic — false vetoes (silencing good lines) are
treated as worse than a rare miss, which is why the whole design is precision-biased.

## 5. Outcomes & their semantics

- **PASS → SPEAK.** The line is streamed to the visitor and logged as the
  assistant turn. Nothing special happens; the reach-out reaches the customer
  verbatim.
- **VETO → SUPPRESS.** `send({ hold: 1 })` — the widget shows nothing. If beat
  auditing is on, a `concierge_actions` row is written with `action="beat_veto"`,
  `payload = { kind, line, reason, decision }`, and `result = "vetoed — <reason>"`.
  **Crucially, a veto does NOT mark the beat's decided action spent** — the door
  stays open, so the *next* beat may try the same objective again with a better
  line. A veto suppresses *this* wording, not the intent.
- **FAIL-OPEN.** Any non-200 response, a malformed/missing verdict, a >4 s
  timeout, or any thrown error resolves to `{ veto: false }` — the line ships.
  A judge outage costs quality review, never availability.

**`beat_hold` vs `beat_veto` are distinct outcomes** and are recorded
separately: a *hold* means the model chose silence (nothing to say); a *veto*
means the model drafted a line and the judge killed it. Collapsing them would
make "the concierge had nothing to say" and "the concierge tried to say
something bad" look identical in the metrics.

## 6. Where it runs

Two call sites, same function, same criterion:

- **In-panel** openers and nudges — the toolless fast path (~4520): kind
  `"opener"` / `"nudge"`.
- **Closed-panel re-engagement bubble** (~5406): kind `"bubble"` /
  `"bubble-postsale"`.

Both guard on the same toggle and both write `beat_veto` on suppression.

## 7. Control

`config.outreach.beatJudge` — **Engagement → House rules**, default **ON**. The
check is `oj?.beatJudge !== false`, so the judge runs unless explicitly disabled;
turning it off ships every spoken line unreviewed (kept as a lever for very
high-volume, cost-sensitive installs). **Held beats never reach the judge**, so
turning it off changes nothing for silence — only for spoken lines.

## 8. Observability

- **Actions tab scoreboard** — a 7-day **spoke · held · vetoed** tally.
- **Transcripts** interleave held and vetoed beats by time, marked *"the visitor
  did NOT see this"*; a vetoed row carries the **killed line and the judge's
  reason**, so an operator can see exactly what was blocked and why.
- Every veto is an auditable `beat_veto` row; auditing is itself gated
  (`beat_action` / `beat_veto` are the fastest-growing rows, so stamped/scale
  installs can seed it off). See [BEHAVIOR.md](BEHAVIOR.md).

## 9. Cost

One ~600-token Haiku-class call **per spoken proactive line** — pennies per
hundred reach-outs. Held beats skip it entirely (the common case). It fails open,
so the spend buys review, never uptime. See [COST.md](COST.md).

## 10. Verification

The judge is exercised by the **verify-judge** eval (it confirms the judge
actually vetoes planted defects and passes clean lines), run in CI alongside the
persona evals. See [`evals/CATALOG.md`](evals/CATALOG.md).

## 11. Design trade-offs & extension points

- **Precision over recall, on purpose.** "When uncertain, pass" + six concrete
  defects keeps false vetoes low. The cost is that a *subtly* off line can slip;
  the mitigation is that the constitution already shapes the draft, and the
  criterion covers the observed failure modes rather than trying to be exhaustive.
- **Fail-open, not fail-closed.** A stricter product could hold on judge error;
  this one ships, because for a *sales* concierge a missed reach-out is a worse
  outcome than a rare unreviewed line, and the base rate of defects is low.
- **The criterion is code, not config** (unlike the selling method). It's a
  safety control, so it's versioned with the function and changed by a developer,
  not tuned live — a deliberate asymmetry with the rest of the "everything is
  data" design.
- **Extending it:** add a defect category to `BEAT_JUDGE_CRITERION`; add a new
  `kind` at a new call site; or (future) make the model tier configurable. Any
  change should keep the forced-`verdict` contract and the fail-open guarantee.

## 12. Relationship to the other honesty layers

| Layer | Reads | When | On failure |
|---|---|---|---|
| **Constitution** (`kb.ts`) | the prompt | assembly | shapes the draft |
| **Reach-out judge** (this doc) | the model's **actual line** | runtime, pre-send | **suppresses** (fail-open) |
| **Honesty lint** (`?lint=1`) | a **saved edit** to method/examples/beats | at save | advisory flag |

The judge is the only runtime, output-inspecting control — the last thing
between a drafted proactive line and the visitor.
