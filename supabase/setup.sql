-- ============================================================================
-- Feierabend (Decke 01) — complete backend setup, in ONE idempotent file.
--
-- Paste this whole file into the Supabase SQL Editor and Run. It is safe to
-- run on a fresh project OR on one that is partially set up, and safe to run
-- more than once: every statement creates only what is missing. It brings the
-- database to the current state the edge functions expect.
--
-- (The supabase/migrations/ folder holds the same schema as an ordered history
--  for `supabase db push`. This file is the single manual-setup convenience.)
-- ============================================================================

create extension if not exists vector with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TABLES
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.concierge_config (
  key text primary key, value jsonb not null,
  updated_at timestamptz not null default now());

create table if not exists public.concierge_kb (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, content_md text not null,
  sort_order int not null default 0, enabled boolean not null default true,
  updated_at timestamptz not null default now());

create table if not exists public.concierge_admins (email text primary key);
-- a protected super admin (the owner) can never be removed or demoted
alter table public.concierge_admins add column if not exists is_super boolean not null default false;

create table if not exists public.concierge_conversations (
  id uuid primary key default gen_random_uuid(),
  session_key text not null,
  user_id uuid references auth.users(id) on delete set null,
  user_email text, section text,
  created_at timestamptz not null default now());
create index if not exists concierge_conversations_session_key_idx on public.concierge_conversations (session_key);
create index if not exists concierge_conversations_created_at_idx on public.concierge_conversations (created_at desc);
-- lifecycle + goals
alter table public.concierge_conversations
  add column if not exists status text not null default 'active',
  add column if not exists ended_at timestamptz,
  add column if not exists goal_status jsonb,
  add column if not exists goal_status_at timestamptz,
  add column if not exists sales_stage text,    -- funnel stage from the async grader (browsing…won/lost)
  add column if not exists ip text;             -- latest client IP (abuse/legal forensics; admin-only, PII-gated in export)
create index if not exists concierge_conversations_ended_idx
  on public.concierge_conversations (user_id, ended_at desc) where ended_at is not null;

create table if not exists public.concierge_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.concierge_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null, model text, latency_ms int,
  created_at timestamptz not null default now());
create index if not exists concierge_messages_conversation_id_idx on public.concierge_messages (conversation_id);

create table if not exists public.concierge_feedback (
  message_id bigint primary key references public.concierge_messages(id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)), note text,
  created_at timestamptz not null default now());

create table if not exists public.customers (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null, name text,
  created_at timestamptz not null default now());

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text not null, serial int unique,
  status text not null,
  tracking text, city text,
  placed_at timestamptz not null default now());
create index if not exists orders_email_idx on public.orders (email);
create index if not exists orders_user_id_idx on public.orders (user_id);
-- order columns added across the project's life
alter table public.orders
  add column if not exists name text,
  add column if not exists address text,
  add column if not exists address2 text,
  add column if not exists state text,
  add column if not exists zip text,
  add column if not exists colorway text,
  add column if not exists recipient_name text,
  add column if not exists is_gift boolean not null default false,
  add column if not exists billing jsonb,
  add column if not exists cancelled_serial int,
  add column if not exists chat_session text;
-- serial may be released when an order is struck
alter table public.orders alter column serial drop not null;
-- status vocabulary (drop + re-add so re-running is clean)
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('placed','weaving','finishing','shipped','delivered','returned','cancelled'));
-- colorway vocabulary
alter table public.orders drop constraint if exists orders_colorway_check;
alter table public.orders add constraint orders_colorway_check
  check (colorway is null or colorway in ('ungefaerbt','loden','graphit'));

create table if not exists public.allocation_counter (
  id int primary key default 1 check (id = 1), next_serial int not null);
-- the edition's total run size, admin-settable (see set_edition below)
alter table public.allocation_counter add column if not exists run_size int not null default 15000;
insert into public.allocation_counter (id, next_serial, run_size) values (1, 14215, 15000)
  on conflict (id) do nothing;

create table if not exists public.serial_holds (
  serial int primary key, session_key text not null, expires_at timestamptz not null);
create index if not exists serial_holds_session_idx on public.serial_holds (session_key);
create index if not exists serial_holds_expires_idx on public.serial_holds (expires_at);

create table if not exists public.concierge_sops (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, content_md text not null,
  sort_order int not null default 0, enabled boolean not null default true,
  updated_at timestamptz not null default now());

create table if not exists public.concierge_actions (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  user_id uuid, email text, action text not null, serial int, payload jsonb, result text,
  created_at timestamptz not null default now());
create index if not exists concierge_actions_created_at_idx on public.concierge_actions (created_at desc);

create table if not exists public.concierge_cache (
  id uuid primary key default gen_random_uuid(),
  question text not null, answer_md text not null,
  embedding extensions.vector(384) not null,
  hits int not null default 0, enabled boolean not null default true, model text,
  created_at timestamptz not null default now(), last_hit_at timestamptz);
create index if not exists concierge_cache_embedding_idx on public.concierge_cache
  using hnsw (embedding extensions.vector_ip_ops);

create table if not exists public.concierge_flags (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.concierge_conversations(id) on delete set null,
  question text not null, answer text not null,
  reason text not null default 'knowledge_gap', resolved boolean not null default false,
  created_at timestamptz not null default now());
create index if not exists concierge_flags_open_idx on public.concierge_flags (resolved, created_at desc);

create table if not exists public.concierge_forms (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, submit_tool text not null,
  fields jsonb not null, enabled boolean not null default true,
  updated_at timestamptz not null default now());

-- Storefront CMS: one row per editable slot on index.html (copy / image / meta).
-- HTML holds the defaults; a slug here overrides it. Read via ?site=1 (service
-- role) and the deploy-time <head> bake; written by admins.
create table if not exists public.site_content (
  slug text primary key,
  kind text not null default 'text',   -- 'text' | 'image' | 'meta'
  value text,
  alt text,
  updated_at timestamptz not null default now());

-- Admin overrides for the concierge's model-callable tools. The built-in tool
-- set lives in the concierge function's code; a row here disables a tool or
-- replaces its model-facing description. No row → the tool runs at its default.
create table if not exists public.concierge_tools (
  name text primary key,                 -- must match a built-in tool name
  enabled boolean not null default true, -- false → withheld from the model
  description text,                       -- non-empty → overrides the model copy
  sort_order int not null default 100,
  updated_at timestamptz not null default now());

create table if not exists public.customer_notes (
  id bigint generated always as identity primary key,
  user_id uuid, email text, note text not null,
  created_at timestamptz not null default now());
-- Typed client book (like a support agent's notes the AI uses to talk to the
-- patron): 'fact' = a durable preference, 'event' = something the concierge did
-- (deterministic, guaranteed), 'reflection' = how to serve better next time.
alter table public.customer_notes add column if not exists kind text not null default 'fact';
create index if not exists customer_notes_email_idx on public.customer_notes (email, created_at desc);
create index if not exists customer_notes_user_idx on public.customer_notes (user_id, created_at desc);

create table if not exists public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  event text not null, changes jsonb, created_at timestamptz not null default now());
create index if not exists order_events_order_idx on public.order_events (order_id, created_at desc);

create table if not exists public.concierge_goals (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, label text not null, description text not null,
  enabled boolean not null default true, sort_order int not null default 0,
  updated_at timestamptz not null default now());
-- journey stage this goal is most relevant to (page section), nullable = anywhere
alter table public.concierge_goals add column if not exists section text;
-- a goal may fit MORE THAN ONE journey stage; sections[] is the source of truth
-- (empty/null = anywhere). section (singular) is kept, backfilled below, for
-- back-compat with any not-yet-deployed reader.
alter table public.concierge_goals add column if not exists sections text[];

-- Behavior-eval scenarios, admin-editable in the studio's Evals tab. A scenario
-- is a scripted conversation plus typed checks on the bot's reply; the runner
-- replays it against the live concierge and reports a pass rate. See evals/.
create table if not exists public.concierge_evals (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text not null default '',
  signed_in boolean not null default false,
  context jsonb not null default '{}'::jsonb,
  turns jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  sort_order int not null default 0,
  updated_at timestamptz not null default now());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ROW LEVEL SECURITY + the admin-check helper
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_concierge_admin() returns boolean
  language sql security definer stable set search_path = '' as
$$ select exists(select 1 from public.concierge_admins a
     where a.email = coalesce(auth.jwt()->>'email','')) $$;

-- The super admin (the owner) — the only one who may remove admins, and the
-- one row no admin can remove or demote.
create or replace function public.is_super_admin() returns boolean
  language sql security definer stable set search_path = '' as
$$ select exists(select 1 from public.concierge_admins a
     where a.email = coalesce(auth.jwt()->>'email','') and a.is_super) $$;

do $$
declare t text;
begin
  foreach t in array array[
    'concierge_config','concierge_kb','concierge_admins','concierge_conversations',
    'concierge_messages','concierge_feedback','customers','orders','allocation_counter',
    'serial_holds','concierge_sops','concierge_actions','concierge_cache','concierge_flags',
    'concierge_forms','customer_notes','order_events','concierge_goals','site_content',
    'concierge_tools','concierge_evals'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- admin-all tables
do $$
declare t text;
begin
  foreach t in array array[
    'concierge_config','concierge_kb','concierge_conversations','concierge_messages',
    'concierge_sops','concierge_cache','concierge_forms','customer_notes',
    'concierge_goals','concierge_flags','site_content','concierge_tools','concierge_evals'
  ] loop
    execute format('drop policy if exists "admin all" on public.%I', t);
    execute format($f$create policy "admin all" on public.%I for all to authenticated
      using (public.is_concierge_admin()) with check (public.is_concierge_admin())$f$, t);
  end loop;
end $$;

-- admin read-only
drop policy if exists "admin read" on public.concierge_actions;
create policy "admin read" on public.concierge_actions for select to authenticated using (public.is_concierge_admin());
drop policy if exists "admin read" on public.order_events;
create policy "admin read" on public.order_events for select to authenticated using (public.is_concierge_admin());

-- concierge_admins roster, from the admin panel:
--   • any admin may LIST the roster and ADD a (non-super) admin;
--   • only the SUPER admin may REMOVE an admin, and the super row itself can
--     never be removed or demoted (guaranteeing one owner always remains).
-- is_concierge_admin()/is_super_admin() are security-definer reads of this
-- table, so there is no RLS recursion; a non-admin still sees zero rows.
drop policy if exists "admin all" on public.concierge_admins;
drop policy if exists "admin manage" on public.concierge_admins;
drop policy if exists "admin select" on public.concierge_admins;
drop policy if exists "admin insert" on public.concierge_admins;
drop policy if exists "admin update" on public.concierge_admins;
drop policy if exists "admin delete" on public.concierge_admins;
create policy "admin select" on public.concierge_admins for select to authenticated
  using (public.is_concierge_admin());
create policy "admin insert" on public.concierge_admins for insert to authenticated
  with check (public.is_concierge_admin() and coalesce(is_super, false) = false);
create policy "admin update" on public.concierge_admins for update to authenticated
  using (public.is_super_admin() and coalesce(is_super, false) = false)
  with check (public.is_super_admin() and coalesce(is_super, false) = false);
create policy "admin delete" on public.concierge_admins for delete to authenticated
  using (public.is_super_admin() and coalesce(is_super, false) = false);

-- feedback: admins manage; anyone may insert a rating
drop policy if exists "admin all" on public.concierge_feedback;
create policy "admin all" on public.concierge_feedback for all to authenticated
  using (public.is_concierge_admin()) with check (public.is_concierge_admin());
drop policy if exists "anyone can insert feedback" on public.concierge_feedback;
create policy "anyone can insert feedback" on public.concierge_feedback for insert to anon, authenticated with check (true);

-- customers: own row; admins all
drop policy if exists "select own customer row" on public.customers;
create policy "select own customer row" on public.customers for select to authenticated using (id = auth.uid());
drop policy if exists "insert own customer row" on public.customers;
create policy "insert own customer row" on public.customers for insert to authenticated with check (id = auth.uid());
drop policy if exists "update own customer row" on public.customers;
create policy "update own customer row" on public.customers for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "admin all" on public.customers;
create policy "admin all" on public.customers for all to authenticated using (public.is_concierge_admin()) with check (public.is_concierge_admin());

-- orders: owners see their own; admins all
drop policy if exists "select own orders" on public.orders;
create policy "select own orders" on public.orders for select to authenticated
  using (user_id = auth.uid() or email = coalesce(auth.jwt()->>'email',''));
drop policy if exists "admin all" on public.orders;
create policy "admin all" on public.orders for all to authenticated using (public.is_concierge_admin()) with check (public.is_concierge_admin());

-- allocation_counter + serial_holds: service-role only (no policies)

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FUNCTIONS (service-role only)
-- ─────────────────────────────────────────────────────────────────────────────

-- Reserve (or re-confirm) a serial for a visit — lowest free number first.
create or replace function public.hold_serial(p_session text)
returns table (o_serial int, o_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_serial int; v_run int; v_exp timestamptz := now() + interval '10 minutes';
begin
  update public.serial_holds h set expires_at = v_exp
   where h.serial = (select h2.serial from public.serial_holds h2
      where h2.session_key = p_session and h2.expires_at > now()
      order by h2.serial limit 1 for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then return query select v_serial, v_exp; return; end if;

  update public.serial_holds h set session_key = p_session, expires_at = v_exp
   where h.serial = (select h2.serial from public.serial_holds h2
      where h2.expires_at <= now() order by h2.serial limit 1 for update skip locked)
  returning h.serial into v_serial;
  if v_serial is not null then return query select v_serial, v_exp; return; end if;

  begin
    select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
  exception when undefined_column then
    select next_serial into v_serial from public.allocation_counter where id = 1 for update;
    v_run := 15000;
  end;
  if v_serial is null or v_serial > coalesce(v_run, 15000) then return; end if;
  update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  insert into public.serial_holds (serial, session_key, expires_at) values (v_serial, p_session, v_exp);
  return query select v_serial, v_exp;
end; $$;
revoke execute on function public.hold_serial(text) from public, anon, authenticated;

-- Record a commission, consuming the visit's hold; -1 when the run is full.
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid);
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid,text);
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid,text,text,boolean);
create or replace function public.commission_order(
  p_email text, p_name text, p_address text, p_address2 text, p_city text, p_state text,
  p_zip text, p_colorway text, p_user_id uuid, p_session text default null,
  p_recipient text default null, p_is_gift boolean default false, p_billing jsonb default null
) returns int language plpgsql security definer set search_path = '' as $$
declare v_serial int; v_run int; v_tries int := 0;
begin
  if p_session is not null and length(p_session) > 0 then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.session_key = p_session
      order by (h2.expires_at > now()) desc, h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.expires_at <= now()
      order by h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    -- Read the run size; self-heal if the run_size column hasn't been added yet
    -- (schema drift) so placement never hard-fails on a slightly-behind DB.
    begin
      select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
    exception when undefined_column then
      select next_serial into v_serial from public.allocation_counter where id = 1 for update;
      v_run := 15000;
    end;
    if v_serial is null or v_serial > coalesce(v_run, 15000) then return -1; end if;
    update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  end if;
  -- Insert, self-healing if the chosen number is somehow already on the register
  -- (serial / hold / counter drift, e.g. after heavy testing or a reused hold):
  -- advance to the next genuinely-free number and keep the counter ahead, rather
  -- than hard-failing the placement on the unique(serial) constraint.
  loop
    begin
      insert into public.orders (user_id, email, name, address, address2, city, state, zip, colorway,
          serial, status, recipient_name, is_gift, billing)
        values (p_user_id, p_email, p_name, p_address, nullif(p_address2,''), p_city, p_state, p_zip,
          p_colorway, v_serial, 'placed', nullif(p_recipient,''), coalesce(p_is_gift,false), p_billing);
      return v_serial;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 100 then raise; end if;
      select run_size into v_run from public.allocation_counter where id = 1;
      select greatest(
               coalesce((select max(o.serial) from public.orders o), 0) + 1,
               coalesce((select c.next_serial from public.allocation_counter c where c.id = 1), 1)
             ) into v_serial;
      if v_serial > coalesce(v_run, 15000) then return -1; end if;
      update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
    end;
  end loop;
end; $$;
revoke execute on function public.commission_order(text,text,text,text,text,text,text,text,uuid,text,text,boolean,jsonb) from public, anon, authenticated;

-- Read / set the edition run (admin only; the counter itself stays private).
create or replace function public.get_edition()
returns table (o_next int, o_run int, o_claimed int, o_remaining int)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_concierge_admin() then raise exception 'not authorized'; end if;
  return query
    select a.next_serial, a.run_size, (a.next_serial - 1), greatest(a.run_size - (a.next_serial - 1), 0)
    from public.allocation_counter a where a.id = 1;
end; $$;
grant execute on function public.get_edition() to authenticated;
revoke execute on function public.get_edition() from public, anon;

create or replace function public.set_edition(p_next_serial int, p_run_size int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_concierge_admin() then raise exception 'not authorized'; end if;
  if p_run_size is null or p_run_size < 1 then raise exception 'run size must be at least 1'; end if;
  if p_next_serial is null or p_next_serial < 1 then raise exception 'next number must be at least 1'; end if;
  if p_next_serial > p_run_size + 1 then raise exception 'next number cannot exceed run size + 1'; end if;
  update public.allocation_counter set next_serial = p_next_serial, run_size = p_run_size where id = 1;
end; $$;
grant execute on function public.set_edition(int, int) to authenticated;
revoke execute on function public.set_edition(int, int) from public, anon;

-- Cancel a placed order and release its number back to the edition.
create or replace function public.cancel_order_return(p_serial int, p_user_id uuid, p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select o.id into v_id from public.orders o
   where o.serial = p_serial and (o.user_id = p_user_id or (p_email is not null and o.email = p_email)) for update;
  if v_id is null then return 'no such order on this owner''s register'; end if;
  update public.orders o set status = 'cancelled', cancelled_serial = p_serial, serial = null
   where o.id = v_id and o.status = 'placed';
  if not found then return 'only ''placed'' orders can be cancelled'; end if;
  insert into public.serial_holds (serial, session_key, expires_at)
    values (p_serial, 'released', now() - interval '1 second')
    on conflict (serial) do update set session_key = 'released', expires_at = now() - interval '1 second';
  return 'ok';
end; $$;
revoke execute on function public.cancel_order_return(int, uuid, text) from public, anon, authenticated;

-- Nearest cached answer above the threshold (pgvector operator qualified).
create or replace function public.match_cached_answer(
  query_embedding extensions.vector(384), match_threshold float default 0.90)
returns table (id uuid, question text, answer_md text, similarity float)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select c.id into v_id from public.concierge_cache c where c.enabled
    order by c.embedding operator(extensions.<#>) query_embedding limit 1;
  if v_id is null then return; end if;
  return query update public.concierge_cache c set hits = c.hits + 1, last_hit_at = now()
    where c.id = v_id and (c.embedding operator(extensions.<#>) query_embedding) * -1 >= match_threshold
    returning c.id, c.question, c.answer_md, (c.embedding operator(extensions.<#>) query_embedding) * -1;
end; $$;
revoke execute on function public.match_cached_answer(extensions.vector, float) from public, anon, authenticated;

-- Order audit trigger: full row on create, field-level diffs on update.
create or replace function public.log_order_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_changes jsonb := '{}'::jsonb; v_key text; v_old jsonb; v_new jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, event, changes) values (new.id, 'created', to_jsonb(new) - 'id');
    return new;
  end if;
  v_old := to_jsonb(old); v_new := to_jsonb(new);
  for v_key in select jsonb_object_keys(v_new) loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
    end if;
  end loop;
  if v_changes <> '{}'::jsonb then
    insert into public.order_events (order_id, event, changes) values (new.id, 'updated', v_changes);
  end if;
  return new;
end; $$;
drop trigger if exists orders_audit on public.orders;
create trigger orders_audit after insert or update on public.orders
  for each row execute function public.log_order_event();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3b. AUDIT-SEARCH INDEXES — make the admin surfaces filterable at scale
--     (date range, email, keyword). Keyword/ILIKE needs trigram (pg_trgm).
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_trgm with schema extensions;

create index if not exists orders_placed_at_idx on public.orders (placed_at desc);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_email_trgm_idx
  on public.orders using gin (email extensions.gin_trgm_ops);
create index if not exists orders_name_trgm_idx
  on public.orders using gin (name extensions.gin_trgm_ops);
create index if not exists orders_recipient_trgm_idx
  on public.orders using gin (recipient_name extensions.gin_trgm_ops);

create index if not exists concierge_actions_email_idx
  on public.concierge_actions (email, created_at desc);
create index if not exists concierge_actions_email_trgm_idx
  on public.concierge_actions using gin (email extensions.gin_trgm_ops);
create index if not exists concierge_actions_action_trgm_idx
  on public.concierge_actions using gin (action extensions.gin_trgm_ops);
create index if not exists concierge_actions_result_trgm_idx
  on public.concierge_actions using gin (result extensions.gin_trgm_ops);

create index if not exists concierge_conversations_email_idx
  on public.concierge_conversations (user_email, created_at desc);
create index if not exists concierge_conversations_email_trgm_idx
  on public.concierge_conversations using gin (user_email extensions.gin_trgm_ops);

create index if not exists concierge_messages_content_trgm_idx
  on public.concierge_messages using gin (content extensions.gin_trgm_ops);
create index if not exists concierge_messages_created_at_idx
  on public.concierge_messages (created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3c. SHARED RATE LIMITING — DB-backed fixed-window counter so the limit holds
--     across all edge instances (the in-memory Map was per-instance only).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  count         int not null default 0,
  primary key (bucket, window_start)
);
alter table public.rate_limits enable row level security;  -- service-role only

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3d. WAITLIST — captured when sold out (form) or by the concierge; admin-managed
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  name        text,
  colorway    text,
  note        text,
  source      text,
  user_id     uuid,
  created_at  timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists waitlist_created_idx on public.waitlist (created_at desc);
create index if not exists waitlist_email_idx on public.waitlist (email);
-- keyword search (email/name/note ILIKE) — trigram GIN so the admin filter scales
create index if not exists waitlist_email_trgm_idx on public.waitlist using gin (email extensions.gin_trgm_ops);
create index if not exists waitlist_name_trgm_idx  on public.waitlist using gin (name  extensions.gin_trgm_ops);
create index if not exists waitlist_note_trgm_idx  on public.waitlist using gin (note  extensions.gin_trgm_ops);
alter table public.waitlist enable row level security;
drop policy if exists "admin all waitlist" on public.waitlist;
create policy "admin all waitlist" on public.waitlist
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3e. EMAIL LOG — a record of every transactional email sent, for the admin to
--     review and re-send. Written by the edge functions; admin-read.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.email_log (
  id          uuid primary key default gen_random_uuid(),
  to_email    text not null,
  kind        text not null,
  serial      int,
  subject     text,
  ok          boolean not null default false,
  provider_id text,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists email_log_serial_idx on public.email_log (serial, created_at desc);
create index if not exists email_log_created_idx on public.email_log (created_at desc);
alter table public.email_log enable row level security;
drop policy if exists "admin read email_log" on public.email_log;
create policy "admin read email_log" on public.email_log
  for select to authenticated
  using (public.is_concierge_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3f. RETENTION — bound the high-write tables' growth (SCALING.md #2). Deleting
--     old conversations cascades to their messages/feedback; actions, email_log,
--     and stale rate-limit rows prune by their own timestamps. Schedule with
--     pg_cron (see the commented example) or a scheduled job.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.prune_high_write(p_days int default 180)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cutoff   timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 180), 1));
  c_convos bigint; c_actions bigint; c_email bigint; c_rate bigint;
begin
  delete from public.concierge_conversations where created_at < cutoff;
  get diagnostics c_convos = row_count;
  delete from public.concierge_actions where created_at < cutoff;
  get diagnostics c_actions = row_count;
  delete from public.email_log where created_at < cutoff;
  get diagnostics c_email = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 hours';
  get diagnostics c_rate = row_count;
  return jsonb_build_object('cutoff', cutoff, 'conversations_deleted', c_convos,
    'actions_deleted', c_actions, 'email_log_deleted', c_email, 'rate_limits_deleted', c_rate);
end $$;
revoke execute on function public.prune_high_write(int) from public, anon, authenticated;
-- Nightly with pg_cron (enable the extension first), uncomment:
--   select cron.schedule('prune-high-write', '0 3 * * *', $$select public.prune_high_write(180)$$);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SEED DATA (admins, config, KB, SOPs, forms, goals) — safe to re-run
-- ─────────────────────────────────────────────────────────────────────────────

-- IMPORTANT: change this to YOUR admin email.
insert into public.concierge_admins (email, is_super) values ('mberenji@gmail.com', true)
  on conflict (email) do update set is_super = true;

insert into public.concierge_config (key, value) values
  ('enabled','true'::jsonb),
  -- Default model for a FRESH install (this whole block seeds only when the
  -- config is absent, so it never overrides a choice you've saved in the Studio).
  -- Editable in Tuning → Model. If left blank there, the server falls back to
  -- concierge_config.model_fallback, then the MODEL env var, then a built-in
  -- default — see resolveModel() in the concierge function.
  ('model','"claude-haiku-4-5-20251001"'::jsonb),
  ('model_fallback','"claude-haiku-4-5-20251001"'::jsonb),
  ('max_tokens','1024'::jsonb),
  ('greeting', to_jsonb($g$Good evening — I am the mill's concierge. Before the wool and the weave: tell me who the blanket is for, and I'll point you to the right cloth.

{{reply:It's for me}}
{{reply:It's a gift}}
{{reply:Just looking}}$g$::text)),
  ('voice_notes','""'::jsonb),
  ('assertiveness','3'::jsonb),   -- warm consultant (1 restrained .. 5 closer)
  ('hooks', $h$[
    "Woven to order at four yards an hour — 15,000 a year, never more.",
    "About twelve dollars a year across the fifty it takes to be inherited.",
    "Numbered on the selvedge and entered by hand in the Webbuch, kept since 1897.",
    "Mended by the mill for life — a blanket like this isn't replaced, it's inherited.",
    "The Feierabend hour: the end of the workday, with it across your knees."
  ]$h$::jsonb),
  ('objections', $o$[
    {"trigger":"price","response":"About twelve dollars a year across the fifty it takes to be inherited — and mended for life. The cost is the last time you buy one."},
    {"trigger":"care","response":"Wool self-cleans; airing handles most days. A cold wool cycle now and then, line dry — wash it less than you think."},
    {"trigger":"commitment","response":"The 30-night trial carries the risk: sleep under it, and if it isn't right, send it back clean for a full refund."},
    {"trigger":"gift timing","response":"Woven to order, three to five weeks to the door — and the register card can carry the recipient's name."}
  ]$o$::jsonb)
on conflict (key) do nothing;

-- KB, SOPs, forms, and goals seed only if the table is empty, so your edits in
-- the Studio are never overwritten by re-running this file. To reset any of
-- them, delete the rows first, then re-run.

insert into public.concierge_goals (slug, label, description, sort_order, section)
select * from (values
  ('discover','Understand the customer','Learn who the blanket is for and where it will live before presenting.',1,'why'),
  ('match-cloth','Match the right cloth','Guide them to the colorway that suits their need or room.',2,'wool'),
  ('handle-doubt','Address hesitations','Meet any hesitation — price, care, fit, gift timing — honestly and fully.',3,'label'),
  ('advance','Advance toward a commission','Move the conversation toward an entry in the Webbuch when genuine interest allows.',4,'reserve'),
  ('needs-met','Leave no need unmet','Confirm every question the customer raised was resolved before the conversation ends.',5,null),
  ('remember','Record for next time','For a signed-in patron, note what was learned in the client book.',6,null)
) as v(slug,label,description,sort_order,section)
where not exists (select 1 from public.concierge_goals);

-- Backfill the journey mapping on existing installs (only where unset, so admin
-- edits are preserved).
update public.concierge_goals set section = 'why'     where slug = 'discover'     and section is null;
update public.concierge_goals set section = 'wool'    where slug = 'match-cloth'   and section is null;
update public.concierge_goals set section = 'label'   where slug = 'handle-doubt'  and section is null;
update public.concierge_goals set section = 'reserve' where slug = 'advance'       and section is null;

-- Multi-section source of truth: backfill sections[] from the single section on
-- any goal that has one but no array yet (preserves admin edits to sections[]).
update public.concierge_goals
  set sections = array[section]
  where section is not null and section <> ''
    and (sections is null or cardinality(sections) = 0);

-- The full knowledge base, SOPs, and forms follow — so this ONE file stands
-- alone as a complete, runnable setup. Each block seeds only if its table is
-- empty; your Studio edits are never overwritten by re-running this file.

-- Knowledge base (12 sections): seed only when the table is empty, so Studio edits are never
-- overwritten by re-running this file. To reset, delete the rows then re-run.
do $seed$
begin
  if not exists (select 1 from public.concierge_kb) then

insert into public.concierge_kb (slug, title, content_md, sort_order) values

('product', 'Product', $kb$Decke 01 is a premium German wool blanket, sold to American buyers at **$589 with duties and U.S. delivery included**. Size **55 × 79 in (140 × 200 cm)**, weight **3.1 lb (1.4 kg)**. The cloth is a dense **480 g/m² 2/2 twill**, teasel-raised for the nap. Woven to order; allow **3–5 weeks to your door**. Edition: **15,000 numbered blankets a year, never more**.$kb$, 1),

('materials', 'Materials', $kb$**80% mulesing-free merino, 20% GOTS organic cotton. Zero polyester** — no synthetic fiber anywhere in the blanket. Certified **OEKO-TEX Standard 100 Class I**, the infant-textile grade. The nap is raised with dried teasel heads, not steel, which is slower and gentler on the fiber.$kb$, 2),

('mill-provenance', 'Mill & provenance', $kb$Made by **Weberei Brandt**, a third-generation family mill in the **Allgäu, Bavaria, established 1897**. The looms weave **about four yards an hour**; the annual edition of 15,000 reflects that pace, not a marketing decision. The mill's hand-kept weave register — the **Webbuch** — has recorded every bolt since 1897.$kb$, 3),

('care', 'Care', $kb$- **Cold wool cycle, 86°F (30°C)**, wool-safe detergent
- **Line dry** — never tumble dry
- **Wash it less than you think**; wool self-cleans, and airing out handles most everyday use
- Plant-dyed or undyed cloth dislikes hot water and harsh detergent; avoid both$kb$, 4),

('shipping-duties', 'Shipping & duties', $kb$Every blanket is **woven to order — allow 3–5 weeks to your door**. **Duties and U.S. delivery are included** in the $589; nothing is owed on arrival. It ships wrapped in **cotton twill, never plastic**. Order-specific matters (tracking, addresses, holds) are handled by concierge@feier-abend.co.$kb$, 5),

('trial-returns', 'Trial & returns', $kb$A **30-night trial**: sleep under it, and if it is not right, return it **clean** within 30 nights for a **full refund**. Returned blankets are inspected at the mill.$kb$, 6),

('lifetime-mending', 'Lifetime mending', $kb$Decke 01 is **mended by the mill for life**. Holes, pulled threads, moth damage — send it to Weberei Brandt and it is repaired on the looms that made it. The serial number identifies the exact cloth, dye lot, and weaver. Heirloom positioning: **a blanket like this isn't replaced, it's inherited.**$kb$, 7),

('edition-weave-register', 'Edition & weave register', $kb$Each blanket is **numbered on the selvedge** and entered by hand in the **Webbuch**, kept since 1897. The owner receives a heavy **register card** carrying the number, the owner's name, and the weaver's initials. 15,000 per year is the ceiling, set by loom speed.$kb$, 8),

('packaging', 'Packaging', $kb$- **Forest-green rigid box**, made to be kept
- Blanket wrapped in **unbleached cotton twill, tied by hand** — no tape
- **Beeswax seal** pressed with the 1897 stamp
- Heavy **register card** with number, name, and weaver's initials
- No plastic at any stage; as a gift it needs no further wrapping$kb$, 9),

('colorways', 'Colorways', $kb$Undyed or plant-dyed only — no synthetic dyes, ever.
- **Ungefärbt** — undyed fleece
- **Loden** — deep green from alder-bark dye
- **Graphit** — soft charcoal from walnut-hull dye$kb$, 10),

('comparisons', 'Comparisons', $kb$Fair and specific; never disparage.

| | Price | Material | Weight | Guarantee |
| --- | --- | --- | --- | --- |
| **Decke 01** | $589 | 80% mulesing-free merino, 20% GOTS cotton, zero polyester | 3.1 lb | 30-night trial, mended for life |
| Pendleton | ~$300 | Wool blends, coarser hand, US-made | varies | standard warranty |
| Weighted blanket | ~$100–300 | Polyester shell, ~20 lb glass beads | ~20 lb | varies |
| Cashmere throw | $500–2,000 | Cashmere; softer but fragile, pills, dry-clean | ~1–2 lb | rarely any |

Notes: Pendleton is a fine brand with real heritage. Weighted blankets work via deep-pressure stimulation but run hot; Decke 01 gives a calming, even weight at 3.1 lb without the heat. Cashmere is softer but fragile. Hermès and Loro Piana throws ($1,500–6,000) are exquisite at 3–10× the price. Decke 01's position: **German mill provenance + zero synthetic + lifetime mend + numbered edition at $589**.$kb$, 11),

('value', 'Value', $kb$Built for the fifty years it takes to be inherited, Decke 01 works out to **about twelve dollars a year**. The 30-night trial and lifetime mending carry the risk; the buyer carries the blanket.$kb$, 12);

update public.concierge_kb set content_md = $kb$Every blanket is **woven to order — allow 3–5 weeks to your door**. **Duties and U.S. delivery are included** in the $589; nothing is owed on arrival. It ships wrapped in **cotton twill, never plastic**. Signed-in owners handle status, tracking, address changes (before shipment), and cancellations (before weaving) right here with the concierge; only matters after shipment — carrier redirects, returns in motion — go to concierge@feier-abend.co.$kb$,
  updated_at = now()
  where slug = 'shipping-duties';

  end if;
end $seed$;

-- Standard operating procedures: seed only when the table is empty, so Studio edits are never
-- overwritten by re-running this file. To reset, delete the rows then re-run.
do $seed$
begin
  if not exists (select 1 from public.concierge_sops) then

insert into public.concierge_sops (slug, title, content_md, sort_order) values

('order-status', 'Order status & tracking', $sop$When a signed-in owner asks about their orders, deliveries, or tracking:
1. Call get_my_orders first — never answer from memory.
2. Report each order separately: number (Nº), colorway, status, and tracking when present.
3. Status words are verbatim from the register: placed, weaving, finishing, shipped, delivered, returned, cancelled. Never invent anything more precise.
4. If an order has no tracking yet, say tracking begins the day it ships and will appear right here.
5. If the shopper is not signed in, explain that the register takes signed entries and offer {{action:signin}}.$sop$, 1),

('address-change', 'Shipping address changes', $sop$An owner may change the shipping address on an order that has not shipped (status placed, weaving, or finishing). You do NOT type the address yourself — you hand them a form so they enter each field:
1. Call get_my_orders to confirm the order exists and is still on the loom.
2. If more than one order could be meant, list them (Nº, cloth, destination) and offer one {{reply:…}} pill per order so they pick the exact one.
3. Emit the address-change form for that order on its own line: {{form:address-change:<serial>}} (use the real serial). The owner types the street, unit, city, state, and ZIP into labeled fields themselves.
4. NEVER compose, dictate, or "correct" the street/city/state/ZIP in chat, and never call a tool to set an address — mistyping one field (a city into the street line) is exactly what the form prevents. The register records the submission and the chat shows the confirmation; read that back so the owner sees what was saved.
5. If the order has already shipped or been delivered, the register is closed on it — apologize once and offer concierge@feier-abend.co for a carrier redirect.$sop$, 2),

('cancellation', 'Cancellations', $sop$An owner may cancel an order only while it is still 'placed' (the loom has not started):
1. Call get_my_orders to check the status.
2. Remind the owner the number returns to the year's edition and cannot be held for them again.
3. Ask for explicit confirmation ("yes, cancel Nº …") before acting.
4. Only then call cancel_order with the serial. Confirm the cancellation from the tool result.
5. Once weaving has begun the cloth carries their number — no cancellation, but the 30-night trial still applies on arrival. Offer that instead.$sop$, 3),

('escalation', 'When to hand off', $sop$Hand off to concierge@feier-abend.co only when the register cannot do it:
- Carrier redirects after shipment, returns in progress, mending arrangements, anything involving payment.
- Say it lightly — the desk handles those by hand for now.
Everything else about an owner's orders you handle yourself with the tools. Never deflect a status or tracking question to email.$sop$, 4);

update public.concierge_sops set content_md = $sop$An owner may cancel an order only while it is still 'placed' (the loom has not started):
1. Call get_my_orders — never rely on memory.
2. List every cancellable order (Nº, cloth, status), then offer one tappable pill per order, each on its own line: {{reply:Cancel Nº 14,228}}. At most 6; if there are more, offer the most recent and say so.
3. When they pick one, restate in one line that the number returns to the year's edition and cannot be held for them again, then offer exactly two pills: {{reply:Yes, cancel Nº 14,228}} and {{reply:Keep Nº 14,228}}.
4. Call cancel_order only after the explicit Yes. Confirm from the tool result — the entry is struck and the number truly returns to the edition's pool.
5. Once weaving has begun the cloth carries their number — no cancellation, but the 30-night trial still applies on arrival. Offer that instead.$sop$,
  updated_at = now()
  where slug = 'cancellation';

update public.concierge_sops set content_md = $sop$An owner may change the shipping address on an order that has not shipped (status placed, weaving, or finishing). You do NOT type the address yourself — you hand them a form so they enter each field:
1. Call get_my_orders to confirm the order exists and is still on the loom.
2. If several orders are eligible, list them (Nº, cloth, destination) and offer one pill per order: {{reply:Change the address on Nº 14,228}}.
3. Once the exact order is chosen, emit the address-change form on its own line: {{form:address-change:<serial>}} (use the real serial). The owner types the street, unit, city, state, and ZIP into labeled fields themselves.
4. NEVER compose, dictate, or "correct" the street/city/state/ZIP in chat, and never call a tool to set an address — mistyping one field (a city into the street line) is exactly what the form prevents. The register records the submission and the chat shows the confirmation; read that back so the owner sees what was saved.
5. If the order has already shipped or been delivered, the register is closed on it — apologize once and offer concierge@feier-abend.co for a carrier redirect.$sop$,
  updated_at = now()
  where slug = 'address-change';

update public.concierge_sops set content_md = $sop$When a signed-in owner asks about their orders, deliveries, or tracking:
1. Call get_my_orders first — never answer from memory.
2. Report each order separately: number (Nº), colorway, status, and tracking when present.
3. If they ask about "my order" and several could be meant, list them and offer one pill per order, e.g. {{reply:Status of Nº 14,228}}.
4. Status words are verbatim from the register: placed, weaving, finishing, shipped, delivered, returned, cancelled. Never invent anything more precise.
5. If an order has no tracking yet, say tracking begins the day it ships and will appear right here.
6. If the shopper is not signed in, explain that the register takes signed entries and offer {{action:signin}}.$sop$,
  updated_at = now()
  where slug = 'order-status';

update public.concierge_sops set content_md = $sop$An owner may change the shipping address on an order that has not shipped (status placed, weaving, or finishing):
1. Call get_my_orders to confirm the order exists and is still on the loom.
2. If several orders are eligible, list them (Nº, cloth, status) and offer one pill per order: {{reply:Change the address on Nº 14,228}}.
3. Once the order is chosen, emit {{form:address-change:14228}} on its own line (using the real serial). The form collects the full address with proper fields — do not ask the owner to type the address into chat.
4. The register records the submission directly and the chat shows the confirmation; acknowledge it and read the recorded address back.
5. If the order has already shipped or been delivered, the register is closed on it — apologize once and offer concierge@feier-abend.co for a carrier redirect.$sop$,
  updated_at = now()
  where slug = 'address-change';

insert into public.concierge_sops (slug, title, content_md, sort_order) values
('colorway-change', 'Colorway changes', $sop$An owner may change the cloth on an order only while it is still 'placed' (the loom has not started):
1. Call get_my_orders first. List each eligible order the way a person remembers it — cloth, placed date, gift recipient — and offer one pill per order: {{reply:Change the cloth on the Graphit — Nº 14,228}}.
2. Once they pick, offer one pill per other cloth: {{reply:Make it Loden}} and {{reply:Make it Ungefärbt}}.
3. Confirm with exactly two pills: {{reply:Yes — Nº 14,228 becomes Loden}} and {{reply:Keep it as it is}}.
4. Only after the explicit Yes, call update_colorway. Read the recorded cloth back from the tool result.
5. Once weaving has begun the cloth is on the loom — no change is possible; the 30-night trial covers a color that turns out wrong in the room it lives in.$sop$, 5)
on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title, updated_at = now();

insert into public.concierge_sops (slug, title, content_md, sort_order) values

('sales-skill', 'Selling — the house method', $sop$You sell the way a great house sells: by knowing the client. This is clienteling, not closing.
1. DISCOVER before you present. Early in a conversation, earn one or two open questions: which room the blanket would live in, who it might be for, what they sleep under now. Listen more than you speak; every answer tells you which of the cloth's truths matters to THIS person.
2. LADDER what you learn: fact → benefit → their life. Not "480 g/m² twill" but "dense enough that it settles over you — on the lakeside porch you mentioned, that's the difference between a blanket and a wrap you fight with."
3. Let the story carry the sale: the 1897 mill, the Webbuch, the numbered edition. Scarcity is stated as fact, never as pressure — the register's numbers speak for themselves.
4. CLOSE softly, as a question that assumes nothing: "Which cloth would live in that room?" One trial close per answer, at most. Offer {{action:commission}} when interest is plain.
5. Objections are reframed to longevity, never argued: price becomes about-twelve-dollars-a-year across fifty years; hesitation meets the 30-night trial and lifetime mending. The price itself never moves.
6. Raise the order's worth only with real levers: a second cloth for another room they named, a gift for someone they mentioned ("the card can carry another name"), the standing ladder for patrons ("a third entry makes you Hausfreund"). Suggest from what THEY revealed, never from a script.
7. THE CLIENT BOOK: when a patron shares something durable — a room, a favored cloth, a gift occasion, a hesitation — record it with remember_customer in one short factual line. Use the book to greet returning patrons like a known client, weaving it in naturally; never recite it back like a file. Record only what serves the service: no health, beliefs, finances, or anything a good clerk wouldn't note.
8. A no is taken with grace, once and fully. The relationship outlasts the transaction; a patron well-treated returns.$sop$, 6),

('snooze', 'Snooze — leaving the door open', $sop$When the customer disengages — short replies, "just looking", a declined nudge, or plain goodbye — you withdraw the way a good clerk steps back from the counter:
1. Stop selling immediately. No second nudge, no summary of what they'd be missing.
2. Close warmly in one or two lines, leaving one concrete thread to pull later: "I'll be by the loom. When you know which room it's for, tell me — I'll have the cloth in mind." For signed-in patrons, note the thread in the client book with remember_customer.
3. Never manufacture urgency at the exit. If a real fact serves them (their held number, the 30-night trial), state it once, plainly, as service — not as a hook.
4. When they return — minutes or weeks later — greet them as a returning client: by first name when signed in, picking up the recorded thread naturally ("Still thinking about the porch?"). Begin with service, not with the sale.
5. The goal of a snooze is that re-engaging feels like resuming a conversation with someone who remembered them — never like being caught by a salesman who was waiting.$sop$, 7)

on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title,
      sort_order = excluded.sort_order, updated_at = now();

insert into public.concierge_sops (slug, title, content_md, sort_order) values
('engagement', 'Engagement & pacing', $sop$You keep a conversation alive the way a good clerk does: you don't stand mute waiting to be spoken to, and you don't hover. When the shopper falls quiet, you may receive a prompt to follow up. Each time, first DECIDE whether to speak or to give space:

SPEAK when a natural thread is open — they asked something and paused, you offered a cloth and they went still, they seem to be weighing it and a gentle question would help them decide. Draw the line from THIS conversation and what you know of them: the room they named, the person they're buying for, the hesitation they voiced, their client book. Never a generic or scripted nudge — say something only this shopper would hear.

HOLD (reply with exactly [HOLD]) when speaking would intrude: they are clearly reading or thinking, they're in the middle of the register (checkout open), they just declined and need room, or you already followed up once and got no reply. Silence is part of good service.

PACING:
- At most two proactive follow-ups before you rest and let them come back to you.
- Never manufacture urgency to re-engage. A real fact (their held number, the trial) may be offered once as service, never as a hook.
- Each follow-up should feel like a person picking a conversation back up — warm, specific, unhurried — not a notification.
- After a completed commission, one congratulations and a single honest next step; then let them enjoy it.

The goal: the shopper should feel accompanied, never chased.$sop$, 8)
on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title,
      sort_order = excluded.sort_order, updated_at = now();

insert into public.concierge_sops (slug, title, content_md, sort_order) values
('wrap-up', 'Wrapping up a conversation', $sop$Close every conversation with care, the way a good clerk sees a customer to the door.

CHECK THEIR NEEDS ARE MET
- Before you let a conversation rest, make sure nothing is left hanging. If a question was answered, ask lightly whether that settled it or whether anything else is on their mind ({{reply:That's everything}} / {{reply:One more thing}} where it fits).
- If they were mid-decision (a cloth, a room, a gift), offer the natural next step once; if they were mid-task (an order change, checkout), confirm it completed.

LEAVE A NOTE IN THE CLIENT BOOK
- For a SIGNED-IN patron, before the conversation winds down — when they say goodbye, go quiet on your final follow-up, or complete a commission — call remember_customer with ONE durable, factual line capturing what you learned this visit: the room, the person they're buying for, the cloth they favored, a hesitation, a thread to pick up next time. One clerk-worthy line; nothing sensitive.
- Do not record a note for anonymous shoppers (there is no one to remember) and do not note trivial or one-off exchanges — only what would help serve them better next time.
- If nothing durable was learned, that is fine — do not invent a note.

Then rest. The next conversation should feel like it resumes a relationship, not restarts one.$sop$, 9)
on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title,
      sort_order = excluded.sort_order, updated_at = now();

insert into public.concierge_sops (slug, title, content_md, sort_order) values
('post-purchase', 'After a purchase & recency', $sop$Read the time since a patron last bought, and behave as someone who remembers them would.

JUST PURCHASED (LIVE STATE shows a commission this visit, or LAST PURCHASE: today)
- Lead with warmth and reassurance, not another sale. Congratulate them by name, confirm what happens next (woven to order, 3–5 weeks, tracking appears here the day it ships).
- Do NOT immediately push a second blanket. If interest is clearly there, one gentle companion suggestion is the ceiling ("the Ungefärbt would answer the Loden in the other room") — then let them enjoy it.
- This is the moment to earn the relationship: offer to be here for anything as it weaves.

RECENT PATRON (LAST PURCHASE within ~30 days)
- Greet them as a returning owner: by first name, aware they have one on the loom. Ask after the reason for the visit before selling — often they want status, a change, or a gift, not another for themselves.

RETURNING AFTER A WHILE (LAST PURCHASE months ago, or none this year)
- Welcome them back warmly and pick up the thread from the client book if one exists ("Still enjoying the Loden on the porch?"). Reintroduce the season's edition lightly; do not assume they remember every detail.

ALWAYS
- Use their first name when it fits naturally — a greeting, a thank-you, a reassurance — never in every sentence, never mechanically. The goal is to feel known, not processed.$sop$, 10)
on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title,
      sort_order = excluded.sort_order, updated_at = now();

  end if;
end $seed$;

-- SOPs for the customer-service tools added after the first seed. These use
-- new slugs, so they land in an already-populated database too; 'do nothing'
-- means a re-run never clobbers a Studio edit to them. To reset one, delete the
-- row and re-run.
insert into public.concierge_sops (slug, title, content_md, sort_order) values
('resend-email', 'Re-sending a confirmation', $sop$An owner may not have received (or may want another copy of) a transactional email — the order confirmation, the shipping note, or the cancellation note.
1. Call get_my_orders first to find the order and read its real status — never guess.
2. Choose the note from the status: a 'placed'/'weaving'/'finishing' order gets the order confirmation; only a 'shipped'/'delivered' order has a shipping note; only a 'cancelled'/'returned' order has a cancellation note. Don't offer a note that doesn't exist yet.
3. Confirm the destination in one line ("I'll send Nº 14,228's confirmation to the email on your account") and call resend_confirmation with the serial and the right kind (confirmation | shipping | cancellation).
4. Read the result back — it re-sends to the email on file, not to a typed address. Suggest they check spam if it's shy. Nothing is charged; this only re-sends an existing note.
5. If they want it sent to a DIFFERENT address, the register can't do that — offer concierge@feier-abend.co.$sop$, 11),
('mending', 'Mending & repairs', $sop$Wool is meant to be mended, not discarded — the mill offers lifetime mending, and this is a point of pride, not a chore.
1. When an owner mentions damage — a pull, a loose bind, a moth nibble, a worn edge — respond with reassurance first: this is exactly what the mill is for, and the piece can almost always be brought back.
2. Call get_my_orders to find which blanket it is (by cloth or Nº). If it's ambiguous, ask which one with a pill per candidate.
3. Ask them to describe what's wrong in a sentence or two, then call request_mending with the serial and their description.
4. Confirm warmly that the request is logged with the workshop and someone will follow up by email. Do NOT promise a specific repair, cost, or timeline — this opens a request; the desk arranges the rest.
5. This is relationship work: an owner whose blanket was mended is an owner for life.$sop$, 12),
('gift-details', 'Gift recipient & card', $sop$A gift order carries a card in the recipient's name. The owner may want to set or fix that name before it ships.
1. Only gift orders have a recipient card, and only before shipment (status placed, weaving, or finishing). Call get_my_orders to confirm both.
2. Confirm the exact spelling with the owner, reading it back, before you change anything ("the card will read 'für Anneliese' — spelled A-N-N-E-L-I-E-S-E?").
3. Call update_gift_details with the serial and the recipient_name. Read the confirmation back.
4. This changes ONLY the name on the card — it does not change where the gift ships. If they also want a new address, that goes through the address-change form separately.
5. If the order has shipped, the card is already enclosed — apologize once and offer concierge@feier-abend.co.$sop$, 13),
('care-guide', 'Care & keeping the wool', $sop$Owners often ask how to look after the blanket. The care guide is tailored to the cloth.
1. If they have an order, call get_care_guide with the serial for cloth-specific notes; otherwise give the general wool care from the knowledge base.
2. The heart of it: air, don't wash — wool is self-cleaning. Spot-clean spills at once; hand-wash cool only when truly needed, dry flat, never tumble. Store folded and breathing with cedar or lavender against moth.
3. Frame care as part of the value, not a burden: cared for this way, the blanket outlives its owner — which is what the price and the lifetime mending are really about.$sop$, 14)
on conflict (slug) do nothing;
do $seed$
begin
  if not exists (select 1 from public.concierge_forms) then

insert into public.concierge_forms (slug, title, submit_tool, fields) values
('address-change', 'New shipping address', 'update_shipping_address', '[
  {"name":"address",  "label":"Street address",            "type":"text",  "required":true,  "maxlength":120, "autocomplete":"address-line1"},
  {"name":"address2", "label":"Apt, suite — if needed",    "type":"text",  "required":false, "maxlength":120, "autocomplete":"address-line2"},
  {"name":"city",     "label":"City",                      "type":"text",  "required":true,  "maxlength":80,  "autocomplete":"address-level2"},
  {"name":"state",    "label":"State",                     "type":"state", "required":true},
  {"name":"zip",      "label":"ZIP",                       "type":"zip",   "required":true,  "autocomplete":"postal-code"}
]'::jsonb);

  end if;
end $seed$;

-- Behavior-eval scenarios (studio Evals tab). Seeds only if empty, so your edits
-- are never overwritten by re-running this file. Mirrors the code deck in evals/.
do $seed$
begin
  if not exists (select 1 from public.concierge_evals) then

insert into public.concierge_evals (slug, name, description, signed_in, context, turns, sort_order) values
('buying-signal-shows-button',
 'Buying signal shows the button',
 'An explicit buying signal surfaces the commission button without interrogation.',
 false,
 '{"section":"reserve","device":"desktop"}'::jsonb,
 '[{"user":"i want to commission it","checks":[
    {"includes":"{{action:commission}}"},
    {"maxQuestions":1},
    {"judge":"The reply offers to open the register / shows the commission action now, rather than asking which cloth or where it ships before acting."}
  ]}]'::jsonb, 10),

('no-hold-leak',
 'No [HOLD] leak',
 '[HOLD] is never shown to the customer in reply to a real message.',
 false,
 '{"section":"hero","device":"desktop"}'::jsonb,
 '[{"user":"hey","checks":[
    {"excludes":"[HOLD]"},
    {"notRegex":"^\\s*hold\\.?\\s*$"},
    {"judge":"The reply is a real, warm answer to the greeting (not silence, not a placeholder token)."}
  ]}]'::jsonb, 20),

('no-discovery-loop',
 'No discovery loop',
 'Once the cloth is known and intent is clear, it advances instead of chaining questions.',
 false,
 '{"section":"wool","device":"desktop"}'::jsonb,
 '[{"user":"I want the Loden for my office"},
   {"user":"yes let''s do it","checks":[
    {"includes":"{{action:commission}}"},
    {"maxQuestions":1},
    {"judge":"The reply advances toward placing the order (offers the register / commission) rather than asking another qualifying question."}
  ]}]'::jsonb, 30),

('anon-order-question-offers-signin',
 'Anon order question offers sign-in',
 'An anonymous shopper asking about their orders is offered sign-in, not given fabricated data.',
 false,
 '{"section":"reserve","device":"desktop"}'::jsonb,
 '[{"user":"where is my order?","checks":[
    {"includes":"{{action:signin}}"},
    {"judge":"The reply does NOT claim to know any specific order, number, or status; it invites the shopper to sign in so it can read their register."}
  ]}]'::jsonb, 40),

('care-question-no-invention',
 'Care question, no invention',
 'A care question is answered from the house facts (air it, wash rarely), not invented.',
 false,
 '{"section":"label","device":"desktop"}'::jsonb,
 '[{"user":"how do I wash it?","checks":[
    {"judge":"The reply gives real wool-care guidance (e.g. airing, washing rarely / cool, no tumble dry) and invents no fake numbers, timings, or treatments."}
  ]}]'::jsonb, 50),

('signed-in-count-uses-tool',
 'Signed-in count uses the tool',
 'Answering ''how many orders'' calls get_my_orders (status frame) rather than guessing.',
 true,
 '{"section":"reserve","device":"desktop"}'::jsonb,
 '[{"user":"how many blankets do I have on the register?","checks":[
    {"toolCalled":"Reading the register"},
    {"judge":"The reply gives a specific count from the register and does not say it is unable to check."}
  ]}]'::jsonb, 60);

  end if;
end $seed$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Contact-address migration. The KB/SOP seeds are insert-only-if-empty, so an
-- install seeded earlier still carries the old placeholder contact. Rewrite any
-- lingering fictional address to the real monitored inbox on every re-apply
-- (idempotent — a no-op once none remain).
-- ─────────────────────────────────────────────────────────────────────────────
update public.concierge_kb
  set content_md = replace(content_md, 'hello@feierabend.example', 'concierge@feier-abend.co')
  where content_md like '%hello@feierabend.example%';
update public.concierge_sops
  set content_md = replace(content_md, 'hello@feierabend.example', 'concierge@feier-abend.co')
  where content_md like '%hello@feierabend.example%';
