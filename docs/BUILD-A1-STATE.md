# A1 build state — appointments (working notes, delete before A1 ships)

Tracking the in-flight A1 build of APPOINTMENTS.md v3.2. Tasks #125–#130.
Blanket branch `claude/github-pages-deploy-14tf3y`.

## Done

- **#125 SQL (committed `0d091ad`)** — full schema + 9 fns integrated into BOTH
  sites' setup.sql (Blanket + /workspace/porsche996turbo) + CI probes in both
  deploy workflows + kit template. Proven on local Postgres 16
  (`/tmp/pga1`, port 55432, `su postgres`): 20 test groups ×2 applies +
  real two-session race (loser blocked 1.45s → 'taken'). Test assets in
  scratchpad: `appointments.sql` (the proven block), `appt_harness.sql`,
  `appt_tests.sql`, `appt_integrate.py`. Two bugs killed: SELECT INTO
  null-overwrite (v_ex_has_win), NULL-token ownership bypass (3× coalesce
  guard). Feature ships DARK: `bookings.enabled` absent = off; types draft.

## Key integration facts (verified line refs, Blanket index.ts @ 0d091ad)

- `pgRpc<T>(fn, args)` line 188 — call the SQL fns with it.
- `sendEmail(...)` line 497 (Resend); email_log exists.
- `REGISTER_TOOLS: any[]` line 844; `submit_inquiry` def at 981 is the
  anonymous-capable analog (its runRegisterTool branch at 1292 reads
  `input.session_key` — the FORM path injects it; for model-called tools the
  chat loop at ~5539 shows label map + special-casing (submit_inquiry
  conversion stamp at 5551) — inject session/conversation ctx into booking
  tool inputs the same way there).
- `runRegisterTool(name, input, customer, cid)` line 1207 — add branches for
  the 7 tools; call pgRpc; MASK contact in returned JSON (maskContacts
  exists); logAction(cid, customer, name, ...) is the audit helper.
- Anonymous tool exposure: find where tools array is assembled per request
  (search "tools:" in handleChatPost ~5460 + look for signed-out filtering;
  inquiry-mode anonymity precedent in handleFormPost 5928+).
- Config: `bookings` key in concierge_config (jsonb value).
  bookingsEnabled = value.enabled === true (absent = OFF). Gate: when off,
  do NOT include the 7 tools in the offered tools array; runRegisterTool
  branches also refuse.
- Visitor tz: widget must send context.tz (Intl...timeZone) — add to
  concierge.js ctx block + validated context passthrough; read in
  handleChatPost as wctx.tz, pass into tool input injection.
- HOURS context block: build from concierge_business_hours + locations
  (per-location "Mon 9:00–18:00" lines + 'closed now, opens …' computed in
  code) — inject as a system section like the CUSTOMER block; precedence
  note "outranks page prose".
- Customer context: upcoming appointment line — query
  concierge_appointments by customer_id status booked/requested future
  limit 1; add to customerBlock (masked contact, never digits).
- Judge defect 9: BEAT_JUDGE_CRITERION string — append "(9) naming a time,
  opening hour, or availability the register did not provide this turn".
- Attribution/funnel: submit_inquiry stamps conversion at 5551 — mirror for
  book_appointment ('appointment' kind, deepest-stage dedup on Conversion
  tab side).
- ICS: build in code (BEGIN:VCALENDAR...), UID = "appt-<coalesce(reschedule_of,id)>@<site>",
  attach via Resend attachments (base64).

## Progress update (post-#126/#127)

- **#126 Engine DONE (`632a6f1`)**: 7 tools + branches + gate + injection +
  labels + bookingContextBlock (HOURS + UPCOMING VISIT) + judge defect 9 +
  emails w/ ICS (sendEmail gained optional attachments param). TS-checked.
- **#127 Widget DONE (uncommitted with admin round)**: ctx.tz sent from both
  widgets (anchor: `var ctx = freshState();` in liveRespond); cache-busters
  Blanket v51 / 996 v5. DESIGN DECISION (document in APPOINTMENTS.md when
  flipping to shipped): slot pills = existing {{reply:…}} machinery (SOP
  instructs the model to render the ≤3 lead_labels as reply pills); contact
  collection v1 follows the submit_inquiry chat precedent (masked, never
  echoed); the dedicated slot-context in-chat form is A2 — spec §8 drift note
  needed.
- **Admin RPCs DONE**: appointments_week(p_days) + patron_appointments(uuid)
  added to BOTH setup.sql (anchor: after expire_stale_requests revoke) and
  locally tested green.
- **996 has UNCOMMITTED changes**: setup.sql (full appointments block + RPCs),
  workflow probe, concierge.js ctx.tz + index.html v5. index.ts NOT yet
  ported (engine-identical: git apply diff 0d091ad..<engine commit> for
  index.ts, or rerun appt_engine.py + appt_engine2.py + wart fix — scripts in
  scratchpad are anchor-based and brand-neutral, should apply clean).
- **Calendar admin tab**: next up (#128) — queue-first per spec §7; config
  save mirrors `sb.from('concierge_config').upsert([{key:'bookings',...}])`
  (pattern at admin.html:3212). Patron-drawer timeline + conversation badge
  + tab badge DEFERRED to the ship round (drawer anchor is order-centric,
  needs care) — note honestly in APPOINTMENTS.md if they slip past A1.

## Remaining tasks

- **#126 Engine**: 7 REGISTER_TOOLS defs (get_available_times,
  book_appointment, get_my_appointments, reschedule_appointment,
  update_appointment, cancel_appointment, request_callback) + runRegisterTool
  branches (pgRpc to the SQL fns; contact masking; taken→alternatives
  passthrough; manual-mode status in result), master gate, tool-input ctx
  injection (session/customer/conversation/visitor tz), emails (+ICS,
  deep links admin#calendar), HOURS block, customer-context upcoming line,
  coach brief line, judge defect 9, beat/reengage awareness (booked visitor
  → service framing note), request_callback insert via plain pgInsert
  (kind callback status open).
- **#127 Widget** (concierge.js both sites): ctx.tz send; slot pills row
  (reuse {{reply:...}} chips? simplest: model presents lead_labels as
  {{reply:}} pills — ALREADY supported by existing reply-token machinery;
  booking details form: reuse {{form:...}} renderer — check a booking form
  seeded in concierge_forms with submit_tool book_appointment? Simpler v1:
  model collects via existing inquiry-style form def seeded 'book-appointment'
  form with fields name/contact(+party) and submit_tool book_appointment —
  BUT form POST path needs slot/type context; alternative: model calls
  book_appointment tool directly after collecting via chat form... decide in
  #127; the spec allows the forms renderer with tool submit like inquiry
  forms (handleFormPost branch for book_appointment mirroring submit_inquiry).
- **#128 Admin** (admin.html both): Calendar tab (TAB_NAMES 'calendar',
  nav after Conversion) — queue via sb.rpc('appointments_queue'), actions via
  rpc confirm_appointment/cancel_appointment/close_appointment; week view via
  rpc appointment_slots per enabled type (types/locations readable directly —
  they're in the admin-all policy loop); locations/hours/types editors
  (progressive disclosure: hide location UI when 1 row); house-rules block
  (bookings config via existing config save path — check how cfg-nps-* saves
  write concierge_config); patron drawer appointments (needs an RPC:
  appointments are RLS-locked — add patron_appointments(p_customer uuid)
  admin RPC in a follow-up SQL round OR extend appointments_queue; NOTE:
  drawer needs per-customer list → add small RPC in #128 round, test in pg).
- **#129 SOP/docs/evals**: booking SOP (spec §9 verbatim, steps 1-9+1a+2b+8a),
  closing-survey v4→v5 chain, DESIGN stories move, PRD KPI row, BACKLOG
  shipped, TOOLS.md rows, CATALOG rows, eval deck rows (qa-), APPOINTMENTS.md
  flip to shipped.
- **#130 Ship**: strip-types check, kit vendor (index.ts, setup.sql,
  admin.html, concierge.js, workflow tmpl already probed) + ENGINE_VERSION +
  gates (tokens.manifest counts will need bumps for any new branded strings —
  avoid brand strings in new code; 'Feierabend' etc. forbidden), 996 patch
  via anchored scripts (stamped files) + git-apply-or-script for index.ts,
  deploys (deploy-concierge blocking schema + new probes; pages), verify
  runs green, headless widget probe on 996 clone (serve + chromium at
  /opt/pw-browsers/chromium, playwright-core from /workspace/concierge-kit).

## House rules that bite (reminders)

- No model identifier in committed artifacts; commits authored
  `Claude <noreply@anthropic.com>`; Blanket only on the designated branch.
- Never let a `;`-chained gate mask a failing stamp — check exit codes.
- tokens.manifest: any new occurrence of counted literals (brand hexes,
  'feier_admin_key', '--loden-deep', etc.) needs manifest count bumps.
- QA sessions: 'qa-' prefix → qa flag everywhere; never real side effects.
- Contact masking on EVERY tool-result injection (maskContacts).
- Emails via sendEmail + email_log; owner deep links three ways.
