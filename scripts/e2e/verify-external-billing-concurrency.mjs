import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const container = "supabase_db_p1-demo-e2e";
const args = ["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-Atq"];
// Refuse external daemons; only this labeled disposable synthetic database.
assert.equal(process.env.DOCKER_HOST || "", "");
assert.equal(process.env.DOCKER_CONTEXT || "", "");
assert.equal(execFileSync("docker", ["context", "show"], { encoding: "utf8" }).trim(), "desktop-linux");
assert.equal(execFileSync("docker", ["context", "inspect", "desktop-linux", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" }).trim(), "unix:///Users/nxs/.docker/run/docker.sock");
assert.equal(execFileSync("docker", ["inspect", container, "--format", '{{index .Config.Labels "com.supabase.cli.project"}} {{.HostConfig.Privileged}}'], { encoding: "utf8" }).trim(), "p1-demo-e2e false");
function sql(statement) {
  return execFileSync("docker", args, { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function concurrent(statement) {
  return new Promise(resolve => {
    const process = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let error = "";
    process.stdout.on("data", chunk => { output += chunk; });
    process.stderr.on("data", chunk => { error += chunk; });
    process.on("close", code => resolve({ code, output: output.trim(), error }));
    process.stdin.end(statement);
  });
}
function fixture() {
  const id = `E2E-EXT-RACE-${randomUUID()}`;
  sql(`insert into public.work_orders(id,status,functional_status,billing_only,summary)
    values ('${id}','pending_invoice','Completed',true,'Synthetic external billing race');`);
  return id;
}
function command(id, operation, delay = false) {
  return `begin;
    ${delay ? "select pg_sleep(0.2);" : ""}
    do $$ begin perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',
      (select id from public.profiles where email='e2e.manager@p1.invalid'))::text,true); end; $$;
    set local role authenticated;
    select public.record_work_order_external_billing_v1('${id}',0,0,0,'${operation}',
      'QuickBooks','SYNTHETIC-RACE','2026-01-01','Synthetic race verification'); commit;`;
}
function counts(id) {
  return JSON.parse(sql(`select jsonb_build_object(
    'records',(select count(*) from public.work_order_external_billings where work_order_id='${id}'),
    'invoices',(select count(*) from public.invoices where work_order_id='${id}'),
    'events',(select count(*) from public.activities where work_order_id='${id}' and event_key='work_order_billed_externally'));`));
}
const identical = fixture(); const operation = randomUUID();
const repeated = await Promise.all([concurrent(command(identical, operation)), concurrent(command(identical, operation))]);
assert(repeated.every(result => result.code === 0));
assert.deepEqual(repeated.map(result => JSON.parse(result.output).applied).sort(), [false, true]);
assert.deepEqual(counts(identical), { records: 1, invoices: 0, events: 1 });

const distinct = fixture();
const competing = await Promise.all([concurrent(command(distinct, randomUUID())), concurrent(command(distinct, randomUUID()))]);
assert.equal(competing.filter(result => result.code === 0).length, 1);
assert(competing.find(result => result.code !== 0).error.includes("EXTERNAL_BILLING_STALE"));
assert.deepEqual(counts(distinct), { records: 1, invoices: 0, events: 1 });

for (const invoiceFirst of [false, true]) {
  const id = fixture();
  const invoice = `begin; ${invoiceFirst ? "" : "select pg_sleep(0.2);"}
    insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,invoice_date,total)
    values ('${id}','staff','invoice','SYNTHETIC-${randomUUID()}','draft',current_date,50); commit;`;
  const results = await Promise.all([concurrent(command(id, randomUUID(), invoiceFirst)), concurrent(invoice)]);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  const state = counts(id);
  assert.equal(state.records + state.invoices, 1);
  assert.equal(state.records, state.events);
  assert.equal(state.records, invoiceFirst ? 0 : 1);
}
console.log(JSON.stringify({ result: "PASS_EXTERNAL_BILLING_CONCURRENCY", scenarios: 4, syntheticOnly: true }));
