-- Shared staff acknowledgement for new work-order notes. A single timestamp
-- is intentional: once any staff member opens the WO, the queue is cleared
-- for everyone so two people do not work the same update.

alter table public.work_orders
  add column if not exists staff_notes_seen_at timestamptz;

create index if not exists idx_activities_work_order_notes
  on public.activities(work_order_id, created_at desc)
  where type = 'note' and deleted_at is null;

create or replace function public.protect_staff_note_read_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.staff_notes_seen_at is distinct from old.staff_notes_seen_at
     and auth.uid() is not null
     and not public.is_staff() then
    raise exception 'Only staff can acknowledge work-order notes';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_staff_note_read_state_trigger
  on public.work_orders;

create trigger protect_staff_note_read_state_trigger
  before update of staff_notes_seen_at on public.work_orders
  for each row execute function public.protect_staff_note_read_state();
