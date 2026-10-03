import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { linkedBillingFixture as fixture, linkedBillingSql as sql, linkedBillingConcurrentSql as concurrent, linkedBillingCounts as counts } from "./linked-billing-test-support.mjs";

function command(f, operation, delay = false) {
  return `begin; ${delay ? "select pg_sleep(0.3);" : ""}
    do $$ begin perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',
      (select id from public.profiles where email='e2e.manager@p1.invalid'))::text,true); end; $$;
    set local role authenticated;
    select public.record_work_order_linked_billing_v1('${f.source}',0,0,0,'${operation}',
      '${f.target}',0,0,'${f.invoice}',0,'Synthetic concurrency coverage'); commit;`;
}
const same = fixture(); const op = randomUUID();
const repeated = await Promise.all([concurrent(command(same, op)), concurrent(command(same, op))]);
assert(repeated.every(result => result.code === 0));
assert.deepEqual(repeated.map(result => JSON.parse(result.output).applied).sort(), [false, true]);
assert.equal(counts(same.source).links, 1); assert.equal(counts(same.source).events, 2);
const different = fixture();
const competing = await Promise.all([concurrent(command(different, randomUUID())), concurrent(command(different, randomUUID()))]);
assert.equal(competing.filter(result => result.code === 0).length, 1);
assert.equal(counts(different.source).links, 1);
for (const invoiceFirst of [true, false]) {
  const f = fixture();
  const insert = `begin; ${invoiceFirst ? "" : "select pg_sleep(0.3);"}
    insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,invoice_date,total)
    values('${f.source}','staff','invoice','SYNTHETIC-${randomUUID()}','draft',current_date,100); commit;`;
  const results = await Promise.all([concurrent(command(f, randomUUID(), invoiceFirst)), concurrent(insert)]);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  const state = counts(f.source); assert.equal(state.links + state.invoices, 1);
  assert.equal(state.links, invoiceFirst ? 0 : 1);
}
for (const invalidationFirst of [true, false]) {
  const f = fixture();
  const invalidate = `begin; ${invalidationFirst ? "" : "select pg_sleep(0.3);"}
    update public.invoices set state='draft' where id='${f.invoice}'; commit;`;
  const results = await Promise.all([concurrent(command(f, randomUUID(), invalidationFirst)), concurrent(invalidate)]);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  assert.equal(counts(f.source).links, invalidationFirst ? 0 : 1);
}
// External and linked billing are mutually exclusive for one work cycle.
const f = fixture();
const external = command(f, randomUUID()).replace(/select public\.record_work_order_linked_billing_v1[\s\S]+?; commit;/,
  `select public.record_work_order_external_billing_v1('${f.source}',0,0,0,'${randomUUID()}',
    'Synthetic Accounting','SYNTHETIC-EXTERNAL','2026-01-01','Synthetic external coverage'); commit;`);
const exclusive = await Promise.all([concurrent(command(f, randomUUID())), concurrent(external)]);
assert.equal(exclusive.filter(result => result.code === 0).length, 1);
assert.equal(Number(sql(`select (select count(*) from public.work_order_billing_links where work_order_id='${f.source}')
  +(select count(*) from public.work_order_external_billings where work_order_id='${f.source}');`)), 1);
console.log(JSON.stringify({ result: "PASS_LINKED_BILLING_CONCURRENCY", scenarios: 7, syntheticOnly: true }));
