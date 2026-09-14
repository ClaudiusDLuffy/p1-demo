import { z } from "zod";
import type { ControllerExportContext } from "./controllerExportContext";
import { controllerArchiveBytes, controllerCommandFailure, controllerCount, controllerFingerprint,
  controllerTimestamp, controllerTotal, controllerUuid, ControllerCommandResultInvalid,
  parseControllerCommandEnvelope, sameControllerUuid, validControllerBatchObjectPath,
  type ControllerCommandFailure } from "./commandResultValidation";

export type StageCommand = {
  batchId: string; actorId: string; objectPath: string;
  sources: readonly { invoiceId: string; updatedAt: string }[];
  archiveSha256: string; archiveBytes: number; archiveFormat: "reference_manifest_v2";
};
const source = z.object({ invoiceId: controllerUuid, updatedAt: controllerTimestamp });
const commandSchema = z.object({ batchId: controllerUuid, actorId: controllerUuid, objectPath: z.string().min(1),
  sources: z.array(source).min(1).max(500), archiveSha256: controllerFingerprint,
  archiveBytes: controllerArchiveBytes, archiveFormat: z.literal("reference_manifest_v2") })
  .refine(command => validControllerBatchObjectPath(command.batchId, command.objectPath));

export const stageReceiptSchema = z.object({ batchId: controllerUuid, status: z.literal("pending"),
  invoiceCount: controllerCount, total: controllerTotal, objectPath: z.string().min(1),
  archiveSha256: controllerFingerprint, archiveBytes: controllerArchiveBytes,
  archiveFormat: z.literal("reference_manifest_v2") });
export type StageReceipt = z.infer<typeof stageReceiptSchema>;
export type StageCommandResult =
  | { status: "committed"; receipt: StageReceipt }
  | { status: "replayed"; receipt: StageReceipt }
  | ControllerCommandFailure;
export interface StageCommandRepository { execute(command: StageCommand): Promise<StageCommandResult> }

export function parseStageReceipt(value: unknown, command: StageCommand): StageReceipt {
  const parsed = stageReceiptSchema.safeParse(value);
  if (!parsed.success || !sameControllerUuid(parsed.data.batchId, command.batchId)
    || parsed.data.objectPath !== command.objectPath || parsed.data.archiveSha256 !== command.archiveSha256
    || parsed.data.archiveBytes !== command.archiveBytes || parsed.data.archiveFormat !== command.archiveFormat
    || parsed.data.invoiceCount !== command.sources.length) throw new ControllerCommandResultInvalid();
  return parsed.data;
}

/** One dispatch only: this SQL function has no operation-ledger replay branch. */
export function createStageCommandRepository(context: ControllerExportContext): StageCommandRepository {
  const actorId = context.actor.profileId;
  return { execute: async command => {
    if (context.signal?.aborted) return { status: "not_dispatched", code: "REQUEST_ABORTED", cause: context.signal.reason };
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success || new Set(command.sources.map(item => item.invoiceId.toLowerCase())).size !== command.sources.length) {
      return { status: "not_dispatched", code: "CONTROLLER_EXPORT_COMMAND_INVALID", cause: parsed.error };
    }
    const captured = parsed.data;
    if (!sameControllerUuid(captured.actorId, actorId)) {
      return { status: "known_rejected", code: "42501", cause: new Error("Controller actor binding mismatch") };
    }
    try {
      const query = context.dataSession.rpc("stage_contractor_bill_handoff", {
        p_batch_id: captured.batchId, p_actor_id: captured.actorId, p_object_path: captured.objectPath,
        p_sources: captured.sources.map(item => ({ invoiceId: item.invoiceId, updatedAt: item.updatedAt })),
        p_archive_sha256: captured.archiveSha256, p_archive_bytes: captured.archiveBytes,
        p_archive_format: captured.archiveFormat,
      });
      const result = parseControllerCommandEnvelope(await (context.signal ? query.abortSignal(context.signal) : query));
      if (result.error !== null) return controllerCommandFailure(result.error);
      return { status: "committed", receipt: parseStageReceipt(result.data, captured) };
    } catch (cause: unknown) { return controllerCommandFailure(cause); }
  } };
}
