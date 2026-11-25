import assert from 'node:assert/strict';
import {linkedBillingSql as sql} from './linked-billing-test-support.mjs';
import {priorSqlAs,quotePrior as q} from './prior-contractor-invoice-fixtures.mjs';
assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"),'0');
const sample=JSON.parse(sql(`select jsonb_build_object('invoice',i.id,'work',i.work_order_id,'path',i.pdf_storage_path)
  from public.invoices i where i.manual_contractor_bill and i.state='submitted' and i.pdf_storage_path is not null
  and i.deleted_at is null order by i.created_at desc limit 1`));
assert.ok(sample?.invoice,'Run the manual browser upload scenarios first');
const checks=[];
for(const actor of ['e2e.manager@p1.invalid','e2e.dispatcher@p1.invalid','e2e.backoffice@p1.invalid']){
  priorSqlAs(`do $probe$ declare r jsonb; parent jsonb; before_history bigint; begin
    select to_jsonb(w) into parent from public.work_orders w where id=${q(sample.work)};
    select count(*) into before_history from public.work_order_assignment_history where work_order_id=${q(sample.work)};
    r:=public.review_contractor_invoice(${q(sample.invoice)}::uuid,'reject','Verified manual original correction');
    if r->>'invoiceState'<>'rejected' then raise exception 'Manual reject failed'; end if;
    r:=public.retract_contractor_invoice_rejection(${q(sample.invoice)}::uuid);
    if r->>'invoiceState'<>'approved' then raise exception 'Manual retract failed'; end if;
    if parent is distinct from (select to_jsonb(w) from public.work_orders w where id=${q(sample.work)})
      or before_history<>(select count(*) from public.work_order_assignment_history where work_order_id=${q(sample.work)}) then
      raise exception 'Manual review changed parent or assignment history'; end if;
    if exists(select 1 from public.activities where work_order_id=${q(sample.work)}
      and event_data->>'invoiceId'=${q(sample.invoice)} and event_key in ('invoice_rejected','invoice_rejection_retracted')
      and (not is_staff_only or requires_contractor_attention)) then raise exception 'Manual review leaked to current work'; end if;
    end; $probe$;`,actor);
  checks.push(`reject/retract preserve full parent/history and staff-only evidence: ${actor}`);
}
for(const actor of ['e2e.direct@p1.invalid','e2e.company.admin@p1.invalid']){
  const result=JSON.parse(priorSqlAs(`select jsonb_build_object(
    'invoices',(select count(*) from public.invoices where id=${q(sample.invoice)}::uuid),
    'pdfs',(select count(*) from storage.objects where bucket_id='invoice-pdfs' and name=${q(sample.path)}),
    'activities',(select count(*) from public.activities where work_order_id=${q(sample.work)} and event_data->>'invoiceId'=${q(sample.invoice)}));`,actor).split('\n').at(-1));
  assert.deepEqual(result,{invoices:0,pdfs:0,activities:0});
  priorSqlAs(`do $probe$ begin
    begin perform public.resolve_private_object_binding_v1('invoice_original',${q(sample.invoice)}::uuid);
      raise exception 'Manual original PDF exposed'; exception when insufficient_privilege then null; end;
    end; $probe$;`,actor);
  checks.push(`current/billed contractor cannot read bill, activity or original PDF: ${actor}`);
}
priorSqlAs(`do $probe$ declare r jsonb; parent jsonb; begin
  select to_jsonb(w) into parent from public.work_orders w where id=${q(sample.work)};
  r:=public.review_contractor_invoices(array[${q(sample.invoice)}::uuid],'approve');
  if r->>'count'<>'1' then raise exception 'Manual batch approval failed'; end if;
  if parent is distinct from (select to_jsonb(w) from public.work_orders w where id=${q(sample.work)}) then
    raise exception 'Manual batch approval changed parent'; end if;
  end; $probe$;`);
checks.push('batch approval uses manual staff-intake branch without advancing current work');
console.log(JSON.stringify({passed:checks.length,checks},null,2));
