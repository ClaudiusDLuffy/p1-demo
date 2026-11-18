-- Additive read-only NTE queue. Existing row/count contracts and business data
-- are untouched. Filter the same invoice marker as the brown Work orders dot
-- BEFORE ordering, cursor pagination and exact counts; EXISTS avoids duplicates.
begin;

do $nte_reads$
declare
  spec record; source record; wrapper record; body text; wrapper_body text;
  before_text constant text := 'where work_order.deleted_at is null';
  after_text constant text := $predicate$where work_order.deleted_at is null
      and (select public.is_staff())
      and exists (
        select 1 from public.staff_invoice_nte_wait_flags nte_flag
        join public.invoices nte_invoice on nte_invoice.id = nte_flag.invoice_id
        where nte_invoice.work_order_id = work_order.id
          and nte_flag.waiting_on_nte_approval = true
      )$predicate$;
begin
  -- Closed migration-time allowlist of the reviewed helpers through 0183.
  -- No runtime dynamic SQL, new grants on tables, mutations, or RLS bypass.
  for spec in select * from (values
    ('p1_read_contracts', 'work_orders_v1', 'work_orders_nte_v1',
      'a139955a8551c7d13b03db031b155023', 2,
      'list_work_orders_rows_v1', 'count_work_orders_v1',
      'list_work_orders_nte_rows_v1', 'count_work_orders_nte_v1'),
    ('p1_portal_reads', 'work_orders_table_v2', 'work_orders_nte_table_v1',
      'e02f595f2bca56a2a5999a260592ef5c', 1,
      'list_work_orders_table_rows_v2', 'count_work_orders_table_v2',
      'list_work_orders_nte_table_rows_v1', 'count_work_orders_nte_table_v1')
  ) s(schema_name, helper, new_helper, body_md5, predicate_count,
      row_name, count_name, new_row_name, new_count_name) loop
    select p.*, l.lanname, pg_get_function_arguments(p.oid) arguments,
      pg_get_function_identity_arguments(p.oid) identity_arguments
      into strict source
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname = spec.schema_name and p.proname = spec.helper;
    body := replace(source.prosrc, chr(13), '');
    if source.prosecdef or source.provolatile <> 's' or source.lanname <> 'sql'
      or md5(body) <> spec.body_md5
      or (length(body) - length(replace(body, before_text, ''))) / length(before_text)
        <> spec.predicate_count then
      raise exception 'Reviewed NTE read source changed: %.%', spec.schema_name, spec.helper;
    end if;
    body := replace(body, before_text, after_text);
    execute format('create function %I.%I(%s) returns jsonb language sql stable
      security invoker set search_path=pg_catalog,public as %L',
      spec.schema_name, spec.new_helper, source.arguments, body);
    execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',
      spec.schema_name, spec.new_helper, source.identity_arguments);
    execute format('grant execute on function %I.%I(%s) to authenticated,service_role',
      spec.schema_name, spec.new_helper, source.identity_arguments);

    for wrapper in select p.*, l.lanname,
      pg_get_function_arguments(p.oid) arguments,
      pg_get_function_identity_arguments(p.oid) identity_arguments,
      case p.proname when spec.row_name then spec.new_row_name else spec.new_count_name end new_name
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.pronamespace = 'public'::regnamespace
        and p.proname in (spec.row_name, spec.count_name) loop
      if wrapper.prosecdef or wrapper.provolatile <> 's' or wrapper.lanname <> 'plpgsql' then
        raise exception 'Reviewed NTE wrapper changed: %', wrapper.proname;
      end if;
      wrapper_body := replace(wrapper.prosrc,
        spec.schema_name || '.' || spec.helper || '(',
        spec.schema_name || '.' || spec.new_helper || '(');
      if wrapper_body = wrapper.prosrc or wrapper_body not like 'begin %' then
        raise exception 'NTE wrapper transformation failed: %', wrapper.proname;
      end if;
      wrapper_body := 'begin if not coalesce((select public.is_staff()),false) then '
        || 'raise exception using errcode=''42501'',message=''Staff access required''; end if; '
        || substring(wrapper_body from 7);
      execute format('create function public.%I(%s) returns jsonb language plpgsql stable
        security invoker set search_path=pg_catalog,public as %L',
        wrapper.new_name, wrapper.arguments, wrapper_body);
      execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',
        wrapper.new_name, wrapper.identity_arguments);
      execute format('grant execute on function public.%I(%s) to authenticated',
        wrapper.new_name, wrapper.identity_arguments);
    end loop;
    if not exists (select 1 from pg_proc where pronamespace='public'::regnamespace
      and proname=spec.new_row_name) or not exists (select 1 from pg_proc
      where pronamespace='public'::regnamespace and proname=spec.new_count_name) then
      raise exception 'Missing NTE row/count pair';
    end if;
  end loop;
end;
$nte_reads$;

notify pgrst, 'reload schema';
commit;
