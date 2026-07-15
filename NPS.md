# NPS — closed-loop feedback for the concierge

How the concierge captures a **Net Promoter Score** at the end of a session,
turns the reason into structured, **detractor-aware** categories, and feeds that
history back into how it talks to each customer — the same closed-loop pattern
as the [sales coach](COACH.md) and the [reach-out judge](JUDGE.md), pointed at
satisfaction instead of reply-rate.

**Design stance:** the survey is a **beat** (fire once, at a natural close,
gated), the score is **standard NPS math**, and the closed loop **reuses the
machinery already in production** — the coach brief, the judge's honesty gate,
and the `concierge_insights`-style cached digest. New surface area is small.

![NPS — the survey beat, the score math, and the closed loop](docs/nps-loop.svg)

**Code:** `supabase/functions/concierge/beats.ts` — `npsSegment`, `npsScore`,
`npsTriggerGate`, `detractorThemes`, `renderCustomerNps` (all pure, unit-tested
in `beats_test.ts`). Schema + the aggregate calculation: `supabase/setup.sql`
(`nps_responses`, `nps_categories`, `nps_metrics()`).
**Companions:** [COACH.md](COACH.md) (the loop this reuses) · [JUDGE.md](JUDGE.md)
(the never-quote-a-score guard) · [BEHAVIOR.md](BEHAVIOR.md) (the beat system) ·
[SCHEMA.md](supabase/SCHEMA.md).

> **Status: LIVE end-to-end.** The `REQUEST_NPS` beat fires through the tested
> gate — and the **wrap-up itself asks** (the "That's all" chip / a typed
> farewell), the widget renders the 0–10 scale, score + reason capture and the
> LLM categorizer run server-side, the customer's history grounds the coach
> (judge-guarded), and the admin studio carries the config block, a dedicated
> **NPS tab** (funnel, charts, categories, analyst report), the patron badge,
> and the transcript badge. Default ON
> (`outreach.nps.enabled !== false`); turn it off in Engagement → House rules.

---

## 1. The survey trigger — it's a beat

An NPS prompt is a proactive line, so it is a **beat**, gated by the same
discipline as every other (BEHAVIOR.md): fire **once**, only at a **natural
close**, only for a session **worth rating**, never inside a **cooldown**. The
gate is a pure function, `npsTriggerGate`, so it's testable and auditable:

```
npsTriggerGate({ enabled, concluded, alreadySurveyedSession,
                 sessionDurationMs, minDurationMs,
                 lastSurveyedAtMs, cooldownMs, nowMs }) → { ask, reason }
```

It answers **yes** only when all hold:

- **enabled** — `outreach.nps.enabled` (absent = **ON**, the house pattern; Engagement → House rules).
- **concluded** — a natural end was reached: an order placed, a goal met, the
  wrap-up/leave signal (`?wrapup` / `pagehide`), or the visitor's "that's all for
  now". Never mid-conversation.
- **not already offered this session** — the "offer once" ledger, exactly like
  the beat engine's spent-action logic; a submitted row or a recorded offer
  closes the door for the session.
- **long enough** — `sessionDurationMs ≥ outreach.nps.minDurationMs`; a
  five-second bounce isn't worth a survey.
- **past the cooldown** — `now − lastSurveyedAtMs ≥ outreach.nps.cooldownMs`;
  the same customer isn't re-surveyed too soon (over-prompting *lowers* both
  response rate and trust). Anonymous sessions have no identity to look up, so
  the cooldown is skipped for them — the once-per-conversation rule still binds.

**Config (`outreach.nps`, Engagement → House rules), with the built-in
defaults** (`npsConfigFrom` in `index.ts`): `enabled` — absent = **ON** ·
`minMinutes` — default **3** · `cooldownDays` — default **30** · `reviseDays`
(the rating change window) — default **3**, 0 = ratings are final · `question` —
default *"Before you go — how likely are you to recommend us to a friend, 0 to
10?"* (capped at 300 chars). Testing tip: a quick test session is usually
shorter than 3 minutes — set `minMinutes` to 0 first.

Every decision returns a `reason`, so a held survey is as diagnosable as a held
beat. When it fires, the concierge's **invitation line still passes the
[reach-out judge](JUDGE.md)** — so an NPS ask can never come across as pushy or
guilt-tripping.

## 2. The survey flow (chat-native)

The prompt is part of the conversation, not a modal:

1. The beat speaks one warm line ending with the **`{{nps}}` token**, which the
   widget renders as a tappable **0–10 scale row** (the pill mechanism).
2. A tap sends a visible turn ("8/10") carrying `context.nps = {score}` — the
   server records the `nps_responses` row **deterministically** (never
   model-dependent), once per conversation, and a private system note has the
   concierge thank them and ask the follow-up: *"what made you give that score?"*
3. The next real message carries `context.nps_reason = 1`; the server attaches
   it as `reason_text` on the open row — only within **15 minutes** of the
   score, so an unrelated later message is never misattached — and fires the
   **async categorizer**.
4. The concierge receives it graciously (problem → acknowledged and addressed
   forward; praise → light thanks) and never mentions scores again. **Skip** is
   simply not answering — the gate never re-asks this session.

It is fast, mobile-native, and accessible because it *is* the chat — the same
components the widget already renders.

## 3. The calculation — standard NPS

Two pure functions pin the math (and `nps_metrics()` mirrors them in SQL for the
dashboards, so the number is identical wherever it's shown):

- **`npsSegment(score)`** — 9–10 **promoter**, 7–8 **passive**, 0–6
  **detractor**. In the schema this is a **generated column**, never stored loose.
- **`npsScore(scores)`** — `%promoters − %detractors`, on a **−100…100** scale,
  rounded. **Passives count in the denominator but never the numerator** — that
  is the whole point of the metric. It returns **null** for an empty set: no
  responses is *not* a score of zero, and that difference has to stay visible.

| input | promoters | detractors | NPS |
|---|---|---|---|
| `[10,10,9,7,0]` | 3 | 1 | **40** |
| `[9,9,9,9]` | 4 | 0 | **100** |
| `[0,1,2]` | 0 | 3 | **−100** |
| `[7,8,7]` | 0 | 0 | **0** (not null — there are responses) |
| `[]` | — | — | **null** |

## 4. Detractor reasons — the actionable half

A score is a thermometer; the **reason** is the lever. On submission an LLM
classifies `reason_text` into one or more **admin-managed categories**
(`nps_categories` — `slug, label, prompt_hint, detractor_focus, enabled`), using
the same forced-tool structured-output pattern as the judge and the goal grader.
Both the raw text and the assigned categories are stored, and an operator can
**re-categorise** on the dashboard (logged, `category_source='human'`).

The vocabulary is **detractor-forward** by design — its seed leads with the
themes that explain *why* someone is unhappy and are the most fixable:
`scheduling`, `communication`, `value`, `expectations`, `outcome`, `guidance`
(all `detractor_focus`), plus `experience`, `product`, `praise`, `other`.

`detractorThemes(history)` tallies the categories behind **sub-promoter** scores
(detractors **and** passives), most frequent first — promoter mentions are
excluded so praise never dilutes the concerns. `nps_metrics()` exposes the same
split at the aggregate level (`themes` + a separate `detractor_themes`), which is
what powers "3 customers cited *scheduling* this week."

## 5. The closed loop — and the honesty guard

This is where NPS stops being a report and starts changing behaviour, and it is
**the coach loop reused**:

- **Per customer.** `renderCustomerNps(history)` builds a private brief — current
  segment, trend, the recurring concerns, and a **forward-looking play**
  (*rebuild trust* for a detractor, *nudge one improvement* for a passive,
  *invite a referral* for a promoter). It is fed to the [sales coach](COACH.md)
  the same way the reply-rate digest is, so the concierge's next proactive line
  is shaped by this customer's real feedback. Empty on thin history (the
  `renderLearningDigest` honesty floor — no invented pattern for a customer with
  one rating).
- **In aggregate.** `nps_metrics()` (optionally per coach) surfaces the pattern
  panel on the dashboard — the `beat_learning_digest` sibling.

**The load-bearing safety design.** An NPS-aware concierge that references a past
low score is repellent. Two controls stop that, and they already exist:

1. `renderCustomerNps` leads with an explicit instruction: *"NEVER quote a past
   score, rating, or survey back at them."* The brief is a *how*, never a line to
   read out — same contract as the coach.
2. The [reach-out judge](JUDGE.md) independently **vetoes scorekeeping** — so
   even if a draft slipped ("you rated us a 3"), it's killed before the customer
   sees it. NPS surfaces to the *coach*, never echoes at the *customer*.

## 6. Customer 360°

NPS folds into the existing **client book** rather than a parallel store.
**Shipped today:** the latest rating badge on the patron card and on the
conversation transcript head, and the full per-customer history grounding the
coach (`npsCoachBrief` — the *live* conversation is NPS-aware through the
coach, never through a spoken line). **Designed, not yet built:** a full NPS
timeline in the Patron drawer (score badges + reason snippets + category
chips) and folding themes into `consolidateClientBook`'s rolling summary —
tracked in [BACKLOG.md](BACKLOG.md).

## 7. Data model

| object | shape | notes |
|---|---|---|
| `nps_responses` | id, conversation_id, customer_id (nullable), coach_id, score (0–10), **segment** (generated), reason_text, categories jsonb, category_source, response_time_seconds, survey_version, created_at | admin-read RLS; service-role write. Linked to the conversation thread. |
| `nps_categories` | slug, label, prompt_hint, **detractor_focus**, enabled, sort | admin-managed vocabulary; detractor-forward seed. |
| `nps_metrics(p_days, p_coach?)` | → jsonb `{ window_days, coach, nps, responses, promoters/passives/detractors, offers, response_rate, gate_holds, themes, detractor_themes }` | `security definer`; the dashboard/aggregate calculation. `nps` mirrors `npsScore`, `response_rate` mirrors `npsResponseRate` (null when nothing offered or coach-scoped), `offers` counts audited `REQUEST_NPS` beat rows, `gate_holds` groups `payload.npsGate` refusal reasons. |
| `concierge_insights` (kind `nps_report`) | payload `{ report, days, responses }`, computed_at | the cached analyst report (`?npsreport=1`); no RLS policy — service-role only, served through the admin-guarded endpoint. |

## 8. Tests — how we know it works

The trigger and the math are pure, so they're pinned in the **hard-gate** deck
(`beats_test.ts`, run by `deno test` on every deploy and by the kit CI):

- **`npsSegment`** — the 0-6 / 7-8 / 9-10 bands.
- **`npsScore`** — %P−%D with passives ignored in the numerator; all-promoters =
  100, all-detractors = −100, all-passives = 0, empty = **null**, out-of-range
  dropped.
- **`npsTriggerGate`** — fires once, only concluded, only long-enough, only past
  the cooldown; each blocking condition asserted independently.
- **`detractorThemes`** — tallies only sub-promoter concerns, most frequent
  first, promoter mentions excluded.
- **`renderCustomerNps`** — a detractor brief carries the themes, the trend, the
  never-quote guard, and the rebuild-trust play; a promoter brief invites a
  referral; thin history ⇒ **empty**.
- **`npsResponseRate`** — responses ÷ offers; **null** when nothing was offered
  (never a fake 0%), negative counts clamp, deliberately uncapped so a
  window-edge anomaly (more responses than offers) shows instead of hiding.
- **`npsAnalystCorpus`** — the analyst report's evidence pack: detractors lead,
  the customer's own words are quoted, categories and transcripts ride along,
  session/char caps hold, and **fewer than 3 responses ⇒ ''** — no report on
  thin data.

The behavior deck adds **`nps-score-capture`** — the widget's exact
`context.nps` wire turns replayed against production on every deploy
(gracious receipt, no score echoed, no `{{nps}}` leak). Still open: the
live-fire judge-veto scenario for a planted "you rated us low" line (the
criterion + unit guard cover it; forcing it reliably in a deck is brittle).

## 9. The live wiring — what shipped, and how

- **The trigger** lives in the **nudge beat path**: it gathers the gate's inputs
  (conversation age, post-sale window or a met goal as *concluded*, the offer-
  once check, the per-customer cooldown) and calls the unit-tested
  `npsTriggerGate`; on *ask* it overrides the beat decision with **REQUEST_NPS**
  (service — a blocked order — always outranks it, and a pending question of
  ours suppresses it). The gate's verdict + reason ride the beat audit.
- **Capture is deterministic**: `context.nps` / `context.nps_reason` from the
  widget, written server-side (`captureNpsScore` / `attachNpsReason`) with the
  model only supplying warm language via private system notes. Both fail-open.
- **The categorizer** (`categorizeNpsReason`) — one Haiku forced-tool call over
  the admin-managed `nps_categories`, async, `category_source='llm'`.
- **The coach grounding** — `npsCoachBrief` (→ `renderCustomerNps`) joins the
  reply-rate digest in `coachBeatLine`'s private brief at both proactive sites;
  the judge criterion now names quoting past ratings as scorekeeping and
  whitelists the `{{nps}}` pill.
- **The widget** renders `{{nps}}` as an accessible 0–10 pill row (ES5, the
  `.cx-reply` components).
- **Admin**: Engagement → House rules NPS block (`outreach.nps` — enabled ·
  min-minutes · cooldown-days · question), a dedicated **NPS tab** (below), a
  rating badge on the patron card and on the conversation transcript head.

**Dashboard depth (shipped in the follow-up pass):** the NPS card now carries a
**trend chart** (segment counts per bucket, the bucket NPS in the tooltip — the
same `cvChart` spec as every other chart), **CSV export**, a **per-coach line**
(when more than one coach has responses), **segment movement** for repeat raters
(↑ improved / ↓ declined, with the at-risk names), and **✎ re-categorisation**
on each recent response (`category_source='human'`, via an admin RLS update
policy). The behavior deck gained `nps-score-capture` — the widget's exact
`context.nps` turns replayed against production (deck turns now support a
per-turn `ctx`). The privacy notice names the voluntary rating in *What we
collect*.

**Fail-visible + deploy-proven (hardening pass):** the NPS card never hides
silently — any `nps_metrics()` failure renders the card with an inline
"NPS unavailable — *reason*" line (and a `console.warn`), so "not deployed" and
"erroring" are distinguishable at a glance. Every deploy now proves the RPC
live: after applying `setup.sql`, the workflow executes `nps_metrics(30)` in
the database (service-role claim) **and** probes the REST path the admin uses —
`403` for the publishable key passes (resolvable + guarded), `404` fails the
deploy (stale PostgREST schema cache; `setup.sql` also ends with
`notify pgrst, 'reload schema'`). The schema-apply step is now blocking — a
SQL error fails the run instead of hiding behind `continue-on-error`. **QA
traffic never counts**: sessions with a `qa-` key (CI smoke, the eval deck)
exercise the survey conversationally but write no `nps_responses` row, and a
`setup.sql` janitor deletes any that ever slipped in — the dashboard NPS is
real customers only.

**The NPS tab (the PRD's reporting surface, in full):** NPS moved off the
Conversion tab onto its **own admin tab**, reporting the whole survey funnel —
**offers** (the ask was actually spoken: `beat_action` rows with
`REQUEST_NPS`), **gate holds** (every time the gate evaluated and correctly did
NOT ask, with `npsTriggerGate`'s own reasons from `payload.npsGate`),
**responses**, and **response rate** (responses ÷ offers; `npsResponseRate` in
`beats.ts` is the unit-tested mirror of the SQL — null when nothing was
offered, never a fake 0%). **By-category reporting** shows the full
`nps_categories` vocabulary — zeros included, detractor-focus rows bold — with
mention counts, detractor share, and bars, so the operator sees the classifier
working at a glance. The tab keeps the trend chart, per-coach line, segment
movement, recent responses with ✎ re-categorisation, and CSV export, over its
own rolling range picker (7/30/90/365/all — `nps_metrics(p_days)` windows) and
a **View-by granularity picker** (auto/day/week/month/year). An **Over time**
card aggregates every KPI per bucket, Conversion-style: **NPS per bucket** (a
signed −100…100 line with honest gaps — a bucket with no responses breaks the
line rather than faking a zero), the **survey funnel** (offers vs responses,
bucket response rate in the tooltip), **response rate per bucket**, and
**responses by segment** (the raw quantity). Offers come from the audited
`beat_action` rows, so the charts and the beat ledger can never disagree.
`response_rate` is deliberately null in coach-scoped views: offer rows carry no
coach, and the house never approximates a number it can't ground.

**The close IS the moment (wrap-up trigger):** the survey's designed moment —
the natural close — used to be exactly the moment it could never fire: the
"That's all for now" chip sent only a silent lifecycle beacon and muted future
beats, and a typed "all done" wrapped via the snooze flow. Now the chip sends a
**real goodbye turn** (`context.wrapup=1`), typed farewells match a phrase
list, and the ask rides the goodbye reply itself through the same pure gate
(once per conversation — responses *and* prior offers both count — minimum
session length, per-customer cooldown). **Anonymous sessions are eligible** on
this path (no identity ⇒ no cooldown to check; once-per-conversation still
binds), which closes the anonymous-shopper gap for the flow that matters. The
widget defers the close beacon while the `{{nps}}` scale is on screen so the
score and reason attach to the conversation being rated; walk-aways still
close on pagehide. Every wrap-up ask writes the same audited offer row, so the
response rate stays honest. The *etiquette* — goodbye first, an **invitation**
("would you be willing to answer one quick question?" — tapping a number
answers, walking away declines), gracious receipt, never mention scores again —
is the admin-editable `closing-survey` SOP; the *decision* stays in unit-tested
code.

**The two closes — conversations and surveys are separate processes:**

- **The conversation close.** "That's all" (chip or typed) wraps the visit:
  quiet mode on, the conversation row stamped `closed`. **A new conversation
  starts on the very next message** — there is no lockout; the next thing the
  visitor types (or a later return visit, greeted by the re-engage opener)
  opens a fresh conversation row immediately.
- **The survey close.** When the goodbye carries the scale, the widget holds
  the conversation OPEN through the rating exchange so the score and reason
  attach to the visit being rated. **The reason receipt then ends the visit**:
  the concierge thanks them for taking the time, addresses a problem forward or
  receives praise warmly, says goodbye — and asks nothing further ("what can I
  help you with?" after a survey is a defect). The widget closes and quiets on
  that turn.
- **Changing a rating — inside the window only.** "I need to change my score"
  is honored, not argued with, **while the admin-configurable change window is
  open** (`outreach.nps.reviseDays`, Engagement → House rules, default **3
  days** from the original rating; **0 = ratings are final** the moment
  they're given). Inside the window, a deterministic detector (change/fix/
  correct + rating/score/survey, or rating + wrong/mistake) re-presents the
  scale with one gracious line, and the new tap **revises the existing row in
  place** (`npsCaptureAction`, unit-tested — the *offer* to revise and the
  *write* use the same decision, so they can never disagree). The model is
  told, not trusted to know: the server injects a per-turn `[SURVEY REVISION]`
  register note carrying the verdict (window open → re-present the scale;
  window closed → the rating stands), and step 6 of the `closing-survey` SOP
  instructs the concierge to follow that note — etiquette in the SOP,
  decision in code, same as the survey ask itself. The revision
  targets this conversation's own row, or — in a fresh conversation — the
  customer's most recent row. **Past the window** the concierge declines
  kindly in one line and invites the feedback directly (still acted on, never
  changing the number), and a stray tap **writes nothing**: inside the
  cooldown it can be neither a correction (window over) nor a new response
  (the gate never offers there) — a duplicate rating from one person stays
  structurally impossible. A revision that changes segment clears the
  now-stale reason (and categories) so the follow-up "why" re-attaches; a
  same-segment nudge (10 → 9) keeps the reason it still describes. Anonymous
  corrections bind only within the same conversation.
- **How the dashboard treats a revision.** A revision **restates history in
  place** — the row keeps its original `created_at`, so every aggregate (the
  NPS number, trend buckets, segments, themes, the analyst report's corpus)
  reflects the **corrected score in the original bucket**; nothing is
  double-counted and offers/response-rate are untouched (a revision is not a
  new response). `revised_at` is the audit stamp: the tab's recent list marks
  the row "· revised", and the raw stamp rides the CSV-visible row data. The
  house shows the number the customer stands behind, in the period they said
  it about.
- **How soon can the survey happen again?** At most **once per conversation**
  (a response *or* a prior offer both close that door), and for a recognized
  customer never inside `cooldownDays` (default **30**) — so a new conversation
  ten minutes later will NOT re-ask, even though conversations themselves
  restart freely. Anonymous sessions carry no identity, so only the
  once-per-conversation rule binds them. Every refusal is logged with the
  gate's reason (the NPS tab's "Held by the gate" line).

**The analyst report (conversational analytics):** `GET ?npsreport=1` turns
the numbers into actions. `npsAnalystCorpus` (unit-tested) packs the rated
sessions — score, the customer's own reason, transcript excerpts — detractors
first, capped, and **refuses to run on fewer than 3 responses**. The model
then writes four sections: *what is creating detractors*, *what promoters
praise*, *do next* (≤3 fixes ranked by impact), and *watch* — every claim
quoting a short phrase and naming its session numbers, "Insufficient
evidence." where the data can't support a section, never a name or an email.
The report caches in `concierge_insights` (kind `nps_report`): the NPS tab
loads the cached copy free, and **Generate fresh** is the deliberate,
operator-triggered model spend, windowed to the picked range.

**Still open** (tracked in [BACKLOG.md](BACKLOG.md)): a segment filter on the
conversations list, an admin editor for the `nps_categories` vocabulary (SQL
today; the classifier + ✎ honor it live), and the judge-veto deck scenario for
a planted "you rated us low" line (unit + criterion cover it today; a
live-fire deck case is flaky to force).

## 10. Open decisions (from the PRD)

- **"coach" = who?** The AI concierge instance, or a human agent — `coach_id`
  carries either; the design is invariant. Confirm before the dashboard's coach
  table is built.
- **Response-rate target (>35%)** is a hypothesis to instrument, not a
  guarantee; the cooldown + once-per-session + judge exist precisely so chasing
  the number never costs trust.
- **Causation** — segment movement after an intervention is correlational; a
  holdout/A-B is the honest way to claim the coach *caused* a Detractor →
  Promoter move (the same caveat as the coach-lift eval).
