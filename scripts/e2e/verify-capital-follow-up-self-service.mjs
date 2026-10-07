import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { linkedBillingSql as sql, linkedBillingConcurrentSql as concurrent } from "./linked-billing-test-support.mjs";

const quoteText = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quoteText(JSON.stringify(value))}::jsonb`;
const asActor = (statement, email = "e2e.manager@p1.invalid") => `begin;
  do $$ begin perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',
    (select id from public.profiles where email=${quoteText(email)}))::text,true); end; $$;
  set local role authenticated; ${statement}; commit;`;
function reject(statement, expected, email) {
  let error; try { sql(asActor(statement, email)); } catch (cause) { error = String(cause.stderr); }
  assert(error && error.includes(expected), `Expected guarded rejection: ${expected}`);
}
function work(id) { return JSON.parse(sql(`select jsonb_build_object('id',id,'status',status,'functionalStatus',functional_status,
  'assignment',contractor_assignment_version,'cycle',workflow_cycle,'version',lifecycle_version,'capitalStatus',capital_status,
  'closed',closed_at is not null) from public.work_orders where id=${quoteText(id)};`)); }
function capital(action, id, payload, operation = randomUUID(), snapshot = work(id)) {
  return `select public.run_capital_self_service_v1(${quoteText(id)},${snapshot.assignment},${snapshot.cycle},${snapshot.version},
    '${operation}',${quoteText(action)},${json(payload)})`;
}
function createCapital(withQuote = false) {
  const id = `E2E-SELF-CAP-${randomUUID().slice(0,8)}`; const quote = randomUUID();
  sql(`insert into public.work_orders(id,status,functional_status,is_capital,store_number,store_state,summary)
    values('${id}','capital','Work in Progress',true,'E2E001','TX','Synthetic capital self-service');
    ${withQuote ? `insert into public.invoices(id,num,work_order_id,invoice_type,state,invoice_date,store_number,terms,territory,equipment_tag,subtotal,sales_tax,total)
      values('${quote}','SYNTHETIC-QUOTE-${id}','${id}','staff','approved',current_date,'E2E001','Net 60','Texas','7-ELEVEN: Fountain',100,0,100);
      insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable,source_unit_cost)
        values('${quote}',1,'Labor','Synthetic quote labor',1,100,false,60);
      update public.work_orders set status='pending_capital_completion',functional_status='Pending Capital Completion' where id='${id}';
      insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,workflow_cycle,is_staff_only)
        values('${id}','Synthetic Staff','Synthetic capital quote sent','system','capital_quote_submitted',jsonb_build_object('invoiceId','${quote}'),0,true);` : ""}`);
  return { id, quote };
}
const note = "Synthetic local-only confirmed facts";
const external = createCapital(); const extOp = randomUUID(); const extSnapshot = work(external.id);
const extCommand = capital("capital_external_handoff", external.id, { note, reference:"SYNTHETIC-EXTERNAL-QUOTE", confirmed:true },extOp,extSnapshot);
reject(capital("capital_confirmed_completion",external.id,{note,confirmed:true}),"Record the capital quote handoff");
reject(capital("capital_external_handoff",external.id,{note,reference:"SYNTHETIC",confirmed:false}),"Confirm the facts");
reject(extCommand,"LINKED_BILLING_FORBIDDEN","e2e.direct@p1.invalid");
reject(extCommand,"LINKED_BILLING_FORBIDDEN","e2e.controller@p1.invalid");
const extResult = JSON.parse(sql(asActor(extCommand)));
assert.equal(extResult.workOrderStatus,"pending_capital_completion");
assert.equal(JSON.parse(sql(asActor(extCommand))).applied,false);
assert.equal(Number(sql(`select count(*) from public.invoices where work_order_id='${external.id}';`)),0);
const completeResult = JSON.parse(sql(asActor(capital("capital_confirmed_completion",external.id,{note,confirmed:true}))));
assert.equal(completeResult.workOrderStatus,"pending_invoice");
assert.equal(work(external.id).capitalStatus,"Installed"); assert.equal(work(external.id).closed,false);
sql(`insert into public.invoices(work_order_id,invoice_type,num,state,invoice_date,total)
  values('${external.id}','staff','SYNTHETIC-FINAL-${external.id}','draft',current_date,100);`);
assert.equal(sql(`select source_external_capital_quote_id::text from public.invoices where work_order_id='${external.id}';`),extResult.externalQuoteId);
reject(extCommand,"Work order changed");
const sent = createCapital(true); const snapshot = work(sent.id); const revisionOp = randomUUID();
const version = Number(sql(`select invoice_version from public.invoices where id='${sent.quote}';`));
const original = sql(`select to_jsonb(i)::text from public.invoices i where id='${sent.quote}';`);
const revisionCommand = capital("capital_quote_revision",sent.id,{note,confirmed:true,quoteId:sent.quote,invoiceVersion:version},revisionOp,snapshot);
const revision = JSON.parse(sql(asActor(revisionCommand)));
assert(revision.invoiceId); assert.equal(revision.invoiceVersion,Number(sql(`select invoice_version from public.invoices where id='${revision.invoiceId}';`)));
assert.equal(sql(`select to_jsonb(i)::text from public.invoices i where id='${sent.quote}';`),original);
assert.equal(JSON.parse(sql(asActor(revisionCommand))).applied,false);
assert.equal(Number(sql(`select count(*) from public.invoices where revision_of_capital_quote_id='${sent.quote}';`)),1);
assert.equal(sql(`select state::text||':'||source_unit_cost::text from public.invoices i join public.invoice_lines l on l.invoice_id=i.id where i.id='${revision.invoiceId}';`),"draft:60.00");
reject(capital("capital_confirmed_completion",sent.id,{note,confirmed:true}),"Submit the pending capital quote or revision");
reject(capital("capital_external_handoff",sent.id,{note,reference:"SYNTHETIC-DUPLICATE",confirmed:true}),"Review existing portal documents");
reject(`update public.invoices set revision_of_capital_quote_id=null where id='${revision.invoiceId}'`,"permission denied");
assert.equal(sql(`select revision_of_capital_quote_id::text from public.invoices where id='${revision.invoiceId}';`),sent.quote);
const racing = createCapital(); const raceOp = randomUUID();
const raceCommand = asActor(capital("capital_external_handoff",racing.id,{note,confirmed:true,reference:"SYNTHETIC-RACE"},raceOp));
const race = await Promise.all([concurrent(raceCommand),concurrent(raceCommand)]);
assert(race.every(result=>result.code===0)); assert.deepEqual(race.map(result=>JSON.parse(result.output).applied).sort(),[false,true]);

function followUp({cycle=1,mode="billing_follow_up",newStaff=false,newContractor=true,billed=true}={}) {
  const suffix=randomUUID().slice(0,8); const id=`E2E-SELF-FOLLOW-${suffix}`; const target=`E2E-SELF-COVER-${suffix}`;
  const old=randomUUID(); const covering=randomUUID(); const contractor=randomUUID();
  sql(`insert into public.work_orders(id,status,functional_status,workflow_cycle,lifecycle_version,store_number,summary,
      contractor_id,contractor_assignment_version,contractor_assignment_started_at)
    values('${id}','pending_invoice','Completed',0,${cycle ? 6 : 7},'E2E001','Synthetic follow-up source',
      (select id from public.profiles where email='e2e.direct@p1.invalid'),1,now()-interval '3 days'),
      ('${target}','pending_invoice','Completed',0,0,'E2E001','Synthetic destination',null,0,null);
    insert into public.invoices(id,work_order_id,num,invoice_type,state,invoice_date,total,created_at)
      values('${old}','${id}','SYNTHETIC-OLD-${suffix}','staff','approved',current_date-2,111,now()-interval '2 days'),
        ('${covering}','${target}','SYNTHETIC-COVER-${suffix}','staff','submitted',current_date,222,now());
    ${billed ? `insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,workflow_cycle,created_at,is_staff_only)
      values('${id}','Synthetic Staff','Synthetic prior billing','system','staff_billing',jsonb_build_object('action','billed_to_7_eleven','invoiceId','${old}'),0,now()-interval '2 days',true);` : ""}
    ${cycle ? `update public.work_orders set workflow_cycle=${cycle} where id='${id}';` : ""}
    insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,workflow_cycle,created_at,is_staff_only)
      values('${id}','Synthetic Staff','Synthetic reopen','system','work_order_reopened',${json(mode ? {mode} : {})},${cycle},now()-interval '1 day',true);
    ${newContractor ? `insert into public.invoices(id,work_order_id,num,contractor_id,created_by,invoice_type,state,invoice_date,total)
      select '${contractor}','${id}','SYNTHETIC-NEW-${suffix}',id,id,'contractor','paid',current_date,222
        from public.profiles where email='e2e.direct@p1.invalid';` : ""}
    ${newStaff ? `insert into public.invoices(work_order_id,num,invoice_type,state,invoice_date,total)
      values('${id}','SYNTHETIC-NEW-P1-${suffix}','staff','draft',current_date,222);` : ""}`);
  return {id,target,old,covering};
}
function link(f,op=randomUUID()) {
  return `select public.record_work_order_linked_billing_v1('${f.id}',1,${work(f.id).cycle},7,'${op}',
    '${f.target}',0,0,'${f.covering}',0,'Synthetic invoice covers only the follow-up')`;
}
for(const cycle of [0,1]) {
  const f=followUp({cycle,mode:cycle?"billing_follow_up":""}); const before=sql(`select to_jsonb(i)::text from public.invoices i where id='${f.old}';`);
  const op=randomUUID(); const command=link(f,op); const result=JSON.parse(sql(asActor(command)));
  assert.equal(result.workOrderStatus,"closed"); assert.equal(result.followUp.workflowCycle,cycle);
  assert.equal(result.followUp.preservedInvoices[0].id,f.old);
  assert.equal(sql(`select to_jsonb(i)::text from public.invoices i where id='${f.old}';`),before);
  assert.equal(JSON.parse(sql(asActor(command))).applied,false);
}
for(const options of [{newStaff:true},{billed:false},{mode:"invalid"}]) {
  const f=followUp(options); reject(link(f),"LINKED_BILLING_PORTAL_INVOICE_EXISTS"); assert.equal(work(f.id).closed,false);
}
const legacy=followUp({cycle:0,mode:"",newContractor:false});
const closed=JSON.parse(sql(asActor(`select public.close_reopened_work_order_without_additional_billing('${legacy.id}',0,1,
  (select updated_at from public.work_orders where id='${legacy.id}'),'Synthetic resolved follow-up already covered')`)));
assert.equal(work(legacy.id).status,"closed"); assert(closed.applied);
const active=followUp({cycle:0,mode:"",newContractor:false});
sql(`update public.work_orders set status='wip',functional_status='Work in Progress' where id='${active.id}';
  insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
    select '${active.id}',id,id,now()-interval '1 hour' from public.profiles where email='e2e.direct@p1.invalid';`);
reject(`select public.close_reopened_work_order_without_additional_billing('${active.id}',0,1,
  (select updated_at from public.work_orders where id='${active.id}'),'Synthetic resolved already covered')`,"Record the actual visit checkout");
assert.equal(Number(sql(`select count(*) from public.work_order_lifecycle_transition_guards where work_order_id like 'E2E-SELF-%';`)),0);
console.log(JSON.stringify({result:"PASS_CAPITAL_AND_FOLLOW_UP_SELF_SERVICE",syntheticOnly:true,
  coverage:["external-quote-confirmation","no-duplicate-invoice","final-external-quote-link","sent-quote-revision-preserves-original",
    "pending-revision-blocks-completion","roles","replay","stale-replay","concurrent-idempotency",
    "cycle-zero-and-one-link","new-P1-block","missing-handoff-block","legacy-no-billing-close","actual-checkout-required"]}));
