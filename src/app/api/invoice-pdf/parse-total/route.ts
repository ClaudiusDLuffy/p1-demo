import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/invoice-pdf/parse-total", ["POST"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { type NextRequest, NextResponse } from "next/server";
import { extractInvoiceDataFromPdf } from "../../../../lib/invoicePdfParser";
import { InvoicePdfError } from "../../../../lib/pdf/invoicePdfBudget";
import { requireInvoicePdfActor } from "../../../../lib/server/invoicePdfAuthorization";
import { InvoicePdfRequestError, readUploadedInvoicePdf } from "../../../../lib/server/invoicePdfRequest";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/invoice-pdf/parse-total");
  try {
    return await runRequestOperation(context, async () => {
  try {
    // No multipart body is read before the current actor is authorized.
    await requireInvoicePdfActor(request);
    const bytes = await readUploadedInvoicePdf(request);
    const result = await extractInvoiceDataFromPdf(bytes, { signal: request.signal });
    if (request.signal.aborted) throw new InvoicePdfRequestError("REQUEST_ABORTED");
    return await finalizeApiResponse(await NextResponse.json(result, { headers }), context);
  } catch (error: unknown) {
    if (error instanceof InvoicePdfRequestError) {
      return await finalizeApiResponse(await NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers }), context);
    }
    if (error instanceof InvoicePdfError) {
      const status = error.code === "PDF_INVALID_SIGNATURE" ? 415
        : ["REQUEST_ABORTED", "PDF_PARSE_TIMEOUT"].includes(error.code) ? 408
          : error.code === "PDF_PARSE_BUSY" ? 503
            : ["PDF_PARSE_FAILED", "PDF_CLEANUP_FAILED"].includes(error.code) ? 500
              : ["PDF_TOO_LARGE", "PDF_PAGE_LIMIT", "PDF_ITEM_LIMIT", "PDF_TEXT_LIMIT", "PDF_OUTPUT_LIMIT"].includes(error.code) ? 413 : 422;
      return await finalizeApiResponse(await NextResponse.json({ error: error.message, code: error.code }, { status, headers }), context);
    }
    return await finalizeApiResponse(await NextResponse.json({ error: "The PDF text could not be read", code: "PDF_PARSE_FAILED" }, { status: 500, headers }), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
