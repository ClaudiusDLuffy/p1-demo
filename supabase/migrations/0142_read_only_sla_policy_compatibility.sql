-- Batch 3D: read-only SLA compatibility, not a new approved SLA contract.
-- This pure SQL materialization matches src/lib/sla/policy.ts and evaluation.ts.
-- Cross-language executable tests bind it to that single TypeScript policy.
-- No source work-order/deadline/anchor/activity/outbox row is updated or backfilled.
-- Existing invoker/RLS, scope predicates, ordering tie-breakers, response fields
-- and opaque cursors remain unchanged. now() is transaction-stable within a read.
-- Across separate pages an existing live SLA deadline can change headline as
-- time passes; this migration does not introduce a snapshot/cursor redesign.
begin;

create function public.evaluate_work_order_sla_v1(
  p_priority text,
  p_dispatched_at timestamptz,
  p_response_breach_at timestamptz,
  p_resolution_breach_at timestamptz,
  p_start_time timestamptz,
  p_now timestamptz
)
returns table(due_at timestamptz,breached boolean)
language sql immutable parallel safe security invoker
set search_path=pg_catalog,public as $$
  with inputs as (
    select p_response_breach_at is not null or p_resolution_breach_at is not null as stored,
      case when isfinite(p_response_breach_at) then p_response_breach_at end as response_due,
      case when isfinite(p_resolution_breach_at) then p_resolution_breach_at end as resolution_due,
      case when isfinite(p_start_time) then p_start_time end as responded_at,
      case when isfinite(p_dispatched_at) then p_dispatched_at end as dispatched_at,
      case when isfinite(p_now) then p_now end as evaluated_at,
      -- Compatibility-only materialization. Change through the canonical policy
      -- and parity tests, never as an independent editable SLA registry.
      case lower(p_priority) when 'p1' then 8 when 'p2' then 24
        when 'p3' then 72 when 'p4' then 168 else null end as legacy_hours
  ), evaluated as (
    select *,
      case when stored then
        case when response_due is not null and resolution_due is not null then
          case when responded_at is not null or response_due<=evaluated_at or resolution_due<response_due
            then resolution_due else response_due end
          when resolution_due is not null then resolution_due
          when response_due is not null and responded_at is null then response_due
          else null end
        when dispatched_at is not null and legacy_hours is not null
          then dispatched_at+legacy_hours*interval '1 hour'
        else null end as effective_due
    from inputs
  )
  select effective_due,
    coalesce((response_due is not null and responded_at is null and response_due<=evaluated_at)
      or (resolution_due is not null and resolution_due<=evaluated_at)
      or (not stored and effective_due is not null and effective_due<=evaluated_at),false)
  from evaluated;
$$;
revoke all on function public.evaluate_work_order_sla_v1(text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.evaluate_work_order_sla_v1(text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)
  to authenticated,service_role;

-- Explicit effective definitions: only the navigation breach predicate,
-- sortable-page overdue/due expressions, and original-page due expression differ.
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
      coalesce(activity.pending_7eleven_sync_count, 0)
        as pending_7eleven_sync_count,
      coalesce(activity.pending_contractor_attention_count, 0)
        as pending_contractor_attention_count,
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
      where annotated.priority::text = 'p1'
        and annotated.status::text = 'unassigned'
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
        and (select effective_sla.breached from public.evaluate_work_order_sla_v1(
              annotated.priority::text, annotated.dispatched_at,
              annotated.response_breach_at, annotated.resolution_breach_at,
              annotated.start_time, now()
            ) effective_sla)
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
        and public.contractor_invoicing_is_complete(annotated.id)
    ),
    'sevenElevenUpdateCount', coalesce(sum(
      annotated.pending_7eleven_sync_count
    ) filter (where annotated.status::text <> 'closed'), 0),
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
          and (select effective_sla.breached from public.evaluate_work_order_sla_v1(
              work_order.priority::text, work_order.dispatched_at,
              work_order.response_breach_at, work_order.resolution_breach_at,
              work_order.start_time, now()
            ) effective_sla)
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
      ) as pending_7eleven_sync_count,
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
      coalesce(summary.pending_7eleven_sync_count, 0)::bigint
        as _pending_7eleven_sync_count,
      coalesce(summary.pending_contractor_attention_count, 0)::bigint
        as _pending_contractor_attention_count,
      case work_order.priority::text
        when 'p1' then 1 when 'p2' then 2 when 'p3' then 3
        when 'p4' then 4 when 'p5' then 5 else 99
      end as _priority_rank,
      coalesce(
        (select effective_sla.due_at from public.evaluate_work_order_sla_v1(
              work_order.priority::text, work_order.dispatched_at,
              work_order.response_breach_at, work_order.resolution_breach_at,
              work_order.start_time, now()
            ) effective_sla),
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
        when 'dashboard_seven_eleven_updates' then
          coalesce(summary.pending_7eleven_sync_count, 0) > 0
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
        else true
      end
    )
      and (not p_needs_action
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
        (select effective_sla.due_at from public.evaluate_work_order_sla_v1(
              work_order.priority::text, work_order.dispatched_at,
              work_order.response_breach_at, work_order.resolution_breach_at,
              work_order.start_time, now()
            ) effective_sla),
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

revoke all on function public.get_portal_navigation_summary() from public,anon;
grant execute on function public.get_portal_navigation_summary() to authenticated,service_role;
revoke all on function public.list_work_orders_table_page(
  text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],
  text,text,text,text,text,text,text,date,date,text
) from public,anon;
grant execute on function public.list_work_orders_table_page(
  text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],
  text,text,text,text,text,text,text,date,date,text
) to authenticated,service_role;
revoke all on function public.list_work_orders_page(
  text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[]
) from public,anon;
grant execute on function public.list_work_orders_page(
  text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[]
) to authenticated,service_role;
commit;

