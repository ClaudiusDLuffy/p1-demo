import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { priorInvoiceFixture, priorSqlAs, priorDraftCall, quotePrior as q } from './prior-contractor-invoice-fixtures.mjs';
const checks = [];
for (const options of [{}, { capital: true }, { closed: true }, { returning: true }]) {
  const f = priorInvoiceFixture(options); const op = randomUUID(); const call = priorDraftCall(f, { operation: op });
  priorSqlAs(`do $probe$ declare r jsonb; again jsonb; before_parent jsonb; changed integer;
    begin
      select to_jsonb(w) into before_parent from public.work_orders w where id=${q(f.work)};
      r:=${call}; again:=${call};
      if r->>'state'<>'draft' or r->>'assignmentId'<>${q(f.history)} or (r->>'total')::numeric<>125.50
        or again->'applied'<>'false'::jsonb then raise exception 'Draft/replay invalid'; end if;
      if before_parent is distinct from (select to_jsonb(w) from public.work_orders w where id=${q(f.work)}) then
        raise exception 'Prior draft changed current work'; end if;
      begin update public.activities set text='Synthetic evidence tamper' where id=(r->>'activityId')::uuid;
        raise exception 'Evidence update allowed'; exception when insufficient_privilege then null; end;
      begin delete from public.activities where id=(r->>'activityId')::uuid;
        get diagnostics changed=row_count;
        if changed>0 then raise exception 'Evidence delete allowed'; end if;
        exception when insufficient_privilege then null; end;
      if not exists(select 1 from public.invoices where id=(r->>'invoiceId')::uuid and contractor_id=${q(f.priorContractor)}::uuid
        and total=125.50 and subtotal=120 and sales_tax=5.50 and prior_assignment_id=${q(f.history)}::uuid) then
        raise exception 'Invoice attribution/amount incorrect'; end if;
      r:=public.save_prior_contractor_invoice_v1(${q(f.work)},${f.assignment},${f.cycle},${q(f.history)}::uuid,
        (r->>'invoiceId')::uuid,(r->>'invoiceVersion')::bigint,gen_random_uuid(),jsonb_build_object('num',r->>'invoiceNum',
          'invoiceDate',${q(f.day)},'total',125.50,'salesTax',5.50,'note','Synthetic retained draft resumed'));
      begin perform public.submit_prior_contractor_invoice_v1((r->>'invoiceId')::uuid,(r->>'invoiceVersion')::bigint,
        ${f.assignment},${f.cycle},gen_random_uuid()); raise exception 'Missing PDF accepted'; exception when sqlstate '22023' then null; end;
    end; $probe$;`);
  checks.push(`draft, tax, ownership, no parent changes, replay and missing-PDF rejection ${JSON.stringify(options)}`);
}
const f = priorInvoiceFixture(); const other = priorInvoiceFixture();
function denied(call, code, label, actor) {
  priorSqlAs(`do $probe$ declare rejected text; before_parent jsonb; begin
    select to_jsonb(w) into before_parent from public.work_orders w where id=${q(f.work)};
    begin perform ${call}; exception when others then rejected:=sqlstate; end;
    if rejected is distinct from ${q(code)} then raise exception 'Wrong rejection for ${label}: %',rejected; end if;
    if before_parent is distinct from (select to_jsonb(w) from public.work_orders w where id=${q(f.work)}) then
      raise exception 'Denied command changed work'; end if; end; $probe$;`, actor);
  checks.push(label);
}
for (const actor of ['e2e.controller@p1.invalid','e2e.direct@p1.invalid','e2e.company.admin@p1.invalid','e2e.invoice.tech@p1.invalid','e2e.report.tech@p1.invalid'])
  denied(priorDraftCall(f), '42501', `forbidden actor ${actor}`, actor);
denied(priorDraftCall(f, { history: other.history }), '22023', 'assignment from another WO rejected');
denied(priorDraftCall(f, { assignment: f.assignment + 1 }), 'PT409', 'stale assignment rejected');
for (const payload of [
  { num: 'SYNTHETIC-BAD', invoiceDate: f.day, total: 0, salesTax: 0, note: 'Synthetic' },
  { num: 'SYNTHETIC-BAD', invoiceDate: f.day, total: 1, salesTax: 2, note: 'Synthetic' },
  { num: 'SYNTHETIC-BAD', invoiceDate: '2999-01-01', total: 1, salesTax: 0, note: 'Synthetic' },
  { num: 'SYNTHETIC-BAD', invoiceDate: f.day, total: 1.111, salesTax: 0, note: 'Synthetic' },
  { num: 'SYNTHETIC-BAD', invoiceDate: f.day, total: 1, salesTax: 0, note: 'x' },
  { num: 'SYNTHETIC-BAD', invoiceDate: f.day, total: 1, salesTax: 0, note: 'Synthetic', contractorId: f.priorContractor },
]) denied(priorDraftCall(f, { payload }), '22023', `invalid payload ${checks.length}`);
{
  const result = JSON.parse(priorSqlAs(`select ${priorDraftCall(f)};`, undefined, true).split('\n').at(-1));
  assert.ok(result.invoiceId);
  for (const actor of ['e2e.direct@p1.invalid','e2e.company.admin@p1.invalid']) {
    assert.equal(priorSqlAs(`select count(*) from public.invoices where id=${q(result.invoiceId)}::uuid;`, actor).split('\n').at(-1), '0');
    checks.push(`invoice RLS isolation ${actor}`);
  }
  const context = JSON.parse(priorSqlAs(`select public.get_prior_contractor_invoice_context_v1(${q(f.work)});`).split('\n').at(-1));
  assert.equal(context.drafts[0].id, result.invoiceId); checks.push('retained drafts can be resumed');
  denied(priorDraftCall(f, { number: result.invoiceNum }), '23505', 'duplicate invoice number rejected');
  denied(priorDraftCall(f, { invoice: result.invoiceId, version: 999 }), 'PT409', 'stale draft version rejected');
}
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
