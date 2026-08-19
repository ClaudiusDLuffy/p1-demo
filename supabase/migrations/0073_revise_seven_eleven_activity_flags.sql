-- Only contractor activity that requires a manual 7-Eleven portal update
-- should raise the shared dashboard flag. Invoice submission and ETA changes
-- already have dedicated workflow states and do not require a second flag.

begin;

create or replace function public.stamp_activity_actor_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  assigned_contractor uuid;
  syncable_event boolean;
begin
  if new.author_id is null and auth.uid() is not null then
    new.author_id := auth.uid();
  end if;

  if new.author_id is not null then
    select role::text into actor_role
    from public.profiles
    where id = new.author_id;
  end if;

  new.entered_by_role := coalesce(actor_role, 'system');

  if new.entered_by_role = 'contractor' then
    new.is_staff_override := false;
    new.override_for_contractor_id := null;
  elsif new.entered_by_role in ('manager', 'dispatcher', 'back_office')
        and new.is_staff_override then
    select contractor_id into assigned_contractor
    from public.work_orders
    where id = new.work_order_id;

    new.override_for_contractor_id := coalesce(
      new.override_for_contractor_id,
      assigned_contractor
    );
  else
    new.is_staff_override := false;
    new.override_for_contractor_id := null;
  end if;

  syncable_event := new.event_key in (
    'note', 'check_in', 'check_out', 'job_paused', 'job_completed',
    'status_change', 'technician_updated',
    'part_added', 'part_updated', 'part_removed',
    'photo_added', 'photo_removed'
  );

  if new.entered_by_role = 'contractor'
     or new.is_staff_override then
    new.requires_7eleven_sync := syncable_event;
  elsif new.entered_by_role not in ('manager', 'dispatcher', 'back_office') then
    new.requires_7eleven_sync := false;
  end if;

  if not new.requires_7eleven_sync then
    new.synced_to_7eleven_at := null;
    new.synced_to_7eleven_by := null;
  end if;

  return new;
end;
$$;

-- Clear only outstanding flags. Previously completed 7-Eleven audit history
-- remains intact, while the live dashboard count drops immediately.
update public.activities
set requires_7eleven_sync = false,
    synced_to_7eleven_at = null,
    synced_to_7eleven_by = null
where event_key in ('eta_updated', 'invoice_submitted', 'invoice_resubmitted')
  and requires_7eleven_sync = true
  and synced_to_7eleven_at is null;

commit;
