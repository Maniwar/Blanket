-- A2 staff tests. Runs on: harness + appointments.sql (v1 block) + staff_delta.
-- Fixture: viewing (45min, cap 3, auto-confirm for booking tests), loc 'main'
-- open every day 08:00-20:00; Maya works Tue-Sat 09:00-17:00; Jo Sat-Sun
-- 10:00-16:00. Both do 'viewing'. Next-week dates keep lead-time out of play.
\set ON_ERROR_STOP on
begin;
delete from public.concierge_appointments;
delete from public.concierge_availability;
delete from public.concierge_availability_exceptions;
delete from public.concierge_staff_services;
delete from public.concierge_staff_hours;
delete from public.concierge_staff;
delete from public.concierge_business_hours;
update public.concierge_appointment_types
  set enabled = true, capacity = 3, confirm_mode = 'auto', buffer_min = 0,
      lead_time_min = 0, horizon_days = 30, duration_min = 45, step_min = 60
  where slug = 'viewing';
insert into public.concierge_business_hours (location_id, dow, open_min, close_min)
  select l.id, d, 480, 1200 from public.concierge_locations l, generate_series(0,6) d
  where l.slug = 'main';
insert into public.concierge_availability (type_id, location_id, dow, start_min, end_min, step_min)
  select t.id, l.id, d, 480, 1200, null
  from public.concierge_appointment_types t, public.concierge_locations l, generate_series(0,6) d
  where t.slug = 'viewing' and l.slug = 'main';
insert into public.concierge_staff (name) values ('Maya'), ('Jo');
insert into public.concierge_staff_hours (staff_id, location_id, dow, open_min, close_min)
  select s.id, l.id, d, 540, 1020 from public.concierge_staff s, public.concierge_locations l,
    generate_series(2,6) d where s.name = 'Maya' and l.slug = 'main';
insert into public.concierge_staff_hours (staff_id, location_id, dow, open_min, close_min)
  select s.id, l.id, d, 600, 960 from public.concierge_staff s, public.concierge_locations l,
    (values (6),(0)) v(d) where s.name = 'Jo' and l.slug = 'main';
insert into public.concierge_staff_services (staff_id, type_id)
  select s.id, t.id from public.concierge_staff s, public.concierge_appointment_types t
  where t.slug = 'viewing';
commit;

-- helper: next occurrence of a dow, at least 3 days out (lead/today noise off)
create or replace function pg_temp.nextdow(d int) returns date language sql as
$$ select (current_date + 3) + ((7 + d - extract(dow from current_date + 3)::int) % 7) $$;

-- T1: Saturday noon — both work → slot carries both names
do $$
declare v jsonb; s jsonb;
begin
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(6), pg_temp.nextdow(6), null);
  select x into s from jsonb_array_elements(v->'slots') x
    where (x->>'starts_at')::timestamptz
          = ((pg_temp.nextdow(6)::timestamp + interval '12 hours') at time zone 'America/Los_Angeles');
  if s is null then raise exception 'T1: no Saturday noon slot'; end if;
  if jsonb_array_length(s->'staff') <> 2 then
    raise exception 'T1: expected 2 staff, got %', s->'staff'; end if;
  raise notice 'T1 ok — Saturday noon offers Maya + Jo';
end $$;

-- T2: Monday — nobody works → NO slots despite open hours + windows
do $$
declare v jsonb;
begin
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(1), pg_temp.nextdow(1), null);
  if jsonb_array_length(v->'slots') <> 0 then
    raise exception 'T2: Monday should be empty, got %', jsonb_array_length(v->'slots'); end if;
  raise notice 'T2 ok — no qualified person, no slots';
end $$;

-- T3: Tuesday 10:00 — only Maya; early Saturday 09:00 — only Maya (Jo starts 10)
do $$
declare v jsonb; s jsonb;
begin
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(2), pg_temp.nextdow(2), null);
  select x into s from jsonb_array_elements(v->'slots') x limit 1;
  if s->'staff' <> '["Maya"]'::jsonb then raise exception 'T3: expected only Maya, got %', s->'staff'; end if;
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(6), pg_temp.nextdow(6), null);
  select x into s from jsonb_array_elements(v->'slots') x
    where (x->>'starts_at')::timestamptz
          = ((pg_temp.nextdow(6)::timestamp + interval '9 hours') at time zone 'America/Los_Angeles');
  if s is null or s->'staff' <> '["Maya"]'::jsonb then
    raise exception 'T3b: 09:00 Sat should be Maya only, got %', coalesce(s->'staff','null'); end if;
  raise notice 'T3 ok — per-person hours drive the names';
end $$;

-- T4: unnamed bookings spread the load; third same-slot try is refused
do $$
declare r1 jsonb; r2 jsonb; r3 jsonb; t0 timestamptz;
begin
  t0 := (pg_temp.nextdow(6)::timestamp + interval '12 hours') at time zone 'America/Los_Angeles';
  r1 := public.book_appointment('viewing','main', t0, 'Guest A','a@x.io','email');
  r2 := public.book_appointment('viewing','main', t0, 'Guest B','b@x.io','email');
  r3 := public.book_appointment('viewing','main', t0, 'Guest C','c@x.io','email');
  if (r1->>'ok')::bool is not true or (r2->>'ok')::bool is not true then
    raise exception 'T4: first two should book: % / %', r1, r2; end if;
  if r1->>'staff_name' = r2->>'staff_name' then
    raise exception 'T4: both landed on %', r1->>'staff_name'; end if;
  if (r3->>'ok')::bool is true or r3->>'reason' <> 'taken' then
    raise exception 'T4: third should be taken (capacity 3 but only 2 humans), got %', r3; end if;
  raise notice 'T4 ok — spread load, emergent capacity = people (% / %)',
    r1->>'staff_name', r2->>'staff_name';
end $$;

-- T5: naming a person books THAT person; naming someone not working is refused
do $$
declare r jsonb; t2 timestamptz;
begin
  t2 := (pg_temp.nextdow(2)::timestamp + interval '10 hours') at time zone 'America/Los_Angeles';
  r := public.book_appointment('viewing','main', t2, 'Guest D','d@x.io','email',
        null, '', null, null, null, 'sess-t5', 'maya');
  if (r->>'ok')::bool is not true or r->>'staff_name' <> 'Maya' then
    raise exception 'T5: named booking failed: %', r; end if;
  r := public.book_appointment('viewing','main',
        (pg_temp.nextdow(2)::timestamp + interval '11 hours') at time zone 'America/Los_Angeles',
        'Guest E','e@x.io','email', null, '', null, null, null, null, 'jo');
  if (r->>'ok')::bool is true or r->>'reason' <> 'taken' then
    raise exception 'T5b: Jo does not work Tuesdays, got %', r; end if;
  raise notice 'T5 ok — named person honored; absent person refused honestly';
end $$;

-- T6: personal time off removes only that person; shop day survives
do $$
declare v jsonb; s jsonb; d date;
begin
  d := pg_temp.nextdow(3);
  insert into public.concierge_availability_exceptions (on_date, closed, staff_id)
    select d, true, id from public.concierge_staff where name = 'Maya';
  v := public.appointment_slots('viewing','main', d, d, null);
  if jsonb_array_length(v->'slots') <> 0 then
    raise exception 'T6: Wed has only Maya; her day off should empty it'; end if;
  -- Saturday still has Jo even with Maya off
  insert into public.concierge_availability_exceptions (on_date, closed, staff_id)
    select pg_temp.nextdow(6), true, id from public.concierge_staff where name = 'Maya';
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(6), pg_temp.nextdow(6), null);
  select x into s from jsonb_array_elements(v->'slots') x
    where (x->>'starts_at')::timestamptz
          = ((pg_temp.nextdow(6)::timestamp + interval '15 hours') at time zone 'America/Los_Angeles');
  if s is null or s->'staff' <> '["Jo"]'::jsonb then
    raise exception 'T6b: Saturday 15:00 should be Jo only, got %', coalesce(s->'staff','gone'); end if;
  delete from public.concierge_availability_exceptions where staff_id is not null;
  raise notice 'T6 ok — time off is personal, never shop-wide';
end $$;

-- T7: reschedule keeps the person when free, reassigns when not
do $$
declare r jsonb; rid bigint; t2 timestamptz; t3 timestamptz;
begin
  -- Guest D holds Maya Tue 10:00 (from T5). Move them to Tue 13:00 → Maya again.
  select id into rid from public.concierge_appointments
    where visitor_name = 'Guest D' and status = 'booked';
  t2 := (pg_temp.nextdow(2)::timestamp + interval '13 hours') at time zone 'America/Los_Angeles';
  r := public.reschedule_appointment(rid, 'main', t2, null, null, null, 'sess-t5');
  if (r->>'ok')::bool is not true then raise exception 'T7: move failed %', r; end if;
  if (select st.name from public.concierge_appointments a
        join public.concierge_staff st on st.id = a.staff_id where a.id = rid) <> 'Maya' then
    raise exception 'T7: should stay with Maya'; end if;
  -- Saturday: A holds one person at 12:00 (from T4). Move Guest D onto Sat 12:00:
  -- Maya may be busy there; whoever is free takes it — assigned, never null.
  t3 := (pg_temp.nextdow(6)::timestamp + interval '13 hours') at time zone 'America/Los_Angeles';
  r := public.reschedule_appointment(rid, 'main', t3, null, null, null, 'sess-t5');
  if (r->>'ok')::bool is not true then raise exception 'T7b: move failed %', r; end if;
  if (select staff_id from public.concierge_appointments where id = rid) is null then
    raise exception 'T7b: reschedule lost the assignment'; end if;
  raise notice 'T7 ok — moves keep a person attached';
end $$;

-- T8: queue + week rows carry the person's name
do $$
declare q jsonb; w jsonb;
begin
  w := public.appointments_week(30);
  if not exists (select 1 from jsonb_array_elements(w) x where x->>'staff' in ('Maya','Jo')) then
    raise exception 'T8: week rows carry no staff name: %', w; end if;
  raise notice 'T8 ok — surfaces name the person';
end $$;

select 'ALL STAFF TESTS PASSED' as verdict;

-- T9: single reassign — refused when nobody else qualifies; hands over when free
do $$
declare r jsonb; fid bigint; did bigint; before text;
begin
  -- Guest F: named Maya, Tuesday 10:00 (only she works Tuesdays)
  r := public.book_appointment('viewing','main',
        (pg_temp.nextdow(2)::timestamp + interval '10 hours') at time zone 'America/Los_Angeles',
        'Guest F','f@x.io','email', null, '', null, null, null, 'sess-t9', 'maya');
  if (r->>'ok')::bool is not true then raise exception 'T9: setup booking failed %', r; end if;
  fid := (r->>'id')::bigint;
  r := public.reassign_appointment(fid, null);
  if (r->>'ok')::bool is true or r->>'reason' <> 'nobody_free' then
    raise exception 'T9: Tuesday reassign should be nobody_free, got %', r; end if;
  -- Guest D sits on Saturday 13:00 (from T7); the other person is free then
  select a.id, st.name into did, before from public.concierge_appointments a
    join public.concierge_staff st on st.id = a.staff_id
    where a.visitor_name = 'Guest D' and a.status in ('requested','booked');
  r := public.reassign_appointment(did, null);
  if (r->>'ok')::bool is not true then raise exception 'T9b: reassign failed %', r; end if;
  if r->>'staff_name' = before then raise exception 'T9b: still with %', before; end if;
  raise notice 'T9 ok — honest refusal on Tue; Saturday visit changed hands (% -> %)',
    before, r->>'staff_name';
end $$;

-- T10: departure — retire Maya, shuffle her book; the stuck become unassigned
do $$
declare r jsonb; gid bigint;
begin
  -- Guest G: named Maya, Saturday 15:00 — Jo is free there, so this one moves
  r := public.book_appointment('viewing','main',
        (pg_temp.nextdow(6)::timestamp + interval '15 hours') at time zone 'America/Los_Angeles',
        'Guest G','g@x.io','email', null, '', null, null, null, 'sess-t10', 'maya');
  if (r->>'ok')::bool is not true then raise exception 'T10: setup booking failed %', r; end if;
  gid := (r->>'id')::bigint;
  r := public.staff_departure((select id from public.concierge_staff where name = 'Maya'));
  if (r->>'ok')::bool is not true then raise exception 'T10: departure failed %', r; end if;
  if (select enabled from public.concierge_staff where name = 'Maya') then
    raise exception 'T10: Maya should be disabled'; end if;
  -- moved: Guest G -> Jo. stuck: Guest A (Jo already busy 12:00) + Guest F (Tue)
  if (r->>'moved')::int <> 1 or (r->>'needs_attention')::int <> 2 then
    raise exception 'T10: expected moved=1 stuck=2, got %', r; end if;
  if (select st.name from public.concierge_appointments a
        join public.concierge_staff st on st.id = a.staff_id where a.id = gid) <> 'Jo' then
    raise exception 'T10: Guest G should now be with Jo'; end if;
  if (select count(*) from public.concierge_appointments
        where staff_id is null and status in ('requested','booked')
          and visitor_name in ('Guest A','Guest F')) <> 2 then
    raise exception 'T10: Guest A + Guest F should be unassigned'; end if;
  raise notice 'T10 ok — departure: 1 handed to Jo, 2 flagged for attention';
end $$;

select 'ALL STAFF TESTS PASSED (incl. departures)' as verdict;

-- T11: a lunch break (split ranges) — no slot may land in the gap
do $$
declare v jsonb; d date; bad int; pre int; post int;
begin
  delete from public.concierge_appointments;
  delete from public.concierge_availability_exceptions;
  update public.concierge_staff set enabled = true;
  -- Maya's Tuesday becomes 09:00-12:00 + 13:00-17:00 (lunch 12-1)
  delete from public.concierge_staff_hours
    where staff_id = (select id from public.concierge_staff where name = 'Maya') and dow = 2;
  insert into public.concierge_staff_hours (staff_id, location_id, dow, open_min, close_min)
    select s.id, l.id, 2, v2.a, v2.b from public.concierge_staff s, public.concierge_locations l,
      (values (540, 720), (780, 1020)) v2(a, b)
    where s.name = 'Maya' and l.slug = 'main';
  d := pg_temp.nextdow(2);
  v := public.appointment_slots('viewing','main', d, d, null);
  -- 45-min visits: nothing may START in 11:16..12:59 (would cross or sit in lunch)
  select count(*) into bad from jsonb_array_elements(v->'slots') x
    where (x->>'starts_at')::timestamptz
          >  ((d::timestamp + interval '11 hours 15 minutes') at time zone 'America/Los_Angeles')
      and (x->>'starts_at')::timestamptz
          <  ((d::timestamp + interval '13 hours') at time zone 'America/Los_Angeles');
  if bad <> 0 then raise exception 'T11: % slot(s) landed in the lunch gap: %', bad, v; end if;
  select count(*) into pre from jsonb_array_elements(v->'slots') x
    where (x->>'starts_at')::timestamptz
          <= ((d::timestamp + interval '11 hours 15 minutes') at time zone 'America/Los_Angeles');
  select count(*) into post from jsonb_array_elements(v->'slots') x
    where (x->>'starts_at')::timestamptz
          >= ((d::timestamp + interval '13 hours') at time zone 'America/Los_Angeles');
  if pre = 0 or post = 0 then
    raise exception 'T11: morning (%) and afternoon (%) must both offer slots', pre, post; end if;
  raise notice 'T11 ok — the lunch gap is unsellable (% before, % after)', pre, post;
end $$;

-- T12: staff_report — numbers add up and rates are honest
do $$
declare r jsonb; m jsonb; j jsonb; mid bigint; util int;
begin
  select id into mid from public.concierge_staff where name = 'Maya';
  -- her book, planted directly (report reads outcomes, not the booking path):
  -- one kept visit yesterday, one no-show two days ago, one booked tomorrow
  insert into public.concierge_appointments
    (kind, type_id, location_id, starts_at, ends_at, status, visitor_name, visitor_contact, contact_kind, staff_id)
  select 'appointment', t.id, l.id, x.s, x.s + interval '45 minutes', x.st, x.nm, 'p@x.io', 'email', mid
    from public.concierge_appointment_types t, public.concierge_locations l,
      (values (now() - interval '1 day',  'completed'::text, 'Kept Guest'),
              (now() - interval '2 days', 'no_show'::text,   'Ghost Guest'),
              (now() + interval '1 day',  'booked'::text,    'Future Guest')) x(s, st, nm)
    where t.slug = 'viewing' and l.slug = 'main';
  -- one day off inside the window
  insert into public.concierge_availability_exceptions (on_date, closed, staff_id)
    values (current_date - 3, true, mid);
  r := public.staff_report(7);
  if (r->>'ok')::bool is not true then raise exception 'T12: %', r; end if;
  select x into m from jsonb_array_elements(r->'people') x where x->>'name' = 'Maya';
  select x into j from jsonb_array_elements(r->'people') x where x->>'name' = 'Jo';
  if (m->>'booked_min')::int <> 90 then raise exception 'T12: booked_min % (want 90)', m->>'booked_min'; end if;
  if (m->>'done')::int <> 1 or (m->>'no_show')::int <> 1 or (m->>'upcoming')::int <> 1 then
    raise exception 'T12: outcome counts wrong: %', m; end if;
  if (m->>'show_rate')::int <> 50 then raise exception 'T12: show_rate % (want 50)', m->>'show_rate'; end if;
  if (m->>'days_off')::int <> 1 then raise exception 'T12: days_off % (want 1)', m->>'days_off'; end if;
  if (m->>'sched_min')::int <= 0 then raise exception 'T12: sched_min must be positive: %', m; end if;
  util := round(90 * 100.0 / (m->>'sched_min')::int);
  if (m->>'utilization')::int <> util then
    raise exception 'T12: utilization % inconsistent with sched (want %)', m->>'utilization', util; end if;
  if j->'show_rate' <> 'null'::jsonb or (j->>'booked_min')::int <> 0 then
    raise exception 'T12: an idle person must report 0 minutes and NULL rates: %', j; end if;
  raise notice 'T12 ok — sched %m, 90m booked (util %%%), 50%% kept, honest NULLs',
    m->>'sched_min', m->>'utilization';
end $$;

-- T13: retention — dated exceptions older than 400 days are pruned
do $$
declare r jsonb;
begin
  insert into public.concierge_availability_exceptions (on_date, closed, note)
    values (current_date - 500, true, 'ancient closure');
  insert into public.concierge_availability_exceptions (on_date, closed, staff_id, note)
    select current_date - 401, true, id, 'ancient day off' from public.concierge_staff where name = 'Maya';
  r := public.prune_high_write(180);
  if exists (select 1 from public.concierge_availability_exceptions where on_date < current_date - 400) then
    raise exception 'T13: ancient exceptions survived the prune'; end if;
  if not exists (select 1 from public.concierge_availability_exceptions where on_date = current_date - 3) then
    raise exception 'T13: a recent (reportable) day off was wrongly pruned'; end if;
  raise notice 'T13 ok — the ledger forgets what no longer matters, keeps what reports need';
end $$;

select 'ALL STAFF TESTS PASSED (incl. breaks + report + retention)' as verdict;
