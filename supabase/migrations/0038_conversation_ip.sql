-- 0038_conversation_ip.sql — log the client IP on a conversation for abuse/legal
-- forensics. Admin-only (RLS already restricts concierge_conversations to admins),
-- and surfaced only in the PII-gated transcript export. Holds the latest IP seen
-- for the session.
alter table public.concierge_conversations
  add column if not exists ip text;
