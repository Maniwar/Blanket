-- ============================================================================
-- APPLY_NOW_2.sql — paste this whole file into the Supabase SQL Editor and Run.
-- Adds:
--   1. concierge_sops     — admin-written standard operating procedures the
--                           concierge follows verbatim (injected into the
--                           system prompt on every request)
--   2. concierge_actions  — audit log of every register action the concierge
--                           takes with its tools (reads, address changes,
--                           cancellations), shown in the admin Studio
--   3. concierge_cache    — semantic answer cache (pgvector, gte-small 384-dim
--                           embeddings) + match_cached_answer() RPC
--   4. orders             — 'cancelled' joins the status vocabulary so the
--                           concierge's cancel_order tool has somewhere to go
-- The edge function uses the service role and bypasses RLS; admin policies
-- exist so the Studio (authed browser) can manage SOPs and the cache.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SOPs — the concierge's handbook
-- ----------------------------------------------------------------------------

create table public.concierge_sops (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  content_md  text not null,
  sort_order  int not null default 0,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.concierge_sops enable row level security;

create policy "admin all" on public.concierge_sops
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

insert into public.concierge_sops (slug, title, content_md, sort_order) values

('order-status', 'Order status & tracking', $sop$When a signed-in owner asks about their orders, deliveries, or tracking:
1. Call get_my_orders first — never answer from memory.
2. Report each order separately: number (Nº), colorway, status, and tracking when present.
3. Status words are verbatim from the register: placed, weaving, finishing, shipped, delivered, returned, cancelled. Never invent anything more precise.
4. If an order has no tracking yet, say tracking begins the day it ships and will appear right here.
5. If the shopper is not signed in, explain that the register takes signed entries and offer {{action:signin}}.$sop$, 1),

('address-change', 'Shipping address changes', $sop$An owner may change the shipping address on an order that has not shipped (status placed, weaving, or finishing):
1. Call get_my_orders to confirm the order exists and is still on the loom.
2. Confirm the full new address back to the owner — street, unit if any, city, state, ZIP — and ask them to confirm before acting.
3. Only after the owner confirms, call update_shipping_address with the serial and the complete new address.
4. Read the recorded address back from the tool result so the owner sees exactly what the register now holds.
5. If the order has already shipped or been delivered, the register is closed on it — apologize once and offer hello@feierabend.example for a carrier redirect.$sop$, 2),

('cancellation', 'Cancellations', $sop$An owner may cancel an order only while it is still 'placed' (the loom has not started):
1. Call get_my_orders to check the status.
2. Remind the owner the number returns to the year's edition and cannot be held for them again.
3. Ask for explicit confirmation ("yes, cancel Nº …") before acting.
4. Only then call cancel_order with the serial. Confirm the cancellation from the tool result.
5. Once weaving has begun the cloth carries their number — no cancellation, but the 30-night trial still applies on arrival. Offer that instead.$sop$, 3),

('escalation', 'When to hand off', $sop$Hand off to hello@feierabend.example only when the register cannot do it:
- Carrier redirects after shipment, returns in progress, mending arrangements, anything involving payment.
- Say it lightly — the desk handles those by hand for now.
Everything else about an owner's orders you handle yourself with the tools. Never deflect a status or tracking question to email.$sop$, 4);

-- ----------------------------------------------------------------------------
-- 2. ACTIONS — audit log of tool use
-- ----------------------------------------------------------------------------

create table public.concierge_actions (
  id              bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  user_id         uuid,
  email           text,
  action          text not null,
  serial          int,
  payload         jsonb,
  result          text,
  created_at      timestamptz not null default now()
);

create index concierge_actions_created_at_idx
  on public.concierge_actions (created_at desc);

alter table public.concierge_actions enable row level security;

create policy "admin read" on public.concierge_actions
  for select to authenticated
  using (public.is_concierge_admin());

-- ----------------------------------------------------------------------------
-- 3. SEMANTIC CACHE — pgvector + gte-small (384 dims, inner product ≡ cosine
--    because gte-small embeddings are normalized)
-- ----------------------------------------------------------------------------

create extension if not exists vector with schema extensions;

create table public.concierge_cache (
  id          uuid primary key default gen_random_uuid(),
  question    text not null,
  answer_md   text not null,
  embedding   extensions.vector(384) not null,
  hits        int not null default 0,
  enabled     boolean not null default true,
  model       text,
  created_at  timestamptz not null default now(),
  last_hit_at timestamptz
);

create index concierge_cache_embedding_idx
  on public.concierge_cache
  using hnsw (embedding extensions.vector_ip_ops);

alter table public.concierge_cache enable row level security;

create policy "admin all" on public.concierge_cache
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- Nearest enabled cached answer above the similarity threshold, bumping hits.
create or replace function public.match_cached_answer(
  query_embedding extensions.vector(384),
  match_threshold float default 0.90
) returns table (id uuid, question text, answer_md text, similarity float)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id
    from public.concierge_cache c
    where c.enabled
    order by c.embedding <#> query_embedding
    limit 1;

  if v_id is null then return; end if;

  return query
    update public.concierge_cache c
      set hits = c.hits + 1, last_hit_at = now()
      where c.id = v_id
        and (c.embedding <#> query_embedding) * -1 >= match_threshold
      returning c.id, c.question, c.answer_md,
                (c.embedding <#> query_embedding) * -1;
end;
$$;

-- Only the service role (edge function) may call it.
revoke execute on function public.match_cached_answer(extensions.vector, float)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. ORDERS — 'cancelled' status
-- ----------------------------------------------------------------------------

alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('placed','weaving','finishing','shipped','delivered','returned','cancelled'));

-- ----------------------------------------------------------------------------
-- 5. Mark this repo migration as applied (so future 'db push' stays clean)
-- ----------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
values ('0005','bot_ops')
on conflict (version) do nothing;
