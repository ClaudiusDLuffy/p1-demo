import assert from "node:assert/strict";
import test from "node:test";
import { BillingPartPriceCorrectionSchema, correctedPartPrice, effectivePartPriceCost, refreshedP1PartPrice } from "./billingPartPriceCorrection";
import { StaffFinancialLineInputSchema, StaffFinancialLineSchema } from "./staffInvoiceContracts";
import { createBillingDraftPayload, validateBillingDraft } from "./billingDraftPersistence";
import { makeWorkOrderBoundBillingLinesManual } from "../features/billing/billingSourceWorkOrderChange";
import { parseInvoiceLinePage } from "../features/invoices/invoiceReadContracts";

const correction = { basis: "purchase_cost" as const, amount: 3275.37, reason: "Verified synthetic contractor receipt" };
const partId = "b8500000-0000-4000-8000-000000000001";
const sourced = { type: "Parts/Hardware", desc: "Synthetic compressor", qty: 1, rate: 4094.21,
  isTaxable: false, sourceWorkOrderPartId: partId, sourceUnitCost: 1.01, markupPercent: 25,
  priceCorrection: correction };

test("purchase cost applies markup once; exact final billing price applies no markup", () => {
  assert.deepEqual(correctedPartPrice(correction), { rate: 4094.21, markupPercent: 25 });
  assert.deepEqual(correctedPartPrice({ ...correction, basis: "billing_rate" }), { rate: 3275.37, markupPercent: null });
  for (let cents = 1; cents <= 10000; cents++) {
    assert.equal(correctedPartPrice({ ...correction, amount: cents / 100 }).rate, Math.floor((cents * 125 + 50) / 100) / 100);
  }
});
test("reason, positive cents, maximum amount and strict correction metadata are validated", () => {
  for (const bad of [{ ...correction, amount: 0 }, { ...correction, amount: -1 }, { ...correction, amount: 1.001 },
    { ...correction, amount: "3275.37" }, { ...correction, amount: Infinity }, { ...correction, amount: NaN },
    { ...correction, reason: "short" }, { ...correction, reason: "ten characters\nnewline" },
    { ...correction, reason: "x".repeat(1001) }, { ...correction, actorId: partId },
    { ...correction, amount: 99_999_999.99 }, { ...correction, basis: "unknown" }]) {
    assert.equal(BillingPartPriceCorrectionSchema.safeParse(bad).success, false);
  }
  assert.equal(BillingPartPriceCorrectionSchema.safeParse({ ...correction, basis: "billing_rate", amount: 99_999_999.99 }).success, true);
});
test("financial command keeps original source cost and correction; rejects incompatible prices or source stripping", () => {
  const result = StaffFinancialLineSchema.parse(sourced);
  assert.equal(result.sourceUnitCost, 1.01); assert.deepEqual(result.priceCorrection, correction);
  for (const bad of [{ ...sourced, rate: 3275.37 }, { ...sourced, markupPercent: null },
    { ...sourced, sourceWorkOrderPartId: null }, { ...sourced, type: "Labor" }]) {
    assert.equal(StaffFinancialLineInputSchema.safeParse(bad).success, false);
  }
  assert.equal(StaffFinancialLineInputSchema.safeParse({ ...sourced, rate: 3275.37, markupPercent: null,
    priceCorrection: { ...correction, basis: "billing_rate" } }).success, true);
});
test("P1 source refresh preserves correction and reset restores default pricing", () => {
  assert.equal(effectivePartPriceCost(sourced), 3275.37);
  assert.equal(effectivePartPriceCost({ ...sourced, priceCorrection: { ...correction, basis: "billing_rate" } }), 1.01);
  assert.deepEqual(refreshedP1PartPrice(1.01, correction), { rate: 4094.21, markupPercent: 25 });
  assert.deepEqual(refreshedP1PartPrice(500, { ...correction, basis: "billing_rate" }), { rate: 3275.37, markupPercent: null });
  assert.deepEqual(refreshedP1PartPrice(1.01, null), { rate: 1.26, markupPercent: 25 });
});
test("browser draft persists only validated correction data and work-order detachment clears source-bound correction", () => {
  const draft = createBillingDraftPayload({ form: { lines: [sourced] } });
  assert.deepEqual(validateBillingDraft(draft)?.form.lines[0].priceCorrection, correction);
  const detached = makeWorkOrderBoundBillingLinesManual([sourced]);
  assert.equal(detached.lines[0].priceCorrection, null); assert.equal(detached.lines[0].rate, 4094.21);
});
test("bounded line reads preserve correction metadata and reject malformed persisted corrections", () => {
  const row = { id: partId, invoice_id: partId, position: 1, type: "Parts/Hardware", description: "Synthetic",
    qty: 1, rate: 4094.21, amount: 4094.21, is_taxable: false, source_work_order_part_id: partId,
    source_unit_cost: 1.01, markup_percent: 25, price_correction: correction };
  const page = { projection: "line_page", invoiceVersion: 1, pageSize: 50, hasMore: false, nextCursor: null, items: [row] };
  assert.deepEqual(parseInvoiceLinePage(page).items[0].priceCorrection, correction);
  assert.throws(() => parseInvoiceLinePage({ ...page, items: [{ ...row, price_correction: { ...correction, reason: "bad" } }] }));
});
