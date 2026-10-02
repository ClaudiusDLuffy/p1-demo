-- External accounting is evidence of billing, never a portal invoice or proof
-- of submission to 7-Eleven. No historical work orders are changed here.
begin;

alter table public.work_order_close_transition_guards
  drop constraint work_order_close_transition_guards_transition_kind_check;
alter table public.work_order_close_transition_guards
  add constraint work_order_close_transition_guards_transition_kind_check
  check (transition_kind in ('without_invoice', 'reopened_without_additional_billing', 'external_billing'));

create table public.work_order_external_billings (
  operation_id uuid primary key,
  work_order_id text not null references public.work_orders(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  assignment_version integer not null check (assignment_version >= 0),
  workflow_cycle integer not null check (workflow_cycle >= 0),
  expected_lifecycle_version bigint not null check (expected_lifecycle_version >= 0),
  billing_system text not null check (length(btrim(billing_system)) between 1 and 80),
  invoice_reference text not null check (length(btrim(invoice_reference)) between 1 and 100),
  billed_on date not null check (isfinite(billed_on)),
  note text not null check (length(btrim(note)) between 5 and 1000),
  activity_id uuid not null unique references public.activities(id) on delete restrict,
  closed_at timestamptz not null,
  result jsonb not null,
  unique (work_order_id, workflow_cycle)
);
-- Deliberately NOT unique by external reference: one external invoice may
-- legitimately cover several unrelated work orders. Never total its value here.
comment on table public.work_order_external_billings is
  'Immutable staff-only external billing evidence per work-order cycle. Not a portal invoice, payment confirmation, or 7-Eleven submission.';
alter table public.work_order_external_billings enable row level security;
revoke all on public.work_order_external_billings from public, anon, authenticated, service_role;

create function public.require_external_billing_actor()
returns public.profiles language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = auth.uid() and p.active
    and p.role in ('manager', 'dispatcher', 'back_office');
  if not found or public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'EXTERNAL_BILLING_FORBIDDEN' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create function public.protect_external_billing_evidence()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_work_id text; v_actor uuid;
begin
  if tg_table_name = 'activities' then
    if tg_op = 'INSERT' then
      if new.event_key is distinct from 'work_order_billed_externally' then return new; end if;
    elsif tg_op = 'UPDATE' then
      if old.event_key is distinct from 'work_order_billed_externally'
        and new.event_key is distinct from 'work_order_billed_externally' then return new; end if;
    elsif old.event_key is distinct from 'work_order_billed_externally' then return old;
    end if;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'External billing evidence is immutable' using errcode = '42501';
  end if;
  v_work_id := new.work_order_id;
  if tg_table_name = 'activities' then v_actor := new.author_id;
  else v_actor := new.actor_id; end if;
  if v_actor is distinct from auth.uid() or not exists (
    select 1 from public.work_order_close_transition_guards g
    where g.transaction_id = txid_current() and g.work_order_id = v_work_id
      and g.actor_id = auth.uid() and g.transition_kind = 'external_billing'
  ) then
    raise exception 'External billing evidence requires its owning command' using errcode = '42501';
  end if;
  if tg_table_name = 'activities' then
    if not new.is_staff_only or new.requires_7eleven_sync then
      raise exception 'External billing evidence must remain internal' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger zz_protect_external_billing_activity
  before insert or update or delete on public.activities
  for each row execute function public.protect_external_billing_evidence();
create trigger protect_external_billing_record
  before insert or update or delete on public.work_order_external_billings
  for each row execute function public.protect_external_billing_evidence();

-- Serialize invoice writes with the same parent lock used by closure. A
-- delayed draft, conversion, or invoice relink must not duplicate external AR.
create function public.prevent_invoice_after_external_billing()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cycle integer;
begin
  if new.work_order_id is null or new.deleted_at is not null
    or new.invoice_type <> 'staff' or new.document_kind <> 'invoice' then return new; end if;
  select w.workflow_cycle into v_cycle from public.work_orders w
    where w.id = new.work_order_id for update;
  if exists (select 1 from public.work_order_external_billings b
    where b.work_order_id = new.work_order_id and b.workflow_cycle = v_cycle) then
    raise exception 'EXTERNAL_BILLING_ALREADY_RECORDED' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger prevent_invoice_after_external_billing
  before insert or update on public.invoices
  for each row execute function public.prevent_invoice_after_external_billing();

create function public.record_work_order_external_billing_v1(
  p_work_order_id text, p_expected_assignment_version integer, p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint, p_operation_id uuid,
  p_billing_system text, p_invoice_reference text, p_billed_on date, p_note text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor public.profiles%rowtype; v_work public.work_orders%rowtype;
  v_existing public.work_order_external_billings%rowtype;
  v_system text := btrim(coalesce(p_billing_system, ''));
  v_reference text := btrim(coalesce(p_invoice_reference, ''));
  v_note text := regexp_replace(coalesce(p_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_activity uuid := gen_random_uuid(); v_now timestamptz := now(); v_result jsonb;
begin
  v_actor := public.require_external_billing_actor();
  if p_operation_id is null or p_work_order_id is null or length(p_work_order_id) not between 1 and 128
    or p_expected_assignment_version is null or p_expected_assignment_version < 0
    or p_expected_workflow_cycle is null or p_expected_workflow_cycle < 0
    or p_expected_lifecycle_version is null or p_expected_lifecycle_version < 0
    or length(v_system) not between 1 and 80 or length(v_reference) not between 1 and 100
    or length(v_note) not between 5 and 1000 or p_billed_on is null or not isfinite(p_billed_on)
    or p_billed_on > (clock_timestamp() at time zone 'America/New_York')::date
    or v_system ~ '[[:cntrl:]]' or v_reference ~ '[[:cntrl:]]' then
    raise exception 'EXTERNAL_BILLING_INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_work from public.work_orders w
    where w.id = p_work_order_id and w.deleted_at is null for update;
  if not found then raise exception 'EXTERNAL_BILLING_NOT_FOUND' using errcode = 'P0002'; end if;
  v_actor := public.require_external_billing_actor();

  select * into v_existing from public.work_order_external_billings b where b.operation_id = p_operation_id;
  if found then
    if v_existing.work_order_id is distinct from p_work_order_id or v_existing.actor_id is distinct from v_actor.id
      or v_existing.assignment_version is distinct from p_expected_assignment_version
      or v_existing.workflow_cycle is distinct from p_expected_workflow_cycle
      or v_existing.expected_lifecycle_version is distinct from p_expected_lifecycle_version
      or v_existing.billing_system is distinct from v_system or v_existing.invoice_reference is distinct from v_reference
      or v_existing.billed_on is distinct from p_billed_on or v_existing.note is distinct from v_note then
      raise exception 'EXTERNAL_BILLING_OPERATION_REUSED' using errcode = 'PT409';
    end if;
    if v_work.status <> 'closed' or v_work.workflow_cycle <> v_existing.workflow_cycle
      or v_work.contractor_assignment_version <> v_existing.assignment_version
      or v_work.lifecycle_version <> (v_existing.result->>'lifecycleVersion')::bigint
      or v_work.closed_at is distinct from v_existing.closed_at then
      raise exception 'EXTERNAL_BILLING_STALE' using errcode = 'PT409';
    end if;
    return v_existing.result || jsonb_build_object('applied', false);
  end if;
  if v_work.workflow_cycle <> p_expected_workflow_cycle
    or v_work.contractor_assignment_version <> p_expected_assignment_version
    or v_work.lifecycle_version <> p_expected_lifecycle_version then
    raise exception 'EXTERNAL_BILLING_STALE' using errcode = 'PT409';
  end if;
  if v_work.status = 'closed' or exists (select 1 from public.work_order_external_billings b
    where b.work_order_id = v_work.id and b.workflow_cycle = v_work.workflow_cycle) then
    raise exception 'EXTERNAL_BILLING_ALREADY_RECORDED' using errcode = '23514';
  end if;
  if v_work.status::text not in ('completed', 'pending_invoice', 'pending_payment')
    or (not v_work.billing_only and v_work.functional_status::text is distinct from 'Completed') then
    raise exception 'EXTERNAL_BILLING_FIELD_INCOMPLETE' using errcode = '23514';
  end if;
  if exists (select 1 from public.work_order_visits v where v.work_order_id = v_work.id and v.check_out_at is null) then
    raise exception 'EXTERNAL_BILLING_OPEN_VISIT' using errcode = '23514';
  end if;
  if exists (select 1 from public.activities a where a.work_order_id = v_work.id and a.deleted_at is null
    and ((a.requires_7eleven_sync and a.synced_to_7eleven_at is null)
      or (a.requires_contractor_attention and a.contractor_attention_acknowledged_at is null))) then
    raise exception 'EXTERNAL_BILLING_PENDING_UPDATES' using errcode = '23514';
  end if;
  if exists (select 1 from public.invoices i where i.work_order_id = v_work.id and i.deleted_at is null
    and i.invoice_type = 'staff' and i.document_kind = 'invoice') then
    raise exception 'EXTERNAL_BILLING_PORTAL_INVOICE_EXISTS' using errcode = '23514';
  end if;
  if exists (select 1 from public.invoices i where i.work_order_id = v_work.id and i.deleted_at is null
    and i.invoice_type = 'contractor' and i.state not in ('approved', 'paid')) then
    raise exception 'EXTERNAL_BILLING_UNRESOLVED_INVOICES' using errcode = '23514';
  end if;
  insert into public.work_order_close_transition_guards(transaction_id, work_order_id, actor_id, transition_kind)
    values (txid_current(), v_work.id, v_actor.id, 'external_billing');
  update public.work_orders set status = 'closed', closed_at = v_now, updated_at = v_now
    where id = v_work.id returning * into v_work;
  insert into public.activities(id, work_order_id, author_id, author_name, text, type,
    is_staff_override, is_staff_only, event_key, event_data)
  values (v_activity, v_work.id, v_actor.id, v_actor.name,
    format('Billed outside the portal in %s. Invoice %s, billing date %s. %s', v_system, v_reference, p_billed_on, v_note),
    'system', false, true, 'work_order_billed_externally',
    jsonb_build_object('operationId', p_operation_id, 'billingSystem', v_system,
      'invoiceReference', v_reference, 'billedOn', p_billed_on, 'note', v_note,
      'sevenElevenStatusUnchanged', true));
  v_result := jsonb_build_object('applied', true, 'operationId', p_operation_id,
    'workOrderId', v_work.id, 'assignmentVersion', v_work.contractor_assignment_version,
    'workflowCycle', v_work.workflow_cycle, 'lifecycleVersion', v_work.lifecycle_version,
    'workOrderStatus', 'closed', 'functionalStatus', v_work.functional_status,
    'activityId', v_activity, 'closedAt', v_work.closed_at,
    'billingSystem', v_system, 'invoiceReference', v_reference, 'billedOn', p_billed_on, 'note', v_note);
  insert into public.work_order_external_billings(operation_id, work_order_id, actor_id,
    assignment_version, workflow_cycle, expected_lifecycle_version, billing_system,
    invoice_reference, billed_on, note, activity_id, closed_at, result)
  values (p_operation_id, v_work.id, v_actor.id, v_work.contractor_assignment_version, v_work.workflow_cycle,
    p_expected_lifecycle_version, v_system, v_reference, p_billed_on, v_note, v_activity, v_work.closed_at, v_result);
  delete from public.work_order_close_transition_guards where transaction_id = txid_current()
    and work_order_id = v_work.id and actor_id = v_actor.id and transition_kind = 'external_billing';
  return v_result;
end;
$$;

create function public.get_work_order_external_billing_v1(p_work_order_id text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  perform public.require_external_billing_actor();
  if p_work_order_id is null or length(p_work_order_id) not between 1 and 128 then
    raise exception 'EXTERNAL_BILLING_INVALID_INPUT' using errcode = '22023';
  end if;
  select b.result into v_result from public.work_order_external_billings b
    join public.work_orders w on w.id = b.work_order_id and w.deleted_at is null
    where b.work_order_id = p_work_order_id order by b.workflow_cycle desc limit 1;
  return v_result;
end;
$$;

revoke all on function public.require_external_billing_actor(), public.protect_external_billing_evidence(),
  public.prevent_invoice_after_external_billing() from public, anon, authenticated, service_role;
revoke all on function public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text),
  public.get_work_order_external_billing_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text),
  public.get_work_order_external_billing_v1(text) to authenticated;
notify pgrst, 'reload schema';
commit;
