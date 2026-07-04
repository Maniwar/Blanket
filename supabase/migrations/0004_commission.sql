-- ============================================================================
-- 0004_commission.sql — Feierabend (Decke 01) demo checkout
-- Demo checkout — data minimization by design: a "commission" collects only
-- email, name, city/state, and colorway. No street address, no payment data —
-- nothing is charged; the site is a demonstration.
-- Adds: order columns (name/state/colorway), a serialized allocation counter,
-- and a SECURITY DEFINER RPC the commission edge function calls with the
-- service role to atomically assign the next serial number.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ORDERS — minimal commission fields
-- ----------------------------------------------------------------------------

alter table public.orders
  add column name     text,
  add column state    text,
  add column colorway text check (colorway in ('ungefaerbt', 'loden', 'graphit'));

-- ----------------------------------------------------------------------------
-- 2. ALLOCATION COUNTER — single row holding the next serial to assign
-- ----------------------------------------------------------------------------

create table public.allocation_counter (
  id          int primary key default 1 check (id = 1),
  next_serial int not null
);

-- RLS on, no policies: only the service role (which bypasses RLS) touches it.
alter table public.allocation_counter enable row level security;

-- Seed: the demo order Nº 14,214 exists, so the next commission takes 14,215.
insert into public.allocation_counter (id, next_serial) values (1, 14215);

-- ----------------------------------------------------------------------------
-- 3. RPC — atomically assign the next serial and record the order
-- ----------------------------------------------------------------------------

create function public.commission_order(
  p_email    text,
  p_name     text,
  p_city     text,
  p_state    text,
  p_colorway text,
  p_user_id  uuid
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial int;
begin
  -- Lock the counter row so concurrent commissions serialize cleanly.
  select next_serial into v_serial
    from public.allocation_counter
    where id = 1
    for update;

  update public.allocation_counter
    set next_serial = v_serial + 1
    where id = 1;

  insert into public.orders (user_id, email, name, city, state, colorway, serial, status)
    values (p_user_id, p_email, p_name, p_city, p_state, p_colorway, v_serial, 'placed');

  return v_serial;
end;
$$;

-- Only the service role may call this (the commission edge function does).
revoke execute on function public.commission_order(text, text, text, text, text, uuid)
  from public, anon, authenticated;
