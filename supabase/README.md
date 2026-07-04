# Concierge Backend — Setup

The AI sales concierge on the site talks to a Supabase Edge Function
(`supabase/functions/concierge/`), which proxies streaming chat to the
Anthropic API. The API key lives only in Supabase — never in the browser
or the repo.

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
at 1024). If you want it even cheaper, set a `MODEL` env var on the function
to a cheaper model, e.g.:

```bash
supabase secrets set MODEL="claude-haiku-4-5"
```

## Security

`ALLOWED_ORIGINS` (set by the workflow to `https://maniwar.github.io`)
restricts which **browsers** may call the function via CORS — it does not
stop direct `curl` calls. Abuse is bounded by the built-in rate limit
(**20 requests per 10 minutes per IP**) and the `max_tokens: 1024` cap on
each response. Watch your Anthropic usage dashboard; if usage looks wrong,
rotate the API key (create a new one, update the `ANTHROPIC_API_KEY` repo
secret, re-run the deploy, then revoke the old key).

## v2 — config, knowledge base, logging, accounts

v2 keeps the entire v1 wire contract (`data: {"t":...}` chunks, `data: [DONE]`,
CORS via `ALLOWED_ORIGINS`, the 20 req / 10 min rate limit) and layers a
database on top. The schema lives in **`supabase/migrations/0001_concierge.sql`**
— apply it with the Supabase MCP server or `supabase db push` before deploying
the v2 function. The function reads the DB with the service-role key over raw
PostgREST (no supabase-js) and caches config + KB in memory for **60 seconds**,
so admin edits take up to a minute to reach live traffic.

### Config — `concierge_config` (key / jsonb value)

| key | effect |
| --- | --- |
| `enabled` (bool) | `false` → chat POSTs return 503 ("The concierge is resting…") and `?config=1` reports `enabled: false` so the widget shows a resting state |
| `model` (string) | Anthropic model id for replies. Takes precedence over the `MODEL` env var; final fallback is `claude-sonnet-4-5` |
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
validation message), `405` (non-POST), `429` (rate limit — **10 requests per
10 minutes per IP**), `502` ("The register is briefly unavailable. Nothing
was recorded — try again.") when the RPC fails.

Optionally send `Authorization: Bearer <Supabase user JWT>` to link the order
to the signed-in account (the bare anon key does not count; invalid tokens
simply mean an anonymous order — never an error).

### Data minimization by design

The commission stores **only**: email, name, city + state, colorway (plus
the assigned serial and a `placed` status). No street address (nothing
ships), no phone number, no payment data of any kind (nothing is charged),
no analytics fields. City/state exist purely so the concierge can answer
"where is my blanket headed?"; the CCPA-minded stance is that data never
collected never needs safeguarding or disclosure. Deletion requests:
hello@feierabend.example.

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

The **Deploy Concierge** GitHub Action deploys **only the concierge
function** — it does not deploy this one. Apply the migration first
(Supabase MCP server or `supabase db push`), then deploy the function with:

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
