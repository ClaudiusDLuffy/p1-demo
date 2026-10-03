import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const container = "supabase_db_p1-demo-e2e";
assert.equal(process.env.DOCKER_HOST || "", "");
assert.equal(process.env.DOCKER_CONTEXT || "", "");
assert.equal(execFileSync("docker", ["context", "show"], { encoding: "utf8" }).trim(), "desktop-linux");
assert.equal(execFileSync("docker", ["context", "inspect", "desktop-linux", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" }).trim(), "unix:///Users/nxs/.docker/run/docker.sock");
assert.equal(execFileSync("docker", ["inspect", container, "--format", '{{index .Config.Labels "com.supabase.cli.project"}} {{.HostConfig.Privileged}}'], { encoding: "utf8" }).trim(), "p1-demo-e2e false");
const args = ["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-Atq"];
export function linkedBillingSql(statement) {
  return execFileSync("docker", args, { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
export function linkedBillingConcurrentSql(statement) {
  return new Promise(resolve => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("close", code => resolve({ code, output: output.trim(), error })); child.stdin.end(statement);
  });
}
export function linkedBillingFixture() {
  const suffix = randomUUID().slice(0, 8); const source = `E2E-LINK-S-${suffix}`; const target = `E2E-LINK-T-${suffix}`;
  const invoice = randomUUID(); const number = `SYNTHETIC-LINK-${suffix}`;
  linkedBillingSql(`insert into public.work_orders(id,status,functional_status,billing_only,store_number,summary)
    values('${source}','pending_invoice','Completed',true,'E2E001','Synthetic coverage source'),
      ('${target}','pending_invoice','Completed',true,'E2E001','Synthetic billing destination');
    insert into public.invoices(id,work_order_id,invoice_type,document_kind,num,state,invoice_date,total)
    values('${invoice}','${target}','staff','invoice','${number}','submitted',current_date,100);`);
  return { source, target, invoice, number };
}
export function linkedBillingCounts(source) {
  return JSON.parse(linkedBillingSql(`select jsonb_build_object('status',status,'functionalStatus',functional_status,
    'links',(select count(*) from public.work_order_billing_links where work_order_id='${source}'),
    'invoices',(select count(*) from public.invoices where work_order_id='${source}'),
    'events',(select count(*) from public.activities where event_data->>'coveredWorkOrderId'='${source}'
      and event_key in ('work_order_billed_under_another','work_order_billing_coverage_added')))
    from public.work_orders where id='${source}';`));
}
