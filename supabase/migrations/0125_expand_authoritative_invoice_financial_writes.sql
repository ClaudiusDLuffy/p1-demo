-- Batch 1C expansion: authoritative, versioned, idempotent invoice writes.
--
-- Apply after 0122 and 0123. This phase adds the replacement RPCs and their
-- evidence ledger while leaving legacy table grants available for the
-- compatible application rollout. Migration 0125 performs the contraction.

begin;

do $prerequisites$
begin
  if to_regclass('public.work_order_lifecycle_control') is null
     or to_regprocedure(
       'public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])'
     ) is null then
    raise exception 'Migrations 0122/0123 and the current staff invoice save must exist before 0124';
  end if;
end
$prerequisites$;

alter table public.invoices
  add column invoice_version bigint not null default 0
  check (invoice_version >= 0);

create table public.invoice_financial_control (
  singleton boolean primary key default true check (singleton),
  contracted boolean not null default false
);

insert into public.invoice_financial_control(singleton, contracted)
values (true, false);

create table public.invoice_financial_operations (
  operation_id uuid primary key,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  command_kind text not null check (command_kind in (
    'contractor_draft',
    'contractor_submit',
    'contractor_revise',
    'contractor_delete',
    'staff_save',
    'admin_delete'
  )),
  requested_invoice_id uuid,
  invoice_id uuid references public.invoices(id) on delete restrict,
  invoice_type text not null check (invoice_type in ('contractor', 'staff')),
  work_order_id text references public.work_orders(id) on delete restrict,
  assignment_version integer,
  workflow_cycle integer,
  expected_invoice_version bigint,
  payload jsonb not null,
  result jsonb,
  invoice_snapshot jsonb,
  line_snapshot jsonb,
  source_snapshot jsonb,
  parent_snapshot jsonb,
  activity_snapshot jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint invoice_financial_operation_work_order_shape check (
    (
      work_order_id is null
      and assignment_version is null
      and workflow_cycle is null
    )
    or (
      work_order_id is not null
      and assignment_version is not null
      and assignment_version >= 0
      and workflow_cycle is not null
      and workflow_cycle >= 0
    )
  ),
  constraint invoice_financial_operation_version_shape check (
    expected_invoice_version is null or expected_invoice_version >= 0
  ),
  constraint invoice_financial_operation_outcome_complete check (
    (
      result is null
      and invoice_snapshot is null
      and line_snapshot is null
      and source_snapshot is null
      and parent_snapshot is null
      and activity_snapshot is null
    )
    or (
      result is not null
      and invoice_id is not null
      and invoice_snapshot is not null
      and line_snapshot is not null
      and source_snapshot is not null
    )
  )
);

-- One UUID identifies one financial command family across invoice and
-- work-order-only commands.  This closes the otherwise separate-ledger hole
-- where the same client operation UUID could be replayed as a different
-- financial action.
create table public.financial_operation_claims (
  operation_id uuid primary key,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  command_kind text not null,
  created_at timestamptz not null default clock_timestamp()
);

create index invoice_financial_operations_target
  on public.invoice_financial_operations(
    invoice_id,
    work_order_id,
    created_at desc
  );

create table public.invoice_financial_transition_guards (
  id bigint generated always as identity primary key,
  transaction_id bigint not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  command_kind text not null,
  operation_id uuid references public.invoice_financial_operations(operation_id),
  invoice_id uuid references public.invoices(id) on delete cascade
    deferrable initially deferred,
  work_order_id text references public.work_orders(id) on delete cascade,
  header_allowed boolean not null default false,
  lines_allowed boolean not null default false,
  sources_allowed boolean not null default false,
  parent_allowed boolean not null default false,
  event_key text
);

create index invoice_financial_transition_guards_lookup
  on public.invoice_financial_transition_guards(
    transaction_id,
    invoice_id,
    work_order_id,
    command_kind
  );

alter table public.invoice_financial_control enable row level security;
alter table public.invoice_financial_operations enable row level security;
alter table public.invoice_financial_transition_guards enable row level security;
alter table public.financial_operation_claims enable row level security;

revoke all on public.invoice_financial_control,
  public.invoice_financial_operations,
  public.invoice_financial_transition_guards,
  public.financial_operation_claims
  from public, anon, authenticated, service_role;

create function public.invoice_financial_is_owner_maintenance()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select session_user in ('postgres', 'supabase_admin')
    and current_setting('role') in ('none', 'postgres', 'supabase_admin')
    and auth.uid() is null
    and coalesce(auth.role(), '') = '';
$$;

create function public.invoice_financial_invoice_snapshot(p_invoice_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- A later, separately authorized PDF attachment is not part of the save
  -- command's replay identity.  Its version bump is likewise omitted; every
  -- other header value and the complete child snapshots remain compared.
  select to_jsonb(invoice)
    - 'updated_at'
    - 'invoice_version'
    - 'pdf_storage_path'
  from public.invoices invoice
  where invoice.id = p_invoice_id;
$$;

create function public.invoice_financial_line_snapshot(p_invoice_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(to_jsonb(line) order by line.position, line.id),
    '[]'::jsonb
  )
  from public.invoice_lines line
  where line.invoice_id = p_invoice_id;
$$;

create function public.invoice_financial_source_snapshot(p_invoice_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(to_jsonb(source) order by source.contractor_invoice_id, source.id),
    '[]'::jsonb
  )
  from public.staff_invoice_sources source
  where source.staff_invoice_id = p_invoice_id;
$$;

create function public.invoice_financial_parent_snapshot(p_work_order_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', work_order.id,
    'status', work_order.status,
    'functionalStatus', work_order.functional_status,
    'invoiceTotal', work_order.invoice_total,
    'contractorId', work_order.contractor_id,
    'assignmentVersion', work_order.contractor_assignment_version,
    'workflowCycle', work_order.workflow_cycle,
    'lifecycleVersion', work_order.lifecycle_version,
    'contractorInvoicingCompletedAt', work_order.contractor_invoicing_completed_at,
    'contractorInvoicingCompletedBy', work_order.contractor_invoicing_completed_by,
    'contractorInvoicingAssignmentVersion', work_order.contractor_invoicing_assignment_version,
    'contractorInvoicingWorkflowCycle', work_order.contractor_invoicing_workflow_cycle,
    'contractorInvoicingCompletionSource', work_order.contractor_invoicing_completion_source,
    'closedAt', work_order.closed_at
  )
  from public.work_orders work_order
  where work_order.id = p_work_order_id;
$$;

create function public.invoice_financial_activity_snapshot(p_activity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(activity)
    - 'synced_to_7eleven_at'
    - 'synced_to_7eleven_by'
    - 'contractor_attention_acknowledged_at'
    - 'contractor_attention_acknowledged_by'
  from public.activities activity
  where activity.id = p_activity_id
    and activity.deleted_at is null;
$$;

create function public.invoice_financial_guard_exists(
  p_invoice_id uuid,
  p_work_order_id text,
  p_permission text,
  p_event_key text default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.invoice_financial_transition_guards guard
    where guard.transaction_id = txid_current()
      and (auth.uid() is null or guard.actor_id = auth.uid())
      and (
        guard.operation_id is null
        or exists (
          select 1
          from public.invoice_financial_operations operation
          where operation.operation_id = guard.operation_id
            and operation.actor_id = guard.actor_id
            and operation.command_kind = guard.command_kind
        )
      )
      and (
        p_invoice_id is null
        or guard.invoice_id = p_invoice_id
      )
      and guard.work_order_id is not distinct from p_work_order_id
      and case p_permission
        when 'header' then guard.header_allowed
        when 'lines' then guard.lines_allowed
        when 'sources' then guard.sources_allowed
        when 'parent' then guard.parent_allowed
        when 'event' then guard.event_key is not distinct from p_event_key
        else false
      end
  );
$$;

create function public.invoice_financial_creation_guard_id(
  p_work_order_id text,
  p_command_kinds text[]
)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select guard.id
  from public.invoice_financial_transition_guards guard
  where guard.transaction_id = txid_current()
    and guard.invoice_id is null
    and guard.work_order_id is not distinct from p_work_order_id
    and guard.command_kind = any(p_command_kinds)
    and guard.header_allowed
    and (auth.uid() is null or guard.actor_id = auth.uid())
    and (
      guard.operation_id is null
      or exists (
        select 1
        from public.invoice_financial_operations operation
        where operation.operation_id = guard.operation_id
          and operation.actor_id = guard.actor_id
          and operation.command_kind = guard.command_kind
      )
    )
  order by guard.id desc
  limit 1;
$$;

create function public.open_invoice_financial_guard(
  p_actor_id uuid,
  p_command_kind text,
  p_operation_id uuid,
  p_invoice_id uuid,
  p_work_order_id text,
  p_header_allowed boolean,
  p_lines_allowed boolean,
  p_sources_allowed boolean,
  p_parent_allowed boolean,
  p_event_key text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guard_id bigint;
begin
  insert into public.invoice_financial_transition_guards(
    transaction_id,
    actor_id,
    command_kind,
    operation_id,
    invoice_id,
    work_order_id,
    header_allowed,
    lines_allowed,
    sources_allowed,
    parent_allowed,
    event_key
  ) values (
    txid_current(),
    p_actor_id,
    p_command_kind,
    p_operation_id,
    p_invoice_id,
    p_work_order_id,
    p_header_allowed,
    p_lines_allowed,
    p_sources_allowed,
    p_parent_allowed,
    p_event_key
  )
  returning id into v_guard_id;

  return v_guard_id;
end;
$$;

create function public.write_contractor_invoice_v1(
  p_command_kind text,
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_invoice_id uuid,
  p_expected_invoice_version bigint,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_actor_id uuid := auth.uid();
  v_account_id uuid := public.current_contractor_account_id();
  v_work_order public.work_orders%rowtype;
  v_invoice public.invoices%rowtype;
  v_payload jsonb;
  v_replay jsonb;
  v_guard_id bigint;
  v_activity_id uuid;
  v_target_state public.invoice_state;
  v_subtotal numeric(10,2);
  v_sales_tax numeric(10,2);
  v_total numeric(10,2);
  v_line_count integer;
  v_num text;
  v_attempt integer := 0;
  v_pdf_path text;
  v_previous_state public.invoice_state;
begin
  if p_command_kind not in (
    'contractor_draft', 'contractor_submit', 'contractor_revise'
  ) then
    raise exception 'Unsupported contractor invoice command' using errcode = '22023';
  end if;
  if p_operation_id is null
     or nullif(btrim(coalesce(p_work_order_id, '')), '') is null
     or p_expected_assignment_version is null
     or p_expected_assignment_version < 0
     or p_expected_workflow_cycle is null
     or p_expected_workflow_cycle < 0
     or ((p_invoice_id is null) <> (p_expected_invoice_version is null))
     or coalesce(p_expected_invoice_version, 0) < 0
     or (p_command_kind = 'contractor_revise' and p_invoice_id is null) then
    raise exception 'Invoice identity and expected versions are required'
      using errcode = '22023';
  end if;

  v_payload := public.normalize_contractor_invoice_payload(p_payload);
  v_target_state := case p_command_kind
    when 'contractor_draft' then 'draft'::public.invoice_state
    when 'contractor_submit' then 'submitted'::public.invoice_state
    else 'revised'::public.invoice_state
  end;

  if v_actor_id is null or v_account_id is null then
    raise exception 'Contractor authentication is required' using errcode = '42501';
  end if;
  select profile.* into v_actor
  from public.profiles profile
  where profile.id = v_actor_id
    and profile.active = true
    and profile.role = 'contractor';
  if not found
     or not public.can_invoice_for_contractor(v_account_id)
     or not public.can_access_contractor_work_order(p_work_order_id) then
    raise exception 'Current contractor invoice access is required'
      using errcode = '42501';
  end if;

  -- Parent first, then invoice: every command and compatibility wrapper uses
  -- this order so review/export/delete cannot deadlock an editor.
  select work_order.* into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;
  if not found
     or v_work_order.contractor_id is distinct from v_account_id
     or v_work_order.contractor_assignment_version is distinct from
       p_expected_assignment_version
     or v_work_order.workflow_cycle is distinct from p_expected_workflow_cycle
     or not public.can_access_contractor_work_order(v_work_order.id) then
    raise exception 'Work order assignment changed. Refresh and try again.'
      using errcode = 'PT409';
  end if;

  if p_invoice_id is not null then
    select invoice.* into v_invoice
    from public.invoices invoice
    where invoice.id = p_invoice_id
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
    for update;
    if not found then
      raise exception 'Contractor invoice was not found' using errcode = 'P0002';
    end if;
    if v_invoice.work_order_id is distinct from v_work_order.id
       or v_invoice.contractor_id is distinct from v_account_id
       or v_work_order.contractor_assignment_started_at is null
       or v_invoice.created_at < v_work_order.contractor_assignment_started_at then
      raise exception 'Invoice is outside the current assignment'
        using errcode = '42501';
    end if;
  end if;

  v_replay := public.begin_invoice_financial_operation(
    p_operation_id,
    v_actor_id,
    p_command_kind,
    p_invoice_id,
    'contractor',
    v_work_order.id,
    p_expected_assignment_version,
    p_expected_workflow_cycle,
    p_expected_invoice_version,
    v_payload
  );
  if v_replay is not null then return v_replay; end if;

  if p_invoice_id is not null
     and v_invoice.invoice_version is distinct from p_expected_invoice_version then
    raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
  end if;
  if p_command_kind = 'contractor_draft'
     and p_invoice_id is not null
     and v_invoice.state <> 'draft' then
    raise exception 'Only a draft invoice can be saved as draft' using errcode = 'PT409';
  end if;
  if p_command_kind = 'contractor_submit'
     and p_invoice_id is not null
     and v_invoice.state <> 'draft' then
    raise exception 'Only a draft invoice can be submitted' using errcode = 'PT409';
  end if;
  if p_command_kind = 'contractor_revise'
     and v_invoice.state <> 'rejected' then
    raise exception 'Only a rejected invoice can be revised' using errcode = 'PT409';
  end if;

  select count(*)::integer,
    round(coalesce(sum(
      round((line.value ->> 'qty')::numeric, 2)
      * round((line.value ->> 'rate')::numeric, 2)
    ), 0), 2)
  into v_line_count, v_subtotal
  from jsonb_array_elements(v_payload -> 'lines') line;
  v_sales_tax := (v_payload ->> 'salesTax')::numeric;
  if v_payload ->> 'mode' = 'manual_pdf_total' then
    v_total := (v_payload ->> 'totalOverride')::numeric;
    v_subtotal := greatest(v_total - v_sales_tax, 0);
  else
    v_total := v_subtotal + v_sales_tax;
  end if;
  if v_total > 99999999.99 or v_subtotal > 99999999.99 then
    raise exception 'Invoice totals exceed the supported money range'
      using errcode = '22023';
  end if;

  if p_command_kind <> 'contractor_draft' then
    if v_total <= 0 then
      raise exception 'Submitted invoice total must be greater than zero'
        using errcode = '22023';
    end if;
    if v_payload ->> 'mode' = 'line_items' and (
      v_line_count = 0 or exists (
        select 1
        from jsonb_array_elements(v_payload -> 'lines') line
        where (line.value ->> 'qty')::numeric <= 0
          or (line.value ->> 'rate')::numeric < 0
          or (
            nullif(btrim(line.value ->> 'description'), '') is null
            and lower(btrim(line.value ->> 'type')) not in (
              'travel', 'truck charge'
            )
          )
      )
    ) then
      raise exception 'Submitted invoice lines require quantity, rate, and description'
        using errcode = '22023';
    end if;
  end if;

  v_pdf_path := v_payload ->> 'pdfStoragePath';
  if p_invoice_id is null and v_pdf_path is not null then
    raise exception 'Attach the invoice PDF after the invoice is created'
      using errcode = '22023';
  end if;
  if v_pdf_path is not null
     and v_pdf_path is distinct from v_invoice.pdf_storage_path
     and (
       split_part(v_pdf_path, '/', 1) <> p_invoice_id::text
       or not exists (
         select 1 from storage.objects object
         where object.bucket_id = 'invoice-pdfs' and object.name = v_pdf_path
       )
     ) then
    raise exception 'Invoice PDF was not found' using errcode = '22023';
  end if;

  v_guard_id := public.open_invoice_financial_guard(
    v_actor_id,
    p_command_kind,
    p_operation_id,
    p_invoice_id,
    v_work_order.id,
    true,
    true,
    false,
    true,
    case p_command_kind
      when 'contractor_draft' then 'invoice_draft'
      when 'contractor_submit' then 'invoice_submitted'
      else 'invoice_resubmitted'
    end
  );

  if p_invoice_id is null then
    if (v_payload ->> 'userTypedNum')::boolean then
      v_num := v_payload ->> 'num';
    else
      perform pg_advisory_xact_lock(hashtext('contractor-invoice-number'));
      v_num := public.next_contractor_invoice_num();
    end if;

    while v_attempt < 6 loop
      begin
        insert into public.invoices(
          num, work_order_id, store_number, store_address, contractor_id,
          cme, invoice_date, service_date, due_date, terms, state, subtotal,
          sales_tax, total, pdf_storage_path, created_by, invoice_type,
          submission_key
        ) values (
          v_num,
          v_work_order.id,
          v_work_order.store_number,
          coalesce(v_payload ->> 'storeAddress', v_work_order.address),
          v_account_id,
          v_payload ->> 'cme',
          coalesce((v_payload ->> 'invoiceDate')::date, current_date),
          (v_payload ->> 'serviceDate')::date,
          (v_payload ->> 'dueDate')::date,
          v_payload ->> 'terms',
          'draft',
          v_subtotal,
          v_sales_tax,
          v_total,
          null,
          v_actor_id,
          'contractor',
          p_operation_id
        ) returning * into v_invoice;
        exit;
      exception when unique_violation then
        if (v_payload ->> 'userTypedNum')::boolean then
          raise exception 'Invoice number already exists for this contractor'
            using errcode = '23505';
        end if;
        v_attempt := v_attempt + 1;
        v_num := public.next_contractor_invoice_num();
      end;
    end loop;
    if v_invoice.id is null then
      raise exception 'Could not allocate an unused invoice number'
        using errcode = '23505';
    end if;
    -- The BEFORE INSERT trigger binds the previously unbound creation guard
    -- to this exact UUID.  Assert that claim before any child writes.
    if not public.invoice_financial_guard_exists(
      v_invoice.id, v_work_order.id, 'header', null
    ) then
      raise exception 'Invoice creation capability was not bound'
        using errcode = '42501';
    end if;
  else
    v_previous_state := v_invoice.state;
    v_num := case
      when p_command_kind = 'contractor_revise' then v_invoice.num
      when (v_payload ->> 'userTypedNum')::boolean then v_payload ->> 'num'
      else v_invoice.num
    end;
    if p_command_kind = 'contractor_revise'
       and v_payload ->> 'num' is distinct from v_invoice.num then
      raise exception 'A rejected invoice keeps its original invoice number'
        using errcode = '22023';
    end if;
    if p_command_kind = 'contractor_revise' then
      perform set_config('app.contractor_invoice_transition', 'resubmit', true);
    end if;
    update public.invoices invoice
    set num = v_num,
        cme = v_payload ->> 'cme',
        store_address = coalesce(
          v_payload ->> 'storeAddress', invoice.store_address, v_work_order.address
        ),
        invoice_date = coalesce(
          (v_payload ->> 'invoiceDate')::date, invoice.invoice_date
        ),
        service_date = (v_payload ->> 'serviceDate')::date,
        due_date = (v_payload ->> 'dueDate')::date,
        terms = v_payload ->> 'terms',
        state = v_target_state,
        subtotal = v_subtotal,
        sales_tax = v_sales_tax,
        total = v_total,
        pdf_storage_path = coalesce(v_pdf_path, invoice.pdf_storage_path),
        submission_key = case when p_command_kind = 'contractor_draft'
          then invoice.submission_key
          else coalesce(invoice.submission_key, p_operation_id) end,
        review_revision = case when p_command_kind = 'contractor_revise'
          then invoice.review_revision + 1 else invoice.review_revision end,
        resubmitted_at = case when p_command_kind = 'contractor_revise'
          then clock_timestamp() else invoice.resubmitted_at end,
        resubmitted_by = case when p_command_kind = 'contractor_revise'
          then v_actor_id else invoice.resubmitted_by end,
        invoice_version = invoice.invoice_version + 1,
        updated_at = clock_timestamp()
    where invoice.id = v_invoice.id
      and invoice.invoice_version = p_expected_invoice_version
    returning * into v_invoice;
    if not found then
      raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
    end if;
  end if;

  delete from public.invoice_lines line where line.invoice_id = v_invoice.id;
  insert into public.invoice_lines(
    invoice_id, position, type, description, qty, rate
  )
  select v_invoice.id,
    line.ordinality::integer,
    line.value ->> 'type',
    line.value ->> 'description',
    (line.value ->> 'qty')::numeric,
    (line.value ->> 'rate')::numeric
  from jsonb_array_elements(v_payload -> 'lines')
    with ordinality as line(value, ordinality);

  if p_invoice_id is null and p_command_kind <> 'contractor_draft' then
    update public.invoices invoice
    set state = v_target_state, updated_at = clock_timestamp()
    where invoice.id = v_invoice.id
    returning * into v_invoice;
  else
    select invoice.* into strict v_invoice
    from public.invoices invoice where invoice.id = v_invoice.id;
  end if;

  if p_command_kind <> 'contractor_draft' then
    update public.work_orders work_order
    set status = case when work_order.status = 'closed' then work_order.status
          else 'pending_approval'::public.wo_status end,
        invoice_total = v_total,
        updated_at = clock_timestamp()
    where work_order.id = v_work_order.id
      and work_order.contractor_assignment_version = p_expected_assignment_version
      and work_order.workflow_cycle = p_expected_workflow_cycle;
    if not found then
      raise exception 'Work order changed. Refresh and try again.' using errcode = 'PT409';
    end if;
  end if;

  if p_command_kind = 'contractor_revise' then
    update public.activities activity
    set contractor_attention_acknowledged_at = clock_timestamp(),
        contractor_attention_acknowledged_by = v_actor_id
    where activity.work_order_id = v_work_order.id
      and activity.event_key = 'invoice_rejected'
      and activity.event_data ->> 'invoiceId' = v_invoice.id::text
      and activity.requires_contractor_attention
      and activity.contractor_attention_acknowledged_at is null
      and activity.deleted_at is null;
  end if;

  insert into public.activities(
    work_order_id, author_id, author_name, text, type, event_key, event_data
  ) values (
    v_work_order.id,
    v_actor_id,
    v_actor.name,
    case p_command_kind
      when 'contractor_draft' then format('Invoice #%s draft saved.', v_invoice.num)
      when 'contractor_submit' then format(
        'Invoice %s submitted. Total: $%s.',
        v_invoice.num, to_char(v_total, 'FM999999990.00')
      )
      else format('Invoice #%s corrected and resubmitted by %s.',
        v_invoice.num, v_actor.name)
    end,
    'system',
    case p_command_kind
      when 'contractor_draft' then 'invoice_draft'
      when 'contractor_submit' then 'invoice_submitted'
      else 'invoice_resubmitted'
    end,
    jsonb_build_object(
      'invoiceId', v_invoice.id,
      'invoiceNum', v_invoice.num,
      'state', v_invoice.state,
      'previousState', v_previous_state,
      'total', v_total,
      'mode', v_payload ->> 'mode',
      'totalOverride', v_payload -> 'totalOverride',
      'salesTax', v_sales_tax,
      'operationId', p_operation_id,
      'assignmentVersion', v_work_order.contractor_assignment_version,
      'workflowCycle', v_work_order.workflow_cycle
    )
  ) returning id into v_activity_id;

  select invoice.* into strict v_invoice
  from public.invoices invoice where invoice.id = v_invoice.id;

  return public.finish_invoice_financial_operation(
    p_operation_id,
    v_invoice.id,
    jsonb_build_object(
      'invoiceId', v_invoice.id,
      'invoiceNum', v_invoice.num,
      'workOrderId', v_work_order.id,
      'assignmentVersion', v_work_order.contractor_assignment_version,
      'workflowCycle', v_work_order.workflow_cycle,
      'invoiceVersion', v_invoice.invoice_version,
      'state', v_invoice.state,
      'subtotal', v_invoice.subtotal,
      'salesTax', v_invoice.sales_tax,
      'total', v_invoice.total
    ),
    v_activity_id
  );
end;
$$;

create function public.save_contractor_invoice_draft_v1(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_invoice_id uuid,
  p_expected_invoice_version bigint,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.write_contractor_invoice_v1(
    'contractor_draft', p_work_order_id, p_expected_assignment_version,
    p_expected_workflow_cycle, p_invoice_id, p_expected_invoice_version,
    p_operation_id, p_payload
  );
$$;

create function public.submit_contractor_invoice_v1(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_invoice_id uuid,
  p_expected_invoice_version bigint,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.write_contractor_invoice_v1(
    'contractor_submit', p_work_order_id, p_expected_assignment_version,
    p_expected_workflow_cycle, p_invoice_id, p_expected_invoice_version,
    p_operation_id, p_payload
  );
$$;

create function public.revise_contractor_invoice_v1(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_invoice_id uuid,
  p_expected_invoice_version bigint,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.write_contractor_invoice_v1(
    'contractor_revise', p_work_order_id, p_expected_assignment_version,
    p_expected_workflow_cycle, p_invoice_id, p_expected_invoice_version,
    p_operation_id, p_payload
  );
$$;

create function public.delete_own_contractor_invoice_v1(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_invoice_id uuid,
  p_expected_invoice_version bigint,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_actor_id uuid := auth.uid();
  v_account_id uuid := public.current_contractor_account_id();
  v_work_order public.work_orders%rowtype;
  v_invoice public.invoices%rowtype;
  v_previous_state public.invoice_state;
  v_replay jsonb;
  v_guard_id bigint;
  v_activity_id uuid;
begin
  if p_operation_id is null
     or p_invoice_id is null
     or nullif(btrim(coalesce(p_work_order_id, '')), '') is null
     or p_expected_assignment_version is null
     or p_expected_assignment_version < 0
     or p_expected_workflow_cycle is null
     or p_expected_workflow_cycle < 0
     or p_expected_invoice_version is null
     or p_expected_invoice_version < 0 then
    raise exception 'Invoice identity and expected versions are required'
      using errcode = '22023';
  end if;
  if v_actor_id is null or v_account_id is null then
    raise exception 'Contractor authentication is required' using errcode = '42501';
  end if;
  select profile.* into v_actor
  from public.profiles profile
  where profile.id = v_actor_id
    and profile.active = true
    and profile.role = 'contractor';
  if not found
     or not public.can_invoice_for_contractor(v_account_id)
     or not public.can_access_contractor_work_order(p_work_order_id) then
    raise exception 'Current contractor invoice access is required'
      using errcode = '42501';
  end if;

  select work_order.* into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;
  if not found
     or v_work_order.contractor_id is distinct from v_account_id
     or v_work_order.contractor_assignment_version is distinct from
       p_expected_assignment_version
     or v_work_order.workflow_cycle is distinct from p_expected_workflow_cycle
     or not public.can_access_contractor_work_order(v_work_order.id) then
    raise exception 'Work order assignment changed. Refresh and try again.'
      using errcode = 'PT409';
  end if;

  select invoice.* into v_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.invoice_type = 'contractor'
  for update;
  if not found then
    raise exception 'Contractor invoice was not found' using errcode = 'P0002';
  end if;
  if v_invoice.work_order_id is distinct from v_work_order.id
     or v_invoice.contractor_id is distinct from v_account_id
     or v_work_order.contractor_assignment_started_at is null
     or v_invoice.created_at < v_work_order.contractor_assignment_started_at then
    raise exception 'Invoice is outside the current assignment'
      using errcode = '42501';
  end if;

  v_replay := public.begin_invoice_financial_operation(
    p_operation_id, v_actor_id, 'contractor_delete', p_invoice_id,
    'contractor', v_work_order.id, p_expected_assignment_version,
    p_expected_workflow_cycle, p_expected_invoice_version,
    jsonb_build_object('invoiceId', p_invoice_id, 'action', 'delete')
  );
  if v_replay is not null then return v_replay; end if;

  if v_invoice.deleted_at is not null then
    raise exception 'Contractor invoice was already deleted' using errcode = 'PT409';
  end if;
  if v_invoice.invoice_version is distinct from p_expected_invoice_version then
    raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
  end if;
  if v_invoice.state not in ('draft', 'rejected') then
    raise exception 'Only draft or rejected invoices can be deleted'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.staff_invoice_sources source
    join public.invoices staff_invoice on staff_invoice.id = source.staff_invoice_id
    where source.contractor_invoice_id = v_invoice.id
      and staff_invoice.deleted_at is null
  ) then
    raise exception 'Invoice is already used by a P1 billing invoice'
      using errcode = '22023';
  end if;

  v_previous_state := v_invoice.state;
  v_guard_id := public.open_invoice_financial_guard(
    v_actor_id, 'contractor_delete', p_operation_id, v_invoice.id,
    v_work_order.id, true, false, false, true,
    'invoice_deleted_by_contractor'
  );
  perform set_config('app.contractor_invoice_delete_transition', 'delete_own', true);
  update public.invoices invoice
  set deleted_at = clock_timestamp(),
      deleted_by = v_actor_id,
      updated_at = clock_timestamp()
  where invoice.id = v_invoice.id
    and invoice.invoice_version = p_expected_invoice_version
    and invoice.deleted_at is null
  returning * into v_invoice;
  if not found then
    raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
  end if;

  update public.activities activity
  set contractor_attention_acknowledged_at = clock_timestamp(),
      contractor_attention_acknowledged_by = v_actor_id
  where activity.work_order_id = v_work_order.id
    and activity.event_key = 'invoice_rejected'
    and activity.event_data ->> 'invoiceId' = v_invoice.id::text
    and activity.requires_contractor_attention
    and activity.contractor_attention_acknowledged_at is null
    and activity.deleted_at is null;

  insert into public.activities(
    work_order_id, author_id, author_name, text, type, event_key, event_data
  ) values (
    v_work_order.id,
    v_actor_id,
    v_actor.name,
    format('Invoice #%s deleted by %s (%s).',
      v_invoice.num, v_actor.name, v_previous_state::text),
    'system',
    'invoice_deleted_by_contractor',
    jsonb_build_object(
      'invoiceId', v_invoice.id,
      'invoiceNum', v_invoice.num,
      'previousState', v_previous_state,
      'deletedBy', v_actor_id,
      'operationId', p_operation_id,
      'assignmentVersion', v_work_order.contractor_assignment_version,
      'workflowCycle', v_work_order.workflow_cycle
    )
  ) returning id into v_activity_id;

  return public.finish_invoice_financial_operation(
    p_operation_id,
    v_invoice.id,
    jsonb_build_object(
      'invoiceId', v_invoice.id,
      'invoiceNum', v_invoice.num,
      'workOrderId', v_work_order.id,
      'assignmentVersion', v_work_order.contractor_assignment_version,
      'workflowCycle', v_work_order.workflow_cycle,
      'invoiceVersion', v_invoice.invoice_version,
      'state', v_invoice.state,
      'deletedAt', v_invoice.deleted_at
    ),
    v_activity_id
  );
end;
$$;

create function public.close_invoice_financial_guard(p_guard_id bigint)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.invoice_financial_transition_guards
  where id = p_guard_id
    and transaction_id = txid_current();
$$;

create function public.begin_invoice_financial_operation(
  p_operation_id uuid,
  p_actor_id uuid,
  p_command_kind text,
  p_requested_invoice_id uuid,
  p_invoice_type text,
  p_work_order_id text,
  p_assignment_version integer,
  p_workflow_cycle integer,
  p_expected_invoice_version bigint,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_operation public.invoice_financial_operations%rowtype;
  v_inserted integer;
  v_activity_id uuid;
begin
  if p_operation_id is null
     or p_actor_id is null
     or p_payload is null
     or p_invoice_type not in ('contractor', 'staff') then
    raise exception 'Operation, actor, type, and payload are required'
      using errcode = '22023';
  end if;

  insert into public.financial_operation_claims(operation_id, actor_id, command_kind)
  values (p_operation_id, p_actor_id, p_command_kind)
  on conflict (operation_id) do nothing;

  if not exists (
    select 1
    from public.financial_operation_claims claim
    where claim.operation_id = p_operation_id
      and claim.actor_id = p_actor_id
      and claim.command_kind = p_command_kind
  ) then
    raise exception 'Operation identity was reused by another financial command'
      using errcode = 'PT409';
  end if;

  insert into public.invoice_financial_operations(
    operation_id,
    actor_id,
    command_kind,
    requested_invoice_id,
    invoice_type,
    work_order_id,
    assignment_version,
    workflow_cycle,
    expected_invoice_version,
    payload
  ) values (
    p_operation_id,
    p_actor_id,
    p_command_kind,
    p_requested_invoice_id,
    p_invoice_type,
    p_work_order_id,
    p_assignment_version,
    p_workflow_cycle,
    p_expected_invoice_version,
    p_payload
  )
  on conflict (operation_id) do nothing;
  get diagnostics v_inserted = row_count;

  select operation.*
  into strict v_operation
  from public.invoice_financial_operations operation
  where operation.operation_id = p_operation_id
  for update;

  if v_operation.actor_id is distinct from p_actor_id
     or v_operation.command_kind is distinct from p_command_kind
     or v_operation.requested_invoice_id is distinct from p_requested_invoice_id
     or v_operation.invoice_type is distinct from p_invoice_type
     or v_operation.work_order_id is distinct from p_work_order_id
     or v_operation.assignment_version is distinct from p_assignment_version
     or v_operation.workflow_cycle is distinct from p_workflow_cycle
     or v_operation.expected_invoice_version is distinct from p_expected_invoice_version
     or v_operation.payload is distinct from p_payload then
    raise exception 'Operation identity was reused with different input'
      using errcode = 'PT409';
  end if;

  if v_inserted = 0 then
    if v_operation.result is null
       or v_operation.invoice_id is null
       or v_operation.invoice_snapshot is distinct from
         public.invoice_financial_invoice_snapshot(v_operation.invoice_id)
       or v_operation.line_snapshot is distinct from
         public.invoice_financial_line_snapshot(v_operation.invoice_id)
       or v_operation.source_snapshot is distinct from
         public.invoice_financial_source_snapshot(v_operation.invoice_id)
       or v_operation.parent_snapshot is distinct from
         public.invoice_financial_parent_snapshot(v_operation.work_order_id) then
      raise exception 'Invoice changed after this operation. Refresh and reconcile.'
        using errcode = 'PT409';
    end if;

    v_activity_id := nullif(v_operation.result ->> 'activityId', '')::uuid;
    if v_operation.activity_snapshot is distinct from
         public.invoice_financial_activity_snapshot(v_activity_id) then
      raise exception 'Invoice evidence changed after this operation. Refresh and reconcile.'
        using errcode = 'PT409';
    end if;

    return v_operation.result
      || jsonb_build_object('applied', false, 'reason', 'already_applied');
  end if;

  return null;
end;
$$;

create function public.finish_invoice_financial_operation(
  p_operation_id uuid,
  p_invoice_id uuid,
  p_result jsonb,
  p_activity_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_operation public.invoice_financial_operations%rowtype;
  v_result jsonb;
begin
  select operation.*
  into strict v_operation
  from public.invoice_financial_operations operation
  where operation.operation_id = p_operation_id
  for update;

  v_result := coalesce(p_result, '{}'::jsonb)
    || jsonb_build_object(
      'applied', true,
      'reason', 'applied',
      'operationId', p_operation_id,
      'activityId', p_activity_id
    );

  update public.invoice_financial_operations operation
  set invoice_id = p_invoice_id,
      result = v_result,
      invoice_snapshot = public.invoice_financial_invoice_snapshot(p_invoice_id),
      line_snapshot = public.invoice_financial_line_snapshot(p_invoice_id),
      source_snapshot = public.invoice_financial_source_snapshot(p_invoice_id),
      parent_snapshot = public.invoice_financial_parent_snapshot(v_operation.work_order_id),
      activity_snapshot = public.invoice_financial_activity_snapshot(p_activity_id)
  where operation.operation_id = p_operation_id;

  delete from public.invoice_financial_transition_guards guard
  where guard.transaction_id = txid_current()
    and guard.operation_id = p_operation_id;

  return v_result;
end;
$$;

-- This trigger is alphabetically after the pre-existing invoice guards. It
-- therefore versions the final normalized row instead of making migration
-- 0117's whole-row handoff guard observe a caller-supplied version change.
create function public.zzz_protect_invoice_financial_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contracted boolean;
  v_allowed boolean;
  v_changed boolean;
  v_creation_guard_id bigint;
begin
  select control.contracted
  into v_contracted
  from public.invoice_financial_control control
  where control.singleton;

  if public.invoice_financial_is_owner_maintenance() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'DELETE' then
    if v_contracted then
      raise exception 'Invoices are retained and may only be soft-deleted through an invoice command'
        using errcode = '42501';
    end if;
    return old;
  end if;

  select public.invoice_financial_guard_exists(
    new.id,
    new.work_order_id,
    'header',
    null
  ) into v_allowed;

  if tg_op = 'INSERT' then
    if not v_allowed then
      v_creation_guard_id := public.invoice_financial_creation_guard_id(
        new.work_order_id,
        array['contractor_draft', 'contractor_submit', 'staff_save', 'estimate_convert']
      );
      if v_creation_guard_id is not null then
        update public.invoice_financial_transition_guards guard
        set invoice_id = new.id
        where guard.id = v_creation_guard_id
          and guard.transaction_id = txid_current()
          and guard.invoice_id is null;
        v_allowed := found;
      end if;
    end if;
    if v_contracted and not v_allowed then
      raise exception 'Invoice creation must use an authoritative invoice command'
        using errcode = '42501';
    end if;
    new.invoice_version := case when v_allowed then 1 else 0 end;
    return new;
  end if;

  v_changed := (to_jsonb(new) - 'updated_at' - 'invoice_version')
    is distinct from
    (to_jsonb(old) - 'updated_at' - 'invoice_version');

  if v_contracted
     and (v_changed or new.invoice_version is distinct from old.invoice_version)
     and not v_allowed then
    raise exception 'Invoice changes must use an authoritative invoice command'
      using errcode = '42501';
  end if;

  if v_changed then
    new.invoice_version := old.invoice_version + 1;
  elsif new.invoice_version is distinct from old.invoice_version then
    if new.invoice_version <> old.invoice_version + 1 then
      raise exception 'Invoice version is database controlled'
        using errcode = '42501';
    end if;
  else
    new.invoice_version := old.invoice_version;
  end if;

  return new;
end;
$$;

create trigger zzz_protect_invoice_financial_row_trigger
  before insert or update or delete on public.invoices
  for each row execute function public.zzz_protect_invoice_financial_row();

create function public.zzz_protect_invoice_financial_line()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid;
  v_work_order_id text;
  v_contracted boolean;
begin
  v_invoice_id := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
  select invoice.work_order_id into v_work_order_id
  from public.invoices invoice where invoice.id = v_invoice_id;
  select contracted into v_contracted
  from public.invoice_financial_control where singleton;

  if v_contracted
     and not public.invoice_financial_is_owner_maintenance()
     and not public.invoice_financial_guard_exists(
       v_invoice_id,
       v_work_order_id,
       'lines',
       null
     ) then
    raise exception 'Invoice lines must be changed through an authoritative invoice command'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger zzz_protect_invoice_financial_line_trigger
  before insert or update or delete on public.invoice_lines
  for each row execute function public.zzz_protect_invoice_financial_line();

-- Preserve the existing updated_at handoff revision and add the explicit
-- optimistic-concurrency version. The line amount itself remains generated.
create or replace function public.touch_invoice_after_line_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_invoice_id uuid;
  v_new_invoice_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old_invoice_id := old.invoice_id; end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new_invoice_id := new.invoice_id; end if;

  update public.invoices invoice
  set updated_at = clock_timestamp(),
      invoice_version = invoice.invoice_version + 1
  where invoice.id in (v_old_invoice_id, v_new_invoice_id);

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create function public.zzz_protect_staff_invoice_source()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid;
  v_work_order_id text;
  v_contracted boolean;
begin
  v_invoice_id := case
    when tg_op = 'DELETE' then old.staff_invoice_id
    else new.staff_invoice_id
  end;
  select invoice.work_order_id into v_work_order_id
  from public.invoices invoice where invoice.id = v_invoice_id;
  select contracted into v_contracted
  from public.invoice_financial_control where singleton;

  if v_contracted
     and not public.invoice_financial_is_owner_maintenance()
     and not public.invoice_financial_guard_exists(
       v_invoice_id,
       v_work_order_id,
       'sources',
       null
     ) then
    raise exception 'Invoice sources must be changed through an authoritative invoice command'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger zzz_protect_staff_invoice_source_trigger
  before insert or update or delete on public.staff_invoice_sources
  for each row execute function public.zzz_protect_staff_invoice_source();

create function public.touch_invoice_after_source_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_invoice_id uuid;
  v_new_invoice_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old_invoice_id := old.staff_invoice_id; end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new_invoice_id := new.staff_invoice_id; end if;

  update public.invoices invoice
  set updated_at = clock_timestamp(),
      invoice_version = invoice.invoice_version + 1
  where invoice.id in (v_old_invoice_id, v_new_invoice_id);

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger touch_invoice_after_source_change_trigger
  after insert or update or delete on public.staff_invoice_sources
  for each row execute function public.touch_invoice_after_source_change();

create function public.zzz_protect_invoice_financial_parent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contracted boolean;
  v_financial_change boolean;
begin
  select contracted into v_contracted
  from public.invoice_financial_control where singleton;

  v_financial_change :=
    new.invoice_total is distinct from old.invoice_total
    or new.contractor_invoicing_completed_at is distinct from old.contractor_invoicing_completed_at
    or new.contractor_invoicing_completed_by is distinct from old.contractor_invoicing_completed_by
    or new.contractor_invoicing_assignment_version is distinct from old.contractor_invoicing_assignment_version
    or new.contractor_invoicing_workflow_cycle is distinct from old.contractor_invoicing_workflow_cycle
    or new.contractor_invoicing_completion_source is distinct from old.contractor_invoicing_completion_source
    or (
      new.status is distinct from old.status
      and (
        new.status::text in ('pending_invoice', 'pending_approval', 'pending_payment')
        or old.status::text in ('pending_invoice', 'pending_approval', 'pending_payment')
      )
    );

  if v_contracted
     and v_financial_change
     and not public.invoice_financial_is_owner_maintenance()
     and not public.invoice_financial_guard_exists(
       null,
       new.id,
       'parent',
       null
     )
     and not exists (
       select 1 from public.work_order_lifecycle_transition_guards guard
       where guard.transaction_id = txid_current()
         and guard.work_order_id = new.id
         and guard.actor_id is not distinct from auth.uid()
         and guard.parent_allowed
     )
     and not exists (
       select 1 from public.work_order_assignment_transition_guards guard
       where guard.transaction_id = txid_current()
         and guard.work_order_id = new.id
         and guard.actor_id = auth.uid()
     )
     and not exists (
       select 1 from public.work_order_close_transition_guards guard
       where guard.transaction_id = txid_current()
         and guard.work_order_id = new.id
         and guard.actor_id = auth.uid()
     )
     and not exists (
       select 1 from public.work_order_reopen_transition_guards guard
       where guard.transaction_id = txid_current()
         and guard.work_order_id = new.id
         and guard.actor_id = auth.uid()
     ) then
    raise exception 'Invoice-related work-order changes must use an authoritative invoice command'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger zzzz_protect_invoice_financial_parent_trigger
  before update on public.work_orders
  for each row execute function public.zzz_protect_invoice_financial_parent();

create function public.zzz_protect_invoice_financial_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_key text;
  v_old_event_key text;
  v_work_order_id text;
  v_invoice_id uuid;
  v_operation_id uuid;
  v_contracted boolean;
  v_owned boolean;
begin
  v_event_key := case when tg_op = 'DELETE' then old.event_key else new.event_key end;
  v_old_event_key := case when tg_op = 'INSERT' then null else old.event_key end;
  v_work_order_id := case when tg_op = 'DELETE' then old.work_order_id else new.work_order_id end;
  v_owned := coalesce(v_event_key in (
    'invoice_draft',
    'invoice_submitted',
    'invoice_resubmitted',
    'invoice_deleted',
    'invoice_deleted_by_contractor',
    'staff_billing'
  ), false) or coalesce(v_old_event_key in (
    'invoice_draft',
    'invoice_submitted',
    'invoice_resubmitted',
    'invoice_deleted',
    'invoice_deleted_by_contractor',
    'staff_billing'
  ), false);

  if v_owned is not true then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  v_invoice_id := nullif(
    case when tg_op = 'DELETE' then old.event_data else new.event_data end
      ->> 'invoiceId',
    ''
  )::uuid;

  select contracted into v_contracted
  from public.invoice_financial_control where singleton;

  if v_contracted
     and not public.invoice_financial_is_owner_maintenance()
     and (
       tg_op <> 'INSERT'
       or not public.invoice_financial_guard_exists(
         v_invoice_id,
         v_work_order_id,
         'event',
         v_event_key
       )
       or not exists (
         select 1
         from public.invoice_financial_transition_guards guard
         where guard.transaction_id = txid_current()
           and guard.invoice_id is not distinct from v_invoice_id
           and guard.work_order_id is not distinct from v_work_order_id
           and guard.event_key is not distinct from v_event_key
           and guard.actor_id is not distinct from new.author_id
       )
     ) then
    raise exception 'Invoice evidence must be created by its authoritative command'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    select guard.operation_id
    into v_operation_id
    from public.invoice_financial_transition_guards guard
    where guard.transaction_id = txid_current()
      and guard.invoice_id is not distinct from v_invoice_id
      and guard.work_order_id is not distinct from v_work_order_id
      and guard.event_key is not distinct from v_event_key
      and guard.actor_id is not distinct from new.author_id
    order by guard.id desc
    limit 1;
    if v_operation_id is not null then
      new.event_data := coalesce(new.event_data, '{}'::jsonb)
        || jsonb_build_object('operationId', v_operation_id);
    end if;
  end if;

  if tg_op <> 'INSERT' and not public.invoice_financial_is_owner_maintenance() then
    raise exception 'Authoritative invoice evidence is immutable'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger zzzz_protect_invoice_financial_activity_trigger
  before insert or update or delete on public.activities
  for each row execute function public.zzz_protect_invoice_financial_activity();

create function public.normalize_contractor_invoice_payload(p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_num text;
  v_user_typed boolean;
  v_sales_tax numeric;
  v_total_override numeric;
  v_lines jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Invoice payload must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) key
    where key not in (
      'num', 'userTypedNum', 'cme', 'storeAddress', 'invoiceDate',
      'serviceDate', 'dueDate', 'terms', 'mode', 'salesTax',
      'totalOverride', 'lines', 'pdfStoragePath'
    )
  ) then
    raise exception 'Invoice payload contains unsupported fields' using errcode = '22023';
  end if;

  if not (p_payload ?& array[
    'num', 'userTypedNum', 'mode', 'salesTax', 'totalOverride', 'lines'
  ]) then
    raise exception 'Invoice payload is incomplete' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'num') is distinct from 'string'
     or (p_payload ? 'cme' and jsonb_typeof(p_payload -> 'cme') not in ('string', 'null'))
     or (p_payload ? 'storeAddress' and jsonb_typeof(p_payload -> 'storeAddress') not in ('string', 'null'))
     or (p_payload ? 'invoiceDate' and jsonb_typeof(p_payload -> 'invoiceDate') not in ('string', 'null'))
     or (p_payload ? 'serviceDate' and jsonb_typeof(p_payload -> 'serviceDate') not in ('string', 'null'))
     or (p_payload ? 'dueDate' and jsonb_typeof(p_payload -> 'dueDate') not in ('string', 'null'))
     or (p_payload ? 'terms' and jsonb_typeof(p_payload -> 'terms') not in ('string', 'null'))
     or (p_payload ? 'pdfStoragePath' and jsonb_typeof(p_payload -> 'pdfStoragePath') not in ('string', 'null')) then
    raise exception 'Invoice text and date fields have invalid types'
      using errcode = '22023';
  end if;

  v_mode := p_payload ->> 'mode';
  if v_mode is null or v_mode not in ('line_items', 'manual_pdf_total') then
    raise exception 'Invoice calculation mode is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'userTypedNum') is distinct from 'boolean' then
    raise exception 'Invoice number ownership must be explicit' using errcode = '22023';
  end if;
  v_user_typed := (p_payload ->> 'userTypedNum')::boolean;
  v_num := btrim(coalesce(p_payload ->> 'num', ''));
  if v_num = '' or length(v_num) > 80 or v_num ~ '[[:cntrl:]]' then
    raise exception 'Invoice number is invalid' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'salesTax') is distinct from 'number' then
    raise exception 'Sales tax must be a number' using errcode = '22023';
  end if;
  v_sales_tax := (p_payload ->> 'salesTax')::numeric;
  if v_sales_tax < 0
     or v_sales_tax > 99999999.99
     or v_sales_tax <> round(v_sales_tax, 2) then
    raise exception 'Sales tax is outside the supported money range'
      using errcode = '22023';
  end if;

  if v_mode = 'line_items' then
    if p_payload -> 'totalOverride' is distinct from 'null'::jsonb then
      raise exception 'Line-item invoices cannot override their total'
        using errcode = '22023';
    end if;
    v_total_override := null;
  else
    if jsonb_typeof(p_payload -> 'totalOverride') is distinct from 'number' then
      raise exception 'Manual PDF invoices require a numeric total'
        using errcode = '22023';
    end if;
    v_total_override := (p_payload ->> 'totalOverride')::numeric;
    if v_total_override < 0
       or v_total_override > 99999999.99
       or v_total_override <> round(v_total_override, 2) then
      raise exception 'Invoice total is outside the supported money range'
        using errcode = '22023';
    end if;
  end if;

  if jsonb_typeof(p_payload -> 'lines') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'lines') > 1000 then
    raise exception 'Invoice lines must be an array with at most 1000 items'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_payload -> 'lines') item
    where jsonb_typeof(item) <> 'object'
  ) then
    raise exception 'One or more invoice lines are invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_payload -> 'lines') item
    where exists (
        select 1 from jsonb_object_keys(item) key
        where key not in ('type', 'description', 'qty', 'rate')
      )
      or jsonb_typeof(item -> 'type') is distinct from 'string'
      or jsonb_typeof(item -> 'description') is distinct from 'string'
      or jsonb_typeof(item -> 'qty') is distinct from 'number'
      or jsonb_typeof(item -> 'rate') is distinct from 'number'
      or length(item ->> 'type') > 80
      or length(item ->> 'description') > 4000
      or (item ->> 'type') ~ '[[:cntrl:]]'
  ) then
    raise exception 'One or more invoice lines are invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_payload -> 'lines') item
    where (item ->> 'qty')::numeric < 0
       or (item ->> 'qty')::numeric > 99999999.99
       or (item ->> 'rate')::numeric < 0
       or (item ->> 'rate')::numeric > 99999999.99
       or round((item ->> 'qty')::numeric, 2)
          * round((item ->> 'rate')::numeric, 2) > 99999999.99
  ) then
    raise exception 'One or more invoice lines are invalid' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'type', coalesce(nullif(btrim(item ->> 'type'), ''), 'Other'),
        'description', btrim(coalesce(item ->> 'description', '')),
        'qty', round((item ->> 'qty')::numeric, 2),
        'rate', round((item ->> 'rate')::numeric, 2)
      ) order by ordinality
    ),
    '[]'::jsonb
  ) into v_lines
  from jsonb_array_elements(p_payload -> 'lines')
    with ordinality as requested(item, ordinality);

  if p_payload ->> 'invoiceDate' is not null then
    if (p_payload ->> 'invoiceDate') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Invoice date is invalid' using errcode = '22023';
    end if;
    perform (p_payload ->> 'invoiceDate')::date;
  end if;
  if p_payload ->> 'serviceDate' is not null then
    if (p_payload ->> 'serviceDate') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Service date is invalid' using errcode = '22023';
    end if;
    perform (p_payload ->> 'serviceDate')::date;
  end if;
  if p_payload ->> 'dueDate' is not null then
    if (p_payload ->> 'dueDate') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Due date is invalid' using errcode = '22023';
    end if;
    perform (p_payload ->> 'dueDate')::date;
  end if;
  if length(coalesce(p_payload ->> 'cme', '')) > 200
     or length(coalesce(p_payload ->> 'storeAddress', '')) > 1000
     or length(coalesce(p_payload ->> 'terms', '')) > 200
     or length(coalesce(p_payload ->> 'pdfStoragePath', '')) > 1000 then
    raise exception 'Invoice text is too long' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'num', v_num,
    'userTypedNum', v_user_typed,
    'cme', nullif(btrim(coalesce(p_payload ->> 'cme', '')), ''),
    'storeAddress', nullif(btrim(coalesce(p_payload ->> 'storeAddress', '')), ''),
    'invoiceDate', p_payload ->> 'invoiceDate',
    'serviceDate', p_payload ->> 'serviceDate',
    'dueDate', p_payload ->> 'dueDate',
    'terms', coalesce(nullif(btrim(coalesce(p_payload ->> 'terms', '')), ''), 'Net 30'),
    'mode', v_mode,
    'salesTax', round(v_sales_tax, 2),
    'totalOverride', v_total_override,
    'lines', v_lines,
    'pdfStoragePath', nullif(btrim(coalesce(p_payload ->> 'pdfStoragePath', '')), '')
  );
end;
$$;

create function public.normalize_staff_invoice_payload(p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_lines jsonb;
  v_sources jsonb;
  v_tax_mode text;
  v_num text;
  v_user_typed boolean;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Staff invoice payload must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) key
    where key not in (
      'num', 'userTypedNum', 'storeNumber', 'storeAddress', 'cme',
      'invoiceDate', 'serviceDate', 'dueDate', 'terms', 'state',
      'territory', 'equipmentTag', 'taxState',
      'taxMode', 'salesTaxOverride', 'taxRateOverride', 'lines',
      'sourceInvoiceIds'
    )
  ) then
    raise exception 'Staff invoice payload contains unsupported fields'
      using errcode = '22023';
  end if;
  if not (p_payload ?& array[
    'num', 'userTypedNum', 'storeNumber', 'invoiceDate', 'terms',
    'state', 'territory', 'equipmentTag', 'taxMode', 'lines',
    'sourceInvoiceIds'
  ]) then
    raise exception 'Staff invoice payload is incomplete' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'num') is distinct from 'string'
     or jsonb_typeof(p_payload -> 'userTypedNum') is distinct from 'boolean'
     or jsonb_typeof(p_payload -> 'storeNumber') is distinct from 'string'
     or jsonb_typeof(p_payload -> 'invoiceDate') is distinct from 'string'
     or jsonb_typeof(p_payload -> 'terms') is distinct from 'string'
     or jsonb_typeof(p_payload -> 'state') is distinct from 'string'
     or jsonb_typeof(p_payload -> 'territory') is distinct from 'string'
     or jsonb_typeof(p_payload -> 'equipmentTag') is distinct from 'string'
     or jsonb_typeof(p_payload -> 'taxMode') is distinct from 'string'
     or (p_payload ? 'storeAddress' and jsonb_typeof(p_payload -> 'storeAddress') not in ('string', 'null'))
     or (p_payload ? 'cme' and jsonb_typeof(p_payload -> 'cme') not in ('string', 'null'))
     or (p_payload ? 'serviceDate' and jsonb_typeof(p_payload -> 'serviceDate') not in ('string', 'null'))
     or (p_payload ? 'dueDate' and jsonb_typeof(p_payload -> 'dueDate') not in ('string', 'null'))
     or (p_payload ? 'taxState' and jsonb_typeof(p_payload -> 'taxState') not in ('string', 'null'))
     or (p_payload ? 'salesTaxOverride' and jsonb_typeof(p_payload -> 'salesTaxOverride') not in ('number', 'null'))
     or (p_payload ? 'taxRateOverride' and jsonb_typeof(p_payload -> 'taxRateOverride') not in ('number', 'null')) then
    raise exception 'Staff invoice header fields have invalid types'
      using errcode = '22023';
  end if;

  v_num := btrim(p_payload ->> 'num');
  v_user_typed := (p_payload ->> 'userTypedNum')::boolean;
  if (v_user_typed and v_num = '')
     or length(v_num) > 80
     or v_num ~ '[[:cntrl:]]'
     or nullif(btrim(p_payload ->> 'storeNumber'), '') is null
     or length(p_payload ->> 'storeNumber') > 80
     or nullif(btrim(p_payload ->> 'terms'), '') is null
     or length(p_payload ->> 'terms') > 200
     or nullif(btrim(p_payload ->> 'territory'), '') is null
     or length(p_payload ->> 'territory') > 200
     or length(coalesce(p_payload ->> 'storeAddress', '')) > 1000
     or length(coalesce(p_payload ->> 'cme', '')) > 200 then
    raise exception 'Staff invoice text fields are invalid' using errcode = '22023';
  end if;
  if p_payload ->> 'state' not in ('draft', 'submitted') then
    raise exception 'Staff invoice state is invalid' using errcode = '22023';
  end if;
  v_tax_mode := p_payload ->> 'taxMode';
  if v_tax_mode not in ('none', 'manual_amount', 'manual_rate', 'active_db_rate') then
    raise exception 'Staff invoice tax mode is invalid' using errcode = '22023';
  end if;
  if nullif(p_payload ->> 'taxState', '') is not null
     and upper(p_payload ->> 'taxState') !~ '^[A-Z]{2}$' then
    raise exception 'Tax state is invalid' using errcode = '22023';
  end if;

  if (p_payload ->> 'invoiceDate') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Invoice date is invalid' using errcode = '22023';
  end if;
  perform (p_payload ->> 'invoiceDate')::date;
  if nullif(p_payload ->> 'serviceDate', '') is not null then
    if (p_payload ->> 'serviceDate') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Service date is invalid' using errcode = '22023';
    end if;
    perform (p_payload ->> 'serviceDate')::date;
  end if;
  if nullif(p_payload ->> 'dueDate', '') is not null then
    if (p_payload ->> 'dueDate') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Due date is invalid' using errcode = '22023';
    end if;
    perform (p_payload ->> 'dueDate')::date;
  end if;

  if v_tax_mode = 'manual_amount' then
    if jsonb_typeof(p_payload -> 'salesTaxOverride') is distinct from 'number'
       or (p_payload ->> 'salesTaxOverride')::numeric < 0
       or (p_payload ->> 'salesTaxOverride')::numeric > 99999999.99
       or (p_payload ->> 'salesTaxOverride')::numeric <>
         round((p_payload ->> 'salesTaxOverride')::numeric, 2) then
      raise exception 'Manual sales tax is invalid' using errcode = '22023';
    end if;
  elsif p_payload -> 'salesTaxOverride' is distinct from 'null'::jsonb
        and p_payload ? 'salesTaxOverride' then
    raise exception 'Sales tax amount does not match the selected tax mode'
      using errcode = '22023';
  end if;
  if v_tax_mode = 'manual_rate' then
    if jsonb_typeof(p_payload -> 'taxRateOverride') is distinct from 'number'
       or (p_payload ->> 'taxRateOverride')::numeric < 0
       or (p_payload ->> 'taxRateOverride')::numeric > 100
       or (p_payload ->> 'taxRateOverride')::numeric <>
         round((p_payload ->> 'taxRateOverride')::numeric, 6) then
      raise exception 'Manual tax rate is invalid' using errcode = '22023';
    end if;
  elsif p_payload -> 'taxRateOverride' is distinct from 'null'::jsonb
        and p_payload ? 'taxRateOverride' then
    raise exception 'Tax rate does not match the selected tax mode'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'lines') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'lines') = 0
     or jsonb_array_length(p_payload -> 'lines') > 1000 then
    raise exception 'Staff invoices require between 1 and 1000 lines'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_payload -> 'lines') line
    where jsonb_typeof(line) is distinct from 'object'
  ) then
    raise exception 'One or more staff invoice lines are invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_payload -> 'lines') line
    where exists (
        select 1 from jsonb_object_keys(line) key
        where key not in (
          'type', 'description', 'qty', 'rate', 'isTaxable',
          'sourceInvoiceLineId', 'sourceWorkOrderPartId',
          'sourceUnitCost', 'markupPercent'
        )
      )
      or jsonb_typeof(line -> 'type') is distinct from 'string'
      or jsonb_typeof(line -> 'description') is distinct from 'string'
      or jsonb_typeof(line -> 'qty') is distinct from 'number'
      or jsonb_typeof(line -> 'rate') is distinct from 'number'
      or jsonb_typeof(line -> 'isTaxable') is distinct from 'boolean'
      or (line ? 'sourceInvoiceLineId' and jsonb_typeof(line -> 'sourceInvoiceLineId') not in ('string', 'null'))
      or (line ? 'sourceWorkOrderPartId' and jsonb_typeof(line -> 'sourceWorkOrderPartId') not in ('string', 'null'))
      or (line ? 'sourceUnitCost' and jsonb_typeof(line -> 'sourceUnitCost') not in ('number', 'null'))
      or (line ? 'markupPercent' and jsonb_typeof(line -> 'markupPercent') not in ('number', 'null'))
  ) then
    raise exception 'One or more staff invoice lines are invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_payload -> 'lines') line
    where nullif(btrim(line ->> 'type'), '') is null
      or length(line ->> 'type') > 80
      or length(line ->> 'description') > 4000
      or (line ->> 'qty')::numeric <= 0
      or (line ->> 'qty')::numeric > 99999999.99
      or (line ->> 'qty')::numeric <> round((line ->> 'qty')::numeric, 2)
      or (line ->> 'rate')::numeric <= 0
      or (line ->> 'rate')::numeric > 99999999.99
      or (line ->> 'rate')::numeric <> round((line ->> 'rate')::numeric, 2)
      or (
        nullif(btrim(line ->> 'description'), '') is null
        and lower(btrim(line ->> 'type')) not in ('travel', 'truck charge')
      )
      or (
        nullif(line ->> 'sourceInvoiceLineId', '') is not null
        and nullif(line ->> 'sourceWorkOrderPartId', '') is not null
      )
      or coalesce((line ->> 'sourceUnitCost')::numeric, 0) < 0
      or coalesce((line ->> 'sourceUnitCost')::numeric, 0) > 99999999.99
      or coalesce((line ->> 'sourceUnitCost')::numeric, 0) <>
        round(coalesce((line ->> 'sourceUnitCost')::numeric, 0), 2)
      or coalesce((line ->> 'markupPercent')::numeric, 0) < 0
      or coalesce((line ->> 'markupPercent')::numeric, 0) > 999
      or coalesce((line ->> 'markupPercent')::numeric, 0) <>
        round(coalesce((line ->> 'markupPercent')::numeric, 0), 1)
  ) then
    raise exception 'One or more staff invoice lines are invalid'
      using errcode = '22023';
  end if;

  begin
    perform nullif(line ->> 'sourceInvoiceLineId', '')::uuid,
      nullif(line ->> 'sourceWorkOrderPartId', '')::uuid
    from jsonb_array_elements(p_payload -> 'lines') line;
  exception when invalid_text_representation then
    raise exception 'A staff invoice line source ID is invalid' using errcode = '22023';
  end;
  if exists (
    select source_id from (
      select nullif(line ->> 'sourceInvoiceLineId', '')::uuid source_id
      from jsonb_array_elements(p_payload -> 'lines') line
    ) requested where source_id is not null group by source_id having count(*) > 1
  ) or exists (
    select source_id from (
      select nullif(line ->> 'sourceWorkOrderPartId', '')::uuid source_id
      from jsonb_array_elements(p_payload -> 'lines') line
    ) requested where source_id is not null group by source_id having count(*) > 1
  ) then
    raise exception 'A source may appear only once on a staff invoice'
      using errcode = '22023';
  end if;

  select jsonb_agg(jsonb_build_object(
    'type', btrim(line ->> 'type'),
    'description', btrim(line ->> 'description'),
    'qty', round((line ->> 'qty')::numeric, 2),
    'rate', round((line ->> 'rate')::numeric, 2),
    'isTaxable', (line ->> 'isTaxable')::boolean,
    'sourceInvoiceLineId', nullif(line ->> 'sourceInvoiceLineId', ''),
    'sourceWorkOrderPartId', nullif(line ->> 'sourceWorkOrderPartId', ''),
    'sourceUnitCost', (line ->> 'sourceUnitCost')::numeric,
    'markupPercent', (line ->> 'markupPercent')::numeric
  ) order by ordinality)
  into v_lines
  from jsonb_array_elements(p_payload -> 'lines')
    with ordinality as requested(line, ordinality);

  if jsonb_typeof(p_payload -> 'sourceInvoiceIds') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'sourceInvoiceIds') > 100
     or exists (
       select 1 from jsonb_array_elements(p_payload -> 'sourceInvoiceIds') source
       where jsonb_typeof(source) is distinct from 'string'
     ) then
    raise exception 'Staff invoice sources are invalid' using errcode = '22023';
  end if;
  begin
    select coalesce(jsonb_agg(to_jsonb(source_id) order by source_id), '[]'::jsonb)
    into v_sources
    from (
      select distinct (source #>> '{}')::uuid source_id
      from jsonb_array_elements(p_payload -> 'sourceInvoiceIds') source
    ) normalized;
  exception when invalid_text_representation then
    raise exception 'A staff invoice source ID is invalid' using errcode = '22023';
  end;
  if jsonb_array_length(v_sources) <> jsonb_array_length(p_payload -> 'sourceInvoiceIds') then
    raise exception 'Duplicate staff invoice sources are not allowed'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'num', v_num,
    'userTypedNum', v_user_typed,
    'storeNumber', btrim(p_payload ->> 'storeNumber'),
    'storeAddress', nullif(btrim(coalesce(p_payload ->> 'storeAddress', '')), ''),
    'cme', nullif(btrim(coalesce(p_payload ->> 'cme', '')), ''),
    'invoiceDate', p_payload ->> 'invoiceDate',
    'serviceDate', nullif(p_payload ->> 'serviceDate', ''),
    'dueDate', nullif(p_payload ->> 'dueDate', ''),
    'terms', btrim(p_payload ->> 'terms'),
    'state', p_payload ->> 'state',
    'territory', btrim(p_payload ->> 'territory'),
    'equipmentTag', p_payload ->> 'equipmentTag',
    'taxState', nullif(upper(p_payload ->> 'taxState'), ''),
    'taxMode', v_tax_mode,
    'salesTaxOverride', case when v_tax_mode = 'manual_amount'
      then round((p_payload ->> 'salesTaxOverride')::numeric, 2) else null end,
    'taxRateOverride', case when v_tax_mode = 'manual_rate'
      then round((p_payload ->> 'taxRateOverride')::numeric, 6) else null end,
    'lines', v_lines,
    'sourceInvoiceIds', v_sources
  );
end;
$$;

create function public.save_staff_billing_invoice_v4(
  p_actor_id uuid,
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_invoice_id uuid,
  p_expected_invoice_version bigint,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_target_work_order public.work_orders%rowtype;
  v_existing public.invoices%rowtype;
  v_existing_work_order_id text;
  v_payload jsonb;
  v_replay jsonb;
  v_guard_id bigint;
  v_invoice_id uuid;
  v_invoice public.invoices%rowtype;
  v_source_ids uuid[] := '{}'::uuid[];
  v_p1_part_ids uuid[] := '{}'::uuid[];
  v_lines jsonb := '[]'::jsonb;
  v_line_count integer;
  v_source_count integer;
  v_num text;
  v_subtotal numeric(10,2);
  -- Keep the taxable accumulator and percentage rate unconstrained while
  -- calculating. The established web flow rounds only the final tax amount;
  -- the persisted invoice columns apply their existing numeric scales.
  v_taxable_subtotal numeric;
  v_sales_tax numeric(10,2) := 0;
  v_tax_rate numeric;
  v_tax_state text;
  v_activity_id uuid;
  v_number_attempt integer := 0;
  v_constraint_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_actor_id is null
     or p_operation_id is null
     or ((p_invoice_id is null) <> (p_expected_invoice_version is null))
     or coalesce(p_expected_invoice_version, 0) < 0
     or (
       p_work_order_id is null and (
         p_expected_assignment_version is not null
         or p_expected_workflow_cycle is not null
       )
     )
     or (
       p_work_order_id is not null and (
         p_expected_assignment_version is null
         or p_expected_assignment_version < 0
         or p_expected_workflow_cycle is null
         or p_expected_workflow_cycle < 0
       )
     ) then
    raise exception 'Invoice identity and expected versions are invalid'
      using errcode = '22023';
  end if;

  select profile.* into v_actor
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');
  if not found
     or public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Active operational P1 staff access is required'
      using errcode = '42501';
  end if;
  v_payload := public.normalize_staff_invoice_payload(p_payload);

  -- Read only the old parent identity, then take every parent lock in stable
  -- text order before the invoice/source locks. Re-check after locking.
  if p_invoice_id is not null then
    select invoice.work_order_id into v_existing_work_order_id
    from public.invoices invoice
    where invoice.id = p_invoice_id
      and invoice.invoice_type = 'staff';
    if not found then
      raise exception 'Billing invoice was not found' using errcode = 'P0002';
    end if;
  end if;
  perform 1
  from public.work_orders work_order
  where work_order.id in (p_work_order_id, v_existing_work_order_id)
  order by work_order.id
  for update;

  if p_work_order_id is not null then
    select work_order.* into v_target_work_order
    from public.work_orders work_order
    where work_order.id = p_work_order_id
      and work_order.deleted_at is null;
    if not found then
      raise exception 'Linked work order was not found' using errcode = 'P0002';
    end if;
    if v_target_work_order.contractor_assignment_version is distinct from
         p_expected_assignment_version
       or v_target_work_order.workflow_cycle is distinct from
         p_expected_workflow_cycle then
      raise exception 'Work order changed. Refresh and try again.'
        using errcode = 'PT409';
    end if;
    if v_target_work_order.status = 'closed' and exists (
      select 1 from public.activities activity
      where activity.work_order_id = v_target_work_order.id
        and activity.event_key in (
          'work_order_closed_without_invoice',
          'work_order_follow_up_closed_without_additional_billing'
        )
        and activity.deleted_at is null
        and (
          v_target_work_order.closed_at is null
          or activity.created_at >= v_target_work_order.closed_at
        )
    ) then
      raise exception 'Invoices cannot be saved for this closed work order; reopen it first'
        using errcode = '23514';
    end if;
  end if;

  if p_invoice_id is not null then
    select invoice.* into v_existing
    from public.invoices invoice
    where invoice.id = p_invoice_id
      and invoice.invoice_type = 'staff'
    for update;
    if not found then
      raise exception 'Billing invoice was not found' using errcode = 'P0002';
    end if;
    if v_existing.work_order_id is distinct from v_existing_work_order_id then
      raise exception 'Invoice parent changed. Refresh and try again.'
        using errcode = 'PT409';
    end if;
  end if;

  select coalesce(array_agg(source_id order by source_id), '{}'::uuid[])
  into v_source_ids
  from (
    select (source #>> '{}')::uuid source_id
    from jsonb_array_elements(v_payload -> 'sourceInvoiceIds') source
  ) requested;
  v_source_count := cardinality(v_source_ids);
  if v_source_count > 0 then
    if p_work_order_id is null then
      raise exception 'A linked work order is required for source invoices'
        using errcode = '22023';
    end if;
    perform 1
    from public.invoices invoice
    where invoice.id = any(v_source_ids)
    order by invoice.id
    for update;
  end if;

  v_replay := public.begin_invoice_financial_operation(
    p_operation_id, p_actor_id, 'staff_save', p_invoice_id, 'staff',
    p_work_order_id, p_expected_assignment_version, p_expected_workflow_cycle,
    p_expected_invoice_version, v_payload
  );
  if v_replay is not null then return v_replay; end if;

  if p_invoice_id is not null then
    if v_existing.deleted_at is not null then
      raise exception 'Billing invoice was deleted' using errcode = 'PT409';
    end if;
    if v_existing.invoice_version is distinct from p_expected_invoice_version then
      raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
    end if;
    if v_existing.state not in ('draft', 'submitted') then
      raise exception 'This billing invoice is locked' using errcode = '55000';
    end if;
    if v_existing.qbo_invoice_id is not null
       or v_existing.qbo_synced_at is not null then
      raise exception 'QuickBooks-synced billing invoices are locked'
        using errcode = '55000';
    end if;
  end if;

  if v_source_count > 0 and (
    select count(*)
    from public.invoices invoice
    where invoice.id = any(v_source_ids)
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and invoice.work_order_id = p_work_order_id
      and invoice.state not in ('draft', 'rejected')
  ) <> v_source_count then
    raise exception 'Source invoices must be live and belong to this work order'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.staff_invoice_sources source
    join public.invoices staff_invoice on staff_invoice.id = source.staff_invoice_id
    where source.contractor_invoice_id = any(v_source_ids)
      and source.staff_invoice_id is distinct from p_invoice_id
      and staff_invoice.deleted_at is null
  ) then
    raise exception 'A source invoice is already linked to another active P1 invoice'
      using errcode = '55000';
  end if;

  select coalesce(array_agg(part_id order by part_id), '{}'::uuid[])
  into v_p1_part_ids
  from (
    select nullif(line ->> 'sourceWorkOrderPartId', '')::uuid part_id
    from jsonb_array_elements(v_payload -> 'lines') line
  ) requested where part_id is not null;
  if cardinality(v_p1_part_ids) > 0 then
    if p_work_order_id is null then
      raise exception 'P1 parts require a linked work order' using errcode = '22023';
    end if;
    perform 1 from public.wo_parts part
    where part.id = any(v_p1_part_ids)
    order by part.id for update;
    perform 1 from public.p1_part_costs cost
    where cost.part_id = any(v_p1_part_ids)
    order by cost.part_id for update;
    if (
      select count(*)
      from public.wo_parts part
      join public.p1_part_costs cost on cost.part_id = part.id
      where part.id = any(v_p1_part_ids)
        and part.work_order_id = p_work_order_id
        and part.ordering_responsibility = 'p1'
        and part.p1_order_status in ('ordered', 'received')
        and cost.unit_cost > 0
    ) <> cardinality(v_p1_part_ids) then
      raise exception 'Every P1 part must be ordered, priced, and on this work order'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(v_payload -> 'lines') line
      join public.wo_parts part
        on part.id = nullif(line ->> 'sourceWorkOrderPartId', '')::uuid
      join public.p1_part_costs cost on cost.part_id = part.id
      where nullif(line ->> 'sourceWorkOrderPartId', '') is not null
        and (
          nullif(line ->> 'sourceInvoiceLineId', '') is not null
          or round((line ->> 'sourceUnitCost')::numeric, 2) <> cost.unit_cost
          or round((line ->> 'markupPercent')::numeric, 1) <> 25.0
          or (line ->> 'qty')::numeric <> round(coalesce(part.qty, 1), 2)
          or (line ->> 'rate')::numeric <> round(cost.unit_cost * 1.25, 2)
          or lower(btrim(line ->> 'type')) not in (
            'parts', 'parts/hardware', 'hardware'
          )
        )
    ) then
      raise exception 'P1 part pricing must use the authoritative 25 percent markup'
        using errcode = '23514';
    end if;
  end if;

  if p_work_order_id is not null then
    perform 1
    from public.wo_parts part
    join public.p1_part_costs cost on cost.part_id = part.id
    where part.work_order_id = p_work_order_id
      and part.ordering_responsibility = 'p1'
      and part.p1_order_status in ('ordered', 'received')
      and cost.unit_cost > 0
    order by part.id
    for update of part, cost;
  end if;

  with requested as (
    select line, ordinality::integer as position
    from jsonb_array_elements(v_payload -> 'lines')
      with ordinality as input(line, ordinality)
  ), canonical_requested as (
    select position,
      jsonb_build_object(
        'type', line ->> 'type',
        'description', line ->> 'description',
        'qty', (line ->> 'qty')::numeric,
        'rate', (line ->> 'rate')::numeric,
        'is_taxable', (line ->> 'isTaxable')::boolean,
        'source_invoice_line_id', nullif(line ->> 'sourceInvoiceLineId', ''),
        'source_work_order_part_id', nullif(line ->> 'sourceWorkOrderPartId', ''),
        'source_unit_cost', (line ->> 'sourceUnitCost')::numeric,
        'markup_percent', (line ->> 'markupPercent')::numeric
      ) as line
    from requested
  ), omitted_parts as (
    select 1000 + row_number() over(order by part.created_at, part.id) as position,
      jsonb_build_object(
        'type', 'Parts/Hardware',
        'description', part.description || case
          when nullif(btrim(coalesce(part.part_number, '')), '') is null then ''
          else ' (' || btrim(part.part_number) || ')' end,
        'qty', round(coalesce(part.qty, 1), 2),
        'rate', round(cost.unit_cost * 1.25, 2),
        'is_taxable', false,
        'source_invoice_line_id', null,
        'source_work_order_part_id', part.id,
        'source_unit_cost', cost.unit_cost,
        'markup_percent', 25.0
      ) as line
    from public.wo_parts part
    join public.p1_part_costs cost on cost.part_id = part.id
    where p_work_order_id is not null
      and part.work_order_id = p_work_order_id
      and part.ordering_responsibility = 'p1'
      and part.p1_order_status in ('ordered', 'received')
      and cost.unit_cost > 0
      and not (part.id = any(v_p1_part_ids))
      and not exists (
        select 1
        from public.invoice_lines existing_line
        join public.invoices existing_invoice
          on existing_invoice.id = existing_line.invoice_id
        where existing_line.source_work_order_part_id = part.id
          and existing_invoice.invoice_type = 'staff'
          and existing_invoice.deleted_at is null
          and existing_invoice.id is distinct from p_invoice_id
      )
  ), all_lines as (
    select * from canonical_requested
    union all
    select * from omitted_parts
  )
  select coalesce(jsonb_agg(line order by position), '[]'::jsonb), count(*)::integer
  into v_lines, v_line_count
  from all_lines;
  if v_line_count = 0 or v_line_count > 1000 then
    raise exception 'Staff invoices require between 1 and 1000 lines'
      using errcode = '22023';
  end if;

  select round(coalesce(sum(
      round((line ->> 'qty')::numeric, 2)
      * round((line ->> 'rate')::numeric, 2)
    ), 0), 2),
    coalesce(sum(case when (line ->> 'is_taxable')::boolean then
      (line ->> 'qty')::numeric * (line ->> 'rate')::numeric
    else 0 end), 0)
  into v_subtotal, v_taxable_subtotal
  from jsonb_array_elements(v_lines) line;
  if v_subtotal > 99999999.99 then
    raise exception 'Invoice subtotal exceeds the supported money range'
      using errcode = '22023';
  end if;

  v_tax_state := coalesce(
    v_target_work_order.store_state,
    v_payload ->> 'taxState'
  );
  case v_payload ->> 'taxMode'
    when 'none' then
      v_sales_tax := 0;
      v_tax_rate := null;
    when 'manual_amount' then
      v_sales_tax := (v_payload ->> 'salesTaxOverride')::numeric;
      v_tax_rate := null;
    when 'manual_rate' then
      v_tax_rate := (v_payload ->> 'taxRateOverride')::numeric / 100;
      v_sales_tax := round(v_taxable_subtotal * v_tax_rate, 2);
    when 'active_db_rate' then
      if v_taxable_subtotal <= 0 then
        v_tax_rate := null;
        v_sales_tax := 0;
      else
        if v_tax_state is null then
          raise exception 'A tax state is required to resolve an active rate'
            using errcode = '22023';
        end if;
        select rate.rate into v_tax_rate
        from public.state_sales_tax_rates rate
        where rate.state_code = v_tax_state
          and rate.effective_from <= coalesce(
            (v_payload ->> 'serviceDate')::date,
            (v_payload ->> 'invoiceDate')::date
          )
          and (rate.effective_to is null or rate.effective_to >= coalesce(
            (v_payload ->> 'serviceDate')::date,
            (v_payload ->> 'invoiceDate')::date
          ))
        order by rate.effective_from desc
        limit 1;
        if v_tax_rate is null then
          raise exception 'No active database tax rate is available for this invoice'
            using errcode = 'P0002';
        end if;
        if v_tax_rate < 0 or v_tax_rate > 1 then
          raise exception 'The configured database tax rate is invalid'
            using errcode = '23514';
        end if;
        v_sales_tax := round(v_taxable_subtotal * v_tax_rate, 2);
      end if;
  end case;
  if v_subtotal + v_sales_tax > 99999999.99 then
    raise exception 'Invoice total exceeds the supported money range'
      using errcode = '22023';
  end if;

  if p_invoice_id is null then
    if (v_payload ->> 'userTypedNum')::boolean then
      v_num := v_payload ->> 'num';
    else
      -- Allocate only inside the authoritative transaction. The number-series
      -- row serializes normal callers; the bounded retry also covers a custom
      -- user series colliding with the default series or a legacy/manual row.
      v_num := null;
    end if;
  else
    v_num := case when (v_payload ->> 'userTypedNum')::boolean
      then v_payload ->> 'num' else v_existing.num end;
  end if;

  v_guard_id := public.open_invoice_financial_guard(
    p_actor_id, 'staff_save', p_operation_id, p_invoice_id,
    p_work_order_id, true, true, true, false,
    case when p_work_order_id is null then null else 'staff_billing' end
  );

  loop
    if p_invoice_id is null
       and not (v_payload ->> 'userTypedNum')::boolean then
      v_num := public.next_staff_invoice_num(p_actor_id);
    end if;

    begin
      v_invoice_id := public.save_staff_billing_invoice_v3(
        p_actor_id,
        p_invoice_id,
        v_num,
        p_work_order_id,
        v_payload ->> 'storeNumber',
        v_payload ->> 'storeAddress',
        v_payload ->> 'cme',
        (v_payload ->> 'invoiceDate')::date,
        (v_payload ->> 'serviceDate')::date,
        (v_payload ->> 'dueDate')::date,
        v_payload ->> 'terms',
        v_payload ->> 'state',
        v_sales_tax,
        v_tax_state,
        v_tax_rate,
        v_payload ->> 'territory',
        v_payload ->> 'equipmentTag',
        v_lines,
        v_source_ids
      );
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      if p_invoice_id is not null
         or (v_payload ->> 'userTypedNum')::boolean
         or v_constraint_name is distinct from 'invoices_staff_num_unique' then
        raise;
      end if;
      v_number_attempt := v_number_attempt + 1;
      if v_number_attempt >= 6 then
        raise exception 'Could not allocate an unused P1 invoice number'
          using errcode = '23505';
      end if;
    end;
  end loop;
  if p_invoice_id is null and not public.invoice_financial_guard_exists(
    v_invoice_id, p_work_order_id, 'header', null
  ) then
    raise exception 'Invoice creation capability was not bound'
      using errcode = '42501';
  end if;

  select invoice.* into strict v_invoice
  from public.invoices invoice where invoice.id = v_invoice_id;
  if p_invoice_id is not null
     and v_invoice.invoice_version <= p_expected_invoice_version then
    raise exception 'Invoice version did not advance' using errcode = 'PT409';
  end if;
  if p_work_order_id is not null then
    select activity.id into v_activity_id
    from public.activities activity
    where activity.work_order_id = p_work_order_id
      and activity.event_key = 'staff_billing'
      and activity.event_data ->> 'invoiceId' = v_invoice.id::text
      and activity.event_data ->> 'operationId' = p_operation_id::text
      and activity.deleted_at is null
    order by activity.created_at desc, activity.id desc
    limit 1;
    if v_activity_id is null then
      raise exception 'Staff billing evidence was not created'
        using errcode = '23514';
    end if;
  end if;

  return public.finish_invoice_financial_operation(
    p_operation_id,
    v_invoice.id,
    jsonb_build_object(
      'invoiceId', v_invoice.id,
      'invoiceVersion', v_invoice.invoice_version,
      'invoiceNum', v_invoice.num,
      'workOrderId', p_work_order_id,
      'assignmentVersion', p_expected_assignment_version,
      'workflowCycle', p_expected_workflow_cycle,
      'state', v_invoice.state,
      'subtotal', v_invoice.subtotal,
      'salesTax', v_invoice.sales_tax,
      'total', v_invoice.total,
      'lineCount', v_line_count,
      'sourceInvoiceCount', v_source_count
    ),
    v_activity_id
  );
end;
$$;

create function public.delete_invoice_admin_v1(
  p_actor_id uuid,
  p_invoice_id uuid,
  p_invoice_type text,
  p_expected_invoice_version bigint,
  p_operation_id uuid,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_invoice public.invoices%rowtype;
  v_work_order public.work_orders%rowtype;
  v_work_order_id text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_replay jsonb;
  v_guard_id bigint;
  v_activity_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_actor_id is null
     or p_invoice_id is null
     or p_operation_id is null
     or p_invoice_type not in ('contractor', 'staff')
     or p_expected_invoice_version is null
     or p_expected_invoice_version < 0
     or length(coalesce(v_reason, '')) > 2000 then
    raise exception 'Invoice delete identity is invalid' using errcode = '22023';
  end if;
  select profile.* into v_actor
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');
  if not found
     or public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Active operational P1 staff access is required'
      using errcode = '42501';
  end if;

  select invoice.work_order_id into v_work_order_id
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.invoice_type = p_invoice_type;
  if not found then
    raise exception 'Invoice was not found' using errcode = 'P0002';
  end if;
  if (v_work_order_id is null) <> (
    p_expected_assignment_version is null
    and p_expected_workflow_cycle is null
  ) then
    raise exception 'Work-order versions do not match this invoice'
      using errcode = '22023';
  end if;

  if v_work_order_id is not null then
    select work_order.* into v_work_order
    from public.work_orders work_order
    where work_order.id = v_work_order_id
    for update;
    if not found then
      raise exception 'Linked work order was not found' using errcode = 'P0002';
    end if;
    if v_work_order.contractor_assignment_version is distinct from
         p_expected_assignment_version
       or v_work_order.workflow_cycle is distinct from
         p_expected_workflow_cycle then
      raise exception 'Work order changed. Refresh and try again.'
        using errcode = 'PT409';
    end if;
  end if;

  select invoice.* into v_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.invoice_type = p_invoice_type
  for update;
  if not found or v_invoice.work_order_id is distinct from v_work_order_id then
    raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
  end if;

  v_replay := public.begin_invoice_financial_operation(
    p_operation_id, p_actor_id, 'admin_delete', p_invoice_id,
    p_invoice_type, v_work_order_id, p_expected_assignment_version,
    p_expected_workflow_cycle, p_expected_invoice_version,
    jsonb_build_object(
      'invoiceId', p_invoice_id,
      'invoiceType', p_invoice_type,
      'reason', v_reason,
      'action', 'delete'
    )
  );
  if v_replay is not null then return v_replay; end if;

  if v_invoice.deleted_at is not null then
    raise exception 'Invoice was already deleted' using errcode = 'PT409';
  end if;
  if v_invoice.invoice_version is distinct from p_expected_invoice_version then
    raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
  end if;
  if p_invoice_type = 'staff' and v_invoice.state not in ('draft', 'submitted') then
    raise exception 'Only draft or submitted P1 invoices can be deleted'
      using errcode = '55000';
  end if;
  if p_invoice_type = 'staff' and (
    v_invoice.qbo_invoice_id is not null or v_invoice.qbo_synced_at is not null
  ) then
    raise exception 'QuickBooks-synced billing invoices are locked'
      using errcode = '55000';
  end if;
  if p_invoice_type = 'contractor' and exists (
    select 1
    from public.staff_invoice_sources source
    join public.invoices staff_invoice on staff_invoice.id = source.staff_invoice_id
    where source.contractor_invoice_id = v_invoice.id
      and staff_invoice.deleted_at is null
  ) then
    raise exception 'Invoice is already used by a P1 billing invoice'
      using errcode = '22023';
  end if;

  v_guard_id := public.open_invoice_financial_guard(
    p_actor_id, 'admin_delete', p_operation_id, v_invoice.id,
    v_work_order_id, true, false, false, p_invoice_type = 'contractor',
    case when v_work_order_id is null then null
      when p_invoice_type = 'contractor' then 'invoice_deleted'
      else 'staff_billing' end
  );
  if p_invoice_type = 'contractor' then
    perform set_config('app.contractor_invoice_delete_transition', 'delete_own', true);
  end if;
  update public.invoices invoice
  set deleted_at = clock_timestamp(),
      deleted_by = p_actor_id,
      updated_at = clock_timestamp()
  where invoice.id = v_invoice.id
    and invoice.invoice_version = p_expected_invoice_version
    and invoice.deleted_at is null
  returning * into v_invoice;
  if not found then
    raise exception 'Invoice changed. Refresh and try again.' using errcode = 'PT409';
  end if;

  if v_work_order_id is not null then
    insert into public.activities(
      work_order_id, author_id, author_name, text, type,
      is_staff_override, is_staff_only, event_key, event_data
    ) values (
      v_work_order_id,
      p_actor_id,
      v_actor.name,
      case when p_invoice_type = 'contractor'
        then format('Contractor invoice #%s deleted by %s.',
          v_invoice.num, v_actor.name)
        else format('P1 invoice #%s deleted by %s.',
          v_invoice.num, v_actor.name) end,
      'system',
      false,
      true,
      case when p_invoice_type = 'contractor'
        then 'invoice_deleted' else 'staff_billing' end,
      jsonb_build_object(
        'action', 'deleted',
        'invoiceId', v_invoice.id,
        'invoiceNum', v_invoice.num,
        'invoiceType', p_invoice_type,
        'reason', v_reason,
        'deletedBy', p_actor_id,
        'operationId', p_operation_id
      )
    ) returning id into v_activity_id;
  end if;

  return public.finish_invoice_financial_operation(
    p_operation_id,
    v_invoice.id,
    jsonb_build_object(
      'invoiceId', v_invoice.id,
      'invoiceVersion', v_invoice.invoice_version,
      'invoiceNum', v_invoice.num,
      'invoiceType', p_invoice_type,
      'workOrderId', v_work_order_id,
      'assignmentVersion', p_expected_assignment_version,
      'workflowCycle', p_expected_workflow_cycle,
      'deletedAt', v_invoice.deleted_at
    ),
    v_activity_id
  );
end;
$$;

create table public.work_order_billing_operations (
  operation_id uuid primary key
    references public.financial_operation_claims(operation_id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  work_order_id text not null references public.work_orders(id) on delete restrict,
  assignment_version integer not null check (assignment_version >= 0),
  workflow_cycle integer not null check (workflow_cycle >= 0),
  expected_lifecycle_version bigint not null check (expected_lifecycle_version >= 0),
  result jsonb,
  parent_snapshot jsonb,
  activity_snapshot jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint work_order_billing_operation_outcome_complete check (
    (result is null and parent_snapshot is null and activity_snapshot is null)
    or (result is not null and parent_snapshot is not null and activity_snapshot is not null)
  )
);

alter table public.work_order_billing_operations enable row level security;
revoke all on public.work_order_billing_operations
  from public, anon, authenticated, service_role;

alter table public.invoice_financial_transition_guards
  add column billing_operation_id uuid
    references public.work_order_billing_operations(operation_id) on delete cascade;

alter table public.invoice_financial_transition_guards
  add constraint invoice_financial_guard_one_operation_kind check (
    operation_id is null or billing_operation_id is null
  );

create or replace function public.invoice_financial_guard_exists(
  p_invoice_id uuid,
  p_work_order_id text,
  p_permission text,
  p_event_key text default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.invoice_financial_transition_guards guard
    where guard.transaction_id = txid_current()
      and (auth.uid() is null or guard.actor_id = auth.uid())
      and (
        guard.operation_id is null
        or exists (
          select 1 from public.invoice_financial_operations operation
          where operation.operation_id = guard.operation_id
            and operation.actor_id = guard.actor_id
            and operation.command_kind = guard.command_kind
        )
      )
      and (
        guard.billing_operation_id is null
        or exists (
          select 1 from public.work_order_billing_operations operation
          where operation.operation_id = guard.billing_operation_id
            and operation.actor_id = guard.actor_id
            and operation.work_order_id is not distinct from guard.work_order_id
        )
      )
      and (p_invoice_id is null or guard.invoice_id = p_invoice_id)
      and guard.work_order_id is not distinct from p_work_order_id
      and case p_permission
        when 'header' then guard.header_allowed
        when 'lines' then guard.lines_allowed
        when 'sources' then guard.sources_allowed
        when 'parent' then guard.parent_allowed
        when 'event' then guard.event_key is not distinct from p_event_key
        else false
      end
  );
$$;

create function public.mark_work_order_ready_for_billing_v1(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_operation public.work_order_billing_operations%rowtype;
  v_inserted integer;
  v_activity_id uuid;
  v_result jsonb;
begin
  if p_operation_id is null
     or nullif(btrim(coalesce(p_work_order_id, '')), '') is null
     or p_expected_assignment_version is null
     or p_expected_assignment_version < 0
     or p_expected_workflow_cycle is null
     or p_expected_workflow_cycle < 0
     or p_expected_lifecycle_version is null
     or p_expected_lifecycle_version < 0 then
    raise exception 'Work-order identity and expected versions are required'
      using errcode = '22023';
  end if;
  select profile.* into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');
  if not found
     or public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'Active operational P1 staff access is required'
      using errcode = '42501';
  end if;

  select work_order.* into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;
  if not found then
    raise exception 'Work order was not found' using errcode = 'P0002';
  end if;

  insert into public.financial_operation_claims(operation_id, actor_id, command_kind)
  values(p_operation_id, v_actor.id, 'work_order_ready')
  on conflict (operation_id) do nothing;
  if not exists (
    select 1 from public.financial_operation_claims claim
    where claim.operation_id = p_operation_id
      and claim.actor_id = v_actor.id
      and claim.command_kind = 'work_order_ready'
  ) then
    raise exception 'Operation identity was reused with another financial action'
      using errcode = 'PT409';
  end if;

  insert into public.work_order_billing_operations(
    operation_id, actor_id, work_order_id, assignment_version,
    workflow_cycle, expected_lifecycle_version
  ) values (
    p_operation_id, v_actor.id, v_work_order.id,
    p_expected_assignment_version, p_expected_workflow_cycle,
    p_expected_lifecycle_version
  ) on conflict (operation_id) do nothing;
  get diagnostics v_inserted = row_count;

  select operation.* into strict v_operation
  from public.work_order_billing_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if v_operation.actor_id is distinct from v_actor.id
     or v_operation.work_order_id is distinct from v_work_order.id
     or v_operation.assignment_version is distinct from p_expected_assignment_version
     or v_operation.workflow_cycle is distinct from p_expected_workflow_cycle
     or v_operation.expected_lifecycle_version is distinct from
       p_expected_lifecycle_version then
    raise exception 'Operation identity was reused with different input'
      using errcode = 'PT409';
  end if;
  if v_inserted = 0 then
    if v_operation.result is null
       or v_operation.parent_snapshot is distinct from
         public.invoice_financial_parent_snapshot(v_work_order.id)
       or v_operation.activity_snapshot is distinct from
         public.invoice_financial_activity_snapshot(
           nullif(v_operation.result ->> 'activityId', '')::uuid
         ) then
      raise exception 'Work order changed after this operation. Refresh and reconcile.'
        using errcode = 'PT409';
    end if;
    return v_operation.result
      || jsonb_build_object('applied', false, 'reason', 'already_applied');
  end if;

  if v_work_order.contractor_assignment_version is distinct from
       p_expected_assignment_version
     or v_work_order.workflow_cycle is distinct from p_expected_workflow_cycle
     or v_work_order.lifecycle_version is distinct from
       p_expected_lifecycle_version then
    raise exception 'Work order changed. Refresh and try again.'
      using errcode = 'PT409';
  end if;
  if v_work_order.status <> 'completed'
     or v_work_order.functional_status::text is distinct from 'Completed' then
    raise exception 'Only completed work can move to Pending 7-Eleven Submission'
      using errcode = 'PT409';
  end if;

  insert into public.invoice_financial_transition_guards(
    transaction_id, actor_id, command_kind, billing_operation_id,
    invoice_id, work_order_id, header_allowed, lines_allowed,
    sources_allowed, parent_allowed, event_key
  ) values (
    txid_current(), v_actor.id, 'work_order_ready', p_operation_id,
    null, v_work_order.id, false, false, false, true, 'staff_billing'
  );

  update public.work_orders work_order
  set status = 'pending_invoice', updated_at = clock_timestamp()
  where work_order.id = v_work_order.id
    and work_order.contractor_assignment_version = p_expected_assignment_version
    and work_order.workflow_cycle = p_expected_workflow_cycle
    and work_order.lifecycle_version = p_expected_lifecycle_version;
  if not found then
    raise exception 'Work order changed. Refresh and try again.'
      using errcode = 'PT409';
  end if;

  select work_order.* into strict v_work_order
  from public.work_orders work_order where work_order.id = p_work_order_id;
  insert into public.activities(
    work_order_id, author_id, author_name, text, type,
    is_staff_override, is_staff_only, event_key, event_data
  ) values (
    v_work_order.id,
    v_actor.id,
    v_actor.name,
    '7-Eleven portal updated. Moved to Pending 7-Eleven Submission.',
    'system',
    false,
    true,
    'staff_billing',
    jsonb_build_object(
      'action', 'moved_to_pending_invoice',
      'operationId', p_operation_id,
      'assignmentVersion', v_work_order.contractor_assignment_version,
      'workflowCycle', v_work_order.workflow_cycle,
      'lifecycleVersion', v_work_order.lifecycle_version
    )
  ) returning id into v_activity_id;

  v_result := jsonb_build_object(
    'applied', true,
    'reason', 'applied',
    'operationId', p_operation_id,
    'workOrderId', v_work_order.id,
    'assignmentVersion', v_work_order.contractor_assignment_version,
    'workflowCycle', v_work_order.workflow_cycle,
    'lifecycleVersion', v_work_order.lifecycle_version,
    'workOrderStatus', v_work_order.status,
    'functionalStatus', v_work_order.functional_status,
    'activityId', v_activity_id
  );
  update public.work_order_billing_operations operation
  set result = v_result,
      parent_snapshot = public.invoice_financial_parent_snapshot(v_work_order.id),
      activity_snapshot = public.invoice_financial_activity_snapshot(v_activity_id)
  where operation.operation_id = p_operation_id;
  delete from public.invoice_financial_transition_guards guard
  where guard.transaction_id = txid_current()
    and guard.billing_operation_id = p_operation_id;
  return v_result;
end;
$$;

-- Keep the established keyset pagination contract while adding current,
-- command-ready parent versions to each visible invoice. These are read-time
-- versions; no stale assignment snapshot is copied onto the invoice.
alter function public.list_contractor_invoices_page(
  text, text, text, text, integer, text, text
) rename to list_contractor_invoices_page_pre_financial_version;

create function public.list_contractor_invoices_page(
  p_state text default 'all',
  p_search text default null,
  p_sort text default 'recent',
  p_direction text default 'desc',
  p_limit integer default 25,
  p_cursor text default null,
  p_work_order_id text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_page jsonb;
  v_items jsonb;
begin
  v_page := public.list_contractor_invoices_page_pre_financial_version(
    p_state, p_search, p_sort, p_direction, p_limit, p_cursor,
    p_work_order_id
  );
  select coalesce(jsonb_agg(
    item || jsonb_build_object(
      'contractor_assignment_version', work_order.contractor_assignment_version,
      'workflow_cycle', work_order.workflow_cycle
    ) order by ordinality
  ), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(coalesce(v_page -> 'items', '[]'::jsonb))
    with ordinality as page_item(item, ordinality)
  left join public.work_orders work_order
    on work_order.id = item ->> 'work_order_id';
  return jsonb_set(v_page, '{items}', v_items, true);
end;
$$;

-- Compatibility wrappers retain the established review, PDF, completion,
-- estimate, controller-export, and staff-billing policies. They add the same
-- parent-before-invoice lock order and narrow capability used by new writes.
do $financial_compatibility$
declare
  v_signature text; v_proc record; v_name text; v_core text; v_call text;
  v_target text; v_actor text; v_auth text; v_event text; v_kind text;
  v_invoke text; v_return text; v_result_decl text;
  v_header boolean; v_lines boolean; v_parent boolean; v_service boolean;
begin
  foreach v_signature in array array[
    'public.review_contractor_invoice(uuid,text,text)',
    'public.retract_contractor_invoice_rejection(uuid)',
    'public.correct_contractor_invoice_total(uuid,numeric,text)',
    'public.attach_contractor_invoice_pdf(uuid,text)',
    'public.finish_contractor_invoicing(text)',
    'public.convert_contractor_estimate_to_invoice(uuid)',
    'public.mark_staff_invoice_ready(uuid,uuid)',
    'public.mark_staff_invoice_billed(uuid,uuid)'
  ] loop
    select procedure.*, pg_get_function_arguments(procedure.oid) arguments,
      pg_get_function_identity_arguments(procedure.oid) identity_arguments,
      pg_get_function_result(procedure.oid) result_type
    into strict v_proc
    from pg_proc procedure
    where procedure.oid = v_signature::regprocedure;
    v_name := v_proc.proname;
    v_core := v_name || '_financial_core';
    select string_agg(format('%I', arg_name), ',' order by ordinality)
    into v_call
    from unnest(v_proc.proargnames[1:v_proc.pronargs])
      with ordinality as args(arg_name, ordinality);
    v_service := v_name in ('mark_staff_invoice_ready', 'mark_staff_invoice_billed');
    v_actor := case when v_service then 'p_actor_id' else 'auth.uid()' end;
    v_auth := case
      when v_service then
        'if coalesce(auth.role(),'''')<>''service_role'' or (auth.uid() is not null and auth.uid() is distinct from p_actor_id) then raise exception ''Trusted service actor required'' using errcode=''42501''; end if;'
      when v_name = 'correct_contractor_invoice_total' then
        'if auth.uid() is null then raise exception ''Authentication required'' using errcode=''42501''; end if; if p_total is null or p_total::text in (''NaN'',''Infinity'',''-Infinity'') then raise exception ''A finite invoice total is required'' using errcode=''22023''; end if;'
      else
        'if auth.uid() is null then raise exception ''Authentication required'' using errcode=''42501''; end if;'
    end;
    v_header := v_name <> 'finish_contractor_invoicing';
    v_lines := v_name = 'convert_contractor_estimate_to_invoice';
    v_parent := v_name in (
      'review_contractor_invoice', 'retract_contractor_invoice_rejection',
      'finish_contractor_invoicing', 'convert_contractor_estimate_to_invoice',
      'mark_staff_invoice_billed'
    );
    v_kind := case when v_name = 'convert_contractor_estimate_to_invoice'
      then 'estimate_convert' else 'compat:' || v_name end;
    v_event := case v_name
      when 'review_contractor_invoice' then
        'case when lower(trim(coalesce(p_action,'''')))=''approve'' then ''invoice_approved'' else ''invoice_rejected'' end'
      when 'retract_contractor_invoice_rejection' then '''invoice_rejection_retracted'''
      when 'correct_contractor_invoice_total' then '''contractor_invoice_total_corrected'''
      when 'finish_contractor_invoicing' then '''contractor_invoicing_completed'''
      when 'convert_contractor_estimate_to_invoice' then '''contractor_estimate_converted'''
      when 'mark_staff_invoice_ready' then '''staff_invoice_ready'''
      when 'mark_staff_invoice_billed' then
        'case when (select i.document_kind from public.invoices i where i.id=v_invoice)=''capital_quote'' then ''capital_quote_submitted'' else ''staff_billing'' end'
      else 'null'
    end;
    if v_name = 'finish_contractor_invoicing' then
      v_target := 'v_target:=p_work_order_id; perform 1 from public.work_orders w where w.id=v_target for update;';
    elsif v_name = 'convert_contractor_estimate_to_invoice' then
      v_target := $estimate$
        select estimate.work_order_id into v_target
        from public.contractor_estimates estimate where estimate.id=p_estimate_id;
        perform 1 from public.work_orders work_order where work_order.id=v_target for update;
        perform 1 from public.contractor_estimates estimate where estimate.id=p_estimate_id for update;
        if exists(select 1 from public.contractor_estimates estimate where estimate.id=p_estimate_id
          and estimate.work_order_id is distinct from v_target) then
          raise exception 'Estimate parent changed. Refresh and retry.' using errcode='PT409'; end if;
      $estimate$;
    else
      v_target := $invoice$
        v_invoice:=p_invoice_id;
        select invoice.work_order_id into v_target from public.invoices invoice where invoice.id=v_invoice;
        perform 1 from public.work_orders work_order where work_order.id=v_target for update;
        perform 1 from public.invoices invoice where invoice.id=v_invoice for update;
        if exists(select 1 from public.invoices invoice where invoice.id=v_invoice
          and invoice.work_order_id is distinct from v_target) then
          raise exception 'Invoice parent changed. Refresh and retry.' using errcode='PT409'; end if;
      $invoice$;
    end if;
    if v_proc.result_type = 'void' then
      v_result_decl := '';
      v_invoke := format('perform public.%I(%s);', v_core, v_call);
      v_return := 'return;';
    else
      v_result_decl := format('v_result %s;', v_proc.result_type);
      v_invoke := format('v_result:=public.%I(%s);', v_core, v_call);
      v_return := 'return v_result;';
    end if;
    execute format('alter function %s rename to %I', v_signature, v_core);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',
      v_core, v_proc.identity_arguments);
    execute format($definition$
      create function public.%I(%s) returns %s language plpgsql security definer
      set search_path=public,pg_temp as $body$
      declare v_target text; v_invoice uuid; v_actor uuid; v_guard bigint; %s
      begin
        %s
        v_actor:=%s;
        if not exists(select 1 from public.profiles profile where profile.id=v_actor and profile.active=true) then
          raise exception 'Active profile required' using errcode='42501'; end if;
        %s
        v_guard:=public.open_invoice_financial_guard(v_actor,%L,null,v_invoice,v_target,%L,%L,false,%L,%s);
        %s
        perform public.close_invoice_financial_guard(v_guard);
        %s
      end;
      $body$;
    $definition$, v_name, v_proc.arguments, v_proc.result_type,
      v_result_decl, v_auth, v_actor, v_target, v_kind, v_header,
      v_lines, v_parent, v_event, v_invoke, v_return);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',
      v_name, v_proc.identity_arguments);
    execute format('grant execute on function public.%I(%s) to %s',
      v_name, v_proc.identity_arguments,
      case when v_service then 'service_role'
        else 'authenticated,service_role' end);
  end loop;
end;
$financial_compatibility$;

alter function public.review_contractor_invoices(uuid[], text, text)
  rename to review_contractor_invoices_financial_core;
revoke all on function public.review_contractor_invoices_financial_core(uuid[], text, text)
  from public, anon, authenticated, service_role;
create function public.review_contractor_invoices(
  p_invoice_ids uuid[], p_action text, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  if auth.uid() is null or not public.is_staff() or public.is_invoice_controller() then
    raise exception 'Staff invoice-review access is required' using errcode='42501';
  end if;
  perform 1 from public.work_orders work_order where work_order.id in (
    select invoice.work_order_id from public.invoices invoice
    where invoice.id=any(coalesce(p_invoice_ids,'{}'::uuid[]))
  ) order by work_order.id for update;
  v_result := public.review_contractor_invoices_financial_core(
    p_invoice_ids, p_action, p_reason
  );
  return v_result;
end;
$$;
revoke all on function public.review_contractor_invoices(uuid[], text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_contractor_invoices(uuid[], text, text)
  to authenticated, service_role;

alter function public.confirm_controller_invoice_export(uuid, uuid)
  rename to confirm_controller_invoice_export_financial_core;
revoke all on function public.confirm_controller_invoice_export_financial_core(uuid, uuid)
  from public, anon, authenticated, service_role;
create function public.confirm_controller_invoice_export(
  p_batch_id uuid, p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record; v_result jsonb;
  v_guards bigint[] := '{}'::bigint[]; v_guard bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or (auth.uid() is not null and auth.uid() is distinct from p_actor_id)
     or not public.profile_has_staff_permission(p_actor_id, 'quickbooks_handoff')
     or not exists(select 1 from public.profiles profile
       where profile.id=p_actor_id and profile.active=true) then
    raise exception 'Trusted active QuickBooks handoff actor required'
      using errcode='42501';
  end if;
  perform 1 from public.work_orders work_order where work_order.id in (
    select invoice.work_order_id
    from public.invoices invoice
    join public.controller_invoice_export_items item on item.invoice_id=invoice.id
    where item.batch_id=p_batch_id
  ) order by work_order.id for update;
  for v_invoice in
    select invoice.id, invoice.work_order_id
    from public.invoices invoice
    join public.controller_invoice_export_items item on item.invoice_id=invoice.id
    where item.batch_id=p_batch_id order by invoice.id for update of invoice
  loop
    v_guard := public.open_invoice_financial_guard(
      p_actor_id, 'compat:confirm_controller_invoice_export', null,
      v_invoice.id, v_invoice.work_order_id, true, false, false, true,
      'invoice_sent_to_quickbooks'
    );
    v_guards := array_append(v_guards, v_guard);
  end loop;
  v_result := public.confirm_controller_invoice_export_financial_core(
    p_batch_id, p_actor_id
  );
  foreach v_guard in array v_guards loop
    perform public.close_invoice_financial_guard(v_guard);
  end loop;
  return v_result;
end;
$$;
revoke all on function public.confirm_controller_invoice_export(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_controller_invoice_export(uuid, uuid)
  to service_role;

revoke all on function
  public.invoice_financial_is_owner_maintenance(),
  public.invoice_financial_invoice_snapshot(uuid),
  public.invoice_financial_line_snapshot(uuid),
  public.invoice_financial_source_snapshot(uuid),
  public.invoice_financial_parent_snapshot(text),
  public.invoice_financial_activity_snapshot(uuid),
  public.invoice_financial_guard_exists(uuid,text,text,text),
  public.invoice_financial_creation_guard_id(text,text[]),
  public.open_invoice_financial_guard(uuid,text,uuid,uuid,text,boolean,boolean,boolean,boolean,text),
  public.close_invoice_financial_guard(bigint),
  public.begin_invoice_financial_operation(uuid,uuid,text,uuid,text,text,integer,integer,bigint,jsonb),
  public.finish_invoice_financial_operation(uuid,uuid,jsonb,uuid),
  public.write_contractor_invoice_v1(text,text,integer,integer,uuid,bigint,uuid,jsonb),
  public.normalize_contractor_invoice_payload(jsonb),
  public.normalize_staff_invoice_payload(jsonb),
  public.zzz_protect_invoice_financial_row(),
  public.zzz_protect_invoice_financial_line(),
  public.zzz_protect_staff_invoice_source(),
  public.touch_invoice_after_source_change(),
  public.zzz_protect_invoice_financial_parent(),
  public.zzz_protect_invoice_financial_activity()
from public, anon, authenticated, service_role;

revoke all on function
  public.save_contractor_invoice_draft_v1(text,integer,integer,uuid,bigint,uuid,jsonb),
  public.submit_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb),
  public.revise_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb),
  public.delete_own_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid),
  public.mark_work_order_ready_for_billing_v1(text,integer,integer,bigint,uuid),
  public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb),
  public.delete_invoice_admin_v1(uuid,uuid,text,bigint,uuid,integer,integer,text),
  public.list_contractor_invoices_page(text,text,text,text,integer,text,text),
  public.list_contractor_invoices_page_pre_financial_version(text,text,text,text,integer,text,text)
from public, anon, authenticated, service_role;

grant execute on function
  public.save_contractor_invoice_draft_v1(text,integer,integer,uuid,bigint,uuid,jsonb),
  public.submit_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb),
  public.revise_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb),
  public.delete_own_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid),
  public.mark_work_order_ready_for_billing_v1(text,integer,integer,bigint,uuid)
to authenticated;

grant execute on function
  public.list_contractor_invoices_page(text,text,text,text,integer,text,text),
  public.list_contractor_invoices_page_pre_financial_version(text,text,text,text,integer,text,text)
to authenticated, service_role;

grant execute on function
  public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb),
  public.delete_invoice_admin_v1(uuid,uuid,text,bigint,uuid,integer,integer,text)
to service_role;

revoke all on sequence public.invoice_financial_transition_guards_id_seq
  from public, anon, authenticated, service_role;

comment on column public.invoices.invoice_version is
  'Server-owned monotonic version for the invoice header and all line/source changes.';
comment on table public.invoice_financial_operations is
  'Private idempotency and evidence ledger for versioned invoice financial commands.';
comment on table public.invoice_financial_transition_guards is
  'Private transaction capabilities; exact actor, operation, invoice and work-order targets only.';

commit;
