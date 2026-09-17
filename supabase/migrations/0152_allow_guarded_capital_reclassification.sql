-- A completed work order may be deliberately reclassified for capital quote
-- preparation by flag_work_order_capital_v1. That command already creates a
-- transaction-local lifecycle capability; the older reopen trigger must honor
-- only that exact capability instead of treating the transition as an
-- unauthorized completion regression.
begin;

create or replace function public.prevent_direct_work_order_reopen()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guarded boolean := false;
  v_capital_guarded boolean := false;
  v_reverses_completion boolean := false;
begin
  v_reverses_completion := old.functional_status::text = 'Completed'
    and new.functional_status::text is distinct from 'Completed';

  if new.workflow_cycle is not distinct from old.workflow_cycle
     and not (
       old.status = 'closed'
       and new.status <> 'closed'
     )
     and not v_reverses_completion then
    return new;
  end if;

  if coalesce(auth.role(), '') in ('service_role', '') then
    return new;
  end if;

  select exists (
    select 1
    from public.work_order_reopen_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.work_order_id = new.id
      and transition_guard.actor_id = auth.uid()
  ) into v_guarded;

  select exists (
    select 1
    from public.work_order_lifecycle_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.work_order_id = new.id
      and transition_guard.actor_id = auth.uid()
      and transition_guard.command_kind = 'capital_flag'
      and transition_guard.parent_allowed
  ) into v_capital_guarded;

  if new.workflow_cycle is distinct from old.workflow_cycle
     and not v_guarded then
    raise exception 'Work-order workflow cycle can only change during reopen'
      using errcode = '42501';
  end if;

  if old.status = 'closed'
     and new.status <> 'closed'
     and not v_guarded then
    raise exception 'Closed work orders must be reopened through the reopen workflow'
      using errcode = '42501';
  end if;

  if v_reverses_completion
     and not v_guarded
     and not v_capital_guarded then
    raise exception 'Completed field work must be reopened before its status can regress'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_direct_work_order_reopen()
  from public, anon, authenticated, service_role;

commit;
