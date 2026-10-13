import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkedBillingSql as sql, linkedBillingConcurrentSql } from './linked-billing-test-support.mjs';
import { reportedInvoiceFixture } from './reported-invoice-fixtures.mjs';

const checks = [];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
function context(f) {
  return JSON.parse(sql(`select jsonb_build_object('work',w.id,'assignment',w.contractor_assignment_version,
    'cycle',w.workflow_cycle,'lifecycle',w.lifecycle_version,'invoice',i.id,'invoiceVersion',i.invoice_version,
    'bill',(select id from public.activities where work_order_id=w.id and event_key='staff_billing'
      and event_data->>'action'='billed_to_7_eleven' order by created_at desc limit 1))
    from public.work_orders w join public.invoices i on i.id=${literal(f.staffInvoice)} where w.id=${literal(f.work)}`));
}
function command(c, operation = randomUUID(), override = {}) {
  const v = { ...c, ...override };
  return `public.reconcile_recorded_billing_closeout_v1(${literal(v.work)},${v.assignment},${v.cycle},${v.lifecycle},
    ${literal(operation)}::uuid,${literal(v.invoice)}::uuid,${v.invoiceVersion},${literal(v.bill)}::uuid,${v.confirmed === false ? 'false' : 'true'})`;
}
function authenticated(statement, email = 'e2e.manager@p1.invalid', role = 'authenticated', before = '') {
  return `begin; ${before}
    select set_config('request.jwt.claims',jsonb_build_object('role',${literal(role)},'sub',
      (select id from public.profiles where email=${literal(email)}))::text,true) is not null;
    set local role ${role}; ${statement} rollback;`;
}
function reject(f, call, code, label, email, role, before) {
  sql(authenticated(`do $probe$ declare message text; code text; prior_status text;
    begin
      select status::text into prior_status from public.work_orders where id=${literal(f.work)};
      begin perform ${call}; exception when others then message:=sqlerrm; code:=sqlstate; end;
      if code is distinct from ${literal(code)} then raise exception 'Expected rejection: ${label}'; end if;
      if exists(select 1 from public.work_orders where id=${literal(f.work)} and status::text is distinct from prior_status)
        or exists(select 1 from public.activities where work_order_id=${literal(f.work)} and event_key='work_order_billing_closeout_reconciled') then
        raise exception 'Rejected request changed state: ${label}'; end if;
    end; $probe$;`, email, role, before));
  checks.push(label);
}

// The accounting fixture is ordinary back-office staff with an additive
// handoff capability, not controller-only. Preserve the existing actor policy.
for (const email of ['e2e.manager@p1.invalid','e2e.dispatcher@p1.invalid','e2e.backoffice@p1.invalid','e2e.accounting@p1.invalid']) {
  const f = reportedInvoiceFixture('regular_billed_still_open'); const c = context(f); const op = randomUUID(); const call = command(c, op);
  sql(authenticated(`do $probe$ declare result jsonb; replay jsonb; invoices_before jsonb; bill_before jsonb; count_after integer;
    begin
      select jsonb_agg(to_jsonb(i) order by i.id) into invoices_before from public.invoices i where work_order_id=${literal(f.work)};
      select to_jsonb(a) into bill_before from public.activities a where id=${literal(c.bill)}::uuid;
      result:=${call}; replay:=${call};
      if result->>'workOrderStatus'<>'closed' or result->'applied'<>'true'::jsonb
        or (result->>'lifecycleVersion')::bigint<>${c.lifecycle + 1}
        or replay->'applied'<>'false'::jsonb or replay->>'reason'<>'already_applied'
        or result->'invoiceCreated'<>'false'::jsonb or result->'billingRecorded'<>'false'::jsonb
        or result->'paymentRecorded'<>'false'::jsonb or result->'csvExported'<>'false'::jsonb then
        raise exception 'Invalid closeout or replay result'; end if;
      if invoices_before is distinct from (select jsonb_agg(to_jsonb(i) order by i.id) from public.invoices i where work_order_id=${literal(f.work)})
        or bill_before is distinct from (select to_jsonb(a) from public.activities a where id=${literal(c.bill)}::uuid)
        or (select count(*) from public.activities where work_order_id=${literal(f.work)} and event_key='work_order_billing_closeout_reconciled')<>1
        or public.get_work_order_external_billing_v1(${literal(f.work)}) is not null
        or public.get_work_order_billing_links_v1(${literal(f.work)},null,null)->'items' is distinct from '[]'::jsonb then
        raise exception 'Reconciliation modified billing or duplicated evidence'; end if;
      begin perform ${command(c, op, { invoiceVersion: c.invoiceVersion + 1 })};
        raise exception 'Changed operation accepted'; exception when sqlstate 'PT409' then null; end;
      begin update public.activities set text='Synthetic tamper' where id=(result->>'activityId')::uuid;
        get diagnostics count_after=row_count;
        if count_after<>0 then raise exception 'Audit tamper accepted'; end if;
        exception when insufficient_privilege then null; end;
      begin delete from public.activities where id=(result->>'activityId')::uuid;
        get diagnostics count_after=row_count;
        if count_after<>0 then raise exception 'Audit deletion accepted'; end if;
        exception when insufficient_privilege then null; end;
      if not exists(select 1 from public.activities where id=(result->>'activityId')::uuid
        and text<>'Synthetic tamper') then raise exception 'Immutable audit evidence missing'; end if;
    end; $probe$;`, email));
  checks.push(`atomic close, immutable invoice/bill, idempotent replay and protected audit: ${email}`);
}

for (const [label, mutation, expectedCode = '23514'] of [
  ['no billing proof', f => `update public.activities set event_data=jsonb_set(event_data,'{action}','"created"') where work_order_id=${literal(f.work)} and event_data->>'action'='billed_to_7_eleven'`],
  ['capital jobs excluded', f => `update public.work_orders set is_capital=true where id=${literal(f.work)}`],
  ['unfinished field work', f => `update public.work_orders set status='parts',functional_status='Awaiting Parts' where id=${literal(f.work)}`],
  ['billing-only job', f => `update public.work_orders set billing_only=true where id=${literal(f.work)}`, 'PT409'],
  ['later workflow cycle', f => `update public.work_orders set workflow_cycle=1 where id=${literal(f.work)}`],
  ['legacy reopen evidence', f => `insert into public.activities(work_order_id,author_name,text,type,event_key,is_staff_only)
    values(${literal(f.work)},'Synthetic staff','Synthetic reopen','system','work_order_reopened',true)`],
  ['wrong billed invoice ID', f => `update public.activities set event_data=jsonb_set(event_data,'{invoiceId}',to_jsonb(${literal(randomUUID())}::text))
    where work_order_id=${literal(f.work)} and event_data->>'action'='billed_to_7_eleven'`],
  ['unapproved current invoice', f => `update public.invoices set state='draft' where id=${literal(f.staffInvoice)}::uuid`, 'PT409'],
  ['unresolved contractor invoice', f => `insert into public.invoices(work_order_id,contractor_id,num,invoice_type,state,created_at,invoice_date,total)
    select id,contractor_id,'SYNTHETIC-PENDING-${f.work}','contractor','submitted','2026-08-05T12:00:00Z','2026-08-05',10
    from public.work_orders where id=${literal(f.work)}`],
  ['pending 7-Eleven update', f => `insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
    select ${literal(f.work)},id,'Synthetic staff','Synthetic pending update','note','note','field_note'
    from public.profiles where email='e2e.manager@p1.invalid'`],
  ['pending contractor attention', f => `insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel,requires_contractor_attention)
    select ${literal(f.work)},id,'Synthetic staff','Synthetic pending attention','note','note','contractor_message',true
    from public.profiles where email='e2e.manager@p1.invalid'`],
  ['conflicting P1 document', f => `insert into public.invoices(work_order_id,num,invoice_type,state,invoice_date,total)
    values(${literal(f.work)},'SYNTHETIC-CONFLICT-${f.work}','staff','draft',current_date,10)`],
  ['open visit', f => `begin;
    update public.work_orders set functional_status='Work in Progress' where id=${literal(f.work)};
    insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
    select id,contractor_id,contractor_id,'2026-08-07T10:00:00Z' from public.work_orders where id=${literal(f.work)};
    commit;`],
  ['later closed visit', f => `insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,checked_out_by,check_in_at,check_out_at)
    select id,contractor_id,contractor_id,contractor_id,'2026-08-07T10:00:00Z','2026-08-07T11:00:00Z' from public.work_orders where id=${literal(f.work)}`],
  ['later contractor invoice', f => `insert into public.invoices(work_order_id,contractor_id,num,invoice_type,state,created_at,invoice_date,total)
    select id,contractor_id,'SYNTHETIC-LATER-${f.work}','contractor','approved','2026-08-07T12:00:00Z','2026-08-07',10
    from public.work_orders where id=${literal(f.work)}`],
]) {
  const f = reportedInvoiceFixture('regular_billed_still_open'); const original = context(f);
  sql(mutation(f)); const c = { ...context(f), bill: original.bill };
  reject(f, command(c), expectedCode, label);
  const read = sql(authenticated(`select public.get_recorded_billing_closeout_v1(${literal(f.work)}) is null;`));
  assert.equal(read.split('\n').at(-1), 't'); checks.push(`ineligible read hidden: ${label}`);
}

{
  const f = reportedInvoiceFixture('regular_billed_still_open'); const original = context(f);
  sql(`update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid')
    where id=${literal(f.work)}`);
  reject(f, command({ ...context(f), bill: original.bill }), '23514', 'reassignment cannot reuse prior-company billing');
}

for (const email of ['e2e.direct@p1.invalid','e2e.company.admin@p1.invalid','e2e.controller@p1.invalid']) {
  const f = reportedInvoiceFixture('regular_billed_still_open');
  reject(f, command(context(f)), '42501', `forbidden actor: ${email}`, email);
}
{
  const f = reportedInvoiceFixture('regular_billed_still_open'); const c = context(f);
  reject(f, command(c), '42501', 'inactive operational staff denied', undefined, undefined,
    "update public.profiles set active=false where email='e2e.manager@p1.invalid';");
  reject(f, command(c), '42501', 'service-role execute denied', undefined, 'service_role');
  reject(f, command(c, randomUUID(), { confirmed: false }), '22023', 'explicit confirmation required');
  reject(f, command(c, randomUUID(), { invoiceVersion: c.invoiceVersion + 1 }), 'PT409', 'invoice version mismatch');
  reject(f, command(c, randomUUID(), { lifecycle: c.lifecycle + 1 }), 'PT409', 'lifecycle version mismatch');
  reject(f, command(c, randomUUID(), { assignment: c.assignment + 1 }), 'PT409', 'assignment version mismatch');
  reject(f, command(c, randomUUID(), { bill: randomUUID() }), 'PT409', 'billing event mismatch');
  reject(f, `public.recorded_billing_closeout_evidence(${literal(f.work)})`, '42501', 'private helper execute denied');
  sql(authenticated(`do $probe$ begin
    begin update public.work_orders set status='closed',closed_at=now() where id=${literal(f.work)};
      raise exception 'Raw close accepted'; exception when insufficient_privilege then null; end;
    begin insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,is_staff_only)
      select ${literal(f.work)},id,name,'Synthetic forged reconciliation','system','work_order_billing_closeout_reconciled',true
      from public.profiles where email='e2e.manager@p1.invalid';
      raise exception 'Forged reconciliation accepted'; exception when insufficient_privilege then null; end;
    end; $probe$;`));
  checks.push('raw closure and forged reconciliation event denied');
}

for (const sameOperation of [true, false]) {
  const f = reportedInvoiceFixture('regular_billed_still_open'); const c = context(f); const op = randomUUID();
  const requests = [command(c, op), command(c, sameOperation ? op : randomUUID())].map(call =>
    authenticated(`select ${call};`).replace(' rollback;', ' commit;'));
  const results = await Promise.all(requests.map(statement => linkedBillingConcurrentSql(statement)));
  assert.equal(results.filter(result => result.code === 0).length, sameOperation ? 2 : 1);
  assert.equal(sql(`select count(*) from public.activities where work_order_id=${literal(f.work)}
    and event_key='work_order_billing_closeout_reconciled'`), '1');
  assert.equal(sql(`select count(*) from public.invoices where work_order_id=${literal(f.work)}`), '2');
  checks.push(sameOperation ? 'concurrent same-operation replay has one audit' : 'concurrent different operations admit one closeout');
}
console.log(JSON.stringify({ passed: checks.length, checks, localOnly: true, originalBillingRecordsUnchanged: true }, null, 2));
