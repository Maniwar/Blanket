-- ============================================================================
-- 0021_conversation_lifecycle.sql — Feierabend (Decke 01)
-- Records when a concierge conversation is wound down, so the next visit reads
-- as a re-engagement rather than one endless thread. Set by the function's
-- POST ?wrapup=1 endpoint on either signal (the visitor's own — a quiet-mode
-- request or an explicit "that's all for now" — or the bot's automatic
-- wind-down when the panel is dismissed / the tab is left after a real
-- exchange). customerBlock() reads the most recent ended conversation to
-- greet a returning signed-in patron as continuity.
--   status:   'active' (default) | 'snoozed' (quiet mode) | 'closed'
--   ended_at: when it was wrapped; presence of this = the thread is done.
-- ============================================================================

alter table public.concierge_conversations
  add column if not exists status text not null default 'active',
  add column if not exists ended_at timestamptz;

create index if not exists concierge_conversations_ended_idx
  on public.concierge_conversations (user_id, ended_at desc)
  where ended_at is not null;
