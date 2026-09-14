import { z } from "zod";
import { DRAFT_MAX_BYTES } from "./drafts/draftSession";
import { isSafeDraftText } from "./drafts/safeDraftText";
import type { QuoteCalculatorLine } from "./quoteCalculator";

export const QUOTE_CALCULATOR_DRAFT_VERSION = 2;
export const MAX_BULK_QUOTE_LINES = 25;
export type QuoteCalculatorDraftPricing = { laborRate: string; partsMarkupPercent: string; overallMarginPercent: string };
const text = (max: number) => z.string().max(max).refine(isSafeDraftText);
const amount = z.number().finite().min(0).max(99_999_999.99);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const schema = z.object({ version: z.literal(QUOTE_CALCULATOR_DRAFT_VERSION), workOrderId: text(120).min(1), selectedSourceId: z.union([z.string().uuid(), z.literal("")]),
  lines: z.array(z.object({ id: text(100).min(1), type: text(80), desc: text(4000), qty: amount, sourceRate: amount, rate: amount,
    sourceInvoiceLineId: z.string().uuid().nullable().optional() }).strict()).max(1000),
  pricing: z.object({ laborRate: text(32), partsMarkupPercent: text(32), overallMarginPercent: text(32) }).strict(), savedAt: z.string().datetime(),
  financialSnapshot: z.object({ workOrderId: text(120).nullable(), expectedInvoiceVersion: version,
    expectedAssignmentVersion: version, expectedWorkflowCycle: version }).strict().nullable().default(null) }).strict();
export type QuoteCalculatorDraft = z.infer<typeof schema>;
export const validateQuoteCalculatorDraft = (value: unknown): QuoteCalculatorDraft | null => {
  const result = schema.safeParse(value); return result.success ? result.data : null;
};
export const createQuoteCalculatorDraft = (input: { workOrderId: string; selectedSourceId: string; lines: QuoteCalculatorLine[];
  pricing: QuoteCalculatorDraftPricing; financialSnapshot?: QuoteCalculatorDraft["financialSnapshot"] }, savedAt = new Date().toISOString()): QuoteCalculatorDraft =>
  schema.parse({ version: QUOTE_CALCULATOR_DRAFT_VERSION, ...input, savedAt });
// No new expiry: quote recovery historically had no TTL. Ownership is enforced by the session envelope.
export const parseQuoteCalculatorDraft = (raw: string | null, expectedWorkOrderId: string): QuoteCalculatorDraft | null => {
  if (!raw || raw.length > DRAFT_MAX_BYTES || new TextEncoder().encode(raw).byteLength > DRAFT_MAX_BYTES) return null;
  try { const value = validateQuoteCalculatorDraft(JSON.parse(raw) as unknown); return value?.workOrderId === expectedWorkOrderId ? value : null;
  } catch { return null; }
};
export const clampBulkQuoteLineCount = (value: unknown) => {
  const number = Math.round(Number(value)); return Number.isFinite(number) ? Math.min(Math.max(number, 1), MAX_BULK_QUOTE_LINES) : 1;
};
