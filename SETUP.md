# Feierabend (Decke 01) — Setup & Verification

A runnable checklist to stand this project up and confirm it's wired correctly.
This is a **demo** — no real product ships and no payment is ever taken.

- **Live site:** https://maniwar.github.io/Blanket/
- **Design doc (the *why*):** [`DESIGN.md`](DESIGN.md)
- **Deep-dive docs:** [`supabase/README.md`](supabase/README.md) (backend) ·
  [`supabase/SCHEMA.md`](supabase/SCHEMA.md) (every table/field/RPC)

---

## Architecture at a glance

| Piece | Where | Deploys via |
| --- | --- | --- |
| Front end (site + admin) | `index.html`, `admin.html`, `assets/*` | **`deploy-pages.yml`** — automatic on every push |
| AI concierge | `supabase/functions/concierge/` | **`deploy-concierge.yml`** — manual/dispatch |
| Demo checkout | `supabase/functions/commission/` | same workflow (deploys both) |
| Database | Supabase Postgres | `supabase/setup.sql` (one file) |

The functions read the DB with the service-role key over PostgREST; the browser
uses the public **publishable** key. Auth is passwordless email (magic link).

---

## First-time setup

1. **Create a Supabase project** — note the project ref (in the dashboard URL).
2. **Apply the schema** — Supabase → **SQL Editor** → paste all of
   [`supabase/setup.sql`](supabase/setup.sql) → **Run**. It's idempotent (safe to
   re-run) and seeds config, goals, and the **super admin** (change the email near
   the bottom to yours first). For the large editable content (KB, SOPs, forms),
   run the ordered files in `supabase/migrations/` once, or `supabase db push`.
3. **Add GitHub repo secrets** (repo → Settings → Secrets and variables → Actions):
   `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `ANTHROPIC_API_KEY`. Optional:
   `RESEND_API_KEY` (+ optional `EMAIL_FROM`) to turn on transactional order email
   — the deploy sets them on the commission function. Without `RESEND_API_KEY`,
   orders still place; the emails are just skipped.
4. **Deploy the functions** — Actions → **Deploy Concierge** → Run workflow.
5. **Wire the front end** — in `index.html`, `FEIER_CONCIERGE_CONFIG` should hold
   your `endpoint`, `supabaseUrl`, and `supabaseAnonKey` (publishable). Push.
6. **Email (required for sign-in + guest checkout)** — configure **custom SMTP**
   (see below); the built-in Supabase sender is rate-limited to a few/hour.
7. **Auth URLs** — Supabase → Authentication → **URL Configuration**: Site URL
   `https://maniwar.github.io/Blanket/`, redirect `https://maniwar.github.io/Blanket/**`.

### Custom SMTP (Resend, free, ~5 min)
1. resend.com → create an account + an **API key** (Sending access).
2. Sender: use `onboarding@resend.dev` (sends only to your Resend account email —
   fine for solo testing) or verify your own domain for real sending.
3. Supabase → Authentication → **SMTP Settings** → Enable Custom SMTP:
   Host `smtp.resend.com`, Port `465`, Username `resend`, Password = API key,
   Sender = your address. Save.
4. Authentication → **Rate Limits** → raise emails/hour (now that it's your SMTP).

### Transactional order email (Resend API, optional)

Separate from auth email: order confirmations and shipment/return notices are
sent by the **commission function** through the Resend HTTP API, not SMTP.

1. Reuse the same Resend **API key** (or make a second one) as the
   `RESEND_API_KEY` GitHub secret.
2. `EMAIL_FROM` is optional; it defaults to `Feierabend <onboarding@resend.dev>`.
   With that default sender, Resend only delivers to **your own Resend-account
   email** — verify a domain and set `EMAIL_FROM` to an address on it to email
   real customers.
3. Re-run **Deploy Concierge** so the secrets land on the function.

---

## Verify it's working

### One command: type `selftest` in the concierge chat (signed in)
It prints a report. Confirm:

- [ ] `build` = the latest tag (e.g. `2026-07-05-persistent-engage+emailinvite`) → function is current
- [ ] `signed_in: true` → the widget's token is recognized
- [ ] `is_admin: true` → your email is in `concierge_admins` (admin panel will load)
- [ ] `schema` block all `ok` → **`setup.sql` fully applied**
- [ ] `orders.by_user_id` > 0 (if you've commissioned) → attribution works
- [ ] `customer_block` shows your name/standing/orders → the bot knows you

### Dashboard checks
- [ ] **SMTP** configured; a test **Sign in** email arrives in seconds
- [ ] **Auth → URL Configuration** has the site + redirect URLs above
- [ ] **Actions → Deploy Concierge** last run succeeded
- [ ] GitHub secret **`ANTHROPIC_API_KEY`** exists (the deploy sets it on the function)

### Quick behavior smoke test
- [ ] Open the chat → the concierge greets/engages (persistent, not one message)
- [ ] Sign in from an anonymous chat → the conversation **carries over**
- [ ] Sign out → the thread resets (no bleed into an anonymous view)
- [ ] Admin panel → Conversations shows your chat (not "anonymous")
- [ ] Admin → Tuning → **Edition** card loads current/next/remaining; saving a new
  run size moves the storefront ticker
- [ ] Admin → Customers → a placed order shows a **fulfillment** control; advancing
  to `shipped` with a tracking number emails the buyer (if `RESEND_API_KEY` is set)

---

## Deploying changes

- **Front end** (`index.html`, `admin.html`, `assets/*`): just push — Pages
  auto-deploys. Bump the `?v=N` on the changed asset in `index.html` to bust cache.
- **Functions** (`supabase/functions/*`): push, then run **Deploy Concierge**.
  Bump `BUILD_TAG` in `concierge/index.ts` so `selftest` confirms the live build.
- **Schema**: add a migration under `supabase/migrations/` AND mirror it in
  `setup.sql`; apply via SQL Editor or `supabase db push`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The key could not be sent" / "posted its share of keys" | Built-in email rate limit (429) | Custom SMTP, or wait for the hourly window |
| Admin panel empty | Your email not in `concierge_admins` | Re-run `setup.sql` (seeds super admin) or add the row |
| Bot treats you generically | Not recognized as signed in, or stale function | `selftest` → check `signed_in` / `build` |
| Cache shows 0 entries | pgvector operator / `setup.sql` not applied | `GET <endpoint>?cachecheck=1` |
| Conversations show "anonymous" | Signed-in token not reaching the function | `selftest` → `signed_in` should be true |

---

## Security notes

- Secrets (Anthropic, Supabase service role, SMTP/Resend keys) live **only** in
  Supabase/GitHub — never in the repo. The browser only ever sees the
  **publishable** anon key.
- Admin access is gated by Row-Level Security (`is_concierge_admin()`); admin
  removal is restricted to the **super admin** (`is_super_admin()`).
- `ALLOWED_ORIGINS` restricts browser CORS; rate limits bound abuse
  (concierge 20/10min, commission 10/10min per IP).

---

## License

**All rights reserved** — see [`LICENSE`](LICENSE). This repository is public
for **viewing and evaluation only** (e.g. reviewing the author's work); it is
not open-source and no reuse is permitted without written permission. The brand
and all imagery/video are fictional, AI-generated demo assets. To license any
other use, contact mberenji@gmail.com.
