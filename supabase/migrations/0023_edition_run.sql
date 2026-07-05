-- ============================================================================
-- 0023_edition_run.sql — Feierabend (Decke 01)
-- Make the edition RUN admin-settable instead of hardcoded. The total run size
-- lives on allocation_counter alongside next_serial; the allocation functions
-- read it instead of the literal 15000. Admins set/read it via RPCs (the
-- counter itself stays service-role only).
-- ============================================================================

alter table public.allocation_counter
  add column if not exists run_size int not null default 15000;

-- ── Allocation now respects the configurable run size ────────────────────────

create or replace function public.hold_serial(p_session text)
returns table (o_serial int, o_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_serial int; v_run int; v_exp timestamptz := now() + interval '10 minutes';
begin
  update public.serial_holds h set expires_at = v_exp
   where h.serial = (select h2.serial from public.serial_holds h2
      where h2.session_key = p_session and h2.expires_at > now()
      order by h2.serial limit 1 for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then return query select v_serial, v_exp; return; end if;

  update public.serial_holds h set session_key = p_session, expires_at = v_exp
   where h.serial = (select h2.serial from public.serial_holds h2
      where h2.expires_at <= now() order by h2.serial limit 1 for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then return query select v_serial, v_exp; return; end if;

  select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
  if v_serial is null or v_serial > v_run then return; end if;
  update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  insert into public.serial_holds (serial, session_key, expires_at) values (v_serial, p_session, v_exp);
  return query select v_serial, v_exp;
end; $$;
revoke execute on function public.hold_serial(text) from public, anon, authenticated;

create or replace function public.commission_order(
  p_email text, p_name text, p_address text, p_address2 text, p_city text, p_state text,
  p_zip text, p_colorway text, p_user_id uuid, p_session text default null,
  p_recipient text default null, p_is_gift boolean default false, p_billing jsonb default null
) returns int language plpgsql security definer set search_path = '' as $$
declare v_serial int; v_run int;
begin
  if p_session is not null and length(p_session) > 0 then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.session_key = p_session
      order by (h2.expires_at > now()) desc, h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.expires_at <= now()
      order by h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
    if v_serial is null or v_serial > v_run then return -1; end if;
    update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  end if;
  insert into public.orders (user_id, email, name, address, address2, city, state, zip, colorway,
      serial, status, recipient_name, is_gift, billing)
    values (p_user_id, p_email, p_name, p_address, nullif(p_address2,''), p_city, p_state, p_zip,
      p_colorway, v_serial, 'placed', nullif(p_recipient,''), coalesce(p_is_gift,false), p_billing);
  return v_serial;
end; $$;
revoke execute on function public.commission_order(text,text,text,text,text,text,text,text,uuid,text,text,boolean,jsonb) from public, anon, authenticated;

-- ── Admin-facing: read and set the edition run ───────────────────────────────

create or replace function public.get_edition()
returns table (o_next int, o_run int, o_claimed int, o_remaining int)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_concierge_admin() then raise exception 'not authorized'; end if;
  return query
    select a.next_serial, a.run_size, (a.next_serial - 1), greatest(a.run_size - (a.next_serial - 1), 0)
    from public.allocation_counter a where a.id = 1;
end; $$;
grant execute on function public.get_edition() to authenticated;
revoke execute on function public.get_edition() from public, anon;

create or replace function public.set_edition(p_next_serial int, p_run_size int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_concierge_admin() then raise exception 'not authorized'; end if;
  if p_run_size is null or p_run_size < 1 then raise exception 'run size must be at least 1'; end if;
  if p_next_serial is null or p_next_serial < 1 then raise exception 'next number must be at least 1'; end if;
  if p_next_serial > p_run_size + 1 then raise exception 'next number cannot exceed run size + 1'; end if;
  update public.allocation_counter set next_serial = p_next_serial, run_size = p_run_size where id = 1;
end; $$;
grant execute on function public.set_edition(int, int) to authenticated;
revoke execute on function public.set_edition(int, int) from public, anon;
