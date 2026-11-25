import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Source guard complements the real 320px browser geometry regression. An
// overflow-hidden card can be scrolled by scrollIntoView, masking clipping.
test("mobile invoice header can shrink and wrap a long invoice number", () => {
  const source = readFileSync(resolve("src/components/PortalShell.tsx"), "utf8");
  const rule = source.match(/\.invoice-top-header-left\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, "Shared mobile invoice header rule must remain present");
  assert.match(rule, /flex:\s*1\s+1\s+0\s*!important/);
  assert.match(rule, /min-width:\s*0\s*!important/);
  assert.match(rule, /max-width:\s*100%\s*!important/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
  const seller = source.match(/\.invoice-top-header-right\s*\{([^}]+)\}/)?.[1];
  assert.ok(seller);
  assert.match(seller, /flex:\s*1\s+1\s+0\s*!important/);
  assert.match(seller, /min-width:\s*0\s*!important/);
});

test("contractor and P1 billing details both use the shared wrapping header", () => {
  for (const path of [
    "src/features/invoices/InvoiceDetail.tsx",
    "src/features/billing/BillingInvoiceDetail.tsx",
  ]) {
    const source = readFileSync(resolve(path), "utf8");
    assert.match(source, /className="invoice-top-header-left"/, path);
  }
});
