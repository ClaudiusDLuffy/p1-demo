import { createApiMethodBoundary } from "../../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/notifications/dispatch/drain", ["POST", "GET"]);
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import { drainReceivingDispatches } from "../../../../../lib/server/receivingDispatchWorker";
import { isCronAuthorized, assertScheduledJobsAllowed } from "../../../../../lib/config/server/cron";
import { graphDeliveryConfigurationError } from "../../../../../lib/config/server/graph";
import { ConfigurationError } from "../../../../../lib/config/shared";
import { safeLog } from "../../../../../lib/observability/safeLogger";

export const runtime = "nodejs";
export const maxDuration = 60;

const authorized = isCronAuthorized;

export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/notifications/dispatch/drain");
  try {
    return await runRequestOperation(context, async () => {
  if (!authorized(request)) return await finalizeApiResponse(await NextResponse.json({ error: "Unauthorized" }, { status: 401 }), context);
  assertScheduledJobsAllowed();
  const configurationError = graphDeliveryConfigurationError(undefined, { includeOwnerRecipients: true });
  const configured = !configurationError;
  try {
    // Database lease recovery must still run while provider configuration is
    // unavailable. The worker checks configuration before any provider I/O.
    const summary = await drainReceivingDispatches();
    const logged = safeLog("receiving_dispatch_drain", context, { ...summary, configured, status: configured ? 200 : 503, ...(configurationError ? { code: configurationError.code } : {}) });
    if (configurationError && logged) context.failureLogged = true;
    if (configurationError) return await finalizeApiResponse(await NextResponse.json({ code: configurationError.code, error: configurationError.message, summary }, { status: 503 }), context);
    return await finalizeApiResponse(await NextResponse.json(summary), context);
  }
  catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return await finalizeApiResponse(await NextResponse.json({ error: "Receiving dispatch worker unavailable" }, { status: 503 }), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}

// Vercel cron invokes GET; authenticated POST remains available to operations.
export const GET = POST;
