import assert from "node:assert/strict";
import test from "node:test";
import {
  priceQuoteLines,
  quoteLineToBillingLine,
  quoteTotals,
  type QuoteCalculatorLine,
} from "./quoteCalculator";

const lines: QuoteCalculatorLine[] = [
  {
    id: "labor",
    type: "Labor",
    desc: "On-site labor",
    qty: 8,
    sourceRate: 80,
    rate: 80,
  },
  {
    id: "parts",
    type: "Materials",
    desc: "Replacement part",
    qty: 1,
    sourceRate: 200,
    rate: 200,
  },
];

test("sets the P1 labor rate and applies visible parts markup", () => {
  const priced = priceQuoteLines(lines, {
    laborRate: 110,
    partsMarkupPercent: 25,
    overallMarginPercent: 0,
  });

  assert.equal(priced[0].rate, 110);
  assert.equal(priced[1].type, "Parts/Hardware");
  assert.equal(priced[1].rate, 250);
});

test("applies overall margin after labor and parts pricing", () => {
  const priced = priceQuoteLines(lines, {
    laborRate: 110,
    partsMarkupPercent: 25,
    overallMarginPercent: 20,
  });

  assert.equal(priced[0].rate, 137.5);
  assert.equal(priced[1].rate, 312.5);
});

test("exposes each pricing stage in the summary", () => {
  const priced = priceQuoteLines(lines, {
    laborRate: 110,
    partsMarkupPercent: 25,
    overallMarginPercent: 0,
  });
  const totals = quoteTotals(priced, {
    laborRate: 110,
    partsMarkupPercent: 25,
    overallMarginPercent: 0,
  });

  assert.deepEqual(totals, {
    sourceCost: 840,
    partsMarkupUplift: 50,
    p1RateAdjustment: 240,
    overallMarginUplift: 0,
    subtotal: 1130,
  });
});

test("preserves source cost and tax metadata for the billing draft", () => {
  assert.deepEqual(
    quoteLineToBillingLine({
      ...lines[1],
      type: "Parts/Hardware",
      rate: 250,
    }),
    {
      type: "Parts/Hardware",
      desc: "Replacement part",
      qty: 1,
      rate: 250,
      isTaxable: true,
      sourceInvoiceLineId: null,
      sourceUnitCost: 200,
      markupPercent: 25,
    },
  );
});

test("allows a manually reduced P1 rate without invalid negative markup", () => {
  const converted = quoteLineToBillingLine({
    ...lines[1],
    rate: 175,
  });

  assert.equal(converted.rate, 175);
  assert.equal(converted.markupPercent, null);
});
