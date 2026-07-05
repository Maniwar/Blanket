# Concierge behavior rules

The invariants that govern how the concierge *behaves* — the guardrails baked
into its prompt and helper code, as opposed to the copy an admin edits (KB, SOPs,
config). This is the reference for "why does the bot do X"; most of it lives in
`supabase/functions/concierge/index.ts` (the always-on system-prompt block) and
`kb.ts` (the move-selector and display-token rules). Admin-editable knobs are
noted where they exist.

## Orders — read the register, never remember it
- The bot **must call `get_my_orders` before answering any question about a
  patron's orders** — every status, every count, every "how many," every filtered
  list. It builds the answer, the count, and the pills **only** from the tool's
  result, never from memory or the CUSTOMER summary in the prompt.
- `get_my_orders` returns an authoritative `{ count, colorway, orders }`. When the
  patron narrows to one cloth ("show my Loden", or taps a cloth pill), the bot
  passes the **colorway filter** so the register returns exactly those rows,
  pre-counted — it does not tally or filter a long list in its head (that is how
  counts got dropped and a cloth mislabeled).
- If it already listed orders earlier in the chat and is asked again, it re-calls
  the tool rather than trusting the earlier list.
- Cancelled entries are archive: excluded from lists and counts unless the patron
  asks about history (`include_cancelled`).

## Tappable pills — always leave a path
- Whenever the patron must choose among specific things (orders, cloths, yes/no),
  the bot offers `{{reply:…}}` pills, never a bare list of numbers to type.
- **Large sets don't drop to prose.** If more than six items are eligible, the bot
  offers a few **narrowing** pills first (by cloth: `Show the Graphit`, or
  most-recent), then one pill per order within the chosen group. The client
  renders at most 6 pills per row; there is always at least one tappable step.
- For a change, after the patron picks, the bot restates the consequence in one
  line and offers exactly two pills (`Yes, cancel Nº X` / `Keep Nº X`); it calls
  the write tool only after the explicit Yes.

## Writes — confirm, then report truthfully
- Every register write (cancel, colorway, gift name, mending, resend) is
  **signed-in only, ownership-scoped, and logged** to `concierge_actions`.
- The bot states what it's about to do, gets explicit confirmation, calls the
  tool, and reports the tool's result verbatim in substance — it never claims a
  change happened unless the tool confirmed it.
- **Address changes are never free-typed by the model.** They go through the
  in-chat address-change form, where the patron types each labelled field, because
  a model composing five address fields once mis-mapped a city into the street
  line. (See [`FORMS.md`](FORMS.md), [`TOOLS.md`](TOOLS.md).)

## Selling, pacing, re-engagement
- Covered in [`DESIGN.md`](DESIGN.md) §2.8: the move-selector (Ask/Recommend/Show/
  Advance/Reassure/Space), the assertiveness dial, hooks/objections, journey-aware
  goals, closed-panel re-engagement, and post-sale behavior. All admin-tunable.

## Journey-aware goals
- Each goal can carry one or more **sections** (page/journey stages), set as
  checkboxes in Procedures → Conversation goals. The bot leads with an open goal
  when the visitor is reading **any** of its sections. No sections = pursued
  anywhere. Source of truth is `concierge_goals.sections[]`.

## Conversation starters
- The suggestion chips (and the on-page inline starters) are the admin's
  configured starters **topped up** with the baked KB defaults, per section — so a
  section left blank or only partly filled still offers a few, never one or none.
- For a **signed-in** patron the widget leads with **personalized** starters from
  `?starters=1` — built deterministically from their real orders (where's my Nº,
  change the cloth, update the gift card, care guide, show all orders) — then tops
  up with the section defaults.

## Admin console — date filters
- The date filters on the Actions / Customers / Conversations / Waitlist tabs read
  a **local** calendar day and convert it to the matching UTC window, so a
  same-day range (e.g. Jul 5 → Jul 5) returns that day's rows in the admin's own
  timezone. Both bounds are inclusive of the whole day.

## Publishing
- Storefront copy/SEO is CMS-driven and hydrates at runtime; social-crawler
  `<head>` tags are baked at publish by `scripts/bake_seo.py` inside
  `deploy-pages.yml` (the one Pages deployer; `pages-retry.yml` auto-re-runs it
  through GitHub's occasional transient deploy errors). See [`CMS.md`](CMS.md).
