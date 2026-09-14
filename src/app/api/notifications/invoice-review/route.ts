import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/notifications/invoice-review", ["POST"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeFinancialRequest, financialHttpError, financialRpcError, readFinancialRequest } from "../../../../lib/server/financialNotificationHttp";

export const runtime = "nodejs";
const requestSchema = z.strictObject({ invoiceId: z.uuid(), event: z.enum(["rejected", "retraction"]) });
const resultSchema = z.object({ success: z.literal(true), recipientCount: z.number().int().nonnegative(),
  notification: z.object({ eventId: z.uuid(), status: z.enum(["queued", "processing", "sent", "unknown", "not_deliverable", "superseded", "failed", "manually_resolved"]) }) });

export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/notifications/invoice-review");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await authorizeFinancialRequest(request, false);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);
  let body: unknown;
  try { body = await readFinancialRequest(request); }
  catch { return await finalizeApiResponse(await financialHttpError("VALIDATION_FAILED", "A valid invoice notification request is required.", 400), context); }
  const input = requestSchema.safeParse(body);
  if (!input.success) return await finalizeApiResponse(await financialHttpError("VALIDATION_FAILED", "A valid invoice notification request is required.", 400), context);
  try {
    // Compatibility only: the financial command already owns intent. This RPC
    // derives the current immutable review event; it never creates or sends one.
    const { data, error } = await auth.caller.rpc("get_financial_notification_review_compatibility_v1", {
      p_invoice_id: input.data.invoiceId, p_event: input.data.event,
    }).abortSignal(AbortSignal.timeout(5_000));
    if (error) return await finalizeApiResponse(await financialRpcError(error), context);
    const result = resultSchema.safeParse(data);
    if (!result.success) return await finalizeApiResponse(await financialHttpError("RESULT_UNCONFIRMED", "Notification status could not be confirmed.", 503), context);
    return await finalizeApiResponse(await NextResponse.json(result.data, { headers: { "Cache-Control": "no-store" } }), context);
  } catch (error) { return await finalizeApiResponse(await financialRpcError(error), context); }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
