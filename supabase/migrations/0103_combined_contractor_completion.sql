-- Give invoice-capable contractors one atomic final action that completes
-- field work and confirms the current contractor invoice set. The existing
-- underlying states remain separate because staff queues and audit flags rely
-- on them, but the contractor can no longer leave the workflow half-finished.

begin;

create or replace function public.complete_contractor_work_and_invoicing(
  p_work_order_id text,
  p_completed_at timestamptz,
  p_asset_make text,
  p_asset_model text,
  p_asset_serial text,
  p_asset_year integer,
  p_resolution_code text,
  p_resolution_notes text,
  p_activity_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_account_id uuid := public.current_contractor_account_id();
  v_work_order public.work_orders%rowtype;
  v_work_completion jsonb;
  v_invoicing_completion jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  select profile.*
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role = 'contractor';

  if not found then
    raise exception 'Active contractor access is required'
      using errcode = '42501';
  end if;

  if v_account_id is null
     or not public.can_invoice_for_contractor(v_account_id)
     or not public.can_access_contractor_work_order(p_work_order_id) then
    raise exception 'Invoice access is required for this work order'
      using errcode = '42501';
  end if;

  -- This lock is shared by invoice submission, work completion, and invoicing
  -- completion. It prevents a concurrent invoice edit from slipping between
  -- the two underlying transitions.
  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.contractor_id is distinct from v_account_id then
    raise exception 'This work order is not assigned to your company'
      using errcode = '42501';
  end if;

  if coalesce(v_work_order.billing_only, false) then
    raise exception 'Billing-only work orders do not require field-work completion'
      using errcode = '22023';
  end if;

  if v_work_order.status in (
    'assigned',
    'parts',
    'closed',
    'capital',
    'pending_capital_completion'
  ) then
    raise exception 'This work order cannot be completed from its current status'
      using errcode = '22023';
  end if;

  -- Existing completed work orders can use this action to finish the second
  -- half of the legacy two-step flow without rewriting their completion data.
  if v_work_order.functional_status::text <> 'Completed'
     and (
       nullif(trim(coalesce(p_asset_make, '')), '') is null
       or nullif(trim(coalesce(p_asset_model, '')), '') is null
       or nullif(trim(coalesce(p_asset_serial, '')), '') is null
     ) then
    raise exception 'Equipment make, model, and serial number are required'
      using errcode = '22023';
  end if;

  -- Both calls run in this function's transaction. Any invoice validation
  -- failure in the second call rolls the work-completion call back as well.
  -- Legacy records may already have their independent field-completion state;
  -- do not rewrite their asset, visit, or completion timestamps.
  if v_work_order.functional_status::text = 'Completed' then
    v_work_completion := jsonb_build_object(
      'applied', false,
      'reason', 'already_completed'
    );
  else
    v_work_completion := public.complete_work_order_once(
      p_work_order_id,
      p_completed_at,
      p_asset_make,
      p_asset_model,
      p_asset_serial,
      p_asset_year,
      p_resolution_code,
      p_resolution_notes,
      p_activity_text
    );
  end if;

  v_invoicing_completion := public.finish_contractor_invoicing(
    p_work_order_id
  );

  return coalesce(v_invoicing_completion, '{}'::jsonb)
    || jsonb_build_object(
      'workCompletionApplied',
        coalesce((v_work_completion ->> 'applied')::boolean, false),
      'workCompletionReason', v_work_completion ->> 'reason',
      'completionActivityId', v_work_completion ->> 'activityId',
      'invoicingCompletionApplied',
        coalesce((v_invoicing_completion ->> 'applied')::boolean, false)
    );
end;
$$;

revoke all on function public.complete_contractor_work_and_invoicing(
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  text,
  text,
  text
) from public, anon;

grant execute on function public.complete_contractor_work_and_invoicing(
  text,
  timestamptz,
  text,
  text,
  text,
  integer,
  text,
  text,
  text
) to authenticated, service_role;

commit;
