-- ============================================================================
-- 0008_flags.sql — Feierabend (Decke 01) concierge knowledge-gap flags
-- Whenever the concierge answers "I don't know / I don't have that detail",
-- the edge function files the exchange here so the admin can review it in the
-- Studio's Knowledge tab and write the missing section. Resolve to dismiss.
-- ============================================================================

create table public.concierge_flags (
  id              bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  question        text not null,
  answer          text not null,
  reason          text not null default 'knowledge_gap',
  resolved        boolean not null default false,
  created_at      timestamptz not null default now()
);

create index concierge_flags_open_idx
  on public.concierge_flags (resolved, created_at desc);

alter table public.concierge_flags enable row level security;

create policy "admin all" on public.concierge_flags
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());
