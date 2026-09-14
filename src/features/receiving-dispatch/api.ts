import { supabase } from "../../lib/supabase/client";
import { actionResultSchema, currentSchema, deliverySchema, historyItemSchema, DISPATCH_PAGE_SIZE,
  DispatchOperatorError, operationSchema, parseDispatchCursor, parseDispatchPage, safeDispatchError,
  type DispatchAction, type DispatchFilter, type DispatchOperation } from "./contracts";

export async function readCurrentDispatch(workOrderId: string, assignmentVersion: number, signal: AbortSignal) {
  const { data, error } = await supabase().rpc("get_receiving_dispatch_current_v1", {
    p_work_order_id: workOrderId, p_assignment_version: assignmentVersion,
  }).abortSignal(signal);
  if (error) throw safeDispatchError(error);
  const result = currentSchema.safeParse(data);
  if (!result.success || (result.data.delivery && (result.data.delivery.workOrderId !== workOrderId
    || result.data.delivery.assignmentVersion !== assignmentVersion))) throw new DispatchOperatorError("DELIVERY_UNCONFIRMED");
  return result.data;
}
export async function readUnresolvedDispatch(state: DispatchFilter, search: string, cursor: string | null, signal: AbortSignal) {
  const { data, error } = await supabase().rpc("list_receiving_dispatch_unresolved_v1", {
    p_state: state === "all" ? null : state, p_search: search, p_cursor: parseDispatchCursor(cursor), p_limit: DISPATCH_PAGE_SIZE,
  }).abortSignal(signal);
  if (error) throw safeDispatchError(error);
  return parseDispatchPage(data, deliverySchema);
}
export async function readDispatchHistory(deliveryId: string, cursor: string | null, signal: AbortSignal) {
  const { data, error } = await supabase().rpc("get_receiving_dispatch_history_v1", {
    p_delivery_id: deliveryId, p_cursor: parseDispatchCursor(cursor), p_limit: DISPATCH_PAGE_SIZE,
  }).abortSignal(signal);
  if (error) throw safeDispatchError(error);
  return parseDispatchPage(data, historyItemSchema);
}
export async function reconcileDispatch(action: DispatchAction, input: DispatchOperation) {
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success) throw new DispatchOperatorError(input.reason.trim() ? "VALIDATION_FAILED" : "REASON_REQUIRED");
  const operation = parsed.data;
  try {
    const { data, error } = await supabase().rpc(action === "resend"
      ? "request_receiving_dispatch_resend_v1" : "resolve_receiving_dispatch_out_of_band_v1", {
      p_delivery_id: operation.deliveryId, p_assignment_version: operation.assignmentVersion,
      p_operation_id: operation.operationId, p_reason: operation.reason,
    });
    if (error) throw error;
    const result = actionResultSchema.safeParse(data);
    if (!result.success || result.data.operationId !== operation.operationId
      || result.data.status !== (action === "resend" ? "queued" : "manually_resolved")) {
      throw new DispatchOperatorError("DELIVERY_UNCONFIRMED");
    }
    return result.data;
  } catch (error) { throw safeDispatchError(error); }
}
