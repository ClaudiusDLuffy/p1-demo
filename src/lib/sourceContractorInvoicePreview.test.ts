import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const db = read("src/lib/db.ts");
const modal = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const drawer = read("src/features/billing/SourceContractorInvoiceDrawer.tsx");
const preview = read("src/features/billing/PrivatePdfCanvasPreview.tsx");
const nextConfig = read("next.config.ts");
const summaryRead = read("src/features/invoices/invoiceReads.ts");
const billingReads = read("src/features/billing/billingReads.ts");

const loadStart = db.indexOf("export async function loadInvoiceById");
const loadEnd = db.indexOf("export async function loadInvoices", loadStart);
const exactInvoiceLoader = db.slice(loadStart, loadEnd);

test("source preview reloads one compact authorized invoice and paged lines without a complete-document collector", () => {
  assert.ok(loadStart >= 0);
  assert.match(exactInvoiceLoader, /readInvoiceDocument\(invoiceId, "edit"/);
  assert.match(summaryRead, /get_invoice_summary_v1/);
  assert.match(summaryRead, /list_invoice_lines_page_v1/);
  assert.match(drawer, /useBillingSourceInvoiceByIdQuery\(invoiceId/);
  assert.match(drawer, /useInvoiceLinePage/);
  assert.match(billingReads, /contract=compact-v1&invoiceId=/);
  assert.doesNotMatch(drawer, /readCompleteInvoiceDocument|readInvoiceDocument/);
});

test("source reference stays read-only and outside the editable modal viewport", () => {
  assert.ok(
    modal.indexOf("</Modal>")
      < modal.indexOf("<SourceContractorInvoiceDrawer"),
  );
  assert.doesNotMatch(
    drawer,
    /sourceUnitCost|source_unit_cost|markupPercent|markup_percent|marginPercent|margin_percent|overallMargin|qbo_/i,
  );
  assert.doesNotMatch(drawer, /onApprove|onDelete|onSubmit|onEdit/);
  assert.match(drawer, /Read-only reference/);
});

test("private PDF preview uses the in-app canvas renderer without weakening browser policy", () => {
  assert.match(drawer, /downloadInvoicePdfBlob\(storagePath\)/);
  assert.match(drawer, /<PrivatePdfCanvasPreview/);
  assert.match(drawer, /href=\{pdfUrl\} target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(drawer, /window\.open\(/);
  assert.doesNotMatch(drawer, /<iframe|<embed|<object/);
  assert.match(preview, /import\("pdfjs-dist\/webpack\.mjs"\)/);
  assert.match(preview, /blob\.arrayBuffer\(\)/);
  assert.match(preview, /isEvalSupported: false/);
  assert.match(preview, /page\.render\(/);
  assert.match(preview, /renderTask\?\.cancel\(\)/);
  assert.match(nextConfig, /object-src 'none'/);
});
