import { z } from "zod";
import type { AssignmentServerDatabase } from "./workOrderAssignmentContracts";

// Identity bound matches the existing priority/creation source-message boundary.
// Text bounds are operational summaries, not a place to retain provider payloads.
export const intakeSourceIdSchema = z.string().trim().min(1).max(2048)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "Invalid intake identity");
export const intakeActionSchema = z.enum(["created", "updated", "skipped", "failed"]);
export const intakeConfidenceSchema = z.enum(["high", "medium", "low"]);

export function boundedIntakeText(value: string, maximum: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\b(?:access_token|refresh_token|client_secret|authorization|api[_-]?key)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/giu, "[redacted credential]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[redacted authorization]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
    .trim();
  const characters = Array.from(safe);
  const marker = " [truncated]";
  return characters.length <= maximum ? safe : characters.slice(0, maximum - marker.length).join("") + marker;
}

const text = (maximum: number) => z.string().transform(value => boundedIntakeText(value, maximum));
// Every key is explicit; no body, header, metadata or caller provenance is accepted.
export const intakeLogPayloadSchema = z.strictObject({
  email_id: intakeSourceIdSchema,
  subject: text(1024).nullable().default(null),
  action: intakeActionSchema,
  work_order_id: z.string().trim().min(1).max(128).nullable().default(null),
  reason: text(2000).pipe(z.string().min(1)),
  parse_confidence: intakeConfidenceSchema,
  contractor_assigned: z.string().uuid().nullable().default(null),
  raw_subject: text(1024).nullable().default(null),
  raw_from: text(320).nullable().default(null),
}).refine(payload => !["created", "updated"].includes(payload.action) || payload.work_order_id !== null,
  "Successful intake requires a work order");
export type EmailIntakeLogPayload = z.infer<typeof intakeLogPayloadSchema>;
export type EmailIntakeAction = z.infer<typeof intakeActionSchema>;

export const intakeLogResultSchema = z.strictObject({
  applied: z.boolean(),
  reason: z.enum(["recorded", "already_recorded"]),
  logId: z.string().uuid(),
  eventId: z.string().uuid(),
  sourceMessageId: intakeSourceIdSchema,
  processedAt: z.string().datetime({ offset: true }),
}).refine(result => result.applied === (result.reason === "recorded"), "Unconfirmed intake receipt");
export type EmailIntakeLogReceipt = z.infer<typeof intakeLogResultSchema>;
export type EmailIntakeLogArguments = {
  p_event_id: string;
  p_source_message_id: string;
  p_payload: EmailIntakeLogPayload;
};
export type EmailIntakeServerDatabase = AssignmentServerDatabase & {
  public: { Functions: {
    record_email_intake_result_v1: { Args: EmailIntakeLogArguments; Returns: unknown };
  } };
};
