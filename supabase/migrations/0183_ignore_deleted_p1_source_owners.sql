-- A soft-deleted P1 draft must not keep its contractor invoice claimed.
-- Keep the historical source row for auditability; expose only an active
-- staff-invoice owner from the compact contractor-invoice list.
begin;

create or replace function public.list_contractor_invoices_rows_v2(
  p_state text default 'all'::text,
  p_search text default null::text,
  p_sort text default 'recent'::text,
  p_direction text default 'desc'::text,
  p_limit integer default 25,
  p_cursor text default null::text,
  p_work_order_id text default null::text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_page jsonb;
begin
  perform p1_read_contracts.validate_v1('contractor_invoices_v1', jsonb_build_object(
    'p_state', p_state,
    'p_search', p_search,
    'p_sort', p_sort,
    'p_direction', p_direction,
    'p_limit', p_limit,
    'p_cursor', p_cursor,
    'p_work_order_id', p_work_order_id
  ));

  v_page := p1_invoice_reads.contractor_rows_v2(
    p_state => p_state,
    p_search => p_search,
    p_sort => p_sort,
    p_direction => p_direction,
    p_limit => p_limit,
    p_cursor => p_cursor,
    p_work_order_id => p_work_order_id
  );

  if v_page->>'hasMore' = 'true' and jsonb_array_length(v_page->'items') = 0 then
    raise exception using errcode = 'PT413', message = 'PAYLOAD_TOO_LARGE';
  end if;

  -- staff_invoice_sources is retained when a staff invoice is soft-deleted.
  -- The source is reusable when no non-deleted P1 invoice currently owns it.
  -- The compact page is bounded, so resolving active owners here is bounded too.
  v_page := jsonb_set(
    v_page,
    '{items}',
    coalesce((
      select jsonb_agg(
        jsonb_set(
          item.value,
          '{source_staff_invoice_id}',
          case
            when not public.is_staff() then 'null'::jsonb
            else coalesce((
              select to_jsonb(source.staff_invoice_id)
              from public.staff_invoice_sources source
              join public.invoices staff_invoice
                on staff_invoice.id = source.staff_invoice_id
               and staff_invoice.invoice_type = 'staff'
               and staff_invoice.deleted_at is null
              where source.contractor_invoice_id = (item.value->>'id')::uuid
              order by source.created_at desc, source.id desc
              limit 1
            ), 'null'::jsonb)
          end,
          true
        ) order by item.ordinality
      )
      from jsonb_array_elements(coalesce(v_page->'items', '[]'::jsonb))
        with ordinality as item(value, ordinality)
    ), '[]'::jsonb),
    true
  );

  return p1_invoice_reads.assert_json_budget_v1(v_page);
end;
$$;

revoke all on function public.list_contractor_invoices_rows_v2(text,text,text,text,integer,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_contractor_invoices_rows_v2(text,text,text,text,integer,text,text)
  to authenticated, service_role;

commit;
