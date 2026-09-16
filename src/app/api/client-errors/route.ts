import { createApiMethodBoundary } from "../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/client-errors", ["POST"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { handleClientDiagnostic } from "../../../lib/server/diagnostics/handler";
import { authorizeDiagnostic } from "../../../lib/server/diagnostics/authorization";
import { admitDiagnostic } from "../../../lib/server/diagnostics/rateLimit";
import { safeLog } from "../../../lib/observability/safeLogger";

export const runtime = "nodejs";
export const maxDuration = 15;
export async function POST(request: Request): Promise<Response> {
  return handleClientDiagnostic(request, {
    authorize: authorizeDiagnostic,
    admit: admitDiagnostic,
    // No free-form message, stack, URL, body or arbitrary detail enters logs.
    // Source, view and details have already passed closed-schema validation.
    log: (report, context) => safeLog("client_diagnostic", context, { code: report.code,
      clientLevel: report.level, source: report.source,
      ...(report.portalView ? { portalView: report.portalView } : {}),
      ...(report.details || {}),
      ...(report.context?.operationId ? { operationId: report.context.operationId } : {}) }),
  });
}
