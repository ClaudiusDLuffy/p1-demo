import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { assertArchiveRpcReconciliation, assertControllerTransitions, assertCanonicalControllerIdentity } from "./controller-export-test-support/regressionAssertions";
import { controllerGraphHarness, controllerScopeFake } from "../server/controller-exports/testing/scopeFake";
import { controllerTestIds as ids } from "../server/controller-exports/testing/authorizationPorts";
import { archiveFilename } from "../server/controller-exports/snapshot";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0096_guarded_quickbooks_handoff.sql");
const immutablePackageMigration = read("supabase/migrations/0117_immutable_contractor_bill_handoff_packages.sql");
const panel = read("src/features/invoices/ControllerExportPanel.tsx");
const invoiceList = read("src/features/invoices/InvoiceList.tsx");
const invoiceCsv = read("src/lib/invoiceCsv.ts");
const portalShell = read("src/components/PortalShell.tsx");
const contractorBillManifest = read("src/lib/contractorBillManifest.ts");

test("downloading stages a batch without marking contractor invoices paid", async () => {
  const stage = migration.match(/create or replace function public\.stage_controller_invoice_export[\s\S]*?\nend;\n\$\$;/)?.[0] || "";
  assert.match(stage, /status\s*\) values[\s\S]*'pending'/);
  assert.doesNotMatch(stage, /set state = 'paid'/);
  await assertArchiveRpcReconciliation();
  const h = controllerGraphHarness();
  const response = await h.route("POST", new Request("https://synthetic.invalid/api/controller-exports", { method: "POST", headers: { Authorization: "Bearer synthetic-controller" }, body: "{}" }));
  assert.equal(response.status, 200); assert.equal((await response.json()).status, "pending");
  assert.equal(h.commands.length, 1); assert.ok(!h.calls.some(call => call.includes("confirm") || call.includes("paid")));
  assert.match(immutablePackageMigration, /source_updated_at/);
  assert.match(immutablePackageMigration, /archive_sha256/);
  assert.match(immutablePackageMigration, /guard_pending_contractor_bill_invoice/);
  assert.match(panel, /Contractor bills remain Approved until their QuickBooks entry is confirmed/);
});

test("only a confirmed pending batch performs the guarded QuickBooks transition", async () => {
  assert.match(migration, /create or replace function public\.confirm_controller_invoice_export/);
  assert.match(migration, /set_config\('app\.quickbooks_handoff_transition', 'confirm', true\)/);
  assert.match(migration, /set state = 'paid'/);
  assert.match(migration, /qbo_synced_at = now\(\)/);
  assert.match(migration, /paid_at = null/);
  assert.match(migration, /protect_quickbooks_handoff_transition/);
  assert.match(migration, /quickbooks_handoff/);
  await assertControllerTransitions();
});

test("the controller audit is filterable, exportable, and retains item detail", async () => {
  const fake = controllerScopeFake(); const filters: unknown[] = [];
  const page = { batches: [{ id: ids.batch, status: "pending" as const, createdBy: ids.actor, createdAt: "2026-09-12T00:00:00Z",
    confirmedAt: null, confirmedBy: null, cancelledAt: null, cancelledBy: null, cancellationReason: null, invoiceCount: 1, total: 120 }],
    items: [{ batchId: ids.batch, invoiceId: ids.invoice, invoiceNumber: "INV-700001", workOrderId: "WOT900001-2", contractorId: ids.otherActor, total: 120 }],
    profiles: [{ id: ids.actor, name: "Synthetic controller", company: null }, { id: ids.otherActor, name: "Synthetic contractor", company: "Synthetic Company" }] };
  fake.scope.list.history.loadRecent = async filter => { filters.push(filter); return page; };
  fake.scope.list.history.pages = async function* (filter) { filters.push(filter); yield page; };
  const h = controllerGraphHarness({ scope: fake });
  const base = `https://synthetic.invalid/api/controller-exports?history=1&from=2026-09-01&to=2026-09-30&actor=${ids.actor}`;
  const json = await h.route("GET", new Request(base, { headers: { Authorization: "Bearer synthetic-controller" } }));
  assert.equal(json.status, 200); const body = await json.json();
  assert.deepEqual(body.history[0].items[0], { invoiceId: ids.invoice, invoiceNumber: "INV-700001", workOrderId: "WOT900001-2", contractorId: ids.otherActor, contractorName: "Synthetic Company", total: 120 });
  const csv = await h.route("GET", new Request(`${base}&format=csv`, { headers: { Authorization: "Bearer synthetic-controller" } }));
  assert.equal(csv.status, 200); assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="Contractor-Bill-Handoff-Audit-2026-09-12.csv"');
  const output = await csv.text(); assert.match(output, /INV-700001,WOT900001-2,Synthetic Company,120\.00,120\.00/);
  assert.deepEqual(JSON.parse(JSON.stringify(filters)), Array.from({ length: 2 }, () => ({ from: "2026-09-01", toExclusive: "2026-10-01T00:00:00.000Z", actor: ids.actor })));
  const queue = await h.route("GET", new Request("https://synthetic.invalid/api/controller-exports", { headers: { Authorization: "Bearer synthetic-controller" } }));
  assert.deepEqual(await queue.json(), { count: 1, limit: 500, canHandoff: true, pendingCount: 0, oldestPendingAt: null });
  assert.match(panel, /Export audit CSV/);
  assert.match(panel, /Run by/);
  assert.match(panel, /Re-download ZIP/);
  assert.match(panel, /Wednesday contractor-payment run/);
});

test("authorized accounting can select an approved handoff batch on desktop or mobile", () => {
  assert.match(invoiceList, /const \[selectedHandoffIds, setSelectedHandoffIds\] = useState/);
  assert.match(invoiceList, /canHandoffQuickBooks\(currentUser\)[\s\S]*invTab === "approved"/);
  assert.match(invoiceList, /else if \(next\.size < 500\) next\.add\(invoiceId\)/);
  assert.match(invoiceList, /Select all visible approved contractor bills for payables handoff/);
  assert.match(invoiceList, /Select contractor bill \$\{inv\.num\} for payables handoff/g);
  assert.match(invoiceList, /selectedInvoiceIds=\{selectedHandoffInvoiceIds\}/);
  assert.match(panel, /JSON\.stringify\(hasSelection \? \{ invoiceIds: selectedIds \} : \{\}\)/);
  assert.match(panel, /onClearSelected\?\.\(\)/);
  assert.match(panel, /Download selected bills/);
});

test("the contractor payables package cannot be mistaken for Lynzy's SaasAnt receivables import", async () => {
  await assertCanonicalControllerIdentity();
  assert.match(contractorBillManifest, /Contractor-Bill-PDFs/);
  assert.match(panel, /reference-only manifest; it is not a QuickBooks import file/);
  assert.equal(archiveFilename(ids.batch, "legacy_saas_ant_v1", "2026-09-12T00:00:00Z"), "Legacy-QuickBooks-Handoff-2026-09-12-81000000-000.zip");
  assert.match(panel, /Legacy package downloaded/);
  assert.match(panel, /const downloadBatch[\s\S]*?setError\(null\);\s*setNotice\(null\);/);

  assert.match(invoiceCsv, /export function generateStaffInvoiceBatchCsv/);
  assert.match(invoiceCsv, /customer: first \? "7-Eleven Inc"/);
  assert.match(portalShell, /downloadStaffInvoiceCsv/);
  assert.doesNotMatch(invoiceList, /doDownloadInvoiceCsv/);
  assert.doesNotMatch(read("src/features/invoices/InvoiceDetail.tsx"), /Download CSV/);
  assert.match(
    read("src/features/billing/BillingInvoiceDetail.tsx"),
    /!capitalHandoff[\s\S]*Download SaasAnt CSV/,
  );
  assert.match(portalShell, /Capital quotes cannot use the SaasAnt customer-invoice format/);
});

test("a selected handoff remains available when the full approved queue exceeds the archive limit", () => {
  assert.match(panel, /\|\| \(!hasSelection && \(approvedCount === 0 \|\| overLimit\)\)/);
  assert.match(panel, /overLimit && !hasSelection/);
  assert.match(panel, /Open the Approved tab, select up to \{exportLimit\} contractor bills/);
});
