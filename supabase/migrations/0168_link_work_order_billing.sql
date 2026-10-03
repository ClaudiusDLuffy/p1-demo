-- A work order covered by an existing portal invoice is not externally billed.
-- No historical/customer records are changed by this migration.
begin;

alter table public.work_order_close_transition_guards
  drop constraint work_order_close_transition_guards_transition_kind_check;
alter table public.work_order_close_transition_guards
  add constraint work_order_close_transition_guards_transition_kind_check
  check (transition_kind in ('without_invoice', 'reopened_without_additional_billing', 'external_billing', 'linked_billing'));

create table public.work_order_billing_links (
  operation_id uuid primary key,
  work_order_id text not null references public.work_orders(id) on delete restrict,
  billing_work_order_id text not null references public.work_orders(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  assignment_version integer not null check (assignment_version >= 0),
  workflow_cycle integer not null check (workflow_cycle >= 0),
  expected_lifecycle_version bigint not null check (expected_lifecycle_version >= 0),
  billing_assignment_version integer not null check (billing_assignment_version >= 0),
  billing_workflow_cycle integer not null check (billing_workflow_cycle >= 0),
  invoice_version bigint not null check (invoice_version >= 0),
  note text not null check (length(btrim(note)) between 5 and 1000),
  activity_id uuid not null unique references public.activities(id) on delete restrict,
  billing_activity_id uuid not null unique references public.activities(id) on delete restrict,
  closed_at timestamptz not null,
  result jsonb not null,
  check (work_order_id <> billing_work_order_id),
  unique (work_order_id, workflow_cycle)
);
create index work_order_billing_links_invoice_idx on public.work_order_billing_links(invoice_id);
create index work_order_billing_links_destination_idx on public.work_order_billing_links(billing_work_order_id, closed_at desc);
comment on table public.work_order_billing_links is
  'Immutable staff-only coverage by an existing portal invoice. No new revenue, external billing, payment, or 7-Eleven submission is recorded.';
alter table public.work_order_billing_links enable row level security;
revoke all on public.work_order_billing_links from public, anon, authenticated, service_role;

create function public.require_linked_billing_actor()
returns public.profiles language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles where id=auth.uid() and active
    and role in ('manager','dispatcher','back_office');
  if not found or public.profile_has_staff_permission(v_actor.id,'invoice_controller') then
    raise exception 'LINKED_BILLING_FORBIDDEN' using errcode='42501';
  end if;
  return v_actor;
end;
$$;

create function public.protect_linked_billing_evidence()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_source text; v_actor uuid;
begin
  if tg_table_name='activities' then
    if tg_op='INSERT' then
      if coalesce(new.event_key,'') not in ('work_order_billed_under_another','work_order_billing_coverage_added') then return new; end if;
    elsif tg_op='UPDATE' then
      if coalesce(old.event_key,'') not in ('work_order_billed_under_another','work_order_billing_coverage_added')
        and coalesce(new.event_key,'') not in ('work_order_billed_under_another','work_order_billing_coverage_added') then return new; end if;
    elsif coalesce(old.event_key,'') not in ('work_order_billed_under_another','work_order_billing_coverage_added') then return old;
    end if;
  end if;
  if tg_op<>'INSERT' then raise exception 'Linked billing evidence is immutable' using errcode='42501'; end if;
  if tg_table_name='activities' then
    v_source:=new.event_data->>'coveredWorkOrderId'; v_actor:=new.author_id;
    if not new.is_staff_only or new.requires_7eleven_sync then
      raise exception 'Linked billing evidence must remain internal' using errcode='42501';
    end if;
  else v_source:=new.work_order_id; v_actor:=new.actor_id; end if;
  if v_actor is distinct from auth.uid() or not exists (
    select 1 from public.work_order_close_transition_guards g where g.transaction_id=txid_current()
      and g.work_order_id=v_source and g.actor_id=auth.uid() and g.transition_kind='linked_billing'
  ) then raise exception 'Linked billing evidence requires its owning command' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger zz_protect_linked_billing_activity before insert or update or delete on public.activities
  for each row execute function public.protect_linked_billing_evidence();
create trigger protect_linked_billing_record before insert or update or delete on public.work_order_billing_links
  for each row execute function public.protect_linked_billing_evidence();

-- The invoice row lock serializes invalidation against link creation. Keep the
-- invoice usable by normal billing/export; only invalidate after reopening the
-- covered work orders. Historical snapshots remain immutable after reopening.
create function public.protect_linked_billing_invoice()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op<>'INSERT' and exists (
    select 1 from public.work_order_billing_links b join public.work_orders w on w.id=b.work_order_id
    where b.invoice_id=old.id and w.workflow_cycle=b.workflow_cycle and w.status='closed'
  ) then
    if tg_op='DELETE' then raise exception 'LINKED_BILLING_INVOICE_IN_USE' using errcode='23514'; end if;
    if new.deleted_at is not null or new.work_order_id is distinct from old.work_order_id
      or new.invoice_type<>'staff' or new.document_kind<>'invoice'
      or new.state::text not in ('submitted','revised','approved','paid') then
      raise exception 'LINKED_BILLING_INVOICE_IN_USE' using errcode='23514';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.work_order_id is not null and new.deleted_at is null
    and new.invoice_type='staff' and new.document_kind='invoice' then
    perform 1 from public.work_orders where id=new.work_order_id for update;
    if exists(select 1 from public.work_order_billing_links b join public.work_orders w on w.id=b.work_order_id
      where w.id=new.work_order_id and b.workflow_cycle=w.workflow_cycle) then
      raise exception 'LINKED_BILLING_ALREADY_RECORDED' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger protect_linked_billing_invoice before insert or update or delete on public.invoices
  for each row execute function public.protect_linked_billing_invoice();

create function public.list_linked_billing_candidates_v1(p_work_order_id text, p_invoice_number text default '')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  perform public.require_linked_billing_actor();
  if p_work_order_id is null or length(p_work_order_id) not between 1 and 128
    or p_invoice_number is null or length(p_invoice_number)>100 then
    raise exception 'LINKED_BILLING_INVALID_INPUT' using errcode='22023';
  end if;
  with candidates as (
    select i.id,i.num,i.invoice_date,i.state,i.invoice_version,w.id as work_id,
      w.contractor_assignment_version,w.workflow_cycle
    from public.invoices i join public.work_orders w on w.id=i.work_order_id
    where w.id=p_work_order_id and w.deleted_at is null and i.deleted_at is null
      and i.invoice_type='staff' and i.document_kind='invoice'
      and i.state::text in ('submitted','revised','approved','paid')
      and (p_invoice_number='' or i.num=p_invoice_number)
    order by i.created_at desc,i.id limit 26
  ), page as (select * from candidates limit 25)
  select jsonb_build_object('workOrderId',p_work_order_id,'hasMore',(select count(*)>25 from candidates),
    'items',coalesce(jsonb_agg(jsonb_build_object('invoiceId',id,'invoiceNumber',num,'invoiceDate',invoice_date,
      'state',state,'invoiceVersion',invoice_version,'workOrderId',work_id,
      'assignmentVersion',contractor_assignment_version,'workflowCycle',workflow_cycle)),'[]'::jsonb))
    into v_result from page;
  return v_result;
end;
$$;

create function public.record_work_order_linked_billing_v1(
  p_work_order_id text, p_expected_assignment_version integer, p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint, p_operation_id uuid, p_billing_work_order_id text,
  p_billing_assignment_version integer, p_billing_workflow_cycle integer,
  p_invoice_id uuid, p_expected_invoice_version bigint, p_note text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor public.profiles%rowtype; v_work public.work_orders%rowtype; v_target public.work_orders%rowtype;
  v_invoice public.invoices%rowtype; v_existing public.work_order_billing_links%rowtype;
  v_note text:=regexp_replace(coalesce(p_note,''),'^[[:space:]]+|[[:space:]]+$','','g');
  v_activity uuid:=gen_random_uuid(); v_target_activity uuid:=gen_random_uuid();
  v_now timestamptz:=now(); v_result jsonb; v_event jsonb;
begin
  v_actor:=public.require_linked_billing_actor();
  if p_operation_id is null or p_invoice_id is null or p_work_order_id is null or p_billing_work_order_id is null
    or length(p_work_order_id) not between 1 and 128 or length(p_billing_work_order_id) not between 1 and 128
    or p_work_order_id=p_billing_work_order_id or length(v_note) not between 5 and 1000
    or p_expected_assignment_version is null or p_expected_assignment_version<0
    or p_expected_workflow_cycle is null or p_expected_workflow_cycle<0
    or p_expected_lifecycle_version is null or p_expected_lifecycle_version<0
    or p_billing_assignment_version is null or p_billing_assignment_version<0
    or p_billing_workflow_cycle is null or p_billing_workflow_cycle<0
    or p_expected_invoice_version is null or p_expected_invoice_version<0 then
    raise exception 'LINKED_BILLING_INVALID_INPUT' using errcode='22023';
  end if;
  -- Invoice first: existing invoice updates also hold this row before taking
  -- their parent lock. Parent locks serialize closure with delayed inserts.
  select * into v_invoice from public.invoices where id=p_invoice_id for update;
  if not found then raise exception 'LINKED_BILLING_INVOICE_UNAVAILABLE' using errcode='23514'; end if;
  perform 1 from public.work_orders where id in (p_work_order_id,p_billing_work_order_id) order by id for update;
  select * into v_work from public.work_orders where id=p_work_order_id and deleted_at is null;
  if not found then raise exception 'LINKED_BILLING_NOT_FOUND' using errcode='P0002'; end if;
  select * into v_target from public.work_orders where id=p_billing_work_order_id and deleted_at is null;
  if not found then raise exception 'LINKED_BILLING_NOT_FOUND' using errcode='P0002'; end if;
  v_actor:=public.require_linked_billing_actor();
  select * into v_existing from public.work_order_billing_links where operation_id=p_operation_id;
  if found then
    if v_existing.work_order_id is distinct from p_work_order_id or v_existing.actor_id is distinct from v_actor.id
      or v_existing.assignment_version is distinct from p_expected_assignment_version
      or v_existing.workflow_cycle is distinct from p_expected_workflow_cycle
      or v_existing.expected_lifecycle_version is distinct from p_expected_lifecycle_version
      or v_existing.billing_work_order_id is distinct from p_billing_work_order_id
      or v_existing.billing_assignment_version is distinct from p_billing_assignment_version
      or v_existing.billing_workflow_cycle is distinct from p_billing_workflow_cycle
      or v_existing.invoice_id is distinct from p_invoice_id or v_existing.invoice_version is distinct from p_expected_invoice_version
      or v_existing.note is distinct from v_note then
      raise exception 'LINKED_BILLING_OPERATION_REUSED' using errcode='PT409';
    end if;
    if v_work.status<>'closed' or v_work.workflow_cycle<>v_existing.workflow_cycle
      or v_work.contractor_assignment_version<>v_existing.assignment_version
      or v_work.lifecycle_version<>(v_existing.result->>'lifecycleVersion')::bigint
      or v_work.closed_at is distinct from v_existing.closed_at then
      raise exception 'LINKED_BILLING_STALE' using errcode='PT409';
    end if;
    return v_existing.result||jsonb_build_object('applied',false);
  end if;
  if v_work.contractor_assignment_version<>p_expected_assignment_version or v_work.workflow_cycle<>p_expected_workflow_cycle
    or v_work.lifecycle_version<>p_expected_lifecycle_version or v_invoice.invoice_version<>p_expected_invoice_version
    or v_target.contractor_assignment_version<>p_billing_assignment_version or v_target.workflow_cycle<>p_billing_workflow_cycle then
    raise exception 'LINKED_BILLING_STALE' using errcode='PT409';
  end if;
  if v_invoice.work_order_id is distinct from v_target.id or v_invoice.deleted_at is not null
    or v_invoice.invoice_type<>'staff' or v_invoice.document_kind<>'invoice'
    or v_invoice.state::text not in ('submitted','revised','approved','paid') then
    raise exception 'LINKED_BILLING_INVOICE_UNAVAILABLE' using errcode='23514';
  end if;
  if v_work.status='closed' or exists(select 1 from public.work_order_billing_links
    where work_order_id=v_work.id and workflow_cycle=v_work.workflow_cycle)
    or exists(select 1 from public.work_order_external_billings
      where work_order_id=v_work.id and workflow_cycle=v_work.workflow_cycle) then
    raise exception 'LINKED_BILLING_ALREADY_RECORDED' using errcode='23514';
  end if;
  if v_work.status::text not in ('completed','pending_invoice','pending_payment')
    or (not v_work.billing_only and v_work.functional_status::text is distinct from 'Completed') then
    raise exception 'LINKED_BILLING_FIELD_INCOMPLETE' using errcode='23514';
  end if;
  if exists(select 1 from public.work_order_visits where work_order_id=v_work.id and check_out_at is null) then
    raise exception 'LINKED_BILLING_OPEN_VISIT' using errcode='23514';
  end if;
  if exists(select 1 from public.activities where work_order_id=v_work.id and deleted_at is null
    and ((requires_7eleven_sync and synced_to_7eleven_at is null)
      or (requires_contractor_attention and contractor_attention_acknowledged_at is null))) then
    raise exception 'LINKED_BILLING_PENDING_UPDATES' using errcode='23514';
  end if;
  if exists(select 1 from public.invoices where work_order_id=v_work.id and deleted_at is null
    and invoice_type='staff' and document_kind='invoice') then
    raise exception 'LINKED_BILLING_PORTAL_INVOICE_EXISTS' using errcode='23514';
  end if;
  if exists(select 1 from public.invoices where work_order_id=v_work.id and deleted_at is null
    and invoice_type='contractor' and state not in ('approved','paid')) then
    raise exception 'LINKED_BILLING_UNRESOLVED_INVOICES' using errcode='23514';
  end if;
  insert into public.work_order_close_transition_guards(transaction_id,work_order_id,actor_id,transition_kind)
    values(txid_current(),v_work.id,v_actor.id,'linked_billing');
  update public.work_orders set status='closed',closed_at=v_now,updated_at=v_now where id=v_work.id returning * into v_work;
  v_event:=jsonb_build_object('operationId',p_operation_id,'coveredWorkOrderId',v_work.id,
    'billingWorkOrderId',v_target.id,'invoiceId',v_invoice.id,'invoiceNumber',v_invoice.num,
    'note',v_note,'sevenElevenStatusUnchanged',true);
  insert into public.activities(id,work_order_id,author_id,author_name,text,type,is_staff_override,is_staff_only,event_key,event_data)
  values(v_activity,v_work.id,v_actor.id,v_actor.name,
    format('Billed under %s on portal invoice #%s. %s',v_target.id,v_invoice.num,v_note),
    'system',false,true,'work_order_billed_under_another',v_event),
    (v_target_activity,v_target.id,v_actor.id,v_actor.name,
    format('Portal invoice #%s also covers %s; that work order was closed. %s',v_invoice.num,v_work.id,v_note),
    'system',false,true,'work_order_billing_coverage_added',v_event);
  v_result:=jsonb_build_object('applied',true,'operationId',p_operation_id,'workOrderId',v_work.id,
    'assignmentVersion',v_work.contractor_assignment_version,'workflowCycle',v_work.workflow_cycle,
    'lifecycleVersion',v_work.lifecycle_version,'workOrderStatus','closed','functionalStatus',v_work.functional_status,
    'activityId',v_activity,'billingActivityId',v_target_activity,'closedAt',v_now,
    'billingWorkOrderId',v_target.id,'billingAssignmentVersion',v_target.contractor_assignment_version,
    'billingWorkflowCycle',v_target.workflow_cycle,'invoiceId',v_invoice.id,'invoiceVersion',v_invoice.invoice_version,
    'invoiceNumber',v_invoice.num,'invoiceDate',v_invoice.invoice_date,'note',v_note);
  insert into public.work_order_billing_links(operation_id,work_order_id,billing_work_order_id,invoice_id,actor_id,
    assignment_version,workflow_cycle,expected_lifecycle_version,billing_assignment_version,billing_workflow_cycle,
    invoice_version,note,activity_id,billing_activity_id,closed_at,result)
  values(p_operation_id,v_work.id,v_target.id,v_invoice.id,v_actor.id,v_work.contractor_assignment_version,v_work.workflow_cycle,
    p_expected_lifecycle_version,v_target.contractor_assignment_version,v_target.workflow_cycle,v_invoice.invoice_version,
    v_note,v_activity,v_target_activity,v_now,v_result);
  delete from public.work_order_close_transition_guards where transaction_id=txid_current()
    and work_order_id=v_work.id and actor_id=v_actor.id and transition_kind='linked_billing';
  return v_result;
end;
$$;

-- Bounded, cursor-paged history on either side. A source reopen makes previous
-- links historical without erasing evidence or moving the original invoice.
create function public.get_work_order_billing_links_v1(p_work_order_id text,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  perform public.require_linked_billing_actor();
  if p_work_order_id is null or length(p_work_order_id) not between 1 and 128
    or ((p_before is null)<>(p_before_id is null)) then
    raise exception 'LINKED_BILLING_INVALID_INPUT' using errcode='22023';
  end if;
  with links as (
    select b.*, w.workflow_cycle=b.workflow_cycle and w.status='closed' as active
    from public.work_order_billing_links b join public.work_orders w on w.id=b.work_order_id
    where (b.work_order_id=p_work_order_id or b.billing_work_order_id=p_work_order_id)
      and (p_before is null or (b.closed_at,b.operation_id)<(p_before,p_before_id))
    order by b.closed_at desc,b.operation_id desc limit 26
  ), page as (select * from links order by closed_at desc,operation_id desc limit 25)
  select jsonb_build_object('workOrderId',p_work_order_id,'hasMore',(select count(*)>25 from links),
    'items',coalesce(jsonb_agg(jsonb_build_object('receipt',result,'active',active) order by closed_at desc,operation_id desc),'[]'::jsonb))
    into v_result from page;
  return v_result;
end;
$$;

revoke all on function public.require_linked_billing_actor(), public.protect_linked_billing_evidence(),
  public.protect_linked_billing_invoice() from public,anon,authenticated,service_role;
revoke all on function public.record_work_order_linked_billing_v1(text,integer,integer,bigint,uuid,text,integer,integer,uuid,bigint,text),
  public.list_linked_billing_candidates_v1(text,text),public.get_work_order_billing_links_v1(text,timestamptz,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.record_work_order_linked_billing_v1(text,integer,integer,bigint,uuid,text,integer,integer,uuid,bigint,text),
  public.list_linked_billing_candidates_v1(text,text),public.get_work_order_billing_links_v1(text,timestamptz,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
