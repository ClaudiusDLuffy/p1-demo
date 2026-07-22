-- Give every work-order activity a stable event kind and track whether the
-- corresponding update still needs to be mirrored in the 7-Eleven portal.

alter table public.activities
  add column if not exists event_key text not null default 'note',
  add column if not exists event_data jsonb not null default '{}'::jsonb,
  add column if not exists requires_7eleven_sync boolean not null default false,
  add column if not exists synced_to_7eleven_at timestamptz,
  add column if not exists synced_to_7eleven_by uuid
    references public.profiles(id);

update public.activities
set event_key = case
  when type = 'system' then 'system'
  when type = 'ai' then 'ai_note'
  else 'note'
end
where event_key is null
   or event_key = ''
   or (event_key = 'note' and type in ('system', 'ai'));

create index if not exists idx_activities_pending_7eleven_sync
  on public.activities(work_order_id, created_at desc)
  where requires_7eleven_sync = true
    and synced_to_7eleven_at is null
    and deleted_at is null;

-- Keep contractor updates and staff overrides fail-safe: the database, not
-- the browser, decides whether a workflow event becomes a pending 7-Eleven
-- update. Draft-only and internal events are deliberately excluded.
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
    'status_change', 'eta_updated', 'technician_updated',
    'part_added', 'part_updated', 'part_removed',
    'photo_added', 'photo_removed', 'invoice_submitted'
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

-- Only staff can acknowledge or reopen a 7-Eleven sync item. The actor is
-- stamped server-side so the acknowledgement remains auditable.
create or replace function public.protect_activity_7eleven_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.requires_7eleven_sync is distinct from old.requires_7eleven_sync
     or new.synced_to_7eleven_at is distinct from old.synced_to_7eleven_at
     or new.synced_to_7eleven_by is distinct from old.synced_to_7eleven_by then
    if auth.uid() is not null and not public.is_staff() then
      raise exception 'Only staff can update 7-Eleven sync status';
    end if;

    if not new.requires_7eleven_sync
       or new.synced_to_7eleven_at is null then
      new.synced_to_7eleven_by := null;
    else
      new.synced_to_7eleven_by := auth.uid();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_activity_7eleven_sync_trigger
  on public.activities;

create trigger protect_activity_7eleven_sync_trigger
  before update of requires_7eleven_sync, synced_to_7eleven_at, synced_to_7eleven_by
  on public.activities
  for each row execute function public.protect_activity_7eleven_sync();
