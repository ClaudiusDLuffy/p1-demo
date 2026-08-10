-- Rejected contractor invoices must remain unresolved until the contractor
-- corrects and resubmits them, or staff explicitly retracts the rejection.
-- Every review transition is atomic, state-checked, and audited per invoice.

begin;

alter table public.invoices
  add column if not exists review_revision integer not null default 1,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references public.profiles(id),
  add column if not exists resubmitted_at timestamptz,
  add column if not exists resubmitted_by uuid references public.profiles(id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoices_review_revision_positive'
      and conrelid = 'public.invoices'::regclass
  ) then
    alter table public.invoices
      add constraint invoices_review_revision_positive
      check (review_revision > 0);
  end if;
end
$$;

comment on column public.invoices.review_revision is
  'Starts at one and increments each time a rejected contractor invoice is resubmitted.';
comment on column public.invoices.rejected_at is
  'Most recent rejection timestamp. Historical rejections remain in activities.';
comment on column public.invoices.rejected_by is
  'Staff profile responsible for the most recent rejection.';
comment on column public.invoices.resubmitted_at is
  'Most recent contractor resubmission timestamp.';
comment on column public.invoices.resubmitted_by is
  'Actual signed-in contractor member responsible for the latest resubmission.';

-- One shared rule for every caller: drafts do not participate; any submitted,
-- revised, or rejected invoice keeps review open. The WO is ready for P1
-- billing only when every live contractor invoice is approved or paid.
create or replace function public.contractor_invoice_work_order_status(
  p_work_order_id text
)
returns public.wo_status
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when not exists (
      select 1
      from public.invoices invoice
      where invoice.work_order_id = p_work_order_id
        and invoice.invoice_type = 'contractor'
        and invoice.deleted_at is null
        and invoice.state <> 'draft'
    ) then null
    when exists (
      select 1
      from public.invoices invoice
      where invoice.work_order_id = p_work_order_id
        and invoice.invoice_type = 'contractor'
        and invoice.deleted_at is null
        and invoice.state <> 'draft'
        and invoice.state not in ('approved', 'paid')
    ) then 'pending_approval'::public.wo_status
    else 'pending_invoice'::public.wo_status
  end
$$;

-- Repair review-stage work orders that the former client-side aggregate moved
-- forward while a rejected invoice still existed. Closed and operational
-- work orders are intentionally left untouched.
update public.work_orders work_order
set status = public.contractor_invoice_work_order_status(work_order.id),
    updated_at = now()
where work_order.deleted_at is null
  and work_order.status in ('pending_invoice', 'pending_approval')
  and public.contractor_invoice_work_order_status(work_order.id) is not null
  and work_order.status is distinct from
    public.contractor_invoice_work_order_status(work_order.id);

-- Older clients wrote this aggregate after approving one sibling even when a
-- previously rejected sibling was still unresolved. Hide only entries that
-- can be proven false: a currently rejected invoice has its own earlier,
-- invoice-number-specific rejection activity on the same work order.
update public.activities aggregate_activity
set deleted_at = now()
where aggregate_activity.deleted_at is null
  and aggregate_activity.text =
    'All contractor invoices are approved — ready for P1 billing.'
  and exists (
    select 1
    from public.invoices rejected_invoice
    join public.activities rejection_activity
      on rejection_activity.work_order_id = rejected_invoice.work_order_id
     and rejection_activity.deleted_at is null
     and rejection_activity.created_at <= aggregate_activity.created_at
     and rejection_activity.text like
       'Invoice #' || rejected_invoice.num || ' rejected by %'
    where rejected_invoice.work_order_id = aggregate_activity.work_order_id
      and rejected_invoice.invoice_type = 'contractor'
      and rejected_invoice.deleted_at is null
      and rejected_invoice.state = 'rejected'
  );

-- State changes outside these RPCs are rejected. The transition marker is
-- transaction-local and is set only inside the SECURITY DEFINER functions
-- below. Draft submission and QuickBooks handoff retain their existing paths.
create or replace function public.protect_contractor_invoice_review_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transition_kind text := coalesce(
    current_setting('app.contractor_invoice_transition', true),
    ''
  );
  actor_is_staff boolean := public.is_staff();
begin
  if new.invoice_type <> 'contractor' then
    return new;
  end if;

  if auth.role() in ('service_role', '') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not actor_is_staff and (
      new.review_revision <> 1
      or new.rejected_at is not null
      or new.rejected_by is not null
      or new.rejection_reason is not null
      or new.resubmitted_at is not null
      or new.resubmitted_by is not null
    ) then
      raise exception 'Contractors cannot set invoice review metadata'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.invoice_type <> 'contractor' then
    return new;
  end if;

  if new.review_revision is distinct from old.review_revision
     and transition_kind <> 'resubmit' then
    raise exception 'Invoice review revision can only change during resubmission'
      using errcode = '42501';
  end if;

  if (
    new.rejected_at is distinct from old.rejected_at
    or new.rejected_by is distinct from old.rejected_by
    or new.rejection_reason is distinct from old.rejection_reason
  ) and transition_kind <> 'review' then
    raise exception 'Invoice rejection metadata can only change during staff review'
      using errcode = '42501';
  end if;

  if (
    new.resubmitted_at is distinct from old.resubmitted_at
    or new.resubmitted_by is distinct from old.resubmitted_by
  ) and transition_kind <> 'resubmit' then
    raise exception 'Invoice resubmission metadata can only change during resubmission'
      using errcode = '42501';
  end if;

  if new.state is not distinct from old.state then
    return new;
  end if;

  if old.state = 'draft'
     and new.state = 'submitted' then
    if not actor_is_staff
       and not public.can_invoice_for_contractor(old.contractor_id) then
      raise exception 'This contractor account cannot submit invoices'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.state in ('submitted', 'revised')
     and new.state in ('approved', 'rejected')
     and transition_kind = 'review'
     and actor_is_staff
     and not public.is_invoice_controller() then
    if new.state = 'rejected'
       and nullif(trim(coalesce(new.rejection_reason, '')), '') is null then
      raise exception 'A rejection reason is required'
        using errcode = '22023';
    end if;
    return new;
  end if;

  if old.state = 'rejected'
     and new.state = 'approved'
     and transition_kind = 'undo_rejection'
     and actor_is_staff
     and not public.is_invoice_controller() then
    return new;
  end if;

  if old.state = 'rejected'
     and new.state = 'revised'
     and transition_kind = 'resubmit'
     and not actor_is_staff
     and public.can_invoice_for_contractor(old.contractor_id)
     and public.can_access_contractor_work_order(old.work_order_id) then
    return new;
  end if;

  if old.state = 'approved'
     and new.state = 'paid'
     and actor_is_staff then
    return new;
  end if;

  raise exception 'Invoice cannot move from % to % in this operation',
    old.state, new.state
    using errcode = '42501';
end;
$$;

drop trigger if exists protect_contractor_invoice_review_lifecycle_trigger
  on public.invoices;
create trigger protect_contractor_invoice_review_lifecycle_trigger
  before insert or update on public.invoices
  for each row execute function public.protect_contractor_invoice_review_lifecycle();

-- Include resubmissions in the same staff follow-up stream as initial
-- contractor invoice submissions.
create or replace function public.stamp_activity_actor_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  assigned_contractor uuid;
  syncable_event boolean;
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

  syncable_event := new.event_key in (
    'note', 'check_in', 'check_out', 'job_paused', 'job_completed',
    'status_change', 'eta_updated', 'technician_updated',
    'part_added', 'part_updated', 'part_removed',
    'photo_added', 'photo_removed', 'invoice_submitted',
    'invoice_resubmitted'
  );

  if new.entered_by_role = 'contractor'
     or new.is_staff_override then
    new.requires_7eleven_sync := syncable_event;
  elsif new.entered_by_role not in ('manager', 'dispatcher', 'back_office') then
    new.requires_7eleven_sync := false;
  end if;

  if not new.requires_7eleven_sync then
    new.synced_to_7eleven_at := null;
    new.synced_to_7eleven_by := null;
  end if;

  return new;
end;
$$;

-- Invoice activity can contain invoice numbers, correction reasons, totals,
-- and PDF metadata. Company admins and invoice-capable members may read it;
-- report-only technicians may not, even through the raw activities API.
drop policy if exists act_read on public.activities;
create policy act_read on public.activities
  for select using (
    public.is_staff()
    or (
      is_staff_only = false
      and public.can_access_contractor_work_order(work_order_id)
      and exists (
        select 1
        from public.work_orders work_order
        where work_order.id = activities.work_order_id
          and work_order.contractor_assignment_started_at is not null
          and activities.contractor_assignment_version
            = work_order.contractor_assignment_version
          and activities.created_at >= work_order.contractor_assignment_started_at
      )
      and (
        not (
          coalesce(event_key, '') in (
            'invoice_draft',
            'invoice_uploaded',
            'invoice_submitted',
            'invoice_resubmitted',
            'invoice_approved',
            'invoice_rejected',
            'invoice_rejection_retracted',
            'contractor_invoice_total_corrected',
            'invoice_deleted',
            'staff_billing'
          )
          or coalesce(text, '') ~*
            'invoice.*(draft|upload|submit|approv|reject|resubmit|billing|quickbooks|total)'
        )
        or exists (
          select 1
          from public.work_orders invoice_work_order
          where invoice_work_order.id = activities.work_order_id
            and public.can_invoice_for_contractor(
              invoice_work_order.contractor_id
            )
        )
      )
    )
  );

-- A report-only technician may acknowledge normal job-action alerts, but not
-- an invoice rejection intended for company admins/invoice users.
create or replace function public.acknowledge_contractor_attention(
  p_activity_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  update public.activities activity
  set contractor_attention_acknowledged_at = now(),
      contractor_attention_acknowledged_by = auth.uid()
  where activity.id = p_activity_id
    and activity.requires_contractor_attention = true
    and activity.contractor_attention_acknowledged_at is null
    and activity.deleted_at is null
    and public.can_access_contractor_work_order(activity.work_order_id)
    and (
      coalesce(activity.event_key, '') <> 'invoice_rejected'
      or exists (
        select 1
        from public.work_orders invoice_work_order
        where invoice_work_order.id = activity.work_order_id
          and public.can_invoice_for_contractor(
            invoice_work_order.contractor_id
          )
      )
    )
    and exists (
      select 1
      from public.work_orders work_order
      where work_order.id = activity.work_order_id
        and work_order.contractor_assignment_started_at is not null
        and activity.contractor_assignment_version
          = work_order.contractor_assignment_version
        and activity.created_at >= work_order.contractor_assignment_started_at
    );

  if not found then
    raise exception 'Pending contractor attention item not found'
      using errcode = '42501';
  end if;
end;
$$;

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

  -- A review activity is contractor-visible. Lock and verify the current
  -- assignment before writing it so a historical invoice can never expose a
  -- prior contractor's identity or rejection reason to the receiving company.
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

  update public.work_orders work_order
  set status = case
        when work_order.status = 'closed' then work_order.status
        else coalesce(next_status, 'pending_approval'::public.wo_status)
      end,
      updated_at = now()
  where work_order.id = invoice.work_order_id
    and work_order.deleted_at is null
    and work_order.contractor_id = invoice.contractor_id
    and work_order.contractor_assignment_started_at is not null
    and invoice.created_at >= work_order.contractor_assignment_started_at
  returning work_order.status into saved_work_order_status;

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

create or replace function public.resubmit_rejected_contractor_invoice(
  p_invoice_id uuid,
  p_cme text,
  p_store_address text,
  p_invoice_date date,
  p_service_date date,
  p_terms text,
  p_sales_tax numeric,
  p_total_override numeric,
  p_lines jsonb,
  p_pdf_storage_path text default null
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
  saved_work_order_status public.wo_status;
  line_count integer := 0;
  v_invoice_subtotal numeric(10,2);
  v_invoice_tax numeric(10,2) := round(greatest(coalesce(p_sales_tax, 0), 0), 2);
  v_invoice_total numeric(10,2);
  replacement_pdf_path text := nullif(trim(coalesce(p_pdf_storage_path, '')), '');
begin
  if actor_id is null then
    raise exception 'Contractor authentication is required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.role = 'contractor'
    and profile.active = true;

  if not found then
    raise exception 'Active contractor profile not found'
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
    raise exception 'Invoice changed before it could be resubmitted; current state is %',
      invoice.state
      using errcode = '40001';
  end if;

  if not public.can_invoice_for_contractor(invoice.contractor_id)
     or not public.can_access_contractor_work_order(invoice.work_order_id) then
    raise exception 'You cannot resubmit this contractor invoice'
      using errcode = '42501';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = invoice.work_order_id
    and candidate.contractor_id = invoice.contractor_id
    and candidate.deleted_at is null
    and candidate.contractor_assignment_started_at is not null
    and invoice.created_at >= candidate.contractor_assignment_started_at
  for update;

  if not found then
    raise exception 'This work order is no longer assigned to your company'
      using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Invoice lines must be an array'
      using errcode = '22023';
  end if;

  select
    count(*)::integer,
    round(
      coalesce(
        sum(
          round(coalesce(line.qty, 1), 2)
          * round(coalesce(line.rate, 0), 2)
        ),
        0
      ),
      2
    )
  into line_count, v_invoice_subtotal
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
    as line(type text, description text, qty numeric, rate numeric);

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as line(type text, description text, qty numeric, rate numeric)
    where coalesce(line.qty, 0) <= 0
       or coalesce(line.rate, -1) < 0
  ) then
    raise exception 'Invoice lines require a positive quantity and non-negative rate'
      using errcode = '22023';
  end if;

  if p_total_override is not null then
    v_invoice_total := round(p_total_override, 2);
    v_invoice_subtotal := greatest(v_invoice_total - v_invoice_tax, 0);
  else
    v_invoice_total := v_invoice_subtotal + v_invoice_tax;
  end if;

  if v_invoice_total <= 0 then
    raise exception 'Invoice total must be greater than zero'
      using errcode = '22023';
  end if;

  if line_count = 0
     and replacement_pdf_path is null
     and invoice.pdf_storage_path is null then
    raise exception 'Invoice lines or an invoice PDF are required'
      using errcode = '22023';
  end if;

  if replacement_pdf_path is not null then
    if split_part(replacement_pdf_path, '/', 1) <> invoice.id::text
       or not exists (
         select 1
         from storage.objects object
         where object.bucket_id = 'invoice-pdfs'
           and object.name = replacement_pdf_path
       ) then
      raise exception 'Replacement invoice PDF was not found'
        using errcode = '22023';
    end if;
  end if;

  perform set_config('app.contractor_invoice_transition', 'resubmit', true);

  update public.invoices candidate
  set cme = nullif(trim(coalesce(p_cme, '')), ''),
      store_address = coalesce(
        nullif(trim(coalesce(p_store_address, '')), ''),
        candidate.store_address
      ),
      invoice_date = coalesce(p_invoice_date, candidate.invoice_date),
      service_date = p_service_date,
      terms = coalesce(nullif(trim(coalesce(p_terms, '')), ''), 'Net 30'),
      state = 'revised',
      subtotal = v_invoice_subtotal,
      sales_tax = v_invoice_tax,
      total = v_invoice_total,
      pdf_storage_path = coalesce(replacement_pdf_path, candidate.pdf_storage_path),
      review_revision = candidate.review_revision + 1,
      resubmitted_at = now(),
      resubmitted_by = actor_id,
      updated_at = now()
  where candidate.id = invoice.id
    and candidate.state = 'rejected'
  returning candidate.* into invoice;

  if not found then
    raise exception 'Invoice changed before it could be resubmitted'
      using errcode = '40001';
  end if;

  delete from public.invoice_lines line
  where line.invoice_id = invoice.id;

  if line_count > 0 then
    insert into public.invoice_lines (
      invoice_id,
      position,
      type,
      description,
      qty,
      rate
    )
    select
      invoice.id,
      line.ordinality::integer,
      coalesce(nullif(trim(line.item ->> 'type'), ''), 'Other'),
      coalesce(line.item ->> 'description', ''),
      round(coalesce(nullif(line.item ->> 'qty', '')::numeric, 1), 2),
      round(coalesce(nullif(line.item ->> 'rate', '')::numeric, 0), 2)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
      with ordinality as line(item, ordinality);
  end if;

  update public.work_orders candidate
  set status = case
        when candidate.status = 'closed' then candidate.status
        else 'pending_approval'::public.wo_status
      end,
      invoice_total = v_invoice_total,
      updated_at = now()
  where candidate.id = work_order.id
  returning candidate.status into saved_work_order_status;

  update public.activities activity
  set contractor_attention_acknowledged_at = now(),
      contractor_attention_acknowledged_by = actor_id
  where activity.work_order_id = work_order.id
    and activity.event_key = 'invoice_rejected'
    and activity.event_data ->> 'invoiceId' = invoice.id::text
    and activity.requires_contractor_attention = true
    and activity.contractor_attention_acknowledged_at is null
    and activity.deleted_at is null;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    work_order.id,
    actor_id,
    actor_name,
    format(
      'Invoice #%s corrected and resubmitted by %s.',
      invoice.num,
      actor_name
    ),
    'system',
    'invoice_resubmitted',
    jsonb_build_object(
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num,
      'outcome', 'resubmitted',
      'revision', invoice.review_revision,
      'previousState', 'rejected',
      'newState', 'revised',
      'total', invoice.total,
      'pdfReplaced', replacement_pdf_path is not null
    )
  );

  return jsonb_build_object(
    'invoiceId', invoice.id,
    'invoiceNum', invoice.num,
    'invoiceState', invoice.state,
    'workOrderId', invoice.work_order_id,
    'workOrderStatus', saved_work_order_status,
    'reviewRevision', invoice.review_revision,
    'total', invoice.total,
    'pdfStoragePath', invoice.pdf_storage_path
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

  update public.work_orders work_order
  set status = case
        when work_order.status = 'closed' then work_order.status
        else coalesce(next_status, 'pending_approval'::public.wo_status)
      end,
      updated_at = now()
  where work_order.id = invoice.work_order_id
    and work_order.deleted_at is null
    and work_order.contractor_id = invoice.contractor_id
    and work_order.contractor_assignment_started_at is not null
    and invoice.created_at >= work_order.contractor_assignment_started_at
  returning work_order.status into saved_work_order_status;

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

-- Contractors may stage a versioned replacement object only while the invoice
-- is rejected. The resubmission RPC verifies the object and attaches it in the
-- same transaction that replaces the lines and changes the state to revised.
drop policy if exists invoice_pdfs_insert on storage.objects;
create policy invoice_pdfs_insert on storage.objects
  for insert with check (
    bucket_id = 'invoice-pdfs'
    and (
      (
        public.is_staff()
        and not public.is_invoice_controller()
      )
      or exists (
        select 1
        from public.invoices invoice
        join public.work_orders work_order
          on work_order.id = invoice.work_order_id
        where invoice.id::text = split_part(name, '/', 1)
          and invoice.invoice_type = 'contractor'
          and invoice.deleted_at is null
          and invoice.state in ('draft', 'submitted', 'rejected')
          and public.can_invoice_for_contractor(invoice.contractor_id)
          and public.can_access_contractor_work_order(invoice.work_order_id)
          and work_order.contractor_id = invoice.contractor_id
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and invoice.created_at >= work_order.contractor_assignment_started_at
      )
    )
  );

revoke all on function public.contractor_invoice_work_order_status(text)
  from public, anon;
revoke all on function public.review_contractor_invoice(uuid, text, text)
  from public, anon;
revoke all on function public.resubmit_rejected_contractor_invoice(
  uuid, text, text, date, date, text, numeric, numeric, jsonb, text
) from public, anon;
revoke all on function public.retract_contractor_invoice_rejection(uuid)
  from public, anon;

grant execute on function public.review_contractor_invoice(uuid, text, text),
  public.resubmit_rejected_contractor_invoice(
    uuid, text, text, date, date, text, numeric, numeric, jsonb, text
  ),
  public.retract_contractor_invoice_rejection(uuid)
  to authenticated, service_role;

grant execute on function public.contractor_invoice_work_order_status(text)
  to service_role;

commit;
