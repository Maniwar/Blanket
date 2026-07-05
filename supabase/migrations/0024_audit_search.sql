-- ============================================================================
-- 0024_audit_search.sql — Feierabend (Decke 01)
-- Indexes that make the admin audit surfaces searchable at scale: filter orders,
-- conversations, and register actions by date range, email, and keyword without
-- full-table scans. Keyword/ILIKE search needs trigram (pg_trgm) GIN indexes.
-- Mirrored in setup.sql.
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

-- ── Orders: date ordering, status filter, keyword on email/name ──────────────
create index if not exists orders_placed_at_idx on public.orders (placed_at desc);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_email_trgm_idx
  on public.orders using gin (email extensions.gin_trgm_ops);
create index if not exists orders_name_trgm_idx
  on public.orders using gin (name extensions.gin_trgm_ops);

-- ── Register actions: filter by email + date, keyword on action/result ───────
create index if not exists concierge_actions_email_idx
  on public.concierge_actions (email, created_at desc);
create index if not exists concierge_actions_result_trgm_idx
  on public.concierge_actions using gin (result extensions.gin_trgm_ops);

-- ── Conversations: filter by patron email ────────────────────────────────────
create index if not exists concierge_conversations_email_idx
  on public.concierge_conversations (user_email, created_at desc);

-- ── Messages: keyword search over transcript content + date ──────────────────
create index if not exists concierge_messages_content_trgm_idx
  on public.concierge_messages using gin (content extensions.gin_trgm_ops);
create index if not exists concierge_messages_created_at_idx
  on public.concierge_messages (created_at desc);
