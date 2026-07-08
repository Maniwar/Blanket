# Revenue attribution & conversion tracking

How Feierabend decides whether the AI concierge earned credit for a commission,
where every number in the admin's **Conversion** tab comes from, and — just as
important — what the numbers can and cannot claim. Written for the merchant
first, engineers second.

![Conversion & attribution diagram](docs/conversion-metrics.svg)

*The whole system on one page — capture pipeline, the three tiers, the funnel's
stages and units, every metric's exact formula and date basis, credit rules,
and the honest limits. The sections below are the prose behind each box.*

## The three tiers

Every kept (non-cancelled) commission lands in exactly one tier:

| Tier | Meaning | Signal | Confidence |
|---|---|---|---|
| **✳ Concierge-initiated** | The buyer opened checkout by tapping the concierge's own **“Begin the commission”** button | `orders.chat_via = 'concierge'` | Causal — the chat produced the click that produced the order |
| **Chat-assisted** | A conversation ran in the buying session, but checkout was opened from a page button | `orders.chat_session` set, `chat_via` ≠ `'concierge'` | Co-occurrence — the chat was present, influence is plausible but not proven |
| **Unassisted** | No conversation existed in the buying session | `chat_session` NULL | The concierge played no visible part |

**Optimize on the ✳ tier.** Chat-assisted is a supporting indicator; unassisted
is the baseline. When quoting a single "concierge revenue" figure, quote the ✳
tier and mention chat-assisted separately — adding them together overstates.

## How a commission gets attributed (the pipeline)

1. **The chat leaves a key.** The concierge widget keeps a per-tab session key
   (`sessionStorage` `cx-skey`) and the transcript (`cx-history`)
   (`assets/concierge.js`). Server-side, every conversation row stores the same
   key (`concierge_conversations.session_key`).
2. **The commission button stamps a marker.** When the buyer taps the
   concierge's `{{action:commission}}` button, the widget writes a marker
   (`sessionStorage` `cx-commission-via`) recording the moment plus context:
   which **entry beat** the exchange came from (`typed` / `pill` /
   `opener:*` / `outreach:*` / `nudge`), the **page section**, and the
   **conversation depth** (turns so far). A page-button checkout writes no
   marker.
3. **Checkout sends the evidence.** At submit, `assets/checkout.js` includes in
   the order body:
   - `chat_session` — the chat's session key, sent whenever any conversation
     happened this tab session;
   - `chat_via` — `'concierge'` if the commission-button marker exists and is
     under 2 hours old (a slow, considered checkout still counts), else
     `'ambient'`;
   - `chat_meta` — the marker's `{entry, section, turns}`, only for
     `'concierge'`.
   After a successful order the marker is cleared, so a later page-button
   purchase can't inherit the earlier click.
4. **The server validates and stamps the order.** The commission function
   (`supabase/functions/commission/index.ts`) whitelists the values
   (`chat_via` ∈ {concierge, ambient}; `chat_meta` keys/lengths bounded) and,
   right after the order row is created, PATCHes `chat_session`, `chat_via`,
   and `chat_meta` onto it. The PATCH is best-effort — an attribution failure
   never blocks the sale — but any failure is **logged** in the function logs,
   so lost attribution is visible rather than silent. The `order_events` audit
   trail records the stamp as an `updated` event.
5. **The admin reads it back.** `orders.chat_session` joins to
   `concierge_conversations.session_key` (a text join, not a foreign key — one
   session key can span several conversation rows), which is also how the
   order drawer resolves the origin IP.

## What each admin number means

The **Conversion tab is the single metrics home** — the Conversations tab is
the working floor (transcripts, filters, grading) and carries no figures of its
own, so numbers can never disagree between views.

### Events glossary (what gets recorded, and when)

| Event | Recorded when | Stored as | Timestamp used |
|---|---|---|---|
| **Visit** | The page loads with the widget live (once per tab session) | `site_events` `kind='visit'` | event time |
| **Chat opened** | The concierge panel opens | `site_events` `kind='chat_open'` | event time |
| **Spoke to concierge** | A conversation receives a **user** message | `concierge_messages` (`role='user'`) | message time |
| **Register opened** | The checkout sheet opens (`via` = `concierge` if the concierge's button opened it, else `page`) | `site_events` `kind='checkout_open'` | event time |
| **Commission click** | The buyer taps the concierge's "Begin the commission" button | `sessionStorage` marker → `orders.chat_via/chat_meta` at placement | click context frozen at placement |
| **Order placed** | `commission_order` inserts the row | `orders` | `placed_at` |
| **Cancellation** | `cancel_order_return` | `orders.status`, `cancelled_at` | `cancelled_at` |

Funnel beacons are **PII-free**: a random device token (`visit_key`), optional
chat session key, section — no IP, no email, no name. They begin counting from
their ship date; earlier history shows zeros.

### Metric definitions (the formal table)

Every tile carries this same definition in its ⓘ hover. **Range** = the picker
(7/30/90 days or all time). **Prior window** = the equal-length window
immediately before the range (deltas; all-time has none).

| Metric | Formula | Date basis | Exclusions |
|---|---|---|---|
| **Revenue** | kept commissions × register price | order date (`placed_at`) | cancelled orders |
| **Commissions** | count of orders `status ≠ 'cancelled'` | order date | — |
| **Avg order value** | revenue ÷ kept commissions | order date | ≡ register price in this demo (one blanket per order, one price) — flat until multi-item/variable pricing exists |
| **Conversion rate** | attributed kept commissions ÷ conversations started | **cross-basis**: numerator by order date, denominator by conversation start | see caveat below |
| **✳ Concierge-initiated** | kept commissions with `chat_via='concierge'` | order date | — |
| **Chat-assisted** | kept commissions with `chat_session` set and not ✳ | order date | — |
| **Attributed revenue** | (✳ + assisted) × register price | order date | quote ✳ alone when claiming causation |
| **Conversations** | conversation rows created in range | conversation start (`created_at`) | — |
| **👍 rate** | thumbs-up ÷ all rated replies | **all-time** (feedback rows carry no timestamp) | not range-scopable |
| **Funnel stages** | UNIQUE count per stage — *Visits / Chat opened / Register opened* count unique **devices** (`visit_key`); *Spoke* counts unique **conversations** with a user turn; *Commissions* counts kept **orders** | event time / message time / order date | dedup is per bucket on the trend chart, per range on the snapshot; pass-through across a unit change (device→conversation→order) is directional, not an exact per-person rate |

**Which chat gets the credit:** the order's `chat_session` names the buying
session; when several conversation rows share that key, drill-ins open the
**latest conversation begun before the order was placed** — the chat that was
live at checkout.

**Bucketing:** ranges ≤ 31 days plot daily, ≤ 200 days weekly, longer monthly.
The trend charts bucket the current range only; deltas compare whole windows.

**Cross-basis caveat (conversion rate):** the numerator counts orders by order
date and the denominator counts chats by start date, so a chat late in the
window that converts after it undercounts slightly, and a bucket with zero
chats shows 0% regardless of orders. At 30+ days this skew is noise; don't
read single sparse buckets as trend.

### The report's other panels

- **Funnel over time** — the layered area/line chart of unique visitors
  reaching each stage per bucket; the snapshot card shows range totals with
  stage-to-stage pass-through and the overall visit → commission rate.
- **Conversation stages** — the LLM judge's `sales_stage` per conversation
  (`browsing → engaged → evaluating → objection → ready → won / lost`). A
  *transcript reading*, not an order record — the ✳ tier is the hard,
  order-level signal; the stages tell you *where* conversations stall.
- **Where the opportunities are** — computed reads: the biggest funnel drop,
  the rate trend vs the prior window, an unassisted majority, sections with
  chats but no ✳ conversions, and grading coverage — each phrased with the
  lever to pull.
- **What converts** — for ✳ orders only, the commission-click context from
  `chat_meta`: which page **sections** and **entry beats** (typed, pill,
  opener, outreach, nudge) produce the taps, and the average conversation
  depth, plus the order list itself.

**Nothing is a dead end.** Every Conversion number drills into the records
behind it: the tiles and split-bar legend open the register pre-filtered to
that tier; the rate tile opens Conversations filtered to 🛒 commissioned
chats; each ✳ commission row jumps to the **conversation that drove it**
(`chat ↗`) or its register row (`order ↗`); an order drawer's attribution line
opens the driving chat. Filters match the rest of the app — the register has
attribution-tier chips beside the status chips, and Conversations has a
**🛒 commissioned chats** checkbox beside the house-note one. **Export**: the
Conversion tab's Export CSV downloads the range with tier + click-context
columns (`attribution`, `attr_entry`, `attr_section`, `attr_turns`), and the
regular register export carries the same columns.

**Order drawer**: each order shows its tier line (with the click context in the
tooltip); the **Chats** tab lists chats that *touched* the order — see below.

## Two links, not one (don't conflate them)

- **Conversion link** — `orders.chat_session` / `chat_via` / `chat_meta`:
  which chat preceded/drove the **placement** of this order. Feeds every
  revenue figure.
- **Service link** — `concierge_actions.conversation_id` + `serial`: chats
  where a register tool later **acted on** an existing order (cancel, address
  change, tracking…). Feeds the order drawer's Chats tab and the 🏷/journey
  navigation. A chat can hold a service link without deserving conversion
  credit, and vice versa.

## Honest limits (read before quoting numbers)

- **Same-tab-session capture.** The chat key lives in `sessionStorage`, so
  attribution is captured only when the conversation and the checkout complete
  in the same browser tab session. Chat-today-buy-tomorrow, or chat on the
  phone then buy on the laptop, records as **unassisted**. For a considered
  purchase this is common: treat attributed figures as a **floor** on the
  concierge's true influence, never a ceiling.
- **Ambient is not causation.** A one-line chat that answered nothing still
  marks the order chat-assisted. That's why the tiers exist.
- **Best-effort stamp.** If the post-insert PATCH fails, the order stands
  unattributed; the failure appears in the commission function's logs (search
  "attribution PATCH").
- **The judge can be wrong.** `sales_stage`/goal grades are model judgments
  with sampling (`goal_sample_rate`) and can be re-run (Re-grade); they're
  directional, not ledger entries.
- **History has an horizon.** `prune_high_write` deletes conversations/actions
  after ~180 days; `orders.chat_session` then points at nothing. Order rows and
  their tier stamps survive, so long-range revenue reporting still works —
  only the drill-down into the transcript is lost.
- **Demo pricing.** Revenue = count × configured unit price. There are no
  taxes, discounts, refunds, or partial payments in this demo, so revenue is
  exactly proportional to counts.

## How to raise the ✳ number

The levers, in the order they usually pay off:

1. **Get the button into more replies where intent exists** — the Selling
   section's ADVANCE move and commission trigger (Tuning → dial, angles,
   objections). Every ✳ order started as `{{action:commission}}` in a reply.
2. **Aim goals at the sections that convert** — the What-converts card shows
   where taps happen; point per-section goals and starters there.
3. **Watch the funnel for the stall stage** — many `evaluating`, few `ready`:
   sharpen angles/objections. Many `ready`, few ✳ orders: the button isn't
   being offered at the moment of intent (check transcripts of `ready`
   conversations).
4. **Compare entry beats** — if outreach/opener beats never appear in
   What-converts, the proactive lines advance conversations that never reach
   the button; adjust their goals or pacing.

## Schema quick reference

| Where | Field | Purpose |
|---|---|---|
| `orders` | `chat_session` | Session key of the chat in the buying session (text join → `concierge_conversations.session_key`) |
| `orders` | `chat_via` | Tier: `concierge` / `ambient` / NULL (`orders_chat_via_check`) |
| `orders` | `chat_meta` | `{entry, section, turns}` at the commission click (✳ only) |
| `concierge_conversations` | `sales_stage`, `goal_status` | Judge-graded funnel stage + per-goal outcomes |
| `concierge_actions` | `conversation_id`, `serial` | Service touches on existing orders |
| `site_events` | `kind`, `visit_key`, `via` | Funnel beacons: visit / chat_open / checkout_open (PII-free) |
| `concierge_config` | `unit_price` | Register price behind every revenue figure |

Full column docs in [`supabase/SCHEMA.md`](supabase/SCHEMA.md); design
rationale in [`DESIGN.md`](DESIGN.md) §4.8.
