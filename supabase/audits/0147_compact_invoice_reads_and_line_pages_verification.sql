-- Read-only catalog verification for Batch 4B.1. No customer rows are read or
-- returned. Synthetic authorization, financial parity, every-line traversal,
-- revision races, payload bytes, and role-equivalent plans belong to the
-- isolated closeout harness; catalog checks are not PostgREST/JWT proof.
with expected(signature) as (values
  ('public.list_contractor_invoices_rows_v2(text,text,text,text,integer,text,text)'),
  ('public.list_staff_invoices_rows_v2(text,text,text,text,integer,text,text)'),
  ('public.get_invoice_summary_v1(uuid)'),
  ('public.list_invoice_lines_page_v1(uuid,integer,text,bigint)'),
  ('public.get_invoice_source_summaries_v1(uuid[])'),
  ('public.get_work_order_invoice_part_hints_v1(text,uuid[])')
), contracts as (
  select expected.signature,p.oid,p.prosecdef,p.provolatile,p.proconfig,p.prosrc
  from expected left join pg_proc p on p.oid=to_regprocedure(expected.signature)
), private_contracts as (
  select p.* from pg_proc p where p.pronamespace=to_regnamespace('p1_invoice_reads')
), checks as (
  select
    (select count(oid)=6 from contracts) all_public_contracts_present,
    (select bool_and(not prosecdef and provolatile='s'
      and proconfig @> array['search_path=pg_catalog, public']) from contracts) invoker_paths_pinned,
    (select bool_and(not has_function_privilege('anon',oid,'EXECUTE')
      and has_function_privilege('authenticated',oid,'EXECUTE')
      and has_function_privilege('service_role',oid,'EXECUTE')) from contracts) intended_grants_only,
    (select count(*)=5 and bool_and(not prosecdef and provolatile in ('s','i')
      and proconfig @> array['search_path=pg_catalog, public']
      and not has_function_privilege('anon',oid,'EXECUTE')) from private_contracts) private_contracts_restricted,
    not has_schema_privilege('anon','p1_invoice_reads','USAGE') private_schema_anonymous_blocked,
    (select count(*)=7 from pg_proc where pronamespace='p1_read_contracts'::regnamespace
      and proname<>'validate_v1') prior_count_helpers_preserved,
    (select count(*)=2 and bool_and(prosrc not like '%''totalCount''%'
      and prosrc not like '%jsonb_agg(to_jsonb(line)%' and prosrc not like '%invoice_uploaded%'
      and prosrc like '%payload_bytes<=204800%'
      and prosrc like '%page_size + 1%')
      from private_contracts where proname in ('contractor_rows_v2','staff_rows_v2')) bounded_compact_pages,
    (select bool_and(prosrc like '%p1_read_contracts.validate_v1%'
      and prosrc like '%assert_json_budget_v1%') from contracts
      where signature like '%invoices_rows_v2%') public_page_validation_present,
    (select prosrc like '%v_limit not between 1 and 100%'
      and prosrc like '%limit v_limit+1%'
      and prosrc like '%order by line.position,line.id%'
      and prosrc like '%payload_bytes<=204800%'
      and prosrc like '%p_expected_version is null%'
      and prosrc like '%STALE_VERSION%'
      and prosrc like '%invoice_version%'
      and prosrc like '%PAYLOAD_TOO_LARGE%'
      and prosrc not like '%totalCount%'
      from contracts where signature like '%list_invoice_lines_page_v1%') bounded_versioned_line_pages,
    (select prosrc like '%line_type_summary%'
      and prosrc like '%source_count%'
      and prosrc like '%limit 101%'
      and prosrc like '%v_source_count>100%'
      and prosrc like '%v_invoice.subtotal%'
      and prosrc like '%assert_json_budget_v1%'
      and prosrc not like '%tax_jurisdiction_snapshot%'
      and prosrc not like '%jsonb_agg(to_jsonb(line)%'
      from contracts where signature like '%get_invoice_summary_v1%') compact_financial_header,
    (select prosrc like '%cardinality(p_part_ids)>1000%'
      and prosrc like '%part.work_order_id=p_work_order_id%'
      and prosrc like '%invoice.work_order_id=p_work_order_id%'
      and prosrc like '%billedPartIds%'
      and prosrc not like '%jsonb_agg(line%'
      from contracts where signature like '%part_hints_v1%') bounded_part_presence_projection,
    (select prosrc like '%cardinality(p_invoice_ids)>100%'
      and prosrc like '%authorized as materialized%'
      and prosrc like '%group by line.invoice_id%'
      and prosrc not like '%get_invoice_summary_v1%'
      and prosrc not like '%jsonb_agg(line%'
      from contracts where signature like '%get_invoice_source_summaries_v1%') bounded_set_based_source_summaries,
    (select prosrc like '%octet_length(p_value::text)>204800%'
      and prosrc like '%PAYLOAD_TOO_LARGE%' from private_contracts
      where proname='assert_json_budget_v1') uncompressed_json_budget_enforced,
    (select prosrc like '%rejection_reason%' from private_contracts
      where proname='list_projection_v1') visible_rejection_reason_preserved,
    to_regprocedure('public.list_contractor_invoices_page(text,text,text,text,integer,text,text)') is not null
      and to_regprocedure('public.list_contractor_invoices_rows_v1(text,text,text,text,integer,text,text)') is not null
      and to_regprocedure('public.list_staff_invoices_page(text,text,text,text,integer,text,text)') is not null
      and to_regprocedure('public.list_staff_invoices_rows_v1(text,text,text,text,integer,text,text)') is not null
      and to_regprocedure('public.count_contractor_invoices_v1(text,text,text)') is not null
      and to_regprocedure('public.count_staff_invoices_v1(text,text,text)') is not null legacy_and_count_functions_present,
    (select bool_and(not (prosrc ~* '\m(insert|update|delete|execute)\s+(into|from|public\.|format\()'))
      from contracts) public_reads_do_not_mutate,
    exists(select 1 from pg_index where indexrelid=to_regclass('public.idx_line_inv')
      and indisvalid) existing_line_index_present
)
select checks.*,
  all_public_contracts_present and invoker_paths_pinned and intended_grants_only
  and private_contracts_restricted and private_schema_anonymous_blocked
  and prior_count_helpers_preserved and bounded_compact_pages and public_page_validation_present
  and bounded_versioned_line_pages and compact_financial_header
  and bounded_part_presence_projection and bounded_set_based_source_summaries and uncompressed_json_budget_enforced
  and visible_rejection_reason_preserved
  and legacy_and_count_functions_present and public_reads_do_not_mutate
  and existing_line_index_present as all_checks_pass
from checks;
