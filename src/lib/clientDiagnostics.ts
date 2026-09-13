"use client";
import { supabase } from "./supabase/client";
import { normalizeUnknownError } from "./errors/normalizeUnknown";
import { diagnosticDetailsSchema, type ClientReportResult } from "./observability/clientReportContracts";
import { sendClientReport } from "./observability/clientReportTransport";
import { normalizeCorrelationId, validCorrelationId } from "./observability/correlationId";

const LAST_FAILED_REQUEST_KEY = "p1:last-failed-request";
const LAST_CLIENT_ERROR_KEY = "p1:last-client-error";
const LAST_REPORT_RESULT_KEY = "p1:last-report-result";
export type ClientFailureContext = { source: string; message: string; stack?: string | null; portalView?: string | null; correlationId?: string };
export type ClientDiagnosticLevel = "error" | "warning" | "info";
export type ClientDiagnosticValue = string | number | boolean | null;
export type ClientDiagnosticContext = ClientFailureContext & { level?: ClientDiagnosticLevel; details?: Record<string, ClientDiagnosticValue> };
export type LastFailedRequest = { method: string; path: string; status: number | null; occurredAt: string; correlationId?: string };

export function sanitizeDiagnosticDetails(details: ClientDiagnosticContext["details"]) {
  const allowed: Record<string, unknown> = {};
  try {
    for (const key of ["scope", "page", "itemCount", "totalCount", "hasMore", "contractorScopeResolved"]) {
      const descriptor = details && Object.getOwnPropertyDescriptor(details, key);
      if (descriptor && "value" in descriptor) allowed[key] = descriptor.value;
    }
    const parsed = diagnosticDetailsSchema.safeParse(allowed);
    return parsed.success ? parsed.data : {};
  } catch { return {}; }
}
export function diagnosticRequestPath(input: RequestInfo | URL): string {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const pathname = new URL(raw, window.location.origin).pathname;
    // Never retain private Storage paths, query credentials, or arbitrary hosts.
    if (pathname.startsWith("/storage/")) return "/storage";
    if (pathname.startsWith("/auth/")) return "/auth";
    if (pathname.startsWith("/rest/")) return "/rest";
    return /^\/api\/[a-z-]+(?:\/[a-z-]+){0,3}$/.test(pathname) ? pathname : "/";
  } catch { return "/"; }
}
export function rememberFailedRequest(request: LastFailedRequest): void {
  try {
    const path = diagnosticRequestPath(new URL(request.path, window.location.origin));
    window.sessionStorage.setItem(LAST_FAILED_REQUEST_KEY, JSON.stringify({ method: /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/.test(request.method) ? request.method : "OTHER",
      path, status: typeof request.status === "number" && request.status >= 400 && request.status <= 599 ? request.status : null,
      occurredAt: new Date().toISOString(), correlationId: validCorrelationId(request.correlationId) ?? undefined }));
  } catch { /* best effort */ }
}
export function readLastFailedRequest(): LastFailedRequest | null {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(LAST_FAILED_REQUEST_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const fields = raw as Record<string, unknown>;
    if (typeof fields.method !== "string" || typeof fields.path !== "string" || typeof fields.occurredAt !== "string") return null;
    return { method: fields.method.slice(0, 10), path: diagnosticRequestPath(new URL(fields.path, window.location.origin)), occurredAt: fields.occurredAt.slice(0, 40),
      status: typeof fields.status === "number" ? fields.status : null, correlationId: validCorrelationId(fields.correlationId) ?? undefined };
  } catch { return null; }
}
function shouldReport(signature: string): boolean {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(LAST_CLIENT_ERROR_KEY) || "null");
    if (raw && typeof raw === "object" && Reflect.get(raw, "signature") === signature && typeof Reflect.get(raw, "at") === "number"
      && Date.now() - Number(Reflect.get(raw, "at")) < 30_000) return false;
    window.sessionStorage.setItem(LAST_CLIENT_ERROR_KEY, JSON.stringify({ signature, at: Date.now() }));
  } catch { /* no browser-storage dependency */ }
  return true;
}
export async function reportClientDiagnostic(context: ClientDiagnosticContext, signal?: AbortSignal): Promise<ClientReportResult> {
  if (typeof window === "undefined") return { status: "unavailable" };
  try {
    const error = normalizeUnknownError({ message: context.message });
    const source = /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(context.source) ? context.source : "client_failure";
    const correlationId = normalizeCorrelationId(context.correlationId ?? readLastFailedRequest()?.correlationId);
    if (!shouldReport(source + ":" + error.code)) return { status: "unavailable", correlationId };
    const portalView = context.portalView && /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(context.portalView) ? context.portalView : undefined;
    const result = await sendClientReport({ version: 1, source, code: error.code, message: error.message,
      level: context.level ?? "error", correlationId, portalView, details: sanitizeDiagnosticDetails(context.details),
      // Never send arbitrary Error stacks or customer text from a caller.
      route: "/" }, { signal, token: async () => {
        const { data } = await supabase().auth.getSession(); return data.session?.access_token ?? null;
      }, fetch });
    try { window.sessionStorage.setItem(LAST_REPORT_RESULT_KEY, JSON.stringify(result)); } catch { /* best effort */ }
    return result;
  } catch { return { status: signal?.aborted ? "aborted" : "unavailable" }; }
}
export function reportClientFailure(context: ClientFailureContext, signal?: AbortSignal): Promise<ClientReportResult> {
  return reportClientDiagnostic({ ...context, level: "error" }, signal);
}
