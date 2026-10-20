import assert from 'node:assert/strict';
import { linkedBillingSql as sql } from './linked-billing-test-support.mjs';
import { priorSqlAs, quotePrior as q } from './prior-contractor-invoice-fixtures.mjs';

assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"), '0');
const sample = JSON.parse(sql(`select jsonb_build_object('invoice',i.id,'work',w.id,'path',i.pdf_storage_path,
  'assignment',w.contractor_assignment_version,'cycle',w.workflow_cycle,'history',i.prior_assignment_id)
  from public.invoices i join public.work_orders w on w.id=i.work_order_id
  where i.prior_assignment_id is not null and i.state='submitted' and i.pdf_storage_path is not null
    and w.deleted_at is null order by i.created_at desc limit 1`));
assert.ok(sample?.invoice, 'Run the browser upload scenarios first');
const checks = [];
for (const actor of ['e2e.manager@p1.invalid','e2e.dispatcher@p1.invalid','e2e.backoffice@p1.invalid']) {
  priorSqlAs(`do $probe$ declare r jsonb; w jsonb; begin
    select to_jsonb(work_order) into w from public.work_orders work_order where id=${q(sample.work)};
    r:=public.review_contractor_invoice(${q(sample.invoice)}::uuid,'reject','Synthetic rejected prior bill');
    if r->>'invoiceState'<>'rejected' then raise exception 'Reject failed'; end if;
    r:=public.retract_contractor_invoice_rejection(${q(sample.invoice)}::uuid);
    if r->>'invoiceState'<>'approved' then raise exception 'Retraction failed'; end if;
    if w is distinct from (select to_jsonb(work_order) from public.work_orders work_order where id=${q(sample.work)}) then
      raise exception 'Review changed current work'; end if;
    if exists(select 1 from public.activities where work_order_id=${q(sample.work)}
      and event_data->>'invoiceId'=${q(sample.invoice)} and event_key in ('invoice_rejected','invoice_rejection_retracted')
      and (not is_staff_only or requires_contractor_attention)) then raise exception 'Prior review leaked to current contractor'; end if;
    end; $probe$;`, actor);
  checks.push(`reject/retract no parent changes or current-contractor attention: ${actor}`);
}
for (const actor of ['e2e.direct@p1.invalid','e2e.company.admin@p1.invalid']) {
  const visibleSample = JSON.parse(sql(`select jsonb_build_object('invoice',i.id,'work',w.id,'path',i.pdf_storage_path)
    from public.invoices i join public.work_orders w on w.id=i.work_order_id where i.prior_assignment_id is not null
      and i.pdf_storage_path is not null and w.contractor_id=i.contractor_id and w.deleted_at is null order by i.created_at desc limit 1`));
  const selected = visibleSample ?? sample;
  const result = JSON.parse(priorSqlAs(`select jsonb_build_object('invoices',(select count(*) from public.invoices where id=${q(sample.invoice)}::uuid),
    'pdfObjects',(select count(*) from storage.objects where bucket_id='invoice-pdfs' and name=${q(sample.path)}),
    'activities',(select count(*) from public.activities where work_order_id=${q(sample.work)} and event_data->>'invoiceId'=${q(sample.invoice)}));`, actor).split('\n').at(-1));
  assert.deepEqual(result, { invoices: 0, pdfObjects: 0, activities: 0 });
  priorSqlAs(`do $probe$ begin
    begin perform public.resolve_private_object_binding_v1('invoice_original',${q(sample.invoice)}::uuid);
      raise exception 'Historical PDF accessible'; exception when insufficient_privilege then null; end;
    begin perform public.get_prior_contractor_invoice_context_v1(${q(sample.work)});
      raise exception 'Past assignment context accessible'; exception when insufficient_privilege then null; end;
    end; $probe$;`, actor);
  checks.push(`returning/other company cannot read bill, PDF, activity, assignment context: ${actor}`);
  assert.equal(priorSqlAs(`select count(*) from public.invoices where id=${q(selected.invoice)}::uuid;`, actor).split('\n').at(-1), '0');
  assert.equal(priorSqlAs(`select count(*) from storage.objects where bucket_id='invoice-pdfs' and name=${q(selected.path)};`, actor).split('\n').at(-1), '0');
}
priorSqlAs(`do $probe$ declare result jsonb; w jsonb; begin
  select to_jsonb(work_order) into w from public.work_orders work_order where id=${q(sample.work)};
  result:=public.review_contractor_invoices(array[${q(sample.invoice)}::uuid],'approve');
  if result->>'count'<>'1' then raise exception 'Batch review failed'; end if;
  if w is distinct from (select to_jsonb(work_order) from public.work_orders work_order where id=${q(sample.work)}) then
    raise exception 'Submit/batch approval changed work'; end if;
  end; $probe$;`);
checks.push('established batch approval preserves entire parent');

for (const command of [
  `public.review_prior_contractor_invoice_core(${q(sample.invoice)}::uuid,'approve',null,false)`,
  `public.review_contractor_invoice_financial_core(${q(sample.invoice)}::uuid,'approve',null)`,
  `public.review_current_contractor_invoice_core(${q(sample.invoice)}::uuid,'approve',null)`,
]) {
  priorSqlAs(`do $probe$ begin begin perform ${command}; raise exception 'Private helper exposed';
    exception when insufficient_privilege then null; end; end; $probe$;`);
  checks.push('private review helper denied');
}
priorSqlAs(`do $probe$ begin
  begin update public.invoices set prior_assignment_id=null,prior_assignment_note=null where id=${q(sample.invoice)}::uuid;
    raise exception 'Historical identity mutable'; exception when insufficient_privilege then null; end;
  begin update public.invoices set contractor_id=(select id from public.profiles where email='e2e.company.admin@p1.invalid')
    where id=${q(sample.invoice)}::uuid; raise exception 'Contractor identity mutable'; exception when insufficient_privilege then null; end;
  end; $probe$;`);
checks.push('raw identity changes denied');
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
