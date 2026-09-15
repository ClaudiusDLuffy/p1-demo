import { z } from "zod";
import { contractorInvoiceSnapshotSchema, type ContractorInvoiceSnapshot } from "./contractorInvoiceCommandContracts";
import { DRAFT_MAX_BYTES } from "./drafts/draftSession";
import { isSafeDraftText } from "./drafts/safeDraftText";

export const CONTRACTOR_INVOICE_CORRECTION_DRAFT_VERSION = 1;
export const CONTRACTOR_INVOICE_CORRECTION_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const text = (maximum: number) => z.string().max(maximum).refine(isSafeDraftText);
const partialNumber = z.union([
  z.number().finite().min(-99_999_999.99).max(99_999_999.99),
  text(32),
  z.null(),
]);
const lineSchema = z.object({
  type: text(80).default("Other"),
  desc: text(4000).default(""),
  qty: partialNumber.default(""),
  rate: partialNumber.default(""),
}).strict();
const formSchema = z.object({
  num: text(80).default(""),
  invoiceDate: text(10).default(""),
  serviceDate: text(10).default(""),
  terms: text(200).default("Net 30"),
  tax: text(32).default(""),
  cme: text(200).default(""),
  uploadOnly: z.boolean().default(false),
  uploadedTotal: text(32).default(""),
  lines: z.array(lineSchema).max(1000).default([]),
}).strict();
const schema = z.object({
  version: z.literal(CONTRACTOR_INVOICE_CORRECTION_DRAFT_VERSION),
  savedAt: z.string().datetime(),
  form: formSchema,
  snapshot: contractorInvoiceSnapshotSchema,
  replacementPdfNeedsReselection: z.boolean(),
}).strict();

export type ContractorInvoiceCorrectionDraft = z.infer<typeof schema>;

export function validateContractorInvoiceCorrectionDraft(value: unknown): ContractorInvoiceCorrectionDraft | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function createContractorInvoiceCorrectionDraft(input: {
  form: unknown;
  snapshot: ContractorInvoiceSnapshot;
  replacementPdfNeedsReselection?: boolean;
  savedAt?: string;
}): ContractorInvoiceCorrectionDraft {
  const payload = schema.parse({
    version: CONTRACTOR_INVOICE_CORRECTION_DRAFT_VERSION,
    savedAt: input.savedAt ?? new Date().toISOString(),
    form: input.form,
    snapshot: input.snapshot,
    replacementPdfNeedsReselection: input.replacementPdfNeedsReselection ?? false,
  });
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > DRAFT_MAX_BYTES) {
    throw new Error("Correction draft exceeds recovery limit");
  }
  return payload;
}

export function correctionDraftMatchesSnapshot(
  draft: ContractorInvoiceCorrectionDraft,
  snapshot: ContractorInvoiceSnapshot,
): boolean {
  return draft.snapshot.workOrderId === snapshot.workOrderId
    && draft.snapshot.expectedAssignmentVersion === snapshot.expectedAssignmentVersion
    && draft.snapshot.expectedWorkflowCycle === snapshot.expectedWorkflowCycle
    && draft.snapshot.invoiceId === snapshot.invoiceId
    && draft.snapshot.expectedInvoiceVersion === snapshot.expectedInvoiceVersion;
}
