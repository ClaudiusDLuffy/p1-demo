import { createApiMethodBoundary } from "../../lib/server/apiMethodBoundary";
const boundary = createApiMethodBoundary("/api/billing-invoices", ["POST", "PATCH"]);
export const PUT = boundary.methodNotAllowed;
export const OPTIONS = boundary.OPTIONS;
