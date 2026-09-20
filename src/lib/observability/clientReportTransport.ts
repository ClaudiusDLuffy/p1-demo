import { clientReportSchema, CLIENT_REPORT_ACCEPTED_HEADER, CLIENT_REPORT_TIMEOUT_MS, type ClientReportResult } from "./clientReportContracts";
import { normalizeCorrelationId, REQUEST_ID_HEADER, validCorrelationId } from "./correlationId";
import { errorMetadata } from "../errors/catalog";
export async function sendClientReport(payload: unknown, dependencies: {
  token: () => Promise<string | null>; fetch: typeof fetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<ClientReportResult> {
  let parsed: ReturnType<typeof clientReportSchema.safeParse>;
  try { parsed = clientReportSchema.safeParse(payload); } catch { return { status: "rejected" }; }
  if (!parsed.success) return { status: "rejected" };
  const correlationId = normalizeCorrelationId(parsed.data.correlationId);
  const controller = new AbortController();
  let requestStarted = false;
  let responseReceived = false;
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
    requestStarted = true;
    const response = await Promise.race([dependencies.fetch("/api/client-errors", {
      method: "POST", signal: controller.signal, cache: "no-store", keepalive: true,
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
    responseReceived = true;
    // The successful server contract is bodyless. If an intermediary or an
    // older deployment supplies a body, discard it without awaiting the stream
    // so it cannot keep the browser request lifecycle open.
    if (response.body) void response.body.cancel().catch(() => undefined);
    const responseCorrelationId = validCorrelationId(response.headers.get(REQUEST_ID_HEADER));
    const acknowledgedId = responseCorrelationId ?? correlationId;
    if (!response.ok) {
      return { status: response.status === 429 ? "rate_limited" : response.status >= 500 ? "unavailable" : "rejected", correlationId: acknowledgedId };
    }
    // A same-origin, correlated 202 plus the closed receipt header is the
    // complete acknowledgement; no response-body read is needed.
    const accepted = response.status === 202
      && responseCorrelationId === correlationId
      && response.headers.get(CLIENT_REPORT_ACCEPTED_HEADER) === "1";
    return { status: accepted ? "accepted" : "unavailable", correlationId: acknowledgedId };
  } catch { return { status: dependencies.signal?.aborted ? "aborted" : "unavailable", correlationId }; }
  finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", abort);
    if (requestStarted && !responseReceived) controller.abort();
  }
}
