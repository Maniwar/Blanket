# Email templates

Every email the demo can send, in one place. There are **two kinds**, and they
live in two different places:

1. **Auth emails** (sign-in) — rendered by Supabase from templates you paste into
   the dashboard. Branded HTML for those is below; copy it into
   **Supabase → Authentication → Email Templates**.
2. **Transactional order emails** — generated in code by the edge functions (no
   dashboard template). They're already in the repo as TypeScript; this file just
   documents them so the full set is visible in one place.

All of them share the same visual shell (dark card, *Feierabend / Weberei Brandt*
masthead) so auth and order mail look like one house. This is a **demo** —
nothing ships and no payment is taken; the footer says so.

---

## 1. Auth emails (paste into the Supabase dashboard)

Auth is passwordless, so **Magic Link** is the one that matters. **Confirm signup**
can fire the first time a brand-new address signs in (if email confirmation is on),
so it's branded too. The remaining Supabase templates (Invite user, Reset password,
Change email, Reauthentication) aren't part of this passwordless flow — if you ever
enable one, reuse the shell below, swap the heading/body, and keep the Supabase
token (`{{ .ConfirmationURL }}`, `{{ .Token }}`).

### Magic Link
Subject: `Your Feierabend sign-in`

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1c211d;margin:0;padding:32px 0;"><tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="width:440px;max-width:92%;background:#232a25;border:1px solid #3a4139;border-radius:14px;overflow:hidden;">
  <tr><td style="padding:30px 34px 4px;font-family:Georgia,serif;color:#f1ece2;font-size:26px;letter-spacing:.5px;">Feierabend</td></tr>
  <tr><td style="padding:0 34px 20px;font-family:'Courier New',monospace;color:#c49b5b;font-size:10px;letter-spacing:3px;text-transform:uppercase;">Weberei Brandt · Est. 1897</td></tr>
  <tr><td style="padding:0 34px;border-top:1px solid #3a4139;"></td></tr>
  <tr><td style="padding:24px 34px 8px;font-family:Georgia,serif;color:#f1ece2;font-size:19px;line-height:1.35;">Your sign-in link</td></tr>
  <tr><td style="padding:0 34px 14px;font-family:Helvetica,Arial,sans-serif;color:#c9c3b6;font-size:14px;line-height:1.6;">Guten Tag — tap below to open the register. The link is single-use and expires shortly.</td></tr>
  <tr><td style="padding:4px 34px 22px;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#c49b5b;color:#1c211d;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;padding:12px 26px;border-radius:8px;">Sign in</a></td></tr>
  <tr><td style="padding:12px 34px 24px;border-top:1px solid #3a4139;font-family:Helvetica,Arial,sans-serif;color:#7f7a6e;font-size:11px;line-height:1.6;">If you didn't request this, you can ignore it. A demo — nothing ships and no payment is taken. hello@feierabend.example</td></tr>
</table></td></tr></table>
```

### Confirm signup
Subject: `Confirm your email · Feierabend`

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1c211d;margin:0;padding:32px 0;"><tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="width:440px;max-width:92%;background:#232a25;border:1px solid #3a4139;border-radius:14px;overflow:hidden;">
  <tr><td style="padding:30px 34px 4px;font-family:Georgia,serif;color:#f1ece2;font-size:26px;letter-spacing:.5px;">Feierabend</td></tr>
  <tr><td style="padding:0 34px 20px;font-family:'Courier New',monospace;color:#c49b5b;font-size:10px;letter-spacing:3px;text-transform:uppercase;">Weberei Brandt · Est. 1897</td></tr>
  <tr><td style="padding:0 34px;border-top:1px solid #3a4139;"></td></tr>
  <tr><td style="padding:24px 34px 8px;font-family:Georgia,serif;color:#f1ece2;font-size:19px;line-height:1.35;">Confirm your email</td></tr>
  <tr><td style="padding:0 34px 14px;font-family:Helvetica,Arial,sans-serif;color:#c9c3b6;font-size:14px;line-height:1.6;">Willkommen — confirm this address to open the register in your name.</td></tr>
  <tr><td style="padding:4px 34px 22px;"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#c49b5b;color:#1c211d;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;padding:12px 26px;border-radius:8px;">Confirm email</a></td></tr>
  <tr><td style="padding:12px 34px 24px;border-top:1px solid #3a4139;font-family:Helvetica,Arial,sans-serif;color:#7f7a6e;font-size:11px;line-height:1.6;">If this wasn't you, ignore it. A demo — nothing ships and no payment is taken. hello@feierabend.example</td></tr>
</table></td></tr></table>
```

---

## 2. Transactional order emails (already in code)

These are built and sent by the edge functions via the Resend API — no dashboard
template. They render through `emailShell()` (same look as above). Turn them on by
setting `RESEND_API_KEY` (+ optional `EMAIL_FROM`) as function secrets; sending is
best-effort and never blocks the response. With the default `onboarding@resend.dev`
sender, Resend only delivers to your own account address until you verify a domain.

| Email | When it's sent | Subject | Source |
| --- | --- | --- | --- |
| **Order confirmation** | A commission is placed | `Nº <n> is entered in the Webbuch` | `commission/index.ts` → `orderEmail('placed')` |
| **On its way** (shipment) | Admin advances an order to `shipped` (with tracking) | `Nº <n> is on its way` | `commission/index.ts` → `orderEmail('shipped')`, via `POST ?fulfill=1` |
| **Struck from the register** (return) | Admin advances an order to `returned` | `Nº <n> — cancelled` | `commission/index.ts` → `orderEmail('cancelled')`, via `POST ?fulfill=1` |
| **Struck from the register** (cancel) | A customer cancels in chat | `Nº <n> — cancelled` | `concierge/index.ts` → `cancelEmail()`, from the `cancel_order` tool |

To change the wording or look of these, edit `emailShell` / `orderEmail` in
`supabase/functions/commission/index.ts` (and `cancelEmail` in
`supabase/functions/concierge/index.ts`), then redeploy — they're kept visually in
sync with the auth templates above by hand.
