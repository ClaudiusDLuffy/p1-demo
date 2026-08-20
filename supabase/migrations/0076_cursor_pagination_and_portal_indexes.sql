-- Phase 3: replace browser-wide table downloads with RLS-aware keyset pages.
-- The cursor is opaque to the client and contains only the last row's stable
-- sort keys. Interactive queries never use OFFSET; complete bulk reads remain
-- server-side concerns.

begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
set local search_path = public, extensions;

create or replace function public.portal_encode_cursor(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select rtrim(
    translate(
      encode(convert_to(p_value::text, 'utf8'), 'base64'),
      '+/',
      '-_'
    ),
    '='
  );
$$;

create or replace function public.portal_decode_cursor(p_cursor text)
returns jsonb
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  normalized text;
begin
  normalized := translate(p_cursor, '-_', '+/');
  normalized := normalized || repeat('=', (4 - length(normalized) % 4) % 4);
  return convert_from(decode(normalized, 'base64'), 'utf8')::jsonb;
exception
  when others then
    raise exception 'Invalid pagination cursor' using errcode = '22023';
end;
$$;

revoke all on function public.portal_encode_cursor(jsonb) from public, anon;
revoke all on function public.portal_decode_cursor(text) from public, anon;

-- Work-order list/history page. Financial values remain staff-only because
-- the lateral join is itself governed by work_order_financials RLS.
create or replace function public.list_work_orders_page(
  p_scope text default 'active',
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
  p_contractor_ids uuid[] default null
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
      lower(coalesce(nullif(trim(p_scope), ''), 'active')) as scope_name,
      lower(coalesce(nullif(trim(p_sort), ''), 'newest')) as sort_name,
      nullif(trim(coalesce(p_search, '')), '') as search_text,
      case when p_cursor is null or trim(p_cursor) = ''
        then null::jsonb
        else public.portal_decode_cursor(p_cursor)
      end as cursor_data
  ),
  candidate_work_orders as materialized (
    select work_order.id
    from public.work_orders work_order
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
        when 'capital' then work_order.status::text in ('capital', 'pending_capital_completion')
        when 'ready_to_bill' then work_order.status::text in ('pending_invoice', 'pending_payment')
        when 'staff_work' then work_order.status::text <> 'closed'
        when 'staff_work_unread' then work_order.status::text <> 'closed'
        when 'staff_work_todo' then work_order.status::text <> 'closed'
        when 'staff_work_ready' then work_order.status::text in ('pending_invoice', 'pending_payment')
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
        or upper(coalesce(work_order.address, '')) ~ (',[[:space:]]*' || upper(p_state) || '([[:space:]]|,|$)')
        or upper(coalesce(work_order.city, '')) ~ ('(,|[[:space:]])' || upper(p_state) || '$')
      )
      and (
        p_resolution is null or p_resolution = 'all'
        or coalesce(work_order.resolution_code, 'unknown') = p_resolution
      )
      and (
        p_from is null
        or coalesce(work_order.closed_at, work_order.created_at)::date >= p_from
      )
      and (
        p_to is null
        or coalesce(work_order.closed_at, work_order.created_at)::date <= p_to
      )
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or (
          coalesce(work_order.id, '') || ' ' ||
          coalesce(work_order.incident_id, '') || ' ' ||
          coalesce(work_order.store_number, '') || ' ' ||
          coalesce(work_order.city, '') || ' ' ||
          coalesce(work_order.address, '') || ' ' ||
          coalesce(work_order.summary, '') || ' ' ||
          coalesce(work_order.description, '')
        ) ilike '%' || trim(p_search) || '%'
      )
      and case args.scope_name
        when 'dashboard_unassigned' then work_order.status::text = 'unassigned'
        when 'dashboard_pending_submission' then work_order.status::text in ('pending_invoice', 'pending_payment')
        when 'dashboard_pending_approval' then (
          work_order.status::text = 'pending_approval'
          or exists (
            select 1 from public.invoices invoice
            where invoice.work_order_id = work_order.id
              and invoice.invoice_type = 'contractor'
              and invoice.deleted_at is null
              and invoice.state::text in ('submitted', 'revised', 'rejected')
          )
        )
        when 'dashboard_awaiting_parts' then (
          work_order.status::text = 'parts'
          or work_order.functional_status = 'Awaiting Parts'
        )
        when 'dashboard_p1_parts_to_order' then exists (
          select 1 from public.wo_parts part
          where part.work_order_id = work_order.id
            and part.ordering_responsibility = 'p1'
            and part.p1_order_status = 'requested'
        )
        when 'dashboard_pending_capital_completion' then
          work_order.status::text = 'pending_capital_completion'
        else true
      end
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
      ) as pending_7eleven_sync_count,
      count(*) filter (
        where activity.requires_contractor_attention
          and activity.contractor_attention_acknowledged_at is null
      ) as pending_contractor_attention_count
    from public.activities activity
    join candidate_work_orders candidate on candidate.id = activity.work_order_id
    where activity.deleted_at is null
    group by activity.work_order_id
  ),
  filtered as (
    select
      work_order.*,
      coalesce(summary.latest_note_at, null) as _latest_note_at,
      coalesce(summary.latest_contractor_activity_at, null) as _latest_contractor_activity_at,
      coalesce(summary.pending_7eleven_sync_count, 0)::bigint as _pending_7eleven_sync_count,
      coalesce(summary.pending_contractor_attention_count, 0)::bigint as _pending_contractor_attention_count,
      case
        when p_pending_first and coalesce(summary.pending_7eleven_sync_count, 0) > 0 then 0
        when p_pending_first then 1
        else 0
      end as _pending_rank,
      case work_order.priority::text
        when 'p1' then 1 when 'p2' then 2 when 'p3' then 3
        when 'p4' then 4 when 'p5' then 5 else 99
      end as _priority_rank,
      coalesce(
        work_order.response_breach_at,
        work_order.resolution_breach_at,
        'infinity'::timestamptz
      ) as _sla_due,
      coalesce(work_order.created_at, work_order.dispatched_at, 'epoch'::timestamptz) as _created_key
    from public.work_orders work_order
    join candidate_work_orders candidate on candidate.id = work_order.id
    left join activity_summary summary on summary.work_order_id = work_order.id
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
        when 'capital' then work_order.status::text in ('capital', 'pending_capital_completion')
        when 'ready_to_bill' then work_order.status::text in ('pending_invoice', 'pending_payment')
        when 'staff_work' then work_order.status::text <> 'closed'
        when 'staff_work_unread' then work_order.status::text <> 'closed'
        when 'staff_work_todo' then work_order.status::text <> 'closed'
        when 'staff_work_ready' then work_order.status::text in ('pending_invoice', 'pending_payment')
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
        or upper(coalesce(work_order.address, '')) ~ (',[[:space:]]*' || upper(p_state) || '([[:space:]]|,|$)')
        or upper(coalesce(work_order.city, '')) ~ ('(,|[[:space:]])' || upper(p_state) || '$')
      )
      and (
        p_resolution is null or p_resolution = 'all'
        or coalesce(work_order.resolution_code, 'unknown') = p_resolution
      )
      and (
        p_from is null
        or coalesce(work_order.closed_at, work_order.created_at)::date >= p_from
      )
      and (
        p_to is null
        or coalesce(work_order.closed_at, work_order.created_at)::date <= p_to
      )
      and (
        args.search_text is null
        or (
          coalesce(work_order.id, '') || ' ' ||
          coalesce(work_order.incident_id, '') || ' ' ||
          coalesce(work_order.store_number, '') || ' ' ||
          coalesce(work_order.city, '') || ' ' ||
          coalesce(work_order.address, '') || ' ' ||
          coalesce(work_order.summary, '') || ' ' ||
          coalesce(work_order.description, '')
        ) ilike '%' || args.search_text || '%'
      )
      and case args.scope_name
        when 'dashboard_unassigned' then work_order.status::text = 'unassigned'
        when 'dashboard_pending_submission' then work_order.status::text in ('pending_invoice', 'pending_payment')
        when 'dashboard_pending_approval' then (
          work_order.status::text = 'pending_approval'
          or exists (
            select 1 from public.invoices invoice
            where invoice.work_order_id = work_order.id
              and invoice.invoice_type = 'contractor'
              and invoice.deleted_at is null
              and invoice.state::text in ('submitted', 'revised', 'rejected')
          )
        )
        when 'dashboard_awaiting_parts' then (
          work_order.status::text = 'parts'
          or work_order.functional_status = 'Awaiting Parts'
        )
        when 'dashboard_seven_eleven_updates' then
          coalesce(summary.pending_7eleven_sync_count, 0) > 0
        when 'dashboard_p1_parts_to_order' then exists (
          select 1 from public.wo_parts part
          where part.work_order_id = work_order.id
            and part.ordering_responsibility = 'p1'
            and part.p1_order_status = 'requested'
        )
        when 'dashboard_pending_capital_completion' then
          work_order.status::text = 'pending_capital_completion'
        when 'staff_work' then (
          work_order.status::text in (
            'unassigned', 'completed', 'pending_invoice', 'pending_payment',
            'pending_approval', 'capital'
          )
          or coalesce(summary.pending_7eleven_sync_count, 0) > 0
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
        when 'staff_work_unread' then (
          summary.latest_contractor_activity_at is not null
          and summary.latest_contractor_activity_at > coalesce((
            select notification_read.read_through_at
            from public.staff_work_order_notification_reads notification_read
            where notification_read.user_id = auth.uid()
              and notification_read.work_order_id = work_order.id
          ), '-infinity'::timestamptz)
        )
        when 'staff_work_todo' then exists (
          select 1
          from public.staff_work_order_todos todo
          where todo.work_order_id = work_order.id
            and todo.owner_id = auth.uid()
            and todo.completed_at is null
        )
        when 'staff_work_ready' then
          work_order.status::text in ('pending_invoice', 'pending_payment')
        else true
      end
      and (
        not p_needs_action
        or (
          public.is_staff() and (
            work_order.status::text in (
              'unassigned', 'completed', 'pending_invoice', 'pending_approval', 'capital'
            )
            or coalesce(summary.pending_7eleven_sync_count, 0) > 0
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
        )
      )
  ),
  after_cursor as (
    select filtered.*
    from filtered
    cross join args
    where args.cursor_data is null
      or filtered._pending_rank > coalesce((args.cursor_data ->> 'pending')::integer, 0)
      or (
        filtered._pending_rank = coalesce((args.cursor_data ->> 'pending')::integer, 0)
        and case args.sort_name
          when 'oldest' then
            (filtered._created_key, filtered.id) > (
              (args.cursor_data ->> 'created')::timestamptz,
              args.cursor_data ->> 'id'
            )
          when 'priority' then
            filtered._priority_rank > (args.cursor_data ->> 'priority')::integer
            or (
              filtered._priority_rank = (args.cursor_data ->> 'priority')::integer
              and (
                filtered._sla_due > (args.cursor_data ->> 'due')::timestamptz
                or (
                  filtered._sla_due = (args.cursor_data ->> 'due')::timestamptz
                  and filtered.id < (args.cursor_data ->> 'id')
                )
              )
            )
          when 'sla_due' then
            filtered._sla_due > (args.cursor_data ->> 'due')::timestamptz
            or (
              filtered._sla_due = (args.cursor_data ->> 'due')::timestamptz
              and (filtered._created_key, filtered.id) < (
                (args.cursor_data ->> 'created')::timestamptz,
                args.cursor_data ->> 'id'
              )
            )
          else
            (filtered._created_key, filtered.id) < (
              (args.cursor_data ->> 'created')::timestamptz,
              args.cursor_data ->> 'id'
            )
        end
      )
  ),
  ordered as (
    select
      after_cursor.*,
      row_number() over (
        order by
          after_cursor._pending_rank asc,
          case when args.sort_name = 'oldest' then after_cursor._created_key end asc,
          case when args.sort_name = 'priority' then after_cursor._priority_rank end asc,
          case when args.sort_name in ('priority', 'sla_due') then after_cursor._sla_due end asc,
          case when args.sort_name = 'sla_due' then after_cursor._created_key end desc,
          case when args.sort_name not in ('oldest', 'priority', 'sla_due') then after_cursor._created_key end desc,
          case when args.sort_name = 'oldest' then after_cursor.id end asc,
          after_cursor.id desc
      ) as _row_number
    from after_cursor
    cross join args
    order by
      after_cursor._pending_rank asc,
      case when args.sort_name = 'oldest' then after_cursor._created_key end asc,
      case when args.sort_name = 'priority' then after_cursor._priority_rank end asc,
      case when args.sort_name in ('priority', 'sla_due') then after_cursor._sla_due end asc,
      case when args.sort_name = 'sla_due' then after_cursor._created_key end desc,
      case when args.sort_name not in ('oldest', 'priority', 'sla_due') then after_cursor._created_key end desc,
      case when args.sort_name = 'oldest' then after_cursor.id end asc,
      after_cursor.id desc
    limit (select page_size + 1 from args)
  ),
  numbered as (
    select ordered.*
    from ordered
  ),
  page_rows as (
    select numbered.*
    from numbered
    cross join args
    where numbered._row_number <= args.page_size
  ),
  enriched as (
    select
      page_rows._row_number,
      (
        to_jsonb(page_rows)
        - array[
          '_row_number', '_latest_note_at', '_latest_contractor_activity_at',
          '_pending_7eleven_sync_count', '_pending_contractor_attention_count',
          '_pending_rank', '_priority_rank', '_sla_due', '_created_key'
        ]::text[]
      )
      || jsonb_build_object(
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
    'hasMore', (select count(*) from numbered) > (select page_size from args),
    'nextCursor', case
      when (select count(*) from numbered) <= (select page_size from args) then null
      else (
        select public.portal_encode_cursor(jsonb_build_object(
          'pending', last_row._pending_rank,
          'priority', last_row._priority_rank,
          'due', last_row._sla_due,
          'created', last_row._created_key,
          'id', last_row.id
        ))
        from last_row
      )
    end,
    'totalCount', (select count(*) from filtered),
    'aggregates', case when (select scope_name from args) = 'history' then
      jsonb_build_object(
        'invoiceTotal', coalesce((
          select sum(invoice.total)
          from public.invoices invoice
          join filtered work_order on work_order.id = invoice.work_order_id
          where invoice.invoice_type = 'contractor'
            and invoice.deleted_at is null
            and invoice.state::text not in ('draft', 'rejected')
        ), 0)
      )
      else null end
  );
$$;

-- A selected row may not belong to the currently mounted page. This lookup
-- keeps direct links and history navigation independent of bootstrap arrays.
create or replace function public.get_portal_work_order(p_work_order_id text)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select case when work_order.id is null then null else
    to_jsonb(work_order)
    || jsonb_build_object(
      'latest_note_at', summary.latest_note_at,
      'latest_contractor_activity_at', summary.latest_contractor_activity_at,
      'pending_7eleven_sync_count', coalesce(summary.pending_7eleven_sync_count, 0),
      'pending_contractor_attention_count', coalesce(summary.pending_contractor_attention_count, 0),
      'afm_email', coalesce(afm.afm_email, work_order.afm_email),
      'nte', coalesce(financial.nte, work_order.nte),
      'nte_flag_threshold', coalesce(financial.nte_flag_threshold, work_order.nte_flag_threshold),
      'nte_flagged', coalesce(financial.nte_flagged, work_order.nte_flagged, false),
      'nte_flag_amount', coalesce(financial.nte_flag_amount, work_order.nte_flag_amount),
      'assignment_history', coalesce(history.rows, '[]'::jsonb),
      'staff_todo', staff_todo.row_data,
      'staff_read_through_at', staff_read.read_through_at
    ) end
  from public.work_orders work_order
  left join public.work_order_afm_contacts afm on afm.work_order_id = work_order.id
  left join public.work_order_financials financial on financial.work_order_id = work_order.id
  left join lateral (
    select
      max(activity.created_at) filter (where activity.type = 'note') as latest_note_at,
      max(activity.created_at) filter (
        where activity.entered_by_role = 'contractor'
      ) as latest_contractor_activity_at,
      count(*) filter (
        where activity.requires_7eleven_sync and activity.synced_to_7eleven_at is null
      ) as pending_7eleven_sync_count,
      count(*) filter (
        where activity.requires_contractor_attention
          and activity.contractor_attention_acknowledged_at is null
      ) as pending_contractor_attention_count
    from public.activities activity
    where activity.work_order_id = work_order.id
      and activity.deleted_at is null
  ) summary on true
  left join lateral (
    select jsonb_agg(to_jsonb(assignment) order by assignment.assignment_ended_at desc, assignment.id desc) as rows
    from public.work_order_assignment_history assignment
    where assignment.work_order_id = work_order.id
  ) history on true
  left join lateral (
    select to_jsonb(todo) as row_data
    from public.staff_work_order_todos todo
    where todo.work_order_id = work_order.id
      and todo.completed_at is null
    order by todo.created_at desc, todo.id desc
    limit 1
  ) staff_todo on true
  left join public.staff_work_order_notification_reads staff_read
    on staff_read.work_order_id = work_order.id
    and staff_read.user_id = auth.uid()
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null;
$$;

create or replace function public.list_work_order_activities_page(
  p_work_order_id text,
  p_limit integer default 30,
  p_cursor text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with args as (
    select
      greatest(1, least(coalesce(p_limit, 30), 100)) as page_size,
      case when p_cursor is null or trim(p_cursor) = '' then null::jsonb
        else public.portal_decode_cursor(p_cursor) end as cursor_data
  ),
  filtered as (
    select activity.*
    from public.activities activity, args
    where activity.work_order_id = p_work_order_id
      and activity.deleted_at is null
      and (
        args.cursor_data is null
        or (coalesce(activity.created_at, 'epoch'::timestamptz), activity.id) < (
          (args.cursor_data ->> 'created')::timestamptz,
          (args.cursor_data ->> 'id')::uuid
        )
      )
    order by activity.created_at desc nulls last, activity.id desc
    limit (select page_size + 1 from args)
  ),
  page_rows as (
    select filtered.*, row_number() over (
      order by filtered.created_at desc nulls last, filtered.id desc
    ) as row_number
    from filtered
    limit (select page_size from args)
  ),
  last_row as (
    select * from page_rows order by row_number desc limit 1
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(page_rows) - 'row_number' order by row_number) from page_rows), '[]'::jsonb),
    'hasMore', (select count(*) from filtered) > (select page_size from args),
    'nextCursor', case when (select count(*) from filtered) > (select page_size from args)
      then (select public.portal_encode_cursor(jsonb_build_object(
        'created', coalesce(last_row.created_at, 'epoch'::timestamptz), 'id', last_row.id
      )) from last_row)
      else null end,
    'totalCount', (
      select count(*) from public.activities activity
      where activity.work_order_id = p_work_order_id and activity.deleted_at is null
    )
  );
$$;

create or replace function public.list_work_order_photos_page(
  p_work_order_id text,
  p_limit integer default 24,
  p_cursor text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with args as (
    select
      greatest(1, least(coalesce(p_limit, 24), 100)) as page_size,
      case when p_cursor is null or trim(p_cursor) = '' then null::jsonb
        else public.portal_decode_cursor(p_cursor) end as cursor_data
  ),
  filtered as (
    select photo.*
    from public.photos photo, args
    where photo.work_order_id = p_work_order_id
      and (
        args.cursor_data is null
        or (coalesce(photo.created_at, 'epoch'::timestamptz), photo.id) < (
          (args.cursor_data ->> 'created')::timestamptz,
          (args.cursor_data ->> 'id')::uuid
        )
      )
    order by photo.created_at desc nulls last, photo.id desc
    limit (select page_size + 1 from args)
  ),
  page_rows as (
    select filtered.*, row_number() over (
      order by filtered.created_at desc nulls last, filtered.id desc
    ) as row_number
    from filtered
    limit (select page_size from args)
  ),
  last_row as (select * from page_rows order by row_number desc limit 1)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(page_rows) - 'row_number' order by row_number) from page_rows), '[]'::jsonb),
    'hasMore', (select count(*) from filtered) > (select page_size from args),
    'nextCursor', case when (select count(*) from filtered) > (select page_size from args)
      then (select public.portal_encode_cursor(jsonb_build_object(
        'created', coalesce(last_row.created_at, 'epoch'::timestamptz), 'id', last_row.id
      )) from last_row)
      else null end,
    'totalCount', (select count(*) from public.photos photo where photo.work_order_id = p_work_order_id)
  );
$$;

create or replace function public.list_work_order_visits_page(
  p_work_order_id text,
  p_limit integer default 30,
  p_cursor text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with args as (
    select
      greatest(1, least(coalesce(p_limit, 30), 100)) as page_size,
      case when p_cursor is null or trim(p_cursor) = '' then null::jsonb
        else public.portal_decode_cursor(p_cursor) end as cursor_data
  ),
  filtered as (
    select visit.*
    from public.work_order_visits visit, args
    where visit.work_order_id = p_work_order_id
      and (
        args.cursor_data is null
        or (visit.check_in_at, visit.id) < (
          (args.cursor_data ->> 'checkIn')::timestamptz,
          (args.cursor_data ->> 'id')::uuid
        )
      )
    order by visit.check_in_at desc, visit.id desc
    limit (select page_size + 1 from args)
  ),
  page_rows as (
    select filtered.*, row_number() over (
      order by filtered.check_in_at desc, filtered.id desc
    ) as row_number
    from filtered
    limit (select page_size from args)
  ),
  last_row as (select * from page_rows order by row_number desc limit 1)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(page_rows) - 'row_number' order by row_number) from page_rows), '[]'::jsonb),
    'hasMore', (select count(*) from filtered) > (select page_size from args),
    'nextCursor', case when (select count(*) from filtered) > (select page_size from args)
      then (select public.portal_encode_cursor(jsonb_build_object(
        'checkIn', last_row.check_in_at, 'id', last_row.id
      )) from last_row)
      else null end,
    'totalCount', (select count(*) from public.work_order_visits visit where visit.work_order_id = p_work_order_id)
  );
$$;

-- Contractor invoice page. Lines and upload metadata are joined only for the
-- current page, so line-table growth no longer expands every screen load.
create or replace function public.list_contractor_invoices_page(
  p_state text default 'all',
  p_search text default null,
  p_sort text default 'recent',
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
      lower(coalesce(nullif(trim(p_sort), ''), 'recent')) as sort_name,
      case when lower(p_direction) = 'asc' then 'asc' else 'desc' end as direction_name,
      nullif(trim(coalesce(p_search, '')), '') as search_text,
      case when p_cursor is null or trim(p_cursor) = '' then null::jsonb
        else public.portal_decode_cursor(p_cursor) end as cursor_data
  ),
  invoice_rows as (
    select
      invoice.*,
      coalesce(profile.name, '') as _contractor_name,
      coalesce(line_summary.line_count, 0)::integer as _line_count,
      case when public.is_staff() then source_owner.staff_invoice_id else null end as _source_staff_invoice_id,
      case
        when args.sort_name = 'invoice' then coalesce(substring(invoice.num from '([0-9]+)$')::numeric, 0)
        when args.sort_name = 'lines' then coalesce(line_summary.line_count, 0)::numeric
        when args.sort_name = 'total' then coalesce(invoice.total, 0)::numeric
        else 0::numeric
      end as _sort_number,
      case
        when args.sort_name = 'work_order' then lower(coalesce(invoice.work_order_id, ''))
        when args.sort_name = 'contractor' then lower(coalesce(profile.name, ''))
        when args.sort_name = 'status' then lower(invoice.state::text)
        when args.sort_name = 'store' then lower(coalesce(invoice.store_number, ''))
        else ''
      end as _sort_text,
      case
        when args.sort_name = 'date' then invoice.invoice_date::timestamptz
        else coalesce(invoice.created_at, invoice.invoice_date::timestamptz)
      end as _sort_time
    from public.invoices invoice
    cross join args
    left join public.profiles profile on profile.id = invoice.contractor_id
    left join lateral (
      select count(*)::integer as line_count
      from public.invoice_lines line
      where line.invoice_id = invoice.id
    ) line_summary on true
    left join lateral (
      select source.staff_invoice_id
      from public.staff_invoice_sources source
      where source.contractor_invoice_id = invoice.id
      order by source.created_at desc, source.id desc
      limit 1
    ) source_owner on true
    where invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and (p_work_order_id is null or invoice.work_order_id = p_work_order_id)
      and (
        p_state is null or p_state = 'all'
        or (p_state = 'active' and invoice.state::text <> 'paid')
        or invoice.state::text = p_state
      )
      and (
        args.search_text is null
        or (
          coalesce(invoice.num, '') || ' ' ||
          coalesce(invoice.work_order_id, '') || ' ' ||
          coalesce(invoice.store_number, '') || ' ' ||
          coalesce(invoice.store_address, '')
        ) ilike '%' || args.search_text || '%'
        or coalesce(profile.name, '') ilike '%' || args.search_text || '%'
        or exists (
          select 1 from public.invoice_lines line
          where line.invoice_id = invoice.id
            and coalesce(line.description, '') ilike '%' || args.search_text || '%'
        )
      )
  ),
  after_cursor as (
    select invoice_rows.*
    from invoice_rows, args
    where args.cursor_data is null
      or case
        when args.sort_name in ('invoice', 'lines', 'total') and args.direction_name = 'asc'
          then (invoice_rows._sort_number, invoice_rows.id) > (
            (args.cursor_data ->> 'number')::numeric,
            (args.cursor_data ->> 'id')::uuid
          )
        when args.sort_name in ('invoice', 'lines', 'total')
          then (invoice_rows._sort_number, invoice_rows.id) < (
            (args.cursor_data ->> 'number')::numeric,
            (args.cursor_data ->> 'id')::uuid
          )
        when args.sort_name in ('work_order', 'contractor', 'status', 'store') and args.direction_name = 'asc'
          then (invoice_rows._sort_text, invoice_rows.id) > (
            args.cursor_data ->> 'text',
            (args.cursor_data ->> 'id')::uuid
          )
        when args.sort_name in ('work_order', 'contractor', 'status', 'store')
          then (invoice_rows._sort_text, invoice_rows.id) < (
            args.cursor_data ->> 'text',
            (args.cursor_data ->> 'id')::uuid
          )
        when args.direction_name = 'asc'
          then (invoice_rows._sort_time, invoice_rows.id) > (
            (args.cursor_data ->> 'time')::timestamptz,
            (args.cursor_data ->> 'id')::uuid
          )
        else (invoice_rows._sort_time, invoice_rows.id) < (
          (args.cursor_data ->> 'time')::timestamptz,
          (args.cursor_data ->> 'id')::uuid
        )
      end
  ),
  ordered as (
    select
      after_cursor.*,
      row_number() over (
        order by
          case when args.direction_name = 'asc' and args.sort_name in ('invoice', 'lines', 'total') then after_cursor._sort_number end asc,
          case when args.direction_name = 'desc' and args.sort_name in ('invoice', 'lines', 'total') then after_cursor._sort_number end desc,
          case when args.direction_name = 'asc' and args.sort_name in ('work_order', 'contractor', 'status', 'store') then after_cursor._sort_text end asc,
          case when args.direction_name = 'desc' and args.sort_name in ('work_order', 'contractor', 'status', 'store') then after_cursor._sort_text end desc,
          case when args.direction_name = 'asc' and args.sort_name not in ('invoice', 'lines', 'total', 'work_order', 'contractor', 'status', 'store') then after_cursor._sort_time end asc,
          case when args.direction_name = 'desc' and args.sort_name not in ('invoice', 'lines', 'total', 'work_order', 'contractor', 'status', 'store') then after_cursor._sort_time end desc,
          case when args.direction_name = 'asc' then after_cursor.id end asc,
          after_cursor.id desc
      ) as _row_number
    from after_cursor, args
    order by
      case when args.direction_name = 'asc' and args.sort_name in ('invoice', 'lines', 'total') then after_cursor._sort_number end asc,
      case when args.direction_name = 'desc' and args.sort_name in ('invoice', 'lines', 'total') then after_cursor._sort_number end desc,
      case when args.direction_name = 'asc' and args.sort_name in ('work_order', 'contractor', 'status', 'store') then after_cursor._sort_text end asc,
      case when args.direction_name = 'desc' and args.sort_name in ('work_order', 'contractor', 'status', 'store') then after_cursor._sort_text end desc,
      case when args.direction_name = 'asc' and args.sort_name not in ('invoice', 'lines', 'total', 'work_order', 'contractor', 'status', 'store') then after_cursor._sort_time end asc,
      case when args.direction_name = 'desc' and args.sort_name not in ('invoice', 'lines', 'total', 'work_order', 'contractor', 'status', 'store') then after_cursor._sort_time end desc,
      case when args.direction_name = 'asc' then after_cursor.id end asc,
      after_cursor.id desc
    limit (select page_size + 1 from args)
  ),
  numbered as (select ordered.* from ordered),
  page_rows as (
    select numbered.* from numbered, args where numbered._row_number <= args.page_size
  ),
  enriched as (
    select
      page_rows._row_number,
      (
        to_jsonb(page_rows)
        - array['_row_number', '_contractor_name', '_line_count', '_source_staff_invoice_id', '_sort_number', '_sort_text', '_sort_time']::text[]
      )
      || jsonb_build_object(
        'contractor_name', page_rows._contractor_name,
        'source_staff_invoice_id', page_rows._source_staff_invoice_id,
        'lines', coalesce(lines.rows, '[]'::jsonb),
        'pdf_is_original', upload.pdf_is_original,
        'original_pdf_name', upload.original_pdf_name
      ) as item
    from page_rows
    left join lateral (
      select jsonb_agg(to_jsonb(line) order by line.position asc, line.id asc) as rows
      from public.invoice_lines line
      where line.invoice_id = page_rows.id
    ) lines on true
    left join lateral (
      select
        true as pdf_is_original,
        activity.event_data ->> 'fileName' as original_pdf_name
      from public.activities activity
      where activity.event_key = 'invoice_uploaded'
        and activity.deleted_at is null
        and activity.event_data ->> 'invoiceId' = page_rows.id::text
      order by activity.created_at desc, activity.id desc
      limit 1
    ) upload on true
  ),
  last_row as (select * from page_rows order by _row_number desc limit 1)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(enriched.item order by enriched._row_number) from enriched), '[]'::jsonb),
    'hasMore', (select count(*) from numbered) > (select page_size from args),
    'nextCursor', case when (select count(*) from numbered) > (select page_size from args)
      then (select public.portal_encode_cursor(jsonb_build_object(
        'number', last_row._sort_number,
        'text', last_row._sort_text,
        'time', last_row._sort_time,
        'id', last_row.id
      )) from last_row)
      else null end,
    'totalCount', (select count(*) from invoice_rows)
  );
$$;

-- Staff billing headers use the same cursor contract. The API enriches only
-- these page IDs with line and source-invoice rows, avoiding the former four
-- full-table downloads on every Billing visit.
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
      lower(coalesce(nullif(trim(p_sort), ''), 'invoice')) as sort_name,
      case when lower(p_direction) = 'asc' then 'asc' else 'desc' end as direction_name,
      nullif(trim(coalesce(p_search, '')), '') as search_text,
      case when p_cursor is null or trim(p_cursor) = '' then null::jsonb
        else public.portal_decode_cursor(p_cursor) end as cursor_data
  ),
  invoice_rows as (
    select
      invoice.*,
      case when args.sort_name = 'invoice'
        then coalesce(substring(invoice.num from '([0-9]+)$')::numeric, 0)
        else 0::numeric end as _sort_number,
      case when args.sort_name = 'status'
        then lower(invoice.state::text)
        else '' end as _sort_text,
      coalesce(invoice.updated_at, invoice.created_at, invoice.invoice_date::timestamptz) as _sort_time
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
    from invoice_rows, args
    where args.cursor_data is null
      or case
        when args.sort_name = 'invoice' and args.direction_name = 'asc'
          then (invoice_rows._sort_number, invoice_rows.id) > (
            (args.cursor_data ->> 'number')::numeric,
            (args.cursor_data ->> 'id')::uuid
          )
        when args.sort_name = 'invoice'
          then (invoice_rows._sort_number, invoice_rows.id) < (
            (args.cursor_data ->> 'number')::numeric,
            (args.cursor_data ->> 'id')::uuid
          )
        when args.sort_name = 'status' and args.direction_name = 'asc'
          then (invoice_rows._sort_text, invoice_rows.id) > (
            args.cursor_data ->> 'text',
            (args.cursor_data ->> 'id')::uuid
          )
        when args.sort_name = 'status'
          then (invoice_rows._sort_text, invoice_rows.id) < (
            args.cursor_data ->> 'text',
            (args.cursor_data ->> 'id')::uuid
          )
        when args.direction_name = 'asc'
          then (invoice_rows._sort_time, invoice_rows.id) > (
            (args.cursor_data ->> 'time')::timestamptz,
            (args.cursor_data ->> 'id')::uuid
          )
        else (invoice_rows._sort_time, invoice_rows.id) < (
          (args.cursor_data ->> 'time')::timestamptz,
          (args.cursor_data ->> 'id')::uuid
        )
      end
  ),
  ordered as (
    select
      after_cursor.*,
      row_number() over (
        order by
          case when args.direction_name = 'asc' and args.sort_name = 'invoice' then after_cursor._sort_number end asc,
          case when args.direction_name = 'desc' and args.sort_name = 'invoice' then after_cursor._sort_number end desc,
          case when args.direction_name = 'asc' and args.sort_name = 'status' then after_cursor._sort_text end asc,
          case when args.direction_name = 'desc' and args.sort_name = 'status' then after_cursor._sort_text end desc,
          case when args.direction_name = 'asc' and args.sort_name not in ('invoice', 'status') then after_cursor._sort_time end asc,
          case when args.direction_name = 'desc' and args.sort_name not in ('invoice', 'status') then after_cursor._sort_time end desc,
          case when args.direction_name = 'asc' then after_cursor.id end asc,
          after_cursor.id desc
      ) as _row_number
    from after_cursor, args
    order by
      case when args.direction_name = 'asc' and args.sort_name = 'invoice' then after_cursor._sort_number end asc,
      case when args.direction_name = 'desc' and args.sort_name = 'invoice' then after_cursor._sort_number end desc,
      case when args.direction_name = 'asc' and args.sort_name = 'status' then after_cursor._sort_text end asc,
      case when args.direction_name = 'desc' and args.sort_name = 'status' then after_cursor._sort_text end desc,
      case when args.direction_name = 'asc' and args.sort_name not in ('invoice', 'status') then after_cursor._sort_time end asc,
      case when args.direction_name = 'desc' and args.sort_name not in ('invoice', 'status') then after_cursor._sort_time end desc,
      case when args.direction_name = 'asc' then after_cursor.id end asc,
      after_cursor.id desc
    limit (select page_size + 1 from args)
  ),
  page_rows as (
    select ordered.* from ordered, args where ordered._row_number <= args.page_size
  ),
  last_row as (select * from page_rows order by _row_number desc limit 1)
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        to_jsonb(page_rows) - array['_row_number', '_sort_number', '_sort_text', '_sort_time']::text[]
        order by page_rows._row_number
      ) from page_rows
    ), '[]'::jsonb),
    'hasMore', (select count(*) from ordered) > (select page_size from args),
    'nextCursor', case when (select count(*) from ordered) > (select page_size from args)
      then (select public.portal_encode_cursor(jsonb_build_object(
        'number', last_row._sort_number,
        'text', last_row._sort_text,
        'time', last_row._sort_time,
        'id', last_row.id
      )) from last_row)
      else null end,
    'totalCount', (select count(*) from invoice_rows)
  );
$$;

-- The application shell needs counts for navigation and alert badges, not
-- thousands of rows. Compute those values in one RLS-aware scan so opening a
-- route never requires a hidden full-table bootstrap query.
create or replace function public.get_portal_navigation_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with visible_work_orders as materialized (
    select work_order.*
    from public.work_orders work_order
    where work_order.deleted_at is null
  ),
  activity_summary as (
    select
      activity.work_order_id,
      max(activity.created_at) filter (
        where activity.entered_by_role = 'contractor'
      ) as latest_contractor_activity_at,
      count(*) filter (
        where activity.requires_7eleven_sync
          and activity.synced_to_7eleven_at is null
      ) as pending_7eleven_sync_count,
      count(*) filter (
        where activity.requires_contractor_attention
          and activity.contractor_attention_acknowledged_at is null
      ) as pending_contractor_attention_count
    from public.activities activity
    join visible_work_orders work_order on work_order.id = activity.work_order_id
    where activity.deleted_at is null
    group by activity.work_order_id
  ),
  personal_reads as (
    select notification_read.work_order_id, notification_read.read_through_at
    from public.staff_work_order_notification_reads notification_read
    where notification_read.user_id = auth.uid()
  ),
  active_todos as (
    select todo.work_order_id, todo.owner_id
    from public.staff_work_order_todos todo
    where todo.completed_at is null
  ),
  annotated as (
    select
      work_order.*,
      coalesce(activity.pending_7eleven_sync_count, 0) as pending_7eleven_sync_count,
      coalesce(activity.pending_contractor_attention_count, 0) as pending_contractor_attention_count,
      activity.latest_contractor_activity_at,
      personal_read.read_through_at,
      todo.owner_id as todo_owner_id
    from visible_work_orders work_order
    left join activity_summary activity on activity.work_order_id = work_order.id
    left join personal_reads personal_read on personal_read.work_order_id = work_order.id
    left join active_todos todo on todo.work_order_id = work_order.id
  )
  select jsonb_build_object(
    'openCount', count(*) filter (
      where annotated.status::text in ('unassigned', 'assigned', 'wip', 'parts')
    ),
    'p1UnassignedCount', count(*) filter (
      where annotated.priority::text = 'p1' and annotated.status::text = 'unassigned'
    ),
    'capitalCount', count(*) filter (
      where (
        annotated.is_capital
        or annotated.status::text in ('capital', 'pending_capital_completion')
      ) and annotated.status::text <> 'closed'
    ),
    'pendingApprovalCount', count(*) filter (
      where annotated.status::text = 'pending_approval'
    ),
    'historyCount', count(*) filter (where annotated.status::text = 'closed'),
    'slaBreachedCount', count(*) filter (
      where annotated.status::text in ('unassigned', 'assigned', 'wip', 'parts')
        and (
          (
            annotated.response_breach_at is not null
            and annotated.start_time is null
            and annotated.response_breach_at <= now()
          )
          or (
            annotated.resolution_breach_at is not null
            and annotated.resolution_breach_at <= now()
          )
        )
    ),
    'contractorActiveCount', count(*) filter (
      where annotated.status::text in ('unassigned', 'assigned', 'wip', 'parts')
    ),
    'contractorAttentionCount', coalesce(sum(
      annotated.pending_contractor_attention_count
    ), 0),
    'staffUnreadCount', count(*) filter (
      where public.is_staff()
        and annotated.status::text <> 'closed'
        and annotated.latest_contractor_activity_at is not null
        and annotated.latest_contractor_activity_at > coalesce(
          annotated.read_through_at,
          '-infinity'::timestamptz
        )
    ),
    'myTodoCount', count(*) filter (
      where public.is_staff() and annotated.todo_owner_id = auth.uid()
    ),
    'readyToBillCount', count(*) filter (
      where public.is_staff()
        and annotated.status::text in ('pending_invoice', 'pending_payment')
    ),
    'staffWorkCount', count(*) filter (
      where public.is_staff()
        and annotated.status::text <> 'closed'
        and (
          annotated.status::text in (
            'unassigned', 'completed', 'pending_invoice', 'pending_payment',
            'pending_approval', 'capital'
          )
          or annotated.pending_7eleven_sync_count > 0
          or annotated.todo_owner_id is not null
          or (
            annotated.latest_contractor_activity_at is not null
            and annotated.latest_contractor_activity_at > coalesce(
              annotated.read_through_at,
              '-infinity'::timestamptz
            )
          )
        )
    ),
    'contractorInvoiceCount', (
      select count(*)
      from public.invoices invoice
      where invoice.invoice_type = 'contractor'
        and invoice.deleted_at is null
        and invoice.state::text in ('submitted', 'revised', 'rejected')
    )
  )
  from annotated;
$$;

-- Contractor cards need aggregate workload counts, not every work-order row.
-- RLS still determines which assignments the caller may contribute to the
-- result, while staff receive one compact object for the whole directory.
create or replace function public.get_contractor_workload_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(
      workload.contractor_id::text,
      jsonb_build_object(
        'active', workload.active_count,
        'capital', workload.capital_count
      )
    ),
    '{}'::jsonb
  )
  from (
    select
      work_order.contractor_id,
      count(*) filter (
        where work_order.status::text in ('unassigned', 'assigned', 'wip', 'parts')
      ) as active_count,
      count(*) filter (
        where work_order.status::text in ('capital', 'pending_capital_completion')
      ) as capital_count
    from public.work_orders work_order
    where work_order.deleted_at is null
      and work_order.contractor_id is not null
    group by work_order.contractor_id
  ) workload;
$$;

revoke all on function public.list_work_orders_page(text, text, uuid, text, text, text, text, date, date, boolean, text, boolean, integer, text, text, uuid[]) from public, anon;
revoke all on function public.get_portal_work_order(text) from public, anon;
revoke all on function public.list_work_order_activities_page(text, integer, text) from public, anon;
revoke all on function public.list_work_order_photos_page(text, integer, text) from public, anon;
revoke all on function public.list_work_order_visits_page(text, integer, text) from public, anon;
revoke all on function public.list_contractor_invoices_page(text, text, text, text, integer, text, text) from public, anon;
revoke all on function public.list_staff_invoices_page(text, text, text, text, integer, text, text) from public, anon;
revoke all on function public.get_portal_navigation_summary() from public, anon;
revoke all on function public.get_contractor_workload_summary() from public, anon;

grant execute on function public.list_work_orders_page(text, text, uuid, text, text, text, text, date, date, boolean, text, boolean, integer, text, text, uuid[]) to authenticated, service_role;
grant execute on function public.get_portal_work_order(text) to authenticated, service_role;
grant execute on function public.list_work_order_activities_page(text, integer, text) to authenticated, service_role;
grant execute on function public.list_work_order_photos_page(text, integer, text) to authenticated, service_role;
grant execute on function public.list_work_order_visits_page(text, integer, text) to authenticated, service_role;
grant execute on function public.list_contractor_invoices_page(text, text, text, text, integer, text, text) to authenticated, service_role;
grant execute on function public.list_staff_invoices_page(text, text, text, text, integer, text, text) to authenticated, service_role;
grant execute on function public.get_portal_navigation_summary() to authenticated, service_role;
grant execute on function public.get_contractor_workload_summary() to authenticated, service_role;

-- Indexes mirror the equality, ordering, and per-parent cursor predicates.
create index if not exists work_orders_active_created_cursor_idx
  on public.work_orders (created_at desc, id desc)
  where deleted_at is null;
create index if not exists work_orders_status_created_cursor_idx
  on public.work_orders (status, created_at desc, id desc)
  where deleted_at is null;
create index if not exists work_orders_contractor_created_cursor_idx
  on public.work_orders (contractor_id, created_at desc, id desc)
  where deleted_at is null;
create index if not exists work_orders_closed_cursor_idx
  on public.work_orders (closed_at desc, id desc)
  where deleted_at is null and status = 'closed';
create index if not exists work_orders_portal_search_trgm_idx
  on public.work_orders using gin ((
    coalesce(id, '') || ' ' || coalesce(incident_id, '') || ' ' ||
    coalesce(store_number, '') || ' ' || coalesce(city, '') || ' ' ||
    coalesce(address, '') || ' ' || coalesce(summary, '') || ' ' ||
    coalesce(description, '')
  ) gin_trgm_ops)
  where deleted_at is null;

create index if not exists activities_work_order_created_cursor_idx
  on public.activities (work_order_id, created_at desc, id desc)
  where deleted_at is null;
create index if not exists photos_work_order_created_cursor_idx
  on public.photos (work_order_id, created_at desc, id desc);
create index if not exists work_order_visits_work_order_check_in_cursor_idx
  on public.work_order_visits (work_order_id, check_in_at desc, id desc);

create index if not exists invoices_contractor_state_created_cursor_idx
  on public.invoices (invoice_type, state, created_at desc, id desc)
  where deleted_at is null;
create index if not exists invoices_contractor_date_cursor_idx
  on public.invoices (invoice_type, invoice_date desc, id desc)
  where deleted_at is null;
create index if not exists invoices_portal_search_trgm_idx
  on public.invoices using gin ((
    coalesce(num, '') || ' ' || coalesce(work_order_id, '') || ' ' ||
    coalesce(store_number, '') || ' ' || coalesce(store_address, '')
  ) gin_trgm_ops)
  where deleted_at is null and invoice_type = 'contractor';
create index if not exists invoice_lines_description_trgm_idx
  on public.invoice_lines using gin ((coalesce(description, '')) gin_trgm_ops);

commit;
