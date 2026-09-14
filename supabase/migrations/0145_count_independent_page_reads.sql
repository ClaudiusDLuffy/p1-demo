-- Batch 4B: additive count-independent read contracts. No business rows,
-- authorization semantics, SLA rule, historical routine, or index is changed.
-- The seven known SQL page bodies supply ONE shared filter definition per
-- family; a read mode selects either bounded rows or the exact authorized
-- count. CASE subqueries not selected are not executed. Legacy functions stay
-- byte-identical for stale clients. Catalog generation happens only here,
-- under the migration owner, from a closed signature/hash allowlist. There is
-- no runtime dynamic SQL and no caller-selected relation/column/function.
begin;

do $prerequisite$
begin
  if to_regprocedure('public.list_directory_page_v1(text,text,uuid,integer,text)') is null then
    raise exception 'Apply the complete schema through 0143 before 0144';
  end if;
end;
$prerequisite$;

-- A measured 50k-row plan spent ~0.95s repeatedly evaluating the same staff
-- eligibility inside the existing row-dependent visibility helper. Its first
-- disjunct is is_staff(); A OR (A OR B) = A OR B. Hoist only A to an InitPlan;
-- keep the complete existing contractor/company/technician B helper intact.
-- No role, command, permissiveness, helper definition, or other policy changes.
do $staff_initplan$
declare v_policy record;v_helper record;
begin
  select p.*,pg_get_expr(p.polqual,p.polrelid) expression into strict v_policy
    from pg_policy p where p.polrelid='public.work_orders'::regclass and p.polname='wo_read';
  select p.*,l.lanname into strict v_helper from pg_proc p join pg_language l on l.oid=p.prolang
    where p.oid='public.can_access_contractor_work_order(text)'::regprocedure;
  if v_policy.polcmd<>'r' or not v_policy.polpermissive or v_policy.polroles<>array[0::oid]
    or v_policy.expression<>'can_access_contractor_work_order(id)'
    or v_helper.lanname<>'sql' or not v_helper.prosecdef or v_helper.provolatile<>'s'
    or btrim(regexp_replace(v_helper.prosrc,'[[:space:]]+',' ','g')) not like 'select public.is_staff() or exists (%'
    or not exists(select 1 from pg_proc where oid='public.is_staff()'::regprocedure and provolatile='s') then
    raise exception 'Work-order read authorization shape drifted; review before InitPlan optimization';
  end if;
end;
$staff_initplan$;
alter policy wo_read on public.work_orders
  using ((select public.is_staff()) or public.can_access_contractor_work_order(id));

create schema p1_read_contracts;
revoke all on schema p1_read_contracts from public,anon,authenticated,service_role;
grant usage on schema p1_read_contracts to authenticated,service_role;

-- Validation is additive for the new public contracts only. Legacy callers
-- retain their existing permissive defaults; unknown new filters cannot
-- silently fall through to a wider result set. Text search remains contains
-- search with the same SQL semantics, but is now byte/control bounded.
create function p1_read_contracts.validate_v1(p_family text,p_args jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_key text;v_value jsonb;v_text text;v_allowed text[];
begin
  if p_family not in ('work_orders_v1','work_orders_table_v1','work_order_activities_v1',
    'work_order_photos_v1','work_order_visits_v1','contractor_invoices_v1','staff_invoices_v1')
    or p_args is null or jsonb_typeof(p_args)<>'object' then
    raise exception using errcode='22023',message='INVALID_REQUEST';
  end if;
  for v_key,v_value in select key,value from jsonb_each(p_args) loop
    if v_value='null'::jsonb then continue;end if;
    v_text:=p_args->>v_key;
    if jsonb_typeof(v_value)='string' and (v_text~'[[:cntrl:]]'
      or octet_length(v_text)>case when v_key='p_cursor' then 4096 else 1000 end) then
      raise exception using errcode='22023',message='INVALID_REQUEST';
    end if;
    v_allowed:=null;
    case v_key
      when 'p_limit' then
        if v_text!~'^[0-9]+$' or v_text::numeric not between 1 and 100 then
          raise exception using errcode='22023',message='INVALID_REQUEST';
        end if;
      when 'p_scope' then v_allowed:=array['active','operations','operations_all','history','capital','ready_to_bill','all',
        'staff_work','staff_work_unread','staff_work_todo','staff_work_ready','dashboard_unassigned',
        'dashboard_pending_submission','dashboard_pending_approval','dashboard_awaiting_parts',
        'dashboard_seven_eleven_updates','dashboard_p1_parts_to_order','dashboard_pending_capital_completion'];
      when 'p_sort' then
        v_allowed:=case when p_family='contractor_invoices_v1' then array['recent','invoice','lines','total','work_order','contractor','status','store','date']
          when p_family='staff_invoices_v1' then array['recent','invoice','date','work_order','store','territory','total','status']
          else array['newest','oldest','priority','sla_due'] end;
      when 'p_queue' then v_allowed:=array['active','draft','submitted','sent','work_order','all'];
      when 'p_sort_column' then v_allowed:=array['work_order','status','priority','incident','store','summary','contractor','technician','created','updated','closed','sla'];
      when 'p_direction','p_sort_direction' then v_allowed:=array['asc','desc'];
      when 'p_sla_filter' then v_allowed:=array['all','overdue'];
      when 'p_priority' then v_allowed:=array['all']||enum_range(null::public.wo_priority)::text[];
      when 'p_status' then v_allowed:=array['all']||enum_range(null::public.wo_status)::text[];
      when 'p_state' then
        if p_family='contractor_invoices_v1' then
          v_allowed:=array['all','active']||enum_range(null::public.invoice_state)::text[];
        elsif v_text<>'all' and v_text!~'^[A-Za-z]{2}$' then
          raise exception using errcode='22023',message='INVALID_REQUEST';
        end if;
      when 'p_contractor_ids' then
        if jsonb_typeof(v_value)<>'array' or jsonb_array_length(v_value)>100 then
          raise exception using errcode='22023',message='INVALID_REQUEST';
        end if;
      when 'p_work_order_id' then
        if btrim(v_text)='' then raise exception using errcode='22023',message='INVALID_REQUEST';end if;
      else null;
    end case;
    if v_allowed is not null and not(v_text=any(v_allowed)) then
      raise exception using errcode='22023',message='INVALID_REQUEST';
    end if;
  end loop;
  if p_args->>'p_from' is not null and p_args->>'p_to' is not null
    and (p_args->>'p_from')::date>(p_args->>'p_to')::date then
    raise exception using errcode='22023',message='INVALID_REQUEST';
  end if;
end;
$$;
revoke all on function p1_read_contracts.validate_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function p1_read_contracts.validate_v1(text,jsonb) to authenticated,service_role;

do $read_contracts$
declare
  v_spec record; v_proc record; v_body text; v_arguments text; v_identity text;
  v_count_arguments text; v_count_identity text; v_call text; v_count_call text;
  v_select integer; v_count integer; v_prefix text; v_row_expression text;
  v_count_expression text; v_definition text; v_wrapper text; v_arg text;
  v_activity_start integer; v_activity_end integer; v_activity_body text;
  v_validation text;
begin
  for v_spec in select * from (values
    ('public.list_work_orders_page(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[])',
      '982adfa2bbce7081f834f7271b9edcb8','work_orders_v1','list_work_orders_rows_v1','count_work_orders_v1',false),
    ('public.list_work_orders_table_page(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],text,text,text,text,text,text,text,date,date,text)',
      '98540451455b7742913a58f61137c198','work_orders_table_v1','list_work_orders_table_rows_v1','count_work_orders_table_v1',false),
    ('public.list_work_order_activities_page(text,integer,text)',
      '2c7dd318dd9329c36d4131669f36d33c','work_order_activities_v1','list_work_order_activities_rows_v1','count_work_order_activities_v1',false),
    ('public.list_work_order_photos_page(text,integer,text)',
      '176147e5104d7c1b7d84ff0bb4a46fdb','work_order_photos_v1','list_work_order_photos_rows_v1','count_work_order_photos_v1',false),
    ('public.list_work_order_visits_page(text,integer,text)',
      '9249b6c0ad6eed0515cbab1820cf303b','work_order_visits_v1','list_work_order_visits_rows_v1','count_work_order_visits_v1',false),
    ('public.list_contractor_invoices_page_pre_financial_version(text,text,text,text,integer,text,text)',
      '138b2a17ca3630d0b3d4f564e12ff838','contractor_invoices_v1','list_contractor_invoices_rows_v1','count_contractor_invoices_v1',true),
    ('public.list_staff_invoices_page(text,text,text,text,integer,text,text)',
      '99c115d934206becd14e6602a62a6755','staff_invoices_v1','list_staff_invoices_rows_v1','count_staff_invoices_v1',true)
  ) spec(signature,body_md5,helper_name,row_name,count_name,invoice_family)
  loop
    select p.*,pg_get_function_arguments(p.oid) arguments,
      pg_get_function_identity_arguments(p.oid) identity_arguments,
      l.lanname into strict v_proc from pg_proc p join pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure(v_spec.signature);
    if v_proc.prosecdef or v_proc.lanname<>'sql' or v_proc.provolatile<>'s'
      or md5(v_proc.prosrc)<>v_spec.body_md5 then
      raise exception 'Known page definition drifted: %; review before generating read contracts',v_spec.signature;
    end if;
    v_body:=v_proc.prosrc;
    v_select:=strpos(v_body,E'\n  select jsonb_build_object(');
    v_count:=strpos(v_body,E'\n    ''totalCount'',');
    if v_select=0 or v_count<=v_select or v_body !~ '\);[[:space:]]*$' then
      raise exception 'Known page output shape changed: %',v_spec.signature;
    end if;
    v_prefix:=left(v_body,v_select);
    -- Prevent the shared count reference from forcing all filtered row values
    -- (including computed presentation columns) to materialize in rows mode.
    -- This does not change predicates, RLS, ordering, or cursor semantics.
    v_prefix:=replace(v_prefix,E'\n  filtered as (',E'\n  filtered as not materialized (');
    v_prefix:=replace(v_prefix,E'\n  invoice_rows as (',E'\n  invoice_rows as not materialized (');
    if v_spec.helper_name in ('work_orders_v1','work_orders_table_v1') then
      -- 50k role-equivalent plans showed 44k activity probes for ordinary
      -- queue reads. Only activity-dependent membership/order needs that
      -- summary before LIMIT. Other reads enrich the bounded page afterwards.
      v_activity_start:=strpos(v_prefix,E'\n  activity_summary as (');
      v_activity_end:=strpos(v_prefix,E'\n  filtered as not materialized (');
      if v_activity_start=0 or v_activity_end<=v_activity_start then
        raise exception 'Known activity summary shape changed';
      end if;
      v_activity_body:=substring(v_prefix from v_activity_start for v_activity_end-v_activity_start);
      v_activity_body:=replace(v_activity_body,'where activity.deleted_at is null',
        'where activity.deleted_at is null
        and (p_needs_action is distinct from false or p_pending_first
          or (select scope_name from args) in (''staff_work'',''staff_work_unread'',''dashboard_seven_eleven_updates''))
        and (
          p_needs_action is distinct from false
          or ((select scope_name from args) in (''staff_work'',''staff_work_unread'')
            and (activity.entered_by_role=''contractor'' or (activity.requires_7eleven_sync and activity.synced_to_7eleven_at is null)))
          or ((p_pending_first or (select scope_name from args)=''dashboard_seven_eleven_updates'')
            and activity.requires_7eleven_sync and activity.synced_to_7eleven_at is null))');
      v_prefix:=left(v_prefix,v_activity_start-1)||v_activity_body||substring(v_prefix from v_activity_end);
      if v_spec.helper_name='work_orders_v1' then
        -- The full generic filtered predicate already repeats every candidate
        -- predicate. Removing this redundant join avoids a second RLS scan;
        -- table-mode has extra candidate-only filters and is left intact.
        v_prefix:=replace(v_prefix,E'\n    join candidate_work_orders candidate on candidate.id = work_order.id','');
      end if;
      v_prefix:=replace(v_prefix,E'\n    from page_rows\n    left join public.work_order_afm_contacts',E'\n    from page_rows\n    left join lateral (
      select max(activity.created_at) filter(where activity.type=''note'') latest_note_at,
        max(activity.created_at) filter(where activity.entered_by_role=''contractor'') latest_contractor_activity_at,
        count(*) filter(where activity.requires_7eleven_sync and activity.synced_to_7eleven_at is null) pending_7eleven_sync_count,
        count(*) filter(where activity.requires_contractor_attention and activity.contractor_attention_acknowledged_at is null) pending_contractor_attention_count
      from public.activities activity where activity.work_order_id=page_rows.id and activity.deleted_at is null
    ) page_activity on true\n    left join public.work_order_afm_contacts');
      foreach v_arg in array array['latest_note_at','latest_contractor_activity_at','pending_7eleven_sync_count','pending_contractor_attention_count'] loop
        v_prefix:=replace(v_prefix,format('%L, page_rows._%s',v_arg,v_arg),format('%L, page_activity.%s',v_arg,v_arg));
      end loop;
    end if;
    v_row_expression:=rtrim(substring(v_body from v_select+length(E'\n  select ')
      for v_count-v_select-length(E'\n  select ')),E' \n\r\t,')||')';
    v_count_expression:='jsonb_build_object('||regexp_replace(
      substring(v_body from v_count),'\);[[:space:]]*$','')||')';
    v_definition:=v_prefix||'  select case when p_read_mode=''count'' then '||v_count_expression||
      ' when p_read_mode=''rows'' then '||v_row_expression||' else null::jsonb end;';
    v_arguments:=v_proc.arguments;
    v_identity:=v_proc.identity_arguments;
    execute format('create function p1_read_contracts.%I(p_read_mode text,%s) returns jsonb
      language sql stable security invoker set search_path=pg_catalog,public as %L',
      v_spec.helper_name,v_arguments,v_definition);
    execute format('revoke all on function p1_read_contracts.%I(text,%s) from public,anon,authenticated,service_role',
      v_spec.helper_name,v_identity);
    execute format('grant execute on function p1_read_contracts.%I(text,%s) to authenticated,service_role',
      v_spec.helper_name,v_identity);
    select string_agg(format('%I',name),',' order by ordinality) into v_call
      from unnest(v_proc.proargnames) with ordinality as args(name,ordinality);
    select string_agg(format('%L,%I',name,name),',' order by ordinality) into v_validation
      from unnest(v_proc.proargnames) with ordinality as args(name,ordinality);
    v_wrapper:=format('begin perform p1_read_contracts.validate_v1(%L,jsonb_build_object(%s));
      return p1_read_contracts.%I(''rows'',%s); end;',v_spec.helper_name,v_validation,v_spec.helper_name,v_call);
    execute format('create function public.%I(%s) returns jsonb language plpgsql stable security invoker
      set search_path=pg_catalog,public as %L',v_spec.row_name,v_arguments,v_wrapper);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',v_spec.row_name,v_identity);
    execute format('grant execute on function public.%I(%s) to authenticated,service_role',v_spec.row_name,v_identity);

    v_count_arguments:=''; v_count_identity:=''; v_count_call:='';
    foreach v_arg in array string_to_array(v_arguments,', ') loop
      if split_part(v_arg,' ',1) not in ('p_limit','p_cursor')
        and (not v_spec.invoice_family or split_part(v_arg,' ',1) not in ('p_sort','p_direction')) then
        v_count_arguments:=concat_ws(', ',nullif(v_count_arguments,''),v_arg);
      end if;
    end loop;
    foreach v_arg in array string_to_array(v_identity,', ') loop
      if split_part(v_arg,' ',1) not in ('p_limit','p_cursor')
        and (not v_spec.invoice_family or split_part(v_arg,' ',1) not in ('p_sort','p_direction')) then
        v_count_identity:=concat_ws(', ',nullif(v_count_identity,''),v_arg);
        v_count_call:=concat_ws(',',nullif(v_count_call,''),format('%I=>%I',split_part(v_arg,' ',1),split_part(v_arg,' ',1)));
      end if;
    end loop;
    select string_agg(format('%L,%I',split_part(arg,' ',1),split_part(arg,' ',1)),',') into v_validation
      from unnest(string_to_array(v_count_identity,', ')) arg;
    v_wrapper:=format('begin perform p1_read_contracts.validate_v1(%L,jsonb_build_object(%s));
      return p1_read_contracts.%I(p_read_mode=>''count'',%s); end;',v_spec.helper_name,v_validation,v_spec.helper_name,v_count_call);
    execute format('create function public.%I(%s) returns jsonb language plpgsql stable security invoker
      set search_path=pg_catalog,public as %L',v_spec.count_name,v_count_arguments,v_wrapper);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',v_spec.count_name,v_count_identity);
    execute format('grant execute on function public.%I(%s) to authenticated,service_role',v_spec.count_name,v_count_identity);
  end loop;
end;
$read_contracts$;

-- Preserve 0124's live parent versions in the contractor row DTO without
-- invoking the old counted page. Exact same authorized parent enrichment.
create or replace function public.list_contractor_invoices_rows_v1(
  p_state text default 'all',p_search text default null,p_sort text default 'recent',
  p_direction text default 'desc',p_limit integer default 25,p_cursor text default null,
  p_work_order_id text default null
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_page jsonb; v_items jsonb;
begin
  perform p1_read_contracts.validate_v1('contractor_invoices_v1',jsonb_build_object(
    'p_state',p_state,'p_search',p_search,'p_sort',p_sort,'p_direction',p_direction,
    'p_limit',p_limit,'p_cursor',p_cursor,'p_work_order_id',p_work_order_id));
  v_page:=p1_read_contracts.contractor_invoices_v1('rows',p_state,p_search,p_sort,p_direction,p_limit,p_cursor,p_work_order_id);
  select coalesce(jsonb_agg(item||jsonb_build_object(
    'contractor_assignment_version',work_order.contractor_assignment_version,
    'workflow_cycle',work_order.workflow_cycle) order by ordinality),'[]'::jsonb)
  into v_items from jsonb_array_elements(coalesce(v_page->'items','[]'::jsonb))
    with ordinality as page_item(item,ordinality)
    left join public.work_orders work_order on work_order.id=item->>'work_order_id';
  return jsonb_set(v_page,'{items}',v_items,true);
end;
$$;

-- Preserve the existing 14-scalar navigation contract for stale callers;
-- current callers opt into the same exact counts with measured cheaper reads.
-- 50k fixture: 2.33s -> 1.04s locally, no production timing certification.
-- Eligibility, invoice completion, and the canonical SLA evaluator are intact.
do $navigation_contract$
declare v_proc record;v_body text;
begin
  select p.*,l.lanname into strict v_proc from pg_proc p join pg_language l on l.oid=p.prolang
    where p.oid='public.get_portal_navigation_summary()'::regprocedure;
  if v_proc.prosecdef or v_proc.lanname<>'sql' or v_proc.provolatile<>'s'
    or md5(v_proc.prosrc)<>'57b63f843bb1f894d450e2036337c078' then
    raise exception 'Known navigation count definition drifted; review before read optimization';
  end if;
  v_body:=replace(v_proc.prosrc,'public.is_staff()','(select public.is_staff())');
  -- Excluded activity rows contribute to none of the three aggregates. A
  -- missing left-joined group keeps the same existing NULL/zero semantics.
  v_body:=replace(v_body,'where activity.deleted_at is null',
    'where activity.deleted_at is null and (activity.entered_by_role=''contractor''
      or (activity.requires_7eleven_sync and activity.synced_to_7eleven_at is null)
      or (activity.requires_contractor_attention and activity.contractor_attention_acknowledged_at is null))');
  v_body:=replace(v_body,E'    select work_order.*',
    '    select work_order.id,work_order.status,work_order.priority,work_order.is_capital,
      work_order.dispatched_at,work_order.response_breach_at,work_order.resolution_breach_at,work_order.start_time');
  execute format('create function public.get_portal_navigation_summary_v1() returns jsonb
    language sql stable security invoker set search_path=pg_catalog,public as %L',v_body);
end;
$navigation_contract$;
revoke all on function public.get_portal_navigation_summary_v1() from public,anon,authenticated,service_role;
grant execute on function public.get_portal_navigation_summary_v1() to authenticated,service_role;

comment on schema p1_read_contracts is
  'Non-PostgREST-exposed, RLS-preserving shared page/count implementations. No writes or runtime dynamic SQL.';
commit;
