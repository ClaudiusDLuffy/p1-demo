-- Separate "do not pay" from the QuickBooks handoff. Staff can place an
-- approved contractor invoice on hold with a required reason. Only an
-- authorized accounting handoff owner can release it. Holds are visible to
-- staff, audited independently, and invalidate any pending ZIP containing the
-- invoice so stale files cannot be confirmed later.

begin;

-- Invoice rows are contractor-readable through RLS. Keep active hold reasons
-- in a separate staff-only relation so internal accounting decisions never
-- become contractor-visible API fields.
create table if not exists public.contractor_invoice_payment_holds (
  invoice_id uuid primary key references public.invoices(id) on delete restrict,
  placed_at timestamptz not null default now(),
  placed_by uuid not null references public.profiles(id),
  reason text not null check (nullif(trim(reason), '') is not null)
);

create index if not exists contractor_invoice_payment_holds_placed
  on public.contractor_invoice_payment_holds(placed_at desc, invoice_id desc);

alter table public.contractor_invoice_payment_holds enable row level security;

drop policy if exists contractor_invoice_payment_holds_read
  on public.contractor_invoice_payment_holds;
create policy contractor_invoice_payment_holds_read
  on public.contractor_invoice_payment_holds
  for select using (public.is_staff());

revoke all on public.contractor_invoice_payment_holds
  from public, anon, authenticated;
grant select on public.contractor_invoice_payment_holds to authenticated;
grant all on public.contractor_invoice_payment_holds to service_role;

-- Safe forward repair if an earlier draft of this migration was run manually:
-- preserve any active holds, then remove the contractor-readable columns.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'invoices'
      and column_name = 'payment_hold_at'
  ) then
    execute $repair$
      insert into public.contractor_invoice_payment_holds (
        invoice_id,
        placed_at,
        placed_by,
        reason
      )
      select
        invoice.id,
        invoice.payment_hold_at,
        invoice.payment_hold_by,
        invoice.payment_hold_reason
      from public.invoices invoice
      where invoice.payment_hold_at is not null
        and invoice.payment_hold_by is not null
        and nullif(trim(coalesce(invoice.payment_hold_reason, '')), '') is not null
      on conflict (invoice_id) do update
      set placed_at = excluded.placed_at,
          placed_by = excluded.placed_by,
          reason = excluded.reason
    $repair$;
  end if;

  alter table public.invoices
    drop constraint if exists invoices_payment_hold_complete;
  drop index if exists public.invoices_active_payment_holds;
  alter table public.invoices
    drop column if exists payment_hold_at,
    drop column if exists payment_hold_by,
    drop column if exists payment_hold_reason;
end
$$;

create table if not exists public.contractor_invoice_payment_hold_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  invoice_num text not null,
  work_order_id text references public.work_orders(id),
  contractor_id uuid references public.profiles(id),
  action text not null check (action in ('placed', 'released')),
  reason text not null check (nullif(trim(reason), '') is not null),
  actor_id uuid not null references public.profiles(id),
  actor_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists contractor_invoice_hold_events_invoice
  on public.contractor_invoice_payment_hold_events(invoice_id, created_at desc, id desc);

create index if not exists contractor_invoice_hold_events_created
  on public.contractor_invoice_payment_hold_events(created_at desc, id desc);

alter table public.contractor_invoice_payment_hold_events enable row level security;

drop policy if exists contractor_invoice_payment_hold_events_read
  on public.contractor_invoice_payment_hold_events;
create policy contractor_invoice_payment_hold_events_read
  on public.contractor_invoice_payment_hold_events
  for select using (public.is_staff());

revoke all on public.contractor_invoice_payment_hold_events
  from public, anon, authenticated;
grant select on public.contractor_invoice_payment_hold_events to authenticated;
grant all on public.contractor_invoice_payment_hold_events to service_role;

create or replace function public.place_contractor_invoice_payment_hold(
  p_invoice_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invoice public.invoices%rowtype;
  active_hold public.contractor_invoice_payment_holds%rowtype;
  actor_name text;
  clean_reason text := nullif(trim(coalesce(p_reason, '')), '');
  pending_batch public.controller_invoice_export_batches%rowtype;
  cancelled_batch_ids uuid[] := array[]::uuid[];
begin
  if p_invoice_id is null or p_actor_id is null or clean_reason is null then
    raise exception 'Invoice, actor, and hold reason are required'
      using errcode = '22023';
  end if;

  if length(clean_reason) > 500 then
    raise exception 'Hold reason is too long' using errcode = '22023';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if actor_name is null then
    raise exception 'Active P1 staff actor required' using errcode = '42501';
  end if;

  select candidate.*
  into invoice
  from public.invoices candidate
  where candidate.id = p_invoice_id
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Contractor invoice not found' using errcode = 'P0002';
  end if;

  select hold.*
  into active_hold
  from public.contractor_invoice_payment_holds hold
  where hold.invoice_id = invoice.id;

  if found then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_held',
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num,
      'holdAt', active_hold.placed_at,
      'holdBy', active_hold.placed_by,
      'holdReason', active_hold.reason,
      'cancelledBatchIds', cancelled_batch_ids
    );
  end if;

  if invoice.state <> 'approved' then
    raise exception 'Only an approved invoice awaiting QuickBooks can be placed on hold; current state is %',
      invoice.state
      using errcode = '55000';
  end if;

  if invoice.qbo_synced_at is not null or invoice.qbo_invoice_id is not null then
    raise exception 'Invoice is already recorded in QuickBooks and requires accounting reconciliation'
      using errcode = '55000';
  end if;

  -- A ZIP is an immutable accounting artifact. If it contains this invoice,
  -- cancel the whole pending batch so it cannot later be confirmed by mistake.
  for pending_batch in
    select batch.*
    from public.controller_invoice_export_batches batch
    where batch.status = 'pending'
      and exists (
        select 1
        from public.controller_invoice_export_items item
        where item.batch_id = batch.id
          and item.invoice_id = invoice.id
      )
    order by batch.id
    for update
  loop
    update public.controller_invoice_export_batches batch
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = p_actor_id,
        cancellation_reason = format(
          'Automatically cancelled because invoice #%s was placed on hold: %s',
          invoice.num,
          clean_reason
        )
    where batch.id = pending_batch.id;

    cancelled_batch_ids := array_append(cancelled_batch_ids, pending_batch.id);
  end loop;

  insert into public.contractor_invoice_payment_holds (
    invoice_id,
    placed_by,
    reason
  ) values (
    invoice.id,
    p_actor_id,
    clean_reason
  )
  returning * into active_hold;

  insert into public.contractor_invoice_payment_hold_events (
    invoice_id,
    invoice_num,
    work_order_id,
    contractor_id,
    action,
    reason,
    actor_id,
    actor_name
  ) values (
    invoice.id,
    invoice.num,
    invoice.work_order_id,
    invoice.contractor_id,
    'placed',
    clean_reason,
    p_actor_id,
    actor_name
  );

  if invoice.work_order_id is not null then
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
    ) values (
      invoice.work_order_id,
      p_actor_id,
      actor_name,
      format(
        'Invoice #%s placed on payment hold by %s: %s',
        invoice.num,
        actor_name,
        clean_reason
      ),
      'system',
      'invoice_payment_hold_placed',
      jsonb_build_object(
        'invoiceId', invoice.id,
        'invoiceNum', invoice.num,
        'outcome', 'payment_hold',
        'reason', clean_reason,
        'cancelledBatchIds', to_jsonb(cancelled_batch_ids)
      ),
      'internal_note',
      true
    );
  end if;

  return jsonb_build_object(
    'applied', true,
    'invoiceId', invoice.id,
    'invoiceNum', invoice.num,
    'holdAt', active_hold.placed_at,
    'holdBy', active_hold.placed_by,
    'holdReason', active_hold.reason,
    'cancelledBatchIds', to_jsonb(cancelled_batch_ids)
  );
end;
$$;

create or replace function public.release_contractor_invoice_payment_hold(
  p_invoice_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invoice public.invoices%rowtype;
  active_hold public.contractor_invoice_payment_holds%rowtype;
  actor_name text;
  clean_reason text := nullif(trim(coalesce(p_reason, '')), '');
  previous_hold_reason text;
  previous_hold_at timestamptz;
  previous_hold_by uuid;
begin
  if p_invoice_id is null or p_actor_id is null or clean_reason is null then
    raise exception 'Invoice, actor, and release reason are required'
      using errcode = '22023';
  end if;

  if length(clean_reason) > 500 then
    raise exception 'Release reason is too long' using errcode = '22023';
  end if;

  if not public.profile_has_staff_permission(p_actor_id, 'quickbooks_handoff') then
    raise exception 'QuickBooks handoff permission required to release a payment hold'
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
  into invoice
  from public.invoices candidate
  where candidate.id = p_invoice_id
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Contractor invoice not found' using errcode = 'P0002';
  end if;

  select hold.*
  into active_hold
  from public.contractor_invoice_payment_holds hold
  where hold.invoice_id = invoice.id
  for update;

  if not found then
    return jsonb_build_object(
      'applied', false,
      'reason', 'not_held',
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num
    );
  end if;

  if invoice.state <> 'approved'
     or invoice.qbo_synced_at is not null
     or invoice.qbo_invoice_id is not null then
    raise exception 'Held invoice changed and requires accounting reconciliation'
      using errcode = '55000';
  end if;

  previous_hold_reason := active_hold.reason;
  previous_hold_at := active_hold.placed_at;
  previous_hold_by := active_hold.placed_by;

  delete from public.contractor_invoice_payment_holds hold
  where hold.invoice_id = invoice.id;

  insert into public.contractor_invoice_payment_hold_events (
    invoice_id,
    invoice_num,
    work_order_id,
    contractor_id,
    action,
    reason,
    actor_id,
    actor_name
  ) values (
    invoice.id,
    invoice.num,
    invoice.work_order_id,
    invoice.contractor_id,
    'released',
    clean_reason,
    p_actor_id,
    actor_name
  );

  if invoice.work_order_id is not null then
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
    ) values (
      invoice.work_order_id,
      p_actor_id,
      actor_name,
      format(
        'Payment hold released for invoice #%s by %s: %s',
        invoice.num,
        actor_name,
        clean_reason
      ),
      'system',
      'invoice_payment_hold_released',
      jsonb_build_object(
        'invoiceId', invoice.id,
        'invoiceNum', invoice.num,
        'outcome', 'payment_hold_released',
        'reason', clean_reason,
        'previousHoldReason', previous_hold_reason,
        'previousHoldAt', previous_hold_at,
        'previousHoldBy', previous_hold_by
      ),
      'internal_note',
      true
    );
  end if;

  return jsonb_build_object(
    'applied', true,
    'invoiceId', invoice.id,
    'invoiceNum', invoice.num,
    'releasedBy', p_actor_id,
    'releaseReason', clean_reason
  );
end;
$$;

-- Defense in depth for callers that still invoke the migration-0096 stage
-- RPC: a held or already-synced invoice can never be inserted into a batch.
create or replace function public.reject_ineligible_quickbooks_handoff_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.invoices invoice
    where invoice.id = new.invoice_id
      and (
        invoice.invoice_type <> 'contractor'
        or invoice.state <> 'approved'
        or invoice.deleted_at is not null
        or invoice.qbo_synced_at is not null
        or invoice.qbo_invoice_id is not null
        or exists (
          select 1
          from public.contractor_invoice_payment_holds hold
          where hold.invoice_id = invoice.id
        )
      )
  ) then
    raise exception 'Invoice is held, changed, or already recorded in QuickBooks'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists reject_ineligible_quickbooks_handoff_item_trigger
  on public.controller_invoice_export_items;
create trigger reject_ineligible_quickbooks_handoff_item_trigger
  before insert on public.controller_invoice_export_items
  for each row execute function public.reject_ineligible_quickbooks_handoff_item();

-- Confirming an import records a QuickBooks sync, not a contractor payment.
-- The legacy paid enum remains the portal's historic "Sent to QuickBooks"
-- bucket, but paid_at is deliberately left null.
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

  if not public.profile_has_staff_permission(p_actor_id, 'quickbooks_handoff') then
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

  -- Payment holds lock invoice rows before their pending batches. Use the
  -- same lock order here to avoid deadlocks when both actions race.
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
    and invoice.deleted_at is null
    and invoice.qbo_synced_at is null
    and invoice.qbo_invoice_id is null
    and not exists (
      select 1
      from public.contractor_invoice_payment_holds hold
      where hold.invoice_id = invoice.id
    );

  if item_count <> batch.invoice_count then
    raise exception 'One or more invoices changed or were held after the handoff was staged; cancel and rebuild the batch'
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
    and invoice.deleted_at is null
    and invoice.qbo_synced_at is null
    and invoice.qbo_invoice_id is null
    and not exists (
      select 1
      from public.contractor_invoice_payment_holds hold
      where hold.invoice_id = invoice.id
    );

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

revoke all on function public.place_contractor_invoice_payment_hold(
  uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.release_contractor_invoice_payment_hold(
  uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.confirm_controller_invoice_export(
  uuid, uuid
) from public, anon, authenticated;

grant execute on function public.place_contractor_invoice_payment_hold(
  uuid, uuid, text
), public.release_contractor_invoice_payment_hold(
  uuid, uuid, text
), public.confirm_controller_invoice_export(
  uuid, uuid
) to service_role;

commit;
