import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PORTAL_REALTIME_TABLES } from "./realtimeInvalidation";
import { measuredBatcher, routingEvent } from "./realtime/realtimeTestSupport";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0054_atomic_contractor_invoice_submission.sql"),
  "utf8",
);
const dbClient = readFileSync(resolve(process.cwd(), "src/lib/db.ts"), "utf8");
const modal = readFileSync(
  resolve(process.cwd(), "src/features/invoices/InvoiceCreateModal.tsx"),
  "utf8",
);
const invoiceQuery = readFileSync(
  resolve(process.cwd(), "src/features/invoices/queries.ts"),
  "utf8",
);

test("contractor invoice submission is transactional and idempotent", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(migration, /submission_key uuid/);
  assert.match(migration, /invoices_contractor_submission_key_unique/);
  assert.match(migration, /submit_contractor_invoice_once/);
  assert.match(
    migration,
    /where invoice\.contractor_id = actor_id\s+and invoice\.submission_key = p_submission_key/,
  );
});

test("one database transaction saves lines, submits, advances the WO, and audits", () => {
  const header = migration.indexOf("insert into public.invoices");
  const lines = migration.indexOf("insert into public.invoice_lines");
  const submit = migration.indexOf("update public.invoices invoice");
  const workOrder = migration.indexOf("update public.work_orders");
  const activity = migration.indexOf("insert into public.activities");

  assert.ok(header >= 0);
  assert.ok(lines > header);
  assert.ok(submit > lines);
  assert.ok(workOrder > submit);
  assert.ok(activity > workOrder);
});

test("submission verifies direct-contractor ownership of the current WO", () => {
  assert.match(migration, /profile\.contractor_tier = 'direct'/);
  assert.match(migration, /candidate\.contractor_id = actor_id/);
  assert.match(migration, /candidate\.deleted_at is null/);
  assert.match(migration, /for update;/);
});

test("the client reuses one submission key and blocks rapid duplicate clicks", () => {
  // The deployed predecessor is characterized above; current callers use the
  // versioned successor, exercised behaviorally in contractorInvoiceCommands.test.
  assert.match(dbClient, /createContractorInvoiceCommands\(\(name, args\) => sb\.rpc\(name, args\)\)/);
  assert.match(modal, /submissionKeyRef = useRef\(""\)/);
  assert.match(modal, /if \(submitLockRef\.current\) return;/);
  assert.match(modal, /submissionKey: submissionKeyRef\.current/);
});

test("invoice lists refresh for submissions made in another session", async () => {
  assert.doesNotMatch(invoiceQuery, /refetchInterval/);
  assert.ok(PORTAL_REALTIME_TABLES.includes("invoices"));
  const fixture = measuredBatcher();
  try {
    fixture.batcher.add(routingEvent("invoices", "invoice-a"));
    await fixture.batcher.flush();
    const lists = [...fixture.calls].filter(([key]) => ["invoice-pages", "billing-invoice-pages"].includes(JSON.parse(key)[0]));
    assert.equal(lists.length, 2); assert.ok(lists.every(([, count]) => count === 1));
  } finally { fixture.close(); }
});
