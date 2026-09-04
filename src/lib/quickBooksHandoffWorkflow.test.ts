import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0096_guarded_quickbooks_handoff.sql");
const immutablePackageMigration = read("supabase/migrations/0117_immutable_contractor_bill_handoff_packages.sql");
const route = read("src/app/api/controller-exports/route.ts");
const panel = read("src/features/invoices/ControllerExportPanel.tsx");
const invoiceList = read("src/features/invoices/InvoiceList.tsx");
const invoiceCsv = read("src/lib/invoiceCsv.ts");
const portalShell = read("src/components/PortalShell.tsx");
const contractorBillManifest = read("src/lib/contractorBillManifest.ts");

test("downloading stages a batch without marking contractor invoices paid", () => {
  const stage = migration.match(/create or replace function public\.stage_controller_invoice_export[\s\S]*?\nend;\n\$\$;/)?.[0] || "";
  assert.match(stage, /status\s*\) values[\s\S]*'pending'/);
  assert.doesNotMatch(stage, /set state = 'paid'/);
  assert.match(route, /stage_contractor_bill_handoff/);
  assert.match(immutablePackageMigration, /source_updated_at/);
  assert.match(immutablePackageMigration, /archive_sha256/);
  assert.match(immutablePackageMigration, /guard_pending_contractor_bill_invoice/);
  assert.match(panel, /Contractor bills remain Approved until their QuickBooks entry is confirmed/);
});

test("only a confirmed pending batch performs the guarded QuickBooks transition", () => {
  assert.match(migration, /create or replace function public\.confirm_controller_invoice_export/);
  assert.match(migration, /set_config\('app\.quickbooks_handoff_transition', 'confirm', true\)/);
  assert.match(migration, /set state = 'paid'/);
  assert.match(migration, /qbo_synced_at = now\(\)/);
  assert.match(migration, /paid_at = null/);
  assert.match(migration, /protect_quickbooks_handoff_transition/);
  assert.match(migration, /quickbooks_handoff/);
  assert.match(route, /confirm_controller_invoice_export/);
  assert.match(route, /cancel_controller_invoice_export/);
});

test("the controller audit is filterable, exportable, and retains item detail", () => {
  assert.match(route, /params: \{ from\?: string; to\?: string; actor\?: string; all\?: boolean \}/);
  assert.match(route, /exportHistoryCsvRows/);
  assert.match(route, /Contractor-Bill-Handoff-Audit/);
  assert.match(route, /invoiceNumber/);
  assert.match(route, /workOrderId/);
  assert.match(route, /contractorName/);
  assert.match(panel, /Export audit CSV/);
  assert.match(panel, /Run by/);
  assert.match(panel, /Re-download ZIP/);
  assert.match(route, /oldestPendingAt/);
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

test("the contractor payables package cannot be mistaken for Lynzy's SaasAnt receivables import", () => {
  assert.match(route, /generateContractorBillManifestCsv/);
  assert.match(route, /Contractor-bills-reference-manifest\.csv/);
  assert.match(route, /contractorBillPdfPath/);
  assert.match(contractorBillManifest, /Contractor-Bill-PDFs/);
  assert.doesNotMatch(route, /generateInvoiceBatchCsv/);
  assert.doesNotMatch(route, /QuickBooks-approved-invoices\.csv/);
  assert.match(panel, /reference-only manifest; it is not a QuickBooks import file/);
  assert.match(route, /archive_format/);
  assert.match(route, /createSignedUrl/);
  assert.match(route, /Legacy-QuickBooks-Handoff/);
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
