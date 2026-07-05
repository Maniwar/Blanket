-- ============================================================================
-- 0029_email_log.sql — Feierabend (Decke 01)
-- Record every transactional email the system sends (order confirmation,
-- shipment, return, cancellation) so the admin can see what went to a customer
-- and re-send it if needed. Previously sendEmail() fired and discarded the
-- result — nothing was recorded. Mirrored in setup.sql.
-- ============================================================================

create table if not exists public.email_log (
  id          uuid primary key default gen_random_uuid(),
  to_email    text not null,
  kind        text not null,     -- placed | shipped | returned | cancelled
  serial      int,               -- the order's Nº, when applicable
  subject     text,
  ok          boolean not null default false,
  provider_id text,              -- Resend message id, when the send succeeded
  error       text,              -- short reason when it failed
  created_at  timestamptz not null default now()
);

create index if not exists email_log_serial_idx on public.email_log (serial, created_at desc);
create index if not exists email_log_created_idx on public.email_log (created_at desc);

alter table public.email_log enable row level security;
-- Admins read; the edge functions insert with the service role (bypasses RLS).
drop policy if exists "admin read email_log" on public.email_log;
create policy "admin read email_log" on public.email_log
  for select to authenticated
  using (public.is_concierge_admin());
