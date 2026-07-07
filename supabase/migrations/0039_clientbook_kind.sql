-- 0039_clientbook_kind.sql — typed client book. Notes the concierge uses to talk
-- to the patron, like a support agent's CRM notes:
--   'fact'       — a durable preference or detail (deduped)
--   'event'      — something the concierge DID (deterministic, guaranteed)
--   'reflection' — how to serve this patron better next time
alter table public.customer_notes
  add column if not exists kind text not null default 'fact';
