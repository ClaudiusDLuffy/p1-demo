-- Keep portal list badges exact without transferring every activity row.
-- Full timelines are loaded separately for the work order a user opens.

begin;

create or replace function public.get_work_order_activity_summaries()
returns table (
  work_order_id text,
  latest_note_at timestamptz,
  latest_contractor_activity_at timestamptz,
  pending_7eleven_sync_count bigint,
  pending_contractor_attention_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    activity.work_order_id,
    max(activity.created_at) filter (
      where activity.type = 'note'
    ) as latest_note_at,
    max(activity.created_at) filter (
      where activity.entered_by_role = 'contractor'
    ) as latest_contractor_activity_at,
    count(*) filter (
      where activity.requires_7eleven_sync = true
        and activity.synced_to_7eleven_at is null
    ) as pending_7eleven_sync_count,
    count(*) filter (
      where activity.requires_contractor_attention = true
        and activity.contractor_attention_acknowledged_at is null
    ) as pending_contractor_attention_count
  from public.activities activity
  where activity.deleted_at is null
  group by activity.work_order_id;
$$;

revoke all on function public.get_work_order_activity_summaries()
  from public, anon;
grant execute on function public.get_work_order_activity_summaries()
  to authenticated, service_role;

commit;
