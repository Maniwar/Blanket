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
- Every register write (cancel, colorway, gift name, mending, resend,
  `resolve_admin_note`) is **signed-in only, ownership-scoped, and logged** to
  `concierge_actions`.
- The bot states what it's about to do, gets explicit confirmation, calls the
  tool, and reports the tool's result verbatim in substance — it never claims a
  change happened unless the tool confirmed it.
- **Address changes are never free-typed by the model.** They go through the
  in-chat address-change form, where the patron types each labelled field, because
  a model composing five address fields once mis-mapped a city into the street
  line. (See [`FORMS.md`](FORMS.md), [`TOOLS.md`](TOOLS.md).)

## House instructions (directives) — follow them, then check them off
The team can leave a standing instruction for a specific patron; it appears in the
CUSTOMER block as **HOUSE INSTRUCTIONS FOR THIS PATRON**, each printed with a
`(#id)`. Invariants (SOP `client-book-method`, which now also carries the
directive-handling detail formerly split into a separate `house-directives` SOP):
- **Honour them before anything else.** An open instruction outranks the bot's own
  plan for the conversation. It is woven into service, never read aloud or
  attributed to "the team."
- **The note's exact wording is the sole source of the errand.** If the client
  book or a past visit mentions a *similar* errand (an earlier forgotten item, an
  earlier apology), that one is history — its details must never bleed into the
  new instruction. To keep old errands from contaminating new ones, resolving a
  note writes a **content-free** book event (the note's id only, marked "a past
  errand: never repeat or reference its contents") — the errand's text lives
  only on the note itself.
- **Standing vs. one-time.** A standing preference ("always offer the Loden first")
  is followed every visit and left open. A one-time task ("apologise for the delay
  on Nº 231") is done at the first natural moment, then checked off by calling
  **`resolve_admin_note`** with its `(#id)` **in the same reply** — the CUSTOMER-block
  line warns that a completed one-time task left open will wrongly repeat next visit.
- **Proactive beats honour them too.** The idle-nudge, opener, and closed-panel
  re-engagement lines are told to act on an open instruction even when the patron
  hasn't typed (those beats run tool-less, so they can't self-resolve — the
  backstop below closes them). Every one of these lines is **recorded to
  `concierge_messages`** — including the closed-panel `?reengage=1` bubble, which
  formerly returned its text without logging it, so a note delivered there vanished
  from the transcript. The transcript is now complete: every customer-visible line
  the concierge produces is written.
- **Greet on the opening beat only.** The RE-ENGAGEMENT banner ("new visit — greet
  like someone returning") and the "on your very first line of the visit" directive
  framing render only when `customerBlock(customer, opening)` is called with
  `opening = true` (a proactive greet/reengage, or the first turn with no assistant
  reply yet). Mid-conversation they are dropped so the bot never re-greets ("what
  brings you back today?") on every reply — the live conversation is never the
  "last" one, so the banner would otherwise repeat verbatim each turn.
- **Self-resolve backstop.** Because a model sometimes acts but forgets to resolve,
  `reconcileDirectives` runs after any signed-in turn with an open one-time
  directive: a small, tool-scoped background pass re-reads what was said and calls
  `resolve_admin_note` for anything now carried out. It only ever resolves (never
  speaks), so a miss is safe — the note simply resurfaces next turn. Resolving also
  **tags** the chat (`🏷 house note`), since the tag derives from that action.
  (Full design in [`DESIGN.md`](DESIGN.md) §4.13.)

## Selling, pacing, re-engagement

![Conversation-flow diagram](docs/conversation-flow.svg)
*The full beat lifecycle — triggers, client gates, the context every beat
carries (patron record, client book, house notes, goals, house knowledge,
the moment), the substance-gate decision, and the measures — in one picture.*

- Covered in [`DESIGN.md`](DESIGN.md) §2.8: the move-selector (Ask/Recommend/Show/
  Advance/Reassure/Space), the assertiveness dial, hooks/objections, journey-aware
  goals, closed-panel re-engagement, and post-sale behavior. All admin-tunable.
- **Show the commission button on a buying signal — don't interrogate.** The moment
  the shopper signals intent ("I want to commission," "let's do it," "open the
  register," "I'll take it"), the bot emits `{{action:commission}}` **in that same
  reply**. It does NOT ask which cloth or where it ships first — the register sheet
  collects the cloth and address itself, so asking beforehand is friction that
  loses the sale. It never proposes opening the register ("shall I…?") without the
  button in the message, and never repeats a qualifying question.
- **`[HOLD]` is a silence signal, never a reply.** The bot may answer a *proactive*
  check-in prompt with exactly `[HOLD]` when staying quiet is kinder — the server
  turns that into a hold and shows nothing. It must never write `[HOLD]` in reply
  to a message the visitor actually sent; the token can never reach the reader (the
  pipeline strips it on every path).
- **The guardrails themselves are editable and versioned.** The entire
  ENGAGEMENT & PACING rule block is an editable base
  (`concierge_config.engagement_base` — Tuning → Engagement pace, with "Load
  built-in to edit" and History ⟲ rollback like the voice base; blank = the
  built-in text below). `beat_notes` additionally appends the admin's own
  standing instructions to **every** proactive beat brief (nudges, openers,
  the closed-panel bubble) without replacing the base. Every save lands in
  `concierge_edit_history`. The bullets that follow describe the **built-in**
  defaults.
- **Sell, don't just report.** The substance gate is not a license to become a
  status board: on every spoken beat the bot prefers the line that moves
  *toward the register* — an open goal's next step, a companion cloth for
  another room, a gift in another name — using at most one register fact as
  the doorway, never the destination. A pure status line is right only when
  service genuinely needs it (a blocked order, a delivery), and only once — a
  service fact already raised is spent, not substance.
- **Substance or silence (proactive beats).** A proactive beat may speak only
  when it has something **new and concrete** — a register fact not yet
  mentioned, an open goal's next step, a house instruction. Nothing new →
  `[HOLD]`. This inverts the old "SPEAK now (do not hold)" bias, which ordered
  content on a timer and made the model fill the gap with atmosphere and
  invented color once the real facts were spent. Proactive lines are also held
  to **plain speech** (one or two clerk-plain sentences, at most one image,
  every fact verbatim from the register — never invented rituals, meanings, or
  tallies).
- **Quiet mode is a time-boxed pause, not a switch.** "That's all for now" (the
  in-flow chip or ⋯ menu) and "Don't message me until I write back" both enter
  quiet mode, which silences **every** proactive beat — in-panel nudges,
  openers, and the closed-panel bubble. It lifts three ways, whichever comes
  first: (1) **by itself** after the quiet window (`outreach.quietMs`, default
  30 minutes, Tuning → Engagement pace), after which the bot resumes a *light*
  presence rather than staying dark; (2) **on page reload** — the pause is
  deliberately not persisted, so a fresh page never inherits an old silence;
  (3) **the moment the visitor types** — their message always reopens play.
  Diagnosable live: `FeierabendConcierge.status()` reports `quietMode` and
  `quietRemainingMs`, and `lastSkip` names the quiet window when it's the gate.
- **Plain is not blunt; the book is background; status words are law.** Four
  guardrails on the plain-speech correction: (1) dropping poetry never means
  dropping warmth — no curtness, no interrogation, no scorekeeping; a patron
  asking "why buy?" always gets the true service answer (another room, a gift,
  the trial), never "I have no good answer." (2) The client book *seasons* a
  line once — an old note (a room, a light) is background, never the recurring
  agenda, and never a current fact. (3) An order's register status is
  authoritative: `placed` has not arrived — the bot never describes a cloth as
  settled in or in use unless the register says delivered. (4) The book is
  **invisible at the point of data**: the discipline line rides with the book
  content itself on every beat (not only in the toggleable Recognition
  section) — never name the book, never cite "notes/records" as a source, and
  never describe the patron's own preferences or communication style back to
  them ("the client book notes you prefer direct data…" is a service failure;
  a style note changes *how* the bot speaks, never what it says).
- **Vary the door, not the words (proactive pacing).** The bot never repeats or
  rephrases its own unanswered question on a proactive beat. The server scans
  the **whole trailing run** of its own unprompted lines (not just the last
  one — a statement beat used to "launder" the guard, and the same question
  came back two beats later): while any question of the bot's is pending, every
  proactive beat is question-free — one true statement if it has one, `[HOLD]`
  if it doesn't. From the second reach-out on, each beat must open a
  **different door** — a subject not yet offered — and when every door is
  spent, the honest move is `[HOLD]`, never invention, so five beats never
  orbit one cloth. The rule is **scoped**, not a gag: it governs only the
  bot's own unprompted follow-ups; an ambiguous reply invites a gentle
  clarify, explicit confirmations (a cancellation, a change) are always asked,
  and a pending question may be returned to once the patron speaks again.
  Persistence stays wanted; repetition is what annoys. **The closed-panel
  bubble follows the same rules**: `?reengage=1` composes each line fresh, so
  it is shown its own recent lines and bound to the same contract — spent
  subjects, no re-asks while a question is pending, and an explicit hold
  (`{hold:true}`) when nothing new is left, which the client honors with
  silence (no canned fallback line) until the patron shows fresh activity.
  For a signed-in patron the guard reads across their **recent conversations**,
  not just the current one — a wrap-up or quiet-window expiry opens a fresh
  conversation row, and a guard scoped to the new (empty) row let the same
  subject return 45 minutes later.
- **Every pacing number is admin-tunable** (Tuning → Engagement pace, stored on
  the `outreach` config key, no deploy): the five-step in-chat follow-up ladder
  (`nudge1Ms`–`nudge5Ms`, last repeats), `nudgeCap`, `unackedCap` (pause after
  N unacknowledged reach-outs), `holdBudget` (consecutive silent holds before
  resting), opener timings (`openerSignedMs`/`openerAnonMs`/`openerReengageMs`),
  closed-panel idle thresholds and budgets (`reengageIdle*Ms`, `reengageMax*`,
  `reengageEnabled`), bubble linger (`bubbleWithdrawMs`), ambient budget
  (`maxAmbient`), post-sale behavior (`reengageGraceMs`,
  `reengagePostSaleWindowMs`, `reengagePostSaleEnabled`), the kept-transcript
  window (`historyKeepMs`), and the **substance gate itself** (`substanceGate`,
  default on). Blank = built-in default, scaled by the assertiveness dial.
  `FeierabendConcierge.status()` reports the *effective* caps after config and
  dial are applied. **Held beats are monitored, not invisible**: each one
  writes `concierge_actions.action='beat_hold'` (conversation id + beat kind),
  so the Actions tab shows deliberate silence and hold rate is a real metric.
  The product-level user stories, acceptance criteria, and the full
  quantitative/qualitative measure set live in [`DESIGN.md`](DESIGN.md) §2.10.
- **Every proactive beat carries the full patron context.** In-panel nudges,
  openers, and the **closed-panel re-engagement bubble** all inject the complete
  CUSTOMER block (name, standing, orders, recency, client book, open house
  instructions) and are told to ground the line in THIS patron — the token getter
  also waits briefly for a remembered session, so a known patron is never greeted
  anonymously by a beat that fired before auth finished loading.
- **Post-purchase.** A commission is congratulated **in the transcript** the moment
  checkout closes (with the standing note — Wiederkehr/Hausfreund/Stifter — when it
  applies), whether the chat panel is open or closed. After the sale the bot leads
  with reassurance (grace window), then may re-engage for a companion cloth/gift —
  never "still eyeing it." Timings are admin-tunable (`outreach.reengageGraceMs`,
  `reengagePostSaleWindowMs`, `reengagePostSaleEnabled`).

## Chat panel & composer (client UX)
- **"That's all for now" is a visible control, not a hidden menu item.** Once a
  real exchange exists (one visitor turn + one bot turn), a small chip rides in
  the message flow under the bot's latest reply — no chrome, no extra row; it
  scrolls with the conversation and is rebuilt after each reply. One tap wraps
  the conversation: quiet mode on, the register records the wrap, a warm
  goodbye, and the panel closes. It hides while there's nothing to wrap (fresh
  chat, already wrapped, quiet, mid-stream). The ⋯ menu keeps both signals
  ("Don't message me until I write back" and "That's all for now") for
  completeness; typing again always lifts the quiet and starts a fresh
  conversation. A bot line that lands on a wound-down thread (a re-engagement)
  marks it resumed, so the resumed conversation can be wrapped again.
- **A brief tab-switch does not end the conversation.** Glancing at another tab
  (e.g. the admin) no longer marks the live chat "closed" — the wind-down fires
  only on a real leave (tab hidden ~60s, or an actual page unload). An explicit
  "That's all"/snooze still starts a fresh conversation deliberately.
- **The composer keeps focus** on pointer devices (including a narrow, side-by-side
  desktop window): the cursor lands in the box on open and returns to it after each
  reply, so you can send back-to-back with Enter. On touch it's left alone so the
  keyboard doesn't spring up.
- **The transcript follows a signed-in patron across tabs.** The live thread is
  per-tab (`sessionStorage`), but for a **signed-in** patron every save is also
  kept device-side keyed to their identity — so closing the tab and coming back
  restores the conversation, for the visitor *and* for the bot (which otherwise
  restarted from an empty thread and repeated itself). The keep is wiped on
  sign-out or identity change, expires after an admin-tunable window
  (`outreach.historyKeepMs`, default 7 days), and never applies to anonymous
  visitors — their chats stay per-tab for privacy. Server-side, a new tab still
  opens a fresh conversation row; continuity is the transcript the model sees,
  not a merged analytics session.

## Diagnosing a quiet widget (browser console)

The concierge has many *deliberate* reasons to stay silent (quiet mode, spent
budgets, an anonymous visitor who hasn't typed, a congrats grace window after a
sale). To make silence readable instead of a mystery, the widget exposes
diagnostics on any page where it's mounted — open the browser console and run:

- **`FeierabendConcierge.status()`** — a snapshot of the engagement state:
  signed-in email, `panelOpen`, `quietMode`, `wrappedUp`, whether the visitor
  has typed, nudge count vs. effective cap, unacknowledged reach-outs vs. cap,
  hold attempts, history length and last speaker, `entryMode` (how this
  conversation began: typed / opener / nudge / tapped outreach),
  `nudgeTimerArmed` (a follow-up is scheduled right now), and a `reengage`
  object for the closed-panel bubble (enabled, count vs. max, fires-after-idle
  threshold vs. how long you've actually been idle, whether page activity has
  been seen, whether a bubble is on screen, post-sale grace).
- **`status().lastSkip`** — the headline field: names, in plain language with a
  timestamp, the exact gate that stopped the **most recent** proactive beat
  (e.g. *"reengage: not idle long enough — fires after 30s still; last activity
  4s ago (moving the mouse resets the clock)"*).
- **`window.FEIER_CX_DEBUG = true`** — from then on, every skipped beat also
  logs live to the console (`[concierge] skip: …`) as it happens.
- **`FeierabendConcierge.open()` / `.close()`** — programmatic panel control
  (`open('question')` opens and sends the question).

Instrumented beats: in-panel follow-ups (`scheduleNudge`), the on-open
opener, the closed-panel re-engagement tick, and the ambient outreach bubble —
every early return names itself. One structural guarantee worth knowing: an
open panel never sits with **no** beat armed — if the opener stands down (for
example, the outreach line you just tapped *is* the opener), the light-presence
follow-up loop is armed in its place.

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
