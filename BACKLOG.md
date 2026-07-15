# Backlog

Known future work, prioritized. None of it is needed for the demo today — the
scaling *blockers* are done (see [SCALING.md](SCALING.md) #1–#4). This is the
"we know exactly what to do when it's needed" list. Fuller detail lives in
[SCALING.md](SCALING.md) and [DESIGN.md](DESIGN.md) §8–§9.

## Scalability — do when volume demands it

- **[P1] Collapse per-request query fan-out (SCALING #5).** Fold `customerBlock`'s
  ~3 sequential reads into one `security definer` RPC bundle; keep PostgREST on
  the pooler. *Payoff:* lower per-message latency, fewer held DB connections under
  concurrency. *Effort:* moderate. *Trigger:* hundreds+ of concurrent signed-in
  chats.
- **[Later] Monthly range partitioning (SCALING #2, further step).** Retention
  already bounds the high-write tables via `prune_high_write`. For true web-scale,
  convert `concierge_messages`/`concierge_actions` to monthly range partitions so
  retention is an instant `drop partition` (no delete bloat) and scans prune by
  partition. *Effort:* high (data-migrating). *Trigger:* billions of rows / delete
  bloat from retention becomes visible.
- **[Watch — no code] Cost & quotas (SCALING #8).** Right-size the Supabase plan,
  request Anthropic rate-limit increases, verify a Resend domain for volume. The
  semantic cache (built) is the main code-side lever.
- **[Skip unless repurposed] Serial-allocation contention (SCALING #6).** The
  single-row `FOR UPDATE` is correct for a 15,000-piece scarce edition; only
  matters if the engine is reused for a high-volume, non-scarce product.

## Product / features

- **[Shipped] Client-book consolidation (relevance by process).** Rolling
  `kind='summary'` per patron: `consolidateClientBook` folds the AI's
  fact/event/reflection notes into one tight digest (never touching directives),
  auto-firing once ~8 new notes accrue and on-demand via the drawer's Regenerate
  button (`?consolidate=1`); the CUSTOMER block injects *open directives + summary
  + 2 newest notes* instead of ~14, with older detail reachable via
  `recall_context`. See DESIGN.md §2.4 and COST.md.
- **Image uploads for Bot images.** Admins can now add bot images by **URL or
  `data:` URI** (Tuning → Bot images). A file-upload path (Supabase Storage
  bucket + signed URLs) would let them drop in real image files instead of
  pasting a source. *Effort:* moderate (storage bucket + RLS + upload widget).
- **`select` field type for in-chat forms.** Form fields are `text` · `state` ·
  `zip` today, so a constrained choice (e.g. colorway) is a free-text field
  validated server-side. A `select` type (label + options) would give a proper
  dropdown and remove the typo path. *Effort:* small (widget renderer + a type in
  the field schema). See [FORMS.md](FORMS.md) §8.
- **Configurable colorways per run.** Currently hardcoded (`ungefaerbt/loden/
  graphit`) across ~13 places incl. a DB `CHECK`. Make them admin-editable
  (name/description/swatch), replacing the constraint, wired through checkout,
  the concierge, and validation. (Deferred by choice; storefront card art would
  also need per-colorway images.)
- **Demo auto-progression of fulfillment (DESIGN §8).** A timed job that advances
  orders through `placed → … → shipped` on their own, so the edition visibly moves
  without an admin acting.
- **Scheduled idle-close job (DESIGN §9).** A server-side sweep that ends
  conversations idle for N hours, so leave-detection doesn't depend on the
  best-effort `pagehide`/`visibilitychange` beacon.

## Quality — inherent limitations (DESIGN §9)

- **Multi-judge goal scoring.** Goal scoring and client-book summaries are single
  async LLM calls; an adversarial / multi-judge pass would raise confidence.
  (Proactive *reach-outs* now do get a second reading — the reach-out judge —
  but goal grading remains single-judge.)
- **[Shipped] Auto cache invalidation.** Any save to `concierge_kb`,
  `concierge_config`, or `concierge_sops` now flushes the semantic answer
  cache via a Postgres statement trigger (it re-warms from live traffic), and
  a polarity guard refuses a cached hit whose negation signature differs from
  the incoming question's. See SCHEMA.md → `concierge_cache`.

## Reach-out judge — the proactive-line safety gate ([JUDGE.md](JUDGE.md))

The judge is a fixed safety floor with a dynamic per-house layer: its six
universal defects + model are code (versioned with the engine, vendored
byte-identical by the kit — [Maniwar/concierge-kit](https://github.com/Maniwar/concierge-kit)
— in the pristine `engine/` snapshot, in neither stamp manifest), while what each
house may claim/price/offer is read at call time from that house's constitution
(the kit-stamped `BRAND_SYSTEM` / admin `voice_base`). Design detail:
[JUDGE.md](JUDGE.md) §4a, §13–14.

- **[Shipped] Dynamic per-house grounding.** The judge no longer hardcodes *"the
  house never discounts"*. Defect (3) now reads against the house's actual price
  posture, and every call injects the effective constitution's HONESTY & SCOPE
  (`houseHonestyRules` → `voice_base` else `BRAND_SYSTEM`) as authoritative
  "house rules" — the same honesty text that binds the drafting prompt and that
  the kit stamps per product. This fixed the Feierabend seam *and* let the judge
  catch house-specific claim violations (medical claims, out-of-scope products,
  fabricated figures), while the six universal defects stay a fixed floor the
  merchant cannot weaken. See [JUDGE.md](JUDGE.md) §4a.
- **(Considered) Stampable criterion.** Make `BEAT_JUDGE_CRITERION` a Class-2
  block the kit rewrites per brand. Held — it adds a brand-authored surface to a
  safety control and weakens the uniform-backstop guarantee.
- **(Declined) Operator-editable criterion.** A safety gate the controlled party
  can weaken isn't a control (JUDGE.md §7). House-specific rules go in the
  constitution/SOPs instead.
- **(Small) Configurable judge model tier** — expose `BEAT_JUDGE_MODEL` per
  install for cost/quality trade-offs at scale.
- **(Scope) Judge reactive replies too**, not only proactive lines — at a
  per-turn latency/cost the current design deliberately avoids.

## Sales-strategist coach — the pre-draft "second brain" ([COACH.md](COACH.md))

The additive mirror of the judge: before each proactive line is written, a focused
sales strategist reads the full situation and privately briefs the draft with the
best move/tactic. Grounded in the drafter's own system (method + register + stage),
bounded by the same constitution, advisory + fail-open. Shipped; the coach code is
vendored byte-identical by the kit and defaults ON (`outreach.beatCoach`).

- **[Shipped] The feedback loop.** The coach now reads the house's own outcome
  digest (`beat_learning_digest` → reply rate per move × kind, DB-cached in
  `concierge_insights`), so it reasons over real reactions the drafter never sees
  — the change that turns it from a mirror into a learning layer. Honest about
  thin data (empty below a floor; a fresh house gets no invented pattern) and can
  push the coach *down* to restraint. `outreach.coachLearning`, default on.
  See [COACH.md](COACH.md) §5.
- **Bandit-driven selection** *(the loop's next step).* Today the digest *informs*
  the coach; a stricter version could let reply-rate drive move selection directly
  (Thompson sampling per segment), coach explaining, constitution still bounding.
  Gated on the eval below, to avoid optimising for replies over the *right* replies.
- **Eval the coach's lift** *(near-term — now measurable).* A persona-eval pairing
  running coach-on vs. coach-off vs. inline-planning, grading the tactical-quality
  delta; plus the live tactic → reply-rate signal the loop now records.
- **(Scope) Reactive coaching at stage transitions.** Today only *proactive* lines
  are coached. A stricter product could coach reactive replies too — but on the
  shopper's critical path, so gated to high-value moments (a detected stage advance,
  a first price objection) rather than every turn, to bound latency.
- **(Small) Configurable coach model tier** — expose `BEAT_COACH_MODEL` per install
  for cost/quality trade-offs (a cheaper strategist at very high volume).
- **(Small) Surface the brief in the transcript viewer** — the coaching already
  rides the audit payload; render it inline next to the line it shaped, the way
  vetoes already show the killed line and reason.

## NPS — closed-loop feedback ([NPS.md](NPS.md))

**[Shipped] The foundation, dormant by design:** the survey trigger gate
(`npsTriggerGate` — once, at a natural close, past cooldown), the score math
(`npsSegment`/`npsScore`, %P−%D with honest nulls), the detractor-reason tally
(`detractorThemes`), the judge-guarded customer brief (`renderCustomerNps`), the
schema (`nps_responses` with a generated segment, detractor-forward
`nps_categories`), and the SQL aggregate (`nps_metrics`) — all unit-tested (5
hard-gate tests) and documented with a diagram. Nothing fires live yet.

- **[Shipped] The live wiring** *(NPS.md §9)*: the `REQUEST_NPS` beat through
  the tested gate (post-sale / goal-met, service-first, pending-ask-suppressed);
  deterministic `context.nps` score + reason capture; the async LLM categorizer;
  the `{{nps}}` 0–10 scale pill in the widget; `npsCoachBrief` into
  `coachBeatLine` at both sites; the judge criterion naming quoted-rating
  scorekeeping + whitelisting the pill; `outreach.nps` config block, the
  Conversion-tab NPS card, patron + transcript badges; DFD/ROPA row.
- **Dashboard depth** *(next)*: NPS trend-over-time chart + period comparison,
  per-coach table, CSV export, human re-categorisation UI, an NPS segment filter
  on the conversations list, and a privacy-notice sentence on the published page.
- **Behavior-deck scenarios for the live flow** *(coverage gap)*: fires at close
  / not mid-flow / not twice; a planted "you rated us low" line is judge-vetoed.
- **Segment-movement widgets** *(with the tab)*: Detractor→Passive→Promoter
  cohort movement, at-risk (recent decline) list — the period-comparison
  machinery already exists.
- **(Phase 2)** Relationship Health Score (NPS × standing/LTV × recency),
  customer self-serve history, automated playbooks, churn prediction.
- **(Honesty)** claiming an intervention *caused* a segment move needs a
  holdout/A-B — same caveat as the coach-lift eval.

## Deferred by choice

- **Lifecycle beats package.** Weave-milestone updates, post-delivery
  check-ins, and days-scale ownership follow-ups (WEAVE_MILESTONE,
  POST_DELIVERY_CHECKIN, REASSURE_OWNERSHIP rules for the Action Table).
  Designed during the engagement program; the merchant deferred it — the
  post-sale window covers the near-term need.
