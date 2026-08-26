import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const db = read("src/lib/db.ts");
const modal = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const drawer = read("src/features/billing/SourceContractorInvoiceDrawer.tsx");

const loadStart = db.indexOf("export async function loadInvoiceById");
const loadEnd = db.indexOf("export async function loadInvoices", loadStart);
const exactInvoiceLoader = db.slice(loadStart, loadEnd);

test("source preview reloads one live contractor invoice through existing RLS", () => {
  assert.ok(loadStart >= 0);
  assert.match(exactInvoiceLoader, /\.eq\("id", invoiceId\)/);
  assert.match(exactInvoiceLoader, /\.eq\("invoice_type", "contractor"\)/);
  assert.match(exactInvoiceLoader, /\.is\("deleted_at", null\)/);
  assert.match(drawer, /useInvoiceByIdQuery\(invoiceId/);
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
