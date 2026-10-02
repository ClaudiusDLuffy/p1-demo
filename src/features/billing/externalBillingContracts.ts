import { z } from "zod";
import { STAFF_PERMISSION } from "../../lib/staffPermissions";
import { lifecycleContextSchema, lifecycleRpcContext } from "../../lib/workOrderLifecycleContracts";
import type { Json } from "../../lib/supabase/database.types";

const singleLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const externalBillingFieldsSchema = z.object({
  billingSystem: singleLine(80), invoiceReference: singleLine(100),
  billedOn: z.iso.date(), note: z.string().trim().min(5).max(1000),
});
export type ExternalBillingFields = z.infer<typeof externalBillingFieldsSchema>;
export const externalBillingCommandSchema = lifecycleContextSchema.extend(externalBillingFieldsSchema.shape);
export const externalBillingReceiptSchema = z.object({
  ...externalBillingFieldsSchema.shape,
  applied: z.boolean(), operationId: z.uuid(), workOrderId: z.string().min(1).max(128),
  assignmentVersion: z.number().int().nonnegative(), workflowCycle: z.number().int().nonnegative(),
  lifecycleVersion: z.number().int().nonnegative(), workOrderStatus: z.literal("closed"),
  functionalStatus: z.string().nullable(), activityId: z.uuid(), closedAt: z.iso.datetime({ offset: true }),
});
export type ExternalBillingReceipt = z.infer<typeof externalBillingReceiptSchema>;
export type ExternalBillingFunctions = {
  record_work_order_external_billing_v1: {
    Args: ReturnType<typeof lifecycleRpcContext> & {
      p_billing_system: string; p_invoice_reference: string; p_billed_on: string; p_note: string;
    }; Returns: Json;
  };
  get_work_order_external_billing_v1: { Args: { p_work_order_id: string }; Returns: Json };
};

export function canRecordExternalBilling(actor: { active?: boolean; role?: string; staffPermissions?: readonly string[] | null } | null | undefined) {
  return actor?.active === true && ["manager", "dispatcher", "back_office"].includes(actor.role ?? "")
    && !actor.staffPermissions?.includes(STAFF_PERMISSION.invoiceController);
}

const messages = {
  EXTERNAL_BILLING_FORBIDDEN: "Only active operational P1 staff can record external billing.",
  EXTERNAL_BILLING_INVALID_INPUT: "Enter the billing system, invoice reference, a billing date no later than today (Miami time), and a note of 5–1,000 characters.",
  EXTERNAL_BILLING_NOT_FOUND: "This work order is no longer available. Refresh the list.",
  EXTERNAL_BILLING_STALE: "This work order changed. Close this form, refresh, and review it before trying again.",
  EXTERNAL_BILLING_OPERATION_REUSED: "This request conflicts with an earlier attempt. Close the form and review the work order before continuing.",
  EXTERNAL_BILLING_ALREADY_RECORDED: "This work order is already closed or externally billed. Refresh and review its billing history.",
  EXTERNAL_BILLING_FIELD_INCOMPLETE: "Finish field work and move this work order to billing before closing it as billed externally.",
  EXTERNAL_BILLING_OPEN_VISIT: "An open visit still needs its actual checkout time. Close it before recording external billing.",
  EXTERNAL_BILLING_PENDING_UPDATES: "Complete pending 7-Eleven updates and contractor attention items before closing this work order. External billing does not mark them submitted.",
  EXTERNAL_BILLING_PORTAL_INVOICE_EXISTS: "A P1 billing invoice already exists for this work order. Review it to avoid duplicate billing.",
  EXTERNAL_BILLING_UNRESOLVED_INVOICES: "Resolve the outstanding contractor invoice reviews before closing this work order.",
  EXTERNAL_BILLING_UNCONFIRMED: "The save could not be confirmed. Retry this unchanged request; it may already have saved. Do not create another invoice.",
} as const;
export class ExternalBillingError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "ExternalBillingError"; }
  get uncertain() { return this.code === "EXTERNAL_BILLING_UNCONFIRMED"; }
}
export function externalBillingError(cause: unknown): ExternalBillingError {
  if (cause instanceof ExternalBillingError) return cause;
  if (cause instanceof z.ZodError) return new ExternalBillingError("EXTERNAL_BILLING_INVALID_INPUT");
  const parsed = z.object({ message: z.string().optional(), code: z.string().optional() }).safeParse(cause);
  if (parsed.success) {
    const known = Object.keys(messages).find(key => key === parsed.data.message) as keyof typeof messages | undefined;
    if (known) return new ExternalBillingError(known);
    if (["42501", "PT401", "PT403", "PGRST301", "PGRST302"].includes(parsed.data.code ?? "")) return new ExternalBillingError("EXTERNAL_BILLING_FORBIDDEN");
    if (["PT409", "40001"].includes(parsed.data.code ?? "")) return new ExternalBillingError("EXTERNAL_BILLING_STALE");
  }
  return new ExternalBillingError("EXTERNAL_BILLING_UNCONFIRMED");
}
