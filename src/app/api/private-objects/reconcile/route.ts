import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/private-objects/reconcile", ["POST"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { handlePrivateObjectReconciliation } from "../../../../lib/server/privateObjectHandlers";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const context = createRequestContext(request, "/api/private-objects/reconcile");
  try {
    return await runRequestOperation(context, async () => { return await finalizeApiResponse(await handlePrivateObjectReconciliation(request), context); 
    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
