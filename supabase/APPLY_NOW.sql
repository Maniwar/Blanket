-- ============================================================================
-- APPLY_NOW.sql — everything pending for the live database, in one paste.
-- Supabase dashboard → SQL Editor → paste → Run. Safe to run exactly once.
-- (Combines migrations 0002_fix_rls_admin and 0004_commission.)
-- ============================================================================

-- ---- 1. Fix the admin check (RLS recursion) --------------------------------

drop policy if exists "admin all" on public.concierge_admins;

create or replace function public.is_concierge_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists(
    select 1 from public.concierge_admins a
    where a.email = coalesce(auth.jwt()->>'email','')
  );
$$;

drop policy if exists "read own admin row" on public.concierge_admins;
create policy "read own admin row" on public.concierge_admins
  for select to authenticated
  using (email = coalesce(auth.jwt()->>'email',''));

-- ---- 2. Commission checkout: order fields, counter, RPC --------------------

alter table public.orders
  add column name     text,
  add column address  text,
  add column address2 text,
  add column state    text,
  add column zip      text,
  add column colorway text check (colorway in ('ungefaerbt', 'loden', 'graphit'));

create table public.allocation_counter (
  id          int primary key default 1 check (id = 1),
  next_serial int not null
);

alter table public.allocation_counter enable row level security;

insert into public.allocation_counter (id, next_serial) values (1, 14215);

create function public.commission_order(
  p_email    text,
  p_name     text,
  p_address  text,
  p_address2 text,
  p_city     text,
  p_state    text,
  p_zip      text,
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
  select next_serial into v_serial
    from public.allocation_counter
    where id = 1
    for update;

  update public.allocation_counter
    set next_serial = v_serial + 1
    where id = 1;

  insert into public.orders
      (user_id, email, name, address, address2, city, state, zip, colorway, serial, status)
    values
      (p_user_id, p_email, p_name, p_address, nullif(p_address2, ''), p_city, p_state, p_zip,
       p_colorway, v_serial, 'placed');

  return v_serial;
end;
$$;

revoke execute on function public.commission_order(text, text, text, text, text, text, text, text, uuid)
  from public, anon, authenticated;

-- ---- 3. Mark repo migrations as applied (so future 'db push' is clean) -----

insert into supabase_migrations.schema_migrations (version, name)
values ('0001','concierge'), ('0002','fix_rls_admin'), ('0003','hardening'), ('0004','commission')
on conflict (version) do nothing;
