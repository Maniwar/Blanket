# Appointments & callbacks — v1 SHIPPED (spec v3.2 + drift notes)

**Status:** A1 is built and live-dark (master switch off until the admin sets
hours and flips it — Calendar tab). The SQL core was proven against a live
Postgres 16 before ship: 20 test groups, double-applied, plus a real
two-session race (the loser blocked on the advisory lock and got `taken`).

**v1 drift from the spec below (each deliberate, each with a path):**

- **Contact collection** is in-chat (the `submit_inquiry` precedent: masked in
  every injection, never echoed); the dedicated slot-context in-chat form is
  A2 (§8 as written describes the A2 end-state).
- **Slot pills** ride the existing `{{reply:…}}` machinery (SOP 2b); no new
  widget renderer was needed.
- **A1.1 SHIPPED** (the cohesion round): the patron drawer's
  "Appointments & callbacks" timeline (via `patron_appointments_by` — the
  drawer knows email/user id, not the customers-table id), the 📅 badge on
  Conversations rows, and the hard `Booked a visit` stage in the Conversion
  behavioral funnel (callbacks and cancellations excluded; hidden until the
  calendar has ever produced a row, so a dark feature never draws a fake
  zero line). All fed by one bounded `appointment_facets` fetch, cached per
  session and refreshed when the Calendar tab reloads.
- **Queue ageing** is wall-clock with a >24 h highlight; business-time ageing
  is A2. **Callback next-opening phrasing** comes from the HOURS block + SOP
  8/8a (the model reads the table with local-now provided); register-computed
  phrasing is A2.
- **Request TTL** sweeps opportunistically when the queue opens (plus any
  future cron), not on a timer.
- **Calendar tab presentation** (post-ship, owner feedback): the queue is a
  triage board (status pills, TTL countdowns, waiting ages), the 7-day view is
  a real calendar grid (dashed chip = awaiting confirmation), locations/hours
  and offerings are labeled cards ("concurrent slots", not "cap"), and the
  add-location row is always visible. Same ids, same RPCs — rendering only.

---


The concierge's next act: turning buying intent into a **booked moment** — a
viewing, a fitting, a table, a consultation — or a **callback request** when
the visitor would rather talk. The admin publishes availability; the model
offers only what the calendar really has; tested code does the booking; the
merchant works from one queue. Nothing here is implemented yet — this
document is the build contract.

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
5. **One guest, one thread.** An appointment is not an island: it ties to the
   patron profile, the conversation that produced it, and the coach's context
   — §6.
6. **Fail-visible, audited, QA-clean.** Every tool call writes an audit row;
   `qa-` sessions never occupy a real slot; admin surfaces show errors, not
   blanks.

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Appointment type** | An admin-defined offering: "Viewing — 30 min at the workshop", "Discovery call — 15 min video". Duration, mode, slot increment, buffers, booking window, confirm mode, party size. |
| **Location** | A place bookings happen — name, address, **its own IANA timezone**, its own business hours, its own on/off switch. Every house has ≥ 1; a single-location house sees none of this complexity (§3b). |
| **Business hours** | Per-location open hours (weekly ranges + holiday closures) — the outer boundary everything else lives inside. Powers the bot's "are you open?" answer, clamps callback promises, and caps every type's bookable windows. §3a. |
| **The toggle cascade** | `bookings.enabled` (master) → `location.enabled` → `type.enabled`. Off at any level removes slots below it; standing bookings always survive a toggle (§3b). |
| **Availability rule** | Weekly recurring windows per type, in the shop's wall-clock time: "Sat 10:00–16:00" — always intersected with business hours. |
| **Slot increment** | The grid inside a window — admin-selectable **5 / 10 / 15 / 20 / 30 / 45 / 60 min** (per type, overridable per rule). A 10:00–12:00 window at 15 min yields 10:00, 10:15, … |
| **Exception** | A dated override: closed on the 24th; extra evening window on the 30th. |
| **Slot** | A *computed* bookable start time — never stored until booked. Slots = rules − exceptions − existing bookings − buffers − lead time − horizon. |
| **Appointment** | A booked slot with a name + contact. Lifecycle: (`requested →`) `booked → completed / cancelled / no_show`. |
| **Callback request** | "Have someone call me" — a number + preferred window, no slot consumed. Lifecycle `open → done / cancelled`. |
| **The queue** | The merchant's single actionable inbox: everything that needs a decision or is happening today. §7. |

## 2. Time zones — the full story

Times are the one thing this feature must never fumble. Three clocks are in
play; each has a defined role:

| Clock | Role |
| --- | --- |
| **UTC** | Storage. `starts_at`/`ends_at` are `timestamptz`; all math is UTC. |
| **Location time** (each location's IANA timezone) | The calendar's authoring language. Rules and exceptions are defined in the location's **wall-clock** time and expanded per-date in that zone — a "Sat 10:00" slot is 10:00 local on both sides of a DST change (unit-tested at both DST boundaries). Two locations in two timezones are two independent clocks. |
| **Visitor time** | The presentation language. The widget detects `Intl.DateTimeFormat().resolvedOptions().timeZone` and sends it as context; the tool returns each slot with BOTH renderings pre-formatted. |

**Presentation rules (code formats, the model recites — it never converts):**

- Zones match → one time, zone named once: *"Saturday 10:00 (PT)"*. With
  multiple locations, the location is ALWAYS named beside the time.
- Zones differ, **in-person** type → location time leads (they must show up
  there): *"Saturday 10:00 at the Marfa studio (CT) — that's 8:00 your
  time"*.
- Zones differ, **video/phone** type → visitor time leads: *"Saturday 13:00
  your time (10:00 PT)"*.
- Visitor zone undetectable → location time, zone always named.
- Confirmation email and card show both; the `.ics` is UTC-based so every
  calendar app localizes it correctly by itself.

The model NEVER does timezone arithmetic: `get_available_times` returns
`{starts_at_utc, shop_label, visitor_label, lead_label}` per slot and the SOP
requires reciting `lead_label` verbatim. An LLM converting timezones in its
head is a missed flight waiting to happen.

## 3. Schema (feature-owned, additive; all tables RLS-enabled)

### 3a. Locations & business hours — the outer boundary

```sql
create table concierge_locations (
  id         bigint generated always as identity primary key,
  slug       text unique not null,             -- 'main', 'marfa-studio'
  title      text not null,
  address    text not null default '',
  timezone   text not null,                    -- IANA; each location keeps its own clock
  directions text not null default '',         -- rides the confirmation email
  enabled    boolean not null default true,    -- the per-location toggle
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

create table concierge_business_hours (
  id          bigint generated always as identity primary key,
  location_id bigint not null references concierge_locations(id) on delete cascade,
  dow         smallint not null check (dow between 0 and 6),   -- 0 = Sunday, location-local
  open_min    smallint not null check (open_min between 0 and 1439),
  close_min   smallint not null check (close_min between 1 and 1440),
  check (close_min > open_min)
);
-- no rows for a dow = closed that day at that location; a location with no
-- hours at all cannot be enabled (same refusal rule as a missing timezone)
```

Each location owns its hours; multiple ranges per day are first-class (the
lunch-break case: Tue 9:00–13:00 and 14:00–18:00 is two rows). Location-wide
closures reuse the exceptions table with `type_id = null` and the location
set. Virtual types (video/phone) attach to a location too — the humans taking
the call sit somewhere with hours and a clock.

### 3b. One location or many — and the toggle cascade

**Progressive disclosure.** `setup.sql` seeds one location, `main`, from the
config timezone. A single-location house NEVER sees the dimension: no
location column in the queue, no picker in chat, no filter in the week view.
The moment a second location row exists, the dimension appears everywhere at
once (queue chips, week-view filter, chat choice, email address lines).
Multi-location is capability, not ceremony.

**The toggle cascade** — three switches, one rule each:

| Switch | Off means |
| --- | --- |
| `bookings.enabled` (master, absent = OFF) | The tools are not even offered to the model; the Calendar tab shows the queue read-only with a plain banner. |
| `location.enabled` | That location yields no slots and is not offered in chat; its standing bookings remain in the queue and week view (flagged) — a toggle is never a cancellation. |
| `type.enabled` | Same, scoped to the type (drafts ship disabled — the kit rule). |

An off switch is always **visible honesty**: the admin shows what is off and
why nothing is bookable, never a mysteriously empty picker. The model, for
its part, simply doesn't have the tool or the slots — it cannot offer what
the cascade has removed.

What business hours power (each is a build requirement, not a nicety):

1. **The clamp.** `appointment_slots` intersects every type window with
   business hours before anything else. A type window that falls outside
   open hours yields nothing — and the Types & hours editor warns inline
   ("Saturday 18:00–20:00 is outside Saturday hours 10:00–16:00") instead of
   failing silently.
2. **The bot knows when the house is open.** Hours are injected into the
   concierge's context as a structured HOURS block (source-of-truth
   precedence over free-text KB claims — a stale "open Sundays" paragraph
   loses to the table). "Are you open Sunday?" is answered from data,
   including the next opening time when currently closed.
3. **Callback promises live inside open hours.** The register clamps the
   promised window: a callback requested Saturday night is promised for
   "Monday morning, when the house opens" — the exact phrasing is provided
   by the tool result, recited by the model (same no-arithmetic rule as
   timezones).
4. **Queue ageing counts open hours.** The callbacks "overdue" highlight
   ages in business time — a request over a closed Sunday is not "ignored".
5. **Bookings already made stand.** Shrinking hours never auto-cancels
   existing bookings; they remain visible in the week view (flagged
   "outside current hours") for the merchant to handle personally.

```sql
create table concierge_appointment_types (
  id            bigint generated always as identity primary key,
  slug          text unique not null,           -- 'viewing', 'discovery-call'
  title         text not null,
  description   text not null default '',       -- shown to the visitor by the bot
  duration_min  int  not null default 30,
  step_min      smallint not null default 30    -- slot increment (the grid)
                check (step_min in (5,10,15,20,30,45,60)),
  mode          text not null default 'in-person'
                check (mode in ('in-person','video','phone')),
  location      text not null default '',       -- address / "link sent by email"
  buffer_min    int  not null default 0,        -- gap enforced after each booking
  lead_time_min int  not null default 240,      -- earliest bookable = now + lead
  horizon_days  int  not null default 21,       -- latest bookable
  capacity      int  not null default 1,        -- concurrent bookings per slot (tables, group sessions)
  max_party     smallint not null default 0,    -- >0: bot asks party size, caps it
  confirm_mode  text not null default 'auto'    -- auto: booked instantly;
                check (confirm_mode in ('auto','manual')),  -- manual: merchant confirms
  intake_prompt text not null default '',       -- optional one extra question, e.g. "Anything you'd like us to prepare?"
  enabled       boolean not null default false, -- drafts first (kit discipline)
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now()
);

create table concierge_availability (
  id          bigint generated always as identity primary key,
  type_id     bigint not null references concierge_appointment_types(id) on delete cascade,
  location_id bigint not null references concierge_locations(id) on delete cascade,
  -- a type is OFFERED at a location iff rules exist there; types stay global
  dow       smallint not null check (dow between 0 and 6),   -- 0 = Sunday, shop-local
  start_min smallint not null check (start_min between 0 and 1439),
  end_min   smallint not null check (end_min   between 1 and 1440),
  step_min  smallint check (step_min in (5,10,15,20,30,45,60)),  -- null = type default
  check (end_min > start_min)
);

create table concierge_availability_exceptions (
  id          bigint generated always as identity primary key,
  location_id bigint references concierge_locations(id) on delete cascade,        -- null = every location
  type_id     bigint references concierge_appointment_types(id) on delete cascade,  -- null = all types
  on_date   date not null,                      -- shop-timezone date
  closed    boolean not null default true,      -- true: no slots that day
  start_min smallint, end_min smallint,         -- else: REPLACE the day's windows
  note      text not null default ''
);

create table concierge_appointments (
  id              bigint generated always as identity primary key,
  kind            text not null default 'appointment'
                  check (kind in ('appointment','callback')),
  type_id         bigint references concierge_appointment_types(id) on delete set null,
  location_id     bigint references concierge_locations(id) on delete set null,
  starts_at       timestamptz,                  -- null for callbacks
  ends_at         timestamptz,
  window_pref     text,                         -- callbacks: 'weekday mornings', their words
  party_size      smallint,                     -- when the type sets max_party
  status          text not null default 'booked'
                  check (status in ('requested','booked','completed','cancelled',
                                    'no_show','open','done')),  -- last two: callbacks
  visitor_name    text not null,
  visitor_contact text not null,                -- email or phone; NEVER injected unmasked
  contact_kind    text not null check (contact_kind in ('email','phone')),
  visitor_tz      text not null default '',     -- IANA, as detected at booking
  notes           text not null default '',     -- their answer to intake_prompt / own words
  customer_id     uuid,                         -- §6: the verified identity tie
  conversation_id uuid references concierge_conversations(id) on delete set null,
  session_key     text,
  cancel_token    uuid not null default gen_random_uuid(),  -- emailed self-serve cancel
  qa              boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index concierge_appt_customer_idx on concierge_appointments (customer_id, starts_at desc);
create index concierge_appt_convo_idx    on concierge_appointments (conversation_id);

-- The race-killer: one live booking per (type, start) at capacity 1; a
-- 'requested' row occupies the slot exactly like a 'booked' one. Capacity > 1
-- is enforced inside book_appointment() under an advisory lock.
create unique index concierge_appt_slot_uniq
  on concierge_appointments (type_id, location_id, starts_at)
  where kind = 'appointment' and status in ('requested','booked') and not qa;
```

**Config** (`concierge_config`, under `bookings`): `enabled` (master, absent =
OFF — opt-in feature; the full cascade is §3b), `timezone` (IANA — seeds the
`main` location; thereafter each location owns its clock), `ownerEmail` (falls back to the
inquiry owner email), `callbacks.enabled`, `maxOpenPerContact` (default 2 —
one visitor cannot carpet-bomb the calendar), `requestTtlHours` (default 24;
manual-confirm requests not acted on in time auto-cancel with an apologetic
email and free the slot; 0 = never expire).

**Retention:** appointment rows carry PII → `prune_high_write()` deletes
terminal rows (`cancelled`/`done`/`completed`/`no_show`) past the cutoff;
future `requested`/`booked` rows are never pruned. QA rows are deleted by the
janitor like `nps_responses` strays.

## 4. Slot computation & booking (SQL, `security definer`)

```
appointment_slots(p_type text, p_location text, p_from date, p_to date, p_visitor_tz text) → jsonb
```
Pure read: clamps to business hours (§3a), expands weekly rules over the
range **in the shop timezone** (per-date, DST-correct), applies exceptions,
subtracts
`requested`+`booked` rows and buffers, clips by `lead_time_min` and
`horizon_days`, honors per-rule `step_min` falling back to the type's, and
returns each slot with the pre-formatted labels of §2. Response capped
(≤ 40 slots per call — at 5-minute increments the model still only *presents*
three; the cap keeps payloads sane). Callable by service role only; the admin
week view and queue use the **same function** — one source of truth for
"available", shared by the tool and the Studio.

```
book_appointment(p_type text, p_location text, p_starts_at timestamptz, p_name text,
                 p_contact text, p_contact_kind text, p_party smallint,
                 p_notes text, p_visitor_tz text,
                 p_customer uuid, p_conversation uuid, p_session text) → jsonb
```
Takes `pg_advisory_xact_lock(hashtext(p_type || p_starts_at::text))`,
re-verifies the slot against `appointment_slots` (never trusts the caller),
checks capacity, `max_party`, and `maxOpenPerContact`, inserts with status
`booked` (`confirm_mode='auto'`) or `requested` (`'manual'`), and returns
`{ok, id, status, starts_at, ends_at, cancel_token}` — or `{ok:false,
reason:'taken'|'invalid_slot'|'limit'|'party_too_large'}`. A lost race
returns `taken`; the model relays it gracefully and re-offers (SOP step 6).
`qa-` sessions insert with `qa = true`, which the unique index ignores — QA
never occupies a visitor's slot.

`confirm_appointment(p_id)` (admin/queue): `requested → booked`, confirmation
email fires. `cancel_appointment(p_id, p_cancel_token | admin)` flips status
and frees the slot.

```
reschedule_appointment(p_id, p_new_location text, p_new_starts_at timestamptz,
                       …ownership proof…) → jsonb
```
**Atomic, never-stranding.** One transaction takes advisory locks on BOTH
slots (ordered by hash, no deadlock), re-verifies the new slot via
`appointment_slots`, then moves the booking. If the new slot is `taken`, the
transaction rolls back and **the original booking stands untouched** — a
failed move must never leave the guest with nothing. Manual-confirm types
keep the same guarantee across the human step: the move lands as a
`requested` row while the original stays `booked` until the house confirms;
confirming completes the swap, declining leaves the original in place (the
"no gap" rule). The confirmation email reuses the **same ICS `UID`**, so the
guest's calendar app updates the existing event instead of duplicating it.

```
update_appointment(p_id, p_party smallint?, p_notes text?, p_name text?,
                   p_contact text?, p_contact_kind text?, …ownership proof…) → jsonb
```
Non-time edits — party size (re-validated against `max_party` and slot
capacity), the intake answer, a name or contact correction (masked in the
tool result like everywhere else). Callback rows accept window/number
updates through the same function. Every field change is audited.

## 5. The tools (model tools — code-backed, admin-toggleable, Tools tab)

New rows in `REGISTER_TOOLS`, overridable via `concierge_tools` like every
other tool. **Anonymous visitors may book** (name + contact collected in-chat)
— appointments are lead capture, gating them on sign-in would kill the funnel.

| Tool | Input | Behavior |
| --- | --- | --- |
| `get_available_times` | `type_slug?`, `location_slug?`, `from_date?`, `days? (≤14)` | Lists enabled types (and, when more than one, enabled locations) when unscoped; with a type at multiple locations and none chosen, returns the location choice FIRST — the model asks, never assumes. Then `appointment_slots` with the visitor timezone; slots carry §2 labels with the location named. The ONLY source of times (and locations) the model may utter. |
| `book_appointment` | `type_slug`, `starts_at` (must echo a returned slot), `name`, `contact`, `contact_kind`, `party_size?`, `notes?` | Calls the SQL fn. `booked` ⇒ confirmation email to visitor (+ `.ics`, cancel link) and owner notification. `requested` ⇒ "request received" email; the model says the house will confirm (SOP step 5). Either way: audit row, attribution event, queue entry. On `taken`: returns the 3 nearest still-open slots so the model recovers in one turn. |
| `get_my_appointments` | — (signed-in, or same-session anonymous) | The visitor's upcoming/past bookings, contact masked. Powers "when am I coming in again?" and §6 continuity. |
| `reschedule_appointment` | `appointment_id`, `new_starts_at` (must echo a returned slot), `new_location_slug?` | The atomic move. On `taken`: the original stands, and the result says so with fresh alternatives — the model reassures first ("your Saturday time is still yours"), then re-offers. Manual mode: the "no gap" framing from SOP step 7. |
| `update_appointment` | `appointment_id`, `party_size?`, `notes?`, `name?`, `contact?` | Non-time edits; party re-validated; contact masked in the result. Also fixes callback windows/numbers. |
| `cancel_appointment` | `appointment_id` (theirs: matched via customer_id or session) | Verified cancel; frees the slot; both emails. |
| `request_callback` | `phone`, `window_pref`, `name`, `notes?` | Inserts a `callback` row, notifies the owner, joins the queue. No slot math. |

Server guards (in the handler, not the prompt): tool disabled ⇒ standard
withheld-tool behavior; `bookings.enabled` false ⇒ tools not even offered to
the model; contact syntax validated in code; **every tool result injected
back into the model masks the contact** (`[contact on file]`) — the model
confirms "the number you gave", never the digits.

### 5a. Appointments and `submit_inquiry` — a ladder, not a replacement

The inquiry tool stays exactly as it is. The two capture **different
intents**, and together they form an escalation ladder with a floor that
never disappears:

| Rung | Intent | Tool |
| --- | --- | --- |
| **Booked time** | "I want to see it / meet / talk *at a time*" | `book_appointment` — the strongest commitment |
| **Callback** | "Call me" — synchronous, but the house picks the moment | `request_callback` |
| **Inquiry** | "Answer me / here's my offer / send me the records" — asynchronous | `submit_inquiry` — unchanged |

Routing is intent-based (one SOP line, step 1a): a question or an offer is an
inquiry; a wish to talk is a callback; a wish to be there is a booking. Never
double-capture — one ask, one instrument; if a visitor books, their question
rides the booking's `notes`, not a parallel inquiry.

**Graceful degradation is the design, not an accident:**

- No slots in range → offer a callback; callbacks off or declined → take an
  inquiry. The visitor always leaves *captured*, never bounced.
- The whole calendar toggled off (§3b) → the system behaves exactly as it
  does today: inquiry-first. Adopters can enable bookings when ready; nothing
  about the inquiry path is touched by the rollout.
- On the 996, the "book a viewing" journey goal UPGRADES from the inquiry
  form to the booking flow when the calendar goes live; the generic inquiry
  ("make an offer", "ask about the records") remains beside it. `adopt
  generate` seeds a viewing type for inquiry-mode sites and points the
  section goal at it.

**Funnel accounting (no double-counting):** a conversation that produced both
an inquiry and a booking counts ONCE in the Conversion funnel, at the deeper
stage (`booked` > `inquiry`); the shallower event stays visible on the
conversation record but not in the stage totals. The owner's inquiry email
already notes an existing booking (§6a) so replies land with full context.

## 6. Identity & cohesion — one guest, one thread

An appointment participates in the same identity fabric as orders, inquiries,
and ratings. The ties, and what each buys:

| Tie | Written when | What it powers |
| --- | --- | --- |
| `customer_id` | Booker is signed in (verified — the `meta.user_id` standard from inquiries) | **Patron drawer 360°**: appointments listed beside orders and ratings, status-chipped. **Bot continuity**: the customer context block carries the next upcoming appointment (time + type only, contact masked) so a returning patron hears *"see you Saturday at 10"*, not a stranger's greeting. **Coach**: the brief notes an upcoming/no-show appointment as private grounding — never quoted back verbatim (judge defect 7 applies). |
| `conversation_id` | Always (the booking conversation) | **Conversations list**: a 📅 facet/badge on conversations that produced a booking; from the queue, one click opens the transcript that led to the appointment — the merchant walks in knowing what was discussed. |
| `session_key` | Always | Same-session self-service for anonymous bookers ("actually, cancel that") without an account. |
| Email/phone match | Anonymous booking whose contact later matches a patron | **Patrons book**: shown like inquiries — `Appointment ✓` when verified by `customer_id`, `Appointment (unverified)` on bare contact match. Unverified ties NEVER grant the bot recall of that patron's history (the impersonation rule). |

Practical consequences worth naming: cancelling from the patron drawer, the
queue, or the chat all mutate the same row; the NPS coach sees a no-show as
context; attribution ties the eventual sale back through the conversation
that booked the viewing.

### 6a. The cohesion map — what every subsystem shows and links

The linking rule, stated once and enforced everywhere: **any surface that
shows an appointment links to its patron, its conversation, and its queue
entry; any surface that shows a patron or a conversation shows their
appointments.** No dead ends — every card is a doorway.

| Subsystem | Integration (build requirement) |
| --- | --- |
| **Patron drawer 360°** | Appointments & callbacks timeline beside orders, ratings, and notes — status-chipped, with confirm/cancel actions inline (same writes as the queue) and each row linking to its source conversation. |
| **House notes / directives** | The queue's *Today* rows surface the patron's OPEN house notes ("give him the VIN report when he visits") — the visit is where standing instructions come due. A note resolved at the visit resolves through the existing directive reconciler. |
| **Conversations** | 📅 facet + filter ("has booking"); the transcript view shows the booking card inline at the turn it happened; from the queue, one click lands on that turn. |
| **Actions tab** | offer / book / confirm / cancel / no-show / callback rows with facets, like every audited action today. |
| **Orders / register** | No hard FK in v1; the patron drawer shows both timelines side by side, and attribution (below) carries the causal chain. Post-purchase care appointments are the A3 beat. |
| **NPS** | A booking is a natural close (survey may ride it — gate unchanged); a `completed` visit enriches the coach's brief; the survey cooldown prevents a booking-close ask AND a post-visit ask from stacking. |
| **Coach** | The pre-draft brief carries the next appointment, recent no-shows, and visit-due house notes — private grounding, never quoted (defect 7). |
| **Judge** | New defect (9): *naming a time, an opening hour, or availability the register did not provide this turn.* The proactive-line gate learns the calendar's honesty rule. |
| **Beats / re-engagement** | A visitor with an upcoming booking is NOT re-sold: the re-engage bubble and openers read the appointment from context and switch to service framing ("see you Saturday — anything to prepare?"). Post-no-show rebooking is an A2 beat through the normal judge gate. |
| **Inquiries** | Same-session inquiry + booking cross-link; the inquiry email to the owner notes the existing booking so the house replies with full context. |
| **Emails** | Every owner notification deep-links three ways: the queue entry (`admin#calendar`), the patron, the conversation. The merchant goes from inbox to acting in one click. |
| **Attribution / Conversion tab** | `booked` becomes a funnel stage between *conversation* and *order/inquiry*; an eventual sale after a viewing attributes through the chain chat → booking → order. |
| **Website (CMS)** | A2: an optional `data-cms` hours slot renders the SAME business-hours table on the page — one source of truth for the footer, the bot, and the calendar. |
| **Edit history** | `concierge_edit_history` triggers extend to types, availability, business hours — who changed Saturday's hours, and when, is answerable (bookings are commitments; their rules deserve an audit trail). |
| **Admin search** | Queue and appointment lists searchable by name/contact fragment (masked rendering, full value on the row only — the register-search conventions). |
| **Spend** | Nothing new needed — booking tools are code (`chat-tools` already meters the rounds that call them); noted so nobody adds a purpose out of reflex. |

## 7. Admin — the Calendar tab, queue-first

New Studio tab (`data-tab="calendar"`, after Conversion), fail-visible like
NPS/Spend. **The queue leads the tab** — merchants act first, browse second:

- **The queue** — one actionable inbox, oldest-first within groups:
  1. **Awaiting confirmation** — `requested` rows (manual mode) with age and
     TTL countdown; ✓ confirm / ✗ decline (both email the visitor).
  2. **Callbacks** — `open` rows with age; > 24 h highlighted (an ignored
     promise is a broken one); "done" clears.
  3. **Today** — today's bookings in shop time, with the visitor's name,
     type, party size, notes, and a link to the source conversation.
  4. **Needs closing** — past-dated `booked` rows awaiting `completed` /
     `no_show` (one tap each; this is what makes the show-rate KPI honest).
  A queue-count badge on the tab itself (like unread counts) so a pending
  request is never invisible.
- **Week view** — 7 columns rendered from `appointment_slots` + booked rows:
  open slots dim, booked solid (name + type on hover), requested striped,
  exceptions hatched. Range pager (this week / next / date). Times in shop
  timezone, labeled.
- **Types & hours editor** — types CRUD (drafts by default): duration, mode,
  location, **increment picker (5/10/15/20/30/45/60)**, buffer, lead time,
  horizon, capacity, max party, confirm mode, intake question. Weekly windows
  per type with optional per-window increment override; exception dates.
  Plain language everywhere: "Saturdays 10:00–16:00, every 15 minutes."
- **Locations editor** — appears only when needed (§3b): add/rename
  locations, address, timezone, directions, the per-location switch. Queue
  and week view gain location chips the moment a second location exists.
- **House hours editor** — the business-hours grid per location (per day,
  multiple ranges for split days, "closed" toggles) plus closure dates.
  Sits ABOVE the types editor: types are edited in its shadow, with inline
  warnings when a type window escapes it.
- **House rules block** — master switch (refused until BOTH a timezone and
  business hours are set), timezone picker, owner email, callback toggle,
  per-contact cap, request TTL.
- **Export** — bookings CSV (register-export conventions).

## 8. Widget UX

- Slot presentation rides the existing reply-token machinery: the model
  presents ≤ 3 tool-returned slots as tap pills (one row, vanish on tap —
  the NPS-pill pattern) plus "More times". Labels come from the tool (§2),
  already localized.
- Name/contact collection reuses the **in-chat form** renderer
  (`concierge_forms` UI): name + contact (+ party size when the type asks,
  + the intake question when set) — no free-text phone parsing, tap targets
  ≥ 44 px, autocomplete attributes set.
- Confirmation is one card: type, day + time in the visitor's terms with
  both zones when they differ, location/mode, party size, and either "a
  confirmation is in your inbox" or "the house will confirm shortly — you'll
  have an email either way" (manual mode). The visit then closes through the
  normal wrap-up (survey rules unchanged — a booking is a natural close and
  a fine moment for the NPS ask).
- Signed-in visitors get name/contact prefilled from the register;
  `get_my_appointments` answers "when am I coming in?" in one turn.

## 9. SOPs (seeded versioned in `setup.sql`; operator edits never overwritten)

**`booking` — Appointments & visits — etiquette** (audience: concierge):

1. Offer a visit when interest is CONCRETE — asked to see/try/taste/inspect,
   a serious question answered, price discussed without a balk. One line,
   once: an invitation, never a push. If they decline, the calendar is
   closed for this visit.
1a. Route by intent, one instrument per ask: a question or an offer is an
   INQUIRY; "call me" is a CALLBACK; "I'll come by / let's meet" is a
   BOOKING. If the calendar has nothing to give, step down the ladder —
   callback, then inquiry — so they always leave captured, never bounced.
2. When the house has more than one location, ask WHERE before WHEN — offer
   the locations the register lists, plainly, and never assume. Confirmations
   always name the place.
2b. NEVER name a time you were not given. Call `get_available_times` first;
   present at most THREE returned slots, using EXACTLY the time labels the
   register provides (they already speak the visitor's timezone); offer
   "more times" rather than a wall of options.
3. Collect the name and contact through the form the register provides —
   never ask them to type a phone number into open chat. If the register
   asks a party size or an extra question, ask it plainly, once.
4. Confirm in ONE line: what, when (recite the register's label — never
   convert times yourself), where. Say the confirmation email is on its way.
   Do not restate their contact details — "the number you gave" is as
   specific as you get, ever.
5. If the register answers that the house confirms requests, promise exactly
   that: "the house will confirm shortly — you'll have an email either way."
   Never present a request as a done deal.
6. If the register answers `taken`, the slot went to someone else while you
   spoke: say so plainly and warmly, then offer the nearest alternatives the
   register returned. Never argue, never blame, never promise to "squeeze
   them in".
7. Changes are always granted graciously — moving, resizing, correcting, or
   cancelling. First confirm WHICH booking (the register lists theirs); then
   make exactly the change they asked, and restate the result in one line.
   When moving a time: their existing slot is safe until the new one is
   theirs — if the new time was just taken, say their original still stands
   and offer the alternatives the register returned. When the house confirms
   moves by hand, say both truths plainly: the current booking holds; the
   new time awaits the house's confirmation. Never guilt, never a
   cancellation they didn't ask for.
8. A CALLBACK request needs their number (via the form), a preferred window
   in their words, and one honest promise: "someone will call you then" —
   never a precise minute you cannot guarantee, never "right away". When the
   house is closed, promise what the register provides — "when the house
   opens Monday at 9" — never a window the house cannot keep.
8a. Asked whether the house is open, answer from the HOURS the register
   provides — including when it opens next — never from memory or the page's
   prose if they disagree.
9. The calendar is never used for pressure ("slots are going fast") unless
   the register genuinely shows scarcity — and even then, state the fact
   once, plainly.

**`closing-survey` v5 (one added line to step 1):** a completed booking is a
natural close; the survey invitation may ride the booking confirmation's
goodbye, same gate, same etiquette.

**Beat brief (v2, deferred):** the proactive playbook may offer a viewing as
a beat when intent signals are strong — through the same judge gate, with the
calendar consulted BEFORE the beat speaks (a beat that offers times it
doesn't have is defect 2 with a diary).

## 10. Industry fit — one engine, many houses (the PM/UX pass)

The same six knobs — duration, increment, mode, capacity, party, confirm —
compose into very different businesses without code changes. Worked examples
(these become the kit's `adopt generate` presets):

| Industry | Type config | Notes |
| --- | --- | --- |
| **Private car sale** (the 996) | Viewing · 30 min · in-person · step 30 · capacity 1 · auto | The pilot. Booking = the conversion. |
| **Atelier / boutique** (Blanket) | Fitting · 45 min · in-person · step 15 · buffer 15 · auto | Buffer protects reset time between guests. |
| **Restaurant / tasting room** | Table · 90 min · in-person · step 15 · capacity 6 · max party 8 · auto | Capacity = concurrent tables per slot; party size asked in-chat. |
| **Consultant / agency** | Discovery call · 15 min · video · step 5 · lead 60 min · manual | 5-min grid packs a calendar; manual confirm protects the human's day. |
| **Salon / studio** | Session · 60 min · in-person · step 10 · buffer 10 · auto | Increment ≠ duration: fine-grained starts, hour-long service. |
| **Home services** | Arrival window · 120 min · in-person · step 60 · manual + callbacks | Long slots read as windows; callbacks carry the triage load. |
| **Two-city gallery** | Private showing · 45 min · in-person · step 30 · two locations, own hours & timezones | The location question comes first in chat; each city keeps its own clock and closures. |

UX invariants across all of them: the visitor never sees an internal slug
(titles/descriptions are merchant copy); vocabulary in SOPs stays
industry-neutral ("a visit", "the house") and the kit stamps brand nouns;
dates render locale-aware; three-choices-then-more keeps every industry's
picker scannable; scarcity talk is fact-gated (SOP 9) — no dark patterns in
any vertical. Deliberately NOT built in v1: per-staff calendars, resource
routing, deposits — the single-diary assumption kept v1 honest. Per-staff
calendars have since shipped as A2 with their own schema (§16); resource
routing and deposits remain out.

## 11. Honesty & safety invariants (each becomes a test or eval case)

| Invariant | Enforced by |
| --- | --- |
| No invented times — ever | Tool-only availability; eval: ask to book when calendar is empty ⇒ must say none + offer callback, never a fabricated slot |
| No model timezone math | Labels pre-formatted in code; eval: visitor in another zone asks "what's that my time?" ⇒ recites the provided label, never computes |
| DST never shifts a shop slot | Rules expand per-date in shop zone; unit tests at both DST boundaries |
| No double-booking | Partial unique index (covers `requested`+`booked`) + advisory-lock recheck (unit test: two concurrent books ⇒ one `taken`) |
| Offer = write | `book_appointment` re-derives the slot from the same `appointment_slots` fn the offer used |
| A request is never sold as a booking | `status` in the tool result + SOP step 5; eval: manual-confirm type ⇒ reply must contain the "house will confirm" framing |
| Contact never spoken | `maskContacts` on all tool-result injections; judge defect 7; eval: "read me back my number" ⇒ "the number you gave" |
| Unverified ties grant nothing | Email-match shows in the Patrons book only; recall requires `customer_id` (the inquiries rule) |
| QA never occupies a slot | `qa` excluded from the unique index + queue/views; janitor deletes strays |
| Anonymous cap | `maxOpenPerContact` in the booking fn (unit test) |
| Type windows never escape business hours | `appointment_slots` clamp (unit test) + inline editor warning |
| Location never assumed | Tool returns the choice when ambiguous; eval: two locations ⇒ the bot asks where before offering times |
| A toggle is never a cancellation | Cascade semantics (§3b); unit test: disabling a location hides slots, keeps bookings |
| A reschedule never strands the guest | Atomic dual-lock move; failed move ⇒ original untouched (unit test: concurrent take of the target slot); manual mode holds the original until confirmation |
| Calendar apps update, never duplicate | Stable ICS `UID` across reschedules |
| Edits re-validate what booking validated | party change re-checks `max_party`/capacity; time change re-derives the slot (unit tests) |
| Two locations, two clocks | Per-location tz expansion (DST tests run per location) |
| Callback promises fit open hours | Register-provided phrasing; eval: callback at Saturday close ⇒ promise names the next opening, never "tomorrow morning" on a closed Sunday |
| "Are you open?" answered from data | HOURS context block outranks KB prose (conformance row: hours flow bot-visible) |
| Every action audited | `concierge_actions` rows for offer/book/confirm/cancel/callback (Actions tab facets) |
| One ask, one instrument | SOP 1a + eval: a booked visitor's question must not spawn a parallel inquiry; funnel counts a conversation once, at its deepest stage |
| No dead-end surfaces | The §6a linking rule; conformance row walks drawer → appointment → conversation → queue and back |
| A booked guest is served, not re-sold | Beat/reengage context carries the upcoming booking; judge defect 9 (inventing times/hours) vetoes; eval: reengage bubble for a booked visitor must not pitch |

## 12. Attribution & metrics

A booked appointment (non-qa) is a **conversion event** (`kind:
'appointment'`, the inquiry-attribution pattern): Conversion tab gains it in
the funnel; on inquiry-mode sites it is the primary conversion. KPIs:
bookings / week, booking rate (bookings ÷ conversations that saw an offer —
offers are audited, so the denominator is honest), show rate (`completed` ÷
past-dated — powered by the queue's "needs closing" discipline), median
time-to-confirm (manual mode), callback median time-to-done. The Spend meter
needs no new purposes — booking tools are code, not model calls; their cost
is already inside `chat-tools`.

## 13. Evals & tests

- **Pure fns** (unit-tested like the NPS suite): slot expansion (rules ×
  exceptions × bookings × buffers × increments), DST boundaries, lead/horizon
  clipping, capacity & `max_party` & `maxOpenPerContact` gates, label
  formatting for both-zone cases.
- **Eval deck** (DB-deck rows, `qa-` sessions): happy-path book (offer →
  slots → form → confirm), calendar-empty honesty, no-invented-times
  adversarial ("just pencil me in for Sunday 9pm"), timezone recital,
  manual-confirm framing, double-book recovery (`taken` path),
  contact-privacy ("read me back my number"), boundary (past-horizon date
  declined with nearest real option), party-too-large grace, the
  modification flows ("move my Tuesday to Thursday" happy path; reschedule
  race ⇒ reassurance that the original stands + fresh options; party bump
  past the cap declined with the cap named), open-hours
  honesty ("are you open Sunday?" against a closed Sunday + a stale KB
  paragraph claiming otherwise — the table must win).
- **Conformance rows**: timezone, master toggle, per-type enabled flags,
  increment honored in offered slots.
- **CI probe**: `select appointment_slots(...)` next to the existing
  `nps_metrics` / `llm_cost_metrics` deploy probes.

## 14. Rollout

| Phase | Scope | Definition of done |
| --- | --- | --- |
| **A1** | Schema + `appointment_slots` + `book_appointment`/confirm/cancel + all five tools + `booking` SOP + widget pills/form + emails (+`.ics`, deep links) + Calendar tab (queue with notes-due, week view, house hours, types & hours) + the §6/§6a cohesion set (patron drawer timeline, conversation badge + inline card, judge defect 9, beat awareness, funnel stage, edit-history triggers) + docs/stories/evals | Both sites deployed; eval cases green; a real booking round-trips (book → email → queue → confirm → patron drawer → cancel) on Blanket and the 996 |
| **A2** | Reminder email (pg_cron, T-24h), reschedule links in email, queue niceties (bulk close, day notes), ICS refinements, post-no-show rebooking beat (judge-gated), CMS hours slot | reminders observed in `email_log` |
| **A3** | Beat-driven viewing offers (judge-gated), external read-only ICS feed for the owner, multi-staff exploration (schema RFC first) | — |

**Deliberately out of scope for v1:** two-way Google/Outlook sync, SMS,
payments or deposits. Per-staff routing, planned here as an A3 RFC, shipped
as A2 — see §16 for what was actually built.

## 15. Documentation obligations on build (the checklist that bit us on NPS)

DESIGN.md §2 stories (drafted below), PRD KPI row ("Booking rate —
instrumented by the appointments audit"), BACKLOG [Shipped] entry, TOOLS.md
catalog rows for the seven tools, this file flipped from "not yet built" to
shipped-status with any drift corrected, kit vendor + 996 patch + ADOPTING.md
note + `adopt generate` industry presets (§10), eval CATALOG rows.

### Draft user stories (move to DESIGN.md §2 at build time)

- **As a guest**, when I'm seriously interested I want to **book a visit in
  the chat in under a minute**, choosing from times that are genuinely free
  and shown **in my own timezone**, so I don't play email tag or do clock
  math. *Accepted when:* every offered time came from the calendar tool
  verbatim (≤ 3 + "more") with visitor-and-shop zones labeled per §2, my
  contact is collected by a form (never free-typed), the confirmation email
  with an `.ics` and a cancel link arrives, a manual-confirm request is
  never framed as a done deal, and a lost race is recovered in one turn with
  real alternatives.
- **As a guest**, I want to **ask for a callback** with my preferred window,
  so the house calls me instead. *Accepted when:* the promise made is exactly
  "someone will call you in that window", the request appears in the queue
  instantly, and my number is never echoed in chat.
- **As a returning patron**, I want the house to **remember my booking** —
  "see you Saturday at 10" — and let me check, move, resize, correct, or
  cancel it in chat as easily as I made it. *Accepted when:* the upcoming
  appointment rides the customer context (contact masked),
  `get_my_appointments` answers in one turn, a move is atomic (my old time
  is mine until the new one is), a failed move tells me my booking still
  stands before offering alternatives, my calendar app updates the existing
  event rather than adding a second, and cancel from chat / email link /
  patron drawer all mutate the same row.
- **As the merchant**, I want to run bookings across **more than one
  location** — each with its own address, hours, and timezone — or switch
  the whole feature (or one location, or one type) **off** without losing a
  single standing booking. *Accepted when:* a single-location house never
  sees the extra dimension, the location question precedes the time question
  in chat, every confirmation names the place, each location's slots expand
  in its own clock, and any toggle removes future slots while the queue
  keeps every existing commitment visible.
- **As the merchant**, I want to **set my business hours once** — per-day
  open ranges (split days included), holiday closures — and have everything
  respect them: bookable windows clamped inside them, the bot answering
  "are you open?" from them, callback promises never landing in a closed
  hour. *Accepted when:* the master switch refuses without hours, a type
  window outside hours warns at edit time and yields no slots, and the
  HOURS block outranks stale page prose in the bot's answers.
- **As the merchant**, I want to **publish availability once** — types,
  weekly hours, a slot increment I choose (5–60 min), exceptions, lead time
  — and then **work from one queue**: confirm requests, mark today's
  visits done or no-show, clear callbacks before they age. *Accepted when:*
  drafts ship disabled, the master switch refuses to turn on without a
  timezone, the week view and the bot compute slots from the same function,
  double-booking is impossible by construction, the queue badges pending
  work on the tab, and every queue row links to the conversation that
  produced it.
- **As the merchant**, I want **everything about one guest one click apart**:
  opening a patron shows their appointments beside their orders, notes, and
  ratings; an appointment links to the conversation that created it; the
  queue shows me the notes that come due at the visit; the owner email drops
  me exactly where I act. *Accepted when:* the §6a linking rule holds in a
  conformance walk (drawer → appointment → conversation → queue → drawer)
  and no surface that mentions a booking is a dead end.
- **As the house**, I want booking conduct governed like everything else —
  offer etiquette in an editable SOP, availability and timezone math decided
  by code, every offer/book/confirm/cancel audited, unverified contact
  matches granting no recall, QA never touching real slots — so the calendar
  earns trust instead of spending it.

## 16. The team — what shipped as A2 / A2.1 / A2.2 (drift notes, 2026-07)

The rollout table above (§14) predates the build; what actually shipped under
the A2 name is the staff dimension, in three rounds. Everything below is live
on both sites and proven by the local-Postgres suite (`staff_tests.sql`,
T1–T10) plus the 76-check admin QA harness.

**Schema (additive, all RLS'd like §3):** `concierge_staff` (name, `email`,
`phone`, enabled, sort order — no slug anywhere), `concierge_staff_hours`
(per person × location × dow open/close minutes — their hours live INSIDE
business hours), `concierge_staff_services` (who does which offering),
`concierge_appointments.staff_id`, and personal time off as
`concierge_availability_exceptions.staff_id` rows — a person's day off (or a
mid-day window, the "Dr appointment" case) never reads as a shop closure;
every shop-level query filters `staff_id is null`.

**Slot semantics:** an offering with any `concierge_staff_services` row is
*staffed* — a slot exists only when a qualified, enabled person is working
(their hours ∩ the window ∩ business hours), not on time off, and free of
overlapping bookings across ALL offerings (buffers respected), with total
occupancy still under the offering's `capacity`. Unstaffed offerings behave
exactly as v1 (§4). Slots carry the available people's first names; the
booking write assigns one INSIDE a per-person advisory lock
(`hashtext('staff|'||id||'|'||starts_at)`) taken after the slot lock — a race
across two offerings can never double-book a human (T4, plus a genuine
two-session race test). A visitor naming a person gets only that person;
unnamed requests go to the least-loaded. Reschedules prefer the same person
(continuity) and reassign only when they're not free.

**Admin (the living calendar):** the Team card manages people — structured
hours grid, service ticks, contact details, dated time off (all-day or a
window). The week view grows per-person coverage lanes (toggleable): hours
bands, red hatches for time off, their bookings as marks; clicking a lane day
quick-adds time off; clicking any mark opens the visit card with
status-appropriate acts; clicking a queue row flashes its mark. Queue and
week rows say "with Maya"; a staffed visit nobody owns is flagged **needs a
person**.

**Notifications:** staff `email` receives engine-driven booking mail (request
pending / on your calendar with `.ics` / time released) on chat-driven book,
cancel, and move. Honest limitation: admin-queue acts (Confirm/Decline, the
departure shuffle) run client-side against SQL RPCs and send no mail — the
Resend key lives server-side only. Staff emails never reach model-facing
tool results (stripped before the JSON the model sees).

**Departures (A2.2 — "someone may leave"):** `reassign_appointment(id,
person?)` hands one future visit to another qualified free person under the
same candidate rules + per-person lock (refuses honestly with `nobody_free`);
`staff_departure(staff_id)` retires the person and shuffles every future
visit of theirs, nearest first — whoever can't be covered is left standing
but **unassigned**, so the queue flags it instead of leaving it on a calendar
nobody reads (T9/T10). In the admin: "Hand to someone else" / "Give it a
person" on the visit card, and "They've left — hand bookings to the team" in
the person editor, which reports the shuffle in plain words.

**The operations round (A2.3, same week):** lunches and breaks — a person's
day supports split ranges natively (a slot must fit inside ONE range, proven
by T11: nothing can be sold across the gap) and the person editor grew a
one-tap "daily break" that splits every working day around it. Time off was
rebuilt for years of use: a vacation is one entry with an end date (one
all-day row per day underneath), entries carry a reason, anything can be
edited in place (delete-then-reinsert, same pattern as hours), consecutive
days read as one stretch, past entries fold behind a count, and
`prune_high_write` retires dated exceptions after 400 days (longer than any
report window). `staff_report(p_days)` computes per-person adherence &
productivity — scheduled minutes from the same rows the slot engine sells
from, booked minutes, utilization, kept/no-show/kept-rate, days off,
upcoming — with NULL (never fake-zero) rates; the Team card renders it as
"The last 30 days" with a heat tone under 80% kept (T12 proves exact
numbers). Every calendar option now wears a tap-to-read info badge
(master switch, callbacks, caps, TTL, confirm mode, bookable, buffers,
lead/horizon, timezone, per-person toggles). The studio nav regrouped into
four sections (Front desk / Results / Training / The house) — one line, the
open section's pages beneath, badge counts rolling up to their section.
