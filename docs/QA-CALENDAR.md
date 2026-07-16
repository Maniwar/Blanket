# Calendar tab — QA evidence (UI/UX review)

**Method.** The tab's PRODUCTION code (the calendar JS region, the
House-rules and add-exception handlers, and the `.cal-*` CSS, extracted
verbatim from `admin.html`) runs against an instrumented stub data layer
that records every RPC and table mutation. A headless-Chromium driver loads
five scenarios — fresh install, populated, RPC-error, edge cases, mobile
(375 px) — screenshots each state, clicks every control, and asserts both
what renders and what would have been written to the database. Zero
`pageerror`s tolerated in any scenario.

**Re-run:** `python3 cal_qa.py && node cal_qa_drive.js` (scratchpad copies of
both scripts; the harness re-extracts from `admin.html` on every run, so it
always tests the current code).

## Result: 47 / 47 after one product fix

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
