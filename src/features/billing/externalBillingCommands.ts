import { lifecycleContextFor } from "../../lib/workOrderLifecycleCommands";
import { lifecycleRpcContext } from "../../lib/workOrderLifecycleContracts";
import {
  externalBillingCommandSchema, externalBillingReceiptSchema, externalBillingError, ExternalBillingError,
  type ExternalBillingFields, type ExternalBillingFunctions,
} from "./externalBillingContracts";

type Transport = (name: "record_work_order_external_billing_v1",
  args: ExternalBillingFunctions["record_work_order_external_billing_v1"]["Args"])
  => PromiseLike<{ data: unknown; error: unknown }>;

/** Freeze the displayed versions, normalized payload, and UUID for retries. */
export function createExternalBillingAttempt(workOrder: unknown, fields: ExternalBillingFields, operationId = crypto.randomUUID()) {
  const command = externalBillingCommandSchema.parse({ ...fields, ...lifecycleContextFor(workOrder, operationId) });
  const args = { ...lifecycleRpcContext(command), p_billing_system: command.billingSystem,
    p_invoice_reference: command.invoiceReference, p_billed_on: command.billedOn, p_note: command.note };
  return async (transport: Transport) => {
    try {
      const { data, error } = await transport("record_work_order_external_billing_v1", args);
      if (error) throw error;
      const parsed = externalBillingReceiptSchema.safeParse(data);
      if (!parsed.success) throw new ExternalBillingError("EXTERNAL_BILLING_UNCONFIRMED");
      const result = parsed.data;
      if (result.operationId !== command.operationId || result.workOrderId !== command.workOrderId
        || result.assignmentVersion !== command.expectedAssignmentVersion || result.workflowCycle !== command.expectedWorkflowCycle
        || result.lifecycleVersion !== command.expectedLifecycleVersion + 1
        || result.billingSystem !== command.billingSystem || result.invoiceReference !== command.invoiceReference
        || result.billedOn !== command.billedOn || result.note !== command.note) {
        throw new ExternalBillingError("EXTERNAL_BILLING_UNCONFIRMED");
      }
      return result;
    } catch (cause) { throw externalBillingError(cause); }
  };
}
