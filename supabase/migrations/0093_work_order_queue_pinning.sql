-- Keep 7-Eleven updates pinned above the selected table sort and add a
-- dedicated P1-parts queue scope that automatically excludes capital jobs.
-- Cursor payloads include the pin rank so pagination cannot skip or repeat rows.

begin;

create or replace function public.list_work_orders_table_page(
  p_scope text default 'operations',
  p_search text default null,
  p_contractor_id uuid default null,
  p_priority text default null,
  p_status text default null,
  p_state text default null,
  p_resolution text default null,
  p_from date default null,
  p_to date default null,
  p_needs_action boolean default false,
  p_sort text default 'newest',
  p_pending_first boolean default false,
  p_limit integer default 25,
  p_cursor text default null,
  p_store_number text default null,
  p_contractor_ids uuid[] default null,
  p_sort_column text default 'created',
  p_sort_direction text default 'desc',
  p_work_order_filter text default null,
  p_incident_filter text default null,
  p_store_filter text default null,
  p_summary_filter text default null,
  p_contractor_filter text default null,
  p_created_date_filter date default null,
  p_updated_date_filter date default null,
  p_sla_filter text default null
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
      lower(coalesce(nullif(trim(p_scope), ''), 'operations')) as scope_name,
      case lower(coalesce(nullif(trim(p_sort_column), ''), 'created'))
        when 'work_order' then 'work_order'
        when 'status' then 'status'
        when 'priority' then 'priority'
        when 'incident' then 'incident'
        when 'store' then 'store'
        when 'summary' then 'summary'
        when 'contractor' then 'contractor'
        when 'technician' then 'technician'
        when 'updated' then 'updated'
        when 'closed' then 'closed'
        when 'sla' then 'sla'
        else 'created'
      end as sort_column,
      case lower(coalesce(nullif(trim(p_sort_direction), ''), 'desc'))
        when 'asc' then 'asc'
        else 'desc'
      end as sort_direction,
      nullif(trim(coalesce(p_search, '')), '') as search_text,
      case when p_cursor is null or trim(p_cursor) = ''
        then null::jsonb
        else public.portal_decode_cursor(p_cursor)
      end as cursor_data
  ),
  candidate as materialized (
    select
      work_order.id,
      lower(coalesce(contractor.company, contractor.name, '')) as contractor_name
    from public.work_orders work_order
    left join public.profiles contractor on contractor.id = work_order.contractor_id
    cross join args
    where work_order.deleted_at is null
      and case args.scope_name
        when 'history' then work_order.status::text = 'closed'
        when 'operations' then work_order.status::text not in (
          'closed', 'capital', 'pending_capital_completion'
        )
        when 'operations_all' then work_order.status::text not in (
          'capital', 'pending_capital_completion'
        )
        when 'capital' then work_order.status::text in (
          'capital', 'pending_capital_completion'
        )
        when 'dashboard_pending_submission' then
          work_order.status::text in ('pending_invoice', 'pending_payment')
        when 'ready_to_bill' then
          work_order.status::text in ('pending_invoice', 'pending_payment')
        when 'staff_work_ready' then
          work_order.status::text in ('pending_invoice', 'pending_payment')
        when 'staff_work' then work_order.status::text <> 'closed'
        when 'dashboard_seven_eleven_updates' then
          work_order.status::text <> 'closed'
        when 'dashboard_p1_parts_to_order' then
          work_order.status::text not in (
            'closed', 'capital', 'pending_capital_completion'
          )
        when 'all' then true
        else work_order.status::text <> 'closed'
      end
      and (p_contractor_id is null or work_order.contractor_id = p_contractor_id)
      and (p_contractor_ids is null or work_order.contractor_id = any(p_contractor_ids))
      and (p_priority is null or p_priority = 'all' or work_order.priority::text = p_priority)
      and (p_status is null or p_status = 'all' or work_order.status::text = p_status)
      and (p_store_number is null or work_order.store_number = p_store_number)
      and (
        p_state is null or p_state = 'all'
        or upper(coalesce(work_order.store_state, '')) = upper(p_state)
        or upper(coalesce(work_order.address, '')) ~ (
          ',[[:space:]]*' || upper(p_state) || '([[:space:]]|,|$)'
        )
        or upper(coalesce(work_order.city, '')) ~ (
          '(,|[[:space:]])' || upper(p_state) || '$'
        )
      )
      and (
        p_resolution is null or p_resolution = 'all'
        or coalesce(work_order.resolution_code, 'unknown') = p_resolution
      )
      and (p_from is null or coalesce(work_order.closed_at, work_order.created_at)::date >= p_from)
      and (p_to is null or coalesce(work_order.closed_at, work_order.created_at)::date <= p_to)
      and (
        args.search_text is null
        or (
          coalesce(work_order.id, '') || ' ' ||
          coalesce(work_order.incident_id, '') || ' ' ||
          coalesce(work_order.store_number, '') || ' ' ||
          coalesce(work_order.city, '') || ' ' ||
          coalesce(work_order.address, '') || ' ' ||
          coalesce(work_order.summary, '') || ' ' ||
          coalesce(work_order.description, '') || ' ' ||
          coalesce(contractor.company, contractor.name, '')
        ) ilike '%' || args.search_text || '%'
      )
      and (
        nullif(trim(coalesce(p_work_order_filter, '')), '') is null
        or work_order.id ilike '%' || trim(p_work_order_filter) || '%'
      )
      and (
        nullif(trim(coalesce(p_incident_filter, '')), '') is null
        or coalesce(work_order.incident_id, '') ilike '%' || trim(p_incident_filter) || '%'
      )
      and (
        nullif(trim(coalesce(p_store_filter, '')), '') is null
        or coalesce(work_order.store_number, '') ilike '%' || trim(p_store_filter) || '%'
      )
      and (
        nullif(trim(coalesce(p_summary_filter, '')), '') is null
        or coalesce(work_order.summary, '') ilike '%' || trim(p_summary_filter) || '%'
      )
      and (
        nullif(trim(coalesce(p_contractor_filter, '')), '') is null
        or coalesce(contractor.company, contractor.name, '') ilike
          '%' || trim(p_contractor_filter) || '%'
      )
      and (
        p_created_date_filter is null
        or work_order.created_at::date = p_created_date_filter
      )
      and (
        p_updated_date_filter is null
        or work_order.updated_at::date = p_updated_date_filter
      )
      and (
        p_sla_filter is null or p_sla_filter = 'all'
        or (
          p_sla_filter = 'overdue'
          and coalesce(
            work_order.response_breach_at,
            work_order.resolution_breach_at
          ) < now()
        )
      )
  ),
  activity_summary as (
    select
      activity.work_order_id,
      max(activity.created_at) filter (where activity.type = 'note') as latest_note_at,
      max(activity.created_at) filter (
        where activity.entered_by_role = 'contractor'
      ) as latest_contractor_activity_at,
      count(*) filter (
        where activity.requires_7eleven_sync
          and activity.synced_to_7eleven_at is null
      ) as raw_pending_7eleven_sync_count,
      count(*) filter (
        where activity.requires_contractor_attention
          and activity.contractor_attention_acknowledged_at is null
      ) as pending_contractor_attention_count
    from public.activities activity
    join candidate on candidate.id = activity.work_order_id
    where activity.deleted_at is null
    group by activity.work_order_id
  ),
  filtered as (
    select
      work_order.*,
      candidate.contractor_name as _contractor_name,
      summary.latest_note_at as _latest_note_at,
      summary.latest_contractor_activity_at as _latest_contractor_activity_at,
      case
        when work_order.functional_status::text = 'Completed'
          or work_order.status::text = 'closed'
        then coalesce(summary.raw_pending_7eleven_sync_count, 0)::bigint
        else 0::bigint
      end as _pending_7eleven_sync_count,
      coalesce(summary.pending_contractor_attention_count, 0)::bigint
        as _pending_contractor_attention_count,
      case work_order.priority::text
        when 'p1' then 1 when 'p2' then 2 when 'p3' then 3
        when 'p4' then 4 when 'p5' then 5 else 99
      end as _priority_rank,
      coalesce(
        work_order.response_breach_at,
        work_order.resolution_breach_at,
        '9999-12-31 23:59:59+00'::timestamptz
      ) as _sla_due,
      coalesce(work_order.created_at, 'epoch'::timestamptz) as _created_key,
      coalesce(work_order.updated_at, work_order.created_at, 'epoch'::timestamptz)
        as _updated_key
    from public.work_orders work_order
    join candidate on candidate.id = work_order.id
    left join activity_summary summary on summary.work_order_id = work_order.id
    cross join args
    where (
      case args.scope_name
        when 'dashboard_seven_eleven_updates' then (
          (work_order.functional_status::text = 'Completed'
            or work_order.status::text = 'closed')
          and coalesce(summary.raw_pending_7eleven_sync_count, 0) > 0
        )
        when 'dashboard_pending_submission' then
          public.contractor_invoicing_is_complete(work_order.id)
        when 'ready_to_bill' then
          public.contractor_invoicing_is_complete(work_order.id)
        when 'staff_work_ready' then
          public.contractor_invoicing_is_complete(work_order.id)
        when 'dashboard_p1_parts_to_order' then exists (
          select 1
          from public.wo_parts queued_part
          where queued_part.work_order_id = work_order.id
            and queued_part.ordering_responsibility = 'p1'
            and queued_part.p1_order_status = 'requested'
        )
        when 'staff_work' then (
          work_order.status::text in (
            'unassigned', 'completed', 'pending_invoice', 'pending_payment',
            'pending_approval', 'capital'
          )
          or (
            work_order.functional_status::text = 'Completed'
            and coalesce(summary.raw_pending_7eleven_sync_count, 0) > 0
          )
          or exists (
            select 1
            from public.staff_work_order_todos todo
            where todo.work_order_id = work_order.id
              and todo.completed_at is null
          )
          or (
            summary.latest_contractor_activity_at is not null
            and summary.latest_contractor_activity_at > coalesce((
              select notification_read.read_through_at
              from public.staff_work_order_notification_reads notification_read
              where notification_read.user_id = auth.uid()
                and notification_read.work_order_id = work_order.id
            ), '-infinity'::timestamptz)
          )
        )
        else true
      end
    )
      and (not p_needs_action
      or (
        public.is_staff() and (
          work_order.status::text in (
            'unassigned', 'completed', 'pending_invoice', 'pending_approval', 'capital'
          )
          or (
            (work_order.functional_status::text = 'Completed'
              or work_order.status::text = 'closed')
            and coalesce(summary.raw_pending_7eleven_sync_count, 0) > 0
          )
          or (
            summary.latest_note_at is not null
            and (
              work_order.staff_notes_seen_at is null
              or summary.latest_note_at > work_order.staff_notes_seen_at
            )
          )
        )
        or (
          not public.is_staff()
          and coalesce(summary.pending_contractor_attention_count, 0) > 0
        )
      ))
  ),
  sortable as (
    select
      filtered.*,
      case args.sort_column
        when 'work_order' then lower(filtered.id)
        when 'status' then lower(filtered.status::text)
        when 'incident' then lower(coalesce(filtered.incident_id, ''))
        when 'store' then lower(coalesce(filtered.store_number, ''))
        when 'summary' then lower(coalesce(filtered.summary, ''))
        when 'contractor' then filtered._contractor_name
        when 'technician' then lower(coalesce(filtered.technician_on_job, ''))
        else ''
      end as _text_sort,
      case when args.sort_column = 'priority'
        then filtered._priority_rank else 0 end as _number_sort,
      case args.sort_column
        when 'updated' then filtered._updated_key
        when 'closed' then coalesce(filtered.closed_at, filtered._updated_key)
        when 'sla' then filtered._sla_due
        else filtered._created_key
      end as _time_sort,
      case
        when args.sort_column in (
          'work_order', 'status', 'incident', 'store', 'summary', 'contractor',
          'technician'
        ) then 'text'
        when args.sort_column = 'priority' then 'number'
        else 'time'
      end as _sort_kind,
      case
        when p_pending_first
          and filtered._pending_7eleven_sync_count > 0 then 0
        else 1
      end as _pending_rank
    from filtered
    cross join args
  ),
  after_cursor as (
    select sortable.*
    from sortable
    cross join args
    where args.cursor_data is null
      or sortable._pending_rank > coalesce(
        (args.cursor_data ->> 'pendingRank')::integer,
        1
      )
      or (
        sortable._pending_rank = coalesce(
          (args.cursor_data ->> 'pendingRank')::integer,
          1
        )
        and (
          (
            args.sort_direction = 'asc'
            and case sortable._sort_kind
              when 'text' then (sortable._text_sort, sortable.id) > (
                coalesce(args.cursor_data ->> 'text', ''),
                args.cursor_data ->> 'id'
              )
              when 'number' then (sortable._number_sort, sortable.id) > (
                (args.cursor_data ->> 'number')::integer,
                args.cursor_data ->> 'id'
              )
              else (sortable._time_sort, sortable.id) > (
                (args.cursor_data ->> 'time')::timestamptz,
                args.cursor_data ->> 'id'
              )
            end
          )
          or (
            args.sort_direction = 'desc'
            and case sortable._sort_kind
              when 'text' then (sortable._text_sort, sortable.id) < (
                coalesce(args.cursor_data ->> 'text', ''),
                args.cursor_data ->> 'id'
              )
              when 'number' then (sortable._number_sort, sortable.id) < (
                (args.cursor_data ->> 'number')::integer,
                args.cursor_data ->> 'id'
              )
              else (sortable._time_sort, sortable.id) < (
                (args.cursor_data ->> 'time')::timestamptz,
                args.cursor_data ->> 'id'
              )
            end
          )
        )
      )
  ),
  ordered as (
    select
      after_cursor.*,
      row_number() over (
        order by
          after_cursor._pending_rank asc,
          case when after_cursor._sort_kind = 'text'
            and args.sort_direction = 'asc' then after_cursor._text_sort end asc,
          case when after_cursor._sort_kind = 'text'
            and args.sort_direction = 'desc' then after_cursor._text_sort end desc,
          case when after_cursor._sort_kind = 'number'
            and args.sort_direction = 'asc' then after_cursor._number_sort end asc,
          case when after_cursor._sort_kind = 'number'
            and args.sort_direction = 'desc' then after_cursor._number_sort end desc,
          case when after_cursor._sort_kind = 'time'
            and args.sort_direction = 'asc' then after_cursor._time_sort end asc,
          case when after_cursor._sort_kind = 'time'
            and args.sort_direction = 'desc' then after_cursor._time_sort end desc,
          case when args.sort_direction = 'asc' then after_cursor.id end asc,
          case when args.sort_direction = 'desc' then after_cursor.id end desc
      ) as _row_number
    from after_cursor
    cross join args
    order by
      after_cursor._pending_rank asc,
      case when after_cursor._sort_kind = 'text'
        and args.sort_direction = 'asc' then after_cursor._text_sort end asc,
      case when after_cursor._sort_kind = 'text'
        and args.sort_direction = 'desc' then after_cursor._text_sort end desc,
      case when after_cursor._sort_kind = 'number'
        and args.sort_direction = 'asc' then after_cursor._number_sort end asc,
      case when after_cursor._sort_kind = 'number'
        and args.sort_direction = 'desc' then after_cursor._number_sort end desc,
      case when after_cursor._sort_kind = 'time'
        and args.sort_direction = 'asc' then after_cursor._time_sort end asc,
      case when after_cursor._sort_kind = 'time'
        and args.sort_direction = 'desc' then after_cursor._time_sort end desc,
      case when args.sort_direction = 'asc' then after_cursor.id end asc,
      case when args.sort_direction = 'desc' then after_cursor.id end desc
    limit (select page_size + 1 from args)
  ),
  page_rows as (
    select ordered.*
    from ordered
    cross join args
    where ordered._row_number <= args.page_size
  ),
  enriched as (
    select
      page_rows._row_number,
      (
        to_jsonb(page_rows)
        - array[
          '_row_number', '_contractor_name', '_latest_note_at',
          '_latest_contractor_activity_at', '_pending_7eleven_sync_count',
          '_pending_contractor_attention_count', '_priority_rank', '_sla_due',
          '_created_key', '_updated_key', '_text_sort', '_number_sort',
          '_time_sort', '_sort_kind', '_pending_rank'
        ]::text[]
      ) || jsonb_build_object(
        'contractor_name', page_rows._contractor_name,
        'latest_note_at', page_rows._latest_note_at,
        'latest_contractor_activity_at', page_rows._latest_contractor_activity_at,
        'pending_7eleven_sync_count', page_rows._pending_7eleven_sync_count,
        'pending_contractor_attention_count', page_rows._pending_contractor_attention_count,
        'afm_email', coalesce(afm.afm_email, page_rows.afm_email),
        'nte', coalesce(financial.nte, page_rows.nte),
        'nte_flag_threshold', coalesce(financial.nte_flag_threshold, page_rows.nte_flag_threshold),
        'nte_flagged', coalesce(financial.nte_flagged, page_rows.nte_flagged, false),
        'nte_flag_amount', coalesce(financial.nte_flag_amount, page_rows.nte_flag_amount),
        'incident_reuse', incident.warning,
        'history_invoice_total', coalesce(invoice_summary.invoice_total, 0),
        'history_invoice_count', coalesce(invoice_summary.invoice_count, 0),
        'billing_invoice_id', staff_billing.invoice_id,
        'parts_total', coalesce(part_summary.parts_total, 0),
        'parts_received', coalesce(part_summary.parts_received, 0),
        'staff_todo', staff_todo.row_data,
        'staff_read_through_at', staff_read.read_through_at
      ) as item
    from page_rows
    left join public.work_order_afm_contacts afm on afm.work_order_id = page_rows.id
    left join public.work_order_financials financial on financial.work_order_id = page_rows.id
    left join lateral (
      select case when count(*) = 0 then null else jsonb_build_object(
        'incidentId', page_rows.incident_id,
        'relatedWorkOrderIds', array_agg(other.id order by other.id),
        'crossesState', bool_or(
          coalesce(other.store_state, '') <> coalesce(page_rows.store_state, '')
          and coalesce(other.store_state, '') <> ''
          and coalesce(page_rows.store_state, '') <> ''
        )
      ) end as warning
      from public.work_orders other
      where public.is_staff()
        and page_rows.incident_id is not null
        and other.incident_id = page_rows.incident_id
        and other.id <> page_rows.id
    ) incident on true
    left join lateral (
      select
        coalesce(sum(invoice.total), 0) as invoice_total,
        count(*)::integer as invoice_count
      from public.invoices invoice
      where invoice.work_order_id = page_rows.id
        and invoice.invoice_type = 'contractor'
        and invoice.deleted_at is null
        and invoice.state::text not in ('draft', 'rejected')
    ) invoice_summary on true
    left join lateral (
      select invoice.id as invoice_id
      from public.invoices invoice
      where invoice.work_order_id = page_rows.id
        and invoice.invoice_type = 'staff'
        and invoice.document_kind::text <> 'capital_quote'
        and invoice.deleted_at is null
      order by invoice.updated_at desc nulls last, invoice.created_at desc, invoice.id desc
      limit 1
    ) staff_billing on true
    left join lateral (
      select
        count(*)::integer as parts_total,
        count(*) filter (where part.status = 'received')::integer as parts_received
      from public.wo_parts part
      where part.work_order_id = page_rows.id
    ) part_summary on true
    left join lateral (
      select to_jsonb(todo) as row_data
      from public.staff_work_order_todos todo
      where todo.work_order_id = page_rows.id
        and todo.completed_at is null
      order by todo.created_at desc, todo.id desc
      limit 1
    ) staff_todo on true
    left join public.staff_work_order_notification_reads staff_read
      on staff_read.work_order_id = page_rows.id
      and staff_read.user_id = auth.uid()
  ),
  last_row as (
    select page_rows.*
    from page_rows
    order by page_rows._row_number desc
    limit 1
  )
  select jsonb_build_object(
    'items', coalesce(
      (select jsonb_agg(enriched.item order by enriched._row_number) from enriched),
      '[]'::jsonb
    ),
    'hasMore', (select count(*) from ordered) > (select page_size from args),
    'nextCursor', case
      when (select count(*) from ordered) <= (select page_size from args) then null
      else (
        select public.portal_encode_cursor(jsonb_build_object(
          'kind', last_row._sort_kind,
          'pendingRank', last_row._pending_rank,
          'text', last_row._text_sort,
          'number', last_row._number_sort,
          'time', last_row._time_sort,
          'id', last_row.id
        ))
        from last_row
      )
    end,
    'totalCount', (select count(*) from filtered)
  );
$$;

revoke all on function public.list_work_orders_table_page(
  text, text, uuid, text, text, text, text, date, date, boolean, text,
  boolean, integer, text, text, uuid[], text, text, text, text, text,
  text, text, date, date, text
) from public, anon;
grant execute on function public.list_work_orders_table_page(
  text, text, uuid, text, text, text, text, date, date, boolean, text,
  boolean, integer, text, text, uuid[], text, text, text, text, text,
  text, text, date, date, text
) to authenticated, service_role;

commit;
