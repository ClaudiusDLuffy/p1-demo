-- Let staff approve or reject a reviewed set of contractor invoices in one
-- transaction. Every invoice still uses the guarded, per-invoice lifecycle
-- from 0060/0061, so audit entries and work-order status stay independent and
-- honest while the batch itself remains all-or-nothing.

begin;

do $preflight$
declare
  review_function regprocedure := to_regprocedure(
    'public.review_contractor_invoice(uuid,text,text)'
  );
begin
  if review_function is null then
    raise exception
      'Run 0061_fix_invoice_review_work_order_alias.sql before migration 0062';
  end if;

  if position(
       'target_work_order' in lower(pg_get_functiondef(review_function))
     ) = 0 then
    raise exception
      'Run 0061_fix_invoice_review_work_order_alias.sql before migration 0062';
  end if;
end
$preflight$;

create or replace function public.review_contractor_invoices(
  p_invoice_ids uuid[],
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  action_name text := lower(trim(coalesce(p_action, '')));
  reason_text text := nullif(trim(coalesce(p_reason, '')), '');
  normalized_ids uuid[];
  requested_count integer;
  matched_count integer;
  invoice_id uuid;
  review_result jsonb;
  review_results jsonb := '[]'::jsonb;
begin
  if actor_id is null
     or not public.is_staff()
     or public.is_invoice_controller() then
    raise exception 'Staff invoice-review access is required'
      using errcode = '42501';
  end if;

  if action_name not in ('approve', 'reject') then
    raise exception 'Review action must be approve or reject'
      using errcode = '22023';
  end if;

  if action_name = 'reject' and reason_text is null then
    raise exception 'A rejection reason is required'
      using errcode = '22023';
  end if;

  select
    array_agg(requested.invoice_id order by requested.invoice_id),
    count(*)::integer
  into normalized_ids, requested_count
  from (
    select distinct candidate.invoice_id
    from unnest(coalesce(p_invoice_ids, '{}'::uuid[]))
      as candidate(invoice_id)
    where candidate.invoice_id is not null
  ) requested;

  if requested_count is null or requested_count = 0 then
    raise exception 'Select at least one invoice'
      using errcode = '22023';
  end if;

  if requested_count > 100 then
    raise exception 'A batch can contain at most 100 invoices'
      using errcode = '22023';
  end if;

  -- Lock the complete input set first, in stable order. This prevents two
  -- concurrent batch reviews from interleaving a partially reviewed set.
  perform 1
  from public.invoices candidate
  where candidate.id = any(normalized_ids)
  order by candidate.id
  for update;

  select count(*)::integer
  into matched_count
  from public.invoices candidate
  where candidate.id = any(normalized_ids)
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null
    and candidate.state in ('submitted', 'revised');

  if matched_count <> requested_count then
    raise exception
      'One or more selected invoices are missing or no longer awaiting review'
      using errcode = '40001';
  end if;

  -- Work-order locks also use stable ordering. The single-invoice function
  -- reuses these locks and recomputes each affected work order after every
  -- decision; the final state therefore reflects every sibling invoice.
  perform 1
  from public.work_orders target_work_order
  where target_work_order.id in (
    select distinct candidate.work_order_id
    from public.invoices candidate
    where candidate.id = any(normalized_ids)
  )
  order by target_work_order.id
  for update;

  foreach invoice_id in array normalized_ids loop
    review_result := public.review_contractor_invoice(
      invoice_id,
      action_name,
      reason_text
    );
    review_results := review_results || jsonb_build_array(review_result);
  end loop;

  return jsonb_build_object(
    'action', action_name,
    'count', requested_count,
    'invoiceIds', to_jsonb(normalized_ids),
    'results', review_results
  );
end;
$$;

revoke all on function public.review_contractor_invoices(uuid[], text, text)
  from public, anon;

grant execute on function public.review_contractor_invoices(uuid[], text, text)
  to authenticated, service_role;

commit;
