-- A staff role is not sufficient authorization after the profile has been
-- deactivated. This helper sits underneath the portal's RLS policies, so
-- enforcing `active = true` here revokes an old authenticated session across
-- work orders, invoices, internal notes, storage, and staff-only audit data.

begin;

create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
  )
$$;

revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;

comment on function public.is_staff() is
  'True only for a signed-in, active P1 staff profile. Deactivated staff sessions must fail every RLS policy that depends on this helper.';

-- The original schema exposed the entire store directory to every signed-in
-- account. Contractors already receive the assigned store snapshot on their
-- work order; raw directory access must follow that same work-order boundary.
drop policy if exists stores_read on public.stores;
create policy stores_read on public.stores
  for select using (
    public.is_staff()
    or exists (
      select 1
      from public.work_orders work_order
      where work_order.store_number = stores.store_number
        and work_order.deleted_at is null
        and public.can_access_contractor_work_order(work_order.id)
    )
  );

revoke select on public.stores from anon;

commit;
