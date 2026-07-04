-- ============================================================================
-- APPLY_NOW_16.sql — paste into the SQL Editor and Run. Conversation goals + scoring.
-- Admin-defined goals for every concierge conversation, and a per-conversation
-- evaluation of how well each was met. The goals are injected into the system
-- prompt (the bot pursues them) and scored by a lightweight judge after turns,
-- writing met/partial/unmet to concierge_conversations.goal_status so the admin
-- can see, per conversation, which goals were fully or partially met.
-- ============================================================================

-- ── 1. Goal definitions (admin-editable in the Studio) ───────────────────────

create table public.concierge_goals (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  label       text not null,
  description text not null,
  enabled     boolean not null default true,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);

alter table public.concierge_goals enable row level security;

create policy "admin all" on public.concierge_goals
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

insert into public.concierge_goals (slug, label, description, sort_order) values
('discover',      'Understand the customer',    'Learn who the blanket is for and where it will live before presenting.', 1),
('match-cloth',   'Match the right cloth',       'Guide them to the colorway that suits their need or room.', 2),
('handle-doubt',  'Address hesitations',         'Meet any hesitation — price, care, fit, gift timing — honestly and fully.', 3),
('advance',       'Advance toward a commission', 'Move the conversation toward an entry in the Webbuch when genuine interest allows.', 4),
('needs-met',     'Leave no need unmet',         'Confirm every question the customer raised was resolved before the conversation ends.', 5),
('remember',      'Record for next time',        'For a signed-in patron, note what was learned in the client book.', 6);

-- ── 2. Per-conversation evaluation ───────────────────────────────────────────
-- goal_status: { "<slug>": { "status": "met|partial|unmet", "note": "..." } }

alter table public.concierge_conversations
  add column if not exists goal_status jsonb,
  add column if not exists goal_status_at timestamptz;

insert into supabase_migrations.schema_migrations (version, name)
values ('0020','goals')
on conflict (version) do nothing;
