import { AppError } from "../../errors/AppError";
import { errorResponse } from "../../errors/httpBoundary";
import { readBoundedBody } from "../../http/boundedBody";
import { clientReportSchema, CLIENT_DIAGNOSTIC_BODY_BYTES, type ClientDiagnosticReport } from "../../observability/clientReportContracts";
import { createRequestContext, withRequestId, type RequestContext } from "../../observability/requestContext";
export type DiagnosticDependencies = {
  authorize: (request: Request) => Promise<string>;
  admit: (profileId: string, signal: AbortSignal) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  log: (report: ClientDiagnosticReport, context: RequestContext) => boolean;
};
export async function handleClientDiagnostic(request: Request, dependencies: DiagnosticDependencies): Promise<Response> {
  const context = createRequestContext(request, "/api/client-errors");
  try {
    const profileId = await dependencies.authorize(request);
    // Charge attempts before parsing: malformed floods cannot bypass the cap.
    const admission = await dependencies.admit(profileId, request.signal);
    if (!admission.allowed) throw new AppError("RATE_LIMITED", { retryAfterSeconds: admission.retryAfterSeconds });
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d{1,12}$/.test(length) || Number(length) > CLIENT_DIAGNOSTIC_BODY_BYTES)) throw new AppError("PAYLOAD_TOO_LARGE");
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AppError("INVALID_REQUEST");
    let raw: unknown;
    try { raw = JSON.parse(await readBoundedBody(request.body, { maximum: CLIENT_DIAGNOSTIC_BODY_BYTES, timeoutMs: 3_000, signal: request.signal })); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError("INVALID_REQUEST", { cause: error }); }
    const parsed = clientReportSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", { fieldErrors: parsed.error.issues });
    // The logging port never receives discarded legacy prose/stack/route data.
    const safeReport: ClientDiagnosticReport = { version: 1, level: parsed.data.level, source: "client_operation",
      code: parsed.data.code, message: "Client operation failed.", correlationId: context.correlationId,
      ...(parsed.data.context?.operationId ? { context: { operationId: parsed.data.context.operationId } } : {}) };
    if (!dependencies.log(safeReport, context)) throw new AppError("PROVIDER_UNAVAILABLE");
    return withRequestId(Response.json({ accepted: true, correlationId: context.correlationId }, { status: 202, headers: { "Cache-Control": "no-store" } }), context);
  } catch (error) {
    // No payload log on rejection; diagnostics cannot amplify logs recursively.
    context.failureLogged = true;
    if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined);
    return errorResponse(error, context);
  }
}
