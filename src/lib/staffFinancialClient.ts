import { z } from "zod";
import { AppError } from "./errors/AppError";
import { FinancialDeleteSchema, StaffInvoiceSaveSchema, type FinancialDeleteCommand, type StaffInvoiceSaveCommand } from "./staffInvoiceContracts";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const invoiceSnapshot = z.object({ id: z.string().uuid(), invoiceVersion: version,
  wot: z.string().nullable().optional(), workOrderId: z.string().nullable().optional(),
  assignmentVersion: version.nullable(), workflowCycle: version.nullable(),
});
const workSnapshot = z.object({ id: z.string().min(1), contractorAssignmentVersion: version, workflowCycle: version });
export type StaffInvoiceSnapshot = {
  workOrderId: string | null; expectedInvoiceVersion: number | null;
  expectedAssignmentVersion: number | null; expectedWorkflowCycle: number | null;
};
export function captureStaffInvoiceSnapshot(invoice: unknown, workOrder: unknown = undefined): StaffInvoiceSnapshot {
  if (invoice != null) {
    const parsed = invoiceSnapshot.safeParse(invoice);
    if (!parsed.success) throw new Error("Refresh and reopen the invoice. Its current financial version is unavailable.");
    const row = parsed.data;
    const original = { workOrderId: row.workOrderId || row.wot || null, expectedInvoiceVersion: row.invoiceVersion,
      expectedAssignmentVersion: row.assignmentVersion, expectedWorkflowCycle: row.workflowCycle };
    // Staff may intentionally relink an editable invoice. The captured invoice
    // version protects its original ownership; the target WO has its own token.
    if (workOrder === undefined) return original;
    const target = captureStaffInvoiceSnapshot(null, workOrder);
    return { ...target, expectedInvoiceVersion: row.invoiceVersion };
  }
  if (workOrder == null) return { workOrderId: null, expectedInvoiceVersion: null, expectedAssignmentVersion: null, expectedWorkflowCycle: null };
  const parsed = workSnapshot.safeParse(workOrder);
  if (!parsed.success) throw new Error("Refresh and reopen the work order. Its assignment version is unavailable.");
  return { workOrderId: parsed.data.id, expectedInvoiceVersion: null,
    expectedAssignmentVersion: parsed.data.contractorAssignmentVersion, expectedWorkflowCycle: parsed.data.workflowCycle };
}

// An uncertain response never creates a fresh operation for changed content.
// This instance belongs to one open editor/selected invoice, not a global cache.
export function createStaffFinancialAttempt() {
  let pending: { fingerprint: string; operationId: string } | null = null;
  function prepare<T>(input: unknown, schema: z.ZodType<T>): T {
    const source = z.record(z.string(), z.unknown()).parse(input);
    const operationId = pending?.operationId || crypto.randomUUID();
    const result = schema.parse({ ...source, operationId });
    const fingerprint = JSON.stringify(result);
    if (pending && fingerprint !== pending.fingerprint) {
      throw new Error("The previous invoice action is unconfirmed. Retry it unchanged or refresh and check the saved invoice before editing.");
    }
    pending = { fingerprint, operationId };
    return result;
  }
  return {
    save: (input: unknown): StaffInvoiceSaveCommand => prepare(input, StaffInvoiceSaveSchema),
    delete: (input: unknown): FinancialDeleteCommand => prepare(input, FinancialDeleteSchema),
    confirmed: () => { pending = null; },
    // These responses explicitly reject the whole transaction. Unknown/network
    // and server failures retain the operation until the user reconciles it.
    rejected: (status: number) => { if ([400, 401, 403, 404, 413, 422, 503].includes(status)) pending = null; },
  };
}

export function recordStaffFinancialAttemptError(
  attempt: ReturnType<typeof createStaffFinancialAttempt>,
  cause: unknown,
): void {
  // A response parsed by apiFetch is a known server rejection. A transport
  // failure is RESULT_UNCONFIRMED and must retain the operation for replay.
  if (cause instanceof AppError && cause.code !== "RESULT_UNCONFIRMED") {
    attempt.rejected(cause.status);
  }
}
