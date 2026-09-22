import { z } from "zod";
import { supabase } from "./supabase/client";
import { beginObjectRequestSchema, uploadFileSchema, uploadIntentSchema, finalizeResponseSchema,
  type BeginObjectRequest, type UploadIntent, type ObjectPurpose } from "./privateObjectContracts";
import { PHOTO_ACCEPTED_FORMAT_GUIDANCE } from "./photoContentPolicy";
import { digestPhotoBytes } from "../features/photos/browserPhotoFileAdapter";
import { createBrowserPhotoStorageAdapter } from "../features/photos/browserPhotoStorageAdapter";
import { PhotoUploadError, type PhotoUploadPorts } from "../features/photos/photoUploadController";
import { getPublicSupabaseConfig } from "./config/public";
import { parseApiError } from "./errors/clientApiError";
import { safeErrorMessage } from "./errors/normalizeUnknown";

async function objectRequest<T>(action: "intents" | "finalize" | "cancel" | "delete", input: unknown,
  schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const { data, error } = await supabase().auth.getSession();
  if (error || !data.session) throw new PhotoUploadError("Please sign in again.");
  let response: Response;
  try {
    response = await fetch(`/api/private-objects/${action}`, { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch { throw new PhotoUploadError("The file operation could not be confirmed. Retry this same file to check its status."); }
  if (!response.ok) {
    const safe = await parseApiError(response, signal);
    throw new PhotoUploadError(safeErrorMessage(safe), response.status !== 422, safe.code);
  }
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new PhotoUploadError("The file operation could not be confirmed. Retry this same file."); }
  const result = schema.safeParse(raw);
  if (!result.success) throw new PhotoUploadError("The file operation could not be confirmed. Retry this same file.");
  return result.data;
}

export async function describeUploadFile(file: Blob, name: string) {
  if (!file.size || file.size > 15 * 1024 * 1024) throw new PhotoUploadError("The file exceeds the supported upload size.", false);
  const description = uploadFileSchema.safeParse({ name, mimeType: file.type, sizeBytes: file.size,
    sha256: await digestPhotoBytes(file) });
  if (!description.success) throw new PhotoUploadError("The file name or size is unsupported. Rename the file and select it again.", false);
  return description.data;
}
async function begin(input: BeginObjectRequest, signal?: AbortSignal): Promise<UploadIntent> {
  const request = beginObjectRequestSchema.parse(input);
  const intent = await objectRequest("intents", request, uploadIntentSchema, signal);
  if (intent.operationId !== request.operationId || intent.file.sha256 !== request.file.sha256 || intent.file.sizeBytes !== request.file.sizeBytes
    || (request.kind === "photo" ? intent.purpose !== "photo" || intent.workOrderId !== request.workOrderId || intent.batchId !== request.batchId
      : intent.parentId !== request.parentId || intent.purpose !== request.purpose)) throw new PhotoUploadError("The upload reservation could not be verified.");
  return intent;
}
const photoStorage = createBrowserPhotoStorageAdapter({
  session: () => supabase().auth.getSession(),
  download: path => supabase().storage.from("photos").download(path),
  configuration: getPublicSupabaseConfig,
  fetch: (target, init) => fetch(target, init),
});
async function upload(intent: UploadIntent, file: Blob, signal?: AbortSignal) {
  if (intent.purpose === "photo") return photoStorage.uploadReservedPhoto(intent, file, signal);
  const contentType = intent.purpose === "estimate_attachment" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
  // Browser session, exact server-reserved path, INSERT only. MIME here is
  // early transport compatibility; trusted inspection remains authoritative.
  const { data, error } = await supabase().auth.getSession();
  if (error || !data.session) throw new PhotoUploadError("Please sign in again.");
  // The installed SDK upload method does not forward AbortSignal. Use its
  // binary POST protocol directly, with the same user credential and no upsert.
  const configuration = getPublicSupabaseConfig();
  const response = await fetch(`${configuration.url}/storage/v1/object/${intent.bucket}/${intent.objectPath.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST", body: file, headers: { "Content-Type": contentType, "x-upsert": "false",
      apikey: configuration.publishableKey, Authorization: `Bearer ${data.session.access_token}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new PhotoUploadError("Upload was not confirmed. Retry this file to check the same reserved object.");
}

export async function cancelUnattachedUpload(intent: UploadIntent): Promise<UploadIntent> {
  const result = await objectRequest("cancel", { intentId: intent.intentId }, uploadIntentSchema);
  if (result.intentId !== intent.intentId || result.operationId !== intent.operationId || result.objectPath !== intent.objectPath) {
    throw new PhotoUploadError("The attachment recovery receipt could not be verified.");
  }
  return result;
}

export function createWorkOrderPhotoPorts(workOrderId: string, expectedAssignmentVersion: number, expectedWorkflowCycle: number): PhotoUploadPorts<UploadIntent> {
  const batchFiles = new Map<string, string>();
  return {
    async begin(file, operationId, batchId, signal) {
      const description = await describeUploadFile(file, file.name);
      const fingerprint = `${batchId}:${description.sha256}`;
      const existingOperation = batchFiles.get(fingerprint);
      if (existingOperation && existingOperation !== operationId) {
        throw new PhotoUploadError("This image is already included in this batch. Remove the duplicate selection.", false);
      }
      batchFiles.set(fingerprint, operationId);
      const intent = await begin({ kind: "photo", workOrderId, operationId, batchId, expectedAssignmentVersion, expectedWorkflowCycle,
        file: description }, signal);
      return { intent, status: intent.status === "finalized" ? "confirmed" : intent.status === "pending" ? "upload_required"
        : intent.status === "validating" ? "uploaded" : intent.status === "cleaned" ? "cancelled" : "cleanup_required",
      storagePath: intent.status === "finalized" ? intent.objectPath : undefined };
    },
    upload,
    async finalize(intent, signal, onFinalizing) {
      const result = await objectRequest("finalize", { intentId: intent.intentId }, finalizeResponseSchema, signal);
      onFinalizing();
      if (result.status === "confirmed") {
        if (result.intent.intentId !== intent.intentId || result.intent.status !== "finalized"
          || result.intent.operationId !== intent.operationId || result.intent.objectPath !== intent.objectPath
          || result.intent.purpose !== "photo" || result.intent.workOrderId !== workOrderId) throw new PhotoUploadError("The photo receipt could not be verified.");
        return { status: "confirmed", storagePath: result.intent.objectPath };
      }
      if ((result.status === "cleanup_required" ? result.intentId : result.intent.intentId) !== intent.intentId) throw new PhotoUploadError("The upload receipt could not be verified.");
      return result.status === "cleanup_required" ? { status: "cleanup_required", message: result.code === "UNSUPPORTED_IMAGE_FORMAT"
        ? PHOTO_ACCEPTED_FORMAT_GUIDANCE : result.message } : { status: "upload_required" };
    },
    async cancel(intent) {
      const result = await cancelUnattachedUpload(intent);
      return result.status === "finalized" ? { status: "confirmed", storagePath: result.objectPath }
        : result.status === "cleaned" ? { status: "cancelled" } : { status: "cleanup_required" };
    },
  };
}

// Retain identities across double-clicks and same-Blob retries. No sharing by
// hash across customers; a new selection is a distinct approved operation.
const attachmentAttempts = new WeakMap<Blob, Map<string, { operationId: string; promise?: Promise<UploadIntent>; intent?: UploadIntent }>>();
export async function uploadBoundAttachment(parentId: string, purpose: Exclude<ObjectPurpose, "photo">, file: Blob, name: string): Promise<UploadIntent> {
  if (!file.size || file.size > (purpose === "estimate_attachment" ? 15 : 5) * 1024 * 1024) {
    throw new PhotoUploadError(purpose === "estimate_attachment" ? "Equipment forms must be 15 MB or smaller." : "PDF documents must be 5 MB or smaller.", false);
  }
  let attempts = attachmentAttempts.get(file);
  if (!attempts) { attempts = new Map(); attachmentAttempts.set(file, attempts); }
  const key = `${purpose}:${parentId}`;
  let attempt = attempts.get(key);
  if (!attempt) { attempt = { operationId: crypto.randomUUID() }; attempts.set(key, attempt); }
  if (attempt.promise) return attempt.promise;
  const current = attempt;
  current.promise = (async () => {
    const intent = current.intent ?? await begin({ kind: "attachment", parentId, purpose, operationId: current.operationId,
      file: await describeUploadFile(file, name) });
    current.intent = intent;
    // Always check before upload. Response loss must never generate a second
    // PDF/form path, including a response lost immediately after begin.
    let result = await objectRequest("finalize", { intentId: intent.intentId }, finalizeResponseSchema);
    if (result.status === "upload_required") {
      await upload(intent, file);
      result = await objectRequest("finalize", { intentId: intent.intentId }, finalizeResponseSchema);
    }
    if (result.status !== "confirmed") throw new PhotoUploadError(result.status === "cleanup_required"
      ? `${result.message} To start a new attachment attempt after cleanup, reload the page and reselect or regenerate the document.`
      : "The attachment has not been confirmed. Retry the same file.");
    if (result.intent.intentId !== intent.intentId || result.intent.parentId !== parentId || result.intent.purpose !== purpose
      || result.intent.operationId !== intent.operationId || result.intent.objectPath !== intent.objectPath) throw new PhotoUploadError("The attachment receipt could not be verified.");
    current.intent = result.intent;
    return result.intent;
  })().finally(() => { current.promise = undefined; });
  return current.promise;
}

const deletionAttempts = new Map<string, { operationId: string; promise?: Promise<void> }>();
export async function deleteBoundObject(purpose: ObjectPurpose, metadataId: string): Promise<void> {
  const key = `${purpose}:${metadataId}`;
  let attempt = deletionAttempts.get(key);
  if (!attempt) { attempt = { operationId: crypto.randomUUID() }; deletionAttempts.set(key, attempt); }
  if (attempt.promise) return attempt.promise;
  const current = attempt;
  current.promise = (async () => {
    const result = await objectRequest("delete", { purpose, metadataId, operationId: current.operationId },
      z.object({ status: z.enum(["deleted", "pending"]), operationId: z.uuid(), metadataId: z.uuid() }));
    if (result.operationId !== current.operationId || result.metadataId !== metadataId) throw new PhotoUploadError("The deletion receipt could not be verified.");
    if (result.status !== "deleted") throw new PhotoUploadError("Photo or attachment deletion is pending. Retry this same item to check its status.");
  })().finally(() => { current.promise = undefined; });
  return current.promise;
}
