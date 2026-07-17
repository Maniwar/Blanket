# CALLMAP.md — every backend call, who makes it, and why

One page, the whole wiring. Each row says who calls what and the reason it
exists; the deep truth stays in the owning docs — **SCHEMA.md** (endpoints,
RPCs, gates, CORS), **COST.md** (every LLM call and its price), BEHAVIOR.md
(when the proactive calls fire). If a row here ever disagrees with those,
they win — this is the atlas, not the territory.

## 1. The four callers

| Caller | Credentials | Talks to |
| --- | --- | --- |
| **Storefront widget** (`concierge.js`, `checkout.js`, the page) | publishable key; user JWT when signed in | both edge functions, nothing else |
| **Admin studio** (`admin.html`) | admin JWT (email in `concierge_admins`) | edge functions (admin routes) + Postgres directly for config tables (RLS admin policies) + admin RPCs |
| **The engine itself** (edge functions, internal) | service-role key | Postgres (bypasses RLS by design), Anthropic, Resend |
| **CI / workflows** | repo secrets (`SUPABASE_DB_URL`, publishable keys) | psql probes, edge-function health checks, deploys |

Every browser call passes the `ALLOWED_ORIGINS` CORS check first, then one of
four gates: **public** (rate-limited) / **signed-in** / **admin** / **service**
(server-to-server only). Details + diagram: SCHEMA.md → HTTP endpoints.

## 2. HTTP endpoints (the two edge functions)

### concierge
| Route | Gate | Why it exists |
| --- | --- | --- |
| `GET ?config=1` | public | Widget bootstrap: enabled, greeting, starters, forms, outreach timings. |
| `GET ?site=1` | public | CMS slot values for the storefront hydrator. |
| `GET ?selftest=1` | public (tiered) | Diagnostics; anon sees schema presence only. |
| `POST` (chat) | public | The streamed reply — tools, cache, logging, goal scheduling ride it. |
| `POST ?reengage=1` | public | One short line for the closed-panel bubble. |
| `POST ?wrapup=1` | public | Records a conversation closed/snoozed, once. |
| `GET ?starters=1` | signed-in | Personalized starters from the caller's real orders. |
| `POST ?form=1` | signed-in | Structured form submission, ownership-scoped. |
| `GET ?tools=1 / ?evals=1 / ?secrets=1 / ?export=1 / ?insights=1 / ?cachecheck=1` | admin | Studio readouts: tool manifest, eval deck, secret presence, streaming CSV export, coach digest, cache self-test. |
| `POST ?judge=1 / ?lint=1 / ?regrade=1 / ?consolidate=1` | admin | LLM judge for evals; advisory honesty lint on saved rule text; on-demand goal re-grade; force a patron summary. |
| `GET ?judgedigest=1` | admin | Judge & Coach digest preview; `&send=1` emails the owner now and runs the Tier-1 coach-draft pass. |

### commission
| Route | Gate | Why it exists |
| --- | --- | --- |
| `GET ?recent=1 / ?next=1` | public | The ticker: recent orders (serial + city only) and live edition figures. |
| `GET ?me=1 / ?addresses=1`, `POST ?address_save=1 / ?address_delete=1` | signed-in | Patron standing + the managed address book. |
| `POST ?hold=1` | public | Reserve the visit's serial. |
| `POST` (order) | signed-in | Place the order with the verified email; confirmation email follows. |
| `POST ?waitlist=1` | public | Join the waitlist. |
| `POST ?fulfill=1 / ?editaddr=1 / ?editbilling=1 / ?resend=1` | admin | Order operations: advance status, correct addresses, re-send emails. |
| `POST ?custresend=1` | service | Internal only: the concierge's `resend_confirmation` tool, after ownership is verified. |

## 3. The model's tools (what the concierge may DO in chat)

Called only from inside `POST` chat, executed server-side, every use audited
to `concierge_actions`. Registry overrides (`concierge_tools`) can disable or
re-instruct any of them from the Tools tab.

- **Register & service** — `get_my_orders`, `cancel_order`, `update_colorway`,
  `update_gift_details`, `resend_confirmation` (→ commission `?custresend=1`),
  `track_shipment`, `request_mending`, `get_care_guide`: the signed-in
  patron's own orders, read and gently managed.
- **Memory** — `recall_context` (older turns), `remember_customer` (house
  note), `resolve_admin_note` (close a directive): continuity without
  surveillance.
- **Capture** — `submit_inquiry`, `join_waitlist`: an intent is never lost,
  account or not.
- **Calendar** — `get_available_times`, `book_appointment`,
  `get_my_appointments`, `reschedule_appointment`, `update_appointment`,
  `cancel_appointment` (visits *and* callbacks): the model recites what the
  register computed — it never invents a time.
- **Callbacks** — `request_callback` (exists only once the tool returns ok),
  `change_callback` (an open request stays the visitor's to shape). Status
  truth rides the CALLBACKS context line, never the model's memory.

## 4. Database calls

Two kinds, one rule — **anything that decides is a tested function**:

- **RPCs** (`security definer`, `search_path=''`): the slot engine, booking
  under advisory locks, reassignment/departures, reports
  (`staff_report`, `booking_report`, `capacity_matrix`, `judge_findings`,
  `nps_metrics`, `llm_cost_metrics`), the queue, patron timelines, guarded
  removal, `change_callback`, retention (`prune_high_write`). Full table with
  per-function "why" + "used by": SCHEMA.md → Functions.
- **Direct table access**: the studio edits config tables under RLS admin
  policies (locations, hours, offerings, exceptions/time-off, staff, KB,
  SOPs, goals, forms, evals, config) — every edit versioned in
  `concierge_edit_history`. PII tables (`concierge_appointments`,
  conversations, customers) are **RPC-only** — no direct reads.

## 5. LLM calls (who spends, when)

Condensed from COST.md (which carries triggers, budgets, and prices):

| Call | Fires when | Purpose tag |
| --- | --- | --- |
| Chat reply (+ up to 4 tool rounds signed-in) | every message; **0** on a semantic-cache hit | `chat`, `chat-tools` |
| Proactive beat (opener/nudge) | idle beats the Action Table approves — incl. the graceful close + survey | `beat` |
| Beat judge (+ one redraft on veto) | before any proactive line is shown | `judge` |
| Sales coach grounding | beat briefs | `coach` |
| Re-engage bubble line | closed-panel bubble | `reengage` |
| Goal grading | sampled after turns; on-demand `?regrade=1` | `goals` |
| Client-book note / summary / directives | after signed-in turns, background | `notes`, `clientbook`, `directives` |
| NPS categorize / analyst report | survey answers; the NPS report card | `nps-categorize`, `nps-report` |
| Starter generation + answerability check | admin "AI generate" | `starters` |
| Eval judge / honesty lint | eval runs; after a rule-text save | `eval-judge`, `lint` |
| Coach "say it differently" drafts | the weekly digest run, repeat defect classes | `judge` |
| Cache embeddings | anonymous questions (local model, no API spend) | — |

Every call logs tokens + purpose to `concierge_llm_usage`; the **Spend tab**
prices it per conversation.

## 6. Outbound third-party calls

| Service | Called for |
| --- | --- |
| **Anthropic** | everything in §5; keys live only in function secrets. |
| **Resend** | order confirmations/shipping, callback + inquiry owner alerts, booking alerts to the assigned person, the weekly judge digest — all logged to `email_log`. |
| **Postgres** | the engine as service role; the studio under RLS. |

## 7. Background & self-scheduled work (no cron, no external scheduler)

- Goal grading, client-book notes/summary, directive reconciliation —
  `EdgeRuntime.waitUntil`, never on the shopper's reply path.
- **Judge & Coach weekly digest** — an hourly per-isolate check claims the
  week atomically in `concierge_insights`, then emails the owner and runs the
  Tier-1 coach-draft pass.
- Stale-request TTL sweep — when the queue opens. Retention
  (`prune_high_write`) — on demand from the studio (or pg_cron if enabled).
- Semantic-cache flush — triggered by KB/config/SOP edits.

## 8. Watching it live

- **Actions tab** — every tool call and beat decision with its ledger + trace.
- **Spend tab** — every LLM call, priced.
- **Judge & coach page** — blocks, classes, gaps, drafts, pause switches.
- **Calendar queue** — every booking/callback action with who acted.
- **Tuning → history** — every config/KB/SOP edit, revertible.

## 9. Evidence workflows (GitHub Actions — the sandbox-blind's eyes)

All `workflow_dispatch`, read-only unless named otherwise:

| Workflow | What it proves |
| --- | --- |
| **Judge pulse** | Spoke / held / blocked per day, block share, top block reasons — the judge-recovery watch. Counts only; no lines, no contact details. |
| **NPS probe** | The closing choreography END TO END against production: real conversation, waits out the worth-rating minimum, types "that's all for now", asserts the warm goodbye + `{{nps}}`, reads the gate's audited decision, then **deletes every row it created**. |
| **Starter probe** | Baked starter answers definitively: plants a pinned row, taps it over the real wire, asserts the streamed reply is **byte-identical** to the stored answer with **ZERO** `concierge_llm_usage` rows for that conversation, watches the real starters until each is pinned or accounted for (live / needs-knowledge / queued), then deletes everything it created. |
| **Gap probe** | The gap-to-knowledge loop end to end: plants two QA gaps, kicks the drafting pass with a zero-cost tap, watches until both gaps link to a **disabled** `origin='gap'` KB draft (and prints it), enables the draft, asserts both gaps clear (sweep or studio path, named honestly), then deletes everything it created. |
| **Case probe** | The conversation case boundary: plants a CONCLUDED case, proves a rating tap attaches to it without opening a new one, proves a real visitor message opens a **fresh case** (and a second message continues it, no runaway), all on zero-cost pinned taps, then deletes everything it created. |
| **Judge floor probe** | The merchant-set judge floor's audited count: plants a `floored` spoke (a family the floor let through) + a still-blocked veto, asserts `judge_findings` counts the floored one as *floored* and the other as *vetoed* — never confusing the two — then deletes them. No model call, no config mutation. |
| **Judge trend probe** | The "Is it getting better?" chart's live plumbing: plants a beat spoke + veto today and a gap it then resolves, asserts `judge_findings` returns a gap-filled daily `series` whose today-row reflects both, and that the `resolved_at` trigger stamped the cleared gap (so "gaps cleared per day" is real) — then deletes everything. No model call. |
| **Calendar doctor** | Capacity matrix + slot counts + raw hours/windows config — why is nothing bookable? |
| **Prod validate** | The calendar case deck (V1–V8) live, inside a rolled-back transaction. Step 1 commits one idempotent fix (tour windows). |
| **Config conformance** | Every Engagement knob vs the widget's observed behavior (weekly cron + on demand). |
| **key-probe** | Browser-credential health for both sites (publishable key + function liveness). |
| **Deploy Concierge** | Beat tests, `deno check`, setup.sql apply, RPC probes, live smoke — and it **auto-triggers on any `supabase/**` push**, so code can never sit committed-but-undeployed. |

## 10. Instruction channels (why the model obeys — measured, not hoped)

Three channels carry house instructions to the model, in rising strength:
**baked system text** (constitution/engagement blocks — strong for standing
habits, carries exemplars) → **late system notes** (per-turn `system.push`
— weakest; a note here LOST to the baked snooze exemplar in live probes) →
**register notes in USER position** (a bracketed note beside the visitor's
own message — the channel the SOPs are trained on, "when the register
instructs you…"; the closing survey moved here and complied on the first
live run). Rules of thumb: train the channel in an SOP, deliver per-turn
imperatives in user position, keep a deterministic net under anything a
visitor must never miss, and METER the net (`REQUEST_NPS_APPENDED` rows)
so compliance is a rate with a target of zero, never a feeling.
