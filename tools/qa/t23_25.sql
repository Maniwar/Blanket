-- T23–T25: time-off lifecycle. Fixture matches staff_tests.sql conventions.
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
insert into public.concierge_staff (name) values ('Maya');
insert into public.concierge_staff_hours (staff_id, location_id, dow, open_min, close_min)
  select s.id, l.id, d, 540, 1020 from public.concierge_staff s, public.concierge_locations l,
    generate_series(0,6) d where s.name = 'Maya' and l.slug = 'main';
insert into public.concierge_staff_services (staff_id, type_id)
  select s.id, t.id from public.concierge_staff s, public.concierge_appointment_types t
  where t.slug = 'viewing';
commit;

create or replace function pg_temp.nextdow(d int) returns date language sql as
$$ select (current_date + 3) + ((7 + d - extract(dow from current_date + 3)::int) % 7) $$;

-- T23: a REQUEST blocks nothing; approving it empties the day; denying restores it
do $$
declare v jsonb; n0 int; n1 int; n2 int; n3 int; n4 int; xid bigint;
begin
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(3), pg_temp.nextdow(3), null);
  n0 := jsonb_array_length(v->'slots');
  if n0 = 0 then raise exception 'T23: fixture broken — no baseline slots'; end if;

  insert into public.concierge_availability_exceptions (on_date, closed, staff_id, note, status)
    select pg_temp.nextdow(3), true, id, 'ski trip', 'requested' from public.concierge_staff
    returning id into xid;
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(3), pg_temp.nextdow(3), null);
  n1 := jsonb_array_length(v->'slots');
  if n1 <> n0 then raise exception 'T23: a mere request blocked slots (% -> %)', n0, n1; end if;

  update public.concierge_availability_exceptions set status = 'approved' where id = xid;
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(3), pg_temp.nextdow(3), null);
  n2 := jsonb_array_length(v->'slots');
  if n2 <> 0 then raise exception 'T23: approved day off still offers % slots', n2; end if;

  update public.concierge_availability_exceptions set status = 'denied' where id = xid;
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(3), pg_temp.nextdow(3), null);
  n3 := jsonb_array_length(v->'slots');
  if n3 <> n0 then raise exception 'T23: denied request still blocks (% vs %)', n3, n0; end if;

  update public.concierge_availability_exceptions set status = 'returned' where id = xid;
  v := public.appointment_slots('viewing','main', pg_temp.nextdow(3), pg_temp.nextdow(3), null);
  n4 := jsonb_array_length(v->'slots');
  if n4 <> n0 then raise exception 'T23: returned time still blocks (% vs %)', n4, n0; end if;
  raise notice 'T23 ok — request/denied/returned block nothing; approved blocks everything';
end $$;

-- T24: staff_report counts only approved time off (sched_min + days_off)
do $$
declare r0 jsonb; r1 jsonb; r2 jsonb; s0 int; s1 int; s2 int; xid bigint;
begin
  delete from public.concierge_availability_exceptions;
  r0 := public.staff_report(7);
  select (x->>'sched_min')::int into s0 from jsonb_array_elements(r0->'people') x
    where x->>'name' = 'Maya';

  insert into public.concierge_availability_exceptions (on_date, closed, staff_id, note, status)
    select current_date, true, id, 'dentist', 'requested' from public.concierge_staff
    returning id into xid;
  r1 := public.staff_report(7);
  select (x->>'sched_min')::int into s1 from jsonb_array_elements(r1->'people') x
    where x->>'name' = 'Maya';
  if s1 <> s0 then raise exception 'T24: requested time off changed sched (% -> %)', s0, s1; end if;
  if (select (x->>'days_off')::int from jsonb_array_elements(r1->'people') x
        where x->>'name' = 'Maya') <> 0 then
    raise exception 'T24: requested day counted as a day off'; end if;

  update public.concierge_availability_exceptions set status = 'approved' where id = xid;
  r2 := public.staff_report(7);
  select (x->>'sched_min')::int into s2 from jsonb_array_elements(r2->'people') x
    where x->>'name' = 'Maya';
  if s2 >= s1 then raise exception 'T24: approved day off did not reduce sched (% -> %)', s1, s2; end if;
  if (select (x->>'days_off')::int from jsonb_array_elements(r2->'people') x
        where x->>'name' = 'Maya') <> 1 then
    raise exception 'T24: approved day off not counted'; end if;
  raise notice 'T24 ok — adherence math reads approved only (% -> % sched_min)', s1, s2;
end $$;

-- T25: the constraint refuses a status the product does not speak
do $$
begin
  begin
    insert into public.concierge_availability_exceptions (on_date, closed, staff_id, note, status)
      select current_date, true, id, '', 'maybe' from public.concierge_staff;
    raise exception 'T25: bogus status accepted';
  exception when check_violation then
    raise notice 'T25 ok — unknown status refused by constraint';
  end;
end $$;
