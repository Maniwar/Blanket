-- 0041_customer_addresses.sql — a managed, editable address book.
-- Real ship-to / billing addresses a patron (or an admin on their behalf) can add,
-- rename, and remove — distinct from the read-only view derived from order history.
-- Auto-populated from an order's ship-to + billing on placement, and backfilled
-- from history the first time a signed-in patron opens the checkout.
create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, email text,
  label text,
  is_gift boolean not null default false,
  recipient_name text,
  address text not null, address2 text, city text not null, state text not null, zip text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create index if not exists customer_addresses_email_idx on public.customer_addresses (email, created_at desc);
create index if not exists customer_addresses_user_idx on public.customer_addresses (user_id, created_at desc);

alter table public.customer_addresses enable row level security;
drop policy if exists "admin all" on public.customer_addresses;
create policy "admin all" on public.customer_addresses for all to authenticated
  using (public.is_concierge_admin()) with check (public.is_concierge_admin());
-- Patron access to their own rows is brokered by the commission Edge Function
-- (service role + verified-JWT ownership checks); no anon/self policy is granted.
