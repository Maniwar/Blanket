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
  add column if not exists goal_status_at timestamptz;
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

create table if not exists public.customer_notes (
  id bigint generated always as identity primary key,
  user_id uuid, email text, note text not null,
  created_at timestamptz not null default now());
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
    'concierge_forms','customer_notes','order_events','concierge_goals'
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
    'concierge_goals','concierge_flags'
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

  select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
  if v_serial is null or v_serial > v_run then return; end if;
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
declare v_serial int; v_run int;
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
    select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
    if v_serial is null or v_serial > v_run then return -1; end if;
    update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  end if;
  insert into public.orders (user_id, email, name, address, address2, city, state, zip, colorway,
      serial, status, recipient_name, is_gift, billing)
    values (p_user_id, p_email, p_name, p_address, nullif(p_address2,''), p_city, p_state, p_zip,
      p_colorway, v_serial, 'placed', nullif(p_recipient,''), coalesce(p_is_gift,false), p_billing);
  return v_serial;
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
-- 4. SEED DATA (admins, config, KB, SOPs, forms, goals) — safe to re-run
-- ─────────────────────────────────────────────────────────────────────────────

-- IMPORTANT: change this to YOUR admin email.
insert into public.concierge_admins (email, is_super) values ('mberenji@gmail.com', true)
  on conflict (email) do update set is_super = true;

insert into public.concierge_config (key, value) values
  ('enabled','true'::jsonb),
  ('model','"claude-sonnet-4-5"'::jsonb),
  ('max_tokens','1024'::jsonb),
  ('greeting', to_jsonb($g$Good evening — I am the mill's concierge. Before the wool and the weave: tell me who the blanket is for, and I'll point you to the right cloth.

{{reply:It's for me}}
{{reply:It's a gift}}
{{reply:Just looking}}$g$::text)),
  ('voice_notes','""'::jsonb)
on conflict (key) do nothing;

-- KB, SOPs, forms, and goals seed only if the table is empty, so your edits in
-- the Studio are never overwritten by re-running this file. To reset any of
-- them, delete the rows first, then re-run.

insert into public.concierge_goals (slug, label, description, sort_order)
select * from (values
  ('discover','Understand the customer','Learn who the blanket is for and where it will live before presenting.',1),
  ('match-cloth','Match the right cloth','Guide them to the colorway that suits their need or room.',2),
  ('handle-doubt','Address hesitations','Meet any hesitation — price, care, fit, gift timing — honestly and fully.',3),
  ('advance','Advance toward a commission','Move the conversation toward an entry in the Webbuch when genuine interest allows.',4),
  ('needs-met','Leave no need unmet','Confirm every question the customer raised was resolved before the conversation ends.',5),
  ('remember','Record for next time','For a signed-in patron, note what was learned in the client book.',6)
) as v(slug,label,description,sort_order)
where not exists (select 1 from public.concierge_goals);

-- KB / SOPs / forms are large; they live in the migrations and the Studio.
-- If this is a brand-new project and those tables are empty, run the ordered
-- files in supabase/migrations/ once (or `supabase db push`) to seed them,
-- then manage everything from the Studio thereafter.
