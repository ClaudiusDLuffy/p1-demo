-- A repeated initial dispatch can include refreshed provider metadata as well
-- as a priority escalation. Keep both changes in the same family-locked
-- transaction so a concurrent reassignment copy cannot inherit half a refresh.
begin;

alter table public.email_priority_escalation_events
  add column if not exists assignment_removal_delivery_id uuid
    constraint email_priority_escalation_assignment_removal_delivery_fkey
    references public.contractor_assignment_transition_deliveries(id) on delete restrict;
create unique index if not exists email_priority_assignment_removal_delivery_unique
  on public.email_priority_escalation_events(assignment_removal_delivery_id)
  where assignment_removal_delivery_id is not null;

create or replace function public.refresh_email_work_order_dispatch(
  p_work_order_id text,
  p_reported_priority text,
  p_source_message_id text,
  p_source_received_at timestamptz,
  p_source_subject text,
  p_expected_sla_started_at timestamptz,
  p_response_breach_at timestamptz,
  p_resolution_breach_at timestamptz,
  p_intake_patch jsonb,
  p_afm_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_patch public.work_orders%rowtype;
  v_work_order public.work_orders%rowtype;
  v_afm_email text := nullif(trim(coalesce(p_afm_email, '')), '');
  v_assignment_delivery_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  if p_intake_patch is null or jsonb_typeof(p_intake_patch) <> 'object' then
    raise exception 'Dispatch refresh must be an object' using errcode = '22023';
  end if;
  if octet_length(p_intake_patch::text) > 262144
     or coalesce(length(v_afm_email), 0) > 320 then
    raise exception 'Dispatch refresh is too large' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_intake_patch) key_name
    where key_name <> all(array[
      'incident_id', 'store_number', 'summary', 'description', 'afm_name',
      'city', 'address', 'store_state', 'store_timezone', 'nte',
      'line_of_service', 'business_service', 'category', 'sub_category',
      'source', 'status', 'functional_status', 'contractor_id',
      'assigned_technician_profile_id', 'technician_on_job',
      'technician_assigned_at', 'technician_assigned_by',
      'contractor_assignment_started_at', 'eta', 'dispatched_at',
      'sla_started_at', 'billing_only', 'billing_ready_at', 'billing_ready_by'
    ])
  ) then
    raise exception 'Dispatch refresh contains unsupported fields' using errcode = '22023';
  end if;

  -- Locks taken by the inner RPC persist until this outer transaction ends.
  v_result := public.apply_email_work_order_priority_escalation(
    p_work_order_id, p_reported_priority, p_source_message_id,
    p_source_received_at, p_source_subject, p_expected_sla_started_at,
    p_response_breach_at, p_resolution_breach_at
  );

  -- Replayed or old messages cannot overwrite newer provider details. Closed
  -- and billing-stage work remains historical; do not refresh its metadata.
  if (v_result ->> 'replayed')::boolean
     or v_result ->> 'outcome' in ('stale', 'non_operational') then
    return v_result || jsonb_build_object('metadataRefreshed', false);
  end if;

  select * into v_work_order
  from public.work_orders
  where id = v_result ->> 'workOrderId' and deleted_at is null
  for update;
  if not found then
    raise exception 'Active work order changed during dispatch refresh'
      using errcode = 'PT409';
  end if;

  v_patch := jsonb_populate_record(v_work_order, p_intake_patch);
  -- Only the existing DO NOT DISPATCH path may carry lifecycle fields.
  -- Their values are derived here, not accepted individually from a patch.
  if p_intake_patch ?| array[
    'status', 'functional_status', 'contractor_id',
    'assigned_technician_profile_id', 'technician_on_job',
    'technician_assigned_at', 'technician_assigned_by',
    'contractor_assignment_started_at', 'eta', 'dispatched_at',
    'sla_started_at', 'billing_ready_at', 'billing_ready_by'
  ] and p_intake_patch -> 'billing_only' is distinct from 'true'::jsonb then
    raise exception 'Lifecycle fields require a billing-only dispatch' using errcode = '22023';
  end if;
  if p_intake_patch ? 'billing_only'
     and p_intake_patch -> 'billing_only' is distinct from 'true'::jsonb then
    raise exception 'Dispatch refresh cannot clear billing-only status' using errcode = '22023';
  end if;

  update public.work_orders
  set incident_id = v_patch.incident_id,
      store_number = v_patch.store_number,
      summary = v_patch.summary,
      description = v_patch.description,
      afm_name = v_patch.afm_name,
      city = v_patch.city,
      address = v_patch.address,
      store_state = v_patch.store_state,
      store_timezone = v_patch.store_timezone,
      nte = v_patch.nte,
      line_of_service = v_patch.line_of_service,
      business_service = v_patch.business_service,
      category = v_patch.category,
      sub_category = v_patch.sub_category,
      source = 'email_intake'
  where id = v_work_order.id;

  if p_intake_patch -> 'billing_only' = 'true'::jsonb then
    -- The assignment-boundary trigger intentionally resets unassignment to
    -- New/unassigned. Let it archive the outgoing assignment first, then set
    -- the billing destination in this same transaction without changing the
    -- contractor again. Combining these updates loses pending_invoice.
    update public.work_orders
    set contractor_id = null
    where id = v_work_order.id and contractor_id is not null;

    update public.work_orders
    set status = 'pending_invoice',
        functional_status = 'Completed',
        contractor_id = null,
        assigned_technician_profile_id = null,
        technician_on_job = null,
        technician_assigned_at = null,
        technician_assigned_by = null,
        contractor_assignment_started_at = null,
        eta = null,
        dispatched_at = null,
        sla_started_at = null,
        response_breach_at = null,
        resolution_breach_at = null,
        billing_only = true,
        billing_ready_at = p_source_received_at,
        billing_ready_by = null
    where id = v_work_order.id;

    insert into public.activities (
      work_order_id, author_name, text, type, is_staff_only, event_key
    ) values (
      v_work_order.id, 'System',
      '7-Eleven marked this work order DO NOT DISPATCH. Routed to billing; any current contractor assignment was removed.',
      'system', true, 'straight_to_billing'
    );

    if v_work_order.contractor_id is not null then
      select delivery.id into strict v_assignment_delivery_id
      from public.contractor_assignment_transition_deliveries delivery
      where delivery.event_key = 'assignment:' || v_work_order.id || ':'
          || v_work_order.contractor_assignment_version::text
        and delivery.transition_type = 'unassigned'
        and delivery.outgoing_contractor_id = v_work_order.contractor_id
        and delivery.initiated_by is null;
    end if;
  end if;

  if v_afm_email is not null then
    insert into public.work_order_afm_contacts (work_order_id, afm_email)
    values (v_work_order.id, v_afm_email)
    on conflict (work_order_id) do update set afm_email = excluded.afm_email;
  end if;

  -- The notice snapshot should describe the details committed with priority.
  update public.email_priority_escalation_events
  set incident_id = v_patch.incident_id,
      store_number = v_patch.store_number,
      store_state = v_patch.store_state,
      city = v_patch.city,
      address = v_patch.address,
      summary = v_patch.summary,
      assignment_removal_delivery_id = v_assignment_delivery_id
  where id = (v_result ->> 'eventId')::uuid;

  return v_result || jsonb_build_object('metadataRefreshed', true);
end;
$$;

revoke all on function public.refresh_email_work_order_dispatch(
  text, text, text, timestamptz, text, timestamptz, timestamptz, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.refresh_email_work_order_dispatch(
  text, text, text, timestamptz, text, timestamptz, timestamptz, timestamptz, jsonb, text
) to service_role;

-- Email intake has no staff identity. It may claim only the exact unassignment
-- produced in its own locked refresh, not impersonate staff or drain their queue.
create or replace function public.claim_email_assignment_removal_delivery(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery public.contractor_assignment_transition_deliveries%rowtype;
  v_claim_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  select delivery.* into v_delivery
  from public.contractor_assignment_transition_deliveries delivery
  where delivery.id = p_delivery_id
    and delivery.transition_type = 'unassigned'
    and delivery.initiated_by is null
    and exists (
      select 1 from public.email_priority_escalation_events event
      where event.assignment_removal_delivery_id = delivery.id
        and event.work_order_id = delivery.work_order_id
    )
  for update;
  if not found then
    raise exception 'Intake-owned assignment removal not found' using errcode = '42501';
  end if;
  if v_delivery.status = 'pending' then
    update public.contractor_assignment_transition_deliveries
    set status = 'claimed', claimed_at = clock_timestamp()
    where id = v_delivery.id returning * into v_delivery;
    v_claim_status := 'new_claim';
  elsif v_delivery.status = 'sent' then
    v_claim_status := 'already_sent';
  elsif v_delivery.status = 'unknown' then
    v_claim_status := 'delivery_unknown';
  elsif v_delivery.status = 'skipped' then
    v_claim_status := 'not_deliverable';
  else
    v_claim_status := 'pending_or_unknown';
  end if;
  return jsonb_build_object(
    'claimStatus', v_claim_status, 'deliveryId', v_delivery.id,
    'workOrderId', v_delivery.work_order_id,
    'externalWorkOrderId', v_delivery.external_work_order_id,
    'portalWorkOrderId', v_delivery.work_order_id,
    'outgoingContractorId', v_delivery.outgoing_contractor_id,
    'outgoingContractorName', v_delivery.outgoing_contractor_name,
    'outgoingContractorCompany', v_delivery.outgoing_contractor_company,
    'outgoingContractorEmail', v_delivery.outgoing_contractor_email,
    'transitionType', v_delivery.transition_type,
    'transitionedAt', v_delivery.created_at
  );
end;
$$;
revoke all on function public.claim_email_assignment_removal_delivery(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_email_assignment_removal_delivery(uuid)
  to service_role;

commit;
