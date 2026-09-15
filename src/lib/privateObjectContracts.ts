import { z } from "zod";
import type { AssignmentDatabase } from "./workOrderAssignmentContracts";
import type { EmailIntakeServerDatabase } from "./emailIntakeLogContracts";
import type { Json } from "./supabase/database.types";

export const objectPurposeSchema = z.enum(["photo", "invoice_original", "invoice_generated", "estimate_attachment"]);
export type ObjectPurpose = z.infer<typeof objectPurposeSchema>;
export const uploadFileSchema = z.strictObject({
  name: z.string().trim().min(1).max(255), mimeType: z.string().max(128),
  sizeBytes: z.number().int().positive().max(15 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const beginObjectRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("photo"), workOrderId: z.string().min(1).max(128),
    operationId: z.uuid(), batchId: z.uuid(), expectedAssignmentVersion: z.number().int().nonnegative(),
    expectedWorkflowCycle: z.number().int().nonnegative(), file: uploadFileSchema }),
  z.strictObject({ kind: z.literal("attachment"), parentId: z.uuid(),
    purpose: objectPurposeSchema.exclude(["photo"]), operationId: z.uuid(), file: uploadFileSchema }),
]);
export type BeginObjectRequest = z.infer<typeof beginObjectRequestSchema>;
const safePath = z.string().min(1).max(512).refine(path => !/[\\%?#\u0000-\u001f]/u.test(path)
  && !path.split("/").some(part => part === "." || part === ".." || part === ""));
export const uploadIntentSchema = z.object({
  intentId: z.uuid(), operationId: z.uuid(), batchId: z.uuid().nullable(), purpose: objectPurposeSchema,
  workOrderId: z.string().min(1), parentId: z.uuid().nullable(),
  bucket: z.enum(["photos", "invoice-pdfs", "contractor-estimate-attachments"]), objectPath: safePath,
  status: z.enum(["pending", "validating", "finalized", "cleanup_required", "cancelled", "expired", "cleaned"]),
  expiresAt: z.iso.datetime({ offset: true }), claimId: z.uuid().nullable(), bindingId: z.uuid().nullable(),
  storageObjectId: z.uuid().nullable(), photoId: z.uuid().nullable(), attachmentId: z.uuid().nullable(), file: uploadFileSchema,
}).superRefine((value, context) => {
  const bucket = value.purpose === "photo" ? "photos" : value.purpose === "estimate_attachment" ? "contractor-estimate-attachments" : "invoice-pdfs";
  const path = value.purpose === "photo" ? `wo/${value.workOrderId}/${value.intentId}`
    : `${value.parentId}/${value.intentId}.${value.purpose === "estimate_attachment" ? "xlsx" : "pdf"}`;
  if (value.bucket !== bucket || value.objectPath !== path) context.addIssue({ code: "custom", message: "Invalid object reservation" });
  if (value.status === "finalized" && (!value.storageObjectId || !value.bindingId || (value.purpose === "photo" && !value.photoId)
    || (value.purpose === "estimate_attachment" && !value.attachmentId))) {
    context.addIssue({ code: "custom", message: "Missing finalized object evidence" });
  }
});
export type UploadIntent = z.infer<typeof uploadIntentSchema>;
export const intentRequestSchema = z.strictObject({ intentId: z.uuid() });
export const deleteRequestSchema = z.strictObject({ purpose: objectPurposeSchema, metadataId: z.uuid(), operationId: z.uuid() });
export const deletionSchema = z.object({
  deletionId: z.uuid(), operationId: z.uuid(), bindingId: z.uuid(), purpose: objectPurposeSchema,
  bucket: uploadIntentSchema.shape.bucket, objectPath: safePath,
  status: z.enum(["pending", "deleting", "deleted", "unknown", "failed"]),
  claimId: z.uuid().nullable(), photoId: z.uuid().nullable().optional(), attachmentId: z.uuid().nullable().optional(),
});
export type ObjectDeletion = z.infer<typeof deletionSchema>;
export const finalizeResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), intent: uploadIntentSchema }),
  z.object({ status: z.literal("upload_required"), intent: uploadIntentSchema }),
  z.object({ status: z.literal("cleanup_required"), intentId: z.uuid(), code: z.string().max(80), message: z.string().max(500) }),
]);
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;
type Routine<Args> = { Args: Args; Returns: Json };
export type PrivateObjectFunctions = {
  begin_work_order_photo_upload_v1: Routine<{ p_work_order_id: string; p_operation_id: string; p_batch_id: string; p_expected_assignment_version: number; p_expected_workflow_cycle: number; p_file: Json }>;
  begin_contractor_attachment_upload_v1: Routine<{ p_parent_id: string; p_purpose: string; p_operation_id: string; p_file: Json }>;
  get_private_object_upload_v1: Routine<{ p_intent_id: string }>;
  claim_private_object_upload_v1: Routine<{ p_intent_id: string }>;
  cancel_private_object_upload_v1: Routine<{ p_intent_id: string }>;
  resolve_private_object_binding_v1: Routine<{ p_purpose: string; p_metadata_id: string; p_operation_id?: string }>;
  request_private_object_delete_v1: Routine<{ p_binding_id: string; p_operation_id: string }>;
};
export type PrivateObjectServiceFunctions = {
  get_verified_invoice_object_v1: Routine<{ p_invoice_id: string }>;
  finalize_private_object_upload_v1: Routine<{ p_intent_id: string; p_claim_id: string; p_inspection: Json }>;
  fail_private_object_upload_v1: Routine<{ p_intent_id: string; p_claim_id: string; p_code: string }>;
  claim_private_object_upload_cleanup_v1: Routine<{ p_intent_id: string }>;
  complete_private_object_upload_cleanup_v1: Routine<{ p_intent_id: string; p_claim_id: string; p_outcome: string }>;
  claim_private_object_deletion_v1: Routine<{ p_deletion_id: string }>;
  complete_private_object_deletion_v1: Routine<{ p_deletion_id: string; p_claim_id: string; p_outcome: string }>;
  list_private_object_reconciliation_v1: Routine<{ p_limit: number; p_dry_run: boolean }>;
};
export type PrivateObjectDatabase = AssignmentDatabase & { public: { Functions: PrivateObjectFunctions } };
export type PrivateObjectServerDatabase = EmailIntakeServerDatabase & { public: { Functions: PrivateObjectFunctions & PrivateObjectServiceFunctions } };

export class PrivateObjectError extends Error {
  constructor(readonly code: string, message = "The file operation could not be confirmed. Retry the same operation.", readonly httpStatus = 409) {
    super(message); this.name = "PrivateObjectError";
  }
}
