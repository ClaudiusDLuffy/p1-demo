begin;

-- Batch review child operations must be deterministic so an exact retry can
-- reconcile safely, but their receipts also cross the strict browser boundary
-- where operationId is validated as an RFC UUID. Casting a raw MD5 digest to
-- uuid leaves the version nibble arbitrary (often 9-f), so a committed batch
-- was incorrectly reported to the user as unconfirmed. Stamp the deterministic
-- digest as version 5 / RFC variant 8 before delegating each child operation.
create or replace function public.review_contractor_invoices_with_notification_v1(
  p_invoice_ids uuid[],
  p_action text,
  p_reason text,
  p_operation_id uuid,
  p_expected_revisions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  a public.profiles%rowtype;
  v_ids uuid[];
  v_id uuid;
  v_child uuid;
  v_child_digest text;
  v_results jsonb := '[]';
  v_result jsonb;
  v_payload jsonb;
  o public.financial_notification_mutation_operations%rowtype;
begin
  a := public.require_financial_notification_actor('invoice_rejected', true);
  select array_agg(distinct x order by x) into v_ids from unnest(p_invoice_ids) x;
  if p_operation_id is null
     or cardinality(v_ids) is null
     or cardinality(v_ids) not between 1 and 100
     or array_position(v_ids, null) is not null
     or jsonb_typeof(p_expected_revisions) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_expected_revisions)) <> cardinality(v_ids) then
    raise exception 'VALIDATION_FAILED' using errcode = 'PT422';
  end if;

  v_payload := jsonb_build_object(
    'ids', v_ids,
    'action', lower(btrim(p_action)),
    'reason', nullif(btrim(p_reason), ''),
    'revisions', p_expected_revisions
  );
  perform pg_advisory_xact_lock(hashtextextended('financial-notification-operation:' || p_operation_id, 0));
  select * into o
  from public.financial_notification_mutation_operations
  where operation_id = p_operation_id;
  if found then
    if o.actor_id <> a.id or o.command_kind <> 'batch_review' or o.payload <> v_payload then
      raise exception 'OPERATION_REUSED' using errcode = 'PT409';
    end if;
    return o.result || jsonb_build_object('replayed', true);
  end if;
  if exists(select 1 from public.financial_notification_operations where operation_id = p_operation_id) then
    raise exception 'OPERATION_REUSED' using errcode = 'PT409';
  end if;

  perform 1
  from public.work_orders w
  where w.id in (select i.work_order_id from public.invoices i where i.id = any(v_ids))
  order by w.id
  for update;
  perform 1 from public.invoices where id = any(v_ids) order by id for update;
  perform public.financial_notification_cap('financial_notification_mutation_operations', p_operation_id);
  insert into public.financial_notification_mutation_operations(operation_id, actor_id, command_kind, payload)
  values (p_operation_id, a.id, 'batch_review', v_payload);

  foreach v_id in array v_ids loop
    if coalesce(p_expected_revisions ->> v_id::text, '') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'VALIDATION_FAILED' using errcode = 'PT422';
    end if;
    v_child_digest := md5(p_operation_id::text || ':' || v_id::text);
    v_child := (
      substr(v_child_digest, 1, 8) || '-' ||
      substr(v_child_digest, 9, 4) || '-5' ||
      substr(v_child_digest, 14, 3) || '-8' ||
      substr(v_child_digest, 18, 3) || '-' ||
      substr(v_child_digest, 21, 12)
    )::uuid;
    v_result := public.review_contractor_invoice_with_notification_v1(
      v_id,
      p_action,
      p_reason,
      v_child,
      (p_expected_revisions ->> v_id::text)::integer
    );
    v_results := v_results || jsonb_build_array(v_result);
  end loop;

  v_result := jsonb_build_object(
    'action', lower(btrim(p_action)),
    'count', cardinality(v_ids),
    'invoiceIds', v_ids,
    'results', v_results,
    'operationId', p_operation_id,
    'replayed', false
  );
  perform public.financial_notification_cap('financial_notification_mutation_operations', p_operation_id);
  update public.financial_notification_mutation_operations
  set result = v_result
  where operation_id = p_operation_id;
  perform public.financial_notification_clear_caps();
  return v_result;
end;
$$;

commit;
