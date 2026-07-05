# Database Schema Reference — Feierabend (Decke 01)

This is the field-by-field reference for the whole backend: every table, every
column, what writes it, what reads it, and when. The schema itself is defined
in **`setup.sql`** (one idempotent file) and mirrored as ordered history in
**`migrations/`**. Keep this document in step with those files whenever a
column, function, or endpoint changes.

Two Supabase Edge Functions use this database:

| Function | Folder | Role |
| --- | --- | --- |
| **concierge** | `functions/concierge/` | The AI sales concierge — streaming chat, register tools, semantic cache, conversation logging, goals, lifecycle. |
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

### `concierge_config` — runtime settings (key → jsonb)
One row per setting. Cached in the function for 60s, so edits reach live
traffic within a minute.

| Column | Type | Purpose |
| --- | --- | --- |
| `key` | text PK | Setting name (see keys below). |
| `value` | jsonb | The setting's value. |
| `updated_at` | timestamptz | Last edit. |

**Keys the concierge reads** (`loadConciergeData`): `enabled` (bool — false ⇒
chat returns 503 and `?config=1` reports resting), `model` (Anthropic model id,
overrides the `MODEL` env var), `max_tokens` (per-reply cap, default 1024),
`greeting` (opening line; may embed `{{reply:…}}` pills), `voice_notes`
(appended to the system prompt as tuning notes), `starters` (per-section
suggested questions), `outreach`/`nudge*` (timings the client reads via
`?config=1`).
**Written by:** admin portal (Config tab). **Read by:** `handleConfigGet`
(`GET ?config=1`), `handleChatPost` (every reply). **Seeded by:** `setup.sql`
(`enabled`, `model`, `max_tokens`, `greeting`, `voice_notes`).

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

**Written by:** `logUserTurn` (create + identity back-fill), `handleWrapup`
(status/ended_at), `evaluateGoals` (goal_status). **Read by:** `logUserTurn`
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
| `chat_session` | text | The `session_key` of the concierge conversation that drove the sale (revenue attribution). | placement |
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
| `action` | text | Tool name (`get_my_orders`, `recall_context`, `update_colorway`, `cancel_order`, `remember_customer`, …). |
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
| `note` | text | One durable observation (≤240 chars). |
| `created_at` | timestamptz | When learned. |

Clienteling memory that travels with the customer. **Written by:** the
`remember_customer` tool (what the bot learned) and `handleWrapup` (a terse
line recording the wind-down: quiet mode / closed / wound down). **Read by:**
`customerBlock` (last 8 notes feed the CLIENT BOOK line in the prompt), admin
(Customers → client book, ❦ badge).

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

### `concierge_goals` — admin-defined conversation goals
| Column | Type | Purpose |
| --- | --- | --- |
| `id` | uuid PK | Row id. |
| `slug` | text unique | Goal handle (keys into `goal_status`). |
| `label` | text | Short name (admin scorecard). |
| `description` | text | What "met" means; injected so the bot pursues it. |
| `enabled` | boolean | Only enabled goals are pursued/scored. |
| `sort_order` | int | Display order. |
| `updated_at` | timestamptz | Last edit. |

**Written by:** admin (Procedures → Conversation goals). **Read by:**
`buildSystemPrompt` (the bot pursues them) and `evaluateGoals` (the judge
scores each into `concierge_conversations.goal_status`). **Seeded by:**
`setup.sql` (six starter goals, only if the table is empty).

---

## Functions (RPCs) — all `security definer`, `search_path = ''`

| Function | Signature | What it does | Called by |
| --- | --- | --- | --- |
| `is_concierge_admin()` | → bool | True if the JWT email is in `concierge_admins`. | Every admin RLS policy. |
| `is_super_admin()` | → bool | True if the JWT email is the super admin. | `concierge_admins` delete/update policies. |
| `hold_serial(p_session)` | → (serial, expires_at) | Reserves the **lowest free** number for a visit — refresh own hold, else claim a lapsed hold, else draw from `allocation_counter`. `FOR UPDATE SKIP LOCKED`. | commission `?hold=1`. |
| `commission_order(…13 args)` | → int | Places an order: consume this visit's hold (or a lapsed one, or a fresh number), insert the order, return the serial. `-1` when the edition is full. | commission POST. |
| `cancel_order_return(p_serial,p_user_id,p_email)` | → text | Cancels a `placed` order the caller owns: sets `status='cancelled'`, moves `serial`→`cancelled_serial`, and re-inserts the number as a lapsed hold so it's reclaimable. | concierge `cancel_order` tool. |
| `match_cached_answer(query_embedding, match_threshold)` | → rows | Nearest cached answer above threshold; increments `hits`. Operator is `operator(extensions.<#>)`-qualified because `search_path=''`. | concierge chat (cache lookup), `?cachecheck`. |
| `log_order_event()` | trigger | Writes `order_events`: full row on insert, field diffs on update. | Trigger `orders_audit` on `orders`. |
| `get_edition()` | → (next, run, claimed, remaining) | Reads the edition counter. Raises unless `is_concierge_admin()`. | admin Edition card. |
| `set_edition(p_next_serial, p_run_size)` | → void | Sets `next_serial`/`run_size` (validates `next ≤ run+1`). Raises unless `is_concierge_admin()`. | admin Edition card. |

`EXECUTE` on the register/cache RPCs is revoked from
`public`/`anon`/`authenticated`; only the service role calls them. The two
edition RPCs are the exception — granted to `authenticated` (they self-gate on
`is_concierge_admin()`) so the admin studio can call them with the user's JWT.

---

## HTTP endpoints

### concierge (`functions/concierge/index.ts`)
| Method / query | Handler | Purpose |
| --- | --- | --- |
| `GET ?config=1` | `handleConfigGet` | Public bootstrap: enabled, greeting, starters, forms. |
| `GET ?cachecheck=1` | inline | Self-diagnosis of the semantic cache round-trip. |
| `POST` (chat) | `handleChatPost` | Streaming reply (SSE). Handles nudges, **proactive openers** (`context.opener` = `reengage`/`greet` — the bot speaks first on panel open), tools (incl. `recall_context` to pull prior notes/conversation), cache, logging, goal scheduling. |
| `POST ?wrapup=1` | `handleWrapup` | **Records a conversation as closed/snoozed.** Body `{session_key, reason}` where reason is `quiet` (→ snoozed), `close` or `auto` (→ closed). Stamps `status`+`ended_at` **once** (already-ended threads are left alone), and for a signed-in patron adds one `customer_notes` line. |
| `POST ?form=1` | `handleFormPost` | Structured form submission (verified JWT, routed through `submit_tool`). |

**SSE frames** (chat): `{"t":…}` text, `{"s":…}` status, `{"m":{cid,mid}}`
meta, `{"c":…}` cache marker, `{"hold":1}` a held nudge, then `[DONE]`.

### commission (`functions/commission/index.ts`)
| Method / query | Purpose |
| --- | --- |
| `GET ?recent=1` | Recent real orders (for the site ticker). |
| `GET ?next=1` | The live edition figures: `{next_serial, run_size, remaining}` (drives the ticker). |
| `GET ?me=1` | Signed-in patron's orders + shipping details, for checkout prefill. |
| `POST ?hold=1` | Reserve the visit's serial (`hold_serial`). |
| `POST` | Place the order (`commission_order`); emails a confirmation (best-effort, `EdgeRuntime.waitUntil`). |
| `POST ?fulfill=1` | **Admin only** (`verifyUser` + `is_concierge_admin`). Advances `status`, sets `tracking`; emails the customer on `shipped`/`returned`. |

Transactional email uses Resend (`RESEND_API_KEY`, optional `EMAIL_FROM`,
default `Feierabend <onboarding@resend.dev>`). With the default Resend sender,
delivery is limited to the Resend account's own address until a domain is
verified — see SETUP.md.

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
