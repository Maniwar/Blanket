-- ============================================================================
-- APPLY_NOW_5.sql — idempotent catch-up. Run this ONCE in the SQL Editor.
-- Safe regardless of which earlier paste you ran (APPLY_NOW_4 in any of its
-- versions, or none of them): every statement only creates what is missing.
-- Covers migrations 0007 (gifts), 0008 (knowledge-gap flags), 0009 (billing).
-- Requires APPLY_NOW_3 (serial holds) to have been run first.
-- ============================================================================

-- ── 0007: gift commissions ───────────────────────────────────────────────────

alter table public.orders add column if not exists recipient_name text;
alter table public.orders add column if not exists is_gift boolean not null default false;

-- ── 0009: separate billing address (stored only when it differs) ─────────────

alter table public.orders add column if not exists billing jsonb;

-- ── 0008: knowledge-gap flags ────────────────────────────────────────────────

create table if not exists public.concierge_flags (
  id              bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  question        text not null,
  answer          text not null,
  reason          text not null default 'knowledge_gap',
  resolved        boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists concierge_flags_open_idx
  on public.concierge_flags (resolved, created_at desc);

alter table public.concierge_flags enable row level security;

drop policy if exists "admin all" on public.concierge_flags;
create policy "admin all" on public.concierge_flags
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- ── commission_order: retire every older signature, create the current one ──

drop function if exists public.commission_order(
  text, text, text, text, text, text, text, text, uuid);
drop function if exists public.commission_order(
  text, text, text, text, text, text, text, text, uuid, text);
drop function if exists public.commission_order(
  text, text, text, text, text, text, text, text, uuid, text, text, boolean);
drop function if exists public.commission_order(
  text, text, text, text, text, text, text, text, uuid, text, text, boolean, jsonb);

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

-- ── bookkeeping: mark all covered migrations as applied ──────────────────────

insert into supabase_migrations.schema_migrations (version, name)
values ('0007','gifts'), ('0008','flags'), ('0009','billing')
on conflict (version) do nothing;
