-- Assignment history can identify both outgoing and incoming contractors.
-- Keep that audit trail for staff while preventing contractor visibility.

begin;

create or replace function public.protect_activity_staff_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assignment_event_key text;
begin
  assignment_event_key := case
    when new.event_key = 'work_order_reassigned'
      or coalesce(new.text ~* '^Reassigned from .+ to .+ by .+\.$', false)
      then 'work_order_reassigned'
    when new.event_key = 'work_order_unassigned'
      or coalesce(new.text ~* '^Work order unassigned by .+\.$', false)
      then 'work_order_unassigned'
    when new.event_key = 'work_order_assignment'
      or coalesce(new.text ~* '^(Dispatched|Assigned) to .+\.$', false)
      then 'work_order_assignment'
    else null
  end;

  if assignment_event_key is not null then
    if auth.role() not in ('service_role', '')
       and not public.is_staff() then
      raise exception 'Only staff can create assignment activity'
        using errcode = '42501';
    end if;

    new.event_key := assignment_event_key;
    new.is_staff_only := true;
  end if;

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
  before insert or update of is_staff_only, event_key, text
  on public.activities
  for each row execute function public.protect_activity_staff_only();

update public.activities
set
  event_key = case
    when event_key = 'work_order_reassigned'
      or text ~* '^Reassigned from .+ to .+ by .+\.$'
      then 'work_order_reassigned'
    when event_key = 'work_order_unassigned'
      or text ~* '^Work order unassigned by .+\.$'
      then 'work_order_unassigned'
    else 'work_order_assignment'
  end,
  is_staff_only = true
where event_key = 'work_order_reassigned'
   or event_key = 'work_order_assignment'
   or event_key = 'work_order_unassigned'
   or text ~* '^Reassigned from .+ to .+ by .+\.$'
   or text ~* '^Work order unassigned by .+\.$'
   or text ~* '^(Dispatched|Assigned) to .+\.$';

commit;
