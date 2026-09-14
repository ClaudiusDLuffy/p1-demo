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

test("numeric styles use familiar unslashed zeros while retaining aligned full-height digits", () => {
  const numericRule = shell.match(/\.mono,\s*\.numeric-readable\s*\{([^}]+)\}/)?.[1];
  const workOrderRule = shell.match(/\.work-order-page-title,\s*\.work-order-location-heading\s*\{([^}]+)\}/)?.[1];
  for (const rule of [numericRule, workOrderRule]) {
    assert.ok(rule, "Shared numeric styles must remain available to existing callers");
    assert.match(rule, /font-family: Arial, "Helvetica Neue", Helvetica, sans-serif/);
    assert.match(rule, /font-variant-numeric: tabular-nums lining-nums/);
    assert.match(rule, /font-feature-settings: "tnum" 1, "lnum" 1, "zero" 0/);
    assert.doesNotMatch(rule, /slashed-zero|"zero" 1/);
  }
});

test("numeric readability does not replace the body font or add another downloaded typeface", () => {
  assert.match(layout, /fontFamily: "var\(--font-inter\), system-ui, sans-serif"/);
  assert.match(layout, /import \{ Inter, Instrument_Serif \} from "next\/font\/google"/);
  assert.doesNotMatch(layout, /JetBrains_Mono|font-jetbrains-mono/);
  assert.match(shell, /\.display \{ font-family: var\(--font-instrument-serif\), Georgia, serif/);
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
