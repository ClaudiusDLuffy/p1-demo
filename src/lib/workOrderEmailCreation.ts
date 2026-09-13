import { createHash } from "node:crypto";
import { assignmentCreationResultSchema } from "./workOrderAssignmentContracts";
import { safeAssignmentError } from "./workOrderAssignmentCommands";
import type { Database, Json } from "./supabase/database.types";

type WorkOrderInsert = Database["public"]["Tables"]["work_orders"]["Insert"];
type EmailCreationTransport = (name: "create_email_work_order_with_assignment_v1",
  args: { p_operation_id: string; p_work_order: Json }) => PromiseLike<{ data: unknown; error: unknown }>;

// Node-only module, used exclusively by the trusted intake processor. Identity
// uses the existing canonical email source ID, not the processing timestamp.
export function emailWorkOrderCreationId(sourceMessageId: string, workOrderId: string) {
  if (!sourceMessageId.trim() || !workOrderId.trim()) throw new Error("Email creation identity is required");
  const hex = createHash("sha256").update(JSON.stringify(["p1-email-work-order-create-v1", sourceMessageId, workOrderId])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function createEmailWorkOrder(transport: EmailCreationTransport, row: WorkOrderInsert, sourceMessageId: string) {
  try {
    const operationId = emailWorkOrderCreationId(sourceMessageId, row.id);
    const { data, error } = await transport("create_email_work_order_with_assignment_v1", {
      p_operation_id: operationId, p_work_order: row,
    });
    if (error) throw error;
    const result = assignmentCreationResultSchema.safeParse(data);
    if (!result.success || result.data.workOrderId !== row.id || result.data.operationId !== operationId
        || result.data.contractorId !== (row.contractor_id ?? null)
        || result.data.assignmentVersion !== (row.contractor_id ? 1 : 0)
        || result.data.workflowCycle !== 0 || result.data.lifecycleVersion !== 0
        || (row.contractor_id != null && result.data.activityId === null)
        || result.data.applied === (result.data.reason === "already_applied")) throw new Error("Unconfirmed email creation result");
    return result.data;
  } catch (error) { throw safeAssignmentError(error); }
}
