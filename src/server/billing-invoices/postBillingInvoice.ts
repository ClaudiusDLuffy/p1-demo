import { NextRequest, NextResponse } from "next/server";
import { createRequestContext } from "../../lib/observability/requestContext";
import { currentRequestOperation, runRequestOperation } from "../../lib/server/requestOperation";
import { errorResponse, finalizeApiResponse } from "../../lib/errors/httpBoundary";
import { FinancialRequestError, financialErrorResponse } from "../../lib/financialHttpBoundary";
import { authorizeBillingSave } from "./billingMutationContext";
import { parseBillingSaveRequest } from "./billingPostContracts";
import { saveBillingInvoice } from "./saveBillingInvoice";
import { loadStaffInvoiceById } from "./billingPostReadAfterWrite";
import { createBillingSaveScope } from "./createBillingSaveScope";

export async function POST(request: NextRequest) {
  const context = currentRequestOperation() ?? createRequestContext(request, "/api/billing-invoices");
  try {
    return await runRequestOperation(context, async () => {
      try {
        const command = await parseBillingSaveRequest(request);
        if (command.expectedInvoiceVersion !== null) throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "A new invoice cannot supply an existing invoice version", 422);
        const authorization = await authorizeBillingSave(request);
        if ("error" in authorization) return finalizeApiResponse(authorization.error, context);
        const result = await saveBillingInvoice(command, authorization, { ...createBillingSaveScope(authorization), loadCommittedInvoice: invoiceId => loadStaffInvoiceById(authorization.dataSession, invoiceId, request.signal) });
        return finalizeApiResponse(NextResponse.json(result), context);
      } catch (error) {
        return finalizeApiResponse(await financialErrorResponse(error), context);
      }
    });
  } catch (error) {
    return errorResponse(error, context);
  }
}
