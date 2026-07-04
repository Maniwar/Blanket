-- Fix: infinite RLS recursion on the admin check.
--
-- The original is_concierge_admin() was SECURITY INVOKER, so the RLS policy
-- on concierge_admins invoked the function, which selected concierge_admins,
-- which re-triggered the policy — Postgres aborts with "infinite recursion
-- detected in policy", and every admin-gated query failed.
--
-- Fix: the helper becomes SECURITY DEFINER (bypasses RLS for its one lookup,
-- with a pinned empty search_path), and concierge_admins itself gets a simple
-- non-recursive read-own-row policy so the portal's gate query works.
-- Admin rows are managed via the service role / SQL editor only.

drop policy if exists "admin all" on public.concierge_admins;

create or replace function public.is_concierge_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists(
    select 1 from public.concierge_admins a
    where a.email = coalesce(auth.jwt()->>'email','')
  );
$$;

create policy "read own admin row" on public.concierge_admins
  for select to authenticated
  using (email = coalesce(auth.jwt()->>'email',''));

-- Note: the seeded demo order (Nº 14,214 for mberenji@gmail.com) is left in
-- place on purpose — it demonstrates signed-in order awareness. Remove with:
--   delete from public.orders where serial = 14214;
