-- Staff troubleshooting view for contractor-facing workflows.
--
-- This is deliberately not impersonation. The projections below resolve one
-- contractor company, return only contractor-facing fields, and expose no
-- mutation path. Internal P1 billing data remains outside this boundary.

begin;

create or replace function public.list_staff_contractor_preview_work_orders(
  p_contractor_id uuid,
  p_scope text default 'active',
  p_search text default null,
  p_limit integer default 50,
  p_cursor_created_at timestamptz default null,
  p_cursor_id text default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_canonical_contractor_id uuid;
  v_scope text := lower(coalesce(nullif(trim(p_scope), ''), 'active'));
  v_search text := lower(coalesce(trim(p_search), ''));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor jsonb := null;
begin
  select profile.*
    into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found
     or public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'Operational staff access is required'
      using errcode = '42501';
  end if;

  if v_scope not in ('active', 'history', 'all') then
    raise exception 'Invalid contractor preview scope'
      using errcode = '22023';
  end if;

  select case
      when target.contractor_organization_id is null then target.id
      when organization.active = true then organization.canonical_contractor_id
      else null
    end
    into v_canonical_contractor_id
  from public.profiles target
  left join public.organizations organization
    on organization.id = target.contractor_organization_id
  where target.id = p_contractor_id
    and target.role = 'contractor';

  if v_canonical_contractor_id is null then
    raise exception 'Contractor company was not found'
      using errcode = '22023';
  end if;

  with candidates as (
    select
      work_order.id,
      work_order.status::text as status,
      work_order.functional_status::text as functional_status,
      work_order.priority::text as priority,
      work_order.store_number,
      work_order.city,
      work_order.address,
      work_order.store_state,
      work_order.summary,
      work_order.description,
      work_order.category,
      work_order.sub_category,
      work_order.business_service,
      work_order.is_capital,
      work_order.created_at,
      work_order.updated_at,
      work_order.closed_at,
      coalesce(technician.name, work_order.technician_on_job) as technician_name,
      work_order.contractor_invoicing_completed_at,
      coalesce(work_order.created_at, '-infinity'::timestamptz) as sort_at
    from public.work_orders work_order
    left join public.contractor_technicians technician
      on technician.profile_id = work_order.assigned_technician_profile_id
     and technician.contractor_id = v_canonical_contractor_id
     and technician.is_active = true
    where work_order.contractor_id = v_canonical_contractor_id
      and work_order.deleted_at is null
      and (
        v_scope = 'all'
        or (v_scope = 'active' and work_order.status <> 'closed')
        or (v_scope = 'history' and work_order.status = 'closed')
      )
      and (
        v_search = ''
        or position(v_search in lower(concat_ws(
          ' ',
          work_order.id,
          work_order.store_number,
          work_order.city,
          work_order.address,
          work_order.summary,
          work_order.description,
          work_order.category,
          work_order.sub_category,
          work_order.business_service
        ))) > 0
      )
      and (
        p_cursor_created_at is null
        or (
          coalesce(work_order.created_at, '-infinity'::timestamptz),
          work_order.id
        ) < (p_cursor_created_at, coalesce(p_cursor_id, ''))
      )
    order by sort_at desc, work_order.id desc
    limit v_limit + 1
  ), visible as (
    select *
    from candidates
    order by sort_at desc, id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', visible.id,
        'status', visible.status,
        'functionalStatus', visible.functional_status,
        'priority', visible.priority,
        'store', visible.store_number,
        'city', visible.city,
        'address', visible.address,
        'state', visible.store_state,
        'summary', visible.summary,
        'description', visible.description,
        'category', visible.category,
        'subCategory', visible.sub_category,
        'businessService', visible.business_service,
        'isCapital', visible.is_capital,
        'technicianName', visible.technician_name,
        'invoicingCompletedAt', visible.contractor_invoicing_completed_at,
        'createdAt', visible.created_at,
        'updatedAt', visible.updated_at,
        'closedAt', visible.closed_at
      )
      order by visible.sort_at desc, visible.id desc
    ), '[]'::jsonb)
    into v_items
  from visible;

  with candidates as (
    select
      work_order.id,
      coalesce(work_order.created_at, '-infinity'::timestamptz) as sort_at
    from public.work_orders work_order
    where work_order.contractor_id = v_canonical_contractor_id
      and work_order.deleted_at is null
      and (
        v_scope = 'all'
        or (v_scope = 'active' and work_order.status <> 'closed')
        or (v_scope = 'history' and work_order.status = 'closed')
      )
      and (
        v_search = ''
        or position(v_search in lower(concat_ws(
          ' ',
          work_order.id,
          work_order.store_number,
          work_order.city,
          work_order.address,
          work_order.summary,
          work_order.description,
          work_order.category,
          work_order.sub_category,
          work_order.business_service
        ))) > 0
      )
      and (
        p_cursor_created_at is null
        or (
          coalesce(work_order.created_at, '-infinity'::timestamptz),
          work_order.id
        ) < (p_cursor_created_at, coalesce(p_cursor_id, ''))
      )
    order by sort_at desc, work_order.id desc
    limit v_limit + 1
  ), visible as (
    select * from candidates order by sort_at desc, id desc limit v_limit
  )
  select
    (select count(*) > v_limit from candidates),
    case when (select count(*) > v_limit from candidates) then (
      select jsonb_build_object('createdAt', visible.sort_at, 'id', visible.id)
      from visible
      order by visible.sort_at asc, visible.id asc
      limit 1
    ) else null end
    into v_has_more, v_next_cursor;

  return jsonb_build_object(
    'items', v_items,
    'hasMore', v_has_more,
    'nextCursor', v_next_cursor
  );
end;
$$;

create or replace function public.list_staff_contractor_preview_invoices(
  p_contractor_id uuid,
  p_state text default 'all',
  p_search text default null,
  p_limit integer default 50,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_canonical_contractor_id uuid;
  v_state text := lower(coalesce(nullif(trim(p_state), ''), 'all'));
  v_search text := lower(coalesce(trim(p_search), ''));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor jsonb := null;
begin
  select profile.*
    into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found
     or public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'Operational staff access is required'
      using errcode = '42501';
  end if;

  if v_state not in ('all', 'draft', 'submitted', 'revised', 'rejected', 'approved', 'paid') then
    raise exception 'Invalid contractor invoice preview state'
      using errcode = '22023';
  end if;

  select case
      when target.contractor_organization_id is null then target.id
      when organization.active = true then organization.canonical_contractor_id
      else null
    end
    into v_canonical_contractor_id
  from public.profiles target
  left join public.organizations organization
    on organization.id = target.contractor_organization_id
  where target.id = p_contractor_id
    and target.role = 'contractor';

  if v_canonical_contractor_id is null then
    raise exception 'Contractor company was not found'
      using errcode = '22023';
  end if;

  with candidates as (
    select
      invoice.id,
      invoice.num,
      invoice.work_order_id,
      invoice.state::text as state,
      invoice.document_kind,
      invoice.invoice_date,
      invoice.service_date,
      invoice.store_address,
      invoice.subtotal,
      invoice.sales_tax,
      invoice.total,
      invoice.rejection_reason,
      invoice.created_at,
      invoice.updated_at,
      coalesce(invoice.created_at, '-infinity'::timestamptz) as sort_at
    from public.invoices invoice
    where invoice.contractor_id = v_canonical_contractor_id
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and (v_state = 'all' or invoice.state::text = v_state)
      and (
        v_search = ''
        or position(v_search in lower(concat_ws(
          ' ',
          invoice.num,
          invoice.work_order_id,
          invoice.store_address,
          invoice.state::text
        ))) > 0
      )
      and (
        p_cursor_created_at is null
        or (
          coalesce(invoice.created_at, '-infinity'::timestamptz),
          invoice.id
        ) < (p_cursor_created_at, coalesce(p_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
      )
    order by sort_at desc, invoice.id desc
    limit v_limit + 1
  ), visible as (
    select *
    from candidates
    order by sort_at desc, id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', visible.id,
        'number', visible.num,
        'workOrderId', visible.work_order_id,
        'state', visible.state,
        'documentKind', visible.document_kind,
        'invoiceDate', visible.invoice_date,
        'serviceDate', visible.service_date,
        'storeAddress', visible.store_address,
        'subtotal', visible.subtotal,
        'salesTax', visible.sales_tax,
        'total', visible.total,
        'rejectionReason', visible.rejection_reason,
        'createdAt', visible.created_at,
        'updatedAt', visible.updated_at
      )
      order by visible.sort_at desc, visible.id desc
    ), '[]'::jsonb)
    into v_items
  from visible;

  with candidates as (
    select
      invoice.id,
      coalesce(invoice.created_at, '-infinity'::timestamptz) as sort_at
    from public.invoices invoice
    where invoice.contractor_id = v_canonical_contractor_id
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and (v_state = 'all' or invoice.state::text = v_state)
      and (
        v_search = ''
        or position(v_search in lower(concat_ws(
          ' ',
          invoice.num,
          invoice.work_order_id,
          invoice.store_address,
          invoice.state::text
        ))) > 0
      )
      and (
        p_cursor_created_at is null
        or (
          coalesce(invoice.created_at, '-infinity'::timestamptz),
          invoice.id
        ) < (p_cursor_created_at, coalesce(p_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
      )
    order by sort_at desc, invoice.id desc
    limit v_limit + 1
  ), visible as (
    select * from candidates order by sort_at desc, id desc limit v_limit
  )
  select
    (select count(*) > v_limit from candidates),
    case when (select count(*) > v_limit from candidates) then (
      select jsonb_build_object('createdAt', visible.sort_at, 'id', visible.id)
      from visible
      order by visible.sort_at asc, visible.id asc
      limit 1
    ) else null end
    into v_has_more, v_next_cursor;

  return jsonb_build_object(
    'items', v_items,
    'hasMore', v_has_more,
    'nextCursor', v_next_cursor
  );
end;
$$;

create index if not exists invoices_contractor_created_preview_idx
  on public.invoices(contractor_id, created_at desc, id desc)
  where deleted_at is null;

revoke all on function public.list_staff_contractor_preview_work_orders(
  uuid, text, text, integer, timestamptz, text
) from public, anon;
revoke all on function public.list_staff_contractor_preview_invoices(
  uuid, text, text, integer, timestamptz, uuid
) from public, anon;

grant execute on function public.list_staff_contractor_preview_work_orders(
  uuid, text, text, integer, timestamptz, text
) to authenticated;
grant execute on function public.list_staff_contractor_preview_invoices(
  uuid, text, text, integer, timestamptz, uuid
) to authenticated;

comment on function public.list_staff_contractor_preview_work_orders(
  uuid, text, text, integer, timestamptz, text
) is
  'Read-only company-level contractor work-order preview for active operational staff. Returns a deliberately limited contractor-facing projection.';

comment on function public.list_staff_contractor_preview_invoices(
  uuid, text, text, integer, timestamptz, uuid
) is
  'Read-only company-level contractor invoice preview for active operational staff. Returns contractor documents only, never internal P1 billing records.';

commit;
