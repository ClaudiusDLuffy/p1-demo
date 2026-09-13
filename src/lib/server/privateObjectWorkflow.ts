import "server-only";
import { PrivateObjectError, type FinalizeResponse, type UploadIntent, type ObjectDeletion } from "../privateObjectContracts";
import type { Json } from "../supabase/database.types";
import { inspectPhotoImage, PhotoContentError } from "./photoImageInspection";
import { inspectPrivateAttachment } from "./privateAttachmentInspection";
import type { PrivateObjectStorage, RemovalOutcome } from "./privateObjectStorage";

export interface PrivateObjectWorkflowPorts {
  get(intentId: string): Promise<UploadIntent>;
  claim(intentId: string): Promise<UploadIntent>;
  finalize(intentId: string, claimId: string, inspection: Json): Promise<UploadIntent>;
  fail(intentId: string, claimId: string, code: string): Promise<UploadIntent>;
  cancel(intentId: string): Promise<UploadIntent>;
  claimCleanup(intentId: string): Promise<UploadIntent>;
  completeCleanup(intentId: string, claimId: string, outcome: RemovalOutcome): Promise<UploadIntent>;
  claimDeletion(deletionId: string): Promise<ObjectDeletion>;
  completeDeletion(deletionId: string, claimId: string, outcome: RemovalOutcome): Promise<ObjectDeletion>;
}

/** External IO never runs inside a DB row lock. A leased claim is verified again
 * by the owning command, including current actor/parent versions, at commit. */
export function createPrivateObjectWorkflow(ports: PrivateObjectWorkflowPorts, storage: PrivateObjectStorage,
  inspect: typeof inspectPhotoImage = inspectPhotoImage) {
  const cleanup = async (intentId: string) => {
    const claimed = await ports.claimCleanup(intentId);
    if (claimed.intentId !== intentId) throw new PrivateObjectError("INVALID_COMMAND_RECEIPT");
    if (claimed.status === "cleaned") return claimed;
    if (!claimed.claimId) throw new PrivateObjectError("CLEANUP_PENDING");
    const outcome = await storage.remove(claimed);
    return ports.completeCleanup(intentId, claimed.claimId, outcome);
  };
  return {
    cleanup,
    async finalize(intentId: string, signal?: AbortSignal): Promise<FinalizeResponse> {
      const current = await ports.claim(intentId);
      if (current.intentId !== intentId) throw new PrivateObjectError("INVALID_COMMAND_RECEIPT");
      if (current.status === "finalized") return { status: "confirmed", intent: current };
      if (["cleanup_required", "cancelled", "expired", "cleaned"].includes(current.status)) {
        return { status: "cleanup_required", intentId, code: "CLEANUP_REQUIRED", message: "This upload is awaiting cleanup. Existing photos are not affected." };
      }
      const claimed = current;
      if (!claimed.claimId) throw new PrivateObjectError("VALIDATION_PENDING");
      try {
        const bytes = await storage.download(claimed, (claimed.purpose === "estimate_attachment" ? 15 : claimed.purpose === "photo" ? 10 : 5) * 1024 * 1024, signal);
        if (bytes === null) {
          return { status: "upload_required", intent: await ports.fail(intentId, claimed.claimId, "OBJECT_MISSING") };
        }
        const inspection = claimed.purpose === "photo" ? await inspect(bytes, signal)
          : inspectPrivateAttachment(bytes, claimed.purpose);
        if (inspection.sha256 !== claimed.file.sha256 || inspection.sizeBytes !== claimed.file.sizeBytes) {
          throw new PrivateObjectError("OBJECT_CHANGED", "The uploaded bytes do not match this upload. Cancel it and select the intended file again.", 422);
        }
        const finalized = await ports.finalize(intentId, claimed.claimId, inspection);
        if (finalized.status !== "finalized" || finalized.intentId !== claimed.intentId || finalized.operationId !== claimed.operationId
          || finalized.objectPath !== claimed.objectPath || finalized.bucket !== claimed.bucket
          || finalized.purpose !== claimed.purpose || finalized.parentId !== claimed.parentId) throw new PrivateObjectError("FINALIZATION_FAILED");
        return { status: "confirmed", intent: finalized };
      } catch (error: unknown) {
        const code = error instanceof PhotoContentError ? error.code : error instanceof PrivateObjectError
          ? error.code === "FILE_TOO_LARGE" ? "IMAGE_TOO_LARGE" : ["FORBIDDEN", "FILE_STATE_CONFLICT"].includes(error.code) ? "STALE_PARENT"
            : ["INVALID_ATTACHMENT", "OBJECT_CHANGED", "OBJECT_DOWNLOAD_FAILED"].includes(error.code) ? error.code : "FINALIZATION_FAILED"
          : "FINALIZATION_FAILED";
        // If commit succeeded but its response was lost, fail cannot demote it.
        // Replaying get/finalize discovers the already committed receipt.
        const state = await ports.fail(intentId, claimed.claimId, code).catch(() => null);
        if (state?.status === "finalized") return { status: "confirmed", intent: state };
        const message = error instanceof PhotoContentError || error instanceof PrivateObjectError ? error.message
          : "File finalization could not be confirmed. Retry this same upload.";
        if (state?.status === "cleanup_required") return { status: "cleanup_required", intentId, code, message };
        throw new PrivateObjectError(code, message);
      }
    },
    async cancel(intentId: string): Promise<UploadIntent> {
      // A finalized race remains confirmed, never misreported as cancelled.
      const current = await ports.cancel(intentId);
      if (current.intentId !== intentId) throw new PrivateObjectError("INVALID_COMMAND_RECEIPT");
      if (current.status === "finalized" || current.status === "cleaned") return current;
      return cleanup(intentId);
    },
    async delete(deletionId: string): Promise<ObjectDeletion> {
      const claimed = await ports.claimDeletion(deletionId);
      if (claimed.deletionId !== deletionId) throw new PrivateObjectError("INVALID_COMMAND_RECEIPT");
      if (claimed.status === "deleted") return claimed;
      if (!claimed.claimId) throw new PrivateObjectError("DELETION_PENDING");
      return ports.completeDeletion(deletionId, claimed.claimId, await storage.remove(claimed));
    },
  };
}
