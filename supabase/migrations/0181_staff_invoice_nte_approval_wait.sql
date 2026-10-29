begin;

-- NTE approval is an operational hold, not an invoice amount/status mutation.
-- Keep it separately versioned so marking a bill does not alter financial data.
create table public.staff_invoice_nte_wait_flags (
  invoice_id uuid primary key references public.invoices(id) on delete cascade,
  waiting_on_nte_approval boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict
);

alter table public.staff_invoice_nte_wait_flags enable row level security;
create policy staff_invoice_nte_wait_flags_read
  on public.staff_invoice_nte_wait_flags for select using (public.is_staff());

revoke all on public.staff_invoice_nte_wait_flags from public, anon, authenticated, service_role;
grant select on public.staff_invoice_nte_wait_flags to authenticated;

create function public.list_staff_invoice_nte_wait_flags_v1(p_invoice_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested integer;
  v_found integer;
  v_items jsonb;
begin
  if p_invoice_ids is null or cardinality(p_invoice_ids) > 100
    or exists (select 1 from unnest(p_invoice_ids) requested(id) where requested.id is null) then
    raise exception 'Invalid invoice marker read' using errcode = '22023';
  end if;
  v_requested := cardinality(p_invoice_ids);
  if (select count(distinct requested.id) from unnest(p_invoice_ids) requested(id)) <> v_requested then
    raise exception 'Duplicate invoice marker read target' using errcode = '22023';
  end if;

  select count(*)::integer into v_found
  from public.invoices invoice
  where invoice.id = any(p_invoice_ids)
    and invoice.invoice_type = 'staff'
    and invoice.deleted_at is null;
  if v_found <> v_requested then
    raise exception 'Staff invoice marker target not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'invoiceId', requested.id,
    'waitingOnNteApproval', coalesce(flag.waiting_on_nte_approval, false)
  ) order by requested.ordinality), '[]'::jsonb)
  into v_items
  from unnest(p_invoice_ids) with ordinality requested(id, ordinality)
  left join public.staff_invoice_nte_wait_flags flag on flag.invoice_id = requested.id;

  return jsonb_build_object('items', v_items);
end;
$$;

revoke all on function public.list_staff_invoice_nte_wait_flags_v1(uuid[]) from public, anon, authenticated;
grant execute on function public.list_staff_invoice_nte_wait_flags_v1(uuid[]) to service_role;

create function public.set_staff_invoice_nte_waiting_v1(
  p_invoice_id uuid,
  p_waiting boolean,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_role text;
  v_changed boolean := false;
  v_row_count integer := 0;
begin
  if p_invoice_id is null or p_waiting is null or p_actor_id is null then
    raise exception 'Invalid NTE approval marker command' using errcode = '22023';
  end if;

  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = p_actor_id and profile.active = true;
  if v_role is null or v_role not in ('manager', 'dispatcher', 'back_office')
    or public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Operational billing access required' using errcode = '42501';
  end if;

  select invoice.* into v_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.invoice_type = 'staff'
    and invoice.document_kind = 'invoice'
    and invoice.deleted_at is null
  for update;
  if not found then
    raise exception 'P1 invoice not found' using errcode = 'P0002';
  end if;

  if p_waiting and (v_invoice.state not in ('draft', 'submitted')
    or v_invoice.qbo_invoice_id is not null or v_invoice.qbo_synced_at is not null) then
    raise exception 'NTE approval can only be marked on an unsynced invoice awaiting submission'
      using errcode = '55000';
  end if;

  if p_waiting then
    insert into public.staff_invoice_nte_wait_flags as existing (
      invoice_id, waiting_on_nte_approval, updated_at, updated_by
    ) values (p_invoice_id, true, now(), p_actor_id)
    on conflict (invoice_id) do update
      set waiting_on_nte_approval = true,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      where existing.waiting_on_nte_approval is distinct from true;
  else
    update public.staff_invoice_nte_wait_flags flag
    set waiting_on_nte_approval = false,
        updated_at = now(),
        updated_by = p_actor_id
    where flag.invoice_id = p_invoice_id and flag.waiting_on_nte_approval;
  end if;
  get diagnostics v_row_count = row_count;
  v_changed := v_row_count > 0;

  return jsonb_build_object(
    'invoiceId', p_invoice_id,
    'waitingOnNteApproval', p_waiting,
    'changed', v_changed
  );
end;
$$;

revoke all on function public.set_staff_invoice_nte_waiting_v1(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.set_staff_invoice_nte_waiting_v1(uuid, boolean, uuid) to service_role;

-- Guard the state transition as well as the UI. An NTE-waiting invoice must be
-- untagged after approval before it can be marked ready/sent in the portal.
create function public.guard_staff_invoice_nte_wait_before_submission()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.invoice_type = 'staff'
    and new.state is distinct from old.state
    and new.state in ('submitted', 'approved')
    and exists (
      select 1 from public.staff_invoice_nte_wait_flags flag
      where flag.invoice_id = new.id and flag.waiting_on_nte_approval
    ) then
    raise exception 'Invoice is waiting on NTE approval'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_staff_invoice_nte_wait_before_submission_trigger
  before update of state on public.invoices
  for each row execute function public.guard_staff_invoice_nte_wait_before_submission();

commit;
