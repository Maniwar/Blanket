# Studio QA harness — the calendar/nav/judge deck + the SQL proofs

These scripts are the evidence machine behind docs/QA-CALENDAR.md. They
re-extract PRODUCTION code from `admin.html` on every run, so they always
test the current studio — never a copy.

## The browser deck (137 checks, 20 screenshots)

    python3 cal_qa.py && python3 nav_qa.py && python3 jc_qa.py
    node cal_qa_drive.js

Each `*_qa.py` builds a self-contained HTML harness (real markup, real CSS,
real JS region; instrumented `sb` stub that records every RPC and mutation
to `window.DB_LOG`); `cal_qa_drive.js` drives them all headless (Chromium
via Playwright), asserting renders AND writes. Zero page errors tolerated.
Paths inside the scripts point at the session scratchpad by default — run
them from any writable directory after adjusting the two path constants,
or from the scratchpad as-is.

## The SQL proofs (local Postgres)

`staff_tests.sql` (T1–T14), `t23_25.sql` (time-off lifecycle blocks only
when approved), `t26.sql` (change_callback ownership), `t27.sql`
(judge_findings defect families) run against a scratch database carrying
the appointments block of `supabase/setup.sql` plus the harness stubs
(auth.jwt → service_role). `sql_order_lint.py` gates setup.sql against
forward references.

Committed here so a workspace reset can never erase the deck again.
