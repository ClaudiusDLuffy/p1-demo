import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculateProfit } from "./profitCalculator";

test("profit calculation preserves margin, loss and zero-sale behavior", () => {
  assert.deepEqual(calculateProfit("150", "200", "25"), { profit: 50, actualMargin: 25, targetSell: 200 });
  assert.deepEqual(calculateProfit("100", "50", "0"), { profit: -50, actualMargin: -100, targetSell: 100 });
  assert.deepEqual(calculateProfit("100", "0", "50"), { profit: -100, actualMargin: null, targetSell: 200 });
  assert.equal(calculateProfit("10.01", "20", "30").targetSell, 14.3);
});

test("scratch inputs keep the existing empty/invalid input and margin limits", () => {
  for (const invalid of ["", "bad", "Infinity", "-1"]) {
    assert.deepEqual(calculateProfit(invalid, invalid, invalid), { profit: 0, actualMargin: null, targetSell: 0 });
  }
  assert.equal(calculateProfit("100", "200", "100").targetSell, 1_000_000);
});

test("shell connects the staff calculator to the real editor and scopes memory to its actor", () => {
  const shell = readFileSync("src/components/PortalShell.tsx", "utf8");
  const editor = readFileSync("src/features/billing/BillingInvoiceCreateModal.tsx", "utf8");
  assert.match(shell, /onProfitCalculatorHostChange=\{setBillingCalculatorHost\}/);
  assert.match(shell, /<FloatingProfitCalculator\s+key=\{currentUser\?\.id \|\| "signed-out"\}\s+visible=\{isManager && !invoiceController && \(page === "billing" \|\| modal === "createBillingInvoice"\)\}\s+editorHost=\{billingCalculatorHost\}/);
  assert.match(editor, /<div ref=\{onProfitCalculatorHostChange\}[^>]*\/>\s*<form ref=\{formRef\}/);
});
