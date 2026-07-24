-- Staff can flag an activity as requiring contractor attention. Only the
-- contractor currently assigned to the parent work order can acknowledge it.

alter table public.activities
  add column if not exists requires_contractor_attention boolean
    not null default false,
  add column if not exists contractor_attention_acknowledged_at timestamptz,
  add column if not exists contractor_attention_acknowledged_by uuid
    references public.profiles(id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'activities_contractor_attention_ack_complete'
      and conrelid = 'public.activities'::regclass
  ) then
    alter table public.activities
      add constraint activities_contractor_attention_ack_complete
      check (
        (
          contractor_attention_acknowledged_at is null
          and contractor_attention_acknowledged_by is null
        )
        or (
          requires_contractor_attention = true
          and contractor_attention_acknowledged_at is not null
          and contractor_attention_acknowledged_by is not null
        )
      );
  end if;
end
$$;

create index if not exists idx_activities_pending_contractor_attention
  on public.activities(work_order_id, created_at desc)
  where requires_contractor_attention = true
    and contractor_attention_acknowledged_at is null
    and deleted_at is null;

create or replace function public.protect_activity_contractor_attention()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  assigned_contractor_id uuid;
  flag_changed boolean;
  acknowledgement_changed boolean;
  work_order_changed boolean;
begin
  select contractor_id
  into assigned_contractor_id
  from public.work_orders
  where id = new.work_order_id
    and deleted_at is null;

  if tg_op = 'INSERT' then
    work_order_changed := false;
    flag_changed := new.requires_contractor_attention;
    acknowledgement_changed :=
      new.contractor_attention_acknowledged_at is not null
      or new.contractor_attention_acknowledged_by is not null;
  else
    work_order_changed :=
      new.work_order_id is distinct from old.work_order_id;
    flag_changed :=
      new.requires_contractor_attention
        is distinct from old.requires_contractor_attention
      or (work_order_changed and new.requires_contractor_attention);
    acknowledgement_changed :=
      new.contractor_attention_acknowledged_at
        is distinct from old.contractor_attention_acknowledged_at
      or new.contractor_attention_acknowledged_by
        is distinct from old.contractor_attention_acknowledged_by;
  end if;

  if flag_changed then
    if actor_role not in ('service_role', '')
       and not actor_is_staff then
      raise exception 'Only staff can change contractor attention flags'
        using errcode = '42501';
    end if;

    if new.requires_contractor_attention
       and assigned_contractor_id is null then
      raise exception 'Contractor attention requires an assigned contractor';
    end if;

    new.contractor_attention_acknowledged_at := null;
    new.contractor_attention_acknowledged_by := null;
  end if;

  if acknowledgement_changed and not flag_changed then
    if actor_role in ('service_role', '') then
      null;
    elsif new.contractor_attention_acknowledged_at is null
          and new.contractor_attention_acknowledged_by is null then
      if not actor_is_staff then
        raise exception 'Only staff can reopen contractor attention'
          using errcode = '42501';
      end if;
    else
      if actor_id is null
         or assigned_contractor_id is null
         or actor_id <> assigned_contractor_id then
        raise exception 'Only the assigned contractor can acknowledge attention'
          using errcode = '42501';
      end if;

      if not new.requires_contractor_attention then
        raise exception 'Activity does not require contractor attention';
      end if;

      new.contractor_attention_acknowledged_by := actor_id;
      new.contractor_attention_acknowledged_at := coalesce(
        new.contractor_attention_acknowledged_at,
        now()
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_activity_contractor_attention_trigger
  on public.activities;

create trigger protect_activity_contractor_attention_trigger
  before insert or update of
    work_order_id,
    requires_contractor_attention,
    contractor_attention_acknowledged_at,
    contractor_attention_acknowledged_by
  on public.activities
  for each row execute function public.protect_activity_contractor_attention();

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

  update public.activities a
  set
    requires_contractor_attention = p_required,
    contractor_attention_acknowledged_at = null,
    contractor_attention_acknowledged_by = null
  where a.id = p_activity_id
    and a.deleted_at is null
    and (
      not p_required
      or exists (
        select 1
        from public.work_orders w
        where w.id = a.work_order_id
          and w.contractor_id is not null
          and w.deleted_at is null
      )
    );

  if not found then
    raise exception 'Active activity with an assigned contractor not found';
  end if;
end;
$$;

create or replace function public.acknowledge_contractor_attention(
  p_activity_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  update public.activities a
  set
    contractor_attention_acknowledged_at = now(),
    contractor_attention_acknowledged_by = auth.uid()
  where a.id = p_activity_id
    and a.requires_contractor_attention = true
    and a.contractor_attention_acknowledged_at is null
    and a.deleted_at is null
    and exists (
      select 1
      from public.work_orders w
      where w.id = a.work_order_id
        and w.contractor_id = auth.uid()
        and w.deleted_at is null
    );

  if not found then
    raise exception 'Pending contractor attention item not found'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.set_activity_contractor_attention(uuid, boolean)
  from public;
revoke all on function public.acknowledge_contractor_attention(uuid)
  from public;

grant execute
  on function public.set_activity_contractor_attention(uuid, boolean)
  to authenticated;
grant execute
  on function public.acknowledge_contractor_attention(uuid)
  to authenticated;

grant execute
  on function public.set_activity_contractor_attention(uuid, boolean)
  to service_role;
grant execute
  on function public.acknowledge_contractor_attention(uuid)
  to service_role;
