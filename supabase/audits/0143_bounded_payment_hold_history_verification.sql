-- Read-only promotion checks. Catalog booleans and aggregate counts only:
-- no names, addresses, contacts, reasons, invoice numbers, amounts or cursors.
-- This file does not place/release holds, repair records, send notifications,
-- change invoice/export/SLA state, or call an external service.
with target as (
  select p.*, pg_get_functiondef(p.oid) as definition from pg_proc p
    where p.oid = to_regprocedure('public.list_contractor_invoice_payment_holds_page_v1(integer,text)')
), checks as (
  select count(*) = 1 as rpc_present,
    coalesce(bool_and(prosecdef and provolatile = 's'), false) as stable_security_definer,
    coalesce(bool_and(proconfig @> array['search_path=pg_catalog, public']), false) as pinned_search_path,
    coalesce(bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')
      and not has_function_privilege('anon', oid, 'EXECUTE')
      and not has_function_privilege('service_role', oid, 'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE')), false) as authenticated_only,
    coalesce(bool_and(position('p_limit not between 1 and 100' in definition) > 0
      and position('limit p_limit + 1' in definition) > 0), false) as strict_bounded_probe,
    coalesce(bool_and(position('(h.placed_at, h.invoice_id) < (v_at, v_id)' in definition) > 0
      and position('order by h.placed_at desc, h.invoice_id desc' in definition) > 0), false) as tuple_keyset,
    coalesce(bool_and(position('p.active = true' in definition) > 0
      and position('public.staff_permission_grants' in definition) > 0
      and position('v_scope' in definition) > 0
      and position('PDC01' in definition) > 0), false) as current_authorization_and_cursor_binding,
    coalesce(bool_and(position('i.invoice_type = ''contractor'' and i.deleted_at is null' in definition) > 0
      and position('left join public.work_orders' in definition) > 0
      and position('''externalWorkOrderId''' in definition) > 0), false) as legacy_visibility_and_projection
  from target
), existing_index as (
  select exists(select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.contractor_invoice_payment_holds'::regclass
      and c.relname = 'contractor_invoice_payment_holds_placed' and i.indisvalid
      and pg_get_indexdef(i.indexrelid) like '%(placed_at DESC, invoice_id DESC)%') as existing_seek_index
)
select checks.*, existing_index.*,
  rpc_present and stable_security_definer and pinned_search_path and authenticated_only
  and strict_bounded_probe and tuple_keyset and current_authorization_and_cursor_binding
  and legacy_visibility_and_projection and existing_seek_index as all_checks_pass
from checks cross join existing_index;

select count(*) filter(where i.invoice_type = 'contractor' and i.deleted_at is null) as visible_current_holds,
  count(*) filter(where i.invoice_type <> 'contractor' or i.deleted_at is not null) as excluded_current_holds,
  count(*) filter(where i.invoice_type = 'contractor' and i.deleted_at is null and i.work_order_id is null) as visible_unlinked_holds
from public.contractor_invoice_payment_holds h join public.invoices i on i.id = h.invoice_id;
