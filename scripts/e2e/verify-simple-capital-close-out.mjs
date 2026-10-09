// Verified disposable local database only. Every fixture and test is rolled back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkedBillingSql } from "./linked-billing-test-support.mjs";

const report = linkedBillingSql(`begin;
create temp table capital_checks(label text primary key);
create function pg_temp.check_capital(ok boolean,label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'Capital check failed: %',label; end if;
insert into capital_checks values(label); end; $$;
create function pg_temp.capital_actor_call(statement text, actor text default 'e2e.manager@p1.invalid') returns jsonb language plpgsql as $$
declare prior text:=coalesce(current_setting('request.jwt.claims',true),'{}'); result jsonb;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',
    (select id from public.profiles where email=actor))::text,true);
  begin execute statement into result;
  exception when others then perform set_config('request.jwt.claims',prior,true); raise; end;
  perform set_config('request.jwt.claims',prior,true); return result;
end; $$;
create function pg_temp.reject_capital(statement text, expected text, label text, actor text default 'e2e.manager@p1.invalid') returns void language plpgsql as $$
declare message text;
begin
  begin perform pg_temp.capital_actor_call(statement,actor);
  exception when others then message:=sqlerrm; end;
  perform pg_temp.check_capital(position(expected in coalesce(message,''))>0,label);
end; $$;
create function pg_temp.capital_fixture(state public.invoice_state default 'approved', recorded boolean default true,
  capital boolean default true, has_document boolean default true) returns jsonb language plpgsql as $$
declare work text:='E2E-SIMPLE-CAP-'||left(gen_random_uuid()::text,8); doc uuid:=gen_random_uuid();
begin
  insert into public.work_orders(id,status,functional_status,is_capital,store_number,summary)
    values(work,case when capital then 'capital'::public.wo_status else 'pending_invoice'::public.wo_status end,
      'Work in Progress',capital,'E2E001','Synthetic capital closeout only');
  if has_document then
    insert into public.invoices(id,num,work_order_id,invoice_type,state,invoice_date,subtotal,sales_tax,total)
      values(doc,'SYNTHETIC-'||work,work,'staff',state,current_date,100,0,100);
    insert into public.invoice_lines(invoice_id,position,type,qty,rate,is_taxable)
      values(doc,1,'Labor',1,100,false);
  else doc:=null; end if;
  if recorded then
    insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,workflow_cycle,is_staff_only)
      values(work,'Synthetic staff','Synthetic quote submitted','system','capital_quote_submitted',jsonb_build_object('invoiceId',doc),0,true);
    if capital then update public.work_orders set status='pending_capital_completion',functional_status='Pending Capital Completion' where id=work; end if;
  end if;
  return jsonb_build_object('work',work,'doc',doc);
end; $$;
create function pg_temp.capital_command(fixture jsonb, outcome text default 'billed', mark_submitted boolean default false, operation uuid default gen_random_uuid()) returns text language sql as $$
select format('select public.close_out_capital_v1(%L,%s,%s,%s,%L,%L::jsonb)',w.id,w.contractor_assignment_version,
  w.workflow_cycle,w.lifecycle_version,operation,jsonb_build_object('outcome',outcome,'confirmed',true,'documentId',i.id,
    'invoiceVersion',i.invoice_version,'markQuoteSubmitted',mark_submitted,
    'quoteReference',case when i.id is null then 'SYNTHETIC-EXTERNAL-QUOTE' else '' end,
    'invoiceReference',case when outcome='billed' then coalesce(i.num,'SYNTHETIC-EXTERNAL-BILL') else '' end,
    'billedOn',case when outcome='billed' then ((clock_timestamp() at time zone 'America/New_York')::date-1)::text else null end)::text)
from public.work_orders w left join public.invoices i on i.id=(fixture->>'doc')::uuid where w.id=fixture->>'work'; $$;

do $tests$
declare f jsonb; result jsonb; command text; prior text; work public.work_orders%rowtype;
  actor uuid:=(select id from public.profiles where email='e2e.direct@p1.invalid'); final_doc uuid;
begin
  f:=pg_temp.capital_fixture(); command:=pg_temp.capital_command(f); prior:=(select to_jsonb(i)::text from public.invoices i where id=(f->>'doc')::uuid);
  result:=pg_temp.capital_actor_call(command);
  perform pg_temp.check_capital(result->>'workOrderStatus'='closed' and result->>'functionalStatus'='Completed','billed capital goes to History');
  perform pg_temp.check_capital((select capital_status='Installed' and closed_at is not null from public.work_orders where id=f->>'work'),'installation and closure recorded');
  perform pg_temp.check_capital((select to_jsonb(i)::text=prior from public.invoices i where id=(f->>'doc')::uuid),'sent quote byte-for-byte unchanged');
  perform pg_temp.check_capital((select count(*)=1 from public.invoices where work_order_id=f->>'work'),'no second invoice created');
  perform pg_temp.check_capital((select count(*)=1 from public.work_order_external_billings where work_order_id=f->>'work'),'existing bill evidence recorded once');
  perform pg_temp.check_capital(result->'invoiceCreated'='false'::jsonb and result->'csvExported'='false'::jsonb,'no invoice creation or export in receipt');
  perform pg_temp.check_capital(pg_temp.capital_actor_call(command)->'applied'='false'::jsonb,'same-operation retry is idempotent');
  perform pg_temp.reject_capital(replace(command,'"invoiceReference": "SYNTHETIC-'||(f->>'work')||'"','"invoiceReference": "DIFFERENT"'),
    'Operation identity was reused','same operation cannot carry changed billing facts');
  perform pg_temp.check_capital((select count(*)=1 from public.work_order_external_billings where work_order_id=f->>'work'),'retries never duplicate billing evidence');
  perform pg_temp.reject_capital(format('insert into public.activities(work_order_id,author_name,text,type,event_key,event_data) values(%L,%L,%L,%L,%L,%L::jsonb)',
    f->>'work','Synthetic staff','Synthetic forged billing','system','staff_billing',
    jsonb_build_object('action','billed_to_7_eleven','invoiceId',f->>'doc')::text),
    'must be created by the billing workflow','direct billing activity remains forbidden');
  perform pg_temp.reject_capital(format('update public.activities set text=%L where id=%L::uuid',
    'Synthetic altered confirmation',result->>'activityId'),'immutable','capital outcome evidence is immutable');
  perform pg_temp.reject_capital(replace(command,'"confirmed": true','"confirmed": false'),'CAPITAL_CLOSE_INVALID_INPUT','no closure without explicit confirmation');
  perform pg_temp.reject_capital(replace(command,'"outcome": "billed"','"outcome": "send_to_billing"'),'CAPITAL_CLOSE_INVALID_INPUT','billing facts cannot leak into unbilled outcome');

  f:=pg_temp.capital_fixture('draft',false); command:=pg_temp.capital_command(f);
  perform pg_temp.reject_capital(command,'CAPITAL_CLOSE_SUBMISSION_REQUIRED','unsubmitted draft needs inline submission confirmation');
  perform pg_temp.check_capital((select state='draft' from public.invoices where id=(f->>'doc')::uuid),'rejection leaves draft unchanged');
  result:=pg_temp.capital_actor_call(pg_temp.capital_command(f,'billed',true));
  perform pg_temp.check_capital(result->>'workOrderStatus'='closed','draft quote can be submitted and closed in one transaction');
  perform pg_temp.check_capital((select state='approved' and document_kind='capital_quote' from public.invoices where id=(f->>'doc')::uuid),'submission keeps quote classification');
  perform pg_temp.check_capital((select count(*)=1 from public.activities where work_order_id=f->>'work' and event_key='capital_quote_submitted'),'inline submission evidence recorded once');

  f:=pg_temp.capital_fixture('approved',false);
  update public.work_orders set status='pending_invoice',functional_status='Completed' where id=f->>'work';
  final_doc:=gen_random_uuid();
  insert into public.invoices(id,num,work_order_id,invoice_type,document_kind,state,invoice_date,total)
    values(final_doc,'SYNTHETIC-CONFLICT-'||(f->>'work'),f->>'work','staff','invoice','draft',current_date,100);
  update public.work_orders set status='capital',functional_status='Work in Progress' where id=f->>'work';
  command:=pg_temp.capital_command(f,'billed',true);
  prior:=(select to_jsonb(i)::text from public.invoices i where id=(f->>'doc')::uuid);
  perform pg_temp.reject_capital(command,'EXTERNAL_BILLING_PORTAL_INVOICE_EXISTS','final-invoice conflict rolls back an inline submission');
  perform pg_temp.check_capital((select to_jsonb(i)::text=prior from public.invoices i where id=(f->>'doc')::uuid),'rejected inline submission leaves original quote unchanged');
  perform pg_temp.check_capital((select count(*)=0 from public.activities where work_order_id=f->>'work' and event_key in ('capital_quote_submitted','capital_close_out_recorded')),'no partial submission or completion audit on rejected billing');
  perform pg_temp.check_capital((select status='capital' and closed_at is null from public.work_orders where id=f->>'work'),'rejected billing does not advance capital stage');

  f:=pg_temp.capital_fixture('approved',false,true,false);
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_SUBMISSION_REQUIRED','external quote requires explicit submission approval');
  command:=pg_temp.capital_command(f,'billed',true); result:=pg_temp.capital_actor_call(command);
  perform pg_temp.check_capital(result->>'workOrderStatus'='closed' and result->'documentId'='null'::jsonb,'external quote closes against actual bill without a P1 document');
  perform pg_temp.check_capital((select count(*)=0 from public.invoices where work_order_id=f->>'work'),'external quote closeout creates no invoice');
  perform pg_temp.check_capital((select count(*)=1 from public.external_capital_quote_handoffs where work_order_id=f->>'work'),'external quote approval recorded once');
  perform pg_temp.check_capital(pg_temp.capital_actor_call(command)->'applied'='false'::jsonb,'external quote retry is idempotent');
  f:=pg_temp.capital_fixture('approved',false,true,false);
  perform pg_temp.capital_actor_call(pg_temp.capital_command(f,'send_to_billing',true));
  perform pg_temp.check_capital((select status='pending_invoice' and closed_at is null from public.work_orders where id=f->>'work'),'external quote can go to billing while staying open');
  perform pg_temp.check_capital((select count(*)=0 from public.work_order_external_billings where work_order_id=f->>'work'),'external unbilled outcome records no bill');

  f:=pg_temp.capital_fixture();
  perform pg_temp.reject_capital(pg_temp.capital_command(f||jsonb_build_object('doc',null),'billed',true),
    'CAPITAL_CLOSE_REVIEW_DOCUMENTS','omitting an existing P1 document cannot bypass review');

  f:=pg_temp.capital_fixture('submitted',false);
  result:=pg_temp.capital_actor_call(pg_temp.capital_command(f,'send_to_billing',true));
  perform pg_temp.check_capital(result->>'workOrderStatus'='pending_invoice','unbilled outcome goes to billing');
  perform pg_temp.check_capital((select status='pending_invoice' and closed_at is null from public.work_orders where id=f->>'work'),'unbilled capital remains open');
  perform pg_temp.check_capital((select count(*)=0 from public.work_order_external_billings where work_order_id=f->>'work'),'sending to billing does not fabricate billing');
  final_doc:=gen_random_uuid();
  insert into public.invoices(id,num,work_order_id,invoice_type,state,invoice_date,subtotal,sales_tax,total)
    values(final_doc,'SYNTHETIC-FINAL-'||(f->>'work'),f->>'work','staff','draft',current_date,100,0,100);
  insert into public.invoice_lines(invoice_id,position,type,qty,rate,is_taxable) values(final_doc,1,'Labor',1,100,false);
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'EXTERNAL_BILLING_PORTAL_INVOICE_EXISTS','quote cannot close against a second existing final invoice');
  f:=f||jsonb_build_object('doc',final_doc);
  result:=pg_temp.capital_actor_call(pg_temp.capital_command(f));
  perform pg_temp.check_capital(result->>'workOrderStatus'='closed','existing final invoice can be confirmed without another invoice');
  perform pg_temp.check_capital((select state='approved' from public.invoices where id=final_doc),'existing final invoice actual billing recorded');

  f:=pg_temp.capital_fixture('approved',false);
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_SUBMISSION_REQUIRED','approved state alone is not submission evidence');
  result:=pg_temp.capital_actor_call(pg_temp.capital_command(f,'billed',true));
  perform pg_temp.check_capital(result->>'workOrderStatus'='closed','missing submission audit can be recorded inline');

  f:=pg_temp.capital_fixture(); update public.invoices set qbo_invoice_id='SYNTHETIC-QBO',qbo_synced_at=now() where id=(f->>'doc')::uuid;
  prior:=(select to_jsonb(i)::text from public.invoices i where id=(f->>'doc')::uuid);
  perform pg_temp.capital_actor_call(pg_temp.capital_command(f));
  perform pg_temp.check_capital((select to_jsonb(i)::text=prior from public.invoices i where id=(f->>'doc')::uuid),'synced quote never rewritten or exported again');

  f:=pg_temp.capital_fixture();
  update public.work_orders set contractor_id=actor,contractor_assignment_started_at=now()-interval '2 hours' where id=f->>'work';
  insert into public.work_order_visits(work_order_id,contractor_id,check_in_at,checked_in_by) values(f->>'work',actor,now()-interval '1 hour',actor);
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_OPEN_VISIT','open visit blocks billed closure');
  perform pg_temp.reject_capital(pg_temp.capital_command(f,'send_to_billing'),'CAPITAL_CLOSE_OPEN_VISIT','open visit blocks completion-to-billing');
  perform pg_temp.check_capital((select count(*)=1 from public.work_order_visits where work_order_id=f->>'work' and check_out_at is null),'closeout never manufactures checkout');

  f:=pg_temp.capital_fixture();
  update public.work_orders set contractor_id=actor,contractor_assignment_started_at=now()-interval '2 hours' where id=f->>'work';
  insert into public.invoices(num,work_order_id,invoice_type,contractor_id,state,invoice_date,total,created_at)
    values('SYNTHETIC-UNREVIEWED',f->>'work','contractor',actor,'draft',current_date,50,clock_timestamp());
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_UNRESOLVED_INVOICES','outstanding contractor reviews block billed closure');
  perform pg_temp.check_capital(pg_temp.capital_actor_call(pg_temp.capital_command(f,'send_to_billing'))->>'workOrderStatus'='pending_invoice','unresolved reviews can remain in billing without closure');

  f:=pg_temp.capital_fixture();
  insert into public.activities(work_order_id,author_id,author_name,text,type,activity_channel)
    values(f->>'work',actor,'Synthetic staff','Synthetic pending update','note','field_note');
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_PENDING_UPDATES','pending customer update blocks billed closure');
  f:=pg_temp.capital_fixture();
  select * into work from public.work_orders where id=f->>'work';
  perform pg_temp.capital_actor_call(format('select public.run_capital_self_service_v1(%L,%s,%s,%s,%L,%L,%L::jsonb)',
    work.id,work.contractor_assignment_version,work.workflow_cycle,work.lifecycle_version,gen_random_uuid(),'capital_quote_revision',
    jsonb_build_object('confirmed',true,'note','Synthetic local-only revision','quoteId',f->>'doc',
      'invoiceVersion',(select invoice_version from public.invoices where id=(f->>'doc')::uuid))::text));
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_PENDING_REVISION','pending quote revision blocks both outcomes');
  perform pg_temp.reject_capital(pg_temp.capital_command(f,'send_to_billing'),'CAPITAL_CLOSE_PENDING_REVISION','unsubmitted revision is not skipped for billing');

  f:=pg_temp.capital_fixture(); command:=pg_temp.capital_command(f);
  perform pg_temp.reject_capital(command,'EXTERNAL_BILLING_FORBIDDEN','contractor denied','e2e.direct@p1.invalid');
  perform pg_temp.reject_capital(command,'EXTERNAL_BILLING_FORBIDDEN','invoice controller denied','e2e.controller@p1.invalid');
  perform pg_temp.reject_capital(command,'EXTERNAL_BILLING_FORBIDDEN','unknown actor denied','nobody@p1.invalid');
  perform pg_temp.reject_capital(replace(command,'"billedOn": "'||((clock_timestamp() at time zone 'America/New_York')::date-1)::text||'"','"billedOn": null'),
    'CAPITAL_CLOSE_BILLING_REQUIRED','missing billing date cannot close');
  perform pg_temp.reject_capital(replace(command,'"invoiceReference": "SYNTHETIC-'||(f->>'work')||'"','"invoiceReference": ""'),
    'CAPITAL_CLOSE_BILLING_REQUIRED','missing billed reference cannot close');
  perform pg_temp.reject_capital(replace(command,'"billedOn": "'||((clock_timestamp() at time zone 'America/New_York')::date-1)::text||'"',
    '"billedOn": "'||((clock_timestamp() at time zone 'America/New_York')::date+1)::text||'"'),
    'CAPITAL_CLOSE_BILLING_REQUIRED','future billing date cannot close');
  -- Owner-maintenance fixtures bypass the version trigger; advance it explicitly.
  update public.invoices set terms='Net 60',invoice_version=invoice_version+1 where id=(f->>'doc')::uuid;
  perform pg_temp.reject_capital(command,'CAPITAL_CLOSE_STALE','stale invoice version denied');
  command:=pg_temp.capital_command(f); update public.work_orders set eta=clock_timestamp()+interval '1 hour' where id=f->>'work';
  perform pg_temp.reject_capital(command,'Work order changed','stale lifecycle version denied');
  f:=pg_temp.capital_fixture('approved',true,false);
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_CAPITAL_ONLY','regular work order rejected without mutation');

  f:=pg_temp.capital_fixture(); update public.work_orders set workflow_cycle=1 where id=f->>'work';
  insert into public.activities(work_order_id,author_name,text,type,event_key,workflow_cycle,created_at)
    values(f->>'work','Synthetic staff','Synthetic reopened cycle','system','work_order_reopened',1,clock_timestamp());
  perform pg_temp.reject_capital(pg_temp.capital_command(f),'CAPITAL_CLOSE_PRIOR_CYCLE','prior-cycle quote is never reused');
  perform pg_temp.check_capital(not has_function_privilege('anon','public.close_out_capital_v1(text,integer,integer,bigint,uuid,jsonb)','execute'),'anonymous execute revoked');
  perform pg_temp.check_capital(has_function_privilege('authenticated','public.close_out_capital_v1(text,integer,integer,bigint,uuid,jsonb)','execute'),'authenticated execute granted with actor guards');
  perform pg_temp.check_capital(not exists(select 1 from public.work_order_lifecycle_transition_guards where transaction_id=txid_current()),'no reusable lifecycle guards remain');
  perform pg_temp.check_capital(not exists(select 1 from public.invoice_financial_transition_guards where transaction_id=txid_current()),'no reusable financial guards remain');
  perform pg_temp.check_capital(not exists(select 1 from public.work_order_close_transition_guards where transaction_id=txid_current()),'no reusable closure guards remain');
end; $tests$;
select jsonb_build_object('mode','synthetic_local_rolled_back','checks',count(*),'passed',jsonb_agg(label order by label)) from capital_checks;
rollback;`);
const parsed = JSON.parse(report);
assert.equal(parsed.mode, "synthetic_local_rolled_back");
assert.ok(parsed.checks >= 60);

// Exercise the actual read-only review query against synthetic rows, not data
// from a hosted environment. Owner fixtures and query are in one rollback.
const audit = readFileSync("supabase/audits/capital_close_out_review.sql", "utf8")
  .replace(/^begin transaction read only;$/m, "").replace(/^rollback;$/m, "");
const rows = linkedBillingSql(`begin; insert into public.work_orders(id,status,functional_status,is_capital,store_number,summary)
  values('E2E-CAP-REVIEW-AUDIT','capital','Work in Progress',true,'E2E001','Synthetic capital review');
  select coalesce(jsonb_agg(to_jsonb(result)),'[]'::jsonb) from (${audit.replace(/--[^\n]*\n/g, "").trim().replace(/;$/, "")}) result
    where result.work_order_id='E2E-CAP-REVIEW-AUDIT'; rollback;`);
const exported = JSON.parse(rows);
assert.equal(exported.length, 1); assert.equal(exported[0].board_stage, "Waiting for quote");
assert.equal(exported[0].action, "review_only_no_writes");
assert.equal(exported[0].mandy_confirms_already_billed, null);
console.log(JSON.stringify({ checks: parsed.checks, reviewQueryChecks: 4, mode: parsed.mode }));
