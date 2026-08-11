-- Hotfix for migration 0060: the PL/pgSQL record variable `work_order` and
-- the UPDATE table alias `work_order` made `work_order.id` ambiguous at
-- runtime. Keep the record variable used for assignment validation and give
-- the UPDATE target a distinct alias.

begin;

create or replace function public.review_contractor_invoice(
  p_invoice_id uuid,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  invoice public.invoices%rowtype;
  work_order public.work_orders%rowtype;
  next_status public.wo_status;
  action_name text := lower(trim(coalesce(p_action, '')));
  reason_text text := nullif(trim(coalesce(p_reason, '')), '');
  activity_text text;
  activity_key text;
  previous_state public.invoice_state;
  saved_work_order_status public.wo_status;
begin
  if actor_id is null
     or not public.is_staff()
     or public.is_invoice_controller() then
    raise exception 'Staff invoice-review access is required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found then
    raise exception 'Active staff profile not found'
      using errcode = '42501';
  end if;

  select candidate.*
  into invoice
  from public.invoices candidate
  where candidate.id = p_invoice_id
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Contractor invoice not found'
      using errcode = 'P0002';
  end if;

  if invoice.work_order_id is null then
    raise exception 'Contractor invoice is not linked to a work order'
      using errcode = '22023';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = invoice.work_order_id
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Linked work order not found'
      using errcode = 'P0002';
  end if;

  if work_order.contractor_id is distinct from invoice.contractor_id
     or work_order.contractor_assignment_started_at is null
     or invoice.created_at < work_order.contractor_assignment_started_at then
    raise exception 'Invoice belongs to a prior contractor assignment and cannot be reviewed'
      using errcode = '42501';
  end if;

  if invoice.state not in ('submitted', 'revised') then
    raise exception 'Invoice changed before it could be reviewed; current state is %',
      invoice.state
      using errcode = '40001';
  end if;

  if action_name not in ('approve', 'reject') then
    raise exception 'Review action must be approve or reject'
      using errcode = '22023';
  end if;

  if action_name = 'reject' and reason_text is null then
    raise exception 'A rejection reason is required'
      using errcode = '22023';
  end if;

  previous_state := invoice.state;
  perform set_config('app.contractor_invoice_transition', 'review', true);

  if action_name = 'approve' then
    update public.invoices
    set state = 'approved',
        updated_at = now()
    where id = invoice.id
    returning * into invoice;

    activity_key := 'invoice_approved';
    activity_text := format(
      'Invoice #%s approved by %s.',
      invoice.num,
      actor_name
    );
  else
    update public.invoices
    set state = 'rejected',
        rejection_reason = reason_text,
        rejected_at = now(),
        rejected_by = actor_id,
        updated_at = now()
    where id = invoice.id
    returning * into invoice;

    activity_key := 'invoice_rejected';
    activity_text := format(
      'Invoice #%s rejected by %s: %s',
      invoice.num,
      actor_name,
      reason_text
    );
  end if;

  next_status := public.contractor_invoice_work_order_status(
    invoice.work_order_id
  );

  update public.work_orders target_work_order
  set status = case
        when target_work_order.status = 'closed'
          then target_work_order.status
        else coalesce(next_status, 'pending_approval'::public.wo_status)
      end,
      updated_at = now()
  where target_work_order.id = invoice.work_order_id
    and target_work_order.deleted_at is null
    and target_work_order.contractor_id = invoice.contractor_id
    and target_work_order.contractor_assignment_started_at is not null
    and invoice.created_at >=
      target_work_order.contractor_assignment_started_at
  returning target_work_order.status into saved_work_order_status;

  if not found then
    raise exception 'Linked work order not found'
      using errcode = 'P0002';
  end if;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data,
    requires_contractor_attention
  ) values (
    invoice.work_order_id,
    actor_id,
    actor_name,
    activity_text,
    'system',
    activity_key,
    jsonb_build_object(
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num,
      'outcome', action_name,
      'reason', reason_text,
      'revision', invoice.review_revision,
      'previousState', previous_state,
      'newState', invoice.state
    ),
    action_name = 'reject'
  );

  return jsonb_build_object(
    'invoiceId', invoice.id,
    'invoiceNum', invoice.num,
    'invoiceState', invoice.state,
    'workOrderId', invoice.work_order_id,
    'workOrderStatus', saved_work_order_status,
    'reviewRevision', invoice.review_revision,
    'rejectionReason', invoice.rejection_reason
  );
end;
$$;

create or replace function public.retract_contractor_invoice_rejection(
  p_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  invoice public.invoices%rowtype;
  work_order public.work_orders%rowtype;
  next_status public.wo_status;
  saved_work_order_status public.wo_status;
begin
  if actor_id is null
     or not public.is_staff()
     or public.is_invoice_controller() then
    raise exception 'Staff invoice-review access is required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found then
    raise exception 'Active staff profile not found'
      using errcode = '42501';
  end if;

  select candidate.*
  into invoice
  from public.invoices candidate
  where candidate.id = p_invoice_id
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Contractor invoice not found'
      using errcode = 'P0002';
  end if;

  if invoice.state <> 'rejected' then
    raise exception 'Rejection can no longer be retracted; current state is %',
      invoice.state
      using errcode = '40001';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = invoice.work_order_id
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Linked work order not found'
      using errcode = 'P0002';
  end if;

  if work_order.contractor_id is distinct from invoice.contractor_id
     or work_order.contractor_assignment_started_at is null
     or invoice.created_at < work_order.contractor_assignment_started_at then
    raise exception 'Invoice belongs to a prior contractor assignment and its rejection cannot be retracted here'
      using errcode = '42501';
  end if;

  perform set_config(
    'app.contractor_invoice_transition',
    'undo_rejection',
    true
  );

  update public.invoices candidate
  set state = 'approved',
      updated_at = now()
  where candidate.id = invoice.id
    and candidate.state = 'rejected'
  returning candidate.* into invoice;

  if not found then
    raise exception 'Rejection can no longer be retracted'
      using errcode = '40001';
  end if;

  update public.activities activity
  set requires_contractor_attention = false,
      contractor_attention_acknowledged_at = null,
      contractor_attention_acknowledged_by = null
  where activity.work_order_id = invoice.work_order_id
    and activity.event_key = 'invoice_rejected'
    and activity.event_data ->> 'invoiceId' = invoice.id::text
    and activity.requires_contractor_attention = true
    and activity.contractor_attention_acknowledged_at is null
    and activity.deleted_at is null;

  next_status := public.contractor_invoice_work_order_status(
    invoice.work_order_id
  );

  update public.work_orders target_work_order
  set status = case
        when target_work_order.status = 'closed'
          then target_work_order.status
        else coalesce(next_status, 'pending_approval'::public.wo_status)
      end,
      updated_at = now()
  where target_work_order.id = invoice.work_order_id
    and target_work_order.deleted_at is null
    and target_work_order.contractor_id = invoice.contractor_id
    and target_work_order.contractor_assignment_started_at is not null
    and invoice.created_at >=
      target_work_order.contractor_assignment_started_at
  returning target_work_order.status into saved_work_order_status;

  if not found then
    raise exception 'Linked work order not found'
      using errcode = 'P0002';
  end if;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    invoice.work_order_id,
    actor_id,
    actor_name,
    format(
      'Invoice #%s rejection retracted and approved by %s.',
      invoice.num,
      actor_name
    ),
    'system',
    'invoice_rejection_retracted',
    jsonb_build_object(
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num,
      'outcome', 'rejection_retracted',
      'revision', invoice.review_revision,
      'previousState', 'rejected',
      'newState', 'approved',
      'rejectionReason', invoice.rejection_reason
    )
  );

  return jsonb_build_object(
    'invoiceId', invoice.id,
    'invoiceNum', invoice.num,
    'invoiceState', invoice.state,
    'workOrderId', invoice.work_order_id,
    'workOrderStatus', saved_work_order_status,
    'reviewRevision', invoice.review_revision,
    'rejectionReason', invoice.rejection_reason
  );
end;
$$;

revoke all on function public.review_contractor_invoice(uuid, text, text)
  from public, anon;
revoke all on function public.retract_contractor_invoice_rejection(uuid)
  from public, anon;

grant execute on function public.review_contractor_invoice(uuid, text, text),
  public.retract_contractor_invoice_rejection(uuid)
  to authenticated, service_role;

commit;
