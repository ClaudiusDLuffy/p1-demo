import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/notifications/parts-order", ["GET", "POST"]);
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import { drainPartsSms } from "../../../../lib/server/partsSmsWorker";
import { isCronAuthorized, assertScheduledJobsAllowed } from "../../../../lib/config/server/cron";
import { ConfigurationError } from "../../../../lib/config/shared";
import { safeLog } from "../../../../lib/observability/safeLogger";

export const runtime = "nodejs";
export const maxDuration = 60;

const authenticated = isCronAuthorized;

async function run(request: NextRequest): Promise<Response> {
  const context = createRequestContext(request, "/api/notifications/parts-order");
  try {
    return await runRequestOperation(context, async () => {
  if (!authenticated(request)) return await finalizeApiResponse(await NextResponse.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 }), context);
  assertScheduledJobsAllowed();
  try {
    // Preserve the authenticated legacy force switch only. Recipient, date,
    // source signature and provider identity are never supplied by this route.
    const summary = await drainPartsSms({ force: request.nextUrl.searchParams.get("force") === "1", signal: request.signal });
    const unavailable = !!summary.configurationCode || ["TWILIO_NOT_CONFIGURED", "DATABASE_UNAVAILABLE", "TIME_BUDGET_EXCEEDED"].includes(summary.resultCode) || !summary.heartbeatConfirmed;
    const partial = summary.resultCode !== "RUN_COMPLETE";
    const logged = safeLog("parts_sms_worker_run", context, { ...summary, status: unavailable ? 503 : partial ? 207 : 200, ...(summary.configurationCode ? { code: summary.configurationCode } : {}) });
    if (unavailable && logged) context.failureLogged = true;
    const status = unavailable || partial ? "partial"
      : summary.evaluation === "disabled" ? "unscheduled"
        : summary.evaluation === "queued" ? "completed" : summary.evaluation;
    return await finalizeApiResponse(await NextResponse.json({ status, ...summary, ...(summary.configurationCode ? { code: summary.configurationCode } : {}) }, { status: unavailable ? 503 : partial ? 207 : 200 }), context);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return await finalizeApiResponse(await NextResponse.json({ error: "Parts SMS worker is unavailable.", code: "PARTS_SMS_RUN_UNAVAILABLE" }, { status: 503 }), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}

// Vercel Cron uses GET; POST remains a service-authenticated compatibility alias.
export const GET = run;
export const POST = run;
