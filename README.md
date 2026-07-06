# Feierabend — Decke 01

An AI **sales concierge** for a scarce, considered purchase — a numbered,
limited-edition (15,000-piece) German wool blanket. It explores one question
end-to-end: *what does a genuinely attentive luxury sales associate feel like
when it's software?*

**▶ Live demo:** https://maniwar.github.io/Blanket/

> **Demo only** — nothing ships and no payment is taken. The brand, imagery, and
> video are fictional and AI-generated.

---

## What it demonstrates

- **A concierge that clientels, not FAQs.** It greets returning patrons by name,
  knows their standing (lifetime value), remembers what they told you last time
  (a "client book"), pursues admin-defined conversation goals, and drives toward
  a sale with patience. It reads your register, changes an address/colorway, or
  cancels an order — in chat, itself.
- **Scarcity done honestly.** A numbered edition (15,000 by default, admin-settable),
  allocated collision-free under concurrency (`FOR UPDATE SKIP LOCKED`); the number
  you're shown is the number you get; a cancelled number returns to the edition,
  lowest-first.
- **A merchant back office.** The admin studio sets the edition run, advances an
  order through fulfillment (`placed → … → shipped`, with tracking), and sends the
  buyer a branded confirmation and shipment email along the way.
- **Attentive, not annoying.** The concierge speaks first on open, circles back
  when you go quiet, and — with no true read receipts available — uses
  *acknowledgement/presence* as a proxy: it pauses when it's talking to no one and
  resumes the moment you show a sign of life.
- **Everything tunable is data.** Voice, knowledge, selling procedures, in-chat
  forms, conversation goals, **behavior-eval scenarios**, and even the **model**
  (with a configurable fallback) are database rows editable in an admin studio —
  live, no redeploy.
- **Tested behavior, not vibes.** A behavior-eval deck replays scripted
  conversations against the live concierge and reports a **pass rate** per
  behavior (deterministic checks + a pinned binary LLM judge), so a prompt or
  model change can't silently regress a fixed bug. Runnable from the CLI or the
  admin **Evals** tab.
- **No server to run.** Static site (GitHub Pages) + two Deno edge functions +
  managed Postgres, with Row-Level Security as the authorization boundary and a
  documented [security review](SECURITY.md).

## Stack

Static ES5 front end (self-contained HTML, WebP data-URIs, scroll-scrubbed
motion, `prefers-reduced-motion` respected) · Supabase Edge Functions (Deno) ·
Postgres + RLS + pgvector · Anthropic Claude (streaming + tool use) ·
passwordless email auth.

## Documentation

| Doc | What's in it |
| --- | --- |
| **[DESIGN.md](DESIGN.md)** | The design doc — concept, **user stories** (guest, customer, gift-giver, merchant, super admin, operator), architecture, and the key decisions & trade-offs (serial holds, semantic cache, identity/lifecycle, the engagement model). |
| **[DEMO.md](DEMO.md)** | A 6–8 minute live walkthrough script — do-this / point-out / demonstrates, plus interviewer talking points. |
| **[SETUP.md](SETUP.md)** | Stand it up and verify it — setup steps, custom SMTP, a `selftest`-driven checklist, troubleshooting. |
| **[supabase/README.md](supabase/README.md)** | Backend reference — the edge functions, wire contracts (SSE frames, endpoints), rate limits. |
| **[supabase/SCHEMA.md](supabase/SCHEMA.md)** | Data model — every table, column, RPC, and what reads/writes it. |
| **[evals/README.md](evals/README.md)** | Behavior evals — how the concierge is regression-tested (deterministic checks + a pinned binary LLM judge, reported as a pass rate), runnable from the CLI or the admin **Evals** tab. |
| **[SECURITY.md](SECURITY.md)** | Security review — CISSP/OWASP-framed audit (injection, XSS, access control, RLS, secrets): what was found and fixed, residual risks, and the path to a formal certification. |
| **[PRIVACY_REVIEW.md](PRIVACY_REVIEW.md)** | Privacy compliance check of the published notice against GDPR + CCPA/CPRA — required-disclosure gap analysis, factual corrections, and what still needs counsel. |
| **[SCALING.md](SCALING.md)** | Scaling review — what holds at millions of users, what was hardened, what's next. |
| **[BACKLOG.md](BACKLOG.md)** | Prioritized future work (scalability, features, quality) — none blocking. |

## License

**All rights reserved** — see **[LICENSE](LICENSE)**. This repository is public
for **viewing and evaluation only** (e.g. reviewing the author's work); it is not
open-source and no reuse is permitted without written permission.
