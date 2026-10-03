import { z } from "zod";
import { lifecycleContextSchema, lifecycleRpcContext } from "../../lib/workOrderLifecycleContracts";
import type { Json } from "../../lib/supabase/database.types";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workId = z.string().trim().min(1).max(128);
export const linkedBillingLookupSchema = z.object({ workOrderId: workId, invoiceNumber: z.string().trim().max(100) });
export const linkedBillingCandidateSchema = z.object({
  workOrderId: workId, invoiceId: z.uuid(), invoiceNumber: z.string().min(1), invoiceDate: z.iso.date().nullable(),
  state: z.enum(["submitted", "revised", "approved", "paid"]), invoiceVersion: version,
  assignmentVersion: version, workflowCycle: version,
});
export type LinkedBillingCandidate = z.infer<typeof linkedBillingCandidateSchema>;
export const linkedBillingCandidatesSchema = z.object({ workOrderId: workId,
  hasMore: z.boolean(), items: z.array(linkedBillingCandidateSchema).max(25) });
export const linkedBillingFieldsSchema = z.object({
  candidate: linkedBillingCandidateSchema, note: z.string().trim().min(5).max(1000),
  coverageConfirmed: z.literal(true),
});
export const linkedBillingCommandSchema = lifecycleContextSchema.extend(linkedBillingFieldsSchema.shape)
  .refine(value => value.workOrderId !== value.candidate.workOrderId, "Select a different billing work order.");
export const linkedBillingReceiptSchema = z.object({
  applied: z.boolean(), operationId: z.uuid(), workOrderId: workId, assignmentVersion: version,
  workflowCycle: version, lifecycleVersion: version, workOrderStatus: z.literal("closed"),
  functionalStatus: z.string().nullable(), activityId: z.uuid(), billingActivityId: z.uuid(),
  closedAt: z.iso.datetime({ offset: true }), billingWorkOrderId: workId,
  billingAssignmentVersion: version, billingWorkflowCycle: version, invoiceId: z.uuid(), invoiceVersion: version,
  invoiceNumber: z.string().min(1), invoiceDate: z.iso.date().nullable(), note: z.string().min(5).max(1000),
});
export type LinkedBillingReceipt = z.infer<typeof linkedBillingReceiptSchema>;
export const linkedBillingHistorySchema = z.object({ workOrderId: workId, hasMore: z.boolean(),
  items: z.array(z.object({ receipt: linkedBillingReceiptSchema, active: z.boolean() })).max(25) });
export type LinkedBillingCursor = { closedAt: string; operationId: string } | null;
export type LinkedBillingFunctions = {
  list_linked_billing_candidates_v1: { Args: { p_work_order_id: string; p_invoice_number: string }; Returns: Json };
  get_work_order_billing_links_v1: {
    Args: { p_work_order_id: string; p_before: string | null; p_before_id: string | null }; Returns: Json;
  };
  record_work_order_linked_billing_v1: {
    Args: ReturnType<typeof lifecycleRpcContext> & { p_billing_work_order_id: string;
      p_billing_assignment_version: number; p_billing_workflow_cycle: number;
      p_invoice_id: string; p_expected_invoice_version: number; p_note: string }; Returns: Json;
  };
};

const messages = {
  LINKED_BILLING_FORBIDDEN: "Only active operational P1 staff can link billing.",
  LINKED_BILLING_INVALID_INPUT: "Select a submitted invoice on another work order, confirm it covers this work, and enter a note of 5–1,000 characters.",
  LINKED_BILLING_NOT_FOUND: "One of these work orders is no longer available. Refresh and review the records.",
  LINKED_BILLING_STALE: "The work order or invoice changed. Close this form and review the latest records before trying again.",
  LINKED_BILLING_OPERATION_REUSED: "This request conflicts with an earlier attempt. Close the form and review the billing history.",
  LINKED_BILLING_ALREADY_RECORDED: "This work order is already closed or covered by a billing record. Review its history before billing again.",
  LINKED_BILLING_INVOICE_UNAVAILABLE: "Select an existing submitted P1 invoice on the other work order. Drafts, rejected invoices, quotes, and contractor bills cannot be used.",
  LINKED_BILLING_FIELD_INCOMPLETE: "Finish field work and move this work order to billing first. Awaiting Parts is not complete.",
  LINKED_BILLING_OPEN_VISIT: "An open visit needs its actual checkout time before this work order can close.",
  LINKED_BILLING_PENDING_UPDATES: "Complete pending 7-Eleven updates and contractor attention items first. Linking billing does not mark them submitted.",
  LINKED_BILLING_PORTAL_INVOICE_EXISTS: "This work order already has a P1 billing invoice. Review it to avoid duplicate billing.",
  LINKED_BILLING_UNRESOLVED_INVOICES: "Resolve outstanding contractor invoice reviews before closing this work order.",
  LINKED_BILLING_INVOICE_IN_USE: "This invoice covers other closed work orders. Reopen those work orders for billing review before removing, rejecting, or moving the invoice.",
  LINKED_BILLING_UNCONFIRMED: "The save could not be confirmed. Retry this unchanged request; it may already have saved. Do not create another invoice.",
} as const;
export class LinkedBillingError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "LinkedBillingError"; }
  get uncertain() { return this.code === "LINKED_BILLING_UNCONFIRMED"; }
}
export function linkedBillingError(cause: unknown): LinkedBillingError {
  if (cause instanceof LinkedBillingError) return cause;
  if (cause instanceof z.ZodError) return new LinkedBillingError("LINKED_BILLING_INVALID_INPUT");
  const parsed = z.object({ message: z.string().optional(), code: z.string().optional() }).safeParse(cause);
  if (parsed.success) {
    const known = Object.keys(messages).find(key => key === parsed.data.message) as keyof typeof messages | undefined;
    if (known) return new LinkedBillingError(known);
    if (["42501", "PT401", "PT403", "PGRST301", "PGRST302"].includes(parsed.data.code ?? "")) return new LinkedBillingError("LINKED_BILLING_FORBIDDEN");
    if (["PT409", "40001"].includes(parsed.data.code ?? "")) return new LinkedBillingError("LINKED_BILLING_STALE");
  }
  return new LinkedBillingError("LINKED_BILLING_UNCONFIRMED");
}
