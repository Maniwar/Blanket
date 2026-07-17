# Calendar tab — QA evidence (UI/UX review)

**Method.** The tab's PRODUCTION code (the calendar JS region, the
House-rules and add-exception handlers, and the `.cal-*` CSS, extracted
verbatim from `admin.html`) runs against an instrumented stub data layer
that records every RPC and table mutation. A headless-Chromium driver loads
five scenarios — fresh install, populated, RPC-error, edge cases, mobile
(375 px) — screenshots each state, clicks every control, and asserts both
what renders and what would have been written to the database. Zero
`pageerror`s tolerated in any scenario.

**Re-run:** `python3 cal_qa.py && node cal_qa_drive.js` — the scripts live in
`tools/qa/` (committed, restart-proof); the harness re-extracts from
`admin.html` on every run, so it always tests the current code.

## Result: 153 / 153 (current deck; originally 47 / 47 after one product fix)

The deck has grown with the tab: the original 47-check core (S1–S4 below)
plus staff & hours (S5–S8), departures (S9), breaks/time-off v2 (S10–S11),
grouped nav (S12), reports & exports incl. the operations-review CSV
(S13, S15), guarded removal (S14), capacity drill-in (S16), callback
accountability & the closed-out fold (S17), and the Judge & coach page
(S18 — now including the pause switches, the coach's draft strip, and the
digest preview/send), the time-off request lifecycle — chips,
approve/decline/return/restore, overlap visibility on every surface (S19) —
and the graphical-studio round: **S20 the painted week** (drag-create,
edge-resize, tap card, break split, remove — each gesture driven by real
pointer events and asserted against BOTH the picture and the typed rows the
save reads) and **S21 the Day Book's hands** (dragging a visit's mark shows
the floating clock, the drop card fires the same reschedule RPC the chat
uses; the empty-stretch chooser books a walk-in through book_appointment
with the lane's person named). S1 now walks the five-step first-run wizard
(quick-fill paints Mon–Fri, saves write the same delete-then-insert rows,
the offering copies the painted hours, WHO skips, Open-the-doors flips the
config and the note confirms), and S2.3 asserts the glance landing — six
clickable numbers, time-off decisions included, above the queue.
Latest run: **153/153, 22 screenshots**, zero page errors.

**Bug found and fixed by this pass** — the out-of-hours warning ("Saved —
but N window(s) fall entirely outside … business hours and will yield no
slots") was set and then immediately erased by the save's own tab reload,
so the operator never saw why their new availability produced nothing. The
offering-save handler now awaits the reload and re-applies the warning.

**Design confirmations** (checked, deliberate, not bugs):
- The queue shows the **real** visitor contact — the merchant must be able
  to call back. Masking (`[contact on file]`) is the **model-facing** rule;
  this surface is admin-gated and the table is RPC-only.
- A dark install renders every section honestly empty (no fake data, no
  spinners that never resolve), and the master switch **refuses** to enable
  until an enabled location has business hours — and writes nothing when it
  refuses.
- Every queue action (`Confirm`/`Decline`/`Done`/`Completed`/`No-show`)
  calls exactly the same RPC the chat uses, then reloads, so the two
  surfaces can never disagree.

## The checks

| # | Check | Result |
| --- | --- | --- |
| S1.1 | fresh: renders without errors | ✅ |
| S1.2 | fresh: 7 day columns even when empty | ✅ |
| S1.3 | fresh: all four queue sections present, all empty | ✅ |
| S1.4 | fresh: add-location row visible without data | ✅ |
| S1.5 | fresh: bookings switch reads OFF (config absent) | ✅ |
| S1.6 | fresh: enable REFUSED while no location has hours | ✅ |
| S1.7 | fresh: refusal wrote NOTHING | ✅ |
| S1.8 | fresh: add-location refuses empty fields | ✅ |
| S1.9 | fresh: valid add-location inserts | ✅ |
| S1.10 | fresh: exception without a date refused | ✅ |
| S2.1 | populated: renders without errors | ✅ |
| S2.2 | populated: tab badge counts pending (2+1+1) | ✅ |
| S2.3 | populated: TTL pills render (h-left + m-left) | ✅ |
| S2.4 | populated: move request labeled | ✅ |
| S2.5 | populated: dashed chip for unconfirmed in week grid | ✅ |
| S2.6 | populated: queue displays the contact the RPC returns (admin-gated surface) | ✅ |
| S2.7 | populated: house rules hydrate from config | ✅ |
| S2.8 | populated: split-shift hours render (Wed two ranges) | ✅ |
| S2.9 | populated: disabled location renders unchecked | ✅ |
| S2.10 | populated: offering knobs hydrate (capacity 2, manual) | ✅ |
| S2.11 | populated: availability line round-trips | ✅ |
| S2.12 | populated: exception rows keyed (closed + special hours) | ✅ |
| S2.13 | Confirm fires confirm_appointment(11) | ✅ |
| S2.14 | Decline fires cancel_appointment(11) | ✅ |
| S2.15 | callback Done fires close_appointment(done) | ✅ |
| S2.16 | No-show fires close_appointment(no_show) | ✅ |
| S2.17 | every action reloads the tab | ✅ |
| S2.18 | hours: bad range refused with the format named | ✅ |
| S2.19 | hours: valid save = delete then insert rows | ✅ |
| S2.20 | offering: bad availability line refused | ✅ |
| S2.21 | offering: out-of-hours window saved but WARNED | ✅ |
| S2.22 | exception: two windows refused (needs exactly one) | ✅ |
| S2.23 | exception: valid special-hours inserts with minutes | ✅ |
| S2.24 | rules: enable allowed WITH hours; upserts bookings config | ✅ |
| S3.1 | error: fail-visible note names the failure | ✅ |
| S3.2 | error: no throw escapes to the page | ✅ |
| S4.1 | edge: renders without errors | ✅ |
| S4.2 | edge: expired TTL shows "expiring" | ✅ |
| S4.3 | edge: callback 77h old flagged red | ✅ |
| S4.4 | edge: empty window_pref falls back to “any” | ✅ |
| S4.5 | edge: 6 chips stack in one day column | ✅ |
| S4.6 | edge: 3 locations → offering gains a location selector | ✅ |
| S4.7 | edge: long names/notes wrap, page never scrolls sideways | ✅ |
| S4.8 | edge: party of 12 renders | ✅ |
| S5.1 | mobile: renders without errors | ✅ |
| S5.2 | mobile: week grid scrolls inside its container, body does not | ✅ |
| S5.3 | mobile: action buttons still hit-sized (≥28px tall) | ✅ |

Scenario data highlights: expired TTL ("expiring"), a 77-hour-old callback,
party of 12, CJK + very long names/notes/titles, 6 bookings in one day
column, 3 locations (location selector appears), split-shift hours
(`09:00-13:00, 14:00-18:00`), closed + special-hours exceptions, and every
validation path (bad time range, bad availability line, two-window
exception, empty add-location, no-date exception).

---

## Later rounds (the harness grew with the product)

The 47-check pass above was the first sweep. The harness (same method,
re-extracts production code on every run) has since grown with each round —
current state: **101 / 101** across twelve scenario groups (the list below, plus **S9 breaks** — the one-tap daily break splits working days and the save writes both ranges; **S10 time off v2** — vacations as one entry, reasons, edit-in-place, past folded; **S11 the team's last 30 days** — report table with heat tones and honest dashes; **S12 the grouped nav** — four sections, roll-up badges, last-page memory, mobile rails; **S13 info-tips** — 15+ badges, tap opens a card without flipping the setting):

- **S1 fresh (Sam's walkthrough)** — three-step setup checklist, disabled
  (never refusing) master switch, quick-start hour templates, auto slugs,
  structured pickers; the only free text a first run types is a name.
- **S2 populated** — hydrated structured editors, split shifts, invalid
  ranges refused in plain words with nothing written, live slot preview via
  the real `appointment_slots` RPC, queue acts firing the right RPCs.
- **S6 the team (Marco)** — roster cards with digests, "with Maya/Jo" on
  queue rows, offerings naming their people, one-save person creation
  (hours grid + service ticks), personal time off never in the shop ledger,
  no slug rendered anywhere on the tab.
- **S7 the living calendar (A2.1)** — per-person coverage lanes (2 people ×
  7 days), working-hours bands, the mid-day time-off hatch ("Dr
  appointment", 13:00–14:00, right lane, right day), clickable ticks
  opening visit cards with status-fitting acts (Confirm fires the RPC and
  the card closes), tap-away dismissal, lane-click → two-tap time off
  (all-day insert verified; end-before-start refused), queue-row → tick
  flash, team toggle folding lanes away, email/phone riding the person
  save.
- **S8 departures (A2.2)** — unowned staffed visits flagged **needs a
  person**, "Give it a person" / "Hand to someone else" on the visit card
  firing `reassign_appointment`, the Team editor's "They've left" act
  firing `staff_departure` behind a confirm dialog and reporting the
  shuffle in plain words with the warning tone when someone still needs
  covering.
- **S3 error / S4 edge / S5 mobile** — fail-visible band with zero escaped
  throws; long-text wrap, EXPIRING/aging heat, warning roll-up, no lanes
  and a hidden toggle when there is no team; 375 px usable with native
  pickers and no sideways scroll.

Evidence: 13 screenshots + `results.json` per run (driver + harness live in
the session scratchpad; both regenerate from the current `admin.html`).
The SQL beneath S7/S8 is proven separately on a real local Postgres:
`staff_tests.sql` T1–T10 (slot gating, load spread, named requests, personal
time off, continuity moves, honest `nobody_free`, departure shuffle with
moved/stuck counts) plus a two-session race for the last free person, and
the full appointments block applies idempotently twice.
