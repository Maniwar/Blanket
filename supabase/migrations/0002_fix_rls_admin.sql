-- Drop the policy that causes infinite recursion
drop policy if exists "admin all" on public.concierge_admins;

-- Recreate the function explicitly setting search_path for security
create or replace function public.is_concierge_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(
    select 1
    from public.concierge_admins a
    where a.email = coalesce(auth.jwt()->>'email', '')
  );
$$;

-- Create policies for concierge_admins without causing recursion
-- 1. Admins can read the table (using the function is safe now if the function bypasses RLS, but just to be 100% safe, we can use a simpler check)
-- Actually, if we just make the policy on concierge_admins simple:
create policy "allow read for admins" on public.concierge_admins
  for select to authenticated
  using (email = coalesce(auth.jwt()->>'email',''));

-- Note: The above means a user can only see THEIR OWN admin record.
-- That's usually enough for `is_concierge_admin()` to return true if they are an admin!
-- Wait, if they can only see their own record, `select 1 from concierge_admins` inside the function will still work for them!
-- Let's test this logic!

-- Retroactively remove the hardcoded order from existing databases
delete from public.orders where email = 'mberenji@gmail.com';
