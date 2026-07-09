# Concierge Backend — Setup

The AI sales concierge on the site talks to a Supabase Edge Function
(`supabase/functions/concierge/`), which proxies streaming chat to the
Anthropic API. The API key lives only in Supabase — never in the browser
or the repo.

## The database — one file

**`supabase/setup.sql`** is the single, idempotent setup for the whole
database. Paste it into the Supabase **SQL Editor** and Run. It is safe on a
fresh project, safe on a partially-configured one, and safe to run again —
every statement creates only what is missing, so it always brings the schema
to the state the edge functions expect. Change the admin email near the
bottom (`insert into public.concierge_admins …`) to your own before running.

`setup.sql` now includes **all** the seed content too — config, the full
knowledge base, every SOP, forms, and goals — so this one file provisions a
complete, working system on its own. Each content block seeds only if its table
is empty, so re-running never overwrites edits made in the admin Studio.

The `supabase/migrations/` folder holds the same schema as an ordered history
for `supabase db push` and CI. You don't need to run those files on a fresh
project — `setup.sql` covers everything. (The older `APPLY_NOW_*.sql` snippets
were folded into `setup.sql` and removed.)

**`supabase/SCHEMA.md`** is the field-by-field reference for the whole
database — every table and column, what writes it, what reads it, and when,
plus the RPCs, HTTP endpoints, and the conversation lifecycle. Update it
alongside any schema change so the backend stays explainable.

## Setup

1. **Create a free Supabase project** at [supabase.com](https://supabase.com).
   Note the **project ref** (the short ID in the project URL, e.g.
   `abcdefghijklmnop` in `https://supabase.com/dashboard/project/abcdefghijklmnop`).

2. **Create a Supabase access token**: dashboard → your account (top right)
   → **Access Tokens** → generate a new token.

3. **Add GitHub repo secrets** (repo → Settings → Secrets and variables →
   Actions):
   - `SUPABASE_ACCESS_TOKEN` — the token from step 2
   - `SUPABASE_PROJECT_REF` — the project ref from step 1
   - `ANTHROPIC_API_KEY` — your Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

4. **Run the deploy**: repo → Actions → **Deploy Concierge** → Run workflow.
   The workflow links the project, sets the function secrets, deploys the
   function, and prints the endpoint URL in its final step.

5. **Wire up the front end**: copy the printed endpoint
   (`https://<project-ref>.supabase.co/functions/v1/concierge`) into the
   `FEIER_CONCIERGE_CONFIG` line near the bottom of `index.html` (the
   `endpoint` field) and push.

6. **Verify** with curl — this matches the wire contract the front end uses:

   ```bash
   curl -N "https://<project-ref>.supabase.co/functions/v1/concierge" \
     -H "Content-Type: application/json" \
     -d '{
       "messages": [{"role": "user", "content": "Is the wool section still available?"}],
       "context": {"section": "wool", "claimed": 14213, "remaining": 787,
                   "slot": "14,214", "holdClock": "09:12", "loomClock": "2d 4h 10m"}
     }'
   ```

   You should see a stream of Server-Sent Events:

   ```
   data: {"t":"Yes — "}

   data: {"t":"thread 14,214 in the wool section is"}

   data: {"t":" still yours to claim..."}

   data: [DONE]
   ```

## Cost

A typical answer costs well under a cent (short prompts, `max_tokens` capped
at 1024). The model is normally chosen in the Studio (Tuning → Model / Fallback
model); the `MODEL` env var is the ops-level fallback used only when neither
config value is set (or the config read fails):

```bash
supabase secrets set MODEL="claude-haiku-4-5-20251001"
```

## Security

`ALLOWED_ORIGINS` (set by the workflow to the site origins —
`https://feier-abend.co,https://www.feier-abend.co,https://maniwar.github.io`)
restricts which **browsers** may call the function via CORS — it does not
stop direct `curl` calls. Abuse is bounded by the built-in rate limit —
**buyer-aware**: anonymous traffic gets 20 requests per 10 minutes per IP,
a signed-in email-verified patron gets their own window keyed by user id
(default 60; both admin-tunable via `chat_rate_anon` / `chat_rate_signed`
in Tuning → Engagement pace → Service limits) — and the `max_tokens: 1024`
cap on each response. Watch your Anthropic usage dashboard; if usage looks wrong,
rotate the API key (create a new one, update the `ANTHROPIC_API_KEY` repo
secret, re-run the deploy, then revoke the old key).

## v2 — config, knowledge base, logging, accounts

v2 keeps the entire v1 wire contract (`data: {"t":...}` chunks, `data: [DONE]`,
CORS via `ALLOWED_ORIGINS`, the buyer-aware rate limit above) and layers a
database on top. The schema lives in **`supabase/migrations/0001_concierge.sql`**
— apply it with the Supabase MCP server or `supabase db push` before deploying
the v2 function. The function reads the DB with the service-role key over raw
PostgREST (no supabase-js) and caches config + KB in memory for **60 seconds**,
so admin edits take up to a minute to reach live traffic.

### Config — `concierge_config` (key / jsonb value)

| key | effect |
| --- | --- |
| `enabled` (bool) | `false` → chat POSTs return 503 ("The concierge is resting…") and `?config=1` reports `enabled: false` so the widget shows a resting state |
| `model` (string) | Anthropic model id for replies. Resolution order (`resolveModel()`): `model` → `model_fallback` → `MODEL` env var → the built-in default (`claude-haiku-4-5-20251001`). |
| `model_fallback` (string) | Model used when `model` is blank — lets you set the fallback from the Studio without a redeploy. Only the last-resort default is compiled in. |
| `max_tokens` (number) | per-reply output cap (default 1024) |
| `greeting` (string) | opening line the widget shows before the first message |
| `voice_notes` (string) | appended to the system prompt as `ADMIN TUNING NOTES (follow these):` — tune tone/emphasis without redeploying |
| `starters` (object) | suggested questions per section, e.g. `{"wool": ["Is it soft?", ...]}` |

### Editable knowledge base — `concierge_kb`

Rows of (`slug`, `title`, `content_md`, `sort_order`, `enabled`). Enabled rows
are concatenated (`## <title>` + content, ordered by `sort_order`) into the
`{{KB}}` slot of the system prompt. If the table is empty or the DB is
unreachable, the function falls back to the knowledge compiled into
`functions/concierge/kb.ts`, so the concierge never goes blank.

### Conversation logging — `concierge_conversations` / `concierge_messages`

Each chat POST resolves a conversation — the optional `session_key` body field
(≤ 64 chars) threads repeat requests into one conversation; the signed-in
user's id/email and the page section are stored on it — then logs the user
message and, after the stream completes, the assistant reply (full text, model
used, `latency_ms`). Just before `data: [DONE]`, the stream emits a meta event
`data: {"m":{"cid":"<conversation id>","mid":<message id>}}` so the front end
can reference the exact rows. Logging failures never break the stream.

### Feedback — `concierge_feedback`

The front end inserts feedback rows (thumbs up/down on an answer) **directly
with the anon key** — an insert-only RLS policy in the migration allows that
and nothing else. Rows carry the conversation/message ids taken from the meta
event above; review them in the admin portal.

### Signed-in order awareness

If the browser sends a Supabase Auth JWT (`Authorization: Bearer <jwt>` — the
bare anon key does not count), the function verifies it against
`/auth/v1/user`, then pulls the customer's `orders` rows (matched by `user_id`
or `email`, via the service role) and injects a line like
`CUSTOMER: jane@example.com (signed in). ORDERS: Nº 14213 — on the loom, …`
into the LIVE STATE block, so the concierge can answer "where is my blanket?"
per customer. Absent or invalid tokens simply mean an anonymous chat — never
an error.

### GET ?config=1

`GET https://<project-ref>.supabase.co/functions/v1/concierge?config=1`
returns `{"enabled":bool,"greeting":string|null,"starters":object|null,"auth":true}`
(public, CORS-enabled). The widget bootstraps from this — greeting, starter
chips, and whether to render at all.

### Admin portal

`/Blanket/admin.html` on the site edits the config keys and KB rows and
browses logged conversations and feedback. It talks to the same Supabase
project with a signed-in Supabase Auth account; write access is governed by
the policies in `supabase/migrations/0001_concierge.sql`.

## Commission endpoint (demo checkout)

A second edge function, **`supabase/functions/commission/`**, backs the
"commission" flow on the site. This is a **demo** — no product ships and **no
payment is collected**. A commission does exactly two things: atomically
assigns the next serial number and records a minimal order row.

### Wire contract

`POST https://<project-ref>.supabase.co/functions/v1/commission`

Request body (all fields required, trimmed server-side):

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "city": "Portland",
  "state": "OR",
  "colorway": "loden"
}
```

- `name` — 1–80 chars
- `email` — valid address, ≤ 120 chars
- `city` — 1–80 chars
- `state` — exactly two uppercase letters, one of the 50 US states or DC
- `colorway` — `ungefaerbt` | `loden` | `graphit`

Success — `200`:

```json
{ "serial": 14215, "name": "Jane Doe", "colorway": "loden", "email": "jane@example.com" }
```

Errors are JSON `{"error": "..."}` with CORS headers: `400` (specific
validation message), `405` (non-POST), `429` (rate limit — **buyer-aware**:
10 orders per 10 minutes per anonymous IP; a signed-in email-verified buyer
gets their own window of 30 keyed by user id), `502` ("The register is
briefly unavailable. Nothing was recorded — try again.") when the RPC fails.

Optionally send `Authorization: Bearer <Supabase user JWT>` to link the order
to the signed-in account (the bare anon key does not count; invalid tokens
simply mean an anonymous order — never an error). On a successful placement the
function emails the buyer a confirmation (best-effort; see **Transactional
email** below).

### Other endpoints

| Method / query | Purpose |
| --- | --- |
| `POST ?hold=1` | Reserve this visit's serial (`hold_serial`), returns `{serial, expires_at}`. |
| `GET ?next=1` | Live edition figures: `{next_serial, run_size, remaining}` (drives the storefront ticker). |
| `GET ?recent=1` | A few recent real orders for the ticker — **kept entries only** (a cancelled order's serial returned to the pool; returned orders are struck; neither is shown). |
| `GET ?me=1` | Signed-in buyer's orders + shipping, for checkout prefill (JWT required). |
| `POST ?fulfill=1` | **Admin only.** Advance an order's `status` and set `tracking`. |

**`POST ?fulfill=1`** requires a signed-in admin JWT — the function calls
`verifyUser` and checks the email against `concierge_admins` (mirrors
`is_concierge_admin()`); non-admins get `403`. Body:

```json
{ "serial": 14215, "status": "shipped", "tracking": "1Z999AA10123456784" }
```

`status` must be one of `placed`, `weaving`, `finishing`, `shipped`,
`delivered`, `returned`, `cancelled`. The two strikes are deliberately
different: **`cancelled`** is accepted only while the order is still `placed`
(the true cancel — the strike-and-release RPC frees the Nº back to the
edition's pool; later than that it answers `409` explaining to use `returned`
instead), while **`returned`** covers weaving-or-later strikes (refund; the
Nº stays woven into the cloth). On `shipped` (with tracking), `returned`, or
`cancelled` the buyer is emailed. This is what the admin studio's per-order
fulfillment control and bulk Strike button call.

### Transactional email

Order confirmation and shipment/return notices are sent via the **Resend HTTP
API** (not SMTP — that's only for auth magic links). Set `RESEND_API_KEY` and
optionally `EMAIL_FROM` (default `Feierabend <concierge@feier-abend.co>`, an
address on the verified Resend domain) as function secrets. Override `EMAIL_FROM`
to send from a different domain. Sending is best-effort and
fired via `EdgeRuntime.waitUntil`, so it never blocks or fails the response.

### Data minimization by design

The commission stores **only**: email, name, city + state, colorway (plus
the assigned serial and a `placed` status). No street address (nothing
ships), no phone number, no payment data of any kind (nothing is charged),
no analytics fields. City/state exist purely so the concierge can answer
"where is my blanket headed?"; the CCPA-minded stance is that data never
collected never needs safeguarding or disclosure. Deletion requests:
concierge@feier-abend.co.

### Counter table + RPC

`supabase/migrations/0004_commission.sql` adds:

- `public.orders` gains `name`, `state`, and `colorway` (checked against the
  three colorways).
- **`public.allocation_counter`** — a single-row table (`id = 1` enforced by
  a check constraint) holding `next_serial`, seeded at **14215** (the demo
  order already holds 14,214). RLS is enabled with **no policies** — only the
  service role touches it.
- **`public.commission_order(p_email, p_name, p_city, p_state, p_colorway,
  p_user_id) returns int`** — `security definer` with pinned empty
  `search_path`; locks the counter row `FOR UPDATE`, increments it, inserts
  the order with `status = 'placed'`, and returns the assigned serial.
  `EXECUTE` is revoked from `public`, `anon`, and `authenticated`; the edge
  function calls it with the service role.

### Deployment

The **Deploy Concierge** GitHub Action deploys **both** functions (concierge
and commission) and, when `SUPABASE_DB_PASSWORD` is set, runs `supabase db push`
first. After deploying, it runs a **live smoke test against the production
endpoints** (config fetch, an anonymous chat turn under the metrics-excluded
`qa-smoke-ci` session key, a re-engage call, and a commission validation
reject) — the workflow goes red if the deployed functions don't answer
correctly, so a green run means the live surface was actually exercised, not
just type-checked. To deploy this one by hand instead, apply migrations first
(Supabase MCP server or `supabase db push`), then:

```bash
supabase functions deploy commission --no-verify-jwt
```

or via the Supabase MCP server's deploy tool. It reads the same secrets the
project already has (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` are injected by the platform; `ALLOWED_ORIGINS`
is shared with the concierge).

### Verify with curl

```bash
curl -s "https://<project-ref>.supabase.co/functions/v1/commission" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Doe",
    "email": "jane@example.com",
    "city": "Portland",
    "state": "OR",
    "colorway": "loden"
  }'
```

Expected response:

```json
{"serial":14215,"name":"Jane Doe","colorway":"loden","email":"jane@example.com"}
```
