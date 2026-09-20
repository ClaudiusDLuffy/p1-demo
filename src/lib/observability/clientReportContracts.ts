import { z } from "zod";
import { isPublicErrorCode, type PublicErrorCode } from "../errors/catalog";
import { redactText } from "./redaction";
export const CLIENT_DIAGNOSTIC_BODY_BYTES = 25_000; // Original decimal-byte cap.
export const CLIENT_REPORT_TIMEOUT_MS = 4_000;
export const CLIENT_REPORT_ACCEPTED_HEADER = "X-P1-Diagnostic-Accepted";
const identifier = z.string().max(128).regex(/^[A-Za-z0-9_-]+$/);
const label = z.string().max(120).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);
export const diagnosticDetailsSchema = z.strictObject({
  scope: z.enum(["active", "capital", "all"]).optional(), page: z.number().int().min(1).max(1_000_000).optional(),
  itemCount: z.number().int().min(0).max(1_000_000).optional(), totalCount: z.number().int().min(0).max(1_000_000).optional(),
  hasMore: z.boolean().optional(), contractorScopeResolved: z.boolean().optional(),
});
export const clientReportSchema = z.strictObject({
  version: z.literal(1), code: z.custom<PublicErrorCode>(isPublicErrorCode), correlationId: z.uuid().optional(),
  level: z.enum(["error", "warning", "info"]), source: label,
  message: z.string().max(2_000).transform(value => redactText(value)),
  // A bounded compatibility input, never logged or persisted.
  stack: z.string().max(8_000).optional(), route: z.string().max(150).regex(/^\/[a-zA-Z0-9_/-]*$/).optional(),
  portalView: label.optional(), details: diagnosticDetailsSchema.optional(),
  context: z.strictObject({ workOrderId: identifier.optional(), invoiceId: z.uuid().optional(), operationId: z.uuid().optional(),
    state: z.enum(["pending", "failed", "unknown", "superseded", "completed"]).optional() }).optional(),
});
export type ClientDiagnosticReport = z.infer<typeof clientReportSchema>;
export type ClientReportResult = { status: "accepted" | "rate_limited" | "rejected" | "unavailable" | "aborted"; correlationId?: string };
export function reportOutcomeText(result: ClientReportResult | null): string {
  if (!result) return "Automatic error reporting is pending.";
  if (result.status === "accepted") return `The error report was accepted.${result.correlationId ? ` Error reference: ${result.correlationId}` : ""}`;
  return `Automatic error reporting was not confirmed. Contact support if the problem continues.${result.correlationId ? ` Error reference: ${result.correlationId}` : ""}`;
}
