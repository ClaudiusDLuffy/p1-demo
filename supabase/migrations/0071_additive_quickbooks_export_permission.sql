-- Keep QuickBooks export as an additive accounting capability. The legacy
-- invoice_controller permission remains available only for accounts that are
-- intentionally restricted to the controller workflow.

begin;

-- Preserve export access for any controller-only accounts that still exist.
insert into public.staff_permission_grants (
  profile_id,
  permission,
  granted_by
)
select
  permission_grant.profile_id,
  'quickbooks_export',
  permission_grant.granted_by
from public.staff_permission_grants permission_grant
where permission_grant.permission = 'invoice_controller'
on conflict (profile_id, permission) do nothing;

comment on table public.staff_permission_grants is
  'Data-driven staff capabilities. quickbooks_export is additive; invoice_controller is the optional controller-only restriction.';

drop policy if exists controller_export_batches_read
  on public.controller_invoice_export_batches;
create policy controller_export_batches_read
  on public.controller_invoice_export_batches
  for select using (
    public.has_staff_permission('quickbooks_export')
  );

drop policy if exists controller_export_items_read
  on public.controller_invoice_export_items;
create policy controller_export_items_read
  on public.controller_invoice_export_items
  for select using (
    public.has_staff_permission('quickbooks_export')
  );

create or replace function public.complete_controller_invoice_export(
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
  requested_count integer;
  eligible_count integer;
  exported_total numeric(14,2);
  actor_name text;
begin
  requested_count := coalesce(cardinality(p_invoice_ids), 0);

  if p_batch_id is null
     or p_actor_id is null
     or nullif(trim(coalesce(p_object_path, '')), '') is null
     or requested_count < 1
     or requested_count > 500 then
    raise exception 'A batch id, object path, and 1-500 invoice ids are required'
      using errcode = '22023';
  end if;

  if not public.profile_has_staff_permission(
    p_actor_id,
    'quickbooks_export'
  ) then
    raise exception 'QuickBooks export permission required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if actor_name is null then
    raise exception 'Active QuickBooks exporter profile not found'
      using errcode = 'P0002';
  end if;

  -- Serialize against review, individual handoff, and another export.
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
    );

  if eligible_count <> requested_count then
    raise exception 'One or more invoices changed, lack source data, or are not approved'
      using errcode = '40001';
  end if;

  insert into public.controller_invoice_export_batches (
    id,
    created_by,
    object_path,
    invoice_count,
    total
  ) values (
    p_batch_id,
    p_actor_id,
    trim(p_object_path),
    requested_count,
    exported_total
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

  update public.invoices invoice
  set state = 'paid',
      paid_at = now(),
      updated_at = now()
  where invoice.id = any(p_invoice_ids)
    and invoice.state = 'approved'
    and invoice.deleted_at is null;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  )
  select
    item.work_order_id,
    p_actor_id,
    actor_name,
    format(
      'Invoice #%s sent to QuickBooks by %s in controller batch %s.',
      item.invoice_num,
      actor_name,
      p_batch_id
    ),
    'system',
    'invoice_sent_to_quickbooks',
    jsonb_build_object(
      'invoiceId', item.invoice_id,
      'invoiceNum', item.invoice_num,
      'batchId', p_batch_id,
      'outcome', 'sent_to_quickbooks'
    )
  from public.controller_invoice_export_items item
  where item.batch_id = p_batch_id
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
    where item.batch_id = p_batch_id
      and item.work_order_id is not null
  )
    and work_order.status <> 'closed'
    and work_order.deleted_at is null;

  return jsonb_build_object(
    'batchId', p_batch_id,
    'invoiceCount', requested_count,
    'total', exported_total,
    'objectPath', trim(p_object_path)
  );
end;
$$;

revoke all on function public.complete_controller_invoice_export(
  uuid,
  uuid,
  text,
  uuid[]
) from public, anon, authenticated;
grant execute on function public.complete_controller_invoice_export(
  uuid,
  uuid,
  text,
  uuid[]
) to service_role;

commit;
