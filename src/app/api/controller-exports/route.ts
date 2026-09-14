import { createApiMethodBoundary } from "../../../lib/server/apiMethodBoundary";
import { NextRequest } from "next/server";
import { createRequestContext } from "../../../lib/observability/requestContext";
import { runRequestOperation } from "../../../lib/server/requestOperation";
import { finalizeApiResponse, errorResponse } from "../../../lib/errors/httpBoundary";
import { handleControllerExportRequest } from "../../../server/controller-exports/httpBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/controller-exports", ["GET", "POST", "PATCH"]);
export const PUT = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const context = createRequestContext(request, "/api/controller-exports");
  try { return await runRequestOperation(context, async () => { return finalizeApiResponse(await handleControllerExportRequest("GET", request), context); }); }
  catch (boundaryError) { return errorResponse(boundaryError, context); }
}
export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/controller-exports");
  try { return await runRequestOperation(context, async () => { return finalizeApiResponse(await handleControllerExportRequest("POST", request), context); }); }
  catch (boundaryError) { return errorResponse(boundaryError, context); }
}
export async function PATCH(request: NextRequest) {
  const context = createRequestContext(request, "/api/controller-exports");
  try { return await runRequestOperation(context, async () => { return finalizeApiResponse(await handleControllerExportRequest("PATCH", request), context); }); }
  catch (boundaryError) { return errorResponse(boundaryError, context); }
}
