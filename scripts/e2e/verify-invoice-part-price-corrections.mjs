// Requires approved migration 0185 on the verified disposable local fixture DB.
// All records created here are synthetic and every test transaction rolls back.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {linkedBillingSql as sql} from './linked-billing-test-support.mjs';
assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"),'0');
assert.equal(sql("select to_regclass('public.invoice_part_price_audit') is not null"),'t');
const actors=JSON.parse(sql(`select jsonb_object_agg(email,id) from public.profiles where email in
  ('e2e.manager@p1.invalid','e2e.backoffice@p1.invalid','e2e.direct@p1.invalid','e2e.controller@p1.invalid')`));
const manager=actors['e2e.manager@p1.invalid'], contractor=actors['e2e.direct@p1.invalid'];
const q=value=>value==null?'null':typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;
const j=value=>`${q(JSON.stringify(value))}::jsonb`;
const correction={basis:'purchase_cost',amount:3275.37,reason:'Verified synthetic contractor receipt'};
const results=[];
function fixture({qty=1}={}) {
  const suffix=randomUUID().slice(0,8),work=`E2E-PRICE-${suffix}`,part=randomUUID(),number=`SYNTH-PRICE-${suffix}`;
  const source=randomUUID(),sourceLine=randomUUID();
  const seed=`insert into public.work_orders(id,status,functional_status,contractor_id,contractor_assignment_version,workflow_cycle,lifecycle_version,
    contractor_assignment_started_at,store_number,store_state,summary,nte)
    values(${q(work)},'completed','Completed',${q(contractor)},1,0,3,now()-interval '1 day','E2E001','TX','Synthetic price correction',1000);
    insert into public.wo_parts(id,work_order_id,description,qty) values(${q(part)},${q(work)},'Synthetic compressor',${qty});
    do $purchasing$ begin perform set_config('request.jwt.claims',${j({role:'authenticated',sub:manager})}::text,true);end $purchasing$;
    set local role authenticated;
    do $purchasing$ begin perform public.request_p1_part_order(${q(part)}::uuid);
      perform public.set_p1_part_order_status_with_cost(${q(part)}::uuid,'ordered',1.01);end $purchasing$;
    reset role;
    do $clear$ begin perform set_config('request.jwt.claims','{}',true);end $clear$;`;
  const line={type:'Parts/Hardware',description:'Synthetic compressor',qty,rate:4094.21,isTaxable:false,
    sourceWorkOrderPartId:part,sourceInvoiceLineId:null,sourceUnitCost:1.01,markupPercent:25,priceCorrection:correction};
  const payload=(overrides={})=>({num:number,userTypedNum:true,storeNumber:'E2E001',storeAddress:null,cme:null,
    invoiceDate:'2026-11-25',serviceDate:null,dueDate:null,terms:'Net 30',state:'draft',territory:'Texas',
    equipmentTag:'7-ELEVEN: Refrigeration',taxState:'TX',taxMode:'none',salesTaxOverride:null,taxRateOverride:null,
    lines:[line],sourceInvoiceIds:[],...overrides});
  const call=(p=payload(),{actor=manager,op=randomUUID(),invoice='null',version='null',assignment=1,cycle=0}={})=>
    `public.save_staff_billing_invoice_v4(${q(actor)}::uuid,${q(work)},${assignment},${cycle},${invoice},${version},${q(op)}::uuid,${j(p)})`;
  return {seed,line,work,part,number,payload,call,source,sourceLine};
}
function run(label,f,body,{code=null,validate=()=>{},role='service_role',user=null}={}) {
  const query=`begin;set local statement_timeout='15s';${f.seed}
    do $claims$ begin perform set_config('request.jwt.claims',${j({role,...(user?{sub:user}:{})})}::text,true);end $claims$;
    set local role ${role};
    do $probe$ declare r jsonb;r2 jsonb;rejected text;message text; begin
      begin ${body} exception when others then get stacked diagnostics rejected=returned_sqlstate,message=message_text;end;
      perform set_config('p1.price_result',jsonb_build_object('result',r,'second',r2,'code',rejected,'message',message)::text,true);
    end $probe$;
    reset role;
    do $clear$ begin perform set_config('request.jwt.claims','{}',true);end $clear$;
    select jsonb_build_object('outcome',current_setting('p1.price_result')::jsonb,
      'purchaseCost',(select unit_cost from public.p1_part_costs where part_id=${q(f.part)}),
      'invoices',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'state',i.state,'version',i.invoice_version,'subtotal',i.subtotal,
        'tax',i.sales_tax,'total',i.total,'lines',(select jsonb_agg(to_jsonb(l) order by l.position) from public.invoice_lines l where l.invoice_id=i.id))),'[]'::jsonb)
        from public.invoices i where i.work_order_id=${q(f.work)} and i.invoice_type='staff'),
      'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at),'[]'::jsonb) from public.invoice_part_price_audit a
        join public.invoices i on i.id=a.invoice_id where i.work_order_id=${q(f.work)}),
      'operations',(select count(*) from public.invoice_financial_operations where work_order_id=${q(f.work)}));
    rollback;`;
  try {
    const result=JSON.parse(sql(query));assert.equal(result.outcome.code,code,`${label}: ${result.outcome.message}`);
    assert.equal(result.purchaseCost,1.01,'Purchasing source cost changed');validate(result);
    results.push({label,status:'PASS'});console.log(`PASS ${label}`);
  } catch(error) {console.error(`FAIL ${label}: ${String(error.stderr??error.message)}`);throw error;}
}
function validSaved(r,rate=4094.21,qty=1) {
  assert.equal(r.invoices.length,1);const i=r.invoices[0];assert.equal(i.lines[0].rate,rate);
  assert.equal(i.lines[0].source_unit_cost,1.01);assert.equal(i.subtotal,rate*qty);
  assert.equal(r.audit.length,1);assert.equal(r.audit[0].actor_id,manager);
  assert.equal(r.audit[0].correction.reason,correction.reason);
}
{
  const f=fixture();run('purchase-cost correction saves exact marked-up price and audit',f,`r:=${f.call()};`,{validate:r=>validSaved(r)});
}
{
  const f=fixture({qty:2});run('unit correction respects quantity and calculates sales tax separately',f,
    `r:=${f.call(f.payload({taxMode:'manual_rate',taxRateOverride:10,lines:[{...f.line,isTaxable:true}]}))};`,{
      validate:r=>{validSaved(r,4094.21,2);assert.equal(r.invoices[0].tax,818.84);assert.equal(r.invoices[0].total,9007.26);}});
}
{
  const f=fixture();run('exact final price is not marked up a second time',f,`r:=${f.call(f.payload({lines:[{...f.line,
    rate:3275.37,markupPercent:null,priceCorrection:{...correction,basis:'billing_rate'}}]}))};`,{
      validate:r=>{validSaved(r,3275.37);assert.equal(r.invoices[0].lines[0].markup_percent,null);}});
}
{
  const f=fixture();const op=randomUUID(),command=f.call(f.payload(),{op});
  run('unchanged operation replay retains one invoice and one audit entry',f,`r:=${command};r2:=${command};`,{
    validate:r=>{validSaved(r);assert.equal(r.outcome.second.reason,'already_applied');assert.equal(r.operations,1);}});
}
{
  const f=fixture();run('reopen current-version line page preserves correction reason',f,`r:=${f.call()};
    r2:=public.list_invoice_lines_page_v1((r->>'invoiceId')::uuid,50,null,(r->>'invoiceVersion')::bigint);`,{
    validate:r=>{validSaved(r);assert.deepEqual(r.outcome.second.items[0].price_correction,correction);}});
}
{
  const f=fixture();const restored={...f.line,rate:1.26,markupPercent:25,priceCorrection:null};
  run('explicit restore retains source and creates correction-history entry',f,`r2:=${f.call()};
    r:=${f.call(f.payload({lines:[restored]}),{invoice:"(r2->>'invoiceId')::uuid",version:"(r2->>'invoiceVersion')::bigint"})};`,{
    validate:r=>{assert.equal(r.invoices.length,1);assert.equal(r.invoices[0].lines[0].rate,1.26);
      assert.equal(r.invoices[0].lines[0].price_correction,null);assert.equal(r.audit.length,2);
      assert.equal(r.audit[1].previous_correction.reason,correction.reason);assert.equal(r.audit[1].correction,null);}});
}
{
  const f=fixture();run('ordinary re-save retains override without duplicate price-audit entry',f,`r2:=${f.call()};
    r:=${f.call(f.payload(),{invoice:"(r2->>'invoiceId')::uuid",version:"(r2->>'invoiceVersion')::bigint"})};`,{
    validate:r=>{validSaved(r);assert.equal(r.operations,2);}});
}
for(const omitted of [false,true]) {
  const f=fixture();const oldLine={...f.line,rate:1.26};delete oldLine.priceCorrection;
  const legacyLines=omitted?[{type:'Labor',description:'Synthetic old-client line',qty:1,rate:10,isTaxable:false}]:[oldLine];
  run(`old client ${omitted?'omitting corrected P1 line':'dropping correction metadata'} cannot silently restore price`,f,`
    r2:=${f.call()};
    begin perform ${f.call(f.payload({lines:legacyLines}),{invoice:"(r2->>'invoiceId')::uuid",version:"(r2->>'invoiceVersion')::bigint"})};
    exception when sqlstate 'PT409' then r:=jsonb_build_object('oldClientRejected',true);end;`,{
      validate:r=>{validSaved(r);assert.equal(r.outcome.result.oldClientRejected,true);assert.equal(r.operations,1);}});
}
for(const [label,line] of [
  ['missing correction reason',{priceCorrection:{...correction,reason:'short'}}],
  ['unknown correction fields',{priceCorrection:{...correction,actorId:manager}}],
  ['invalid amount precision',{priceCorrection:{...correction,amount:1.001}}],
  ['zero correction amount',{priceCorrection:{...correction,amount:0}}],
  ['negative correction amount',{priceCorrection:{...correction,amount:-1}}],
  ['numeric string amount',{priceCorrection:{...correction,amount:'3275.37'}}],
  ['changed rate without correction',{priceCorrection:null}],
  ['forged recorded source cost',{sourceUnitCost:100}],
  ['wrong corrected rate',{rate:3275.37}],
  ['wrong correction markup',{markupPercent:100}],
  ['price override on labor',{type:'Labor'}],
]) {
  const f=fixture();run(`rejects ${label} without invoice/audit leftovers`,f,`r:=${f.call(f.payload({lines:[{...f.line,...line}]}))};`,{
    code:['changed rate without correction','forged recorded source cost'].includes(label)?'23514':'22023',
    validate:r=>{assert.equal(r.invoices.length,0);assert.equal(r.audit.length,0);assert.equal(r.operations,0);}});
}
for(const [email,label] of [['e2e.direct@p1.invalid','contractor'],['e2e.controller@p1.invalid','controller']]) {
  const f=fixture();run(`service command refuses ${label} actor`,f,`r:=${f.call(f.payload(),{actor:actors[email]})};`,{code:'42501'});
  const f2=fixture();run(`${label} has no price audit visibility`,f2,
    `r:=jsonb_build_object('visible',(select count(*) from public.invoice_part_price_audit));`,{
    role:'authenticated',user:actors[email],validate:r=>assert.equal(r.outcome.result.visible,0)});
}
{
  const f=fixture();run('authenticated staff cannot call service-only save directly',f,`r:=${f.call()};`,{
    code:'42501',role:'authenticated',user:manager});
}
{
  const f=fixture();run('stale edit fails without altering saved correction or audit',f,`r2:=${f.call()};
    begin perform ${f.call(f.payload(),{invoice:"(r2->>'invoiceId')::uuid",version:"(r2->>'invoiceVersion')::bigint-1"})};
    exception when sqlstate 'PT409' then r:=jsonb_build_object('staleRejected',true);end;`,{
    validate:r=>{validSaved(r);assert.equal(r.outcome.result.staleRejected,true);assert.equal(r.operations,1);}});
}
{
  const f=fixture();run('a P1 source still cannot be billed twice on different invoices',f,`r2:=${f.call()};
    r:=${f.call(f.payload({num:`${f.number}-SECOND`}))};`,{code:'55000',validate:r=>{
      // The exception subtransaction rolls back both calls, not merely the second.
      assert.equal(r.invoices.length,0);assert.equal(r.audit.length,0);}});
}
for(const [field,value] of [['state','paid'],['qbo_invoice_id','synthetic-qbo-id'],['qbo_synced_at','2026-11-25T00:00:00Z']]) {
  const f=fixture();const invoice=randomUUID();
  f.seed+=`insert into public.invoices(id,num,work_order_id,invoice_type,state,invoice_date,subtotal,sales_tax,total,${field==='state'?'terms':field})
    values(${q(invoice)},${q(f.number)},${q(f.work)},'staff',${q(field==='state'?value:'draft')},current_date,1,0,1,${q(field==='state'?'Net 30':value)});`;
  run(`locked ${field} invoice rejects price edit`,f,`r:=${f.call(f.payload(),{invoice:`${q(invoice)}::uuid`,version:'0'})};`,{
    code:'55000',validate:r=>{assert.equal(r.audit.length,0);assert.equal(r.operations,0);assert.equal(r.invoices[0].total,1);}});
}
{
  const f=fixture(),invoice=randomUUID();
  f.seed+=`insert into public.invoices(id,num,work_order_id,invoice_type,state,invoice_date,subtotal,sales_tax,total)
    values(${q(invoice)},${q(f.number)},${q(f.work)},'staff','submitted',current_date,1,0,1);
    insert into public.activities(work_order_id,author_id,author_name,type,event_key,event_data,text)
      values(${q(f.work)},${q(manager)},'Synthetic staff','system','staff_billing',
        jsonb_build_object('action','billed_to_7_eleven','invoiceId',${q(invoice)}),'Synthetic historical billed marker');`;
  run('historical billed marker locks unsynced submitted invoice too',f,
    `r:=${f.call(f.payload(),{invoice:`${q(invoice)}::uuid`,version:'0'})};`,{code:'55000',validate:r=>{
      assert.equal(r.audit.length,0);assert.equal(r.operations,0);assert.equal(r.invoices[0].total,1);}});
}
{
  const f=fixture();const line={...f.line,rate:1.26};delete line.priceCorrection;
  const command=f.call(f.payload({lines:[line]}));
  run('uncorrected default pricing stays replay compatible and creates no correction audit',f,`r:=${command};r2:=${command};`,{
    validate:r=>{assert.equal(r.invoices[0].total,1.26);assert.equal(r.audit.length,0);
      assert.equal(r.outcome.second.reason,'already_applied');}});
}
{
  const f=fixture();f.seed+=`create function pg_temp.reject_synthetic_price_audit() returns trigger language plpgsql as $fail$
    begin raise exception using errcode='23514',message='Synthetic audit failure';end $fail$;
    create trigger synthetic_price_audit_failure before insert on public.invoice_part_price_audit
      for each row execute function pg_temp.reject_synthetic_price_audit();`;
  run('audit failure rolls back invoice, source links and operation together',f,`r:=${f.call()};`,{code:'23514',
    validate:r=>{assert.equal(r.invoices.length,0);assert.equal(r.audit.length,0);assert.equal(r.operations,0);}});
}
{
  const f=fixture();f.seed+=`insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,state,invoice_date,subtotal,sales_tax,total)
    values(${q(f.source)},${q(`${f.number}-CONTRACTOR`)},${q(f.work)},${q(contractor)},'contractor','submitted',current_date,100,0,100);
    insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
    values(${q(f.sourceLine)},${q(f.source)},1,'Parts/Hardware','Synthetic contractor-supplied part',1,100);`;
  const contractorLine={...f.line,sourceWorkOrderPartId:null,sourceInvoiceLineId:f.sourceLine,sourceUnitCost:100};
  run('contractor-sourced correction retains its source invoice and original cost',f,
    `r:=${f.call(f.payload({lines:[contractorLine],sourceInvoiceIds:[f.source]}))};`,{validate:r=>{
      const line=r.invoices[0].lines.find(l=>l.source_invoice_line_id===f.sourceLine);
      assert.equal(line.rate,4094.21);assert.equal(line.source_unit_cost,100);assert.deepEqual(line.price_correction,correction);
      assert.equal(r.audit.length,1);assert.equal(r.invoices[0].lines.length,2,'Required P1 part remains separately sourced');}});
}
console.log(JSON.stringify({passed:results.length,failed:0,allFixturesRolledBack:true,checks:results},null,2));
