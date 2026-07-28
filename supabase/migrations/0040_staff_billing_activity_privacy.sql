-- P1-to-client billing is internal. Contractors can continue to see their
-- operational and contractor-invoice activity, but not P1 billing events.

alter table public.activities
  add column if not exists is_staff_only boolean not null default false;

update public.activities
set
  is_staff_only = true,
  event_key = 'staff_billing'
where event_key = 'staff_billing'
   or text ~* '^P1 invoice #[^ ]+ (created|updated|draft updated)'
   or text = '7-Eleven portal updated. Moved to pending invoice.';

create index if not exists idx_activities_staff_only
  on public.activities(work_order_id, created_at desc)
  where is_staff_only = true and deleted_at is null;

create or replace function public.protect_activity_staff_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() not in ('service_role', '')
     and (
       (tg_op = 'INSERT' and new.is_staff_only)
       or (
         tg_op = 'UPDATE'
         and new.is_staff_only is distinct from old.is_staff_only
       )
     )
     and not public.is_staff() then
    raise exception 'Only staff can create or change staff-only activity'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_activity_staff_only_trigger
  on public.activities;

create trigger protect_activity_staff_only_trigger
  before insert or update of is_staff_only
  on public.activities
  for each row execute function public.protect_activity_staff_only();

drop policy if exists act_read on public.activities;
create policy act_read on public.activities
  for select using (
    public.is_staff()
    or (
      is_staff_only = false
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
      )
    )
  );

-- Remove the obsolete workflow bucket while retaining the enum value for
-- compatibility with historical rows and older clients.
update public.work_orders
set
  status = 'pending_invoice',
  updated_at = now()
where status = 'pending_payment';
