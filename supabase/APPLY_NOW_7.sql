-- ============================================================================
-- APPLY_NOW_7.sql — paste into the Supabase SQL Editor and Run (after APPLY_NOW_6).
-- Continuity only while it is real: a visit KEEPS its own hold while that
-- hold is still active (the number on screen never changes under the
-- visitor). But once the visit's hold has lapsed, there is nothing to keep
-- steady — the returning visitor now receives the LOWEST free number
-- (including numbers released by cancellations), not their old higher one.
-- Previously a visitor's own lapsed hold outranked the pool, so a solo
-- visitor could never pick up a number they had just released.
-- ============================================================================

create or replace function public.hold_serial(p_session text)
returns table (o_serial int, o_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial int;
  v_exp    timestamptz := now() + interval '10 minutes';
begin
  -- 1) A hold this visit already owns AND which is still active: keep it —
  --    the number the visitor is looking at never changes beneath them.
  update public.serial_holds h
     set expires_at = v_exp
   where h.serial = (
     select h2.serial from public.serial_holds h2
      where h2.session_key = p_session and h2.expires_at > now()
      order by h2.serial
      limit 1
      for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then
    return query select v_serial, v_exp;
    return;
  end if;

  -- 2) Fresh start: the lowest lapsed hold from anyone — including numbers
  --    released by cancellations and the visitor's own lapsed hold.
  update public.serial_holds h
     set session_key = p_session, expires_at = v_exp
   where h.serial = (
     select h2.serial from public.serial_holds h2
      where h2.expires_at <= now()
      order by h2.serial
      limit 1
      for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then
    return query select v_serial, v_exp;
    return;
  end if;

  -- 3) A fresh number from the counter — never past the 15,000 edition.
  select next_serial into v_serial
    from public.allocation_counter where id = 1 for update;
  if v_serial is null or v_serial > 15000 then
    return; -- fully spoken for right now; a hold may lapse within minutes
  end if;
  update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  insert into public.serial_holds (serial, session_key, expires_at)
    values (v_serial, p_session, v_exp);
  return query select v_serial, v_exp;
end;
$$;

revoke execute on function public.hold_serial(text)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Mark this repo migration as applied (so future 'db push' stays clean)
-- ----------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
values ('0011','hold_lowest_first')
on conflict (version) do nothing;
