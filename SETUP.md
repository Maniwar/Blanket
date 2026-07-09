# Feierabend (Decke 01) — Setup & Verification

A runnable checklist to stand this project up and confirm it's wired correctly.
This is a **demo** — no real product ships and no payment is ever taken.

- **Live site:** https://maniwar.github.io/Blanket/
- **Design doc (the *why*):** [`DESIGN.md`](DESIGN.md)
- **Deep-dive docs:** [`supabase/README.md`](supabase/README.md) (backend) ·
  [`supabase/SCHEMA.md`](supabase/SCHEMA.md) (every table/field/RPC)

---

## Go-live checklist

The short path from a fresh clone to a working demo. Each step links to its
detail below.

- [ ] **1. Database** — paste all of [`supabase/setup.sql`](supabase/setup.sql)
  into the Supabase **SQL Editor** and Run. This one file provisions everything
  (schema + all seed content + the edition run); nothing else to apply. *Change
  the super-admin email near the bottom to yours first.*
- [ ] **2. GitHub secrets** — add `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
  `ANTHROPIC_API_KEY`. *(Optional now, needed for order email: `RESEND_API_KEY`,
  `EMAIL_FROM`.)*
- [ ] **3. Deploy functions** — Actions → **Deploy Concierge** → Run workflow
  (deploys concierge + commission).
- [ ] **4. Front end config** — confirm `FEIER_CONCIERGE_CONFIG` in `index.html`
  has your `endpoint` / `supabaseUrl` / `supabaseAnonKey`, then push (Pages
  auto-deploys).
- [ ] **5. Auth URLs** — Supabase → Authentication → **URL Configuration**: Site
  URL `https://maniwar.github.io/Blanket/`, redirect `.../Blanket/**`.
- [ ] **6. Sign-in email (required)** — configure **custom SMTP** (the built-in
  sender is rate-limited and causes "The key could not be sent"), then paste the
  branded **Magic Link** + **Confirm Signup** templates from
  [`supabase/EMAIL_TEMPLATES.md`](supabase/EMAIL_TEMPLATES.md) into
  Authentication → Email Templates.
- [ ] **7. Order email (optional)** — add `RESEND_API_KEY` and re-run **Deploy
  Concierge** to turn on confirmation / shipment / cancellation emails. Until a
  domain is verified, the default sender only reaches your own Resend inbox.
- [ ] **8. Verify** — sign in, type `selftest` in the chat, and walk the
  [smoke test](#quick-behavior-smoke-test).

*Steps 1, 6, and 8 are the ones that must be done by hand in the Supabase
dashboard; the rest are GitHub/Actions.*

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
   [`supabase/setup.sql`](supabase/setup.sql) → **Run**. This **one file** is the
   complete, self-contained setup: schema, RLS, functions, **and** all seed
   content (config, the full knowledge base, every SOP, forms, goals, and the
   **super admin** — change that email near the bottom to yours first). It's
   idempotent (safe to re-run) and each content block seeds only if its table is
   empty, so your Studio edits are never overwritten. The numbered files in
   `supabase/migrations/` are just the historical record of how the schema grew —
   you don't need to run them.
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
2. Sender: use an address on a **domain you've verified in Resend** (e.g.
   `concierge@feier-abend.co`) for real sending. `onboarding@resend.dev` also
   works but only delivers to your own Resend-account email — fine for solo tests.
3. Supabase → Authentication → **SMTP Settings** → Enable Custom SMTP:
   Host `smtp.resend.com`, Port `465`, Username `resend`, Password = API key,
   Sender = your address. Save.
4. Authentication → **Rate Limits** → raise emails/hour (now that it's your SMTP).

### Email templates (branded)

Paste-ready branded templates for the auth emails (Magic Link, Confirm signup)
live in **[`supabase/EMAIL_TEMPLATES.md`](supabase/EMAIL_TEMPLATES.md)** — that
file is the single catalog of every email the demo sends, auth and order alike.
Set them under Supabase → Authentication → **Email Templates**.

### Transactional order email (Resend API, optional)

Separate from auth email: order confirmations and shipment/return notices are
sent by the **commission function** through the Resend HTTP API, not SMTP.

1. Reuse the same Resend **API key** (or make a second one) as the
   `RESEND_API_KEY` GitHub secret.
2. `EMAIL_FROM` is optional; it defaults to `Feierabend <concierge@feier-abend.co>`
   — an address on the verified Resend domain, so real recipients receive it.
   Override it with an `EMAIL_FROM` secret to send from a different domain.
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
- [ ] GitHub secret **`ANTHROPIC_API_KEY`** exists — the deploy sets it on the
  function, and it also powers the judge-graded checks in the deploy's
  behavior-evals step and the **Persona Evals** workflow (without it those
  judge checks SKIP silently)
- [ ] **Actions → Config Conformance** run once after tuning Engagement — every
  row PASS proves your settings are what the live widget runs

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
- **Schema**: `setup.sql` is the **single source of truth** — make the change
  there and re-run it in the SQL Editor. A matching file under
  `supabase/migrations/` is optional and only needed if you deploy schema with
  `supabase db push` (the deploy workflow does this when `SUPABASE_DB_PASSWORD`
  is set).

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
