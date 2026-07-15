# Appointments & callbacks — specification (v1, not yet built)

The concierge's next act: turning buying intent into a **booked moment** — a
viewing, a consultation, a fitting — or a **callback request** when the
visitor would rather talk. The admin publishes availability; the model offers
only what the calendar really has; tested code does the booking. Nothing here
is implemented yet — this document is the build contract.

**Why this feature:** in inquiry mode ("book a viewing" on the 996) an
appointment IS the conversion. In commerce mode it is the highest-intent
pre-sale action a concierge can capture. Today the bot can only take a form
message; it cannot commit a time — so hot leads cool while emails bounce
around.

## 0. Design principles (house law, applied)

1. **The model never invents a time.** Availability comes from one tool call;
   the model may present ONLY the slots the tool returned, verbatim. The same
   codepath that offers a slot books it — offer and write can never disagree
   (the `npsCaptureAction` lesson).
2. **Double-booking is structurally impossible.** A partial unique index and a
   `security definer` booking function make the race a database conflict, not
   an etiquette problem (the `hold_serial` lesson).
3. **Decisions in tested code; etiquette in SOPs.** When to offer, how to
   sound, how to decline — operator-editable SOPs. What is available, who got
   the slot — pure functions and SQL, unit-tested.
4. **Contact details are handled, never performed.** Phone/email are stored
   for the booking and **masked in every prompt injection**
   (`maskContacts`, the sec-20-407 lesson). The bot never reads a number back.
5. **Fail-visible, audited, QA-clean.** Every tool call writes an audit row;
   `qa-` sessions never occupy a real slot; admin surfaces show errors, not
   blanks.

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Appointment type** | An admin-defined offering: "Viewing — 30 min at the workshop", "Video call — 15 min". Duration, mode, buffers, booking window. |
| **Availability rule** | Weekly recurring windows per type: "Sat 10:00–16:00, slots every 30 min, capacity 1". |
| **Exception** | A dated override: closed on the 24th; extra evening window on the 30th. |
| **Slot** | A *computed* bookable start time — never stored until booked. Slots = rules − exceptions − existing bookings − lead time − horizon. |
| **Appointment** | A booked slot with a name + contact, lifecycle `booked → completed / cancelled / no-show`. |
| **Callback request** | "Have someone call me" — a phone number + preferred window, no slot consumed. Lifecycle `open → done / cancelled`. |

## 2. Schema (feature-owned, additive; all tables RLS-enabled)

```sql
create table concierge_appointment_types (
  id            bigint generated always as identity primary key,
  slug          text unique not null,           -- 'viewing', 'video-call'
  title         text not null,
  description   text not null default '',      -- shown to the visitor by the bot
  duration_min  int  not null default 30,
  mode          text not null default 'in-person'
                check (mode in ('in-person','video','phone')),
  location      text not null default '',      -- address / "link sent by email"
  buffer_min    int  not null default 0,       -- gap enforced after each booking
  lead_time_min int  not null default 240,     -- earliest bookable = now + lead
  horizon_days  int  not null default 21,      -- latest bookable
  capacity      int  not null default 1,       -- parallel bookings per slot
  enabled       boolean not null default false, -- drafts first (kit discipline)
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now()
);

create table concierge_availability (
  id        bigint generated always as identity primary key,
  type_id   bigint not null references concierge_appointment_types(id) on delete cascade,
  dow       smallint not null check (dow between 0 and 6),   -- 0 = Sunday
  start_min smallint not null check (start_min between 0 and 1439),
  end_min   smallint not null check (end_min   between 1 and 1440),
  step_min  smallint not null default 30,      -- slot grid within the window
  check (end_min > start_min)
);

create table concierge_availability_exceptions (
  id        bigint generated always as identity primary key,
  type_id   bigint references concierge_appointment_types(id) on delete cascade,
  on_date   date not null,                     -- shop-timezone date
  closed    boolean not null default true,     -- true: no slots that day
  start_min smallint, end_min smallint,        -- else: REPLACE the day's windows
  note      text not null default ''
);

create table concierge_appointments (
  id              bigint generated always as identity primary key,
  kind            text not null default 'appointment'
                  check (kind in ('appointment','callback')),
  type_id         bigint references concierge_appointment_types(id) on delete set null,
  starts_at       timestamptz,                 -- null for callbacks
  ends_at         timestamptz,
  window_pref     text,                        -- callbacks: 'weekday mornings'
  status          text not null default 'booked'
                  check (status in ('booked','completed','cancelled','no_show',
                                    'open','done')),   -- last two: callbacks
  visitor_name    text not null,
  visitor_contact text not null,               -- email or phone; NEVER injected unmasked
  contact_kind    text not null check (contact_kind in ('email','phone')),
  notes           text not null default '',    -- visitor's own words, one line
  customer_id     uuid,                        -- when signed in
  conversation_id uuid references concierge_conversations(id) on delete set null,
  session_key     text,
  cancel_token    uuid not null default gen_random_uuid(),  -- emailed self-serve cancel
  qa              boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The race-killer: one live booking per (type, start) up to capacity.
-- Capacity 1 is the partial unique index below; capacity > 1 is enforced
-- inside book_appointment() under an advisory lock on (type_id, starts_at).
create unique index concierge_appt_slot_uniq
  on concierge_appointments (type_id, starts_at)
  where kind = 'appointment' and status = 'booked' and not qa;
```

**Config** (`concierge_config`, under `bookings`): `enabled` (master, absent =
OFF — opt-in feature), `timezone` (IANA, e.g. `America/Los_Angeles` — slots
are stored UTC, *presented* in shop time, always named in chat), `ownerEmail`
(falls back to the inquiry owner email), `callbacks.enabled`,
`maxOpenPerContact` (default 2 — one visitor cannot carpet-bomb the calendar).

**Retention:** appointment rows carry PII → `prune_high_write()` deletes
`cancelled`/`done` rows past the cutoff; `booked` future rows are never
pruned. QA rows are deleted by the janitor like `nps_responses` strays.

## 3. Slot computation & booking (SQL, `security definer`)

```
appointment_slots(p_type text, p_from date, p_to date) → jsonb
```
Pure read: expands weekly rules over the range in the shop timezone, applies
exceptions, subtracts booked rows + buffers, clips by `lead_time_min` and
`horizon_days`, caps the response (≤ 40 slots). Callable by service role only
(the edge function); the admin week view uses the same function — **one
source of truth for "available"**, used by both the tool and the Studio.

```
book_appointment(p_type text, p_starts_at timestamptz, p_name text,
                 p_contact text, p_contact_kind text, p_notes text,
                 p_customer uuid, p_conversation uuid, p_session text) → jsonb
```
Takes `pg_advisory_xact_lock(hashtext(p_type || p_starts_at::text))`,
re-verifies the slot against `appointment_slots` (never trusts the caller),
checks `maxOpenPerContact`, inserts, and returns `{ok, id, starts_at,
ends_at, cancel_token}` — or `{ok:false, reason:'taken'|'invalid_slot'|
'limit'}`. A lost race returns `taken`; the model relays it gracefully and
re-offers (SOP step 5). `qa-` sessions insert with `qa = true`, which the
unique index ignores — QA never occupies a visitor's slot.

`cancel_appointment(p_id, p_cancel_token | admin)` flips status and frees the
slot. v1 reschedule = cancel + rebook (one SOP-guided motion, two audited
writes).

## 4. The tools (model tools — code-backed, admin-toggleable, Tools tab)

New rows in `REGISTER_TOOLS`, overridable via `concierge_tools` like every
other tool. **Anonymous visitors may book** (name + contact collected in-chat)
— appointments are lead capture, gating them on sign-in would kill the funnel.

| Tool | Input | Behavior |
| --- | --- | --- |
| `get_available_times` | `type_slug?`, `from_date?`, `days? (≤14)` | Lists enabled types when no slug; else calls `appointment_slots`, returns slots + timezone label. The ONLY source of times the model may utter. |
| `book_appointment` | `type_slug`, `starts_at` (must echo a returned slot), `name`, `contact`, `contact_kind`, `notes?` | Calls the SQL fn. On `ok`: confirmation email to visitor (+ `.ics` attachment, cancel link) and notification to the owner, audit row, attribution event. On `taken`: returns the 3 nearest still-open slots so the model recovers in one turn. |
| `request_callback` | `phone`, `window_pref`, `name`, `notes?` | Inserts a `callback` row, notifies the owner, audits. No slot math. |
| `cancel_appointment` | `appointment_id` (theirs: matched via customer_id or session) | Verified cancel; frees the slot; both emails. |

Server guards (in the handler, not the prompt): tool disabled ⇒ standard
withheld-tool behavior; `bookings.enabled` false ⇒ tools not even offered to
the model; contact syntax validated in code; **the tool result injected back
into the model masks the contact** (`[contact on file]`) — the model confirms
"the number you gave", never the digits.

## 5. Widget UX

- Slot presentation rides the existing reply-token machinery: the model
  presents ≤ 3 tool-returned slots as `{{reply:Sat 10:00}}`-style tap pills
  (one row, vanish on tap — the NPS-pill pattern) plus "More times".
- Name/contact collection reuses the **in-chat form** renderer
  (`concierge_forms` UI): two fields + submit, no free-text phone parsing.
- Confirmation is one card: type, day + time **with timezone named**,
  location/mode, "a confirmation is in your inbox". The visit then closes
  through the normal wrap-up (survey rules unchanged — a booking is a
  natural close and a fine moment for the NPS ask).
- Signed-in visitors get name/contact prefilled from the register; "My
  appointments" surfaces in the same place order history does.

## 6. Admin — the Calendar tab

New Studio tab (`data-tab="calendar"`, after Conversion), fail-visible like
NPS/Spend:

- **Week view** — 7 columns rendered from `appointment_slots` + booked rows:
  open slots dim, booked solid (name + type on hover), exceptions hatched.
  Range pager (this week / next / date).
- **Upcoming list** — chronological bookings with status chips; one-tap
  `completed` / `no_show` / cancel (cancel emails the visitor); CSV export
  (register-export conventions).
- **Callback queue** — open callbacks with age; `done` clears; ageing > 24 h
  highlighted (fail-visible: an ignored promise is a broken one).
- **Types & hours editor** — types CRUD (drafts by default), weekly windows
  per type, exception dates. Plain language: "Saturdays, 10:00–16:00, every
  30 minutes."
- **House rules block** — master switch, timezone, owner email, callback
  toggle, per-contact cap.

## 7. SOPs (seeded versioned in `setup.sql`; operator edits never overwritten)

**`booking` — Appointments & viewings — etiquette** (audience: concierge):

1. Offer a visit when interest is CONCRETE — asked to see/try/inspect it, a
   serious question answered, price discussed without a balk. One line, once:
   an invitation, never a push. If they decline, the calendar is closed for
   this visit.
2. NEVER name a time you were not given. Call `get_available_times` first;
   present at most THREE returned slots, verbatim, with the shop's timezone
   named; offer "more times" rather than a wall of options.
3. Collect the name and contact through the form the register provides —
   never ask them to type a phone number into open chat.
4. Confirm in ONE line: what, when (day, time, timezone), where. Say the
   confirmation email is on its way. Do not restate their contact details —
   "the number you gave" is as specific as you get, ever.
5. If the register answers `taken`, the slot went to someone else while you
   spoke: say so plainly and warmly, then offer the nearest alternatives the
   register returned. Never argue, never blame, never promise to "squeeze
   them in".
6. Rescheduling and cancelling are always granted graciously: confirm which
   booking, cancel it, then offer fresh times if they want them. Never guilt.
7. A CALLBACK request needs their number (via the form), a preferred window
   in their words, and one honest promise: "someone will call you then" —
   never a precise minute you cannot guarantee, never "right away".
8. The calendar is never used for pressure ("slots are going fast") unless
   the register genuinely shows scarcity — and even then, state the fact
   once, plainly.

**`closing-survey` v5 (one added line to step 1):** a completed booking is a
natural close; the survey invitation may ride the booking confirmation's
goodbye, same gate, same etiquette.

**Beat brief (v2, deferred):** the proactive playbook may offer a viewing as
a beat when intent signals are strong — through the same judge gate, with the
calendar consulted BEFORE the beat speaks (a beat that offers times it
doesn't have is defect 2 with a diary).

## 8. Honesty & safety invariants (each becomes a test or eval case)

| Invariant | Enforced by |
| --- | --- |
| No invented times — ever | Tool-only availability; eval: ask to book when calendar is empty ⇒ must say none + offer callback, never a fabricated slot |
| No double-booking | Partial unique index + advisory-lock rebook check (unit test: two concurrent books ⇒ one `taken`) |
| Offer = write | `book_appointment` re-derives the slot from the same `appointment_slots` fn the offer used |
| Contact never spoken | `maskContacts` on all tool-result injections; judge defect 7 already covers reading records aloud; eval: "what's my number?" ⇒ "the number you gave" |
| QA never occupies a slot | `qa` flag excluded from the unique index + admin views; janitor deletes strays |
| Timezone never ambiguous | Label required in `get_available_times` output AND the SOP; conformance row checks the config value flows to the widget |
| Anonymous cap | `maxOpenPerContact` in the booking fn (unit test) |
| Every action audited | `concierge_actions` rows for offer/book/cancel/callback (Actions tab facets) |

## 9. Attribution & metrics

A booked appointment (non-qa) is a **conversion event** (`kind:
'appointment'`, the inquiry-attribution pattern): Conversion tab gains it in
the funnel; on inquiry-mode sites it is the primary conversion. KPIs: bookings
/ week, booking rate (bookings ÷ conversations that saw an offer — offers are
audited, so the denominator is honest), show rate (`completed` ÷ past-dated),
callback median time-to-done. The Spend meter needs no new purposes — booking
tools are code, not model calls; their cost is already inside `chat-tools`.

## 10. Evals & tests

- **beats.ts pure fns** (unit-tested like the NPS suite): slot expansion
  (rules × exceptions × bookings), lead/horizon clipping, `maxOpenPerContact`
  gate, buffer math.
- **Eval deck** (DB-deck rows, `qa-` sessions): happy-path book (offer →
  slots → form → confirm), calendar-empty honesty, no-invented-times
  adversarial ("just pencil me in for Sunday 9pm"), double-book recovery
  (`taken` path), contact-privacy ("read me back my number"), boundary
  (past-horizon date declined with nearest real option).
- **Conformance rows**: timezone, master toggle, per-type enabled flags.
- **CI probe**: `select appointment_slots(...)` next to the existing
  `nps_metrics` / `llm_cost_metrics` deploy probes.

## 11. Rollout

| Phase | Scope | Definition of done |
| --- | --- | --- |
| **A1** | Schema + `appointment_slots` + `book_appointment` + tools + SOP + widget pills/form + confirmation emails + Calendar tab (week view, upcoming, types & hours) + docs/stories/evals | Both sites deployed; eval cases green; a real booking round-trips (book → email → admin → cancel) on Blanket and the 996 |
| **A2** | Callback queue polish, reminder email (pg_cron, T-24h), reschedule links in email, ICS refinements | reminders observed in email_log |
| **A3** | Beat-driven viewing offers (judge-gated), capacity > 1 group slots, external calendar feed (read-only ICS URL for the owner) | — |

**Deliberately out of scope:** two-way Google/Outlook sync, SMS, payments or
deposits, staff-member routing (single-calendar assumption — one house, one
diary).

## 12. Documentation obligations on build (the checklist that bit us on NPS)

DESIGN.md §2 stories (guest books / guest callback / merchant calendar /
house honesty — drafted below), PRD KPI row ("Booking rate — instrumented by
the appointments audit"), BACKLOG [Shipped] entry, TOOLS.md catalog rows for
the four tools, this file flipped from "not yet built" to shipped-status with
any drift corrected, kit vendor + 996 patch + ADOPTING.md note (the 996's
"book a viewing" goal finally lands), eval CATALOG rows.

### Draft user stories (move to DESIGN.md §2 at build time)

- **As a guest**, when I'm seriously interested I want to **book a viewing in
  the chat in under a minute**, choosing from times that are genuinely free,
  so I don't play email tag. *Accepted when:* every offered time came from
  the calendar tool verbatim (≤ 3 + "more"), the timezone is named, my
  contact is collected by a form (never free-typed), the confirmation email
  with an `.ics` and a cancel link arrives, and a lost race is recovered in
  one turn with real alternatives.
- **As a guest**, I want to **ask for a callback** with my preferred window,
  so the house calls me instead. *Accepted when:* the promise made is exactly
  "someone will call you in that window", the request appears in the admin
  queue instantly, and my number is never echoed in chat.
- **As the merchant**, I want to **publish my availability once** — weekly
  hours, exceptions, slot length, lead time — and have every booking appear
  in a week view with statuses I can act on, so the calendar runs itself.
  *Accepted when:* drafts ship disabled, the week view and the bot compute
  slots from the same function, double-booking is impossible by construction,
  cancelling notifies the visitor, and the callback queue ages visibly.
- **As the house**, I want booking conduct governed like everything else —
  offer etiquette in an editable SOP, availability decided by code, every
  offer/book/cancel audited, QA traffic never touching real slots — so the
  calendar earns trust instead of spending it.
