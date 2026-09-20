import { z } from "zod";

export const COMPLETED_RETURN_REASON_MIN_LENGTH = 5;
export const COMPLETED_RETURN_REASON_MAX_LENGTH = 1000;

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const completedReturnCommandSchema = z.object({
  workOrderId: z.string().trim().min(1),
  expectedAssignmentVersion: version,
  expectedWorkflowCycle: version,
  expectedLifecycleVersion: version,
  operationId: z.uuid(),
  reason: z.string().trim()
    .min(COMPLETED_RETURN_REASON_MIN_LENGTH)
    .max(COMPLETED_RETURN_REASON_MAX_LENGTH),
}).strict();

export const completedReturnResultSchema = z.object({
  applied: z.boolean(),
  reason: z.string().min(1),
  workOrderId: z.string().min(1),
  operationId: z.uuid(),
  assignmentVersion: version,
  workflowCycle: version,
  lifecycleVersion: version,
  workOrderStatus: z.string().min(1),
  functionalStatus: z.string().nullable(),
  invoicesChanged: z.literal(false),
  assignmentsChanged: z.literal(false),
  visitsChanged: z.literal(false),
}).strict();

export type CompletedReturnCommand = z.infer<typeof completedReturnCommandSchema>;
export type CompletedReturnResult = z.infer<typeof completedReturnResultSchema>;

export function validateCompletedReturnReason(reason: string): string | null {
  const clean = reason.trim();
  if (clean.length < COMPLETED_RETURN_REASON_MIN_LENGTH) {
    return `Enter at least ${COMPLETED_RETURN_REASON_MIN_LENGTH} characters explaining why another visit is needed.`;
  }
  if (clean.length > COMPLETED_RETURN_REASON_MAX_LENGTH) {
    return `Keep the reason to ${COMPLETED_RETURN_REASON_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export function canReturnCompletedWorkOrderToField(input: {
  status?: string | null;
  functionalStatus?: string | null;
  contractorId?: string | null;
  billingOnly?: boolean | null;
  isCapital?: boolean | null;
  isOperationalStaff?: boolean;
  isInvoiceController?: boolean;
  canManageContractorCompany?: boolean;
}): boolean {
  const actorAllowed = Boolean(
    (input.isOperationalStaff && !input.isInvoiceController)
      || input.canManageContractorCompany,
  );
  return actorAllowed
    && input.functionalStatus === "Completed"
    && ["completed", "pending_invoice", "pending_approval", "pending_payment"]
      .includes(String(input.status || ""))
    && Boolean(input.contractorId)
    && !input.billingOnly
    && !input.isCapital;
}

export function completedReturnErrorMessage(error: unknown): string {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() })
    .safeParse(error);
  const code = parsed.success ? parsed.data.code : undefined;
  const message = parsed.success ? parsed.data.message || "" : "";
  if (code === "PT409") {
    return "The work order changed in another session. Refresh it and review the current field and billing status.";
  }
  if (code === "42501") {
    return "You no longer have permission to return this work order to field work. Refresh the page.";
  }
  if (code === "22023") {
    return "Enter a clear reason for the additional field visit and try again.";
  }
  if (message.includes("Capital work")) {
    return "Capital work must continue through the capital authorization workflow.";
  }
  if (message.includes("active visit")) {
    return "Close the current active visit before starting another field cycle.";
  }
  return "The return to field work could not be confirmed. Refresh the work order before retrying.";
}
