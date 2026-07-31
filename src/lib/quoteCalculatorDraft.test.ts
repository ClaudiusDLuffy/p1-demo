import assert from "node:assert/strict";
import test from "node:test";
import {
  clampBulkQuoteLineCount,
  createQuoteCalculatorDraft,
  parseQuoteCalculatorDraft,
  quoteCalculatorDraftKey,
} from "./quoteCalculatorDraft";

const draft = createQuoteCalculatorDraft(
  {
    workOrderId: "WOT123",
    selectedSourceId: "source-1",
    pricing: {
      laborRate: "110",
      partsMarkupPercent: "25",
      overallMarginPercent: "10",
    },
    lines: [{
      id: "line-1",
      type: "Labor",
      desc: "Diagnostic labor",
      qty: 2,
      sourceRate: 80,
      rate: 110,
      sourceInvoiceLineId: "source-line-1",
    }],
  },
  "2026-07-31T04:50:00.000Z",
);

test("builds a user and work-order scoped storage key", () => {
  assert.equal(
    quoteCalculatorDraftKey("user@example.com", "WOT 123"),
    "p1:quote-calculator:v1:user%40example.com:WOT%20123",
  );
});

test("round-trips a valid calculator draft", () => {
  assert.deepEqual(
    parseQuoteCalculatorDraft(JSON.stringify(draft), "WOT123"),
    draft,
  );
});

test("rejects a draft belonging to another work order", () => {
  assert.equal(
    parseQuoteCalculatorDraft(JSON.stringify(draft), "WOT999"),
    null,
  );
});

test("rejects malformed calculator lines", () => {
  const malformed = {
    ...draft,
    lines: [{ ...draft.lines[0], rate: "not-a-number" }],
  };
  assert.equal(
    parseQuoteCalculatorDraft(JSON.stringify(malformed), "WOT123"),
    null,
  );
});

test("clamps bulk line creation to a safe range", () => {
  assert.equal(clampBulkQuoteLineCount(0), 1);
  assert.equal(clampBulkQuoteLineCount(4.4), 4);
  assert.equal(clampBulkQuoteLineCount(200), 25);
  assert.equal(clampBulkQuoteLineCount("bad"), 1);
});
