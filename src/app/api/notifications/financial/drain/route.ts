import { createApiMethodBoundary } from "../../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/notifications/financial/drain", ["POST", "GET"]);
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import { drainFinancialNotifications } from "../../../../../lib/server/financialNotificationWorker";
import { isCronAuthorized, assertScheduledJobsAllowed } from "../../../../../lib/config/server/cron";
import { graphDeliveryConfigurationError } from "../../../../../lib/config/server/graph";
import { ConfigurationError } from "../../../../../lib/config/shared";
import { safeLog } from "../../../../../lib/observability/safeLogger";

export const runtime = "nodejs";
export const maxDuration = 60;

const authorized = isCronAuthorized;

export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/notifications/financial/drain");
  try {
    return await runRequestOperation(context, async () => {
  if (!authorized(request)) return await finalizeApiResponse(await NextResponse.json({ code: "AUTH_REQUIRED", error: "Unauthorized" }, { status: 401 }), context);
  assertScheduledJobsAllowed();
  const configurationError = graphDeliveryConfigurationError();
  const configured = !configurationError;
  try {
    // Lease recovery still runs when Graph is unavailable. Claims never depend
    // on a browser request and contain no caller-selected recipient.
    const summary = await drainFinancialNotifications();
    const logged = safeLog("financial_notification_drain", context, { ...summary, configured, status: configured ? 200 : 503, ...(configurationError ? { code: configurationError.code } : {}) });
    if (configurationError && logged) context.failureLogged = true;
    return await finalizeApiResponse(await NextResponse.json({ configured, summary, ...(configurationError ? { code: configurationError.code } : {}) },
      { status: configured ? 200 : 503, headers: { "Cache-Control": "no-store" } }), context);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return await finalizeApiResponse(await NextResponse.json({ code: "WORKER_UNAVAILABLE", error: "Financial notification delivery is temporarily unavailable." }, { status: 503 }), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}

// Vercel owns authenticated GET; POST is the same bounded operational trigger.
export const GET = POST;
