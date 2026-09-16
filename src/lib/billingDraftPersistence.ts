import { z } from "zod";
import { DRAFT_MAX_BYTES } from "./drafts/draftSession";
import { isSafeDraftText } from "./drafts/safeDraftText";

export const BILLING_DRAFT_VERSION = 2;
export const BILLING_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const text = (maximum: number) => z.string().max(maximum).refine(isSafeDraftText);
const partialNumber = z.union([z.number().finite().min(-99_999_999.99).max(99_999_999.99), text(32), z.null()]);
const id = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().uuid().nullable(),
);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const lineSchema = z.object({ type: text(80).default("Other"), desc: text(4000).default(""), qty: partialNumber.default(""), rate: partialNumber.default(""),
  isTaxable: z.boolean().default(false), taxTreatmentManual: z.boolean().default(false), sourceInvoiceLineId: id.default(null), sourceWorkOrderPartId: id.default(null),
  sourceUnitCost: partialNumber.default(null), markupPercent: partialNumber.default(null) }).strict();
const formSchema = z.object({ num: text(80).default(""), invoiceDate: text(10).default(""), serviceDate: text(10).default(""), dueDate: text(10).default(""),
  workOrderId: text(120).default(""), territory: text(200).default(""), equipmentTag: text(200).default("7-ELEVEN: Miscellaneous"),
  storeNumber: text(80).default(""), storeAddress: text(1000).default(""), terms: text(200).default("Net 30"), cme: text(200).default(""),
  taxState: text(2).default(""), taxRateOverride: partialNumber.default(""), salesTaxOverride: partialNumber.default(""),
  state: z.enum(["draft", "submitted"]).default("submitted"), lines: z.array(lineSchema).max(1000).default([]) }).strict();
const sourceSchema = z.object({ id: z.string().uuid(), num: text(80), subtotal: z.number().finite(), total: z.number().finite(), invoiceVersion: version }).strict();
const snapshotSchema = z.object({ key: text(400), value: z.object({ workOrderId: text(120).nullable(), expectedInvoiceVersion: version,
  expectedAssignmentVersion: version, expectedWorkflowCycle: version }).strict() }).strict();
const schema = z.object({ version: z.literal(BILLING_DRAFT_VERSION), savedAt: z.string().datetime(), form: formSchema,
  selectedSourceIds: z.array(z.string().uuid()).max(100), sourceSnapshots: z.record(z.string().uuid(), sourceSchema), partsMarkup: text(32),
  customTerritory: z.boolean(), numberEdited: z.boolean(), financialSnapshot: snapshotSchema.nullable() }).strict()
  .refine(value => Object.keys(value.sourceSnapshots).length <= 100);
export type BillingDraftPayload = z.infer<typeof schema>;
export function validateBillingDraft(value: unknown): BillingDraftPayload | null {
  const result = schema.safeParse(value); return result.success ? result.data : null;
}
/** Explicit projection: full source invoices/lines/provider/PDF fields never persist. */
export function createBillingDraftPayload(input: { form: Record<string, unknown>; selectedSourceIds?: unknown[]; sourceSnapshots?: Record<string, unknown>;
  partsMarkup?: unknown; customTerritory?: unknown; numberEdited?: unknown; financialSnapshot?: unknown; savedAt?: string }): BillingDraftPayload {
  const sources: Record<string, z.infer<typeof sourceSchema>> = {};
  for (const [key, value] of Object.entries(input.sourceSnapshots ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const candidate = sourceSchema.safeParse({ id: key, num: record.num ?? "", subtotal: record.subtotal ?? 0,
      total: record.total ?? 0, invoiceVersion: record.invoiceVersion ?? null });
    if (candidate.success) sources[key] = candidate.data;
  }
  const payload = schema.parse({ version: BILLING_DRAFT_VERSION, savedAt: input.savedAt ?? new Date().toISOString(), form: input.form,
    selectedSourceIds: input.selectedSourceIds ?? [], sourceSnapshots: sources, partsMarkup: input.partsMarkup ?? "25", customTerritory: input.customTerritory ?? false,
    numberEdited: input.numberEdited ?? false, financialSnapshot: input.financialSnapshot ?? null });
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > DRAFT_MAX_BYTES) throw new Error("Draft exceeds recovery limit");
  return payload;
}
/** Payload parser is not an ownership gate; production reads require the session envelope. */
export function parseBillingDraft(raw: string | null, now = Date.now()): BillingDraftPayload | null {
  if (!raw || raw.length > DRAFT_MAX_BYTES || new TextEncoder().encode(raw).byteLength > DRAFT_MAX_BYTES) return null;
  try { const payload = validateBillingDraft(JSON.parse(raw) as unknown); if (!payload) return null;
    const at = Date.parse(payload.savedAt); return at <= now && now - at <= BILLING_DRAFT_MAX_AGE_MS ? payload : null;
  } catch { return null; }
}
