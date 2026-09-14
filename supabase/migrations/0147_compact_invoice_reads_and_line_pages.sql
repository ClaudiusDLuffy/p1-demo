-- Batch 4B.1: additive compact invoice reads. Existing financial commands,
-- legacy read definitions, RLS policies, rows, and indexes are unchanged.
-- Catalog generation below is migration-only, closed/hash-checked, and never
-- accepts a caller-selected relation, column, expression, or function.
begin;

do $prerequisite$
begin
  if to_regprocedure('public.list_contractor_invoices_rows_v1(text,text,text,text,integer,text,text)') is null
    or to_regprocedure('public.count_staff_invoices_v1(text,text,text)') is null then
    raise exception 'Apply the complete schema through 0144 before 0146';
  end if;
end;
$prerequisite$;

create schema p1_invoice_reads;
revoke all on schema p1_invoice_reads from public,anon,authenticated,service_role;
grant usage on schema p1_invoice_reads to authenticated,service_role;

-- Whitelist, not blacklist: future invoice columns cannot silently enlarge
-- the current list contract. The input is an already bounded selected row.
create function p1_invoice_reads.list_projection_v1(p_row jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
  select jsonb_object_agg(key,p_row->key) || jsonb_build_object('projection','summary')
  from unnest(array['id','num','work_order_id','store_number','contractor_id','invoice_type',
    'document_kind','source_capital_quote_id','invoice_date','state','subtotal','sales_tax','total',
    'territory','review_revision','invoice_version','rejection_reason','qbo_invoice_id','qbo_synced_at','paid_at',
    'created_at','updated_at']) key;
$$;

create function p1_invoice_reads.assert_json_budget_v1(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
begin
  -- jsonb::text includes whitespace absent from JSON.stringify, making this
  -- conservative for the uncompressed current JSON wire representation.
  if octet_length(p_value::text)>204800 then
    raise exception using errcode='PT413',message='PAYLOAD_TOO_LARGE';
  end if;
  return p_value;
end;
$$;

create function p1_invoice_reads.external_reference_v1(p_id text,p_root text)
returns text language sql immutable security invoker set search_path=pg_catalog,public as $$
  select coalesce(nullif(btrim(p_root),''),case when btrim(p_id) ~* '^(WOT[0-9]{6,12})-[0-9]+$'
    then regexp_replace(btrim(p_id),'^(WOT[0-9]{6,12})-[0-9]+$','\1','i') else nullif(btrim(p_id),'') end);
$$;

do $compact_pages$
declare
  v_spec record;v_source record;v_body text;v_prefix text;v_tail text;
  v_arguments text;v_identity text;v_call text;v_validation text;v_wrapper text;
  v_columns constant text := 'invoice.id,invoice.num,invoice.work_order_id,invoice.store_number,
      invoice.contractor_id,invoice.invoice_type,invoice.document_kind,invoice.source_capital_quote_id,
      invoice.invoice_date,invoice.state,invoice.subtotal,invoice.sales_tax,invoice.total,invoice.territory,
      invoice.review_revision,invoice.invoice_version,invoice.rejection_reason,invoice.qbo_invoice_id,invoice.qbo_synced_at,
      invoice.paid_at,invoice.created_at,invoice.updated_at';
begin
  for v_spec in select * from (values
    ('public.list_contractor_invoices_page_pre_financial_version(text,text,text,text,integer,text,text)',
      '138b2a17ca3630d0b3d4f564e12ff838','contractor_rows_v2','list_contractor_invoices_rows_v2','contractor_invoices_v1',true),
    ('public.list_staff_invoices_page(text,text,text,text,integer,text,text)',
      '99c115d934206becd14e6602a62a6755','staff_rows_v2','list_staff_invoices_rows_v2','staff_invoices_v1',false)
  ) specifications(signature,source_hash,private_name,public_name,validation_family,is_contractor) loop
    select p.*,l.lanname into strict v_source from pg_proc p join pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure(v_spec.signature);
    if v_source.prosecdef or v_source.provolatile<>'s' or v_source.lanname<>'sql'
      or md5(v_source.prosrc)<>v_spec.source_hash then
      raise exception 'Known invoice read definition drifted; review before compact projection';
    end if;
    v_arguments:=pg_get_function_arguments(v_source.oid);
    v_identity:=pg_get_function_identity_arguments(v_source.oid);
    v_body:=replace(v_source.prosrc,'invoice.*',v_columns);
    v_body:=replace(v_body,'invoice_rows as (','invoice_rows as not materialized (');
    if v_spec.is_contractor then
      -- Only the explicitly requested line-count sort needs a count before
      -- LIMIT. Ordinary page/count separation remains intact; the displayed
      -- per-invoice line count below belongs only to selected header rows.
      v_body:=replace(v_body,'where line.invoice_id = invoice.id' || E'\n    ) line_summary on true',
        'where args.sort_name = ''lines'' and line.invoice_id = invoice.id' || E'\n    ) line_summary on true');
      v_body:=replace(v_body,'case when public.is_staff() then source_owner.staff_invoice_id else null end as _source_staff_invoice_id',
        'null::uuid as _source_staff_invoice_id');
      v_body:=replace(v_body,E'    left join lateral (\n      select source.staff_invoice_id\n      from public.staff_invoice_sources source\n      where source.contractor_invoice_id = invoice.id\n      order by source.created_at desc, source.id desc\n      limit 1\n    ) source_owner on true\n','');
    end if;
    if position(E'  page_rows as (' in v_body)=0 then raise exception 'Known invoice page boundary missing';end if;
    v_prefix:=left(v_body,position(E'  page_rows as (' in v_body)-1);
    -- Both original CTE prefixes now end after bounded ordered rows. No
    -- original full-line/PDF enrichment or global totalCount branch remains.
    v_tail:=$tail$
  projected as materialized (
    select ordered._row_number,ordered._sort_number,ordered._sort_text,ordered._sort_time,ordered.id,
      p1_invoice_reads.list_projection_v1(to_jsonb(ordered)) || jsonb_build_object(
        'line_count',LINE_COUNT_EXPRESSION,
        'contractor_name',CONTRACTOR_NAME_EXPRESSION,
        'contractor_assignment_version',work_order.contractor_assignment_version,
        'workflow_cycle',work_order.workflow_cycle,
        'external_work_order_id',p1_invoice_reads.external_reference_v1(ordered.work_order_id,work_order.duplicate_root_work_order_id),
        'payment_hold_at',hold.placed_at,
        'source_staff_invoice_id',source_owner.staff_invoice_id,
        'source_count',coalesce(source_count.value,0),
        'contractor_cost',coalesce(source_count.contractor_cost,0),
        'gross_profit',coalesce(ordered.subtotal,0)-coalesce(source_count.contractor_cost,0),
        'margin_percent',case when ordered.subtotal>0 then
          (ordered.subtotal-coalesce(source_count.contractor_cost,0))/ordered.subtotal*100 else null end
      ) item
    from ordered
    cross join args
    left join public.work_orders work_order on work_order.id=ordered.work_order_id
    left join public.contractor_invoice_payment_holds hold on hold.invoice_id=ordered.id
    left join lateral (
      select source.staff_invoice_id from public.staff_invoice_sources source
      where CONTRACTOR_BOOLEAN and (select public.is_staff()) and source.contractor_invoice_id=ordered.id
      order by source.created_at desc,source.id desc limit 1
    ) source_owner on true
    left join lateral (
      select count(*)::integer value,
        coalesce(sum(coalesce(invoice.subtotal,greatest(coalesce(invoice.total,0)-coalesce(invoice.sales_tax,0),0))),0) contractor_cost
      from public.staff_invoice_sources source
      left join public.invoices invoice on invoice.id=source.contractor_invoice_id and invoice.deleted_at is null
      where not CONTRACTOR_BOOLEAN and source.staff_invoice_id=ordered.id
    ) source_count on true
  ),
  sized as (
    select projected.*,sum(octet_length(item::text)+2) over(order by _row_number) cumulative_bytes
    from projected
  ),
  prefix_bounds as (
    select sized.*,cumulative_bytes-2+octet_length(jsonb_build_object('items','[]'::jsonb,
      'hasMore',(select count(*) from ordered)>sized._row_number,
      'nextCursor',case when (select count(*) from ordered)>sized._row_number then
        public.portal_encode_cursor(jsonb_build_object(CURSOR_KIND_EXPRESSION
          'number',sized._sort_number,'text',sized._sort_text,'time',sized._sort_time,'id',sized.id)) else null end
      )::text) payload_bytes from sized
  ),
  page_boundary as (
    select max(_row_number) ordinal from prefix_bounds,args
      where _row_number<=args.page_size and payload_bytes<=204800
  ),
  page_rows as (
    select prefix_bounds.* from prefix_bounds where _row_number<=(select ordinal from page_boundary)
  ),
  last_row as (select page_rows.* from page_rows order by _row_number desc limit 1)
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(item order by _row_number) from page_rows),'[]'::jsonb),
    'hasMore',(select count(*) from ordered)>(select count(*) from page_rows),
    'nextCursor',case when (select count(*) from ordered)>(select count(*) from page_rows)
      then (select public.portal_encode_cursor(jsonb_build_object(
        CURSOR_KIND_EXPRESSION
        'number',last_row._sort_number,'text',last_row._sort_text,
        'time',last_row._sort_time,'id',last_row.id)) from last_row)
      else null end
  );
$tail$;
    v_tail:=replace(v_tail,'CONTRACTOR_BOOLEAN',case when v_spec.is_contractor then 'true' else 'false' end);
    v_tail:=replace(v_tail,'CONTRACTOR_NAME_EXPRESSION',case when v_spec.is_contractor then 'ordered._contractor_name' else 'null::text' end);
    v_tail:=replace(v_tail,'LINE_COUNT_EXPRESSION',case when v_spec.is_contractor then
      '(case when args.sort_name=''lines'' then ordered._line_count else (select count(*)::integer from public.invoice_lines line where line.invoice_id=ordered.id) end)'
      else '(select count(*)::integer from public.invoice_lines line where line.invoice_id=ordered.id)' end);
    v_tail:=replace(v_tail,'CURSOR_KIND_EXPRESSION',case when v_spec.is_contractor then '' else
      '''kind'',(select case when sort_name in (''invoice'',''total'') then ''number'' when sort_name in (''work_order'',''store'',''territory'',''status'') then ''text'' else ''time'' end from args),' end);
    v_body:=v_prefix||v_tail;
    if position('''totalCount''' in v_body)>0 or position('jsonb_agg(to_jsonb(line)' in v_body)>0
      or position('invoice_uploaded' in v_body)>0 then raise exception 'Legacy invoice expansion survived compact contract';end if;
    execute format('create function p1_invoice_reads.%I(%s) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as %L',
      v_spec.private_name,v_arguments,v_body);
    select string_agg(format('%I=>%I',split_part(arg,' ',1),split_part(arg,' ',1)),','),
      string_agg(format('%L,%I',split_part(arg,' ',1),split_part(arg,' ',1)),',')
      into v_call,v_validation from unnest(string_to_array(v_identity,', ')) arg;
    v_wrapper:=format('declare v_page jsonb; begin
      perform p1_read_contracts.validate_v1(%L,jsonb_build_object(%s));
      v_page:=p1_invoice_reads.%I(%s);
      if v_page->>''hasMore''=''true'' and jsonb_array_length(v_page->''items'')=0 then
        raise exception using errcode=''PT413'',message=''PAYLOAD_TOO_LARGE'';
      end if;
      return p1_invoice_reads.assert_json_budget_v1(v_page); end;',
      v_spec.validation_family,v_validation,v_spec.private_name,v_call);
    execute format('create function public.%I(%s) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as %L',
      v_spec.public_name,v_arguments,v_wrapper);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',v_spec.public_name,v_identity);
    execute format('grant execute on function public.%I(%s) to authenticated,service_role',v_spec.public_name,v_identity);
  end loop;
end;
$compact_pages$;

-- Compact exact header. Financial totals are stored header values, not the
-- totals of a currently loaded line page. The six-category display summary
-- separately retains the old UI's per-line rounding convention.
create function public.get_invoice_summary_v1(p_invoice_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_invoice public.invoices;v_header jsonb;v_summary jsonb;v_sources jsonb;
  v_source_ids jsonb;v_source_count integer;v_line_count integer;v_contractor_cost numeric;
begin
  if p_invoice_id is null then raise exception using errcode='22023',message='INVALID_REQUEST';end if;
  v_invoice := (select invoice from public.invoices invoice
    where invoice.id=p_invoice_id and invoice.deleted_at is null);
  if v_invoice.id is null then raise exception using errcode='P0002',message='NOT_FOUND';end if;
  -- Do not serialize the composite row and then delete aliases: unrequested
  -- legacy JSON (for example jurisdiction snapshots) must not be expanded.
  select jsonb_build_object('projection','summary','id',v_invoice.id,'num',v_invoice.num,
    'work_order_id',v_invoice.work_order_id,'store_number',v_invoice.store_number,'contractor_id',v_invoice.contractor_id,
    'invoice_type',v_invoice.invoice_type,'document_kind',v_invoice.document_kind,'source_capital_quote_id',v_invoice.source_capital_quote_id,
    'invoice_date',v_invoice.invoice_date,'state',v_invoice.state,'subtotal',v_invoice.subtotal,'sales_tax',v_invoice.sales_tax,
    'total',v_invoice.total,'territory',v_invoice.territory,'review_revision',v_invoice.review_revision,
      'invoice_version',v_invoice.invoice_version,'qbo_invoice_id',v_invoice.qbo_invoice_id,'qbo_synced_at',v_invoice.qbo_synced_at,
    'paid_at',v_invoice.paid_at,'created_at',v_invoice.created_at,'updated_at',v_invoice.updated_at) || jsonb_build_object(
    'submission_key',v_invoice.submission_key,'store_address',v_invoice.store_address,'cme',v_invoice.cme,
    'service_date',v_invoice.service_date,'due_date',v_invoice.due_date,'terms',v_invoice.terms,
    'equipment_tag',v_invoice.equipment_tag,'tax_state',v_invoice.tax_state,'tax_rate',v_invoice.tax_rate,
    'tax_rate_source',v_invoice.tax_rate_source,'tax_rate_reference_id',v_invoice.tax_rate_reference_id,
    'tax_rate_verified_at',v_invoice.tax_rate_verified_at,'pdf_storage_path',v_invoice.pdf_storage_path,
    'rejection_reason',v_invoice.rejection_reason,'rejected_at',v_invoice.rejected_at,
    'rejected_by',v_invoice.rejected_by,'resubmitted_at',v_invoice.resubmitted_at,'resubmitted_by',v_invoice.resubmitted_by,
    'contractor_assignment_version',work_order.contractor_assignment_version,'workflow_cycle',work_order.workflow_cycle,
    'external_work_order_id',p1_invoice_reads.external_reference_v1(v_invoice.work_order_id,work_order.duplicate_root_work_order_id),
    'contractor_name',profile.name,'payment_hold_at',hold.placed_at,'payment_hold_by',hold.placed_by,
    'payment_hold_reason',hold.reason,'pdf_is_original',coalesce(upload.present,false),
    'original_pdf_name',upload.original_name,
    'source_staff_invoice_id',(select source.staff_invoice_id from public.staff_invoice_sources source
      where v_invoice.invoice_type='contractor' and source.contractor_invoice_id=v_invoice.id
      order by source.created_at desc,source.id desc limit 1)
  ) into v_header
  from (values(1)) singleton(value)
  left join public.work_orders work_order on work_order.id=v_invoice.work_order_id
  left join public.profiles profile on profile.id=v_invoice.contractor_id
  left join public.contractor_invoice_payment_holds hold on hold.invoice_id=v_invoice.id
  left join lateral (
    select true present,activity.event_data->>'fileName' original_name
    from public.activities activity where activity.event_key='invoice_uploaded'
      and activity.deleted_at is null and activity.event_data->>'invoiceId'=v_invoice.id::text
    order by activity.created_at desc,activity.id desc limit 1
  ) upload on true;
  with classified as (
    select case
      when display.type_value ~* '^(ot|overtime)\s*labor$' then 2
      when display.type_value ~* '^labor$' then 1
      when line.type ~* 'part|hardware|material' then 4
      when line.type ~* 'travel|truck' then 3
      when line.type ~* 'shipping|freight' then 5 else 6 end category_index,
      -- This is the pre-existing category DISPLAY convention, not the
      -- PostgreSQL-authoritative header calculation. Math.round uses binary
      -- Number multiplication and ties toward +infinity (including negative
      -- legacy values); numeric round would silently alter 1.005 displays.
      (floor(display.scaled)+case when display.scaled-floor(display.scaled)>=0.5
        then 1 else 0 end)::numeric/100 amount
    from public.invoice_lines line
    cross join lateral (select (line.qty::double precision*line.rate::double precision)*100 scaled,
      -- ECMAScript trim/\s whitespace used by the existing line-type helper.
      -- Translating it to spaces also preserves OT<whitespace>Labor matching.
      btrim(translate(line.type,U&'\0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF',repeat(' ',24))) type_value) display
    where line.invoice_id=v_invoice.id
  ), categories as (
    select category_index,sum(amount) amount,count(*)::integer line_count
    from classified group by category_index
  ), aggregate_summary as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'category',(array['Labor','OT Labor','Travel','Parts/Hardware','Shipping','Other'])[category_index],
      'label',(array['Labor','OT labor','Travel','Parts','Shipping','Other'])[category_index],
      'amount',amount,'lineCount',line_count) order by category_index),'[]'::jsonb) categories,
      coalesce(sum(amount),0) subtotal,coalesce(sum(line_count),0)::integer line_count from categories
  ) select jsonb_build_object('categories',categories,'subtotal',subtotal,
      'salesTax',greatest(coalesce(v_invoice.sales_tax,0),0),
      'grandTotal',subtotal+greatest(coalesce(v_invoice.sales_tax,0),0)),line_count
    into v_summary,v_line_count from aggregate_summary;
  -- The financial write contract permits <=100 source invoices. Read one
  -- extra legacy link solely to detect an unsupported oversized document.
  with linked as materialized (
    select source.contractor_invoice_id,source.created_at,source.id
    from public.staff_invoice_sources source where source.staff_invoice_id=v_invoice.id
    order by source.created_at,source.id limit 101
  ) select count(*)::integer,
    coalesce(jsonb_agg(linked.contractor_invoice_id order by linked.created_at,linked.id),'[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('id',invoice.id,'num',invoice.num,'state',invoice.state,
      'total',invoice.total,'subtotal',invoice.subtotal,'sales_tax',invoice.sales_tax,
      'invoice_version',invoice.invoice_version,'work_order_id',invoice.work_order_id)
      order by linked.created_at,linked.id) filter(where invoice.id is not null),'[]'::jsonb),
    coalesce(sum(coalesce(invoice.subtotal,greatest(coalesce(invoice.total,0)-coalesce(invoice.sales_tax,0),0))),0)
    into v_source_count,v_source_ids,v_sources,v_contractor_cost from linked
    left join public.invoices invoice on invoice.id=linked.contractor_invoice_id and invoice.deleted_at is null;
  if v_source_count>100 then raise exception using errcode='PT413',message='PAYLOAD_TOO_LARGE';end if;
  return p1_invoice_reads.assert_json_budget_v1(v_header||jsonb_build_object(
    'line_count',v_line_count,'line_type_summary',v_summary,'source_count',v_source_count,
    'source_invoice_ids',v_source_ids,'source_invoices',v_sources,
    'contractor_cost',v_contractor_cost,'gross_profit',coalesce(v_invoice.subtotal,0)-v_contractor_cost,
    'margin_percent',case when v_invoice.subtotal>0 then
      (v_invoice.subtotal-v_contractor_cost)/v_invoice.subtotal*100 else null end));
end;
$$;

-- A stable RPC statement reads the authorized header version and its line
-- page in one MVCC snapshot. Separate HTTP pages are NOT a transaction-wide
-- snapshot: every continuation must match the header's financial version.
create function public.list_invoice_lines_page_v1(
  p_invoice_id uuid,p_limit integer default 50,p_cursor text default null,p_expected_version bigint default null
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_version bigint;v_cursor jsonb;v_position integer;v_id uuid;
  v_result jsonb;v_limit integer:=coalesce(p_limit,50);
begin
  if p_invoice_id is null or v_limit not between 1 and 100
    or p_expected_version<0 or (p_cursor is not null and octet_length(p_cursor)>4096) then
    raise exception using errcode='22023',message='INVALID_REQUEST';
  end if;
  select invoice.invoice_version into v_version from public.invoices invoice
    where invoice.id=p_invoice_id and invoice.deleted_at is null;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND';end if;
  if p_expected_version is not null and p_expected_version<>v_version then
    raise exception using errcode='PT409',message='STALE_VERSION';
  end if;
  if p_cursor is not null then
    begin
      v_cursor:=public.portal_decode_cursor(p_cursor);
      if jsonb_typeof(v_cursor) is distinct from 'object'
        or not(v_cursor ?& array['v','invoice_id','invoice_version','position','id'])
        or (select count(*) from jsonb_object_keys(v_cursor))<>5
        or jsonb_typeof(v_cursor->'v') is distinct from 'number'
        or jsonb_typeof(v_cursor->'invoice_id') is distinct from 'string'
        or v_cursor->>'v' is distinct from '1'
        or v_cursor->>'invoice_id' is distinct from p_invoice_id::text
        or jsonb_typeof(v_cursor->'invoice_version') is distinct from 'number'
        or jsonb_typeof(v_cursor->'position') is distinct from 'number'
        or coalesce((v_cursor->>'invoice_version')!~'^[0-9]+$',true)
        or coalesce((v_cursor->>'position')!~'^-?[0-9]+$',true)
        or jsonb_typeof(v_cursor->'id') is distinct from 'string' then
        raise exception using errcode='22023',message='INVALID_REQUEST';
      end if;
      v_position:=(v_cursor->>'position')::integer;v_id:=(v_cursor->>'id')::uuid;
      if p_expected_version is null or (v_cursor->>'invoice_version')::bigint<>v_version then
        raise exception using errcode='PT409',message='STALE_VERSION';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode='22023',message='INVALID_REQUEST';
    end;
  end if;
  with candidates as materialized (
    select line.id,line.invoice_id,line.position,line.type,line.description,line.qty,line.rate,line.amount,
      line.is_taxable,line.source_invoice_line_id,line.source_work_order_part_id,line.source_unit_cost,line.markup_percent
    from public.invoice_lines line where line.invoice_id=p_invoice_id
      and (v_cursor is null or (line.position,line.id)>(v_position,v_id))
    order by line.position,line.id limit v_limit+1
  ), projected as (
    select candidates.position,candidates.id,to_jsonb(candidates) item,
      row_number() over(order by candidates.position,candidates.id) ordinal from candidates
  ), sized as (
    select projected.*,sum(octet_length(item::text)+2) over(order by position,id) cumulative_bytes from projected
  ), prefix_bounds as (
    select sized.*,cumulative_bytes-2+octet_length(jsonb_build_object(
      'projection','line_page','invoiceVersion',v_version,'pageSize',v_limit,'items','[]'::jsonb,
      'hasMore',(select count(*) from candidates)>sized.ordinal,
      'nextCursor',case when (select count(*) from candidates)>sized.ordinal then
        public.portal_encode_cursor(jsonb_build_object('v',1,'invoice_id',p_invoice_id,
          'invoice_version',v_version,'position',sized.position,'id',sized.id)) else null end)::text) payload_bytes
    from sized
  ), page_boundary as (
    select max(ordinal) ordinal from prefix_bounds where ordinal<=v_limit and payload_bytes<=204800
  ), page_rows as (
    select prefix_bounds.* from prefix_bounds where ordinal<=(select ordinal from page_boundary)
  ), last_row as (select position,id from page_rows order by position desc,id desc limit 1)
  select jsonb_build_object('projection','line_page','invoiceVersion',v_version,'pageSize',v_limit,
    'items',coalesce((select jsonb_agg(item order by position,id) from page_rows),'[]'::jsonb),
    'hasMore',(select count(*) from candidates)>(select count(*) from page_rows),
    'nextCursor',case when (select count(*) from candidates)>(select count(*) from page_rows)
      then (select public.portal_encode_cursor(jsonb_build_object('v',1,'invoice_id',p_invoice_id,
        'invoice_version',v_version,'position',position,'id',id)) from last_row) else null end)
    into v_result;
  if v_result->>'hasMore'='true' and jsonb_array_length(v_result->'items')=0 then
    raise exception using errcode='PT413',message='PAYLOAD_TOO_LARGE';
  end if;
  return p1_invoice_reads.assert_json_budget_v1(v_result);
end;
$$;

-- Explicit source selection is one bounded set query, not one exact-header
-- RPC per source. Complete lines are still an explicit version-bound editor
-- workflow; this contract neither embeds nor silently collects line pages.
create function public.get_invoice_source_summaries_v1(p_invoice_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
  if p_invoice_ids is null or cardinality(p_invoice_ids)>100
    or array_position(p_invoice_ids,null) is not null
    or cardinality(p_invoice_ids)<>(select count(distinct id) from unnest(p_invoice_ids) id) then
    raise exception using errcode='22023',message='INVALID_REQUEST';
  end if;
  with authorized as materialized (
    select invoice.id,invoice.num,invoice.state,invoice.work_order_id,invoice.invoice_version,
      invoice.subtotal,invoice.sales_tax,invoice.total,invoice.invoice_type
    from public.invoices invoice where invoice.id=any(p_invoice_ids)
      and invoice.invoice_type='contractor' and invoice.deleted_at is null
  ), line_counts as (
    select line.invoice_id,count(*)::integer value from public.invoice_lines line
      join authorized invoice on invoice.id=line.invoice_id group by line.invoice_id
  ) select jsonb_build_object('invoices',coalesce(jsonb_agg(to_jsonb(invoice)||jsonb_build_object(
      'line_count',coalesce(line_counts.value,0)) order by array_position(p_invoice_ids,invoice.id)),'[]'::jsonb))
    into v_result from authorized invoice left join line_counts on line_counts.invoice_id=invoice.id;
  return p1_invoice_reads.assert_json_budget_v1(v_result);
end;
$$;

-- Existing work-order detail shows a billed hint when a visible non-draft,
-- non-rejected contractor line matches a part description. Return only the
-- IDs of requested authorized parent parts, not invoice descriptions/lines.
create function public.get_work_order_invoice_part_hints_v1(p_work_order_id text,p_part_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
  if p_work_order_id is null or octet_length(p_work_order_id)>1000
    or p_part_ids is null or cardinality(p_part_ids)>1000
    or array_position(p_part_ids,null) is not null then
    raise exception using errcode='22023',message='INVALID_REQUEST';
  end if;
  if not exists(select 1 from public.work_orders work_order
    where work_order.id=p_work_order_id and work_order.deleted_at is null) then
    raise exception using errcode='P0002',message='NOT_FOUND';
  end if;
  select jsonb_build_object('billedPartIds',coalesce(jsonb_agg(part.id order by part.id),'[]'::jsonb))
    into v_result from public.wo_parts part where part.work_order_id=p_work_order_id and part.id=any(p_part_ids)
    and nullif(part.description,'') is not null and exists(
      select 1 from public.invoices invoice join public.invoice_lines line on line.invoice_id=invoice.id
      where invoice.work_order_id=p_work_order_id and invoice.invoice_type='contractor'
        and invoice.deleted_at is null and invoice.state::text not in ('draft','rejected')
        and nullif(line.description,'') is not null
        and (position(lower(part.description) in lower(line.description))>0
          or position(lower(line.description) in lower(part.description))>0));
  return p1_invoice_reads.assert_json_budget_v1(v_result);
end;
$$;

revoke all on all functions in schema p1_invoice_reads from public,anon,authenticated,service_role;
grant execute on all functions in schema p1_invoice_reads to authenticated,service_role;
revoke all on function public.get_invoice_summary_v1(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_invoice_summary_v1(uuid) to authenticated,service_role;
revoke all on function public.list_invoice_lines_page_v1(uuid,integer,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.list_invoice_lines_page_v1(uuid,integer,text,bigint) to authenticated,service_role;
revoke all on function public.get_work_order_invoice_part_hints_v1(text,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.get_work_order_invoice_part_hints_v1(text,uuid[]) to authenticated,service_role;
revoke all on function public.get_invoice_source_summaries_v1(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.get_invoice_source_summaries_v1(uuid[]) to authenticated,service_role;

commit;
