import assert from "node:assert/strict";
import test from "node:test";
import {
  clampBulkQuoteLineCount,
  createQuoteCalculatorDraft,
  parseQuoteCalculatorDraft,
} from "./quoteCalculatorDraft";

const draft = createQuoteCalculatorDraft(
  {
    workOrderId: "WOT123",
    selectedSourceId: "00000000-0000-4000-8000-000000000001",
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
      sourceInvoiceLineId: "00000000-0000-4000-8000-000000000002",
    }],
  },
  "2026-07-31T04:50:00.000Z",
);

test("minimal quote payload is versioned and retains no profile or owner substitute", () => {
  assert.equal(draft.version, 2);
  assert.equal(parseQuoteCalculatorDraft(JSON.stringify({ ...draft, profile: {} }), "WOT123"), null);
});
test("quote keeps no added TTL but rejects invalid timestamp, binary fields and oversized lines", () => {
  assert.ok(parseQuoteCalculatorDraft(JSON.stringify(draft), "WOT123"));
  for (const extra of [{ savedAt: "never" }, { pdfText: "synthetic" }, { lines: [{ ...draft.lines[0], desc: "x".repeat(4001) }] }]) {
    assert.equal(parseQuoteCalculatorDraft(JSON.stringify({ ...draft, ...extra }), "WOT123"), null);
  }
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
