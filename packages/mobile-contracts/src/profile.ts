import { z } from "zod";
import { MobileContractError } from "./errors";

const profileSchema = z.object({
  id: z.uuid(), role: z.string().min(1), active: z.boolean(), name: z.string(), email: z.email(),
}).passthrough();
const scopeSchema = z.object({
  contractorAccountId: z.uuid().nullable(), organizationId: z.uuid().nullable(),
  organizationName: z.string().nullable(), accessLevel: z.enum(["company_admin", "invoice", "report_only"]).nullable(),
  canInvoice: z.boolean(), canManageTeam: z.boolean(),
}).strict();
export type MobileCapability = "technician" | "company_admin" | "unsupported";
export type MobileProfile = {
  userId: string; name: string; email: string; role: string; active: true; capability: MobileCapability;
  contractorAccountId: string | null; organizationId: string | null; organizationName: string | null;
  accessLevel: "company_admin" | "invoice" | "report_only" | null;
};
export function parseMobileProfile(profile: unknown, scope: unknown, sessionUserId: string): MobileProfile {
  const p = profileSchema.safeParse(profile);
  if (!p.success) throw new MobileContractError("profile_invalid", "Your profile could not be verified.");
  if (p.data.id !== sessionUserId) throw new MobileContractError("profile_invalid", "Your profile identity could not be verified.");
  if (!p.data.active) throw new MobileContractError("account_inactive", "This account is inactive.");
  if (p.data.role !== "contractor") return {
    userId: p.data.id, name: p.data.name, email: p.data.email, role: p.data.role, active: true,
    capability: "unsupported", contractorAccountId: null, organizationId: null, organizationName: null, accessLevel: null,
  };
  const s = scopeSchema.safeParse(scope);
  if (!s.success || !s.data.contractorAccountId || !s.data.organizationId) {
    throw new MobileContractError("profile_invalid", "Your contractor access could not be verified.");
  }
  const capability: MobileCapability = s.data.accessLevel === "company_admin" && s.data.canManageTeam
    ? "company_admin" : s.data.accessLevel === "report_only" ? "technician" : "unsupported";
  return {
    userId: p.data.id, name: p.data.name, email: p.data.email, role: p.data.role, active: true, capability,
    contractorAccountId: s.data.contractorAccountId, organizationId: s.data.organizationId,
    organizationName: s.data.organizationName, accessLevel: s.data.accessLevel,
  };
}
