-- Let every visible Billing table header sort the complete authorized result
-- set. Sorting stays in SQL so cursor pages remain globally ordered.

begin;

create or replace function public.list_staff_invoices_page(
  p_queue text default 'active',
  p_search text default null,
  p_sort text default 'invoice',
  p_direction text default 'desc',
  p_limit integer default 25,
  p_cursor text default null,
  p_work_order_id text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with args as (
    select
      greatest(1, least(coalesce(p_limit, 25), 100)) as page_size,
      lower(coalesce(nullif(trim(p_queue), ''), 'active')) as queue_name,
      case lower(coalesce(nullif(trim(p_sort), ''), 'invoice'))
        when 'invoice' then 'invoice'
        when 'date' then 'date'
        when 'work_order' then 'work_order'
        when 'store' then 'store'
        when 'territory' then 'territory'
        when 'total' then 'total'
        when 'status' then 'status'
        else 'recent'
      end as sort_name,
      case when lower(p_direction) = 'asc' then 'asc' else 'desc' end as direction_name,
      nullif(trim(coalesce(p_search, '')), '') as search_text,
      case when p_cursor is null or trim(p_cursor) = '' then null::jsonb
        else public.portal_decode_cursor(p_cursor) end as cursor_data
  ),
  invoice_rows as (
    select
      invoice.*,
      case args.sort_name
        when 'invoice' then coalesce(substring(invoice.num from '([0-9]+)$')::numeric, 0)
        when 'total' then coalesce(invoice.total, 0)
        else 0::numeric
      end as _sort_number,
      case args.sort_name
        when 'work_order' then lower(coalesce(invoice.work_order_id, ''))
        when 'store' then lower(coalesce(invoice.store_number, ''))
        when 'territory' then lower(coalesce(invoice.territory, ''))
        when 'status' then lower(invoice.state::text)
        else ''
      end as _sort_text,
      case args.sort_name
        when 'date' then invoice.invoice_date::timestamptz
        else coalesce(invoice.updated_at, invoice.created_at, invoice.invoice_date::timestamptz)
      end as _sort_time,
      case
        when args.sort_name in ('invoice', 'total') then 'number'
        when args.sort_name in ('work_order', 'store', 'territory', 'status') then 'text'
        else 'time'
      end as _sort_kind
    from public.invoices invoice
    cross join args
    where invoice.invoice_type = 'staff'
      and invoice.deleted_at is null
      and (p_work_order_id is null or invoice.work_order_id = p_work_order_id)
      and case args.queue_name
        when 'draft' then invoice.state::text = 'draft'
        when 'submitted' then invoice.state::text = 'submitted'
        when 'sent' then invoice.state::text in ('approved', 'paid')
        when 'work_order' then true
        when 'all' then invoice.state::text not in ('approved', 'paid')
        when 'active' then invoice.state::text not in ('approved', 'paid')
        else invoice.state::text not in ('approved', 'paid')
      end
      and (
        args.search_text is null
        or (
          coalesce(invoice.num, '') || ' ' ||
          coalesce(invoice.work_order_id, '') || ' ' ||
          coalesce(invoice.store_number, '') || ' ' ||
          coalesce(invoice.store_address, '') || ' ' ||
          coalesce(invoice.cme, '') || ' ' ||
          coalesce(invoice.territory, '') || ' ' ||
          coalesce(invoice.document_kind::text, '')
        ) ilike '%' || args.search_text || '%'
        or exists (
          select 1 from public.invoice_lines line
          where line.invoice_id = invoice.id
            and coalesce(line.description, '') ilike '%' || args.search_text || '%'
        )
        or exists (
          select 1
          from public.staff_invoice_sources source_link
          join public.invoices source_invoice
            on source_invoice.id = source_link.contractor_invoice_id
          where source_link.staff_invoice_id = invoice.id
            and coalesce(source_invoice.num, '') ilike '%' || args.search_text || '%'
        )
      )
  ),
  after_cursor as (
    select invoice_rows.*
    from invoice_rows
    cross join args
    where args.cursor_data is null
      or (
        args.direction_name = 'asc'
        and case invoice_rows._sort_kind
          when 'number' then (invoice_rows._sort_number, invoice_rows.id) > (
            (args.cursor_data ->> 'number')::numeric,
            (args.cursor_data ->> 'id')::uuid
          )
          when 'text' then (invoice_rows._sort_text, invoice_rows.id) > (
            coalesce(args.cursor_data ->> 'text', ''),
            (args.cursor_data ->> 'id')::uuid
          )
          else (invoice_rows._sort_time, invoice_rows.id) > (
            (args.cursor_data ->> 'time')::timestamptz,
            (args.cursor_data ->> 'id')::uuid
          )
        end
      )
      or (
        args.direction_name = 'desc'
        and case invoice_rows._sort_kind
          when 'number' then (invoice_rows._sort_number, invoice_rows.id) < (
            (args.cursor_data ->> 'number')::numeric,
            (args.cursor_data ->> 'id')::uuid
          )
          when 'text' then (invoice_rows._sort_text, invoice_rows.id) < (
            coalesce(args.cursor_data ->> 'text', ''),
            (args.cursor_data ->> 'id')::uuid
          )
          else (invoice_rows._sort_time, invoice_rows.id) < (
            (args.cursor_data ->> 'time')::timestamptz,
            (args.cursor_data ->> 'id')::uuid
          )
        end
      )
  ),
  ordered as (
    select
      after_cursor.*,
      row_number() over (
        order by
          case when after_cursor._sort_kind = 'number' and args.direction_name = 'asc' then after_cursor._sort_number end asc,
          case when after_cursor._sort_kind = 'number' and args.direction_name = 'desc' then after_cursor._sort_number end desc,
          case when after_cursor._sort_kind = 'text' and args.direction_name = 'asc' then after_cursor._sort_text end asc,
          case when after_cursor._sort_kind = 'text' and args.direction_name = 'desc' then after_cursor._sort_text end desc,
          case when after_cursor._sort_kind = 'time' and args.direction_name = 'asc' then after_cursor._sort_time end asc,
          case when after_cursor._sort_kind = 'time' and args.direction_name = 'desc' then after_cursor._sort_time end desc,
          case when args.direction_name = 'asc' then after_cursor.id end asc,
          case when args.direction_name = 'desc' then after_cursor.id end desc
      ) as _row_number
    from after_cursor
    cross join args
    order by
      case when after_cursor._sort_kind = 'number' and args.direction_name = 'asc' then after_cursor._sort_number end asc,
      case when after_cursor._sort_kind = 'number' and args.direction_name = 'desc' then after_cursor._sort_number end desc,
      case when after_cursor._sort_kind = 'text' and args.direction_name = 'asc' then after_cursor._sort_text end asc,
      case when after_cursor._sort_kind = 'text' and args.direction_name = 'desc' then after_cursor._sort_text end desc,
      case when after_cursor._sort_kind = 'time' and args.direction_name = 'asc' then after_cursor._sort_time end asc,
      case when after_cursor._sort_kind = 'time' and args.direction_name = 'desc' then after_cursor._sort_time end desc,
      case when args.direction_name = 'asc' then after_cursor.id end asc,
      case when args.direction_name = 'desc' then after_cursor.id end desc
    limit (select page_size + 1 from args)
  ),
  page_rows as (
    select ordered.* from ordered, args where ordered._row_number <= args.page_size
  ),
  last_row as (select * from page_rows order by _row_number desc limit 1)
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        to_jsonb(page_rows) - array[
          '_row_number', '_sort_number', '_sort_text', '_sort_time', '_sort_kind'
        ]::text[]
        order by page_rows._row_number
      ) from page_rows
    ), '[]'::jsonb),
    'hasMore', (select count(*) from ordered) > (select page_size from args),
    'nextCursor', case when (select count(*) from ordered) > (select page_size from args)
      then (select public.portal_encode_cursor(jsonb_build_object(
        'kind', last_row._sort_kind,
        'number', last_row._sort_number,
        'text', last_row._sort_text,
        'time', last_row._sort_time,
        'id', last_row.id
      )) from last_row)
      else null end,
    'totalCount', (select count(*) from invoice_rows)
  );
$$;

revoke all on function public.list_staff_invoices_page(
  text, text, text, text, integer, text, text
) from public, anon;
grant execute on function public.list_staff_invoices_page(
  text, text, text, text, integer, text, text
) to authenticated, service_role;

commit;
