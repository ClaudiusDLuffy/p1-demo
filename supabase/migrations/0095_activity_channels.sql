-- Separate technician field notes, P1-only conversation, contractor chat,
-- and machine-generated audit events. Only field notes participate in the
-- manual 7-Eleven update queue.

begin;

alter table public.activities
  add column if not exists activity_channel text not null default 'legacy';

comment on column public.activities.activity_channel is
  'Semantic activity stream: field_note, internal_note, contractor_message, system_event, or legacy.';

-- Backfill conservatively. Do not turn an old, ambiguous note into a new
-- 7-Eleven task. Existing pending/synchronized human field notes retain their
-- field classification; noisy workflow/photo events move to System.
update public.activities
set activity_channel = case
  when type = 'system'
    or event_key not in ('note', 'ai_note', 'job_completed')
    then 'system_event'
  when is_staff_only then 'internal_note'
  when requires_contractor_attention then 'contractor_message'
  when event_key in ('note', 'ai_note', 'job_completed')
    and requires_7eleven_sync
    then 'field_note'
  when event_key in ('note', 'ai_note')
    and entered_by_role in ('manager', 'dispatcher', 'back_office')
    then 'internal_note'
  else 'legacy'
end
where activity_channel = 'legacy';

-- Normalize the historic queue without discarding completed synchronization
-- timestamps. A non-field event can retain its old audit timestamp, but it can
-- no longer be pending or re-opened as a 7-Eleven task.
drop trigger if exists protect_activity_7eleven_sync_trigger
  on public.activities;

-- Historic staff-entered notes predate activity channels, so many of them
-- were not marked staff-only. Some private rows also retained an obsolete
-- contractor-attention flag. Normalize the complete internal-note invariant
-- before validating it; privacy wins over the legacy attention flag.
update public.activities
set
  is_staff_only = true,
  requires_contractor_attention = false,
  contractor_attention_acknowledged_at = null,
  contractor_attention_acknowledged_by = null,
  requires_7eleven_sync = false
where activity_channel = 'internal_note'
  and (
    is_staff_only is distinct from true
    or requires_contractor_attention is distinct from false
    or contractor_attention_acknowledged_at is not null
    or contractor_attention_acknowledged_by is not null
    or requires_7eleven_sync is distinct from false
  );

update public.activities
set requires_7eleven_sync = (activity_channel = 'field_note')
where requires_7eleven_sync
  is distinct from (activity_channel = 'field_note');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'activities_channel_check'
      and conrelid = 'public.activities'::regclass
  ) then
    alter table public.activities
      add constraint activities_channel_check
      check (activity_channel in (
        'field_note', 'internal_note', 'contractor_message',
        'system_event', 'legacy'
      ));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'activities_channel_sync_check'
      and conrelid = 'public.activities'::regclass
  ) then
    alter table public.activities
      add constraint activities_channel_sync_check
      check (
        requires_7eleven_sync = (activity_channel = 'field_note')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'activities_internal_channel_check'
      and conrelid = 'public.activities'::regclass
  ) then
    alter table public.activities
      add constraint activities_internal_channel_check
      check (
        activity_channel <> 'internal_note'
        or (
          is_staff_only = true
          and requires_contractor_attention = false
        )
      );
  end if;
end
$$;

create index if not exists idx_activities_channel_timeline
  on public.activities(work_order_id, activity_channel, created_at desc, id desc)
  where deleted_at is null;

create index if not exists idx_activities_pending_field_notes
  on public.activities(work_order_id, created_at desc, id desc)
  where activity_channel = 'field_note'
    and requires_7eleven_sync = true
    and synced_to_7eleven_at is null
    and deleted_at is null;

create or replace function public.stamp_activity_actor_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text;
  assigned_contractor uuid;
  requested_channel text;
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

  requested_channel := lower(coalesce(
    nullif(trim(new.activity_channel), ''),
    'legacy'
  ));

  if requested_channel not in (
    'field_note', 'internal_note', 'contractor_message',
    'system_event', 'legacy'
  ) then
    raise exception 'Invalid activity channel'
      using errcode = '22023';
  end if;

  -- Omitted channels arrive as legacy. Infer safe defaults for every existing
  -- workflow RPC so callers do not need a coordinated cut-over.
  if requested_channel = 'legacy' then
    if new.type = 'system'
       or new.event_key not in ('note', 'ai_note', 'job_completed') then
      requested_channel := 'system_event';
    elsif new.event_key = 'job_completed'
          and (
            new.entered_by_role = 'contractor'
            or new.is_staff_override
          ) then
      requested_channel := 'field_note';
    elsif new.event_key in ('note', 'ai_note')
          and new.entered_by_role in ('manager', 'dispatcher', 'back_office') then
      requested_channel := 'internal_note';
    elsif new.event_key in ('note', 'ai_note')
          and new.entered_by_role = 'contractor' then
      requested_channel := 'field_note';
    end if;
  end if;

  if requested_channel = 'internal_note'
     and new.entered_by_role not in ('manager', 'dispatcher', 'back_office') then
    raise exception 'Only staff can create internal notes'
      using errcode = '42501';
  end if;

  if requested_channel in ('field_note', 'contractor_message')
     and new.entered_by_role not in (
       'manager', 'dispatcher', 'back_office', 'contractor'
     ) then
    raise exception 'A signed-in portal user is required for this activity channel'
      using errcode = '42501';
  end if;

  if requested_channel = 'system_event'
     and new.entered_by_role = 'contractor'
     and new.type <> 'system'
     and new.event_key in ('note', 'ai_note') then
    raise exception 'Contractors cannot classify a user note as a system event'
      using errcode = '42501';
  end if;

  new.activity_channel := requested_channel;

  if requested_channel = 'internal_note' then
    new.is_staff_only := true;
    new.requires_contractor_attention := false;
    new.contractor_attention_acknowledged_at := null;
    new.contractor_attention_acknowledged_by := null;
  elsif requested_channel in ('field_note', 'contractor_message') then
    new.is_staff_only := false;
  end if;

  new.requires_7eleven_sync := requested_channel = 'field_note';
  if not new.requires_7eleven_sync then
    new.synced_to_7eleven_at := null;
    new.synced_to_7eleven_by := null;
  end if;

  return new;
end;
$$;

-- Keep the semantic channel and its privacy/sync invariants immutable to
-- contractors. Staff may reclassify a legacy row, with all dependent flags
-- normalized in the same write.
create or replace function public.enforce_activity_channel_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.activity_channel is distinct from old.activity_channel
     and auth.role() not in ('service_role', '')
     and not public.is_staff() then
    raise exception 'Only staff can reclassify activity'
      using errcode = '42501';
  end if;

  if new.activity_channel = 'internal_note' then
    if auth.role() not in ('service_role', '')
       and not public.is_staff() then
      raise exception 'Only staff can create internal notes'
        using errcode = '42501';
    end if;
    new.is_staff_only := true;
    new.requires_contractor_attention := false;
    new.contractor_attention_acknowledged_at := null;
    new.contractor_attention_acknowledged_by := null;
  elsif new.activity_channel in ('field_note', 'contractor_message') then
    new.is_staff_only := false;
  end if;

  new.requires_7eleven_sync := new.activity_channel = 'field_note';
  return new;
end;
$$;

drop trigger if exists enforce_activity_channel_update_trigger
  on public.activities;

create trigger enforce_activity_channel_update_trigger
  before update of
    activity_channel,
    is_staff_only,
    requires_7eleven_sync,
    requires_contractor_attention
  on public.activities
  for each row execute function public.enforce_activity_channel_update();

create or replace function public.protect_activity_7eleven_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.requires_7eleven_sync is distinct from old.requires_7eleven_sync
     or new.synced_to_7eleven_at is distinct from old.synced_to_7eleven_at
     or new.synced_to_7eleven_by is distinct from old.synced_to_7eleven_by then
    if auth.uid() is not null and not public.is_staff() then
      raise exception 'Only staff can update 7-Eleven sync status'
        using errcode = '42501';
    end if;

    if new.requires_7eleven_sync
       and new.activity_channel <> 'field_note' then
      raise exception 'Only field notes can require a 7-Eleven update'
        using errcode = '23514';
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

create trigger protect_activity_7eleven_sync_trigger
  before update of
    requires_7eleven_sync,
    synced_to_7eleven_at,
    synced_to_7eleven_by
  on public.activities
  for each row execute function public.protect_activity_7eleven_sync();

create or replace function public.set_activity_contractor_attention(
  p_activity_id uuid,
  p_required boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Staff access required'
      using errcode = '42501';
  end if;

  update public.activities activity
  set
    requires_contractor_attention = p_required,
    contractor_attention_acknowledged_at = null,
    contractor_attention_acknowledged_by = null
  where activity.id = p_activity_id
    and activity.deleted_at is null
    and activity.activity_channel in (
      'field_note', 'contractor_message', 'legacy'
    )
    and (
      not p_required
      or exists (
        select 1
        from public.work_orders work_order
        where work_order.id = activity.work_order_id
          and work_order.contractor_id is not null
          and work_order.deleted_at is null
      )
    );

  if not found then
    raise exception 'Contractor-visible activity with an assigned contractor not found';
  end if;
end;
$$;

revoke all on function public.set_activity_contractor_attention(uuid, boolean)
  from public, anon;
grant execute on function public.set_activity_contractor_attention(uuid, boolean)
  to authenticated, service_role;

commit;
