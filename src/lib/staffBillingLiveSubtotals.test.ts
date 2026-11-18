import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { summarizeInvoiceLineTypes } from "./invoiceLineSubtotals";

// Evaluate the editor's actual derived-value expression. react-hook-form can
// retain its watched array identity while changing a nested field; React's
// memo dependency comparison must not conceal those edits from the summary.
function editorSummary() {
  const source = readFileSync(resolve("src/features/billing/BillingInvoiceCreateModal.tsx"), "utf8");
  const start = source.indexOf("const lineTypeSummary = ");
  const end = source.indexOf("\n\n  const sourceOwnerById", start);
  assert.ok(start >= 0 && end > start);
  const render = new Function("lines", "salesTax", "useMemo", "summarizeInvoiceLineTypes",
    `${source.slice(start, end)}\nreturn lineTypeSummary;`);
  let previous: unknown[] | undefined;
  let value: ReturnType<typeof summarizeInvoiceLineTypes>;
  const useMemo = (factory: () => typeof value, dependencies: unknown[]) => {
    if (!previous || dependencies.some((dependency, index) => !Object.is(dependency, previous![index]))) {
      value = factory();
      previous = [...dependencies];
    }
    return value;
  };
  return (lines: Record<string, unknown>[], tax = 0): ReturnType<typeof summarizeInvoiceLineTypes> =>
    render(lines, tax, useMemo, summarizeInvoiceLineTypes);
}

test("live staff category totals follow nested rate and quantity edits with unchanged watched-array identity", () => {
  const render = editorSummary();
  const lines = [{ type: "Labor", qty: 1, rate: 110 }];
  assert.equal(render(lines).subtotal, 110);
  lines[0].rate = 100;
  assert.equal(render(lines).categories[0].amount, 100);
  lines[0].qty = 2;
  assert.equal(render(lines).subtotal, 200);
});

test("live staff category labels follow nested type changes and keep tax separate", () => {
  const render = editorSummary();
  const lines = [{ type: "Labor", qty: 1, rate: 100 }];
  assert.equal(render(lines, 5).categories[0].category, "Labor");
  lines[0].type = "Other";
  const result = render(lines, 5);
  assert.deepEqual(result.categories.map(category => category.category), ["Other"]);
  assert.equal(result.subtotal, 100);
  assert.equal(result.grandTotal, 105);
});
