import { createApiMethodBoundary } from "../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/contractor-invoice-holds", ["GET", "PATCH"]);
export const POST = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../lib/server/requestOperation";
import { createRequestContext } from "../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeFinancialRequest, financialHttpError, financialRpcError, readFinancialRequest } from "../../../lib/server/financialNotificationHttp";
import { parsePaymentHoldPage, parsePaymentHoldQuery, paymentHoldReadError, type PaymentHoldPageRpc } from "../../../lib/paymentHoldPagination";

export const runtime = "nodejs";

const inputSchema = z.strictObject({
  invoiceId: z.uuid(), action: z.enum(["hold", "release"]), reason: z.string().trim().min(1).max(500),
  operationId: z.uuid().optional(), expectedSourceEventId: z.uuid().nullable().optional(),
});
const resultSchema = z.object({
  applied: z.boolean(), invoiceId: z.uuid(), invoiceNum: z.string().max(500),
  reason: z.enum(["already_held", "not_held"]).optional(),
  holdAt: z.string().nullable().optional(), holdBy: z.uuid().nullable().optional(), holdReason: z.string().max(500).optional(),
  releasedBy: z.uuid().optional(), releaseReason: z.string().max(500).optional(),
  cancelledBatchIds: z.array(z.uuid()).optional(), operationId: z.uuid(), replayed: z.boolean(),
  notificationStatus: z.enum(["not_required", "queued", "not_deliverable"]),
  notifications: z.array(z.object({ eventId: z.uuid(), sourceEventId: z.uuid(),
    family: z.enum(["payment_hold_placed", "payment_hold_released"]), status: z.enum(["queued", "not_deliverable"]) })).max(1),
});

export async function GET(request: NextRequest) {
  const context = createRequestContext(request, "/api/contractor-invoice-holds");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await authorizeFinancialRequest(request, true);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);
  try {
    const args = parsePaymentHoldQuery(request.nextUrl.searchParams);
    const caller = auth.caller as unknown as PaymentHoldPageRpc;
    const { data, error } = await caller.rpc("list_contractor_invoice_payment_holds_page_v1", args)
      .abortSignal(AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]));
    if (error) return await finalizeApiResponse(await financialRpcError(paymentHoldReadError(error)), context);
    const page = parsePaymentHoldPage(data, args.p_limit);
    return await finalizeApiResponse(await NextResponse.json(page, {
      headers: { "Cache-Control": "no-store" },
    }), context);
  } catch (error) { return await finalizeApiResponse(await financialRpcError(paymentHoldReadError(error)), context); }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}

export async function PATCH(request: NextRequest) {
  const context = createRequestContext(request, "/api/contractor-invoice-holds");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await authorizeFinancialRequest(request, true);
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);
  let body: unknown;
  try { body = await readFinancialRequest(request); }
  catch { return await finalizeApiResponse(await financialHttpError("VALIDATION_FAILED", "A valid payment hold request is required.", 400), context); }
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return await finalizeApiResponse(await financialHttpError("VALIDATION_FAILED", "Check the invoice action and reason (1–500 characters).", 400), context);
  const input = parsed.data;
  if (!input.operationId || input.expectedSourceEventId === undefined) {
    // A stale browser cannot release a newer re-hold by silently reading a new
    // source event. Refresh supplies a stable operation and observed event.
    return await finalizeApiResponse(await financialHttpError("STALE_HOLD", "Refresh the invoice before changing its payment hold.", 409), context);
  }
  if (input.action === "release" && !auth.canRelease) {
    return await finalizeApiResponse(await financialHttpError("FORBIDDEN", "QuickBooks handoff permission is required to release a hold.", 403), context);
  }
  try {
    const { data, error } = await auth.caller.rpc("set_contractor_invoice_payment_hold_with_notification_v1", {
      p_invoice_id: input.invoiceId, p_action: input.action === "hold" ? "place" : "release", p_reason: input.reason,
      p_operation_id: input.operationId, p_expected_source_event_id: input.expectedSourceEventId,
    }).abortSignal(AbortSignal.timeout(5_000));
    if (error) return await finalizeApiResponse(await financialRpcError(error), context);
    const result = resultSchema.safeParse(data);
    if (!result.success || result.data.invoiceId !== input.invoiceId || result.data.operationId !== input.operationId) {
      return await finalizeApiResponse(await financialHttpError("RESULT_UNCONFIRMED", "The result could not be confirmed. Retry the same request or refresh its status.", 503), context);
    }
    return await finalizeApiResponse(await NextResponse.json({
      result: result.data, notificationWarning: null, notification: { status: result.data.notificationStatus },
    }, { headers: { "Cache-Control": "no-store" } }), context);
  } catch (error) { return await finalizeApiResponse(await financialRpcError(error), context); }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
