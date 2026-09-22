-- Run after migration 0164 and the local synthetic seed. Rolls back its test.
begin;
do $test$
declare page jsonb; ids text[];
begin
  page:=public.list_work_orders_rows_v1(p_scope=>'capital',p_status=>'capital_quote_submitted',p_limit=>100);
  select array_agg(item->>'id') into ids from jsonb_array_elements(page->'items') item;
  if not ('E2E-CAPITAL-BOARD-SUBMITTED'=any(coalesce(ids,array[]::text[])))
    or 'E2E-CAPITAL-BOARD-ORDERED'=any(coalesce(ids,array[]::text[])) then
    raise exception 'Submitted capital stage filter returned the wrong rows';
  end if;
  page:=public.list_work_orders_table_rows_v2(p_scope=>'capital',p_status=>'capital_equipment_ordered',p_limit=>100);
  select array_agg(item->>'id') into ids from jsonb_array_elements(page->'items') item;
  if not ('E2E-CAPITAL-BOARD-ORDERED'=any(coalesce(ids,array[]::text[])))
    or 'E2E-CAPITAL-BOARD-SUBMITTED'=any(coalesce(ids,array[]::text[])) then
    raise exception 'Ordered capital stage filter returned the wrong rows';
  end if;
  if not exists(select 1 from jsonb_array_elements(
      public.list_work_orders_rows_v1(p_scope=>'capital',p_limit=>100)->'items') item
      where item->>'id'='E2E-CAPITAL-BOARD-ORDERED') then
    raise exception 'Operational is_capital row is missing from capital scope';
  end if;
end;
$test$;
rollback;
select 'PASS_CAPITAL_STATUS_BOARD' as test_status;
