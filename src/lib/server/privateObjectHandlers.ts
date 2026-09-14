import "server-only";
import { z } from "zod";
import { beginObjectRequestSchema, intentRequestSchema, deleteRequestSchema, uploadIntentSchema,
  deletionSchema, PrivateObjectError } from "../privateObjectContracts";
import { createServerClient } from "../supabase/server";
import { parseObjectRequest, privateObjectFailure, privateObjectFetch, requirePrivateObjectActor } from "./privateObjectAuthorization";
import { createPrivateObjectRepository, objectRpcResult } from "./privateObjectRepository";
import { createPrivateObjectStorage } from "./privateObjectStorage";
import { createPrivateObjectWorkflow } from "./privateObjectWorkflow";
import { getServerSupabaseConfig } from "../config/server/supabase";
import { isCronAuthorized, assertScheduledJobsAllowed } from "../config/server/cron";

const storage = () => createPrivateObjectStorage(getServerSupabaseConfig());
const json = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });

export async function handlePrivateObjectRequest(request: Request, action: "intents" | "finalize" | "cancel" | "delete") {
  try {
    const { actor, service } = await requirePrivateObjectActor(request);
    const workflow = createPrivateObjectWorkflow(createPrivateObjectRepository(actor, service), storage());
    if (action === "intents") {
      const input = await parseObjectRequest(request, beginObjectRequestSchema);
      const intent = input.kind === "photo"
        ? await objectRpcResult(actor.rpc("begin_work_order_photo_upload_v1", {
          p_work_order_id: input.workOrderId, p_operation_id: input.operationId, p_batch_id: input.batchId,
          p_expected_assignment_version: input.expectedAssignmentVersion, p_expected_workflow_cycle: input.expectedWorkflowCycle, p_file: input.file,
        }), uploadIntentSchema)
        : await objectRpcResult(actor.rpc("begin_contractor_attachment_upload_v1", {
          p_parent_id: input.parentId, p_purpose: input.purpose, p_operation_id: input.operationId, p_file: input.file,
        }), uploadIntentSchema);
      if (intent.operationId !== input.operationId || JSON.stringify(intent.file) !== JSON.stringify(input.file)
        || (input.kind === "photo" ? intent.workOrderId !== input.workOrderId || intent.batchId !== input.batchId || intent.purpose !== "photo"
          : intent.parentId !== input.parentId || intent.purpose !== input.purpose)) throw new PrivateObjectError("INVALID_COMMAND_RECEIPT");
      return json(intent);
    }
    if (action === "delete") {
      const input = await parseObjectRequest(request, deleteRequestSchema);
      const binding = await objectRpcResult(actor.rpc("resolve_private_object_binding_v1", {
        p_purpose: input.purpose, p_metadata_id: input.metadataId, p_operation_id: input.operationId,
      }), z.object({ bindingId: z.uuid() }));
      const deletion = await objectRpcResult(actor.rpc("request_private_object_delete_v1", {
        p_binding_id: binding.bindingId, p_operation_id: input.operationId,
      }), deletionSchema);
      if (deletion.bindingId !== binding.bindingId || deletion.operationId !== input.operationId || deletion.purpose !== input.purpose) {
        throw new PrivateObjectError("INVALID_COMMAND_RECEIPT");
      }
      const result = await workflow.delete(deletion.deletionId);
      // The browser receives no deletion path or service claim capability.
      return json({ status: result.status === "deleted" ? "deleted" : "pending", operationId: result.operationId, metadataId: input.metadataId });
    }
    const input = await parseObjectRequest(request, intentRequestSchema);
    if (action === "finalize") return json(await workflow.finalize(input.intentId, request.signal));
    const result = await workflow.cancel(input.intentId);
    return json(result);
  } catch (error: unknown) { return privateObjectFailure(error); }
}

/** No automatic schedule is installed. Dry-run lists only known recovery IDs,
 * never bucket contents; writes require an explicit false dryRun input. */
export async function handlePrivateObjectReconciliation(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      throw new PrivateObjectError("UNAUTHORIZED", "Unauthorized", 401);
    }
    assertScheduledJobsAllowed();
    const input = await parseObjectRequest(request, z.strictObject({ limit: z.number().int().min(1).max(25), dryRun: z.boolean() }));
    const service = createServerClient({ fetch: privateObjectFetch });
    const rows = await objectRpcResult(service.rpc("list_private_object_reconciliation_v1", {
      p_limit: input.limit, p_dry_run: input.dryRun,
    }), z.array(z.object({ kind: z.enum(["upload", "deletion"]), id: z.uuid(), status: z.string().max(40) })).max(25));
    if (input.dryRun) return json({ dryRun: true, items: rows });
    const workflow = createPrivateObjectWorkflow(createPrivateObjectRepository(service, service), storage());
    const outcomes: { id: string; kind: string; status: string }[] = [];
    const started = Date.now();
    // Deliberately sequential, capped, lease-owned; no full-bucket scans.
    for (const row of rows) {
      // One recovery can use three bounded Storage calls plus two DB calls.
      // Stop starting work early enough to keep its leased outcome recoverable
      // within this route's 60-second host budget, even on a slow provider.
      if (Date.now() - started >= 5_000 && outcomes.length > 0) break;
      try {
        const result = row.kind === "upload" ? await workflow.cleanup(row.id) : await workflow.delete(row.id);
        outcomes.push({ id: row.id, kind: row.kind, status: result.status });
      } catch { outcomes.push({ id: row.id, kind: row.kind, status: "retry_required" }); }
    }
    return json({ dryRun: false, items: outcomes });
  } catch (error: unknown) { return privateObjectFailure(error); }
}
