# Revenue attribution & conversion tracking

How Feierabend decides whether the AI concierge earned credit for a commission,
where every number in the admin's **Conversion** tab comes from, and — just as
important — what the numbers can and cannot claim. Written for the merchant
first, engineers second.

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

**Conversion tab** (all figures over the selected range; cancelled orders are
excluded from revenue but keep their attribution):

- **Commissions (kept)** — orders with `status ≠ 'cancelled'`,
  by `placed_at`.
- **✳ Concierge-initiated / Chat-assisted** — tier counts as defined above.
  Orders placed before the tier column existed can never be ✳ (the data wasn't
  captured); they count as chat-assisted when they carry a chat link.
- **Attributed revenue** — (✳ + assisted) × the **register price**
  (`concierge_config.unit_price`, editable under Edition & access; $589 when
  unset). The split line prices each tier separately.
- **Chat → commission rate** — attributed kept commissions ÷ conversations
  started in the range. Both sides are range-bounded, so a chat late in the
  window whose order lands after the window slightly undercounts.
- **Conversation funnel** — the LLM judge's `sales_stage` per conversation
  (`browsing → engaged → evaluating → objection → ready → won / lost`). This is
  a *transcript reading*, not an order record: a stage of `won` and an actual
  attributed order usually agree, but the ✳ tier is the hard, order-level
  signal; the funnel tells you *where* conversations stall.
- **What converts** — for ✳ orders only, the commission-click context from
  `chat_meta`: which page **sections** and **entry beats** (typed, pill,
  opener, outreach, nudge) produce the taps, and the average conversation
  depth. This is the optimization surface: feed what appears (starters, goals,
  selling angles on those sections), investigate what never does.

**Conversations-tab tiles**: *Assisted commissions* = all-time kept orders with
a chat link (both tiers); *Assisted revenue* = that count × the register price.

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
| `concierge_config` | `unit_price` | Register price behind every revenue figure |

Full column docs in [`supabase/SCHEMA.md`](supabase/SCHEMA.md); design
rationale in [`DESIGN.md`](DESIGN.md) §4.8.
