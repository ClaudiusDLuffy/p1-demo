import { lifecycleContextFor } from "../../lib/workOrderLifecycleCommands";
import { lifecycleRpcContext } from "../../lib/workOrderLifecycleContracts";
import { linkedBillingCommandSchema, linkedBillingReceiptSchema, LinkedBillingError, linkedBillingError,
  type LinkedBillingCandidate, type LinkedBillingFunctions } from "./linkedBillingContracts";

type Transport = (name: "record_work_order_linked_billing_v1",
  args: LinkedBillingFunctions["record_work_order_linked_billing_v1"]["Args"])
  => PromiseLike<{ data: unknown; error: unknown }>;

export function createLinkedBillingAttempt(workOrder: unknown, candidate: LinkedBillingCandidate, note: string,
  coverageConfirmed: boolean, operationId = crypto.randomUUID()) {
  const command = linkedBillingCommandSchema.parse({ ...lifecycleContextFor(workOrder, operationId), candidate, note, coverageConfirmed });
  const selected = command.candidate;
  const args = { ...lifecycleRpcContext(command), p_billing_work_order_id: selected.workOrderId,
    p_billing_assignment_version: selected.assignmentVersion, p_billing_workflow_cycle: selected.workflowCycle,
    p_invoice_id: selected.invoiceId, p_expected_invoice_version: selected.invoiceVersion, p_note: command.note };
  return async (transport: Transport) => {
    try {
      const { data, error } = await transport("record_work_order_linked_billing_v1", args);
      if (error) throw error;
      const parsed = linkedBillingReceiptSchema.safeParse(data);
      if (!parsed.success) throw new LinkedBillingError("LINKED_BILLING_UNCONFIRMED");
      const result = parsed.data;
      if (result.operationId !== command.operationId || result.workOrderId !== command.workOrderId
        || result.assignmentVersion !== command.expectedAssignmentVersion || result.workflowCycle !== command.expectedWorkflowCycle
        || result.lifecycleVersion !== command.expectedLifecycleVersion + 1 || result.note !== command.note
        || result.billingWorkOrderId !== selected.workOrderId || result.billingAssignmentVersion !== selected.assignmentVersion
        || result.billingWorkflowCycle !== selected.workflowCycle || result.invoiceId !== selected.invoiceId
        || result.invoiceVersion !== selected.invoiceVersion || result.invoiceNumber !== selected.invoiceNumber
        || result.invoiceDate !== selected.invoiceDate) throw new LinkedBillingError("LINKED_BILLING_UNCONFIRMED");
      return result;
    } catch (cause) { throw linkedBillingError(cause); }
  };
}
