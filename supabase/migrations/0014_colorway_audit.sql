-- ============================================================================
-- 0014_colorway_audit.sql — Feierabend (Decke 01) colorway changes + DB audit
-- 1. order_events: a trigger-written audit of EVERY orders-row change —
--    field-level old/new diffs on update, the full row on creation. Written
--    by the database itself, so no code path (bot tool, form, admin edit,
--    future integrations) can modify an order without leaving a trace.
--    concierge_actions still records WHO asked; order_events records WHAT
--    changed. Together: full auditability.
-- 2. The concierge learns update_colorway (placed orders only — once weaving
--    starts the cloth is on the loom), with its SOP.
-- ============================================================================

-- ── 1. order_events + trigger ────────────────────────────────────────────────

create table public.order_events (
  id         bigint generated always as identity primary key,
  order_id   uuid not null references public.orders(id) on delete cascade,
  event      text not null,   -- 'created' | 'updated'
  changes    jsonb,           -- created: full row; updated: {field:{old,new}}
  created_at timestamptz not null default now()
);

create index order_events_order_idx
  on public.order_events (order_id, created_at desc);

alter table public.order_events enable row level security;

create policy "admin read" on public.order_events
  for select to authenticated
  using (public.is_concierge_admin());

create or replace function public.log_order_event() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_key     text;
  v_old     jsonb;
  v_new     jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, event, changes)
      values (new.id, 'created', to_jsonb(new) - 'id');
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  for v_key in select jsonb_object_keys(v_new) loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
    end if;
  end loop;
  if v_changes <> '{}'::jsonb then
    insert into public.order_events (order_id, event, changes)
      values (new.id, 'updated', v_changes);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_audit on public.orders;
create trigger orders_audit
  after insert or update on public.orders
  for each row execute function public.log_order_event();


-- ── 3. Attribution: which orders the concierge assisted ─────────────────────

alter table public.orders add column if not exists chat_session text;

-- ── 2. The colorway-change SOP ───────────────────────────────────────────────

insert into public.concierge_sops (slug, title, content_md, sort_order) values
('colorway-change', 'Colorway changes', $sop$An owner may change the cloth on an order only while it is still 'placed' (the loom has not started):
1. Call get_my_orders first. List each eligible order the way a person remembers it — cloth, placed date, gift recipient — and offer one pill per order: {{reply:Change the cloth on the Graphit — Nº 14,228}}.
2. Once they pick, offer one pill per other cloth: {{reply:Make it Loden}} and {{reply:Make it Ungefärbt}}.
3. Confirm with exactly two pills: {{reply:Yes — Nº 14,228 becomes Loden}} and {{reply:Keep it as it is}}.
4. Only after the explicit Yes, call update_colorway. Read the recorded cloth back from the tool result.
5. Once weaving has begun the cloth is on the loom — no change is possible; the 30-night trial covers a color that turns out wrong in the room it lives in.$sop$, 5)
on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title, updated_at = now();
