import { clientReportSchema, CLIENT_REPORT_TIMEOUT_MS, type ClientReportResult } from "./clientReportContracts";
import { normalizeCorrelationId, REQUEST_ID_HEADER, validCorrelationId } from "./correlationId";
import { readBoundedBody } from "../http/boundedBody";
import { errorMetadata } from "../errors/catalog";
export async function sendClientReport(payload: unknown, dependencies: {
  token: () => Promise<string | null>; fetch: typeof fetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<ClientReportResult> {
  let parsed: ReturnType<typeof clientReportSchema.safeParse>;
  try { parsed = clientReportSchema.safeParse(payload); } catch { return { status: "rejected" }; }
  if (!parsed.success) return { status: "rejected" };
  const correlationId = normalizeCorrelationId(parsed.data.correlationId);
  const controller = new AbortController();
  let rejectDeadline: () => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => { rejectDeadline = () => reject(new Error("REPORT_UNAVAILABLE")); });
  const abort = () => { controller.abort(); rejectDeadline(); };
  const timer = setTimeout(abort, Math.min(dependencies.timeoutMs ?? CLIENT_REPORT_TIMEOUT_MS, CLIENT_REPORT_TIMEOUT_MS));
  dependencies.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (dependencies.signal?.aborted) return { status: "aborted", correlationId };
    const token = await Promise.race([dependencies.token(), stopped]);
    // Pre-auth reporting is deliberately disabled.
    if (!token) return { status: "unavailable", correlationId };
    const response = await Promise.race([dependencies.fetch("/api/client-errors", {
      method: "POST", signal: controller.signal, cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [REQUEST_ID_HEADER]: correlationId },
      // Legacy callers may still supply a message/stack. Neither is needed by
      // the diagnostic sink; do not transport their potentially private text.
      body: JSON.stringify({ version: parsed.data.version, code: parsed.data.code, correlationId,
        level: parsed.data.level, source: parsed.data.source,
        message: errorMetadata(parsed.data.code).message,
        ...(parsed.data.route ? { route: parsed.data.route } : {}),
        ...(parsed.data.portalView ? { portalView: parsed.data.portalView } : {}),
        ...(parsed.data.details ? { details: parsed.data.details } : {}),
        ...(parsed.data.context ? { context: parsed.data.context } : {}),
      }),
    }), stopped]);
    const acknowledgedId = validCorrelationId(response.headers.get(REQUEST_ID_HEADER)) ?? correlationId;
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { status: response.status === 429 ? "rate_limited" : response.status >= 500 ? "unavailable" : "rejected", correlationId: acknowledgedId };
    }
    const raw: unknown = JSON.parse(await readBoundedBody(response.body, { maximum: 1_024, timeoutMs: CLIENT_REPORT_TIMEOUT_MS, signal: controller.signal }));
    const accepted = raw !== null && typeof raw === "object" && Reflect.get(raw, "accepted") === true
      && validCorrelationId(Reflect.get(raw, "correlationId")) === acknowledgedId;
    return { status: response.status === 202 && accepted ? "accepted" : "unavailable", correlationId: acknowledgedId };
  } catch { return { status: dependencies.signal?.aborted ? "aborted" : "unavailable", correlationId }; }
  finally { clearTimeout(timer); dependencies.signal?.removeEventListener("abort", abort); controller.abort(); }
}
