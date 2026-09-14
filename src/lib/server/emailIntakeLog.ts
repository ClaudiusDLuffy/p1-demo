import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createServerClient } from "../supabase/server";
import {
  intakeLogPayloadSchema, intakeLogResultSchema, intakeSourceIdSchema,
  type EmailIntakeLogPayload,
} from "../emailIntakeLogContracts";

export class IntakeLogUnconfirmedError extends Error {
  readonly code: "INTAKE_LOG_UNCONFIRMED" | "INTAKE_LOG_CONFLICT";
  constructor(cause: unknown) {
    const conflict = z.object({ code: z.literal("PT409") }).safeParse(cause).success;
    super(conflict ? "Intake event identity conflicts with retained history; operator review required."
      : "Trusted intake history could not be confirmed; reconcile before retrying.", { cause });
    this.code = conflict ? "INTAKE_LOG_CONFLICT" : "INTAKE_LOG_UNCONFIRMED";
    this.name = "IntakeLogUnconfirmedError";
  }
}

// The log is multi-event history, not one row per email. Exact normalized outcomes
// deduplicate across polling/retries; a later failed -> created or updated ->
// skipped outcome is a distinct event. Timestamps never supply event identity.
export function emailIntakeEventId(sourceId: string, payload: EmailIntakeLogPayload): string {
  const hex = createHash("sha256").update(JSON.stringify([
    "p1-email-intake-result-v1", sourceId, payload.action, payload.work_order_id,
    payload.reason, payload.parse_confidence,
  ])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function recordTrustedEmailIntakeResult(source: unknown, payload: unknown) {
  try {
    const sourceId = intakeSourceIdSchema.parse(source);
    const normalized = intakeLogPayloadSchema.parse(payload);
    const eventId = emailIntakeEventId(sourceId, normalized);
    const { data, error } = await createServerClient().rpc("record_email_intake_result_v1", {
      p_event_id: eventId, p_source_message_id: sourceId, p_payload: normalized,
    });
    if (error) throw error;
    const receipt = intakeLogResultSchema.parse(data);
    if (receipt.eventId !== eventId || receipt.sourceMessageId !== sourceId) {
      throw new Error("Intake receipt identity mismatch");
    }
    return receipt;
  } catch (error) {
    throw new IntakeLogUnconfirmedError(error);
  }
}
