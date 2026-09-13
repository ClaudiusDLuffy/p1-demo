import { supabase } from "../../lib/supabase/client";
import type { Json } from "../../lib/supabase/database.types";
import { PARTS_SMS_PAGE_SIZE, PartsSmsError, parsePartsSmsCursor, parsePartsSmsPage, partsSmsActionResultSchema,
  partsSmsDeliverySchema, partsSmsFilterSchema, partsSmsHealthSchema, partsSmsHistorySchema, partsSmsOperationSchema, safePartsSmsError,
  type PartsSmsAction, type PartsSmsFilter, type PartsSmsOperation } from "./contracts";

type RpcName = "list_parts_sms_unresolved_v1" | "get_parts_sms_delivery_v1" | "get_parts_sms_history_v1" | "get_parts_sms_worker_health_v1"
  | "request_parts_sms_resend_v1" | "resolve_parts_sms_out_of_band_v1";
type RpcResult = { data: unknown; error: unknown };
type PartsRpcClient = { rpc(name: RpcName, args?: Record<string, Json>): PromiseLike<RpcResult> & { abortSignal(signal: AbortSignal): PromiseLike<RpcResult> } };
// Migration-owned RPCs are deliberately isolated from the legacy generated
// database shape. The narrow allowlist and runtime parsers bound this facade.
const client = () => supabase() as unknown as PartsRpcClient;

export async function readPartsSmsHealth(signal: AbortSignal) {
  const { data, error } = await client().rpc("get_parts_sms_worker_health_v1").abortSignal(signal);
  if (error) throw safePartsSmsError(error);
  const parsed = partsSmsHealthSchema.safeParse(data);
  if (!parsed.success) throw new PartsSmsError("RESULT_UNCONFIRMED");
  return parsed.data;
}
export async function readPartsSmsQueue(state: PartsSmsFilter, search: string, cursor: string | null, signal: AbortSignal) {
  if (search.length > 100 || !partsSmsFilterSchema.safeParse(state).success) throw new PartsSmsError("VALIDATION_FAILED");
  const { data, error } = await client().rpc("list_parts_sms_unresolved_v1", { p_state: state === "all" ? null : state,
    p_search: search, p_cursor: parsePartsSmsCursor(cursor), p_limit: PARTS_SMS_PAGE_SIZE }).abortSignal(signal);
  if (error) throw safePartsSmsError(error);
  return parsePartsSmsPage(data, partsSmsDeliverySchema);
}
export async function readPartsSmsHistory(deliveryId: string, cursor: string | null, signal: AbortSignal) {
  if (!partsSmsDeliverySchema.shape.id.safeParse(deliveryId).success) throw new PartsSmsError("VALIDATION_FAILED");
  const { data, error } = await client().rpc("get_parts_sms_history_v1", { p_delivery_id: deliveryId,
    p_cursor: parsePartsSmsCursor(cursor), p_limit: PARTS_SMS_PAGE_SIZE }).abortSignal(signal);
  if (error) throw safePartsSmsError(error);
  return parsePartsSmsPage(data, partsSmsHistorySchema);
}
export async function reconcilePartsSms(action: PartsSmsAction, input: PartsSmsOperation) {
  const parsed = partsSmsOperationSchema.safeParse(input);
  if (!parsed.success) throw new PartsSmsError(input.reason.trim() ? "VALIDATION_FAILED" : "REASON_REQUIRED");
  const operation = parsed.data;
  try {
    const { data, error } = await client().rpc(action === "resend" ? "request_parts_sms_resend_v1" : "resolve_parts_sms_out_of_band_v1", {
      p_delivery_id: operation.deliveryId, p_operation_id: operation.operationId, p_reason: operation.reason,
    });
    if (error) throw error;
    const result = partsSmsActionResultSchema.safeParse(data);
    if (!result.success || result.data.operationId !== operation.operationId
      || (action === "manual_resolution" && result.data.deliveryId !== operation.deliveryId)
      || result.data.status !== (action === "resend" ? "queued" : "manually_resolved")) throw new PartsSmsError("RESULT_UNCONFIRMED");
    return result.data;
  } catch (error) { throw safePartsSmsError(error); }
}
