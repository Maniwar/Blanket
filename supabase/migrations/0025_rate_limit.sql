-- ============================================================================
-- 0025_rate_limit.sql — Feierabend (Decke 01)
-- Shared, DB-backed rate limiting. The edge functions previously counted
-- requests in an in-memory Map, which is per-instance and resets on cold start —
-- no real limit once traffic spreads across many instances. This moves the
-- counter into Postgres so every instance shares one window. Mirrored in
-- setup.sql. Fixed-window counter, atomic via upsert.
-- ============================================================================

create table if not exists public.rate_limits (
  bucket        text not null,          -- e.g. an IP, or "f:<ip>" / "h:<ip>"
  window_start  timestamptz not null,   -- start of the fixed window
  count         int not null default 0,
  primary key (bucket, window_start)
);

alter table public.rate_limits enable row level security;
-- No policies: service-role only (the edge functions), like the other internals.

-- Count one hit for p_key in the current fixed window and report whether the
-- caller is now OVER p_limit. Atomic (single upsert). Opportunistically drops
-- this key's spent windows so the table stays ~one row per active key.
create or replace function public.rate_hit(p_key text, p_limit int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_secs  int := greatest(coalesce(p_window_seconds, 600), 1);
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
  v_count int;
begin
  insert into public.rate_limits (bucket, window_start, count)
    values (p_key, v_start, 1)
    on conflict (bucket, window_start)
      do update set count = public.rate_limits.count + 1
    returning count into v_count;
  delete from public.rate_limits where bucket = p_key and window_start < v_start;
  return v_count > coalesce(p_limit, 20);
end; $$;

revoke execute on function public.rate_hit(text, int, int) from public, anon, authenticated;
