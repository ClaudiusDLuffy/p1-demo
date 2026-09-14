import process from "node:process";
import { normalizeUnknownError } from "../errors/normalizeUnknown";
import { isPublicErrorCode } from "../errors/catalog";
import { validCorrelationId } from "./correlationId";
import type { RequestContext } from "./requestContext";
import { redact } from "./redaction";
export type LogSink = (line: string) => void;
export function releaseTags(): { environment: string; release: string } {
  const environment = process.env.P1_APP_ENV;
  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  return { environment: environment && ["development", "preview", "production", "test"].includes(environment) ? environment : "unconfigured",
    release: release && /^[a-f0-9]{40}$/i.test(release) ? release.toLowerCase() : "unversioned" };
}
const allowedKeys = new Set(["operationId", "eventId", "attemptId", "runId", "role", "state", "provider", "count", "status", "durationMs", "claimed", "unknown", "accepted", "failed", "recurrenceQueued", "recurrenceBlocked"]);
const workerCounters = new Set(["queued", "eligible", "parts", "workOrders", "claimed", "accepted", "sent", "deliveredUpdates", "failed", "retryableFailed", "unknown", "notDeliverable", "superseded", "skipped", "completionUnconfirmed", "recoveredBeforeSend", "recoveredUnknown", "statusChecked", "statusUnavailable", "statusStale", "recurrenceQueued", "recurrenceBlocked"]);
export function safeLog(event: string, context: RequestContext, fields: Record<string, unknown> = {}, sink: LogSink = console.info): boolean {
  try {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields).slice(0, 32)) {
      if (key === "code" && isPublicErrorCode(value)) safe.code = value;
      else if (workerCounters.has(key)) { if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000) safe[key] = value; }
      else if (["configured", "heartbeatConfirmed"].includes(key) && typeof value === "boolean") safe[key] = value;
      else if (allowedKeys.has(key)) {
        if (key.endsWith("Id")) { const id = validCorrelationId(value); if (id) safe[key] = id; }
        else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
        else if (typeof value === "boolean") safe[key] = value;
        else if (typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)) safe[key] = value;
      }
    }
    const redacted = redact(safe) as Record<string, unknown>;
    // UUIDs were validated above. Their numeric tails are not phone numbers;
    // retaining these references is necessary for cross-boundary correlation.
    for (const [key, value] of Object.entries(safe)) {
      if (key.endsWith("Id") && validCorrelationId(value)) redacted[key] = value;
    }
    sink(JSON.stringify({ timestamp: new Date().toISOString(), level: event === "api_failure" || typeof safe.status === "number" && safe.status >= 400 ? "error" : "info",
      event: /^[a-z][a-z0-9_]{0,79}$/.test(event) ? event : "operation", correlationId: context.correlationId,
      route: context.route, method: context.method, ...releaseTags(), ...redacted }));
    return true;
  } catch { return false; }
}
export function logBoundaryFailure(context: RequestContext, cause: unknown, sink?: LogSink): void {
  if (context.failureLogged) return;
  context.failureLogged = true;
  const error = normalizeUnknownError(cause);
  safeLog("api_failure", context, { code: error.code, status: error.status, durationMs: Math.round(performance.now() - context.startedAt) }, sink);
}
