import { defaultLineTaxable } from "./billingRules";

export type QuoteCalculatorLine = {
  id: string;
  type: string;
  desc: string;
  qty: number;
  sourceRate: number;
  rate: number;
  sourceInvoiceLineId?: string | null;
};

export type QuotePricing = {
  laborRate: number;
  partsMarkupPercent: number;
  overallMarginPercent: number;
};

export const roundMoney = (value: number) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const isQuotePartsLine = (type: unknown) =>
  /part|hardware|material/i.test(String(type || ""));

export const normalizeQuoteLineType = (type: unknown) => {
  const value = String(type || "").trim();
  if (/^labor$/i.test(value)) return "Labor";
  if (/part|hardware|material/i.test(value)) return "Parts/Hardware";
  if (/travel|truck/i.test(value)) return "Truck Charge";
  if (/shipping|freight/i.test(value)) return "Shipping";
  return "Other";
};

const finiteNonNegative = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function priceQuoteLines(
  lines: QuoteCalculatorLine[],
  pricing: QuotePricing,
): QuoteCalculatorLine[] {
  const laborRate = finiteNonNegative(pricing.laborRate, 110);
  const partsMarkup = finiteNonNegative(pricing.partsMarkupPercent) / 100;
  const margin = Math.min(
    finiteNonNegative(pricing.overallMarginPercent),
    99.99,
  ) / 100;
  const marginMultiplier = 1 / (1 - margin);

  return lines.map((line) => {
    const type = normalizeQuoteLineType(line.type);
    const sourceRate = finiteNonNegative(line.sourceRate);
    const baseRate = type === "Labor"
      ? laborRate
      : isQuotePartsLine(type)
        ? sourceRate * (1 + partsMarkup)
        : sourceRate;

    return {
      ...line,
      type,
      sourceRate,
      rate: roundMoney(baseRate * marginMultiplier),
    };
  });
}

export function quoteTotals(
  lines: QuoteCalculatorLine[],
  pricing: QuotePricing,
) {
  const sourceCost = lines.reduce(
    (sum, line) =>
      sum
      + finiteNonNegative(line.qty)
        * finiteNonNegative(line.sourceRate),
    0,
  );
  const partsMarkupUplift = lines
    .filter((line) => isQuotePartsLine(line.type))
    .reduce(
      (sum, line) =>
        sum
        + finiteNonNegative(line.qty)
          * finiteNonNegative(line.sourceRate)
          * finiteNonNegative(pricing.partsMarkupPercent)
          / 100,
      0,
    );
  const preMarginTotal = priceQuoteLines(lines, {
    ...pricing,
    overallMarginPercent: 0,
  }).reduce(
    (sum, line) =>
      sum + finiteNonNegative(line.qty) * finiteNonNegative(line.rate),
    0,
  );
  const subtotal = lines.reduce(
    (sum, line) =>
      sum + finiteNonNegative(line.qty) * finiteNonNegative(line.rate),
    0,
  );

  return {
    sourceCost: roundMoney(sourceCost),
    partsMarkupUplift: roundMoney(partsMarkupUplift),
    p1RateAdjustment: roundMoney(
      preMarginTotal - sourceCost - partsMarkupUplift,
    ),
    overallMarginUplift: roundMoney(subtotal - preMarginTotal),
    subtotal: roundMoney(subtotal),
  };
}

export function quoteLineToBillingLine(line: QuoteCalculatorLine) {
  const sourceRate = finiteNonNegative(line.sourceRate);
  const rate = finiteNonNegative(line.rate);
  const markup = sourceRate > 0 ? ((rate / sourceRate) - 1) * 100 : null;
  const markupPercent = markup != null && markup >= 0
    ? roundMoney(markup)
    : null;

  return {
    type: normalizeQuoteLineType(line.type),
    desc: String(line.desc || "").trim(),
    qty: finiteNonNegative(line.qty),
    rate: roundMoney(rate),
    isTaxable: defaultLineTaxable(line.type, line.desc),
    sourceInvoiceLineId: line.sourceInvoiceLineId || null,
    sourceUnitCost: roundMoney(sourceRate),
    markupPercent,
  };
}
