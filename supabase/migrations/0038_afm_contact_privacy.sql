-- Contractors may see the AFM name on an assigned work order, but AFM
-- contact details are staff-only. Move the email snapshot out of the
-- contractor-readable work_orders row and lock down the AFM directory.

create table if not exists public.work_order_afm_contacts (
  work_order_id text primary key
    references public.work_orders(id) on delete cascade,
  afm_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.work_order_afm_contacts (work_order_id, afm_email)
select id, nullif(trim(afm_email), '')
from public.work_orders
where nullif(trim(afm_email), '') is not null
on conflict (work_order_id) do update
set afm_email = excluded.afm_email,
    updated_at = now();

update public.work_orders
set afm_email = null
where afm_email is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'work_orders_afm_email_must_be_empty'
      and conrelid = 'public.work_orders'::regclass
  ) then
    alter table public.work_orders
      add constraint work_orders_afm_email_must_be_empty
      check (afm_email is null);
  end if;
end
$$;

drop trigger if exists touch_work_order_afm_contacts
  on public.work_order_afm_contacts;
create trigger touch_work_order_afm_contacts
  before update on public.work_order_afm_contacts
  for each row execute function public.touch_updated_at();

alter table public.work_order_afm_contacts enable row level security;

drop policy if exists work_order_afm_contacts_read
  on public.work_order_afm_contacts;
create policy work_order_afm_contacts_read
  on public.work_order_afm_contacts
  for select using (public.is_staff());

drop policy if exists work_order_afm_contacts_insert
  on public.work_order_afm_contacts;
create policy work_order_afm_contacts_insert
  on public.work_order_afm_contacts
  for insert with check (public.is_staff());

drop policy if exists work_order_afm_contacts_update
  on public.work_order_afm_contacts;
create policy work_order_afm_contacts_update
  on public.work_order_afm_contacts
  for update using (public.is_staff())
  with check (public.is_staff());

drop policy if exists work_order_afm_contacts_delete
  on public.work_order_afm_contacts;
create policy work_order_afm_contacts_delete
  on public.work_order_afm_contacts
  for delete using (public.is_staff());

revoke all on public.work_order_afm_contacts from anon;
grant select, insert, update, delete
  on public.work_order_afm_contacts to authenticated;
grant all on public.work_order_afm_contacts to service_role;

-- The AFM directory contains email, phone, region, and notes, so contractors
-- must not be able to query it directly.
drop policy if exists afms_read on public.afms;
create policy afms_read on public.afms
  for select using (public.is_staff());
