-- ============================================================================
-- APPLY_NOW_3.sql — paste this whole file into the Supabase SQL Editor and Run.
-- The page shows "Nº X is held for this visit" — this makes that literally
-- true. A hold reserves a serial for a visit (10-minute TTL, refreshed while
-- the visitor stays). The commission consumes the visit's hold, so the number
-- shown is the number entered in the Webbuch. Lapsed holds recycle: the same
-- visitor gets their number back if nobody claimed it; otherwise the lowest
-- lapsed number goes to the next visitor. The counter never passes 15,000.
--
-- Concurrency notes:
--   * All row grabs use FOR UPDATE SKIP LOCKED — two visitors can never take
--     the same lapsed hold, and nobody blocks.
--   * Serial uniqueness is structural: every serial leaves the counter exactly
--     once; holds recycle without duplication; a consumed hold is deleted.
--     orders.serial UNIQUE remains the final backstop.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. HOLDS
-- ----------------------------------------------------------------------------

create table public.serial_holds (
  serial      int primary key,
  session_key text not null,
  expires_at  timestamptz not null
);

create index serial_holds_session_idx on public.serial_holds (session_key);
create index serial_holds_expires_idx on public.serial_holds (expires_at);

-- RLS on, no policies: only the service role (edge functions) touches holds.
alter table public.serial_holds enable row level security;

-- ----------------------------------------------------------------------------
-- 2. HOLD RPC — reserve (or re-confirm) a number for a visit
--    Returns no row when the run is fully spoken for at this moment.
-- ----------------------------------------------------------------------------

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
  -- 1) A hold this visit already owns — active first, else its own lapsed
  --    one (nobody took it over, so the visitor keeps the very same number).
  update public.serial_holds h
     set expires_at = v_exp
   where h.serial = (
     select h2.serial from public.serial_holds h2
      where h2.session_key = p_session
      order by (h2.expires_at > now()) desc, h2.serial
      limit 1
      for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then
    return query select v_serial, v_exp;
    return;
  end if;

  -- 2) Take over the lowest lapsed hold before advancing the counter,
  --    so walked-away numbers return to the edition instead of gapping it.
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
-- 3. COMMISSION RPC — now consumes the visit's hold
--    Same preference order as hold_serial, so the number shown is the number
--    recorded. Returns -1 when the run is fully spoken for.
--    (Drop first: adding a defaulted parameter would create an ambiguous
--    overload next to the 9-parameter version.)
-- ----------------------------------------------------------------------------

drop function if exists public.commission_order(
  text, text, text, text, text, text, text, text, uuid);

create function public.commission_order(
  p_email    text,
  p_name     text,
  p_address  text,
  p_address2 text,
  p_city     text,
  p_state    text,
  p_zip      text,
  p_colorway text,
  p_user_id  uuid,
  p_session  text default null
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial int;
begin
  -- 1) Consume this visit's hold — active first, else its own lapsed one
  --    that nobody took over. The shown number becomes the recorded number.
  if p_session is not null and length(p_session) > 0 then
    delete from public.serial_holds h
     where h.serial = (
       select h2.serial from public.serial_holds h2
        where h2.session_key = p_session
        order by (h2.expires_at > now()) desc, h2.serial
        limit 1
        for update skip locked)
    returning h.serial into v_serial;
  end if;

  -- 2) No hold: consume the lowest lapsed hold, recycling walked-away numbers.
  if v_serial is null then
    delete from public.serial_holds h
     where h.serial = (
       select h2.serial from public.serial_holds h2
        where h2.expires_at <= now()
        order by h2.serial
        limit 1
        for update skip locked)
    returning h.serial into v_serial;
  end if;

  -- 3) Fresh from the counter, capped at the edition of 15,000.
  if v_serial is null then
    select next_serial into v_serial
      from public.allocation_counter where id = 1 for update;
    if v_serial is null or v_serial > 15000 then
      return -1; -- fully spoken for
    end if;
    update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  end if;

  insert into public.orders
      (user_id, email, name, address, address2, city, state, zip, colorway, serial, status)
    values
      (p_user_id, p_email, p_name, p_address, nullif(p_address2, ''), p_city, p_state, p_zip,
       p_colorway, v_serial, 'placed');

  return v_serial;
end;
$$;

revoke execute on function public.commission_order(
  text, text, text, text, text, text, text, text, uuid, text)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Mark this repo migration as applied (so future 'db push' stays clean)
-- ----------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
values ('0006','serial_holds')
on conflict (version) do nothing;
