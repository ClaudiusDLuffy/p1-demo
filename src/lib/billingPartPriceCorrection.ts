import { z } from "zod";

const MAX_MONEY = 99_999_999.99;
const withDefaultMarkup = (amount: number) => Math.round(Math.round(amount * 100) * 1.25) / 100;
export const BillingPartPriceCorrectionSchema = z.object({
  basis: z.enum(["purchase_cost", "billing_rate"]),
  amount: z.number().finite().positive().max(MAX_MONEY)
    .refine(value => /^\d+(?:\.\d{1,2})?$/.test(String(value)), "Use an amount with at most two decimal places"),
  reason: z.string().trim().min(10, "Explain the correction in at least 10 characters").max(1000)
    .refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Use a single-line reason without control characters"),
}).strict().refine(value => value.basis !== "purchase_cost" || withDefaultMarkup(value.amount) <= MAX_MONEY,
  { path: ["amount"], message: "The price after markup exceeds the supported amount" });
export type BillingPartPriceCorrection = z.infer<typeof BillingPartPriceCorrectionSchema>;

/** A correction is invoice-local. Never overwrite the recorded source cost. */
export function correctedPartPrice(correction: BillingPartPriceCorrection) {
  return { rate: correction.basis === "purchase_cost" ? withDefaultMarkup(correction.amount) : correction.amount,
    markupPercent: correction.basis === "purchase_cost" ? 25 : null };
}

export function refreshedP1PartPrice(recordedCost: number, correction?: BillingPartPriceCorrection | null) {
  return correction ? correctedPartPrice(correction) : { rate: withDefaultMarkup(recordedCost), markupPercent: 25 };
}

export function effectivePartPriceCost(line: { sourceUnitCost?: number | null; priceCorrection?: BillingPartPriceCorrection | null }) {
  return line.priceCorrection?.basis === "purchase_cost" ? line.priceCorrection.amount : line.sourceUnitCost ?? null;
}
