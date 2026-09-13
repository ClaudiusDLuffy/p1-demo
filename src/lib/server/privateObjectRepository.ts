import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deletionSchema, uploadIntentSchema, PrivateObjectError, type PrivateObjectServerDatabase } from "../privateObjectContracts";
import type { PrivateObjectWorkflowPorts } from "./privateObjectWorkflow";

export async function objectRpcResult<T>(result: PromiseLike<{ data: unknown; error: { code?: string } | null }>, schema: z.ZodType<T>): Promise<T> {
  const response = await result;
  if (response.error) {
    const code = response.error.code;
    if (code === "42501") throw new PrivateObjectError("FORBIDDEN", "You no longer have access to this file operation.", 403);
    if (code === "PGRST202" || code === "42883") throw new PrivateObjectError("FILE_COMMAND_UNAVAILABLE", "File changes are temporarily unavailable. Please try again after the portal update.", 503);
    throw new PrivateObjectError(code === "PT422" ? "INVALID_FILE_REQUEST" : "FILE_STATE_CONFLICT",
      "The file operation could not be confirmed. Refresh the work order, then retry the same operation.");
  }
  const parsed = schema.safeParse(response.data);
  if (!parsed.success) throw new PrivateObjectError("INVALID_COMMAND_RECEIPT", undefined, 503);
  return parsed.data;
}
export function createPrivateObjectRepository(actor: SupabaseClient<PrivateObjectServerDatabase>, service: SupabaseClient<PrivateObjectServerDatabase>): PrivateObjectWorkflowPorts {
  return {
    get: id => objectRpcResult(actor.rpc("get_private_object_upload_v1", { p_intent_id: id }), uploadIntentSchema),
    claim: id => objectRpcResult(actor.rpc("claim_private_object_upload_v1", { p_intent_id: id }), uploadIntentSchema),
    cancel: id => objectRpcResult(actor.rpc("cancel_private_object_upload_v1", { p_intent_id: id }), uploadIntentSchema),
    finalize: (id, claim, inspection) => objectRpcResult(service.rpc("finalize_private_object_upload_v1", { p_intent_id: id, p_claim_id: claim, p_inspection: inspection }), uploadIntentSchema),
    fail: (id, claim, code) => objectRpcResult(service.rpc("fail_private_object_upload_v1", { p_intent_id: id, p_claim_id: claim, p_code: code }), uploadIntentSchema),
    claimCleanup: id => objectRpcResult(service.rpc("claim_private_object_upload_cleanup_v1", { p_intent_id: id }), uploadIntentSchema),
    completeCleanup: (id, claim, outcome) => objectRpcResult(service.rpc("complete_private_object_upload_cleanup_v1", { p_intent_id: id, p_claim_id: claim, p_outcome: outcome }), uploadIntentSchema),
    claimDeletion: id => objectRpcResult(service.rpc("claim_private_object_deletion_v1", { p_deletion_id: id }), deletionSchema),
    completeDeletion: (id, claim, outcome) => objectRpcResult(service.rpc("complete_private_object_deletion_v1", { p_deletion_id: id, p_claim_id: claim, p_outcome: outcome }), deletionSchema),
  };
}
