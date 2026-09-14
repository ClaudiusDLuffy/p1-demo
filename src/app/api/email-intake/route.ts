import { createApiMethodBoundary } from "../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/email-intake", ["POST", "GET"]);
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../lib/server/requestOperation";
import { createRequestContext } from "../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import { runIntakeCycle } from "../../../lib/emailIntakeProcessor";
import { isCronAuthorized, assertScheduledJobsAllowed } from "../../../lib/config/server/cron";
import { getEmailIntakeConfig } from "../../../lib/config/server/emailIntake";
import { ConfigurationError } from "../../../lib/config/shared";

export const dynamic = "force-dynamic";

const authorizationError = (req: NextRequest) => {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }
  assertScheduledJobsAllowed();
  return null;
};

const runIntake = async () => {
  if (!getEmailIntakeConfig().enabled) {
    return NextResponse.json(
      { message: "Email intake is disabled" },
      { status: 200 },
    );
  }

  try {
    const results = await runIntakeCycle();
    const historyUnconfirmed = results.some(result => result.logStatus === "unconfirmed");
    return NextResponse.json({
      success: !historyUnconfirmed,
      processed: results.length,
      results,
      ...(historyUnconfirmed ? { code: "INTAKE_LOG_UNCONFIRMED" } : {}),
    }, { status: historyUnconfirmed ? 503 : 200 });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return NextResponse.json(
      { success: false, error: "Email intake could not be completed; operator review required", code: "INTAKE_PROCESSING_FAILED" },
      { status: 500 },
    );
  }
};

export async function POST(req: NextRequest) {
  const context = createRequestContext(req, "/api/email-intake");
  try {
    return await runRequestOperation(context, async () => {
  const authError = authorizationError(req);
  if (authError) return await finalizeApiResponse(await authError, context);

  return await finalizeApiResponse(await runIntake(), context);

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}

export async function GET(req: NextRequest) {
  const context = createRequestContext(req, "/api/email-intake");
  try {
    return await runRequestOperation(context, async () => {
  const authError = authorizationError(req);
  if (authError) return await finalizeApiResponse(await authError, context);

  return await finalizeApiResponse(await runIntake(), context);

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
