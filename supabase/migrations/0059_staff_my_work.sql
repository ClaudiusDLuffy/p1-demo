-- One staff work surface combines personal follow-up, per-login unread state,
-- and the existing Ready to Bill queue. Ready to Bill remains canonical on
-- work_orders; these tables only add personal ownership and read position.

begin;

create table if not exists public.staff_work_order_todos (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  owner_id uuid not null
    references public.profiles(id),
  created_by uuid not null
    references public.profiles(id),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  completed_reason text,
  constraint staff_work_order_todo_completion check (
    (completed_at is null and completed_by is null and completed_reason is null)
    or completed_at is not null
  )
);

create unique index if not exists staff_work_order_todos_one_active_owner
  on public.staff_work_order_todos(work_order_id)
  where completed_at is null;

create index if not exists staff_work_order_todos_owner_active
  on public.staff_work_order_todos(owner_id, created_at desc)
  where completed_at is null;

create table if not exists public.staff_work_order_notification_reads (
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  read_through_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, work_order_id)
);

create index if not exists staff_notification_reads_work_order
  on public.staff_work_order_notification_reads(work_order_id);

-- Start the personal inbox at the deployment boundary. Existing contractor
-- activity remains available in the timeline but does not flood every staff
-- login as newly unread when this feature is first enabled.
insert into public.staff_work_order_notification_reads (
  user_id,
  work_order_id,
  read_through_at
)
select
  staff.id,
  contractor_activity.work_order_id,
  contractor_activity.latest_at
from public.profiles staff
cross join (
  select activity.work_order_id, max(activity.created_at) as latest_at
  from public.activities activity
  where activity.entered_by_role = 'contractor'
    and activity.deleted_at is null
  group by activity.work_order_id
) contractor_activity
where staff.active = true
  and staff.role in ('manager', 'dispatcher', 'back_office')
on conflict (user_id, work_order_id) do nothing;

alter table public.staff_work_order_todos enable row level security;
alter table public.staff_work_order_notification_reads enable row level security;

drop policy if exists staff_work_order_todos_read
  on public.staff_work_order_todos;
create policy staff_work_order_todos_read
  on public.staff_work_order_todos
  for select using (public.is_staff());

drop policy if exists staff_notification_reads_own
  on public.staff_work_order_notification_reads;
create policy staff_notification_reads_own
  on public.staff_work_order_notification_reads
  for select using (
    public.is_staff()
    and user_id = auth.uid()
  );

revoke all on public.staff_work_order_todos from anon, authenticated;
revoke all on public.staff_work_order_notification_reads from anon, authenticated;
grant select on public.staff_work_order_todos to authenticated;
grant select on public.staff_work_order_notification_reads to authenticated;
grant all on public.staff_work_order_todos to service_role;
grant all on public.staff_work_order_notification_reads to service_role;

create or replace function public.assert_active_staff_profile(
  p_profile_id uuid
)
returns void
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_profile_id
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'The selected to-do owner is not an active staff account'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function public.add_work_order_to_my_todos(
  p_work_order_id text,
  p_note text default null
)
returns public.staff_work_order_todos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  existing_todo public.staff_work_order_todos%rowtype;
  result_todo public.staff_work_order_todos%rowtype;
begin
  if actor_id is null or not public.is_staff() then
    raise exception 'Staff access required'
      using errcode = '42501';
  end if;

  perform public.assert_active_staff_profile(actor_id);
  perform pg_advisory_xact_lock(hashtextextended('staff-work-order-todos', 0));

  if not exists (
    select 1
    from public.work_orders work_order
    where work_order.id = p_work_order_id
      and work_order.deleted_at is null
      and work_order.status <> 'closed'
  ) then
    raise exception 'Only an open work order can be added to My Work'
      using errcode = '22023';
  end if;

  select *
  into existing_todo
  from public.staff_work_order_todos todo
  where todo.work_order_id = p_work_order_id
    and todo.completed_at is null
  for update;

  if found then
    if existing_todo.owner_id = actor_id then
      return existing_todo;
    end if;

    raise exception 'This work order is already on another staff member''s to-do list'
      using errcode = '23505';
  end if;

  if (
    select count(*)
    from public.staff_work_order_todos todo
    where todo.owner_id = actor_id
      and todo.completed_at is null
  ) >= 5 then
    raise exception 'Your to-do list already contains the maximum of five work orders'
      using errcode = '23514';
  end if;

  insert into public.staff_work_order_todos (
    work_order_id,
    owner_id,
    created_by,
    note
  ) values (
    p_work_order_id,
    actor_id,
    actor_id,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning * into result_todo;

  return result_todo;
end;
$$;

create or replace function public.complete_my_work_order_todo(
  p_work_order_id text
)
returns public.staff_work_order_todos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  result_todo public.staff_work_order_todos%rowtype;
begin
  if actor_id is null or not public.is_staff() then
    raise exception 'Staff access required'
      using errcode = '42501';
  end if;

  update public.staff_work_order_todos todo
  set completed_at = now(),
      completed_by = actor_id,
      completed_reason = 'completed_by_owner',
      updated_at = now()
  where todo.work_order_id = p_work_order_id
    and todo.owner_id = actor_id
    and todo.completed_at is null
  returning * into result_todo;

  if not found then
    raise exception 'This work order is not on your active to-do list'
      using errcode = 'P0002';
  end if;

  return result_todo;
end;
$$;

create or replace function public.transfer_work_order_todo(
  p_work_order_id text,
  p_new_owner_id uuid
)
returns public.staff_work_order_todos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  result_todo public.staff_work_order_todos%rowtype;
begin
  if actor_id is null or not public.is_staff() then
    raise exception 'Staff access required'
      using errcode = '42501';
  end if;

  perform public.assert_active_staff_profile(p_new_owner_id);
  perform pg_advisory_xact_lock(hashtextextended('staff-work-order-todos', 0));

  if (
    select count(*)
    from public.staff_work_order_todos todo
    where todo.owner_id = p_new_owner_id
      and todo.completed_at is null
      and todo.work_order_id <> p_work_order_id
  ) >= 5 then
    raise exception 'The selected staff member already has five work orders'
      using errcode = '23514';
  end if;

  update public.staff_work_order_todos todo
  set owner_id = p_new_owner_id,
      updated_at = now()
  where todo.work_order_id = p_work_order_id
    and todo.completed_at is null
  returning * into result_todo;

  if not found then
    raise exception 'No active to-do exists for this work order'
      using errcode = 'P0002';
  end if;

  return result_todo;
end;
$$;

create or replace function public.mark_staff_work_order_read(
  p_work_order_id text,
  p_read_through_at timestamptz
)
returns public.staff_work_order_notification_reads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  result_read public.staff_work_order_notification_reads%rowtype;
begin
  if actor_id is null or not public.is_staff() then
    raise exception 'Staff access required'
      using errcode = '42501';
  end if;

  if p_read_through_at is null then
    raise exception 'A read timestamp is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.work_orders where id = p_work_order_id
  ) then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  insert into public.staff_work_order_notification_reads (
    user_id,
    work_order_id,
    read_through_at
  ) values (
    actor_id,
    p_work_order_id,
    p_read_through_at
  )
  on conflict (user_id, work_order_id) do update
  set read_through_at = greatest(
        staff_work_order_notification_reads.read_through_at,
        excluded.read_through_at
      ),
      updated_at = now()
  returning * into result_read;

  return result_read;
end;
$$;

create or replace function public.close_staff_todos_with_work_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null
     or new.status = 'closed' then
    update public.staff_work_order_todos todo
    set completed_at = coalesce(todo.completed_at, now()),
        completed_reason = coalesce(
          todo.completed_reason,
          case when new.deleted_at is not null
            then 'work_order_deleted'
            else 'work_order_closed'
          end
        ),
        updated_at = now()
    where todo.work_order_id = new.id
      and todo.completed_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists close_staff_todos_with_work_order_trigger
  on public.work_orders;
create trigger close_staff_todos_with_work_order_trigger
  after update of status, deleted_at on public.work_orders
  for each row execute function public.close_staff_todos_with_work_order();

revoke all on function public.assert_active_staff_profile(uuid)
  from public, anon, authenticated;
revoke all on function public.add_work_order_to_my_todos(text, text)
  from public, anon;
revoke all on function public.complete_my_work_order_todo(text)
  from public, anon;
revoke all on function public.transfer_work_order_todo(text, uuid)
  from public, anon;
revoke all on function public.mark_staff_work_order_read(text, timestamptz)
  from public, anon;

grant execute on function public.add_work_order_to_my_todos(text, text),
  public.complete_my_work_order_todo(text),
  public.transfer_work_order_todo(text, uuid),
  public.mark_staff_work_order_read(text, timestamptz)
  to authenticated, service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.staff_work_order_todos;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime
      add table public.staff_work_order_notification_reads;
  exception when duplicate_object then null;
  end;
end
$$;

commit;
