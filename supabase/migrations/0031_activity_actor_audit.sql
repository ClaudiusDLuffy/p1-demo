-- Record who entered each activity and whether staff performed a contractor
-- workflow step as an override. The trigger derives actor role from profiles
-- so client input cannot impersonate a staff action.

alter table public.activities
  add column if not exists entered_by_role text not null default 'system',
  add column if not exists is_staff_override boolean not null default false,
  add column if not exists override_for_contractor_id uuid
    references public.profiles(id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'activities_entered_by_role_check'
      and conrelid = 'public.activities'::regclass
  ) then
    alter table public.activities
      add constraint activities_entered_by_role_check
      check (entered_by_role in (
        'manager', 'dispatcher', 'back_office', 'contractor', 'system'
      ));
  end if;
end $$;

update public.activities a
set entered_by_role = coalesce(p.role::text, 'system')
from public.profiles p
where a.author_id = p.id;

create index if not exists idx_activities_staff_override
  on public.activities(work_order_id, created_at desc)
  where is_staff_override = true and deleted_at is null;

create or replace function public.stamp_activity_actor_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  assigned_contractor uuid;
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

  return new;
end;
$$;

drop trigger if exists stamp_activity_actor_audit_trigger
  on public.activities;

create trigger stamp_activity_actor_audit_trigger
  before insert on public.activities
  for each row execute function public.stamp_activity_actor_audit();

drop policy if exists act_insert on public.activities;
create policy act_insert on public.activities
  for insert with check (
    exists (
      select 1
      from public.work_orders w
      where w.id = work_order_id
        and (
          public.is_staff()
          or w.contractor_id = auth.uid()
        )
    )
    and author_id = auth.uid()
    and (
      (
        public.is_staff()
        and entered_by_role in ('manager', 'dispatcher', 'back_office')
      )
      or (
        entered_by_role = 'contractor'
        and is_staff_override = false
        and override_for_contractor_id is null
      )
    )
  );

drop policy if exists act_update on public.activities;
create policy act_update on public.activities
  for update using (
    author_id = auth.uid() or public.is_staff()
  )
  with check (
    public.is_staff()
    or (
      author_id = auth.uid()
      and entered_by_role = 'contractor'
      and is_staff_override = false
      and override_for_contractor_id is null
    )
  );
