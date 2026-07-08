# Database Schema Reference — Feierabend (Decke 01)

This is the field-by-field reference for the whole backend: every table, every
column, what writes it, what reads it, and when. The schema itself is defined
in **`setup.sql`** (one idempotent file) and mirrored as ordered history in
**`migrations/`**. Keep this document in step with those files whenever a
column, function, or endpoint changes.

Two Supabase Edge Functions use this database:

| Function | Folder | Role |
| --- | --- | --- |
| **concierge** | `functions/concierge/` | The AI sales concierge — streaming chat, register tools, semantic cache, conversation logging, goals, lifecycle. System prompt is a prompt-cached static prefix + dynamic tail (see [`COST.md`](../COST.md)). |
| **commission** | `functions/commission/` | The demo checkout — serial holds and order placement. No payment; nothing ships. |

Both read the database with the **service-role key** over raw PostgREST (no
`supabase-js`). Row-Level Security therefore never gates the functions; it
gates the **browser** (anon key) and the **admin portal** (a signed-in admin).

---

## How the trust boundary works

- **Anon key (public browser)** — may only insert `concierge_feedback` rows.
  Everything else it tries to read/write is denied by RLS.
- **Signed-in customer** — may read their own `customers` and `orders` rows
  (owner policies). They never write orders directly; the edge functions do.
- **Signed-in admin** (email present in `concierge_admins`) — full read/write
  on the operational tables, governed by the `is_concierge_admin()` helper.
- **Service role (edge functions)** — bypasses RLS entirely. All order
  placement, serial allocation, cache, logging, and audit writes go through
  here, so the rules that matter for those live in the SQL functions
  (`security definer`, pinned `search_path = ''`), not in RLS.

---

## Tables

### Core entity relationships

The transactional heart — who bought what, the chat that drove it, and the audit
trail. (The `concierge_config`/`_kb`/`_sops`/`_forms`/`_goals`/`_tools`/`_evals`/
`site_content` tables are standalone registry/key-value content the admin edits;
`allocation_counter`/`serial_holds`/`rate_limits` back the serial + rate machinery.)

```mermaid
erDiagram
  customers ||--o{ orders : "places"
  orders ||--o{ order_events : "field-level audit"
  orders ||--o{ email_log : "transactional email (by serial)"
  customers ||--o{ customer_notes : "client book"
  concierge_conversations ||--o{ concierge_messages : "contains"
  concierge_messages ||--o| concierge_feedback : "thumbs (by message_id)"
  concierge_conversations }o--o| orders : "attributes via chat_session"
  concierge_conversations ||--o{ concierge_actions : "tool calls"
  allocation_counter ||--o{ serial_holds : "issues numbers"
```

Key columns: `orders.serial` (UNIQUE), `orders.user_id`/`email` (owner, RLS),
`orders.chat_session` (→ the conversation that drove it); `concierge_messages`
carries `role`/`content`/**`model`**/`latency_ms`; `concierge_conversations`
carries `session_key`/`user_email`/`status`/`sales_stage`/`goal_status`.

### `concierge_config` — runtime settings (key → jsonb)
One row per setting. Cached in the function for 60s, so edits reach live
traffic within a minute.

| Column | Type | Purpose |
| --- | --- | --- |
| `key` | text PK | Setting name (see keys below). |
| `value` | jsonb | The setting's value. |
| `updated_at` | timestamptz | Last edit. |

**Keys the concierge reads** (`loadConciergeData`): `enabled` (bool — false ⇒
chat returns 503 and `?config=1` reports resting), `model` (Anthropic model id),
`model_fallback` (model used when `model` is blank — the fully configurable
fallback; `resolveModel()` resolves `model` → `model_fallback` → `MODEL` env →
a compiled cheap default), `max_tokens` (per-reply cap, default 1024),
`greeting` (opening line; may embed `{{reply:…}}` pills), `voice_notes`
(appended to the system prompt as tuning notes), `starters` (per-section
suggested questions), `images` (admin-added `{{img:token}}` sources, merged
client-side and injected into the prompt), `goal_sample_rate` (0–1 — fraction of
turns the async goal grader runs).

*Client-book (memory) keys:* `clientbook_policy` (extra house rules injected into
the end-of-conversation summarizer — what to record vs. skip), `clientbook_log_actions`
(bool, default true — write a guaranteed `event` note on every mutating action),
`clientbook_reflect` (bool, default true — write a `reflection` line each
conversation). See DESIGN §4.10.

*Model keys:* `model`, `model_fallback` (§ Config table above).

*Selling engine keys:* `assertiveness` (1–5, default 3 = warm consultant — how
hard to sell; scales the prompt guidance and the client nudge/outreach budget),
`hooks` (array of true "selling angles" the bot weaves in to build desire),
`objections` (array of `{trigger, response}` for the Reassure move).

*Engagement pacing* lives under the `outreach` key (object), all admin-editable
in Tuning → Engagement pace: the in-chat follow-up ladder `nudge1Ms`–`nudge5Ms`
(the fifth repeats), `nudgeCap` (max in-chat follow-ups), `unackedCap` (pause
after N unacknowledged reach-outs), `holdBudget` (consecutive silent holds
before resting), opener delays `openerSignedMs`/`openerAnonMs`/
`openerReengageMs`, `dwellMs`/`dwell2Ms` (closed-panel reach-out delays),
`draftMs` (half-written-order nudge), `idleReach` (bool), `maxAmbient` (max
closed-panel reach-outs), `bubbleWithdrawMs` (how long the outreach bubble
lingers), `substanceGate` (bool, default true — a proactive beat must have
something new and concrete or it holds; held beats are logged as
`concierge_actions.action='beat_hold'`), re-engagement keys (`reengageEnabled`,
`reengageIdleAnonMs`/`reengageMaxAnon`, `reengageIdleSignedMs`/
`reengageMaxSigned`, `reengageGraceMs`, `reengagePostSaleWindowMs`,
`reengagePostSaleEnabled`), and `historyKeepMs` (how long a signed-in patron's
device-kept transcript survives a closed tab; default 7 days). The client reads
these via `?config=1`; blank/absent keys fall back to built-in defaults scaled
by `assertiveness`.

*Reporting & retention keys* (Conversion tab / Edition & access — see
[`ATTRIBUTION.md`](../ATTRIBUTION.md)): `unit_price` (USD behind every revenue
figure; $589 fallback), `week_start` (0 = Sunday, 1 = Monday — drives the
This-week range, weekly buckets, and WoW alignment for all admins),
`retention_days` (the horizon last used by the Data-retention prune — a record
of policy, not a schedule; nothing deletes automatically). Every change to any
config key lands in `concierge_edit_history` (who/when/what), so reporting
settings are themselves auditable.

**Written by:** admin portal (Tuning tab — Config, Engagement pace, Selling
style, Bot images). **Read by:** `handleConfigGet` (`GET ?config=1`),
`handleChatPost` (every reply). **Seeded by:** `setup.sql` (`enabled`, `model`,
`max_tokens`, `greeting`, `voice_notes`, `assertiveness`, `hooks`, `objections`).

### `concierge_kb` — editable product knowledge
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id. |
| `slug` | text unique | Stable handle. |
| `title` | text | Rendered as `## <title>` in the prompt. |
| `content_md` | text | The knowledge body. |
| `sort_order` | int | Assembly order. |
| `enabled` | boolean | Only enabled rows are included. |
| `updated_at` | timestamptz | Last edit. |

Enabled rows are concatenated into the `{{KB}}` slot of the system prompt. If
the table is empty or unreachable, the function falls back to the knowledge
compiled into `functions/concierge/kb.ts`. **Written by:** admin (KB tab).
**Read by:** `buildSystemPrompt`.

### `concierge_admins` — who may administer
| Column | Type | Purpose |
| --- | --- | --- |
| `email` | text PK | An admin's verified email. |
| `is_super` | boolean | The protected owner. Exactly one is seeded; can never be removed or demoted. |

**Read by:** `is_concierge_admin()` and `is_super_admin()` (used in the admin RLS
policies). **Managed by:** the admin panel's **Tuning → Administrators** card.
**RLS (command-split):** any admin may **select** the roster and **insert** a
non-super admin; only the **super** admin may **delete**, and the super row
itself cannot be deleted or updated — so one owner always remains. A non-admin
sees zero rows (how the panel gates entry). **Seeded by:** `setup.sql` (change
the email to yours before running); the first/super admin must be seeded in
SQL, after which the roster is self-serve.

### `concierge_conversations` — one row per chat thread
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Conversation id (returned to the client in the `{"m":{cid}}` meta event). |
| `session_key` | text | The client's opaque per-thread key; threads repeat requests into one conversation. Rotated by the client after a wrap-up so the next message starts a fresh thread. |
| `user_id` | uuid → auth.users | Signed-in user, if any. Back-filled if they sign in mid-conversation. |
| `user_email` | text | Signed-in email, if any. Also back-filled. |
| `section` | text | Page section the chat opened from. |
| `created_at` | timestamptz | Thread start. |
| `status` | text (`active`/`snoozed`/`closed`) | **Lifecycle.** `active` by default; set by `handleWrapup`. |
| `ended_at` | timestamptz | When the thread was wrapped (snoozed or closed). Presence of this = the thread is done; the next visit is a **re-engagement**. |
| `goal_status` | jsonb | Per-goal scoring: `{ "<slug>": {"status":"met|partial|unmet","note":"…"} }`. |
| `goal_status_at` | timestamptz | When goals were last judged. |
| `sales_stage` | text | Funnel stage from the async grader: `browsing`/`engaged`/`evaluating`/`objection`/`ready`/`won`/`lost`. Written in a **separate best-effort PATCH** from `goal_status`, so a missing column can't break grading. Shown as a chip in the admin Conversations tab. |
| `ip` | text | Latest client IP for the session (from `x-forwarded-for`), stored for **abuse/legal forensics**. Admin-only (RLS), shown in the transcript header, and included in the transcript export **only** when the PII option is on. Disclosed in the privacy notice. **Searchable** in the admin: the Conversations tab matches it directly, and the Orders & Customers tab resolves it to `session_key`s and finds the orders placed from that IP (`ip ↔ session_key ↔ orders.chat_session`). A full IPv4/IPv6 matches exactly; a partial prefix, as a substring. |

**Written by:** `logUserTurn` (create + identity back-fill), `handleWrapup`
(status/ended_at), `evaluateGoals` (goal_status + sales_stage). **Read by:** `logUserTurn`
(thread reuse), `customerBlock` (re-engagement recency — most recent
`ended_at` for the user), admin (Conversations tab, goal scorecard).

### `concierge_messages` — every turn
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | bigint identity PK | Message id (the `mid` in the meta event; feedback keys off it). |
| `conversation_id` | uuid → conversations | Owning thread (cascade delete). |
| `role` | text (`user`/`assistant`) | Who spoke. |
| `content` | text | The message body. |
| `model` | text | Model used (assistant turns). |
| `latency_ms` | int | Reply latency (assistant turns). |
| `created_at` | timestamptz | Turn time. |

**Written by:** `logUserTurn` (user turn), `logAssistantTurn` (assistant turn
after the stream completes). **Read by:** admin (transcript view).

### `concierge_feedback` — thumbs on an answer
| Column | Type | Purpose |
| --- | --- | --- |
| `message_id` | bigint PK → messages | The rated assistant message. |
| `rating` | smallint (−1/1) | Down / up. |
| `note` | text | Optional. |
| `created_at` | timestamptz | When rated. |

**Written by:** the browser directly with the anon key (the one insert RLS
allows). **Read by:** admin.

### `customers` — signed-in profile
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK → auth.users | The account. |
| `email` | text | Their email. |
| `name` | text | Optional display name. |
| `created_at` | timestamptz | First seen. |

Owner RLS lets a user read/write only their own row; admins read all.

### `orders` — the register (demo orders)
The core table. No payment or street-shipping data beyond what the demo needs.

| Column | Type | Purpose | Written when |
| --- | --- | --- | --- |
| `id` | uuid PK | Order id. | placement |
| `user_id` | uuid → auth.users | Owner, if placed signed-in. | placement |
| `email` | text | Buyer email. | placement |
| `serial` | int **unique, nullable** | The edition number (1–15000). **Null while cancelled** so a struck number frees up (unique ignores nulls). | placement; cleared on cancel |
| `status` | text | `placed`→`weaving`→`finishing`→`shipped`→`delivered`, or `returned`/`cancelled`. Advanced by an admin via commission `POST ?fulfill=1`; on `shipped`/`returned` the customer is emailed. | placement; cancel; admin fulfillment |
| `tracking` | text | Carrier tracking; set alongside `status` on the fulfillment endpoint, included in the shipment email. | admin when shipped |
| `city`,`state`,`zip` | text | Shipping locale (state = 2 letters). | placement / address change |
| `address`,`address2` | text | Street lines (demo only). | placement / address change |
| `colorway` | text | `ungefaerbt`/`loden`/`graphit`. | placement / colorway change |
| `name` | text | Buyer name (first name feeds the concierge's address of them). | placement |
| `recipient_name` | text | Gift recipient, when different from buyer. | placement |
| `is_gift` | boolean | Gift flag. | placement |
| `billing` | jsonb | Billing address when it differs from shipping. | placement |
| `cancelled_serial` | int | Archives the number a cancelled order **used to** hold. | on cancel |
| `chat_session` | text | The `session_key` of the concierge conversation that drove the sale (revenue attribution). Also the join key for **IP lookup**: `chat_session ↔ concierge_conversations.session_key ↔ .ip` lets the admin find every order placed from an IP, and show each order's origin IP in the detail drawer. | placement |
| `chat_via` | text | Attribution **tier**: `concierge` = checkout was opened from the concierge's own commission button (causal); `ambient` = a chat existed this tab session but checkout came from a page button (co-occurrence); `identity` = signed-in buyer with an account conversation ≤ 30 days before placement and no same-session chat (server lookback — catches cross-device journeys); `NULL` = unassisted (or an order placed before this column existed). Constraint `orders_chat_via_check`. See [`ATTRIBUTION.md`](../ATTRIBUTION.md). | placement |
| `chat_meta` | jsonb | Commission-click context for `concierge`-tier orders: `{entry, section, turns}` — which proactive beat the exchange came from, the page section, and conversation depth at the click (whitelisted/bounded server-side). For `identity`-tier orders: `{lookback_days}` — days between the account's last conversation and placement. | placement |
| `placed_at` | timestamptz | Placement time (feeds LTV recency). | placement |

**Written by:** `commission_order` (placement), `cancel_order_return`
(cancel), the register tools `update_shipping_address` / `update_colorway`
(concierge, signed-in), admin fulfillment (`patchOrder` via commission
`POST ?fulfill=1`). **Read by:** `myOrders` /
`customerBlock` (concierge context + LTV/standing), the `get_my_orders` tool,
commission `?me=1` (prefill), admin (Customers/Orders). **Audited by:** the
`log_order_event` trigger → `order_events`.

### `allocation_counter` — the next fresh number
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | int PK (=1) | Single-row guard. |
| `next_serial` | int | Next never-issued number. |
| `run_size` | int (default 15000) | The edition's total size; the allocation cap. Admin-settable via `set_edition`. |

RLS on, **no policies** — service-role only. **Read/written by:**
`hold_serial` and `commission_order` (both `... FOR UPDATE`, capping against
`run_size`); read/written by the admin RPCs `get_edition` / `set_edition`.

> **Edition framing.** Seeded at **next_serial 14215 / run_size 15000** so the
> run reads as "~786 of 15,000 remain" — an established, nearly-sold-out edition.
> The site's "remaining" is driven by the **live** counter (`commission ?next=1`,
> which now returns `run_size` too), not a hardcoded figure. An admin can reset to
> a fresh edition (start at Nº 1, any run size) from the studio's Edition card via
> `set_edition`.

### `serial_holds` — live reservations
| Column | Type | Purpose |
| --- | --- | --- |
| `serial` | int PK | The held number. |
| `session_key` | text | Who holds it (`'released'` marks a number freed by a cancel). |
| `expires_at` | timestamptz | Hold expiry (10 min); a past value = lapsed/free. |

**Written by:** `hold_serial` (reserve/refresh, lowest-free-first),
`commission_order` (consumes the hold on placement), `cancel_order_return`
(re-inserts the struck number as an already-lapsed hold so it's reclaimable).
Concurrency-safe via `FOR UPDATE SKIP LOCKED`.

### `rate_limits` — shared request counter
| Column | Type | Purpose |
| --- | --- | --- |
| `bucket` | text | Rate-limit key (an IP, or `f:<ip>` / `h:<ip>`). |
| `window_start` | timestamptz | Start of the fixed window. |
| `count` | int | Requests seen for this bucket in this window. |

PK `(bucket, window_start)`. RLS on, **no policies** — service-role only.
**Written/read by:** `rate_hit` (atomic upsert + count; self-prunes a key's
spent windows). Replaces the old in-memory per-instance limiter so the limit
holds across every edge instance.

### `waitlist` — future-edition sign-ups
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id. |
| `email` | text | Who to write to. |
| `name`,`colorway`,`note` | text | Optional details captured. |
| `source` | text | `sold_out` (front-end form), `concierge`, or `form`. |
| `user_id` | uuid | Set when captured from a signed-in patron. |
| `created_at` | timestamptz | When they joined. |
| `notified_at` | timestamptz | Admin stamps this once they've reached out. |

RLS on; **admin** select/manage policy (`is_concierge_admin()`). **Written by:**
commission `POST ?waitlist=1` (sold-out form) and the concierge `join_waitlist`
tool (both via service role). **Read/managed by:** admin (Orders & Customers tab →
Waitlist card: filter, mark notified, export CSV).

### `email_log` — record of transactional emails
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id. |
| `to_email` | text | Recipient. |
| `kind` | text | `placed` / `shipped` / `returned` / `cancelled`. |
| `serial` | int | The order's Nº. |
| `subject` | text | The email subject line. |
| `ok` | boolean | Whether Resend accepted it. |
| `provider_id` | text | Resend message id (on success). |
| `error` | text | Short reason (on failure). |
| `created_at` | timestamptz | When it was attempted. |

RLS on; **admin** read policy. **Written by:** `sendEmail` in both functions
(every attempt, success or fail). **Read by:** admin (Orders & Customers tab → per-order
email history). **Re-sent via:** commission `POST ?resend=1` (admin-gated).

### `concierge_sops` — the house's standard operating procedures
Same shape as `concierge_kb` (`slug`,`title`,`content_md`,`sort_order`,
`enabled`). Enabled rows are injected into the system prompt's STANDARD
OPERATING PROCEDURES section — the selling method, snooze/wrap-up procedure,
post-purchase behavior. **Written by:** admin (Procedures tab). **Read by:**
`buildSystemPrompt`.

### `concierge_actions` — audit of register tool use
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | bigint identity PK | Row id. |
| `conversation_id` | uuid → conversations | Where it happened. |
| `user_id`,`email` | — | Who. |
| `action` | text | Tool name (`get_my_orders`, `recall_context`, `update_colorway`, `cancel_order`, `remember_customer`, `resolve_admin_note`, `resend_confirmation`, `request_mending`, `update_gift_details`, `get_care_guide`, `track_shipment`, …) — plus non-tool audit rows: `attribution_qa` (QA run evidence) and `beat_hold` (a proactive beat that chose silence under the substance gate; payload carries the beat kind, so hold rate is measurable). |
| `serial` | int | Affected order, if any. |
| `payload` | jsonb | The tool input. |
| `result` | text | Outcome summary. |
| `created_at` | timestamptz | When. |

**Written by:** `logAction` (every tool execution + form submission). **Read
by:** admin (read-only policy).

### `concierge_cache` — semantic answer cache
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id. |
| `question` | text | The canonical question. |
| `answer_md` | text | The cached answer. |
| `embedding` | `extensions.vector(384)` | gte-small embedding; HNSW index with `vector_ip_ops` (inner product). |
| `hits` | int | Times served. |
| `enabled` | boolean | Off ⇒ never matched. |
| `model` | text | Model that produced the answer. |
| `created_at`,`last_hit_at` | timestamptz | Bookkeeping. |

Engages **only** for anonymous, single-turn, short questions (signed-in and
multi-turn answers depend on private/context state and are never cached).
**Written by:** the chat path after a cacheable answer (`embed` +
insert). **Matched by:** `match_cached_answer` RPC. **Diagnosed by:**
`GET ?cachecheck=1`. **Read by:** admin (Cache tab).

### `concierge_flags` — knowledge gaps
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | bigint identity PK | Row id. |
| `conversation_id` | uuid → conversations | Source thread. |
| `question` | text | What was asked. |
| `answer` | text | What the bot said. |
| `reason` | text | Default `knowledge_gap`; also carries embed/diagnostic failures. |
| `resolved` | boolean | Admin has addressed it. |
| `created_at` | timestamptz | When flagged. |

**Written by:** `maybeFlagGap` (and the `?cachecheck` diagnostic on embed
failure). **Read by:** admin (Knowledge-gaps tab).

### `concierge_forms` — admin-defined in-chat forms
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id. |
| `slug` | text unique | Form handle (referenced by `{{form:slug}}`). |
| `title` | text | Heading. |
| `submit_tool` | text | The register tool the submission routes to. |
| `fields` | jsonb | Field definitions (name, label, type, options). |
| `enabled` | boolean | Availability. |
| `updated_at` | timestamptz | Last edit. |

Lets the bot ask the customer to fill a structured form for order
modifications, submitted through the same audited tool path as the model's own
tool calls. **Written by:** admin (Procedures → Forms). **Read by:**
`loadConciergeData`, `handleConfigGet` (exposes slug/title/fields to the
widget), `handleFormPost` (`POST ?form=1`).

### `customer_notes` — the client book
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | bigint identity PK | Row id. |
| `user_id`,`email` | — | The patron. |
| `note` | text | One durable observation (≤240 chars; directives ≤400). |
| `kind` | text | Note type — **`event`** (something the concierge did — written deterministically by `bookEvent`), **`fact`** (a durable preference), **`reflection`** (private "serve better next time"), **`directive`** (a HUMAN admin's standing instruction the concierge must follow — see DESIGN §4.13), or **`summary`** (the rolling consolidated digest of the AI book — one per patron, written by `consolidateClientBook`; its `created_at` is bumped on each roll-up so newer raw notes are the "since then" tail). Default `fact`. No CHECK constraint. |
| `resolved` | boolean | Directives only: a one-time instruction that's been carried out is `true`. Standing ones stay `false`. Default `false`. |
| `resolved_at` | timestamptz | When a directive was checked off. |
| `author` | text | Directives only: the admin email who left it. |
| `created_at` | timestamptz | When learned. |

Typed clienteling memory the concierge **reads back to talk to the patron** (see
DESIGN §4.10). **Written by:** `bookEvent` (guaranteed `event` note on every
mutating action, via `logAction`), the `remember_customer` tool (`fact`), the
end-of-conversation summarizer `writeClientBookNote` (`fact` + `reflection`, both
deduped), and the **admin** (`directive`, from the Orders & Customers tab).
**Read by:** `customerBlock` and the `recall_context` tool — **grouped by kind**
(house-instructions / did-for-them / know-about-them / serve-better) into the
prompt — and the admin Orders & Customers tab (client book with a per-note kind
tag, plus Resolve/Reopen on directives). Open **directives** are queried
separately (unbounded by the 14-note window) and printed first in the CUSTOMER
block, which is rebuilt per turn in the **uncached** prompt tail — so an
instruction is picked up on the patron's next message, mid-session. The concierge
checks a one-time directive off with the `resolve_admin_note` tool (ownership-
scoped). Governed by the `clientbook_policy` / `clientbook_log_actions` /
`clientbook_reflect` config keys.

### `customer_addresses` — the managed address book
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id (also the client-side key for edit/remove). |
| `user_id`,`email` | — | The owner. |
| `label` | text | "Home", "Work", a gift recipient's name, "Billing"… |
| `is_gift` | boolean | A gift recipient's address (excluded from billing options). |
| `recipient_name` | text | For gift entries. |
| `address`,`address2`,`city`,`state`,`zip` | — | The address. |
| `created_at`,`updated_at` | timestamptz | Timestamps. |

Real, **editable/removable** addresses — distinct from the read-only view derived
from order history. **Written by:** the commission function on the patron's behalf
(`POST ?address_save` / auto-save on order placement / backfill from history on
first `?me`/`?addresses`), and admins via the "admin all" RLS policy. **Read by:**
`?me=1` (`saved_addresses`) and `?addresses=1`, both used by the checkout books.
RLS is enabled with no anon/self policy — patron access is brokered by the Edge
Function (service role + verified-JWT ownership). Migration `0041`. See DESIGN §4.12.

### `order_events` — full order audit trail
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | bigint identity PK | Row id. |
| `order_id` | uuid → orders | The order (cascade delete). |
| `event` | text | `created` or `updated`. |
| `changes` | jsonb | `created` ⇒ the full row (minus id); `updated` ⇒ per-field `{old,new}` diffs. |
| `created_at` | timestamptz | When. |

**Written by:** the `log_order_event` trigger on every insert/update of
`orders`. **Read by:** admin (order history / full audit). Read-only RLS.

### `site_events` — funnel beacons (PII-free)
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | bigint identity PK | Row id. |
| `kind` | text | `visit` (page loaded) · `chat_open` (concierge panel opened) · `checkout_open` (register sheet opened). Checked constraint. |
| `visit_key` | text | Random device token (`feier-visit`) — the funnel's unique-visitor key. **No IP, no email, no name.** |
| `session_key` | text | The chat session in play, when one exists (joins to `concierge_conversations.session_key`). |
| `section` | text | Page section at the event. |
| `via` | text | `checkout_open` only: `concierge` (the concierge's commission button opened the sheet) or `page`. |
| `created_at` | timestamptz | Event time — the funnel's date basis. |

**Written by:** the concierge function's rate-limited `POST ?track=1` (beacons
from `concierge.js` and `checkout.js`; always answers 204). **Read by:** admin
(Conversion tab funnel). Admin-read RLS; pruned by `prune_high_write` with the
other high-write tables. Full metric semantics in
[`ATTRIBUTION.md`](../ATTRIBUTION.md).

### `concierge_goals` — admin-defined conversation goals
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id. |
| `slug` | text unique | Goal handle (keys into `goal_status`). |
| `label` | text | Short name (admin scorecard). |
| `description` | text | What "met" means; injected so the bot pursues it. |
| `enabled` | boolean | Only enabled goals are pursued/scored. |
| `sections` | text[] | Journey stages (page sections) this goal fits; the bot leads with it when the visitor is in ANY of them. Empty/null = anywhere. **Source of truth** — the admin edits it as checkboxes. |
| `section` | text | Legacy single-section column, kept as a back-compat mirror of `sections[0]`; `goalSections()` prefers `sections`. |
| `sort_order` | int | Display order. |
| `updated_at` | timestamptz | Last edit. |

**Written by:** admin (Procedures → Conversation goals). **Read by:**
`buildSystemPrompt` (the bot pursues them) and `evaluateGoals` (the judge
scores each into `concierge_conversations.goal_status`). **Seeded by:**
`setup.sql` — **seven starter goals**: six base goals (in a `where not exists`
block, only if the table is empty) plus `house-notes`, seeded separately with
`on conflict do nothing` so it lands in already-seeded databases too. The judge's
output budget scales with this count (`320 + goals×160`), so adding goals never
truncates its per-goal JSON.

### `concierge_tools` — admin overrides for the model-callable tools
| Column | Type | Purpose |
| --- | --- | --- |
| `name` | text PK | Must match a built-in tool name (from the function's `REGISTER_TOOLS`). |
| `enabled` | boolean | `false` withholds the tool from the model entirely. Default `true`. |
| `description` | text | Non-empty → overrides the model-facing instruction; null/blank → built-in default. |
| `sort_order` | int | Reserved for display ordering. |
| `updated_at` | timestamptz | Last edit. |

The built-in tool **set** lives in code (`REGISTER_TOOLS`); this table only holds
**deviations** from the defaults, so an absent row means "enabled, default
instruction." **Written by:** admin (Tools tab). **Read by:** `loadConciergeData`
→ `buildToolsForModel` merges it over the code defaults before the `tools` array
is sent to the model (disabled dropped, descriptions overridden). The admin Tools
tab reads the built-in catalog from `GET ?tools=1` and the live override state
straight from this table. No seed — every tool starts at its default.

### `concierge_evals` — behavior-eval scenarios (studio Evals tab)
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | — |
| `slug` | text UNIQUE | Stable name (used as the scenario key in results). |
| `name` | text | Human label shown in the panel. |
| `description` | text | What the scenario proves. |
| `signed_in` | boolean | `true` → runs against a signed-in session (the admin's own in the panel; `EVAL_TOKEN` in the CLI). |
| `context` | jsonb | Browsing context sent with each turn, e.g. `{"section":"reserve","device":"desktop"}`. |
| `turns` | jsonb | `[{ "user": "...", "checks": [ {"includes":"…"}, {"maxQuestions":1}, {"judge":"…"} ] }]`. Check kinds: `includes`/`excludes`/`regex`/`notRegex`/`maxQuestions`/`toolCalled` (deterministic) and `judge` (binary LLM). |
| `enabled` | boolean | `false` → skipped in a "run enabled" pass. |
| `sort_order` | int | Display order. |
| `updated_at` | timestamptz | Last edit. |

**Written by:** admin (Evals tab CRUD). **Read by:** the panel runner (direct
RLS select) and, for the CLI, `GET ?evals=1`. The deterministic checks run in the
browser; the `judge` checks go to the admin-gated `POST ?judge=1`, which runs a
pinned binary judge server-side (so the Anthropic key stays off the client).
Seeded with a starter deck (only when empty), mirroring `evals/scenarios.mjs`.

---

## Functions (RPCs) — all `security definer`, `search_path = ''`

| Function | Signature | What it does | Called by |
| --- | --- | --- | --- |
| `is_concierge_admin()` | → bool | True if the JWT email is in `concierge_admins`. | Every admin RLS policy. |
| `is_super_admin()` | → bool | True if the JWT email is the super admin. | `concierge_admins` delete/update policies. |
| `hold_serial(p_session)` | → (serial, expires_at) | Reserves the **lowest free** number for a visit — refresh own hold, else claim a lapsed hold, else draw from `allocation_counter`. `FOR UPDATE SKIP LOCKED`. | commission `?hold=1`. |
| `commission_order(…13 args)` | → int | Places an order: consume this visit's hold (or a lapsed one, or a fresh number), insert the order, return the serial. `-1` when the edition is full. **Self-heals a serial collision:** if the chosen number is already on the register (counter/hold drift), it catches the `unique_violation` and advances to the next free serial (`max(serial)+1`, counter kept ahead) instead of failing placement. | commission POST. |
| `cancel_order_return(p_serial,p_user_id,p_email)` | → text | Cancels a `placed` order the caller owns: sets `status='cancelled'`, moves `serial`→`cancelled_serial`, and re-inserts the number as a lapsed hold so it's reclaimable. | concierge `cancel_order` tool. |
| `match_cached_answer(query_embedding, match_threshold)` | → rows | Nearest cached answer above threshold; increments `hits`. Operator is `operator(extensions.<#>)`-qualified because `search_path=''`. | concierge chat (cache lookup), `?cachecheck`. |
| `log_order_event()` | trigger | Writes `order_events`: full row on insert, field diffs on update. | Trigger `orders_audit` on `orders`. |
| `rate_hit(p_key, p_limit, p_window_seconds)` | → bool | Counts one request for `p_key` in the current fixed window (atomic upsert into `rate_limits`) and returns true when over `p_limit`. Shared across all edge instances. | both functions' rate limiters. |
| `get_edition()` | → (next, run, claimed, remaining) | Reads the edition counter. Raises unless `is_concierge_admin()`. | admin Edition card. |
| `set_edition(p_next_serial, p_run_size)` | → void | Sets `next_serial`/`run_size` (validates `next ≤ run+1`). Raises unless `is_concierge_admin()`. | admin Edition card. |

`EXECUTE` on the register/cache RPCs is revoked from
`public`/`anon`/`authenticated`; only the service role calls them. The two
edition RPCs are the exception — granted to `authenticated` (they self-gate on
`is_concierge_admin()`) so the admin studio can call them with the user's JWT.

---

## HTTP endpoints

The backend is **two Deno edge functions**. The browser holds only the
publishable key and talks to these; the functions hold the secrets and talk to
Anthropic, Postgres (service role, so they bypass RLS by design), and Resend.
Every entrypoint is gated **public** / **signed-in** (verified JWT) / **admin**
(`is_concierge_admin`) / **service** (bearer = service-role key).

```mermaid
flowchart LR
  A["Storefront widget<br/>anon · or signed-in JWT"]
  B["Admin studio<br/>admin JWT"]
  I["concierge internal<br/>service-role key"]

  subgraph CONCIERGE["concierge — Deno edge function"]
    direction TB
    CP["PUBLIC (rate-limited)<br/>?config · ?site · ?selftest<br/>POST chat · ?reengage · ?wrapup"]
    CU["SIGNED-IN<br/>?starters · POST ?form"]
    CA["ADMIN<br/>?tools · ?evals · ?secrets · ?export<br/>?cachecheck · POST ?judge · ?regrade"]
  end

  subgraph COMMISSION["commission — Deno edge function"]
    direction TB
    MP["PUBLIC (rate-limited)<br/>?recent · ?next<br/>POST ?hold · ?waitlist"]
    MU["SIGNED-IN<br/>?me · POST place-order"]
    MA["ADMIN<br/>?fulfill · ?editaddr · ?editbilling · ?resend"]
    MS["SERVICE ONLY<br/>?custresend"]
  end

  ANT["Anthropic Claude<br/>streaming + tool use"]
  PG[("Postgres + RLS<br/>service role")]
  RS["Resend<br/>email"]

  A --> CP
  A --> CU
  B --> CA
  A --> MP
  A --> MU
  B --> MA
  I --> MS

  CP --> ANT
  CA --> ANT
  CONCIERGE --> PG
  COMMISSION --> PG
  COMMISSION --> RS
  CP --> RS
```

*Gate legend:* **PUBLIC** = no auth (abuse-bounded by per-IP rate limits);
**SIGNED-IN** = verified user JWT, own data only; **ADMIN** = JWT email in
`concierge_admins`; **SERVICE** = server-to-server only, unreachable from a
browser.

### Browser access — CORS & allowed origins

Before any gate above, a request from a browser must pass a **CORS origin check**.
Both functions read a comma-separated **`ALLOWED_ORIGINS`** allowlist and echo
`Access-Control-Allow-Origin` **only** when the request's `Origin` is on it;
otherwise the browser blocks the response (this is what surfaces as the widget's
"the line to the mill is quiet"). It is **browser-enforced defense-in-depth** — it
stops *other sites'* pages from calling the API on a visitor's behalf, but does
**not** stop a direct `curl` (rate limits + the auth gates do that).

```mermaid
flowchart LR
  A["feier-abend.co"] --> CK
  B["www.feier-abend.co"] --> CK
  C["maniwar.github.io<br/>(GitHub Pages)"] --> CK
  X["any other origin"] -. blocked .-> CK
  CK{"Origin in<br/>ALLOWED_ORIGINS?"}
  CK -->|yes → echo Origin| GATE["auth gate<br/>(public / signed-in / admin)"]
  CK -->|no → no ACAO header| BLK["browser drops the response"]
  GATE --> FN["concierge / commission"]
```

**`ALLOWED_ORIGINS` is an ops-level deploy secret, not admin-editable** — it's set
by the **Deploy Concierge** workflow (`supabase secrets set ALLOWED_ORIGINS="…"`,
project-wide, so it covers both functions) and is deliberately kept out of the
admin panel because it's a security boundary. To add or change an origin, edit the
allowlist in `.github/workflows/deploy-concierge.yml` and re-run the workflow;
setting it in the dashboard alone is overwritten on the next deploy. Current
allowlist: `https://feier-abend.co`, `https://www.feier-abend.co`,
`https://maniwar.github.io`.

### concierge (`functions/concierge/index.ts`)
| Method / query | Handler | Gate | Purpose |
| --- | --- | --- | --- |
| `GET ?config=1` | `handleConfigGet` | public | Bootstrap: enabled, greeting, starters, forms, images, outreach timings, assertiveness. |
| `GET ?site=1` | `handleSiteGet` | public | Storefront CMS slot values (`site_content`) for the runtime hydrator + head bake. |
| `GET ?selftest=1` | `handleSelfTest` | public (tiered) | Diagnostics: recognition, schema presence, attribution, the exact CUSTOMER block. Per-user + admin detail are gated; anon sees only schema presence + counts. |
| `POST` (chat) | `handleChatPost` | public (rate-limited) | Streaming reply (SSE). Nudges, **proactive openers** (`context.opener`), tools (incl. `recall_context`), cache, logging, goal scheduling. |
| `POST ?reengage=1` | `handleReengage` | public (rate-limited) | One short goal-/journey-aware outreach line for the closed-panel bubble (90-token cap; client fallback if unavailable). |
| `POST ?wrapup=1` | `handleWrapup` | public (rate-limited) | Records a conversation closed/snoozed. Body `{session_key, reason}` (`quiet`→snoozed, `close`/`auto`→closed). Stamps `status`+`ended_at` **once**; adds one `customer_notes` line for a signed-in patron. |
| `GET ?starters=1` | `handleStartersGet` | signed-in | Personalized starters built deterministically from the caller's real orders; `[]` when anonymous or no orders. |
| `POST ?form=1` | `handleFormPost` | signed-in | Structured form submission (verified JWT, routed through `submit_tool`, ownership-scoped). |
| `GET ?tools=1` | `handleToolsGet` | **admin** | The built-in tools manifest (name, enabled, core, effective + default instruction, overridden) for the admin Tools tab. |
| `GET ?evals=1` | `handleEvalsGet` | **admin** | The enabled behavior-eval deck (`concierge_evals`), shaped like `evals/scenarios.mjs`, so the CLI runner can share the DB deck (`--remote`). |
| `GET ?secrets=1` | `handleSecretsGet` | **admin** | Server-secret **presence** (booleans only, never values) + build tag + model-in-effect, for the studio's Keys & connection readout. |
| `GET ?export=1` | `handleExportGet` | **admin** | **Streaming** transcript export: keyset-paginates conversations and streams a CSV (one row per message, `user` pseudonymized unless `?pii=1`; `?from`/`?to` date bounds). Columns include the conversation's `section`, `sales_stage`, `goals_met`, `goals_total`, the full `goal_status` JSON (repeated per message row), and each message's `rating` (up/down) + `rating_note` from `concierge_feedback`, so grades, funnel, and thumbs travel with the transcript. Bounded memory on both ends — the scalable export tier (see note below). |
| `GET ?cachecheck=1` | inline | **admin** | Self-diagnosis of the semantic cache round-trip (writes+deletes a probe row, so admin-gated). |
| `POST ?judge=1` | `handleJudgePost` | **admin** | The pinned binary LLM judge server-side: `{criterion, transcript}` → `{pass, reason}`. Keeps the Anthropic key off the browser; used by the panel + CLI eval runners. |
| `POST ?regrade=1` | `handleRegradePost` | **admin** | Re-run **goal grading** on demand for `{conversation_id}` or `{ids:[…]}` (≤30) — the Conversations panel's "Re-grade goals" / "Re-grade shown" buttons, so grading isn't only the sampled async pass. Returns `{graded, requested, empty, failed}`: `graded` counts real scorecard writes (`evaluateGoals` returns a success boolean), `empty` = chats with no messages, `failed` = judge ran but wrote nothing (transient). The per-chat button auto-retries once on `failed`. |
| `POST ?consolidate=1` | `handleConsolidatePost` | **admin** | Force-regenerate one patron's rolling **client summary** (`kind='summary'` note). Body `{email?, user_id?}`. Runs `consolidateClientBook(..., {force:true})` and returns `{ok, summary}` — the drawer's **Regenerate** button. (The same helper also runs automatically in the background after a signed-in turn once ~8 new notes have accrued.) |

**SSE frames** (chat): `{"t":…}` text, `{"s":…}` status, `{"m":{cid,mid}}`
meta, `{"c":…}` cache marker, `{"hold":1}` a held nudge, then `[DONE]`.

**Export tiers** (transcripts): the admin panel exports one open transcript or
the current filtered set entirely in the **browser** (bounded by memory); the
**`?export=1`** endpoint is the **streaming** tier — the server keyset-paginates
and streams the CSV, piped to disk via the File System Access API, so neither end
buffers the whole result. The next tier for warehouse-scale (not built) is an
**async COPY to a Storage bucket + signed URL**, which survives the function's
wall-clock limit.

### commission (`functions/commission/index.ts`)
| Method / query | Gate | Purpose |
| --- | --- | --- |
| `GET ?recent=1` | public | Recent real orders (serial + city/state only — no name/email) for the site ticker. |
| `GET ?next=1` | public | The live edition figures: `{next_serial, run_size, remaining}` (drives the ticker). |
| `GET ?me=1` | signed-in | Signed-in patron's standing + latest entry + **`saved_addresses[]`** (the managed `customer_addresses` book, backfilled from history if empty) + derived fallbacks **`addresses[]`** / **`billing_addresses[]`** for checkout prefill (`Cache-Control: no-store`). Address entry: `{id?, key?, label, is_gift, recipient_name, name?, address, address2, city, state, zip}`. See DESIGN §4.12. |
| `GET ?addresses=1` | signed-in | The patron's managed address book (`customer_addresses`), backfilled from history on first read. For a refresh after add/remove. `no-store`. |
| `POST ?address_save=1` | signed-in | Add or edit one saved address: `{id?, label, is_gift, recipient_name?, address, address2?, city, state, zip}`, validated. Update is ownership-scoped. Returns the refreshed `addresses[]`. |
| `POST ?address_delete=1` | signed-in | Remove one saved address: `{id}`, ownership-scoped. Returns the refreshed `addresses[]`. |
| `POST ?hold=1` | public (rate-limited) | Reserve the visit's serial (`hold_serial`). |
| `POST` | signed-in (rate-limited) | Place the order (`commission_order`) with the **verified** email; emails a confirmation (best-effort, `EdgeRuntime.waitUntil`). |
| `POST ?waitlist=1` | public (rate-limited) | Join the waitlist: `{email, name?, colorway?, note?, source?}` → inserts a `waitlist` row (links `user_id` if signed in). |
| `POST ?fulfill=1` | **admin** | Advances `status`, sets `tracking`; emails the customer on `shipped`/`returned`. |
| `POST ?editaddr=1` | **admin** | Correct a shipping address on a not-yet-shipped order (validated field-by-field). |
| `POST ?editbilling=1` | **admin** | Set/clear an order's **billing** address (the `orders.billing` jsonb): `{serial, address,…}` or `{serial, same_as_shipping:true}`. Validated; editable at any status (it's a record, not a shipping instruction). |
| `POST ?resend=1` | **admin** | Re-send an order email: `{serial, kind}` → rebuilds from the order and sends, logging to `email_log`. |
| `POST ?custresend=1` | **service** | Bearer = `SUPABASE_SERVICE_ROLE_KEY`; no browser can reach it. Re-send an order email on a customer's behalf; called internally by the concierge's `resend_confirmation` tool **after** it has verified the signed-in owner owns the order; guards `kind` against the order's real status. |

Transactional email uses Resend (`RESEND_API_KEY`, optional `EMAIL_FROM`,
default `Feierabend <concierge@feier-abend.co>` — an address on the verified
Resend domain, so real recipients receive it). Override `EMAIL_FROM` for a
different sender — see SETUP.md.

---

## Conversation lifecycle (the "mix of both")

Closing/snoozing a conversation is driven by **both** the customer's own
signal and the bot winding down — recorded through the one `?wrapup=1`
endpoint:

1. **Customer-explicit** (client `assets/concierge.js`): the header `⋯` menu
   offers *"Don't message me until I write back"* (→ `enterQuietMode`, reason
   `quiet`, sets in-tab **quiet mode** that suppresses all nudges/outreach) and
   *"That's all for now"* (→ `wrapUpByCustomer`, reason `close`).
2. **Bot-automatic**: dismissing the panel or leaving the tab after a real
   exchange fires `doWrapup('auto')`.

`doWrapup` records the wrap **once** (`wrappedUp` guard), then rotates the
`session_key` so the **next** message opens a fresh conversation. On the
server, `customerBlock` reads the most recent `ended_at` for a signed-in
patron and injects a **RE-ENGAGEMENT** line, so the returning visit is greeted
as continuity, not a cold open. The visitor writing again clears quiet mode
and begins the new (re-engaged) thread.

**When things get recorded:** a conversation is only marked ended once there
has been a genuine exchange (a visitor turn *and* a bot turn). Until then there
is nothing to wrap. After `ended_at` is set, that thread is immutable to
further wrap-ups; new activity lives in a new thread.
