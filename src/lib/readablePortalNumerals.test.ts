import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const shell = read("src/components/PortalShell.tsx");
const contractorCreate = read("src/features/invoices/InvoiceCreateModal.tsx");
const contractorDetail = read("src/features/invoices/InvoiceDetail.tsx");
const billingCreate = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const billingDetail = read("src/features/billing/BillingInvoiceDetail.tsx");
const layout = read("src/app/layout.tsx");

test("portal identifiers and financial figures use readable tabular slashed-zero numerals", () => {
  assert.match(shell, /\.mono,[\s\S]*?\.numeric-readable/);
  assert.match(shell, /font-family: var\(--font-inter\)/);
  assert.match(shell, /font-variant-numeric: tabular-nums slashed-zero/);
  assert.match(shell, /font-feature-settings: "tnum" 1, "zero" 1/);
  assert.match(shell, /\.work-order-page-title,[\s\S]*?\.work-order-location-heading[\s\S]*?font-variant-numeric: tabular-nums slashed-zero/);
  assert.doesNotMatch(layout, /JetBrains_Mono|font-jetbrains-mono/);
});

test("large contractor and receivable totals no longer use the decorative serif face", () => {
  assert.match(contractorCreate, /className="numeric-readable"[\s\S]*?fmt\(Math\.round\(total/);
  assert.match(contractorDetail, /className="numeric-readable"[\s\S]*?fmt\(Math\.round\(inv\.total/);
  assert.match(billingCreate, /className="numeric-readable"[\s\S]*?fmt\(Math\.round\(total/);
});

test("receivable entry fields and mobile invoice values use the readable numeral treatment", () => {
  const numericReceivableInputs = billingCreate.match(/className="numeric-readable"\s+type="number"/g) || [];
  assert.ok(numericReceivableInputs.length >= 6);
  assert.match(contractorDetail, /className="numeric-readable"[\s\S]*?Qty: \{line\.qty \|\| 1\}/);
  assert.match(billingDetail, /className="numeric-readable"[\s\S]*?Qty: \{line\.qty\}/);
});
