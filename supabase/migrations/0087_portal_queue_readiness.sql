-- Make every compact navigation/detail projection use the same readiness
-- rules as the dashboard: 7-Eleven follow-up starts only after field
-- completion, and Ready to Bill waits for the contractor's current invoice
-- set to be explicitly complete.

begin;

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
      'pending_7eleven_sync_count', case
        when work_order.functional_status::text = 'Completed'
          or work_order.status::text = 'closed'
        then coalesce(summary.raw_pending_7eleven_sync_count, 0)
        else 0
      end,
      'pending_contractor_attention_count',
        coalesce(summary.pending_contractor_attention_count, 0),
      'afm_email', coalesce(afm.afm_email, work_order.afm_email),
      'nte', coalesce(financial.nte, work_order.nte),
      'nte_flag_threshold', coalesce(
        financial.nte_flag_threshold,
        work_order.nte_flag_threshold
      ),
      'nte_flagged', coalesce(
        financial.nte_flagged,
        work_order.nte_flagged,
        false
      ),
      'nte_flag_amount', coalesce(
        financial.nte_flag_amount,
        work_order.nte_flag_amount
      ),
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
        where activity.requires_7eleven_sync
          and activity.synced_to_7eleven_at is null
      ) as raw_pending_7eleven_sync_count,
      count(*) filter (
        where activity.requires_contractor_attention
          and activity.contractor_attention_acknowledged_at is null
      ) as pending_contractor_attention_count
    from public.activities activity
    where activity.work_order_id = work_order.id
      and activity.deleted_at is null
  ) summary on true
  left join lateral (
    select jsonb_agg(
      to_jsonb(assignment)
      order by assignment.assignment_ended_at desc, assignment.id desc
    ) as rows
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
      ) as raw_pending_7eleven_sync_count,
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
      case
        when work_order.functional_status::text = 'Completed'
          or work_order.status::text = 'closed'
        then coalesce(activity.raw_pending_7eleven_sync_count, 0)
        else 0
      end as pending_7eleven_sync_count,
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
        and public.contractor_invoicing_is_complete(annotated.id)
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

revoke all on function public.get_portal_work_order(text) from public, anon;
revoke all on function public.get_portal_navigation_summary() from public, anon;
grant execute on function public.get_portal_work_order(text)
  to authenticated, service_role;
grant execute on function public.get_portal_navigation_summary()
  to authenticated, service_role;

commit;
