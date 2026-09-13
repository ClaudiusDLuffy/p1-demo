import { z } from "zod";
import type { ControllerExportContext } from "./controllerExportContext";
import { controllerArchiveBytes, controllerCount, controllerFingerprint, controllerReconciliationSignal,
  controllerTimestamp, controllerTotal, controllerUuid, ControllerCommandResultInvalid,
  parseControllerCommandEnvelope, sameControllerUuid, unknownControllerOutcome,
  validControllerBatchObjectPath } from "./commandResultValidation";
import { parseStageReceipt, type StageCommand, type StageCommandResult } from "./stageCommandRepository";

export const STAGE_RECONCILIATION_PROJECTION = "id,status,created_by,object_path,archive_sha256,archive_bytes,archive_format,invoice_count,total";
const batchSchema = z.object({ id: controllerUuid, status: z.enum(["pending", "confirmed", "cancelled"]),
  created_by: controllerUuid, object_path: z.string().min(1), archive_sha256: controllerFingerprint,
  archive_bytes: controllerArchiveBytes, archive_format: z.literal("reference_manifest_v2"),
  invoice_count: controllerCount, total: controllerTotal });
const itemsSchema = z.array(z.object({ batch_id: controllerUuid, invoice_id: controllerUuid,
  source_updated_at: controllerTimestamp })).min(1).max(500);

// Preserve PostgreSQL revision microseconds when comparing equivalent time-zone representations.
function revisionIdentity(value: string): string {
  const fraction = value.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/)?.[1] ?? "";
  return `${Math.floor(Date.parse(value) / 1000)}:${fraction.replace(/0+$/, "")}`;
}
export interface StageReconciliation {
  resolve(command: StageCommand, result: StageCommandResult): Promise<StageCommandResult>;
}

/** Read-only proof: staging has no idempotent replay branch, so it is never reissued here. */
export function createStageReconciliation(context: ControllerExportContext): StageReconciliation {
  const actorId = context.actor.profileId;
  return { resolve: async (command, result) => {
    if (result.status === "committed" || result.status === "replayed" || result.status === "not_dispatched") return result;
    if (context.signal?.aborted) return unknownControllerOutcome(result.cause);
    if (!sameControllerUuid(command.actorId, actorId) || !validControllerBatchObjectPath(command.batchId, command.objectPath)) {
      return unknownControllerOutcome(new ControllerCommandResultInvalid());
    }
    const signal = controllerReconciliationSignal(context.signal);
    try {
      const raw = parseControllerCommandEnvelope(await context.dataSession.from("controller_invoice_export_batches")
        .select(STAGE_RECONCILIATION_PROJECTION).eq("id", command.batchId).eq("object_path", command.objectPath)
        .abortSignal(signal).maybeSingle().retry(false));
      if (raw.error !== null) return unknownControllerOutcome(raw.error);
      if (raw.data === null) return result.status === "known_rejected"
        ? { ...result, absenceConfirmed: true } : unknownControllerOutcome(result.cause);
      const batch = batchSchema.parse(raw.data);
      if (!sameControllerUuid(batch.id, command.batchId) || !sameControllerUuid(batch.created_by, command.actorId)
        || batch.status !== "pending") throw new ControllerCommandResultInvalid();
      const receipt = parseStageReceipt({ batchId: batch.id, status: batch.status,
        invoiceCount: batch.invoice_count, total: batch.total, objectPath: batch.object_path,
        archiveSha256: batch.archive_sha256, archiveBytes: batch.archive_bytes, archiveFormat: batch.archive_format }, command);
      signal.throwIfAborted();
      const rawItems = parseControllerCommandEnvelope(await context.dataSession.from("controller_invoice_export_items")
        .select("batch_id,invoice_id,source_updated_at").eq("batch_id", command.batchId)
        .order("invoice_id", { ascending: true }).limit(501).abortSignal(signal).retry(false));
      if (rawItems.error !== null) return unknownControllerOutcome(rawItems.error);
      const items = itemsSchema.parse(rawItems.data);
      const requested = new Map(command.sources.map(item => [item.invoiceId.toLowerCase(), revisionIdentity(item.updatedAt)]));
      if (items.length !== command.sources.length || new Set(items.map(item => item.invoice_id.toLowerCase())).size !== items.length
        || items.some(item => !sameControllerUuid(item.batch_id, command.batchId)
          || requested.get(item.invoice_id.toLowerCase()) !== revisionIdentity(item.source_updated_at))) {
        throw new ControllerCommandResultInvalid();
      }
      return { status: "replayed", receipt };
    } catch (cause: unknown) { return unknownControllerOutcome(cause); }
  } };
}
