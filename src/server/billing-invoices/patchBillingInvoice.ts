import { NextRequest, NextResponse } from "next/server";
import { createRequestContext } from "../../lib/observability/requestContext";
import { currentRequestOperation, runRequestOperation } from "../../lib/server/requestOperation";
import { errorResponse, finalizeApiResponse } from "../../lib/errors/httpBoundary";
import { FinancialRequestError, financialErrorResponse, parseFinancialRequest } from "../../lib/financialHttpBoundary";
import { FinancialInvoiceIdSchema, StaffInvoicePatchSchema } from "../../lib/staffInvoiceContracts";
import { authorizeBillingSave } from "./billingMutationContext";
import { createBillingUpdateCommandRepository } from "./billingUpdateCommandRepository";
import { updateBillingInvoice } from "./updateBillingInvoice";
import { loadStaffInvoiceById } from "./billingPostReadAfterWrite";

export async function PATCH(request: NextRequest) {
  const context = currentRequestOperation() ?? createRequestContext(request, "/api/billing-invoices");
  try {
    return await runRequestOperation(context, async () => {
      try {
        const parsedId = FinancialInvoiceIdSchema.safeParse(request.nextUrl.searchParams.get("id"));
        if (!parsedId.success) throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "A valid invoice id is required", 422);
        const command = await parseFinancialRequest(request, StaffInvoicePatchSchema);
        if (!("action" in command) && command.expectedInvoiceVersion === null) {
          throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "An edit requires the captured invoice version", 422);
        }
        const authorization = await authorizeBillingSave(request);
        if ("error" in authorization) return finalizeApiResponse(authorization.error, context);
        const result = await updateBillingInvoice(command, parsedId.data, authorization, {
          commandRepository: createBillingUpdateCommandRepository(),
          loadCommittedInvoice: id => loadStaffInvoiceById(authorization.dataSession, id, request.signal),
        });
        return finalizeApiResponse(NextResponse.json(result), context);
      } catch (error) {
        return finalizeApiResponse(await financialErrorResponse(error), context);
      }
    });
  } catch (error) {
    return errorResponse(error, context);
  }
}
