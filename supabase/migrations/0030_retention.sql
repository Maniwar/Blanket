-- ============================================================================
-- 0030_retention.sql — Feierabend (Decke 01)
-- Bound the growth of the high-write tables (SCALING.md #2). Deleting old
-- conversations cascades to their messages and message-feedback; actions,
-- email_log, and stale rate-limit rows are pruned by their own timestamps.
-- order_events is left (bounded by the edition's order count).
--
-- Run on a schedule (pg_cron example at the bottom, or call it from a cron job /
-- scheduled edge function). Mirrored in setup.sql.
-- ============================================================================

create or replace function public.prune_high_write(p_days int default 180)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cutoff   timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 180), 1));
  c_convos bigint; c_actions bigint; c_email bigint; c_rate bigint;
begin
  -- conversations cascade to concierge_messages (and concierge_feedback)
  delete from public.concierge_conversations where created_at < cutoff;
  get diagnostics c_convos = row_count;
  delete from public.concierge_actions where created_at < cutoff;
  get diagnostics c_actions = row_count;
  delete from public.email_log where created_at < cutoff;
  get diagnostics c_email = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 hours';
  get diagnostics c_rate = row_count;
  return jsonb_build_object(
    'cutoff', cutoff,
    'conversations_deleted', c_convos,
    'actions_deleted', c_actions,
    'email_log_deleted', c_email,
    'rate_limits_deleted', c_rate
  );
end $$;

revoke execute on function public.prune_high_write(int) from public, anon, authenticated;

-- To run it nightly with pg_cron (enable the extension first in the Supabase
-- dashboard → Database → Extensions), uncomment:
--   select cron.schedule('prune-high-write', '0 3 * * *',
--     $$select public.prune_high_write(180)$$);
