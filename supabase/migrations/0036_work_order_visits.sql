-- Store each check-in/check-out pair as a distinct visit. Staff can manage
-- visit history; contractors can only access visits while assigned to the
-- active parent work order.

create table if not exists public.work_order_visits (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  contractor_id uuid not null
    references public.profiles(id),
  check_in_at timestamptz not null default now(),
  check_out_at timestamptz,
  checked_in_by uuid not null
    references public.profiles(id),
  checked_out_by uuid
    references public.profiles(id),
  check_in_activity_id uuid
    references public.activities(id) on delete set null,
  check_out_activity_id uuid
    references public.activities(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_order_visits_checkout_complete
    check (
      (
        check_out_at is null
        and checked_out_by is null
        and check_out_activity_id is null
      )
      or (
        check_out_at is not null
        and checked_out_by is not null
        and check_out_at >= check_in_at
      )
    )
);

create unique index if not exists idx_work_order_visits_one_open
  on public.work_order_visits(work_order_id)
  where check_out_at is null;

create index if not exists idx_work_order_visits_work_order
  on public.work_order_visits(work_order_id, check_in_at desc);

create index if not exists idx_work_order_visits_contractor
  on public.work_order_visits(contractor_id, check_in_at desc);

create or replace function public.protect_work_order_visit()
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
  work_order_is_active boolean;
begin
  select
    w.contractor_id,
    w.deleted_at is null
  into
    assigned_contractor_id,
    work_order_is_active
  from public.work_orders w
  where w.id = new.work_order_id;

  if not found then
    raise exception 'Visit must reference an existing work order';
  end if;

  if new.check_in_activity_id is not null
     and not exists (
       select 1
       from public.activities a
       where a.id = new.check_in_activity_id
         and a.work_order_id = new.work_order_id
     ) then
    raise exception 'Check-in activity must belong to the same work order';
  end if;

  if new.check_out_activity_id is not null
     and not exists (
       select 1
       from public.activities a
       where a.id = new.check_out_activity_id
         and a.work_order_id = new.work_order_id
     ) then
    raise exception 'Check-out activity must belong to the same work order';
  end if;

  if tg_op = 'INSERT' then
    if not work_order_is_active then
      raise exception 'Cannot open a visit on an archived work order';
    end if;

    if assigned_contractor_id is null
       or new.contractor_id <> assigned_contractor_id then
      raise exception 'Visit contractor must match the assigned contractor';
    end if;

    if actor_role not in ('service_role', '') then
      new.checked_in_by := actor_id;

      if actor_is_staff and new.check_out_at is not null then
        new.checked_out_by := actor_id;
      end if;
    else
      new.checked_in_by := coalesce(new.checked_in_by, actor_id);
    end if;

    if new.checked_in_by is null then
      raise exception 'A check-in actor is required';
    end if;

    if actor_role not in ('service_role', '')
       and not actor_is_staff then
      if actor_id is null
         or actor_id <> assigned_contractor_id
         or new.contractor_id <> actor_id
         or new.checked_in_by <> actor_id then
        raise exception 'Only the assigned contractor can check in'
          using errcode = '42501';
      end if;

      if new.check_out_at is not null
         or new.checked_out_by is not null
         or new.check_out_activity_id is not null then
        raise exception 'Contractor check-in must create an open visit'
          using errcode = '42501';
      end if;
    end if;

    return new;
  end if;

  if new.work_order_id is distinct from old.work_order_id
     or new.contractor_id is distinct from old.contractor_id
     or new.check_in_at is distinct from old.check_in_at
     or new.checked_in_by is distinct from old.checked_in_by
     or new.check_in_activity_id is distinct from old.check_in_activity_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Visit check-in identity and timestamps are immutable';
  end if;

  if actor_role not in ('service_role', '')
     and actor_is_staff then
    if new.check_out_at is null then
      new.checked_out_by := null;
    elsif old.check_out_at is null then
      new.checked_out_by := actor_id;
    else
      new.checked_out_by := old.checked_out_by;
    end if;
  end if;

  if actor_role not in ('service_role', '')
     and not actor_is_staff then
    if not work_order_is_active
       or actor_id is null
       or actor_id <> assigned_contractor_id
       or old.contractor_id <> actor_id then
      raise exception 'Only the assigned contractor can close this visit'
        using errcode = '42501';
    end if;

    if old.check_out_at is not null then
      raise exception 'A contractor cannot change a closed visit'
        using errcode = '42501';
    end if;

    if new.check_out_at is null then
      raise exception 'Contractor visit updates must close the visit'
        using errcode = '42501';
    end if;

    new.checked_out_by := actor_id;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_work_order_visit_trigger
  on public.work_order_visits;

create trigger protect_work_order_visit_trigger
  before insert or update on public.work_order_visits
  for each row execute function public.protect_work_order_visit();

drop trigger if exists touch_work_order_visits
  on public.work_order_visits;

create trigger touch_work_order_visits
  before update on public.work_order_visits
  for each row execute function public.touch_updated_at();

alter table public.work_order_visits enable row level security;

drop policy if exists work_order_visits_read
  on public.work_order_visits;
create policy work_order_visits_read
  on public.work_order_visits
  for select using (
    public.is_staff()
    or (
      contractor_id = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
      )
    )
  );

drop policy if exists work_order_visits_insert
  on public.work_order_visits;
create policy work_order_visits_insert
  on public.work_order_visits
  for insert with check (
    public.is_staff()
    or (
      contractor_id = auth.uid()
      and checked_in_by = auth.uid()
      and check_out_at is null
      and checked_out_by is null
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
      )
    )
  );

drop policy if exists work_order_visits_update
  on public.work_order_visits;
create policy work_order_visits_update
  on public.work_order_visits
  for update using (
    public.is_staff()
    or (
      contractor_id = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
      )
    )
  )
  with check (
    public.is_staff()
    or (
      contractor_id = auth.uid()
      and checked_out_by = auth.uid()
      and exists (
        select 1
        from public.work_orders w
        where w.id = work_order_id
          and w.contractor_id = auth.uid()
          and w.deleted_at is null
      )
    )
  );

drop policy if exists work_order_visits_delete
  on public.work_order_visits;
create policy work_order_visits_delete
  on public.work_order_visits
  for delete using (public.is_staff());

revoke all on public.work_order_visits from anon;
grant select, insert, update, delete
  on public.work_order_visits to authenticated;
grant all on public.work_order_visits to service_role;
