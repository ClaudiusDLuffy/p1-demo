-- Invoice-local, explicitly explained staff corrections. Purchasing costs,
-- contractor invoices, source ownership and historical invoices stay intact.
begin;

alter table public.invoice_lines add column price_correction jsonb;

create function public.normalize_part_price_correction(p_value jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare v_amount numeric; v_reason text;
begin
  if p_value is null or p_value='null'::jsonb then return null; end if;
  if jsonb_typeof(p_value) is distinct from 'object' then
    raise exception using errcode='22023',message='Invalid part price correction';
  end if;
  if not (p_value ?& array['basis','amount','reason'])
    or (select count(*) from jsonb_object_keys(p_value))<>3
    or jsonb_typeof(p_value->'basis') is distinct from 'string'
    or p_value->>'basis' not in ('purchase_cost','billing_rate')
    or jsonb_typeof(p_value->'amount') is distinct from 'number'
    or jsonb_typeof(p_value->'reason') is distinct from 'string' then
    raise exception using errcode='22023',message='Invalid part price correction';
  end if;
  v_amount:=(p_value->>'amount')::numeric; v_reason:=btrim(p_value->>'reason');
  if v_amount::text in ('NaN','Infinity','-Infinity') or v_amount<=0 or v_amount>99999999.99
    or v_amount<>round(v_amount,2) or length(v_reason) not between 10 and 1000
    or v_reason ~ '[[:cntrl:]]'
    or (p_value->>'basis'='purchase_cost' and round(v_amount*1.25,2)>99999999.99) then
    raise exception using errcode='22023',message='Enter a positive cent amount and a correction reason of 10 to 1000 characters';
  end if;
  return jsonb_build_object('basis',p_value->>'basis','amount',v_amount,'reason',v_reason);
end;
$$;

create function public.corrected_part_billing_rate(p_recorded_cost numeric,p_correction jsonb)
returns numeric language plpgsql immutable set search_path=pg_catalog,public as $$
declare v_correction jsonb:=public.normalize_part_price_correction(p_correction);
begin
  if v_correction is null then return round(p_recorded_cost*1.25,2); end if;
  if v_correction->>'basis'='purchase_cost' then return round((v_correction->>'amount')::numeric*1.25,2); end if;
  return (v_correction->>'amount')::numeric;
end;
$$;

create function public.corrected_part_markup(p_correction jsonb)
returns numeric language sql immutable set search_path=pg_catalog,public as $$
  select case when p_correction->>'basis'='billing_rate' then null::numeric else 25::numeric end;
$$;

create table public.invoice_part_price_audit (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.invoice_financial_operations(operation_id),
  invoice_id uuid not null references public.invoices(id),
  actor_id uuid not null references public.profiles(id),
  line_position integer not null,
  source_work_order_part_id uuid,
  source_invoice_line_id uuid,
  recorded_unit_cost numeric,
  previous_rate numeric,
  new_rate numeric not null,
  previous_correction jsonb,
  correction jsonb,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(operation_id,line_position)
);
alter table public.invoice_part_price_audit enable row level security;
revoke all on public.invoice_part_price_audit from public,anon,authenticated,service_role;
grant select on public.invoice_part_price_audit to authenticated;
create policy invoice_part_price_audit_staff_read on public.invoice_part_price_audit for select to authenticated
  using(public.is_staff() and not public.is_invoice_controller());
create index invoice_part_price_audit_invoice on public.invoice_part_price_audit(invoice_id,created_at);

-- Fail closed on any unexpected installed function shape. Preserve the exact
-- current definitions, including Warranty, close-out, ACL and security patches.
-- Match LF or CRLF anchors without rewriting the surrounding function body:
-- normalizing an entire definition could change newlines inside SQL literals.
create function pg_temp.patch_part_price_function(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare
  v_oid oid:=to_regprocedure(p_signature); v_definition text;
  v_old_lf text; v_old_crlf text; v_new_lf text;
  v_lf_count integer; v_crlf_count integer:=0;
begin
  if v_oid is null then raise exception 'Required function missing: %',p_signature; end if;
  if p_old is null or p_old='' or p_new is null then
    raise exception 'Invalid patch template in %; review required',p_signature;
  end if;
  v_definition:=pg_get_functiondef(v_oid);
  -- The migration file itself may also have been pasted with CRLF endings.
  v_old_lf:=replace(p_old,E'\r\n',E'\n');
  v_new_lf:=replace(p_new,E'\r\n',E'\n');
  v_old_crlf:=replace(v_old_lf,E'\n',E'\r\n');
  v_lf_count:=(length(v_definition)-length(replace(v_definition,v_old_lf,'')))/length(v_old_lf);
  if v_old_crlf<>v_old_lf then
    v_crlf_count:=(length(v_definition)-length(replace(v_definition,v_old_crlf,'')))/length(v_old_crlf);
  end if;
  if v_lf_count+v_crlf_count<>1 then
    raise exception 'Unexpected function shape in %; review required',p_signature;
  end if;
  if v_crlf_count=1 then
    execute replace(v_definition,v_old_crlf,replace(v_new_lf,E'\n',E'\r\n'));
  else
    execute replace(v_definition,v_old_lf,v_new_lf);
  end if;
end;
$$;

do $patch$
declare
  v_normalizer text:='public.normalize_staff_invoice_payload(jsonb)';
  v_save text:='public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb)';
  v_legacy text:='public.save_staff_billing_invoice(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[])';
  v_v2 text:='public.save_staff_billing_invoice_v2(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[])';
  v_trigger text:='public.protect_invoice_line_billing_metadata()';
begin
  perform pg_temp.patch_part_price_function(v_normalizer,
    $old$          'sourceUnitCost', 'markupPercent'$old$,
    $new$          'sourceUnitCost', 'markupPercent', 'priceCorrection'$new$);
  perform pg_temp.patch_part_price_function(v_normalizer,
    $old$  select jsonb_agg(jsonb_build_object(
    'type', btrim(line ->> 'type'),$old$,
    $new$  perform public.normalize_part_price_correction(line->'priceCorrection')
  from jsonb_array_elements(p_payload->'lines') line;
  if exists(select 1 from jsonb_array_elements(p_payload->'lines') line
    where public.normalize_part_price_correction(line->'priceCorrection') is not null and (
      lower(btrim(line->>'type')) not in ('parts','parts/hardware','hardware')
      or (nullif(line->>'sourceWorkOrderPartId','') is null and nullif(line->>'sourceInvoiceLineId','') is null)
      or (line->>'rate')::numeric is distinct from public.corrected_part_billing_rate((line->>'sourceUnitCost')::numeric,line->'priceCorrection')
      or (line->>'markupPercent')::numeric is distinct from public.corrected_part_markup(line->'priceCorrection')
    )) then
    raise exception using errcode='22023',message='A part correction requires its source, reason and exact calculated billing price';
  end if;
  select jsonb_agg(jsonb_build_object(
    'type', btrim(line ->> 'type'),$new$);
  -- Null/missing metadata remains byte-compatible with historical replay payloads.
  perform pg_temp.patch_part_price_function(v_normalizer,
    $old$    'markupPercent', (line ->> 'markupPercent')::numeric
  ) order by ordinality)$old$,
    $new$    'markupPercent', (line ->> 'markupPercent')::numeric
  ) || case when public.normalize_part_price_correction(line->'priceCorrection') is null then '{}'::jsonb
    else jsonb_build_object('priceCorrection',public.normalize_part_price_correction(line->'priceCorrection')) end
  order by ordinality)$new$);

  perform pg_temp.patch_part_price_function(v_save,
    $old$  v_constraint_name text;
begin$old$,
    $new$  v_constraint_name text;
  v_previous_price_lines jsonb;
begin$new$);
  perform pg_temp.patch_part_price_function(v_save,
    $old$  select coalesce(array_agg(part_id order by part_id), '{}'::uuid[])
  into v_p1_part_ids$old$,
    $new$  -- Snapshot before the legacy atomic writer replaces child rows.
  select coalesce(jsonb_agg(to_jsonb(l)),'[]'::jsonb) into v_previous_price_lines
    from public.invoice_lines l where l.invoice_id=p_invoice_id;
  -- Old clients do not understand correction metadata. They must not reset a
  -- saved correction through ordinary source refresh or an omitted P1 line.
  -- The current editor sends priceCorrection:null for an explicit restore.
  if exists(select 1 from jsonb_array_elements(v_previous_price_lines) previous
    where nullif(previous->'price_correction','null'::jsonb) is not null
      and (
        (nullif(previous->>'source_work_order_part_id','') is not null
          and v_existing_work_order_id is not distinct from p_work_order_id)
        or exists(select 1 from jsonb_array_elements(p_payload->'lines') requested
          where nullif(requested->>'sourceInvoiceLineId','')::uuid=
            nullif(previous->>'source_invoice_line_id','')::uuid)
      )
      and not exists(select 1 from jsonb_array_elements(p_payload->'lines') requested
        where requested ? 'priceCorrection' and (
          nullif(requested->>'sourceWorkOrderPartId','')::uuid=nullif(previous->>'source_work_order_part_id','')::uuid
          or nullif(requested->>'sourceInvoiceLineId','')::uuid=nullif(previous->>'source_invoice_line_id','')::uuid
        ))
  ) then raise exception using errcode='PT409',message='Refresh the editor to retain or explicitly restore the saved part price correction'; end if;
  -- A corrected contractor-sourced line keeps its real source cost/owner.
  if exists(select 1 from jsonb_array_elements(v_payload->'lines') line
    left join public.invoice_lines source_line on source_line.id=nullif(line->>'sourceInvoiceLineId','')::uuid
    left join public.invoices source_invoice on source_invoice.id=source_line.invoice_id
    where line ? 'priceCorrection' and nullif(line->>'sourceInvoiceLineId','') is not null and (
      source_line.id is null or source_invoice.invoice_type<>'contractor' or source_invoice.deleted_at is not null
      or source_invoice.work_order_id is distinct from p_work_order_id
      or not(source_invoice.id=any(v_source_ids))
      or (line->>'sourceUnitCost')::numeric is distinct from source_line.rate
    )) then raise exception using errcode='23514',message='The corrected part must retain its contractor invoice source and recorded cost'; end if;
  select coalesce(array_agg(part_id order by part_id), '{}'::uuid[])
  into v_p1_part_ids$new$);
  perform pg_temp.patch_part_price_function(v_save,
    $old$    if v_existing.qbo_invoice_id is not null
       or v_existing.qbo_synced_at is not null then$old$,
    $new$    if exists(select 1 from public.activities billed
      where billed.work_order_id=v_existing.work_order_id and billed.deleted_at is null
        and billed.event_key='staff_billing' and billed.event_data->>'action'='billed_to_7_eleven'
        and billed.event_data->>'invoiceId'=v_existing.id::text) then
      raise exception using errcode='55000',message='Already-billed invoices are locked; use the billing correction workflow';
    end if;
    if v_existing.qbo_invoice_id is not null
       or v_existing.qbo_synced_at is not null then$new$);
  perform pg_temp.patch_part_price_function(v_save,
    $old$or round((line ->> 'sourceUnitCost')::numeric, 2) <> cost.unit_cost
          or round((line ->> 'markupPercent')::numeric, 1) <> 25.0$old$,
    $new$or (line ->> 'sourceUnitCost')::numeric is distinct from cost.unit_cost
          or (line ->> 'markupPercent')::numeric is distinct from public.corrected_part_markup(line->'priceCorrection')$new$);
  perform pg_temp.patch_part_price_function(v_save,
    $old$or (line ->> 'rate')::numeric <> round(cost.unit_cost * 1.25, 2)$old$,
    $new$or (line ->> 'rate')::numeric is distinct from public.corrected_part_billing_rate(cost.unit_cost,line->'priceCorrection')$new$);
  perform pg_temp.patch_part_price_function(v_save,
    $old$        'markup_percent', (line ->> 'markupPercent')::numeric
      ) as line$old$,
    $new$        'markup_percent', (line ->> 'markupPercent')::numeric,
        'price_correction', public.normalize_part_price_correction(line->'priceCorrection')
      ) as line$new$);
  perform pg_temp.patch_part_price_function(v_save,
    $old$  select invoice.* into strict v_invoice
  from public.invoices invoice where invoice.id = v_invoice_id;$old$,
    $new$  insert into public.invoice_part_price_audit(operation_id,invoice_id,actor_id,line_position,
    source_work_order_part_id,source_invoice_line_id,recorded_unit_cost,previous_rate,new_rate,
    previous_correction,correction,reason)
  select p_operation_id,v_invoice_id,p_actor_id,l.position,l.source_work_order_part_id,l.source_invoice_line_id,
    l.source_unit_cost,(previous.item->>'rate')::numeric,l.rate,
    nullif(previous.item->'price_correction','null'::jsonb),l.price_correction,
    coalesce(l.price_correction->>'reason','Restored recorded source cost plus default markup')
  from public.invoice_lines l
  left join lateral (
    select item from jsonb_array_elements(v_previous_price_lines) item
    where (l.source_work_order_part_id is not null and item->>'source_work_order_part_id'=l.source_work_order_part_id::text)
      or (l.source_invoice_line_id is not null and item->>'source_invoice_line_id'=l.source_invoice_line_id::text)
    limit 1
  ) previous on true
  where l.invoice_id=v_invoice_id
    and (l.price_correction is not null or nullif(previous.item->'price_correction','null'::jsonb) is not null)
    and (l.price_correction is distinct from nullif(previous.item->'price_correction','null'::jsonb)
      or l.rate is distinct from (previous.item->>'rate')::numeric);
  select invoice.* into strict v_invoice
  from public.invoices invoice where invoice.id = v_invoice_id;$new$);

  perform pg_temp.patch_part_price_function(v_v2,
    $old$or round((line.item ->> 'source_unit_cost')::numeric, 2) <> cost.unit_cost
          or round((line.item ->> 'markup_percent')::numeric, 4) <> 25.0000$old$,
    $new$or (line.item ->> 'source_unit_cost')::numeric is distinct from cost.unit_cost
          or (line.item ->> 'markup_percent')::numeric is distinct from public.corrected_part_markup(line.item->'price_correction')$new$);
  perform pg_temp.patch_part_price_function(v_v2,
    $old$or round((line.item ->> 'rate')::numeric, 2) <> round(cost.unit_cost * 1.25, 2)$old$,
    $new$or (line.item ->> 'rate')::numeric is distinct from public.corrected_part_billing_rate(cost.unit_cost,line.item->'price_correction')$new$);
  perform pg_temp.patch_part_price_function(v_legacy,
    $old$    source_unit_cost,
    markup_percent
  )$old$,
    $new$    source_unit_cost,
    markup_percent,
    price_correction
  )$new$);
  perform pg_temp.patch_part_price_function(v_legacy,
    $old$    nullif(line.item ->> 'markup_percent', '')::numeric
  from jsonb_array_elements(p_lines)$old$,
    $new$    nullif(line.item ->> 'markup_percent', '')::numeric,
    public.normalize_part_price_correction(line.item->'price_correction')
  from jsonb_array_elements(p_lines)$new$);

  perform pg_temp.patch_part_price_function(v_trigger,
    $old$    if new.is_taxable
       or new.source_invoice_line_id is not null$old$,
    $new$    if new.is_taxable
       or new.price_correction is not null
       or new.source_invoice_line_id is not null$new$);
  perform pg_temp.patch_part_price_function(v_trigger,
    $old$  if new.source_invoice_line_id is not null then
    select invoice.invoice_type, invoice.work_order_id$old$,
    $new$  if new.price_correction is not null then
    new.price_correction:=public.normalize_part_price_correction(new.price_correction);
    if lower(btrim(new.type)) not in ('parts','parts/hardware','hardware')
      or new.rate is distinct from public.corrected_part_billing_rate(new.source_unit_cost,new.price_correction)
      or new.markup_percent is distinct from public.corrected_part_markup(new.price_correction) then
      raise exception using errcode='23514',message='Part price correction and billing price must agree';
    end if;
  end if;
  if new.source_invoice_line_id is not null then
    select invoice.invoice_type, invoice.work_order_id$new$);
  perform pg_temp.patch_part_price_function(v_trigger,
    $old$or round(coalesce(new.source_unit_cost, -1), 2) <> source_part_cost
       or round(coalesce(new.markup_percent, -1), 4) <> 25.0000$old$,
    $new$or new.source_unit_cost is distinct from source_part_cost
       or new.markup_percent is distinct from public.corrected_part_markup(new.price_correction)$new$);
  perform pg_temp.patch_part_price_function(v_trigger,
    $old$or round(new.rate, 2) <> round(source_part_cost * 1.25, 2)$old$,
    $new$or new.rate is distinct from public.corrected_part_billing_rate(source_part_cost,new.price_correction)$new$);
  perform pg_temp.patch_part_price_function('public.list_invoice_lines_page_v1(uuid,integer,text,bigint)',
    $old$line.source_work_order_part_id,line.source_unit_cost,line.markup_percent$old$,
    $new$line.source_work_order_part_id,line.source_unit_cost,line.markup_percent,line.price_correction$new$);
  perform pg_temp.patch_part_price_function('public.invoice_financial_line_snapshot(uuid)',
    $old$jsonb_agg(to_jsonb(line) order by line.position, line.id)$old$,
    $new$jsonb_agg(case when line.price_correction is null then to_jsonb(line)-'price_correction'
      else to_jsonb(line) end order by line.position, line.id)$new$);
end;
$patch$;

revoke all on function public.normalize_part_price_correction(jsonb),
  public.corrected_part_billing_rate(numeric,jsonb),public.corrected_part_markup(jsonb)
  from public,anon,authenticated,service_role;
-- Trigger and command owners call the helpers. The ordinary stable line reader
-- returns stored metadata only; no caller gains a new financial-write RPC.
comment on column public.invoice_lines.price_correction is
  'Invoice-local staff part correction: purchase cost before markup or exact final unit rate, with mandatory reason. Original source_unit_cost is preserved.';
notify pgrst,'reload schema';
commit;
