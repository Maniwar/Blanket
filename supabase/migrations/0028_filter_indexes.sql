-- ============================================================================
-- 0028_filter_indexes.sql — Feierabend (Decke 01)
-- Complete the trigram coverage for the admin keyword filters. The filters run
-- ILIKE '%term%' (substring) across these columns; only a pg_trgm GIN index
-- avoids a full scan at scale. 0024 covered most; these were the gaps:
--   orders.recipient_name, concierge_actions.email/action,
--   concierge_conversations.user_email.
-- Mirrored in setup.sql.
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

create index if not exists orders_recipient_trgm_idx
  on public.orders using gin (recipient_name extensions.gin_trgm_ops);

create index if not exists concierge_actions_email_trgm_idx
  on public.concierge_actions using gin (email extensions.gin_trgm_ops);
create index if not exists concierge_actions_action_trgm_idx
  on public.concierge_actions using gin (action extensions.gin_trgm_ops);

create index if not exists concierge_conversations_email_trgm_idx
  on public.concierge_conversations using gin (user_email extensions.gin_trgm_ops);
