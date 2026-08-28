-- Make the contractor-payables handoff a two-step, controller-owned workflow.
-- Building/downloading an archive stages a batch but does not claim that the
-- invoices reached QuickBooks. A controller explicitly confirms the batch
-- only after the QuickBooks import succeeds. The legacy `paid` enum value is
-- retained as the portal's "sent to QuickBooks" state, while paid_at remains
-- reserved for a real payment event.

begin;

insert into public.staff_permission_grants (
  profile_id,
  permission,
  granted_by
)
select
  permission_grant.profile_id,
  'quickbooks_handoff',
  permission_grant.granted_by
from public.staff_permission_grants permission_grant
where permission_grant.permission = 'invoice_controller'
on conflict (profile_id, permission) do nothing;

comment on table public.staff_permission_grants is
  'Data-driven staff capabilities. quickbooks_export is legacy download access; quickbooks_handoff is the narrow capability to stage and confirm accounting handoffs; invoice_controller is the optional controller-only portal restriction.';

alter table public.controller_invoice_export_batches
  add column if not exists status text,
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references public.profiles(id),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists cancellation_reason text;

-- Every historic batch used the old one-step operation and therefore already
-- changed its invoices to paid/sent. Preserve that fact in the new model.
update public.controller_invoice_export_batches batch
set status = 'confirmed',
    confirmed_at = coalesce(batch.confirmed_at, batch.created_at),
    confirmed_by = coalesce(batch.confirmed_by, batch.created_by)
where batch.status is null;

alter table public.controller_invoice_export_batches
  alter column status set default 'pending',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'controller_export_batch_status_check'
      and conrelid = 'public.controller_invoice_export_batches'::regclass
  ) then
    alter table public.controller_invoice_export_batches
      add constraint controller_export_batch_status_check
      check (status in ('pending', 'confirmed', 'cancelled'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'controller_export_batch_resolution_check'
      and conrelid = 'public.controller_invoice_export_batches'::regclass
  ) then
    alter table public.controller_invoice_export_batches
      add constraint controller_export_batch_resolution_check
      check (
        (status = 'pending'
          and confirmed_at is null
          and confirmed_by is null
          and cancelled_at is null
          and cancelled_by is null)
        or
        (status = 'confirmed'
          and confirmed_at is not null
          and confirmed_by is not null
          and cancelled_at is null
          and cancelled_by is null)
        or
        (status = 'cancelled'
          and cancelled_at is not null
          and cancelled_by is not null
          and confirmed_at is null
          and confirmed_by is null
          and nullif(trim(coalesce(cancellation_reason, '')), '') is not null)
      );
  end if;
end
$$;

-- A cancelled batch must retain its item-level audit trail while allowing the
-- same still-approved invoice to be staged again later.
alter table public.controller_invoice_export_items
  drop constraint if exists controller_invoice_export_items_invoice_id_key;

create index if not exists controller_export_items_invoice
  on public.controller_invoice_export_items(invoice_id, exported_at desc);

create index if not exists controller_export_batches_status_created
  on public.controller_invoice_export_batches(status, created_at desc, id desc);

drop policy if exists controller_export_batches_read
  on public.controller_invoice_export_batches;
create policy controller_export_batches_read
  on public.controller_invoice_export_batches
  for select using (public.is_staff());

drop policy if exists controller_export_items_read
  on public.controller_invoice_export_items;
create policy controller_export_items_read
  on public.controller_invoice_export_items
  for select using (public.is_staff());

create or replace function public.stage_controller_invoice_export(
  p_batch_id uuid,
  p_actor_id uuid,
  p_object_path text,
  p_invoice_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_count integer := coalesce(cardinality(p_invoice_ids), 0);
  eligible_count integer;
  exported_total numeric(14,2);
  actor_name text;
begin
  if p_batch_id is null
     or p_actor_id is null
     or nullif(trim(coalesce(p_object_path, '')), '') is null
     or requested_count < 1
     or requested_count > 500
     or requested_count <> (
       select count(distinct requested.invoice_id)
       from unnest(p_invoice_ids) as requested(invoice_id)
     ) then
    raise exception 'A batch id, object path, and 1-500 unique invoice ids are required'
      using errcode = '22023';
  end if;

  if not public.profile_has_staff_permission(
    p_actor_id,
    'quickbooks_handoff'
  ) then
    raise exception 'QuickBooks handoff permission required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if actor_name is null then
    raise exception 'Active QuickBooks controller profile not found'
      using errcode = 'P0002';
  end if;

  perform 1
  from public.invoices invoice
  where invoice.id = any(p_invoice_ids)
  order by invoice.id
  for update;

  select count(*), round(coalesce(sum(invoice.total), 0), 2)
  into eligible_count, exported_total
  from public.invoices invoice
  where invoice.id = any(p_invoice_ids)
    and invoice.invoice_type = 'contractor'
    and invoice.state = 'approved'
    and invoice.deleted_at is null
    and (
      invoice.pdf_storage_path is not null
      or exists (
        select 1
        from public.invoice_lines line
        where line.invoice_id = invoice.id
      )
    )
    and not exists (
      select 1
      from public.controller_invoice_export_items existing_item
      join public.controller_invoice_export_batches existing_batch
        on existing_batch.id = existing_item.batch_id
      where existing_item.invoice_id = invoice.id
        and existing_batch.status in ('pending', 'confirmed')
    );

  if eligible_count <> requested_count then
    raise exception 'One or more invoices changed, lack source data, or already belong to an active handoff batch'
      using errcode = '40001';
  end if;

  insert into public.controller_invoice_export_batches (
    id,
    created_by,
    object_path,
    invoice_count,
    total,
    status
  ) values (
    p_batch_id,
    p_actor_id,
    trim(p_object_path),
    requested_count,
    exported_total,
    'pending'
  );

  insert into public.controller_invoice_export_items (
    batch_id,
    invoice_id,
    invoice_num,
    work_order_id,
    contractor_id,
    total
  )
  select
    p_batch_id,
    invoice.id,
    invoice.num,
    invoice.work_order_id,
    invoice.contractor_id,
    coalesce(invoice.total, 0)
  from public.invoices invoice
  where invoice.id = any(p_invoice_ids);

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data,
    activity_channel,
    is_staff_only
  )
  select
    item.work_order_id,
    p_actor_id,
    actor_name,
    format(
      'Invoice #%s added to QuickBooks handoff batch %s by %s; awaiting import confirmation.',
      item.invoice_num,
      p_batch_id,
      actor_name
    ),
    'system',
    'invoice_quickbooks_handoff_staged',
    jsonb_build_object(
      'invoiceId', item.invoice_id,
      'invoiceNum', item.invoice_num,
      'batchId', p_batch_id,
      'outcome', 'awaiting_quickbooks_confirmation'
    ),
    'internal_note',
    true
  from public.controller_invoice_export_items item
  where item.batch_id = p_batch_id
    and item.work_order_id is not null;

  return jsonb_build_object(
    'batchId', p_batch_id,
    'status', 'pending',
    'invoiceCount', requested_count,
    'total', exported_total,
    'objectPath', trim(p_object_path)
  );
end;
$$;

create or replace function public.confirm_controller_invoice_export(
  p_batch_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch public.controller_invoice_export_batches%rowtype;
  actor_name text;
  item_count integer;
begin
  if p_batch_id is null or p_actor_id is null then
    raise exception 'Batch and actor are required' using errcode = '22023';
  end if;

  if not public.profile_has_staff_permission(
    p_actor_id,
    'quickbooks_handoff'
  ) then
    raise exception 'QuickBooks handoff permission required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if actor_name is null then
    raise exception 'Active QuickBooks controller profile not found'
      using errcode = 'P0002';
  end if;

  select candidate.*
  into batch
  from public.controller_invoice_export_batches candidate
  where candidate.id = p_batch_id;

  if not found then
    raise exception 'QuickBooks handoff batch not found' using errcode = 'P0002';
  end if;

  if batch.status = 'confirmed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_confirmed',
      'batchId', batch.id,
      'status', batch.status,
      'confirmedAt', batch.confirmed_at,
      'confirmedBy', batch.confirmed_by
    );
  end if;

  if batch.status <> 'pending' then
    raise exception 'Only a pending handoff batch can be confirmed'
      using errcode = '55000';
  end if;

  perform 1
  from public.invoices invoice
  join public.controller_invoice_export_items item
    on item.invoice_id = invoice.id
  where item.batch_id = batch.id
  order by invoice.id
  for update of invoice;

  -- Lock invoices before the batch everywhere. Payment holds use the same
  -- order, avoiding a batch/invoice deadlock under concurrent staff actions.
  select candidate.*
  into batch
  from public.controller_invoice_export_batches candidate
  where candidate.id = p_batch_id
  for update;

  if not found then
    raise exception 'QuickBooks handoff batch not found' using errcode = 'P0002';
  end if;

  if batch.status = 'confirmed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_confirmed',
      'batchId', batch.id,
      'status', batch.status,
      'confirmedAt', batch.confirmed_at,
      'confirmedBy', batch.confirmed_by
    );
  end if;

  if batch.status <> 'pending' then
    raise exception 'Only a pending handoff batch can be confirmed'
      using errcode = '55000';
  end if;

  select count(*)
  into item_count
  from public.controller_invoice_export_items item
  join public.invoices invoice on invoice.id = item.invoice_id
  where item.batch_id = batch.id
    and invoice.invoice_type = 'contractor'
    and invoice.state = 'approved'
    and invoice.deleted_at is null;

  if item_count <> batch.invoice_count then
    raise exception 'One or more invoices changed after the handoff was staged; cancel and rebuild the batch'
      using errcode = '40001';
  end if;

  perform set_config('app.quickbooks_handoff_transition', 'confirm', true);

  update public.invoices invoice
  set state = 'paid',
      qbo_synced_at = now(),
      paid_at = null,
      updated_at = now()
  from public.controller_invoice_export_items item
  where item.batch_id = batch.id
    and item.invoice_id = invoice.id
    and invoice.invoice_type = 'contractor'
    and invoice.state = 'approved'
    and invoice.deleted_at is null;

  update public.controller_invoice_export_batches candidate
  set status = 'confirmed',
      confirmed_at = now(),
      confirmed_by = p_actor_id
  where candidate.id = batch.id
  returning candidate.* into batch;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data,
    activity_channel,
    is_staff_only
  )
  select
    item.work_order_id,
    p_actor_id,
    actor_name,
    format(
      'Invoice #%s confirmed imported into QuickBooks by %s in batch %s.',
      item.invoice_num,
      actor_name,
      batch.id
    ),
    'system',
    'invoice_sent_to_quickbooks',
    jsonb_build_object(
      'invoiceId', item.invoice_id,
      'invoiceNum', item.invoice_num,
      'batchId', batch.id,
      'outcome', 'confirmed_in_quickbooks'
    ),
    'internal_note',
    true
  from public.controller_invoice_export_items item
  where item.batch_id = batch.id
    and item.work_order_id is not null;

  update public.work_orders work_order
  set status = coalesce(
        public.contractor_invoice_work_order_status(work_order.id),
        'pending_invoice'::public.wo_status
      ),
      updated_at = now()
  where work_order.id in (
    select distinct item.work_order_id
    from public.controller_invoice_export_items item
    where item.batch_id = batch.id
      and item.work_order_id is not null
  )
    and work_order.status <> 'closed'
    and work_order.deleted_at is null;

  return jsonb_build_object(
    'applied', true,
    'batchId', batch.id,
    'status', batch.status,
    'invoiceCount', batch.invoice_count,
    'total', batch.total,
    'confirmedAt', batch.confirmed_at,
    'confirmedBy', batch.confirmed_by
  );
end;
$$;

create or replace function public.cancel_controller_invoice_export(
  p_batch_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch public.controller_invoice_export_batches%rowtype;
  actor_name text;
  clean_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if p_batch_id is null or p_actor_id is null or clean_reason is null then
    raise exception 'Batch, actor, and cancellation reason are required'
      using errcode = '22023';
  end if;

  if length(clean_reason) > 500 then
    raise exception 'Cancellation reason is too long' using errcode = '22023';
  end if;

  if not public.profile_has_staff_permission(
    p_actor_id,
    'quickbooks_handoff'
  ) then
    raise exception 'QuickBooks handoff permission required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if actor_name is null then
    raise exception 'Active QuickBooks controller profile not found'
      using errcode = 'P0002';
  end if;

  select candidate.*
  into batch
  from public.controller_invoice_export_batches candidate
  where candidate.id = p_batch_id
  for update;

  if not found then
    raise exception 'QuickBooks handoff batch not found' using errcode = 'P0002';
  end if;

  if batch.status <> 'pending' then
    raise exception 'Only a pending handoff batch can be cancelled'
      using errcode = '55000';
  end if;

  update public.controller_invoice_export_batches candidate
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = p_actor_id,
      cancellation_reason = clean_reason
  where candidate.id = batch.id
  returning candidate.* into batch;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data,
    activity_channel,
    is_staff_only
  )
  select
    item.work_order_id,
    p_actor_id,
    actor_name,
    format(
      'QuickBooks handoff batch %s was cancelled by %s for invoice #%s: %s',
      batch.id,
      actor_name,
      item.invoice_num,
      clean_reason
    ),
    'system',
    'invoice_quickbooks_handoff_cancelled',
    jsonb_build_object(
      'invoiceId', item.invoice_id,
      'invoiceNum', item.invoice_num,
      'batchId', batch.id,
      'outcome', 'cancelled',
      'reason', clean_reason
    ),
    'internal_note',
    true
  from public.controller_invoice_export_items item
  where item.batch_id = batch.id
    and item.work_order_id is not null;

  return jsonb_build_object(
    'applied', true,
    'batchId', batch.id,
    'status', batch.status,
    'cancelledAt', batch.cancelled_at,
    'cancelledBy', batch.cancelled_by,
    'reason', batch.cancellation_reason
  );
end;
$$;

-- Preserve the old server-only signature as a safe compatibility wrapper.
-- It now stages a batch and deliberately does not mark invoices paid.
create or replace function public.complete_controller_invoice_export(
  p_batch_id uuid,
  p_actor_id uuid,
  p_object_path text,
  p_invoice_ids uuid[]
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.stage_controller_invoice_export(
    p_batch_id,
    p_actor_id,
    p_object_path,
    p_invoice_ids
  )
$$;

create or replace function public.protect_quickbooks_handoff_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  transition_kind text := coalesce(
    current_setting('app.quickbooks_handoff_transition', true),
    ''
  );
begin
  if old.invoice_type = 'contractor'
     and old.state = 'approved'
     and new.state = 'paid'
     and not (
       auth.role() in ('service_role', '')
       and transition_kind = 'confirm'
     ) then
    raise exception 'Contractor invoices may be marked sent only by confirming a staged QuickBooks handoff batch'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_quickbooks_handoff_transition_trigger
  on public.invoices;
create trigger protect_quickbooks_handoff_transition_trigger
  before update on public.invoices
  for each row execute function public.protect_quickbooks_handoff_transition();

revoke all on function public.stage_controller_invoice_export(
  uuid, uuid, text, uuid[]
) from public, anon, authenticated;
revoke all on function public.confirm_controller_invoice_export(
  uuid, uuid
) from public, anon, authenticated;
revoke all on function public.cancel_controller_invoice_export(
  uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.complete_controller_invoice_export(
  uuid, uuid, text, uuid[]
) from public, anon, authenticated;

grant execute on function public.stage_controller_invoice_export(
  uuid, uuid, text, uuid[]
), public.confirm_controller_invoice_export(
  uuid, uuid
), public.cancel_controller_invoice_export(
  uuid, uuid, text
), public.complete_controller_invoice_export(
  uuid, uuid, text, uuid[]
) to service_role;

commit;
