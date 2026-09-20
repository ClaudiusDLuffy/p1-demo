import { AppError } from "../../lib/errors/AppError";
export const DIRECTORY_KEY = ["directory"] as const;
export const DIRECTORY_PAGE_SIZE = 25;
export const DIRECTORY_MAX_PAGE_SIZE = 50;
export const DIRECTORY_LABEL_LIMIT = 100;
export const DIRECTORY_DEBOUNCE_MS = 300;

export type DirectoryDomain = "assignable_contractors" | "staff_choices"
  | "contractor_directory" | "contractor_filter" | "contacts"
  | "company_technicians" | "technician_management" | "legacy_team";
export type DirectorySelectionDomain = DirectoryDomain | "profile_labels"
  | "contact_detail" | "technician_detail" | "technician_profile";

// These are purpose-specific projections, never complete profiles or grants.
export type DirectoryItem = {
  id: string;
  name: string;
  company?: string | null;
  initials?: string | null;
  color?: string | null;
  territory?: string | null;
  title?: string | null;
  trades?: string[];
  contractorId?: string;
  profileId?: string | null;
  isActive?: boolean;
  profileActive?: boolean | null;
  contractorAccessLevel?: string | null;
  email?: string | null;
  phone?: string | null;
  activeCount?: number;
  capitalCount?: number;
  teamActiveCount?: number;
};
export type DirectoryPage = {
  items: DirectoryItem[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};
export type DirectoryActor = {
  id?: string | null;
  role?: string | null;
  active?: boolean | null;
  contractorAccountId?: string | null;
  contractorOrganizationId?: string | null;
  contractorAccessLevel?: string | null;
  contractorTier?: string | null;
  canManageTeam?: boolean;
  canLeadTeam?: boolean;
  staffPermissions?: readonly string[];
};
export const isDirectoryId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const normalizeDirectorySearch = (value: string) => {
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new AppError("INVALID_REQUEST");
  const query = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (query.length > 200) throw new AppError("INVALID_REQUEST");
  return query;
};
export const directoryScopeKey = (actor?: DirectoryActor | null) => [
  actor?.id || "", actor?.role || "", actor?.active === true,
  actor?.contractorAccountId || "", actor?.contractorOrganizationId || "",
  actor?.contractorAccessLevel || "", actor?.contractorTier || "",
  actor?.canManageTeam === true, actor?.canLeadTeam === true,
  [...(actor?.staffPermissions || [])].sort().join(","),
] as const;
export function directoryLabelIds(values: readonly unknown[]): string[] {
  const ids = [...new Set(values.filter(isDirectoryId))].sort();
  if (ids.length > DIRECTORY_LABEL_LIMIT) throw new AppError("INVALID_REQUEST");
  return ids;
}
export const directoryItemValue = (item: DirectoryItem, technician = false) => technician
  ? item.profileId || `legacy:${item.id}` : item.id;

const fields: Record<DirectorySelectionDomain, readonly (keyof DirectoryItem)[]> = {
  assignable_contractors: ["company", "territory"], staff_choices: [],
  contractor_filter: [], legacy_team: [],
  contractor_directory: ["company", "initials", "color", "territory", "trades", "activeCount", "capitalCount", "teamActiveCount"],
  contacts: ["company", "title", "initials", "color"],
  profile_labels: ["company", "initials", "color"],
  contact_detail: ["company", "title", "initials", "color", "email", "phone"],
  company_technicians: ["contractorId", "profileId", "isActive", "profileActive", "contractorAccessLevel"],
  technician_profile: ["contractorId", "profileId", "isActive", "profileActive", "contractorAccessLevel"],
  technician_management: ["contractorId", "profileId", "isActive", "profileActive", "contractorAccessLevel"],
  technician_detail: ["contractorId", "profileId", "isActive", "profileActive", "contractorAccessLevel", "email", "phone"],
};
export function parseDirectoryItem(domain: DirectorySelectionDomain, value: unknown, exact = false): DirectoryItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INTERNAL_ERROR");
  const row = value as Record<string, unknown>;
  const textLimit = exact ? 65_536 : 500;
  if (exact && new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) throw new AppError("INTERNAL_ERROR");
  if (!isDirectoryId(row.id) || typeof row.name !== "string" || row.name.length > textLimit) throw new AppError("INTERNAL_ERROR");
  if (Object.keys(row).some(key => !["id", "name", ...fields[domain]].includes(key))) throw new AppError("INTERNAL_ERROR");
  const item: DirectoryItem = { id: row.id, name: row.name };
  for (const field of fields[domain]) {
    const fieldValue = row[field];
    if (fieldValue === undefined) throw new AppError("INTERNAL_ERROR");
    if (field === "trades") {
      if (!Array.isArray(fieldValue) || fieldValue.length > (exact ? 1000 : 50) || !fieldValue.every(value => typeof value === "string" && value.length <= (exact ? textLimit : 200))) throw new AppError("INTERNAL_ERROR");
    } else if (["activeCount", "capitalCount", "teamActiveCount"].includes(field)) {
      if (!Number.isSafeInteger(fieldValue) || Number(fieldValue) < 0) throw new AppError("INTERNAL_ERROR");
    } else if (["isActive", "profileActive"].includes(field)) {
      if (!(field === "profileActive" && fieldValue === null) && typeof fieldValue !== "boolean") throw new AppError("INTERNAL_ERROR");
    } else if (fieldValue !== null && (typeof fieldValue !== "string" || fieldValue.length > textLimit)) throw new AppError("INTERNAL_ERROR");
    if (field === "contractorId" && !isDirectoryId(fieldValue)) throw new AppError("INTERNAL_ERROR");
    if (field === "profileId" && fieldValue !== null && !isDirectoryId(fieldValue)) throw new AppError("INTERNAL_ERROR");
    Object.assign(item, { [field]: fieldValue });
  }
  return item;
}
export function parseDirectoryPage(domain: DirectoryDomain, value: unknown): DirectoryPage {
  const page = value as Partial<DirectoryPage> | null;
  if (!page || !Array.isArray(page.items) || !Number.isInteger(page.pageSize)
    || Number(page.pageSize) < 1 || Number(page.pageSize) > DIRECTORY_MAX_PAGE_SIZE
    || page.items.length > Number(page.pageSize) || typeof page.hasMore !== "boolean"
    || Object.keys(page).some(key => !["items", "pageSize", "hasMore", "nextCursor"].includes(key))
    || (page.hasMore ? !page.items.length || typeof page.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,8192}$/.test(page.nextCursor) : page.nextCursor !== null)) {
    throw new AppError("INTERNAL_ERROR");
  }
  const items = page.items.map(item => parseDirectoryItem(domain, item));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new AppError("INTERNAL_ERROR");
  return { items,
    pageSize: Number(page.pageSize), hasMore: page.hasMore, nextCursor: page.nextCursor || null };
}
