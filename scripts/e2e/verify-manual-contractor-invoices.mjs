import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {linkedBillingSql as sql} from './linked-billing-test-support.mjs';
import {priorInvoiceFixture,priorSqlAs,quotePrior as q} from './prior-contractor-invoice-fixtures.mjs';
assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"),'0');
const vendor=sql("select id from public.profiles where email='e2e.company.admin@p1.invalid'");
const current=sql("select id from public.profiles where email='e2e.direct@p1.invalid'");
const tech=sql("select id from public.profiles where email='e2e.invoice.tech@p1.invalid'");
const checks=[];
function call(f,overrides={}){
  const o={vendor,invoice:null,version:null,operation:randomUUID(),assignment:f.assignment,cycle:f.cycle,
    payload:{num:`SYNTHETIC-MANUAL-${randomUUID().slice(0,8)}`,invoiceDate:f.day,total:125.50,salesTax:5.50,
      note:'Verified original bill for earlier work outside the portal.',verified:true},...overrides};
  return `public.save_verified_manual_contractor_invoice_v1(${q(f.work)},${o.assignment},${o.cycle},${q(o.vendor)}::uuid,
    ${o.invoice?`${q(o.invoice)}::uuid`:'null'},${o.version??'null'},${q(o.operation)}::uuid,${q(JSON.stringify(o.payload))}::jsonb)`;
}
function denied(f,statement,code,label,actor,before=''){
  priorSqlAs(`do $probe$ declare rejected text; parent jsonb; begin
    select to_jsonb(w) into parent from public.work_orders w where id=${q(f.work)};
    begin perform ${statement}; exception when others then rejected:=sqlstate; end;
    if rejected is distinct from ${q(code)} then raise exception 'Wrong rejection: ${label}: %',rejected; end if;
    if parent is distinct from (select to_jsonb(w) from public.work_orders w where id=${q(f.work)}) then
      raise exception 'Rejected manual intake changed parent'; end if;
    end; $probe$;`,actor,false,before);
  checks.push(label);
}
for(const options of [{},{capital:true},{closed:true}]){
  const f=priorInvoiceFixture({...options,noPreviousAssignment:true}),command=call(f);
  priorSqlAs(`do $probe$ declare r jsonb; again jsonb; parent jsonb; context jsonb; summary jsonb; begin
    select to_jsonb(w) into parent from public.work_orders w where id=${q(f.work)};
    context:=public.get_prior_contractor_invoice_context_v1(${q(f.work)});
    if context->'manualIntake'->>'eligible'<>'true' then raise exception 'Missing manual eligibility'; end if;
    r:=${command}; again:=${command};
    if r->'assignmentId'<>'null'::jsonb or r->>'manualContractorId'<>${q(vendor)}
      or again->>'applied'<>'false' then raise exception 'Manual identity/replay mismatch'; end if;
    if parent is distinct from (select to_jsonb(w) from public.work_orders w where id=${q(f.work)})
      or exists(select 1 from public.work_order_assignment_history where work_order_id=${q(f.work)}) then
      raise exception 'Manual intake fabricated assignment history or changed parent'; end if;
    if not exists(select 1 from public.invoices where id=(r->>'invoiceId')::uuid and manual_contractor_bill
      and prior_assignment_id is null and prior_assignment_note is null and contractor_id=${q(vendor)}::uuid
      and total=125.50 and subtotal=120 and sales_tax=5.50) then raise exception 'Manual invoice shape incorrect'; end if;
    summary:=public.get_invoice_summary_v1((r->>'invoiceId')::uuid);
    if summary->>'manual_contractor_bill'<>'true' then raise exception 'Manual header marker missing'; end if;
    if not exists(select 1 from public.activities where id=(r->>'activityId')::uuid and is_staff_only
      and event_data->>'intakeSource'='staff_verified_manual' and event_data->>'verified'='true') then
      raise exception 'Missing explicit verification audit'; end if;
    begin perform public.submit_prior_contractor_invoice_v1((r->>'invoiceId')::uuid,(r->>'invoiceVersion')::bigint,
      ${f.assignment},${f.cycle},gen_random_uuid()); raise exception 'Missing original PDF accepted';
      exception when sqlstate '22023' then null; end;
    end; $probe$;`);
  checks.push(`draft, replay, tax, exact header, audit, missing-PDF rejection and unchanged full parent ${JSON.stringify(options)}`);
}
const f=priorInvoiceFixture({noPreviousAssignment:true});
for(const actor of ['e2e.controller@p1.invalid','e2e.direct@p1.invalid','e2e.company.admin@p1.invalid','e2e.invoice.tech@p1.invalid','e2e.va.coordinator@p1.invalid'])
  denied(f,call(f),'42501',`forbidden actor ${actor}`,actor);
denied(f,call(f,{vendor:current}),'22023','current contractor cannot use earlier-work fallback');
denied(f,call(f,{vendor:tech}),'22023','technician is not a canonical assignable contractor');
denied(f,call(f,{assignment:f.assignment+1}),'PT409','stale assignment version');
denied(f,call(f,{cycle:f.cycle+1}),'PT409','stale workflow cycle');
const payload={num:'SYNTHETIC-INVALID',invoiceDate:f.day,total:125.50,salesTax:5.50,note:'Verified original bill',verified:true};
for(const extra of [{verified:false},{verified:'true'},{total:0},{total:1.001},{salesTax:999},{note:'     '},
  {invoiceDate:'2999-01-01'},{assignmentId:randomUUID()}])
  denied(f,call(f,{payload:{...payload,...extra}}),'22023',`invalid manual payload ${checks.length}`);
denied(f,call(f),'22023','email-source WO cannot use manual fallback',undefined,
  `update public.work_orders set source='email' where id=${q(f.work)};`);
const historical=priorInvoiceFixture();
denied(historical,call(historical),'22023','recorded history must use recorded-assignment workflow');
denied(f,call(f),'42501','revoked operational staff denied','e2e.manager@p1.invalid',
  "update public.profiles set active=false where email='e2e.manager@p1.invalid';");
const r=JSON.parse(priorSqlAs(`select ${call(f)};`,undefined,true).split('\n').at(-1));
denied(f,call(f,{payload:{...payload,num:r.invoiceNum}}),'23505','duplicate vendor invoice number');
denied(f,call(f,{invoice:r.invoiceId,version:999}),'PT409','stale retained draft version');
for(const actor of ['e2e.direct@p1.invalid','e2e.company.admin@p1.invalid']){
  assert.equal(priorSqlAs(`select count(*) from public.invoices where id=${q(r.invoiceId)}::uuid;`,actor).split('\n').at(-1),'0');
  checks.push(`manual bill staff-only under RLS ${actor}`);
}
priorSqlAs(`do $probe$ begin
  begin update public.invoices set manual_contractor_bill=false,manual_contractor_bill_note=null
    where id=${q(r.invoiceId)}::uuid; raise exception 'Manual provenance mutable'; exception when insufficient_privilege then null; end;
  begin update public.invoices set manual_contractor_bill_note='Unowned changed note'
    where id=${q(r.invoiceId)}::uuid; raise exception 'Manual note mutable without capability'; exception when insufficient_privilege then null; end;
  begin update public.activities set text='Changed manual evidence' where id=${q(r.activityId)}::uuid;
    raise exception 'Manual evidence mutable'; exception when insufficient_privilege then null; end;
  end; $probe$;`);
checks.push('raw provenance/note/audit writes denied');
const ctx=JSON.parse(priorSqlAs(`select public.get_prior_contractor_invoice_context_v1(${q(f.work)});`).split('\n').at(-1));
assert.equal(ctx.drafts[0].manualContractorId,vendor);assert.equal(ctx.drafts[0].assignmentId,null);
checks.push('retained manual draft exposes verified contractor without fake assignment');
console.log(JSON.stringify({passed:checks.length,checks},null,2));
