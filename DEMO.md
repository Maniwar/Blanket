# Demo Script — a 6–8 minute walkthrough

A guided path for showing the concierge live (e.g. in an interview). Each beat is
**do this → point this out → it demonstrates**. Skip freely; the beats stand alone.

**Live:** https://maniwar.github.io/Blanket/ · **Admin:** append `/admin.html`

> **Before you start:** open in a fresh/incognito window so you're anonymous. To
> replay the "returning patron" beats, sign out (that clears the local thread) or
> use a second profile. Sign-in needs custom SMTP configured (see
> [SETUP.md](SETUP.md)).

---

## Act 1 — Anonymous shopper (the concierge earns attention)

1. **Land on the page, scroll a little.** → *Point out* the scroll-scrubbed hero,
   the restrained luxury tone (no urgency banners). → *Demonstrates* craft and a
   deliberate brand voice, static and dependency-free.
2. **Open the concierge; wait a beat, don't type.** → It **speaks first** with a
   line drawn from what you're viewing, then eases into light check-ins. → *This
   is proactive, presence-aware engagement* — it opens the conversation but won't
   pester someone who isn't responding.
3. **Ask a common question** ("how much is it?" / "what's it made of?"). → Answer
   comes back **instantly**. → *Semantic cache* — anonymous first-questions are
   served from pgvector without an LLM call (cost + latency near zero).
4. **Go quiet for ~20s, then move the mouse / scroll.** → It circles back, and
   after a while **invites you to leave your email** to be remembered. → *The
   "read-receipt proxy":* it pauses when talking to no one and resumes on any sign
   of life; the email invite is a courtesy, not a gate.

## Act 2 — Scarcity, done honestly

5. **Click a colorway swatch.** → Checkout opens **with that colorway preselected**
   and a **specific number is held** for you. → *Serial holds:* the number you see
   is the number you get.
6. *(Talking point)* Numbers are allocated **collision-free under concurrency**
   with `FOR UPDATE SKIP LOCKED`, lowest-free-first, and a cancelled number
   **returns to the edition** — no fake counters, no double-issue. *(See
   [DESIGN.md §4.2](DESIGN.md).)*

## Act 3 — Becoming known (anonymous → signed in)

7. **Sign in from inside the chat** (magic link). → The **same conversation
   continues**, now greeted by name. → *Anonymous → signed-in adoption:* signing
   in is continuity, not a reset. The thread is attributed to you server-side.
8. **Ask "where's my order?"** (as a returning patron with orders). → It **reads
   your register** and answers per order. **Change the shipping address or
   colorway in chat; then cancel one.** → *Register tools* — self-service,
   restricted to still-mutable orders, every change **audited**; the cancelled
   number frees back to the edition.
9. *(Talking point)* It treats you by **standing** (lifetime value tiers) and
   remembers what you told it last time (the **client book**).

## Act 4 — Gifting & control

10. **Start a commission "as a gift."** → Recipient's name on the card, order in
    your name, separate billing/shipping. → *Purchaser vs. recipient split.*
11. **Say "that's all for now"** (or the `⋯` menu → "Don't message me until I
    write back"). → It closes gracefully / goes quiet. → *Customer-signalled
    lifecycle* always wins over the automatic behavior.

## Act 5 — The merchant's side (`/admin.html`)

12. **Conversations tab** → open your chat; see the **goal scorecard** — each goal
    met/partial/unmet **with the evidence cited**. → *The concierge is measurable.*
13. **Customers tab** → the customer's **LTV/standing, orders, and client book**
    (what the concierge learned). → *Clienteling memory, visible to the merchant.*
14. **Procedures tab** → edit a **goal or SOP** and save. Within ~60s the live
    concierge follows it. → *Everything tunable is data — no deploy.*
15. **Tuning → Administrators** → add an admin; note you **can't remove yourself
    (the super admin)**. → *Access control enforced by RLS, not just the UI.*

## Act 6 — It explains itself

16. **Type `selftest` in the chat.** → A report: recognized sign-in, schema
    applied, orders attributed, and **the exact context the model receives about
    you**. → *Observability / self-diagnosis* — the system proves its own state.

---

## Talking points for an interviewer

- **Concurrency:** serial allocation is the interesting bit — `SKIP LOCKED`,
  lowest-free-first, reclaim-on-cancel. No collisions, no `MAX()+1` race.
- **Security model:** the **database is the boundary** — RLS + `security definer`
  functions; the browser holds only a publishable key; secrets never leave the
  server.
- **Cost/latency:** the semantic cache handles the long tail of identical
  first-questions for free.
- **Product judgment:** the engagement model (openers, nudges, presence, quiet
  mode) is about *restraint* — attentive without hovering.
- **Operability:** one idempotent `setup.sql`, `BUILD_TAG` + `selftest` to know
  what's live, full audit trail, everything-tunable-is-data.

*(Architecture at a glance: [docs/architecture.svg](docs/architecture.svg). The
full rationale: [DESIGN.md](DESIGN.md).)*
