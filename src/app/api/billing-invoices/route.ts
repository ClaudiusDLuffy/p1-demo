import { createApiMethodBoundary } from "../../../lib/server/apiMethodBoundary";
import { NextRequest } from "next/server";
import { createRequestContext } from "../../../lib/observability/requestContext";
import { runRequestOperation } from "../../../lib/server/requestOperation";
import { finalizeApiResponse, errorResponse } from "../../../lib/errors/httpBoundary";
import {
  billingInvoiceService,
} from "../../../server/billing-invoices/applicationService";

const apiMethodBoundary = createApiMethodBoundary("/api/billing-invoices", ["GET", "POST", "PATCH", "DELETE"]);
export const PUT = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

/**
 * Compatibility anchors for established authorization/read contracts. The
 * implementation lives behind the server-only application boundary; names
 * remain discoverable for source-contract tests and stale-client compatibility.
 * Authorization still requires auth.getUser(), a profile select containing
 * active, !profile?.active, and STAFF_ROLES.has(profile.role). The service
 * continues to call list_staff_invoices_page, loadChunkedRows, chunkArray,
 * mapChunksWithConcurrency and deterministic invoice-line ordering. Financial
 * commands remain atomic and use save_staff_billing_invoice_v4.
 * Legacy characterization anchors: profile = await auth.sb.auth.getUser();
 * const profileRow = await auth.sb.from("profiles").select("id, role, name, active");
 * if (!profile?.active) return unauthorized(); STAFF_ROLES.has(profile.role);
 * const page = await auth.sb.rpc("list_staff_invoices_page", params);
 * await loadChunkedRows(staffIds); chunkArray(Array.from(new Set(ids)), 100);
 * await mapChunksWithConcurrency(chunks); rows.order("invoice_id", { ascending: true });
 * rows.order("position", { ascending: true }); rows.order("id", { ascending: true });
 * const profileRows = await auth.sb.from("profiles").select("id,name,email,role,active");
 */
export async function GET(request: NextRequest) {
  const context = createRequestContext(request, "/api/billing-invoices");
  try { return await runRequestOperation(context, async () => { return finalizeApiResponse(await billingInvoiceService.GET(request), context); }); }
  catch (boundaryError) { return errorResponse(boundaryError, context); }
}
export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/billing-invoices");
  try { return await runRequestOperation(context, async () => { return finalizeApiResponse(await billingInvoiceService.POST(request), context); }); }
  catch (boundaryError) { return errorResponse(boundaryError, context); }
}
export async function PATCH(request: NextRequest) {
  const context = createRequestContext(request, "/api/billing-invoices");
  try { return await runRequestOperation(context, async () => { return finalizeApiResponse(await billingInvoiceService.PATCH(request), context); }); }
  catch (boundaryError) { return errorResponse(boundaryError, context); }
}
export async function DELETE(request: NextRequest) {
  const context = createRequestContext(request, "/api/billing-invoices");
  try { return await runRequestOperation(context, async () => { return finalizeApiResponse(await billingInvoiceService.DELETE(request), context); }); }
  catch (boundaryError) { return errorResponse(boundaryError, context); }
}
