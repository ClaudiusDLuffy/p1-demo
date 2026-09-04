-- Expand phase: add revision-bound contractor-payables packages while keeping
-- the legacy server RPCs usable by old application instances during rollout.
-- Apply 0118 only after the new application is stable and its rollback window
-- is closed; 0118 cancels legacy pending batches and retires those RPCs.

begin;

alter table public.controller_invoice_export_batches
  add column if not exists archive_format text,
  add column if not exists archive_sha256 text,
  add column if not exists archive_bytes bigint;

alter table public.controller_invoice_export_items
  add column if not exists source_updated_at timestamptz,
  add column if not exists source_pdf_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'controller_export_archive_metadata_check'
      and conrelid = 'public.controller_invoice_export_batches'::regclass
  ) then
    alter table public.controller_invoice_export_batches
      add constraint controller_export_archive_metadata_check check (
        (archive_format is null and archive_sha256 is null and archive_bytes is null)
        or (
          archive_format is not null
          and archive_sha256 is not null
          and archive_bytes is not null
          and
          archive_format in ('reference_manifest_v2', 'legacy_saas_ant_v1')
          and archive_sha256 ~ '^[0-9a-f]{64}$'
          and archive_bytes > 0
          and archive_bytes <= 104857600
        )
      );
  end if;
end
$$;

create or replace function public.guard_pending_contractor_bill_invoice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  snapshot_updated_at timestamptz;
  snapshot_total numeric;
  snapshot_pdf_path text;
  transition_kind text := coalesce(
    current_setting('app.quickbooks_handoff_transition', true),
    ''
  );
begin
  select item.source_updated_at, item.total, item.source_pdf_path
  into snapshot_updated_at, snapshot_total, snapshot_pdf_path
  from public.controller_invoice_export_items item
  join public.controller_invoice_export_batches batch on batch.id = item.batch_id
  where item.invoice_id = old.id
    and batch.status = 'pending'
  order by batch.created_at, batch.id
  limit 1;

  if not found then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'A contractor bill in a pending payables handoff cannot be deleted; cancel the batch first'
      using errcode = '55000';
  end if;

  if coalesce(auth.role(), '') not in ('service_role', '')
     or transition_kind <> 'confirm'
     or old.invoice_type <> 'contractor'
     or old.state <> 'approved'
     or new.state <> 'paid'
     or new.qbo_synced_at is null
     or new.paid_at is not null
     or (to_jsonb(new) - 'state' - 'qbo_synced_at' - 'paid_at' - 'updated_at')
        is distinct from
        (to_jsonb(old) - 'state' - 'qbo_synced_at' - 'paid_at' - 'updated_at') then
    raise exception 'A contractor bill in a pending payables handoff is immutable; cancel the batch first'
      using errcode = '55000';
  end if;

  if snapshot_updated_at is not null
     and old.updated_at is distinct from snapshot_updated_at then
    raise exception 'Contractor bill changed after its payables package was built; cancel and rebuild the batch'
      using errcode = '40001';
  end if;

  if snapshot_updated_at is not null
     and old.pdf_storage_path is distinct from snapshot_pdf_path then
    raise exception 'Contractor bill source PDF changed after its payables package was built; cancel and rebuild the batch'
      using errcode = '40001';
  end if;

  if round(coalesce(old.total, 0), 2) is distinct from round(snapshot_total, 2) then
    raise exception 'Contractor bill total changed after its payables package was built; cancel and rebuild the batch'
      using errcode = '40001';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_pending_contractor_bill_invoice_trigger
  on public.invoices;
create trigger guard_pending_contractor_bill_invoice_trigger
  before update or delete on public.invoices
  for each row execute function public.guard_pending_contractor_bill_invoice();

create or replace function public.guard_pending_contractor_bill_lines()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_invoice_id uuid;
  new_invoice_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_invoice_id := old.invoice_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_invoice_id := new.invoice_id;
  end if;

  if exists (
    select 1
    from public.controller_invoice_export_items item
    join public.controller_invoice_export_batches batch on batch.id = item.batch_id
    where batch.status = 'pending'
      and item.invoice_id in (old_invoice_id, new_invoice_id)
  ) then
    raise exception 'Line items in a pending contractor-bill handoff are immutable; cancel the batch first'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_pending_contractor_bill_lines_trigger
  on public.invoice_lines;
create trigger guard_pending_contractor_bill_lines_trigger
  before insert or update or delete on public.invoice_lines
  for each row execute function public.guard_pending_contractor_bill_lines();

create or replace function public.touch_invoice_after_line_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.invoices invoice
    set updated_at = clock_timestamp()
    where invoice.id = new.invoice_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.invoices invoice
    set updated_at = clock_timestamp()
    where invoice.id = old.invoice_id;
    return old;
  end if;

  update public.invoices invoice
  set updated_at = clock_timestamp()
  where invoice.id in (old.invoice_id, new.invoice_id);
  return new;
end;
$$;

drop trigger if exists touch_invoice_after_line_change_trigger
  on public.invoice_lines;
create trigger touch_invoice_after_line_change_trigger
  after insert or update or delete on public.invoice_lines
  for each row execute function public.touch_invoice_after_line_change();

create or replace function public.guard_contractor_bill_handoff_batch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Contractor-bill handoff audit batches cannot be deleted'
      using errcode = '55000';
  end if;
  if new.id is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.object_path is distinct from old.object_path
     or new.invoice_count is distinct from old.invoice_count
     or new.total is distinct from old.total
     or new.created_at is distinct from old.created_at
     or new.archive_format is distinct from old.archive_format
     or new.archive_sha256 is distinct from old.archive_sha256
     or new.archive_bytes is distinct from old.archive_bytes then
    raise exception 'Contractor-bill handoff package metadata is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_contractor_bill_handoff_batch_trigger
  on public.controller_invoice_export_batches;
create trigger guard_contractor_bill_handoff_batch_trigger
  before update or delete on public.controller_invoice_export_batches
  for each row execute function public.guard_contractor_bill_handoff_batch();

create or replace function public.guard_contractor_bill_handoff_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Contractor-bill handoff item snapshots are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists guard_contractor_bill_handoff_item_trigger
  on public.controller_invoice_export_items;
create trigger guard_contractor_bill_handoff_item_trigger
  before update or delete on public.controller_invoice_export_items
  for each row execute function public.guard_contractor_bill_handoff_item();

create or replace function public.stage_contractor_bill_handoff(
  p_batch_id uuid,
  p_actor_id uuid,
  p_object_path text,
  p_sources jsonb,
  p_archive_sha256 text,
  p_archive_bytes bigint,
  p_archive_format text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_count integer;
  eligible_count integer;
  exported_total numeric(14,2);
  actor_name text;
begin
  if jsonb_typeof(p_sources) <> 'array' then
    raise exception 'Invoice revision snapshots must be a JSON array'
      using errcode = '22023';
  end if;
  requested_count := jsonb_array_length(p_sources);

  if p_batch_id is null
     or p_actor_id is null
     or nullif(trim(coalesce(p_object_path, '')), '') is null
     or requested_count < 1
     or requested_count > 500
     or coalesce(trim(p_archive_sha256), '') !~ '^[0-9a-f]{64}$'
     or p_archive_bytes is null
     or p_archive_bytes < 1
     or p_archive_bytes > 104857600
     or p_archive_format is distinct from 'reference_manifest_v2' then
    raise exception 'A valid batch, archive fingerprint, format, and 1-500 invoice snapshots are required'
      using errcode = '22023';
  end if;

  if requested_count <> (
    select count(distinct (source.value->>'invoiceId')::uuid)
    from jsonb_array_elements(p_sources) source(value)
    where nullif(source.value->>'updatedAt', '') is not null
  ) then
    raise exception 'Every invoice snapshot must have a unique id and revision timestamp'
      using errcode = '22023';
  end if;

  if not public.profile_has_staff_permission(p_actor_id, 'quickbooks_handoff') then
    raise exception 'QuickBooks handoff permission required'
      using errcode = '42501';
  end if;

  select profile.name into actor_name
  from public.profiles profile
  where profile.id = p_actor_id and profile.active = true;
  if actor_name is null then
    raise exception 'Active QuickBooks controller profile not found'
      using errcode = 'P0002';
  end if;

  perform 1
  from public.invoices invoice
  join jsonb_array_elements(p_sources) source(value)
    on invoice.id = (source.value->>'invoiceId')::uuid
  order by invoice.id
  for update of invoice;

  -- Lock child rows after their parent invoices in a stable order. A line
  -- mutation that already owns a child row must finish (and bump the parent
  -- revision) or deadlock-abort before this package can be staged.
  perform 1
  from public.invoice_lines line
  join jsonb_array_elements(p_sources) source(value)
    on line.invoice_id = (source.value->>'invoiceId')::uuid
  order by line.invoice_id, line.id
  for update of line;

  select count(*), round(coalesce(sum(invoice.total), 0), 2)
  into eligible_count, exported_total
  from public.invoices invoice
  join jsonb_array_elements(p_sources) source(value)
    on invoice.id = (source.value->>'invoiceId')::uuid
  where invoice.invoice_type = 'contractor'
    and invoice.state = 'approved'
    and invoice.deleted_at is null
    and invoice.qbo_synced_at is null
    and invoice.qbo_invoice_id is null
    and invoice.updated_at = (source.value->>'updatedAt')::timestamptz
    and (
      invoice.pdf_storage_path is not null
      or exists (select 1 from public.invoice_lines line where line.invoice_id = invoice.id)
    )
    and not exists (
      select 1 from public.contractor_invoice_payment_holds hold
      where hold.invoice_id = invoice.id
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
    raise exception 'One or more contractor bills changed, lack source data, are held, or already belong to an active handoff'
      using errcode = '40001';
  end if;

  insert into public.controller_invoice_export_batches (
    id, created_by, object_path, invoice_count, total, status,
    archive_format, archive_sha256, archive_bytes
  ) values (
    p_batch_id, p_actor_id, trim(p_object_path), requested_count,
    exported_total, 'pending', p_archive_format,
    trim(p_archive_sha256), p_archive_bytes
  );

  insert into public.controller_invoice_export_items (
    batch_id, invoice_id, invoice_num, work_order_id, contractor_id,
    total, source_updated_at, source_pdf_path
  )
  select p_batch_id, invoice.id, invoice.num, invoice.work_order_id,
    invoice.contractor_id, coalesce(invoice.total, 0), invoice.updated_at,
    invoice.pdf_storage_path
  from public.invoices invoice
  join jsonb_array_elements(p_sources) source(value)
    on invoice.id = (source.value->>'invoiceId')::uuid;

  insert into public.activities (
    work_order_id, author_id, author_name, text, type, event_key,
    event_data, activity_channel, is_staff_only
  )
  select item.work_order_id, p_actor_id, actor_name,
    format('Invoice #%s added to contractor-bill handoff batch %s by %s; awaiting QuickBooks entry confirmation.', item.invoice_num, p_batch_id, actor_name),
    'system', 'invoice_quickbooks_handoff_staged',
    jsonb_build_object(
      'invoiceId', item.invoice_id, 'invoiceNum', item.invoice_num,
      'batchId', p_batch_id, 'outcome', 'awaiting_quickbooks_confirmation',
      'archiveSha256', trim(p_archive_sha256)
    ),
    'internal_note', true
  from public.controller_invoice_export_items item
  where item.batch_id = p_batch_id and item.work_order_id is not null;

  return jsonb_build_object(
    'batchId', p_batch_id, 'status', 'pending',
    'invoiceCount', requested_count, 'total', exported_total,
    'objectPath', trim(p_object_path), 'archiveSha256', trim(p_archive_sha256),
    'archiveBytes', p_archive_bytes, 'archiveFormat', p_archive_format
  );
end;
$$;

revoke all on function public.stage_contractor_bill_handoff(
  uuid, uuid, text, jsonb, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.stage_contractor_bill_handoff(
  uuid, uuid, text, jsonb, text, bigint, text
) to service_role;

revoke all on function public.guard_pending_contractor_bill_invoice()
  from public, anon, authenticated;
revoke all on function public.guard_pending_contractor_bill_lines()
  from public, anon, authenticated;
revoke all on function public.touch_invoice_after_line_change()
  from public, anon, authenticated;
revoke all on function public.guard_contractor_bill_handoff_batch()
  from public, anon, authenticated;
revoke all on function public.guard_contractor_bill_handoff_item()
  from public, anon, authenticated;

commit;
