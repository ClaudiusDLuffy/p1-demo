import assert from "node:assert/strict";
import test from "node:test";
import {
  countWorkOrderBoundBillingLines,
  hasWorkOrderBoundBillingMetadata,
  makeWorkOrderBoundBillingLinesManual,
} from "./billingSourceWorkOrderChange";

test("counts invoice- and work-order-part sourced lines for a work-order transition", () => {
  const lines = [
    { desc: "Imported invoice line", sourceInvoiceLineId: "source-line", sourceUnitCost: 80, markupPercent: 25 },
    { desc: "P1 purchased part", sourceWorkOrderPartId: "work-order-part", sourceUnitCost: 100, markupPercent: 25 },
    { desc: "Manual labor", sourceInvoiceLineId: null, sourceWorkOrderPartId: null, sourceUnitCost: null, markupPercent: null },
  ];

  assert.equal(countWorkOrderBoundBillingLines(lines), 2);
  assert.equal(hasWorkOrderBoundBillingMetadata(lines[0]), true);
  assert.equal(hasWorkOrderBoundBillingMetadata(lines[2]), false);
});

test("manualizes work-order-bound line references without changing amounts or descriptions", () => {
  const lines = [
    { desc: "Imported part", qty: 2, rate: 50, sourceInvoiceLineId: "source-line", sourceUnitCost: 40, markupPercent: 25 },
    { desc: "P1 part", qty: 1, rate: 125, sourceWorkOrderPartId: "work-order-part", sourceUnitCost: 100, markupPercent: 25 },
    { desc: "Manual labor", qty: 1, rate: 110, sourceInvoiceLineId: null, sourceUnitCost: null, markupPercent: null },
  ];

  const result = makeWorkOrderBoundBillingLinesManual(lines);

  assert.equal(result.detachedLineCount, 2);
  assert.deepEqual(result.lines, [
    { desc: "Imported part", qty: 2, rate: 50, sourceInvoiceLineId: null, sourceWorkOrderPartId: null, sourceUnitCost: null, markupPercent: null },
    { desc: "P1 part", qty: 1, rate: 125, sourceWorkOrderPartId: null, sourceInvoiceLineId: null, sourceUnitCost: null, markupPercent: null },
    lines[2],
  ]);
  assert.equal(lines[0].sourceInvoiceLineId, "source-line", "the source form state is not mutated");
});
