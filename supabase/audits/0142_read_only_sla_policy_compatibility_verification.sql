-- Read-only Batch 3D SLA projection audit. Catalog identifiers and counts only.
-- No policy approval, deadline derivation write, historical backfill or repair.
select p.proname,p.oid::regprocedure::text as function_signature,
  not p.prosecdef as invoker_preserved,
  p.provolatile=case when p.proname='evaluate_work_order_sla_v1' then 'i'::"char" else 's'::"char" end as expected_volatility,
  coalesce(p.proconfig @> array[case when p.proname='evaluate_work_order_sla_v1'
    then 'search_path=pg_catalog, public' else 'search_path=public, pg_temp' end],false) as pinned_search_path,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute,
  md5(pg_get_functiondef(p.oid)) as definition_fingerprint
from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in (
  'evaluate_work_order_sla_v1','get_portal_navigation_summary','list_work_orders_table_page','list_work_orders_page')
order by p.proname;

select count(*)=3 as all_live_sla_reads_use_helper,
  bool_and(position('public.evaluate_work_order_sla_v1(' in pg_get_functiondef(p.oid))>0) as canonical_helper_wired,
  bool_and(position('clock_timestamp()' in pg_get_functiondef(p.oid))=0) as transaction_stable_evaluation_clock,
  bool_and(not p.prosecdef) as rls_invoker_preserved
from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in (
  'get_portal_navigation_summary','list_work_orders_table_page','list_work_orders_page');

select count(*) filter(where response_breach_at is not null or resolution_breach_at is not null) as stored_deadline_rows,
  count(*) filter(where (response_breach_at is null)<>(resolution_breach_at is null)) as stored_partial_rows,
  count(*) filter(where response_breach_at is null and resolution_breach_at is null and dispatched_at is not null) as legacy_dispatch_candidates,
  count(*) filter(where (response_breach_at is not null and not isfinite(response_breach_at))
    or (resolution_breach_at is not null and not isfinite(resolution_breach_at))) as nonfinite_stored_deadlines_require_review,
  'Compatibility values only; owner SLA approval remains required. Stored deadlines and anchors are not modified.'::text as policy_status
from public.work_orders;

select p.proname,
  position('page_size + 1' in pg_get_functiondef(p.oid))>0 as bounded_page_continuation,
  position('portal_encode_cursor' in pg_get_functiondef(p.oid))>0 as existing_cursor_encoder,
  position('portal_decode_cursor' in pg_get_functiondef(p.oid))>0 as existing_cursor_decoder,
  position('totalCount' in pg_get_functiondef(p.oid))>0 as existing_count_contract
from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('list_work_orders_page','list_work_orders_table_page');
