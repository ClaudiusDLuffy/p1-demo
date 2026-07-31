-- Existing notes predate the read-state feature. Baseline them as seen so
-- only activity arriving after this rollout appears in the action queue.
with latest_existing_note as (
  select
    work_order_id,
    max(created_at) as latest_note_at
  from public.activities
  where type = 'note'
    and deleted_at is null
  group by work_order_id
)
update public.work_orders as work_order
set staff_notes_seen_at = latest_existing_note.latest_note_at
from latest_existing_note
where work_order.id = latest_existing_note.work_order_id
  and work_order.staff_notes_seen_at is null;
