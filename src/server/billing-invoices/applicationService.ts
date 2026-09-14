
import { parseCompactBillingRead } from "../../lib/server/billingCompactReadInput";
import { authorizeBillingRead } from "./billingReadContext";
import { createBillingReadRepository } from "./readRepository";
import { createBillingReadUseCases } from "./readUseCases";
import { executeLegacyBillingRead } from "./legacyReadUseCases";

const loadPostBillingInvoice = async () => import("./postBillingInvoice");
const loadPatchBillingInvoice = async () => import("./patchBillingInvoice");
const loadDeleteBillingInvoice = async () => import("./deleteBillingInvoice");

async function readBillingInvoices(request: Request): Promise<Response> {
  const parsed = parseCompactBillingRead(new URL(request.url).searchParams);
  const authorization = await authorizeBillingRead(request as never);
  if ("error" in authorization) return authorization.error;
  if (!parsed) return executeLegacyBillingRead(request, authorization);
  const repository = createBillingReadRepository(authorization.sb as never, authorization.isController);
  const useCases = createBillingReadUseCases(repository);
  const result = parsed.kind === "count"
    ? await useCases.count(parsed.page, request.signal)
    : parsed.kind === "page"
      ? await useCases.page(parsed.page, request.signal)
      : parsed.kind === "summary"
        ? await useCases.summary(parsed.invoiceId, request.signal)
        : parsed.kind === "lines"
          ? await useCases.lines(parsed, request.signal)
          : await useCases.sources(parsed, request.signal);
  return Response.json(parsed.kind === "count" ? result : result);
}

/** Method dispatcher. Explicit legacy GET compatibility has its own read
 * owner; mutation methods never load a legacy implementation. */
export const billingInvoiceService = Object.freeze({
  GET: readBillingInvoices,
  POST: async (request: Request) => (await loadPostBillingInvoice()).POST(request as never),
  PATCH: async (request: Request) => (await loadPatchBillingInvoice()).PATCH(request as never),
  DELETE: async (request: Request) => (await loadDeleteBillingInvoice()).DELETE(request as never),
});
