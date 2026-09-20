import type { DirectoryActor } from "../directory/contracts";
import { AppError } from "../../lib/errors/AppError";
export type PortalAuthProfile = DirectoryActor & {
  id: string; role: string; active: boolean; name: string; email: string; initials: string; staffPermissions: string[];
  title: string | null; company: string | null; phone: string | null; territory: string | null;
  trades: string[]; color: string | null; isDemo: boolean; contractorOrganizationName: string | null;
  dispatcherId: string | null; canInvoice: boolean; contractorNteDisplay: number;
  defaultLaborRate: number | null; defaultTruckRate: number | null;
};
const row = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : null;
const numeric = (value: unknown) => (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value)) ? Number(value) : null;
/** Exact self hydration only: directory projections remain separate. */
export function parseAuthProfile(profile: unknown, contractorScope: unknown, grants: unknown, demo: boolean): PortalAuthProfile {
  const p = row(profile); const scope = row(contractorScope);
  if (typeof p.id !== "string" || typeof p.role !== "string" || typeof p.active !== "boolean") throw new AppError("AUTH_REQUIRED");
  return { id: p.id, role: p.role, active: p.active, name: text(p.name) ?? "", email: text(p.email) ?? "", initials: text(p.initials) ?? "",
    title: text(p.title), company: text(p.company), phone: text(p.phone), territory: text(p.territory),
    trades: Array.isArray(p.trades) ? p.trades.filter((value): value is string => typeof value === "string") : [], color: text(p.color), isDemo: demo,
    contractorTier: text(p.contractor_tier), dispatcherId: text(p.dispatcher_id),
    contractorAccountId: text(scope.contractorAccountId) ?? (p.role === "contractor" ? p.id : null),
    contractorOrganizationId: text(scope.organizationId), contractorOrganizationName: text(scope.organizationName),
    contractorAccessLevel: text(scope.accessLevel), canInvoice: scope.canInvoice === true,
    canManageTeam: scope.canManageTeam === true, canLeadTeam: scope.canLeadTeam === true,
    staffPermissions: Array.isArray(grants) ? grants.flatMap(grant => typeof row(grant).permission === "string" ? [String(row(grant).permission)] : []) : [],
    contractorNteDisplay: numeric(p.contractor_nte_display) ?? 1000,
    defaultLaborRate: numeric(p.default_labor_rate), defaultTruckRate: numeric(p.default_truck_rate) };
}
