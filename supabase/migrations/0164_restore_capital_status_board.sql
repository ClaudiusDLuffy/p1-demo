-- Restore the operational capital status board and exact server-side filters.
-- This is a read-only contract change: no work-order, quote, invoice, billing,
-- or QuickBooks data is modified.
begin;

do $validation$
declare routine record; body text; original text;
begin
  select p.*,pg_get_function_arguments(p.oid) arguments into strict routine
  from pg_proc p where p.oid='p1_read_contracts.validate_v1(text,jsonb)'::regprocedure;
  if routine.prosecdef or routine.provolatile<>'s'
    or encode(sha256(convert_to(replace(routine.prosrc,chr(13),''),'UTF8')),'hex')
      <> 'b3b04d5dfca639ff4c0bf099061151805dbcae87622c6272dacef64162e7df35' then
    raise exception 'Reviewed read validation source changed' using errcode='23514';
  end if;
  original:=replace(routine.prosrc,chr(13),'');
  body:=replace(original,
    'when ''p_status'' then v_allowed:=array[''all'']||enum_range(null::public.wo_status)::text[];',
    'when ''p_status'' then v_allowed:=array[''all'']||enum_range(null::public.wo_status)::text[]
        ||case when p_family in (''work_orders_v1'',''work_orders_table_v1'') then array[
          ''capital_waiting_quote'',''capital_quote_submitted'',''capital_work_authorized'',
          ''capital_equipment_ordered'',''capital_equipment_received'',
          ''capital_installation_scheduled'',''capital_installed''] else array[]::text[] end;');
  if body=original or position('capital_waiting_quote' in body)=0 then
    raise exception 'Read validation transformation incomplete' using errcode='23514';
  end if;
  execute format('create or replace function p1_read_contracts.validate_v1(%s) returns void
    language plpgsql stable security invoker set search_path=pg_catalog,public as %L',routine.arguments,body);
end;
$validation$;

do $capital_reads$
declare spec record; routine record; body text; original text; old_scope text; new_scope text;
  old_status constant text := 'and (p_status is null or p_status = ''all'' or work_order.status::text = p_status)';
  new_status constant text := $filter$and case
        when p_status is null or p_status = 'all' then true
        when p_status = 'capital_waiting_quote' then
          (coalesce(work_order.is_capital,false) or work_order.status::text in ('capital','pending_capital_completion'))
          and work_order.capital_status is null and work_order.status::text <> 'pending_capital_completion'
        when p_status = 'capital_quote_submitted' then
          (coalesce(work_order.is_capital,false) or work_order.status::text in ('capital','pending_capital_completion'))
          and (work_order.capital_status::text = 'Pending approval'
            or (work_order.status::text = 'pending_capital_completion' and work_order.capital_status is null))
        when p_status = 'capital_work_authorized' then work_order.capital_status::text = 'Approved - work authorized'
        when p_status = 'capital_equipment_ordered' then work_order.capital_status::text = 'Equipment ordered'
        when p_status = 'capital_equipment_received' then work_order.capital_status::text = 'Equipment received'
        when p_status = 'capital_installation_scheduled' then work_order.capital_status::text = 'Installation scheduled'
        when p_status = 'capital_installed' then work_order.capital_status::text = 'Installed'
        else work_order.status::text = p_status
      end$filter$;
begin
  for spec in select * from (values
    ('p1_read_contracts','work_orders_v1','60a40566efdb8e42fd8a453d0b9dc03e9ff53f69d60bc61984d49cbeecc11af2',
      E'when ''capital'' then work_order.status::text in (''capital'', ''pending_capital_completion'')'),
    ('p1_portal_reads','work_orders_table_v2','bc26c1fbcbe925ac3d04c17fb5d042e2d73c7d7af7341ab577c72cc025895a30',
      E'when ''capital'' then work_order.status::text in (\n          ''capital'', ''pending_capital_completion''\n        )')
  ) value(schema_name,function_name,source_hash,scope_source)
  loop
    select p.*,pg_get_function_arguments(p.oid) arguments into strict routine
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=spec.schema_name and p.proname=spec.function_name;
    if routine.prosecdef or routine.provolatile<>'s'
      or encode(sha256(convert_to(replace(routine.prosrc,chr(13),''),'UTF8')),'hex')<>spec.source_hash then
      raise exception 'Reviewed capital read source changed: %.%',spec.schema_name,spec.function_name using errcode='23514';
    end if;
    original:=replace(routine.prosrc,chr(13),'');
    old_scope:=spec.scope_source;
    new_scope:='when ''capital'' then (coalesce(work_order.is_capital,false)
          or work_order.status::text in (''capital'',''pending_capital_completion''))
          and work_order.status::text <> ''closed''';
    body:=replace(replace(original,old_scope,new_scope),old_status,new_status);
    if body=original or position(old_scope in body)>0 or position(old_status in body)>0
      or position('capital_quote_submitted' in body)=0 then
      raise exception 'Capital read transformation incomplete: %.%',spec.schema_name,spec.function_name using errcode='23514';
    end if;
    execute format('create or replace function %I.%I(%s) returns jsonb
      language sql stable security invoker set search_path=pg_catalog,public as %L',
      spec.schema_name,spec.function_name,routine.arguments,body);
  end loop;
end;
$capital_reads$;

comment on function p1_read_contracts.validate_v1(text,jsonb) is
  'Validates bounded portal reads, including the closed capital-board stage filter vocabulary.';

commit;
