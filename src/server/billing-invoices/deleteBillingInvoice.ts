import { NextRequest, NextResponse } from "next/server";
import { FinancialDeleteSchema, FinancialInvoiceIdSchema } from "../../lib/staffInvoiceContracts";
import { FinancialRequestError, financialErrorResponse, parseFinancialRequest } from "../../lib/financialHttpBoundary";
import { isInvoiceControllerProfile } from "../../lib/server/staffAuthorization";
import { legacyErrorResponse } from "../../lib/errors/legacyResponse";
import { authorizeBillingRead } from "./billingReadContext";
import { createBillingDeleteRepository } from "./billingCommandRepository";

const jsonError = legacyErrorResponse;

/** Focused DELETE boundary. The database RPC remains the sole authority for
 * active-source checks, atomic audit, versioning, and replay semantics. */
export async function DELETE(req: NextRequest) {
  try {
    const id = FinancialInvoiceIdSchema.safeParse(req.nextUrl.searchParams.get("id"));
    if (!id.success) throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "A valid invoice id is required", 422);
    const command = await parseFinancialRequest(req, FinancialDeleteSchema);
    const auth = await authorizeBillingRead(req);
    if ("error" in auth) return auth.error;
    if (isInvoiceControllerProfile(auth.profile)) return jsonError("Forbidden", 403);
    const result = await createBillingDeleteRepository(auth.sb).deleteInvoice(auth.user.id, id.data, command, req.signal);
    return NextResponse.json({ invoice: {
      id: result.invoiceId, num: result.invoiceNum, work_order_id: result.workOrderId, deleted_at: result.deletedAt,
    }, command: result });
  } catch (error) {
    return financialErrorResponse(error);
  }
}
