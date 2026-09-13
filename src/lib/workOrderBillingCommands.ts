import { lifecycleContextFor, safeLifecycleError } from "./workOrderLifecycleCommands";
import { lifecycleResultSchema, lifecycleRpcContext } from "./workOrderLifecycleContracts";
import type { Json } from "./supabase/database.types";

export type WorkOrderBillingFunctions = {
  mark_work_order_ready_for_billing_v1: {
    Args: ReturnType<typeof lifecycleRpcContext>;
    Returns: Json;
  };
};
export type BillingReadyTransport = (
  name: "mark_work_order_ready_for_billing_v1",
  args: WorkOrderBillingFunctions["mark_work_order_ready_for_billing_v1"]["Args"],
) => PromiseLike<{ data: unknown; error: unknown }>;

// One attempt captures the displayed versions and UUID before optimistic UI
// changes. Retrying an uncertain response reuses both, without a raw-write fallback.
export function createBillingReadyAttempt(workOrder: unknown, operationId = crypto.randomUUID()) {
  const context = lifecycleContextFor(workOrder, operationId);
  return async (transport: BillingReadyTransport) => {
    try {
      const { data, error } = await transport("mark_work_order_ready_for_billing_v1", lifecycleRpcContext(context));
      if (error) throw error;
      const parsed = lifecycleResultSchema.safeParse(data);
      if (!parsed.success) throw new Error("Invalid billing command response", { cause: parsed.error });
      const result = parsed.data;
      if (result.workOrderId !== context.workOrderId || result.operationId !== context.operationId
          || result.assignmentVersion !== context.expectedAssignmentVersion
          || result.workflowCycle !== context.expectedWorkflowCycle
          || result.workOrderStatus !== "pending_invoice") {
        throw new Error("Invalid billing command response");
      }
      return result;
    } catch (error) { throw safeLifecycleError(error); }
  };
}
