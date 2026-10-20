import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkedBillingSql as sql } from './linked-billing-test-support.mjs';

export const quotePrior = value => `'${String(value).replaceAll("'", "''")}'`;
export function priorInvoiceFixture({ capital = false, closed = false, returning = false } = {}) {
  assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"), '0');
  const work = `E2E-PRIOR-${randomUUID().slice(0, 8)}`;
  sql(`insert into public.work_orders(id,contractor_id,status,functional_status,is_capital,store_number,store_state,summary)
    select ${quotePrior(work)},id,'assigned','Dispatched',${capital},'E2E001','TX','Synthetic prior contractor billing'
    from public.profiles where email='e2e.direct@p1.invalid';
    update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.company.admin@p1.invalid')
      where id=${quotePrior(work)};
    ${returning ? `update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid') where id=${quotePrior(work)};` : ''}
    update public.work_orders set status='${closed ? 'closed' : capital ? 'capital' : 'assigned'}',
      functional_status='${closed ? 'Completed' : 'Dispatched'}'${closed ? ',closed_at=clock_timestamp()' : ''} where id=${quotePrior(work)};`);
  return JSON.parse(sql(`select jsonb_build_object('work',w.id,'assignment',w.contractor_assignment_version,
    'cycle',w.workflow_cycle,'history',(select id from public.work_order_assignment_history h where h.work_order_id=w.id
      and h.contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid') order by assignment_version limit 1),
    'day',(clock_timestamp() at time zone 'America/New_York')::date,
    'parent',to_jsonb(w),'priorContractor',(select id from public.profiles where email='e2e.direct@p1.invalid'))
    from public.work_orders w where w.id=${quotePrior(work)}`));
}
export function priorSqlAs(statement, email = 'e2e.manager@p1.invalid', commit = false, before = '') {
  return sql(`begin;
    ${before}
    select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',
      (select id from public.profiles where email=${quotePrior(email)}))::text,true) is not null;
    set local role authenticated;
    ${statement} ${commit ? 'commit' : 'rollback'};`);
}
export function priorDraftCall(f, { operation = randomUUID(), invoice = null, version = null,
  number = `SYNTHETIC-PRIOR-${randomUUID().slice(0, 8)}`, history = f.history, assignment = f.assignment,
  payload = { num: number, invoiceDate: f.day, total: 125.50, salesTax: 5.50, note: 'Synthetic bill received after reassignment' } } = {}) {
  return `public.save_prior_contractor_invoice_v1(${quotePrior(f.work)},${assignment},${f.cycle},${quotePrior(history)}::uuid,
    ${invoice ? `${quotePrior(invoice)}::uuid` : 'null'},${version ?? 'null'},${quotePrior(operation)}::uuid,${quotePrior(JSON.stringify(payload))}::jsonb)`;
}
