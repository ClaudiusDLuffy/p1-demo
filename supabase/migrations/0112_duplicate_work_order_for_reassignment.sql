-- Let operational P1 staff create a fresh, unassigned continuation of an
-- existing contractor work order without moving the original contractor,
-- invoice, or field history. The original 7-Eleven SLA remains authoritative,
-- so the duplicate keeps the intake deadlines instead of starting a new clock.

begin;

alter table public.work_orders
  add column if not exists duplicated_from_work_order_id text,
  add column if not exists duplicate_root_work_order_id text,
  add column if not exists duplicate_sequence integer;

comment on column public.work_orders.duplicated_from_work_order_id is
  'Immediate source work order used to create this reassignment copy.';
comment on column public.work_orders.duplicate_root_work_order_id is
  'Canonical work-order ID from which the root-N duplicate series is allocated.';
comment on column public.work_orders.duplicate_sequence is
  'Positive root-N suffix allocated atomically for a reassignment copy.';

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.work_orders'::regclass
      and constraint_row.conname
        = 'work_orders_duplicated_from_work_order_id_fkey'
  ) then
    alter table public.work_orders
      add constraint work_orders_duplicated_from_work_order_id_fkey
      foreign key (duplicated_from_work_order_id)
      references public.work_orders(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.work_orders'::regclass
      and constraint_row.conname
        = 'work_orders_duplicate_root_work_order_id_fkey'
  ) then
    alter table public.work_orders
      add constraint work_orders_duplicate_root_work_order_id_fkey
      foreign key (duplicate_root_work_order_id)
      references public.work_orders(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.work_orders'::regclass
      and constraint_row.conname
        = 'work_orders_duplicate_provenance_check'
  ) then
    alter table public.work_orders
      add constraint work_orders_duplicate_provenance_check
      check (
        (
          duplicated_from_work_order_id is null
          and duplicate_root_work_order_id is null
          and duplicate_sequence is null
        )
        or (
          duplicated_from_work_order_id is not null
          and duplicate_root_work_order_id is not null
          and duplicate_sequence > 0
          and duplicated_from_work_order_id <> id
          and duplicate_root_work_order_id <> id
          and id = duplicate_root_work_order_id
            || '-'
            || duplicate_sequence::text
        )
      );
  end if;
end
$migration$;

create unique index if not exists work_orders_duplicate_root_sequence_key
  on public.work_orders(duplicate_root_work_order_id, duplicate_sequence)
  where duplicate_root_work_order_id is not null;

create index if not exists idx_work_orders_duplicated_from
  on public.work_orders(duplicated_from_work_order_id)
  where duplicated_from_work_order_id is not null;

create or replace function public.protect_work_order_duplicate_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and (
       new.duplicated_from_work_order_id
         is distinct from old.duplicated_from_work_order_id
       or new.duplicate_root_work_order_id
         is distinct from old.duplicate_root_work_order_id
       or new.duplicate_sequence is distinct from old.duplicate_sequence
     ) then
    raise exception 'Work-order duplicate provenance is immutable'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT'
     and new.duplicated_from_work_order_id is not null
     and coalesce(auth.role(), '') not in ('service_role', '')
     and (
       not public.is_staff()
       or public.is_invoice_controller()
     ) then
    raise exception 'Active operational P1 staff required'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_work_order_duplicate_provenance_trigger
  on public.work_orders;
create trigger protect_work_order_duplicate_provenance_trigger
  before insert or update of
    duplicated_from_work_order_id,
    duplicate_root_work_order_id,
    duplicate_sequence
  on public.work_orders
  for each row execute function public.protect_work_order_duplicate_provenance();

revoke all on function public.protect_work_order_duplicate_provenance()
  from public, anon, authenticated;

create or replace function public.duplicate_work_order_for_reassignment(
  p_source_work_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_source public.work_orders%rowtype;
  v_root_work_order_id text;
  v_duplicate_work_order_id text;
  v_inserted_work_order_id text;
  v_duplicate_sequence integer := 1;
  v_source_nte numeric(10, 2);
  v_created_at timestamptz := clock_timestamp();
begin
  if nullif(trim(coalesce(p_source_work_order_id, '')), '') is null then
    raise exception 'Source work order is required'
      using errcode = '22023';
  end if;

  select profile.*
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
    and not public.profile_has_staff_permission(
      profile.id,
      'invoice_controller'
    );

  if not found then
    raise exception 'Active operational P1 staff required'
      using errcode = '42501';
  end if;

  select work_order.*
  into v_source
  from public.work_orders work_order
  where work_order.id = trim(p_source_work_order_id)
    and work_order.deleted_at is null
  for share;

  if not found then
    raise exception 'Active source work order not found'
      using errcode = 'P0002';
  end if;

  if v_source.billing_only
     or coalesce(v_source.is_capital, false)
     or v_source.contractor_id is null
     or v_source.status::text not in (
       'assigned',
       'wip',
       'parts',
       'completed',
       'pending_invoice',
       'pending_approval',
       'pending_payment'
     ) then
    raise exception
      'Source must be an assigned, non-billing, non-capital operational work order'
      using errcode = '22023';
  end if;

  select financial.nte
  into v_source_nte
  from public.work_order_financials financial
  where financial.work_order_id = v_source.id;

  if not found then
    raise exception 'Source work-order NTE record not found'
      using errcode = 'P0002';
  end if;

  v_root_work_order_id := coalesce(
    v_source.duplicate_root_work_order_id,
    v_source.id
  );

  if v_root_work_order_id !~ '^WOT[0-9]{6,12}$' then
    raise exception 'Only canonical 7-Eleven WOT work orders can be duplicated'
      using errcode = '22023';
  end if;

  -- Every writer using this RPC serializes on the logical root, including
  -- calls that duplicate a prior duplicate. The primary-key conflict fallback
  -- also protects against a legacy/manual writer that did not take this lock.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'duplicate_work_order_for_reassignment:' || v_root_work_order_id,
      0
    )
  );

  loop
    if v_duplicate_sequence = 2147483647 then
      raise exception 'Work-order duplicate sequence exhausted'
        using errcode = '54000';
    end if;

    v_duplicate_work_order_id := v_root_work_order_id
      || '-'
      || v_duplicate_sequence::text;
    v_inserted_work_order_id := null;

    -- The ID lookup deliberately includes soft-deleted rows. Archived IDs are
    -- never recycled because invoices and external references may retain them.
    if exists (
      select 1
      from public.work_orders existing_work_order
      where existing_work_order.id = v_duplicate_work_order_id
    ) then
      v_duplicate_sequence := v_duplicate_sequence + 1;
      continue;
    end if;

    insert into public.work_orders (
      id,
      incident_id,
      store_number,
      city,
      address,
      store_state,
      store_timezone,
      store_county,
      store_postal_code,
      line_of_service,
      business_service,
      category,
      sub_category,
      summary,
      description,
      priority,
      afm_id,
      afm_name,
      afm_email,
      source,
      sla_started_at,
      response_breach_at,
      resolution_breach_at,
      nte,
      nte_flag_threshold,
      nte_flagged,
      nte_flag_amount,
      status,
      functional_status,
      contractor_id,
      assigned_technician_profile_id,
      technician_on_job,
      technician_assigned_at,
      technician_assigned_by,
      contractor_assignment_started_at,
      contractor_assignment_version,
      eta,
      dispatched_at,
      start_time,
      end_time,
      closed_at,
      asset_make,
      asset_model,
      asset_serial,
      asset_year,
      invoice_total,
      billing_only,
      billing_ready_at,
      billing_ready_by,
      contractor_invoicing_completed_at,
      contractor_invoicing_completed_by,
      contractor_invoicing_assignment_version,
      contractor_invoicing_workflow_cycle,
      contractor_invoicing_completion_source,
      is_capital,
      capital_status,
      repair_quote,
      install_quote,
      capital_notes,
      part_needed,
      part_eta,
      resolution_code,
      resolution_notes,
      staff_notes_seen_at,
      workflow_cycle,
      deleted_at,
      deleted_by,
      duplicated_from_work_order_id,
      duplicate_root_work_order_id,
      duplicate_sequence,
      created_by,
      created_at,
      updated_at
    ) values (
      v_duplicate_work_order_id,
      v_source.incident_id,
      v_source.store_number,
      v_source.city,
      v_source.address,
      v_source.store_state,
      v_source.store_timezone,
      v_source.store_county,
      v_source.store_postal_code,
      v_source.line_of_service,
      v_source.business_service,
      v_source.category,
      v_source.sub_category,
      v_source.summary,
      v_source.description,
      v_source.priority,
      v_source.afm_id,
      v_source.afm_name,
      null,
      v_source.source,
      v_source.sla_started_at,
      v_source.response_breach_at,
      v_source.resolution_breach_at,
      v_source_nte,
      null,
      false,
      null,
      'unassigned',
      'New',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      v_source.id,
      v_root_work_order_id,
      v_duplicate_sequence,
      v_actor.id,
      v_created_at,
      v_created_at
    )
    on conflict (id) do nothing
    returning id into v_inserted_work_order_id;

    if v_inserted_work_order_id is not null then
      exit;
    end if;

    v_duplicate_sequence := v_duplicate_sequence + 1;
  end loop;

  insert into public.work_order_afm_contacts (
    work_order_id,
    afm_email
  )
  select
    v_inserted_work_order_id,
    source_contact.afm_email
  from public.work_order_afm_contacts source_contact
  where source_contact.work_order_id = v_source.id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data,
    activity_channel,
    entered_by_role,
    is_staff_override,
    is_staff_only,
    requires_7eleven_sync,
    requires_contractor_attention,
    contractor_assignment_version,
    workflow_cycle,
    created_at
  ) values (
    v_inserted_work_order_id,
    v_actor.id,
    v_actor.name,
    'Duplicated from ' || v_source.id || ' for contractor reassignment.',
    'system',
    'work_order_duplicated',
    jsonb_build_object(
      'sourceWorkOrderId', v_source.id,
      'duplicateRootWorkOrderId', v_root_work_order_id,
      'duplicateSequence', v_duplicate_sequence
    ),
    'system_event',
    v_actor.role::text,
    false,
    true,
    false,
    false,
    0,
    0,
    v_created_at
  );

  return jsonb_build_object(
    'applied', true,
    'reason', 'duplicated',
    'workOrderId', v_inserted_work_order_id,
    'sourceWorkOrderId', v_source.id,
    'rootWorkOrderId', v_root_work_order_id,
    'duplicateSequence', v_duplicate_sequence
  );
end;
$$;

comment on function public.duplicate_work_order_for_reassignment(text) is
  'Creates an atomic root-N operational copy for reassignment while leaving the source contractor, invoice, and child history untouched.';

revoke all on function public.duplicate_work_order_for_reassignment(text)
  from public, anon;
grant execute on function public.duplicate_work_order_for_reassignment(text)
  to authenticated, service_role;

commit;
