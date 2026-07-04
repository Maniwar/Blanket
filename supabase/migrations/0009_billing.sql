-- ============================================================================
-- 0009_billing.sql — Feierabend (Decke 01) separate billing address
-- The recorded address is the SHIPPING address (for gifts: the recipient's
-- door). A billing address is stored only when the buyer says theirs differs
-- — data minimization holds: no payment is taken, so it is never demanded.
-- Stored as one nullable jsonb block {address,address2,city,state,zip};
-- null means "same as shipping".
-- ============================================================================

alter table public.orders
  add column billing jsonb;

drop function if exists public.commission_order(
  text, text, text, text, text, text, text, text, uuid, text, text, boolean);

create function public.commission_order(
  p_email     text,
  p_name      text,
  p_address   text,
  p_address2  text,
  p_city      text,
  p_state     text,
  p_zip       text,
  p_colorway  text,
  p_user_id   uuid,
  p_session   text default null,
  p_recipient text default null,
  p_is_gift   boolean default false,
  p_billing   jsonb default null
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
      (user_id, email, name, address, address2, city, state, zip, colorway,
       serial, status, recipient_name, is_gift, billing)
    values
      (p_user_id, p_email, p_name, p_address, nullif(p_address2, ''), p_city, p_state, p_zip,
       p_colorway, v_serial, 'placed', nullif(p_recipient, ''), coalesce(p_is_gift, false),
       p_billing);

  return v_serial;
end;
$$;

revoke execute on function public.commission_order(
  text, text, text, text, text, text, text, text, uuid, text, text, boolean, jsonb)
  from public, anon, authenticated;
