-- ============================================================================
-- 0022_admin_roster.sql — Feierabend (Decke 01)
-- Manage the admin roster from the admin panel, with a protected super admin.
--   • any admin may LIST the roster and ADD a (non-super) admin;
--   • only the SUPER admin may REMOVE an admin;
--   • the super row can never be removed or demoted, so one owner always remains.
--
-- is_concierge_admin() / is_super_admin() are SECURITY DEFINER reads of this
-- table, bypassing RLS, so using them in this table's own policies does not
-- recurse. A non-admin continues to see zero rows.
-- ============================================================================

alter table public.concierge_admins add column if not exists is_super boolean not null default false;

create or replace function public.is_super_admin() returns boolean
  language sql security definer stable set search_path = '' as
$$ select exists(select 1 from public.concierge_admins a
     where a.email = coalesce(auth.jwt()->>'email','') and a.is_super) $$;

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

-- Ensure the owner is the (protected) super admin.
insert into public.concierge_admins (email, is_super) values ('mberenji@gmail.com', true)
  on conflict (email) do update set is_super = true;
