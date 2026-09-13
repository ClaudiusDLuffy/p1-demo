import { isPublicErrorCode } from "./catalog";
import { validCorrelationId } from "../observability/correlationId";

const counters = new Set(["queued", "eligible", "parts", "workOrders", "claimed", "accepted", "sent", "deliveredUpdates", "failed",
  "retryableFailed", "unknown", "notDeliverable", "superseded", "skipped", "recoveredBeforeSend", "recoveredUnknown",
  "completionUnconfirmed", "statusChecked", "statusUnavailable", "statusStale", "recurrenceQueued", "recurrenceBlocked",
  "recovered", "retryScheduled", "processed"]);
const states = new Set(["partial", "completed", "queued", "disabled", "unscheduled", "before_cutoff", "nothing_to_send",
  "capacity_exceeded", "no_recipients", "unavailable"]);
const runCodes = new Set(["RUN_COMPLETE", "RUN_PARTIAL", "TWILIO_NOT_CONFIGURED", "DATABASE_UNAVAILABLE", "TIME_BUDGET_EXCEEDED"]);

function workerSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (counters.has(key) && typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= 100_000) result[key] = item;
    else if (["heartbeatConfirmed", "configured"].includes(key) && typeof item === "boolean") result[key] = item;
    else if (["status", "evaluation"].includes(key) && typeof item === "string" && states.has(item)) result[key] = item;
    else if (key === "resultCode" && typeof item === "string" && runCodes.has(item)) result[key] = item;
    else if (key === "configurationCode" && (item === null || isPublicErrorCode(item))) result[key] = item;
    else if (key === "runId" && validCorrelationId(item)) result[key] = item;
    else if (key === "localDate" && (item === null || typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item))) result[key] = item;
  }
  return result;
}

/** Only existing service aggregate aliases survive an error response. Never
 * spread provider payloads, customer content or arbitrary nested details. */
export function serviceFailureAliases(route: string, body: Record<string, unknown>): Record<string, unknown> {
  if (["/api/notifications/parts-order", "/api/notifications/dispatch/drain", "/api/notifications/financial/drain"].includes(route)) {
    return { ...workerSummary(body), ...(body.summary ? { summary: workerSummary(body.summary) } : {}) };
  }
  if (route === "/api/email-intake") {
    return { ...workerSummary(body), ...(Array.isArray(body.results) ? { results: body.results.slice(0, 100).map((item: unknown) => {
      const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      return {
        action: ["created", "updated", "skipped", "failed"].includes(String(row.action)) ? row.action : "failed",
        logStatus: ["recorded", "already_recorded", "unconfirmed"].includes(String(row.logStatus)) ? row.logStatus : "unconfirmed",
        ...(isPublicErrorCode(row.logError) ? { logError: row.logError } : {}),
      };
    }) } : {}) };
  }
  return {};
}
