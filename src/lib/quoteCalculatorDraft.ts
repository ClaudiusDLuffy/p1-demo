import type { QuoteCalculatorLine } from "./quoteCalculator";

export const QUOTE_CALCULATOR_DRAFT_VERSION = 1;
export const MAX_BULK_QUOTE_LINES = 25;

export type QuoteCalculatorDraftPricing = {
  laborRate: string;
  partsMarkupPercent: string;
  overallMarginPercent: string;
};

export type QuoteCalculatorDraft = {
  version: typeof QUOTE_CALCULATOR_DRAFT_VERSION;
  workOrderId: string;
  selectedSourceId: string;
  lines: QuoteCalculatorLine[];
  pricing: QuoteCalculatorDraftPricing;
  savedAt: string;
};

type CreateQuoteCalculatorDraftInput = Omit<
  QuoteCalculatorDraft,
  "version" | "savedAt"
>;

const finiteNonNegative = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const parseLine = (value: unknown): QuoteCalculatorLine | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const qty = finiteNonNegative(candidate.qty);
  const sourceRate = finiteNonNegative(candidate.sourceRate);
  const rate = finiteNonNegative(candidate.rate);

  if (
    typeof candidate.id !== "string"
    || !candidate.id
    || typeof candidate.type !== "string"
    || typeof candidate.desc !== "string"
    || qty == null
    || sourceRate == null
    || rate == null
  ) {
    return null;
  }

  return {
    id: candidate.id,
    type: candidate.type,
    desc: candidate.desc,
    qty,
    sourceRate,
    rate,
    sourceInvoiceLineId:
      typeof candidate.sourceInvoiceLineId === "string"
        ? candidate.sourceInvoiceLineId
        : null,
  };
};

export const quoteCalculatorDraftKey = (
  userId: string | null | undefined,
  workOrderId: string,
) =>
  [
    "p1",
    "quote-calculator",
    `v${QUOTE_CALCULATOR_DRAFT_VERSION}`,
    encodeURIComponent(userId || "staff"),
    encodeURIComponent(workOrderId),
  ].join(":");

export const createQuoteCalculatorDraft = (
  input: CreateQuoteCalculatorDraftInput,
  savedAt = new Date().toISOString(),
): QuoteCalculatorDraft => ({
  version: QUOTE_CALCULATOR_DRAFT_VERSION,
  ...input,
  savedAt,
});

export const parseQuoteCalculatorDraft = (
  raw: string | null,
  expectedWorkOrderId: string,
): QuoteCalculatorDraft | null => {
  if (!raw) return null;

  try {
    const candidate = JSON.parse(raw) as Record<string, unknown>;
    if (
      candidate.version !== QUOTE_CALCULATOR_DRAFT_VERSION
      || candidate.workOrderId !== expectedWorkOrderId
      || typeof candidate.selectedSourceId !== "string"
      || typeof candidate.savedAt !== "string"
      || !candidate.pricing
      || typeof candidate.pricing !== "object"
      || !Array.isArray(candidate.lines)
    ) {
      return null;
    }

    const pricing = candidate.pricing as Record<string, unknown>;
    if (
      typeof pricing.laborRate !== "string"
      || typeof pricing.partsMarkupPercent !== "string"
      || typeof pricing.overallMarginPercent !== "string"
    ) {
      return null;
    }

    const lines = candidate.lines.map(parseLine);
    if (!lines.length || lines.some((line) => line == null)) return null;

    return {
      version: QUOTE_CALCULATOR_DRAFT_VERSION,
      workOrderId: expectedWorkOrderId,
      selectedSourceId: candidate.selectedSourceId,
      lines: lines as QuoteCalculatorLine[],
      pricing: {
        laborRate: pricing.laborRate,
        partsMarkupPercent: pricing.partsMarkupPercent,
        overallMarginPercent: pricing.overallMarginPercent,
      },
      savedAt: candidate.savedAt,
    };
  } catch {
    return null;
  }
};

export const clampBulkQuoteLineCount = (value: unknown) => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.min(Math.max(number, 1), MAX_BULK_QUOTE_LINES);
};
