-- Fix infinite recursion in profiles_read policy
-- The previous policy (0017) queried profiles from within
-- a profiles policy causing infinite recursion.
-- Solution: use a security definer function to break the loop.

-- Drop the recursive policy from 0017
drop policy if exists profiles_read on public.profiles;

-- Create a security definer function that bypasses RLS
-- to safely read the current user's role without recursion
create or replace function public.get_my_role()
returns text
language sql
security definer
stable
as $$
  select role::text from public.profiles where id = auth.uid()
$$;

-- Recreate the policy using the function
-- get_my_role() runs with definer privileges so it
-- does not trigger the RLS policy again
create policy profiles_read on public.profiles
  for select using (
    auth.uid() = id
    or public.get_my_role() in ('manager', 'dispatcher', 'back_office')
    or role = 'contractor'
  );
