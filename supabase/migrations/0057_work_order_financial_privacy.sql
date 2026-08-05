-- RLS controls rows, not individual columns. Move the real 7-Eleven NTE and
-- internal NTE-review fields behind a staff-only table so a contractor cannot
-- recover them from a raw work_orders REST request. work_orders retains masked
-- compatibility values for contractor clients.

begin;

create table if not exists public.work_order_financials (
  work_order_id text primary key
    references public.work_orders(id) on delete cascade,
  nte numeric(10,2) not null default 0,
  nte_flag_threshold numeric(10,2),
  nte_flagged boolean not null default false,
  nte_flag_amount numeric(10,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.work_order_financials (
  work_order_id,
  nte,
  nte_flag_threshold,
  nte_flagged,
  nte_flag_amount
)
select
  work_order.id,
  coalesce(work_order.nte, 0),
  work_order.nte_flag_threshold,
  coalesce(work_order.nte_flagged, false),
  work_order.nte_flag_amount
from public.work_orders work_order
on conflict (work_order_id) do nothing;

-- The compatibility columns no longer contain private P1 values.
update public.work_orders
set
  nte = 1000,
  nte_flag_threshold = null,
  nte_flagged = false,
  nte_flag_amount = null;

comment on table public.work_order_financials is
  'Staff-only work-order financial values. Contractors receive masked compatibility values from work_orders.';
comment on column public.work_orders.nte is
  'Contractor-safe compatibility value only. The real 7-Eleven NTE is stored in work_order_financials.';

drop trigger if exists touch_work_order_financials
  on public.work_order_financials;
create trigger touch_work_order_financials
  before update on public.work_order_financials
  for each row execute function public.touch_updated_at();

alter table public.work_order_financials enable row level security;

drop policy if exists work_order_financials_staff_read
  on public.work_order_financials;
create policy work_order_financials_staff_read
  on public.work_order_financials
  for select using (public.is_staff());

drop policy if exists work_order_financials_staff_write
  on public.work_order_financials;
create policy work_order_financials_staff_write
  on public.work_order_financials
  for all using (public.is_staff())
  with check (public.is_staff());

revoke all on public.work_order_financials from anon;
grant select, insert, update, delete
  on public.work_order_financials to authenticated;
grant all on public.work_order_financials to service_role;

-- Migration 0052 archives and clears contractor workflow fields on every
-- reassignment. Preserve the real, now-private NTE flag values in that same
-- staff-only archive and reset them for the receiving contractor.
create or replace function public.archive_assignment_financials()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  financial public.work_order_financials%rowtype;
begin
  if new.contractor_id is not distinct from old.contractor_id
     or old.contractor_id is null then
    return new;
  end if;

  select candidate.*
  into financial
  from public.work_order_financials candidate
  where candidate.work_order_id = old.id;

  if found then
    update public.work_order_assignment_history history
    set workflow_snapshot = history.workflow_snapshot || jsonb_build_object(
      'nteFlagged', financial.nte_flagged,
      'nteFlagAmount', financial.nte_flag_amount
    )
    where history.id = (
      select archived.id
      from public.work_order_assignment_history archived
      where archived.work_order_id = old.id
        and archived.assignment_version = old.contractor_assignment_version
      order by archived.assignment_ended_at desc
      limit 1
    );

    update public.work_order_financials
    set nte_flagged = false,
        nte_flag_amount = null,
        updated_at = now()
    where work_order_id = old.id;
  end if;

  return new;
end;
$$;

drop trigger if exists archive_assignment_financials_trigger
  on public.work_orders;
create trigger archive_assignment_financials_trigger
  after update of contractor_id on public.work_orders
  for each row execute function public.archive_assignment_financials();

create or replace function public.capture_work_order_financials()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
begin
  -- Ignore the masking UPDATE issued by this trigger itself.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and actor_role not in ('service_role', '')
     and not actor_is_staff then
    raise exception 'Only P1 staff may change work-order financial fields'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    insert into public.work_order_financials (
      work_order_id,
      nte,
      nte_flag_threshold,
      nte_flagged,
      nte_flag_amount
    ) values (
      new.id,
      coalesce(new.nte, 0),
      new.nte_flag_threshold,
      coalesce(new.nte_flagged, false),
      new.nte_flag_amount
    )
    on conflict (work_order_id) do update
    set
      nte = excluded.nte,
      nte_flag_threshold = excluded.nte_flag_threshold,
      nte_flagged = excluded.nte_flagged,
      nte_flag_amount = excluded.nte_flag_amount,
      updated_at = now();
  elsif tg_argv[0] = 'nte' then
    update public.work_order_financials
    set nte = coalesce(new.nte, 0),
        updated_at = now()
    where work_order_id = new.id;
  elsif tg_argv[0] = 'nte_flag_threshold' then
    update public.work_order_financials
    set nte_flag_threshold = new.nte_flag_threshold,
        updated_at = now()
    where work_order_id = new.id;
  elsif tg_argv[0] = 'nte_flagged' then
    update public.work_order_financials
    set nte_flagged = coalesce(new.nte_flagged, false),
        updated_at = now()
    where work_order_id = new.id;
  elsif tg_argv[0] = 'nte_flag_amount' then
    update public.work_order_financials
    set nte_flag_amount = new.nte_flag_amount,
        updated_at = now()
    where work_order_id = new.id;
  end if;

  update public.work_orders
  set
    nte = 1000,
    nte_flag_threshold = null,
    nte_flagged = false,
    nte_flag_amount = null
  where id = new.id
    and (
      nte is distinct from 1000::numeric
      or nte_flag_threshold is not null
      or nte_flagged is distinct from false
      or nte_flag_amount is not null
    );

  return new;
end;
$$;

drop trigger if exists capture_work_order_financials_trigger
  on public.work_orders;
drop trigger if exists capture_work_order_nte_trigger
  on public.work_orders;
drop trigger if exists capture_work_order_nte_flag_threshold_trigger
  on public.work_orders;
drop trigger if exists capture_work_order_nte_flagged_trigger
  on public.work_orders;
drop trigger if exists capture_work_order_nte_flag_amount_trigger
  on public.work_orders;

create trigger capture_work_order_financials_trigger
  after insert
  on public.work_orders
  for each row execute function public.capture_work_order_financials();

-- PostgreSQL UPDATE OF triggers fire when a column appears in SET, even if
-- its value equals the public mask. Separate triggers preserve that intent
-- without wiping the other three private values from the masked row.
create trigger capture_work_order_nte_trigger
  after update of nte on public.work_orders
  for each row execute function public.capture_work_order_financials('nte');

create trigger capture_work_order_nte_flag_threshold_trigger
  after update of nte_flag_threshold on public.work_orders
  for each row execute function public.capture_work_order_financials('nte_flag_threshold');

create trigger capture_work_order_nte_flagged_trigger
  after update of nte_flagged on public.work_orders
  for each row execute function public.capture_work_order_financials('nte_flagged');

create trigger capture_work_order_nte_flag_amount_trigger
  after update of nte_flag_amount on public.work_orders
  for each row execute function public.capture_work_order_financials('nte_flag_amount');

revoke all on function public.capture_work_order_financials()
  from public, anon, authenticated;
revoke all on function public.archive_assignment_financials()
  from public, anon, authenticated;

commit;
