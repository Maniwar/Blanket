# The Judge & Coach loop — observability, self-healing, merchant control
*(spec for discussion — nothing here is built yet; reviewed numbers are live
from ops-report, 2026-07-16)*

## 1. The problem, in our own data

Last 14 days: **157 holds · 62 judge vetoes · 45 spoke**. Nudges: 54 vetoed
vs 45 spoken — more than half of judged nudge drafts die. The same three
defect classes repeat for weeks because a veto is write-only today: the
drafter never learns it was blocked, the merchant never sees the pattern,
and nothing heals. Meanwhile "how many are left in the edition?" hit **36
knowledge-gap flags** (fed by our own conversation starter) before the
edition context block shipped, and the cache self-check alarm fired 4 times
into a list nobody watches. The system polices itself but does not learn or
report.

## 2. Signals we already record (no new instrumentation needed)

| Stream | Table | What it carries |
| --- | --- | --- |
| Judge vetoes | `concierge_actions` (`beat_veto`) | beat kind, the vetoed line, the judge's reason |
| Holds / spoke | `beat_hold` / `beat_action` rows | why silence was chosen; what was actually sent |
| Knowledge gaps | `concierge_flags` | unanswerable questions, incl. system self-checks |
| Goal outcomes | `concierge_conversations.goal_status` | met / partial / missed per goal |
| Config & content history | `concierge_edit_history` | every SOP/KB/config change, versioned |
| Behavior evals | `concierge_evals` | the deck that proves a remedy worked |

## 3. Pattern detection (nightly + on-demand)

Cluster the streams into **findings**:
- **Repeat vetoes** — same defect class ≥ N times / 14d, by beat kind.
  Classes seen live: plumbing leaks (`{{action:…}}` tokens, process talk),
  invented claims (durability, refunds, fabricated product detail),
  inventorying the shopper (reciting stored data).
- **Policy conflicts** — actions that contradict an *active SOP or setting*:
  outreach during configured quiet windows, offers that ignore
  `confirm_mode`/caps, tool use against `concierge_tools` overrides, pacing
  beyond the configured dials. Each action kind maps to the SOP/setting that
  governs it; a mismatch is a first-class finding, because "acting against
  its own policy" is worse than a style defect.
- **Gap clusters** — semantically-same knowledge-gap questions repeating;
  cross-checked against active conversation starters (a starter feeding an
  unanswerable question is a self-inflicted wound — see §7).
- **Anomalies** — out-of-house content (e.g. the live "vehicle interior"
  veto on a blanket site) flagged for human eyes, never auto-healed.
- **System alerts** — `(system)` self-check gaps route to an ops strip, not
  the content list.

## 4. The closed loop

**detect → classify → propose → apply (tiered) → verify → audit**

1. **Classify** each finding against the constitution, active SOPs, house
   rules, and goals — which authority does it violate, how often, at what
   cost (lost outreach, wrong claims, trust risk).
2. **Propose a remedy**, typed by class:
   - *mechanical* → code guard (e.g. #149's pre-filter for action tokens);
   - *phrasing* → coach-drafted "say this instead" exemplar / beat note;
   - *knowledge* → KB draft from merchant materials, or a context block /
     tool when the data already exists (the edition-count case);
   - *config* → dial/setting change proposal;
   - *starter* → retire/regenerate the starter.
3. **Apply, in tiers**: Tier 0 auto (deterministic guards, starter
   retirement); Tier 1 auto-as-draft (exemplars, KB entries — seeded
   `enabled=false`, merchant flips); Tier 2 merchant-approved only (SOP
   text, dials, tool disables). Every change lands in `concierge_edit_history`
   and is one-click revertible. A global **kill switch** pauses all healing.
4. **Verify**: rerun the relevant eval rows (or synthesize one from the
   finding) and watch the stream — a finding closes only when the pattern
   stops recurring; it reopens itself if it returns.

## 5. Learning at the moment of the block (the drafter must know)

- The drafting prompt gains a **RECENT VETOES** block: the last vetoed lines
  in this conversation + the judge's reasons, so the next draft avoids them.
- **One bounded redraft**: on veto, redraft once with the reason in context,
  judge again, then hold. (Metric: redraft acceptance rate.)
- The coach folds recurring veto reasons into its weekly guidance and drafts
  the "instead" exemplars (Tier 1).

## 6. The Judge & Coach tab (admin)

- **Findings queue** (triage-first, like the Calendar queue): open patterns
  ranked by recurrence × severity, each with evidence rows, the governing
  rule quoted, and the proposed remedy with its tier.
- **Intervention controls**: pause a beat kind, pin a rule ("never mention
  sign-in mechanics"), approve/decline remedies, revert any applied change.
- **The standards floor** (merchant control over their own process): the
  judge blocks a proactive line when it crosses a defect family (invented
  offers, reciting the shopper, process talk, against your rules,
  unsolicited questions, other). The merchant sets each to **Block** or
  **Allow** — a preset (Strict / Standard / Facts-only) sets them all at
  once, or they adjust any row. A family set to *Allow* means the concierge
  may cross that line: it **speaks**, but the audit still records it and the
  health strip shows a *"let through by your floor"* count — control without
  going blind. The judge always RUNS (the floor changes what a block *does*,
  never whether the review happens), the mechanical pre-filter is never
  relaxable, and the floor is versioned like every setting
  (`concierge_config.judge.floor`). Classification uses the same ladder as
  the health strip (`classifyJudgeReason`, unit-tested), so the floor and the
  report never disagree about what a block *was*.
- **Health strip**: veto rate by beat kind (trend), repeat-offense rate,
  redraft acceptance, time-to-heal, gaps closed vs recurring.
- **Weekly digest email** to the owner: what was caught, what healed
  itself, what awaits approval.

## 7. Starters close their own loop (#147)

At generation, each candidate starter is dry-run against the model's real
context; candidates whose honest answer is "I don't have that" are dropped.
Ongoing: a gap cluster that semantically matches an active starter flags it
on the tab with one-click retirement.

## 8. Guardrails

Self-healing edits are drafts-first wherever they change what the model can
say; nothing automated ever touches prices, identity, privacy posture, or
the constitution itself; every automated action is attributed ("healed by
the coach, 2026-07-16") in edit history; the judge itself is never loosened
automatically — only the merchant may do that.

## 9. Build order (proposed)

1. #149 deterministic pre-filter — **live** (now token-vocabulary-aware:
   widget-renderable tokens pass; only unrenderable plumbing dies)
2. RECENT VETOES block + bounded redraft (§5) — **live**
3. Findings detection (`judge_findings`) + the tab's health strip — **live**
4. Remedy tiers — **live**, root cause included: Tier-1 coach drafts ("say
   it differently" procedures, seeded disabled, one per defect class) ride
   the weekly digest run; pause-a-beat-kind and the "Amend the judge" pen
   are the intervention controls; the judge grades against FACTS ON FILE so
   truth is never vetoed as invention. Root-cause repair: Tier-0 starter
   retirement (a deterministic, unit-tested matcher retires a starter that
   keeps feeding an unanswerable question — one revert restores it),
   missing-knowledge findings filed into the gap ledger when invented claims
   repeat (the KB is silent where shoppers ask), and remedy-not-holding
   escalation (an ENABLED procedure whose defect class recurs is named in
   the digest, never silently tolerated). Verify-by-eval — **live**: a
   repeating class seeds a deterministic regression eval into the deck
   (coach-verify-<class>; the weekly eval run proves the fix keeps holding),
   an enabled procedure with zero blocks is reported "healed and holding"
   (observed, never declared), and the missing-knowledge finding closes
   itself when invented claims stop — re-filing on its own if they return.
   §4 is complete.
5. Starter answerability (§7) — **live** · weekly digest — **live**
   (piggybacked self-scheduler, no cron; `?judgedigest=1` previews/sends on
   demand from the tab)

**Open questions for you:** (a) Tier 1 auto-drafts — comfortable with the
coach writing draft exemplars/KB unattended? (b) redraft budget: one retry
per veto, or none on cost-sensitive sites? (c) digest cadence — weekly or
daily while tuning?

## 10. Ops notes (learned live, 2026-07-17)

- **A judged line saying a detail is on file is service, not defect 7.** A
  live block vetoed "they have your number on file" as *reading records
  aloud*; the criterion itself now draws the line — only reciting the ACTUAL
  digits or text of a stored contact detail is the defect — so the rule
  binds even on turns when no register context rides along. (The register
  FACTS ON FILE block already said this; now the criterion agrees when that
  block is absent.)
- **Deploys can no longer lag the code.** The judge-grounding batch sat
  committed-but-undeployed for hours because `deploy-concierge.yml` was
  dispatch-only — Pages republished, the function kept running old code.
  The workflow now ALSO triggers on any push touching `supabase/**` (both
  sites, and the kit template emits the same trigger).
- **The recovery watch has an evidence feed**: the `Judge pulse` workflow
  (read-only, counts only — no lines, no contact details) prints spoke /
  held / blocked per day, the block share, and the top block reasons for the
  last 7 days. Expect the spoke column to rise and the block share to fall
  now that the grounded judge is live; if a legitimate line still gets
  blocked, the *Amend the judge* box on the tab is the pen.
