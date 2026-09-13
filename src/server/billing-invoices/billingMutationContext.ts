import type { NextRequest } from "next/server";
import { legacyErrorResponse } from "../../lib/errors/legacyResponse";
import { authorizeBillingRead, type BillingReadAuthorization } from "./billingReadContext";

export type AuthorizedBillingSaveContext = {
  actor: { userId: string; profileId: string; role: string | null; permissions: string[] };
  requestId: string | null;
  signal: AbortSignal | null;
  dataSession: BillingReadAuthorization extends { sb: infer S } ? S : never;
};

export async function authorizeBillingSave(request: NextRequest): Promise<AuthorizedBillingSaveContext | { error: Response }> {
  const authorized = await authorizeBillingRead(request);
  if ("error" in authorized) return authorized;
  if (authorized.isController) return { error: legacyErrorResponse("Forbidden", 403) };
  return {
    actor: { userId: authorized.user.id, profileId: authorized.profile.id, role: authorized.profile.role, permissions: authorized.profile.staffPermissions },
    requestId: request.headers.get("x-request-id"), signal: request.signal, dataSession: authorized.sb,
  };
}
