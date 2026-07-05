-- ============================================================================
-- 0027_waitlist.sql — Feierabend (Decke 01)
-- A real waitlist: captured when the edition is sold out (front-end form) or by
-- the concierge in chat, and managed by the admin. Previously the sold-out
-- message only *mentioned* a waitlist — nothing recorded it. Mirrored in
-- setup.sql.
-- ============================================================================

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  name        text,
  colorway    text,          -- optional preferred cloth
  note        text,          -- optional: what they're after / a message
  source      text,          -- 'sold_out' | 'concierge' | 'form'
  user_id     uuid,          -- set when captured from a signed-in patron
  created_at  timestamptz not null default now(),
  notified_at timestamptz    -- admin stamps this once they've reached out
);

create extension if not exists pg_trgm with schema extensions;

create index if not exists waitlist_created_idx on public.waitlist (created_at desc);
create index if not exists waitlist_email_idx on public.waitlist (email);
-- keyword search (email/name/note ILIKE) — trigram GIN so the admin filter scales
create index if not exists waitlist_email_trgm_idx on public.waitlist using gin (email extensions.gin_trgm_ops);
create index if not exists waitlist_name_trgm_idx  on public.waitlist using gin (name  extensions.gin_trgm_ops);
create index if not exists waitlist_note_trgm_idx  on public.waitlist using gin (note  extensions.gin_trgm_ops);

alter table public.waitlist enable row level security;
-- Admins read + manage; the edge functions insert with the service role (which
-- bypasses RLS), so there is no public/anon write policy.
drop policy if exists "admin all waitlist" on public.waitlist;
create policy "admin all waitlist" on public.waitlist
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());
