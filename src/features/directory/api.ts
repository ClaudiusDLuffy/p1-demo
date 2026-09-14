import { supabase } from "../../lib/supabase/client";
import { AppError } from "../../lib/errors/AppError";
import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";
import { directoryLabelIds, isDirectoryId, normalizeDirectorySearch, parseDirectoryItem,
  parseDirectoryPage, DIRECTORY_PAGE_SIZE, type DirectoryDomain, type DirectoryItem,
  type DirectorySelectionDomain } from "./contracts";

async function directoryRpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  type Result = { data: unknown; error: { code?: string } | null };
  type Request = PromiseLike<Result> & { abortSignal: (signal: AbortSignal) => Request };
  const client = supabase() as unknown as { rpc: (name: string, args: Record<string, unknown>) => Request };
  let request = client.rpc(name, args);
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  signal?.throwIfAborted();
  // A fixed code, never an error-message substring, identifies a stale cursor.
  if (error) {
    if (error.code === "PDC01") throw new AppError("INVALID_CURSOR");
    throw normalizeUnknownError(error);
  }
  return data;
}
export async function loadDirectoryPage(domain: DirectoryDomain, query = "", contractorId: string | null = null,
  cursor: string | null = null, signal?: AbortSignal) {
  if (contractorId !== null && !isDirectoryId(contractorId)) throw new AppError("INVALID_REQUEST");
  if (cursor !== null && !/^[A-Za-z0-9_-]{1,8192}$/.test(cursor)) throw new AppError("INVALID_CURSOR");
  const page = parseDirectoryPage(domain, await directoryRpc("list_directory_page_v1", {
    p_domain: domain, p_query: normalizeDirectorySearch(query), p_contractor_id: contractorId,
    p_limit: DIRECTORY_PAGE_SIZE, p_cursor: cursor,
  }, signal));
  if (contractorId !== null && page.items.some(item => item.contractorId !== contractorId)) throw new AppError("INTERNAL_ERROR");
  return page;
}
export async function loadDirectorySelection(domain: DirectorySelectionDomain, id: string,
  contractorId: string | null = null, signal?: AbortSignal): Promise<DirectoryItem | null> {
  if (!isDirectoryId(id)) return null;
  if (contractorId !== null && !isDirectoryId(contractorId)) throw new AppError("INVALID_REQUEST");
  const data = await directoryRpc("get_directory_selection_v1", {
    p_domain: domain, p_id: id, p_contractor_id: contractorId,
  }, signal);
  if (data === null) return null;
  const item = parseDirectoryItem(domain, data, true);
  if ((domain === "technician_profile" ? item.profileId : item.id) !== id
    || (contractorId !== null && item.contractorId !== contractorId)) throw new AppError("INTERNAL_ERROR");
  return item;
}
export async function loadDirectoryLabels(ids: readonly string[], signal?: AbortSignal): Promise<DirectoryItem[]> {
  const exactIds = directoryLabelIds(ids);
  if (!exactIds.length) return [];
  const data = await directoryRpc("get_directory_profile_labels_v1", { p_ids: exactIds }, signal);
  if (!Array.isArray(data) || data.length > exactIds.length) throw new AppError("INTERNAL_ERROR");
  const items = data.map(item => parseDirectoryItem("profile_labels", item));
  if (items.some(item => !exactIds.includes(item.id)) || new Set(items.map(item => item.id)).size !== items.length) throw new AppError("INTERNAL_ERROR");
  return items;
}
export async function loadAutoAssignmentCandidate(city: string, trades: string[], signal?: AbortSignal): Promise<DirectoryItem | null> {
  const data = await directoryRpc("get_directory_auto_assignment_candidate_v1", {
    p_city: city, p_trade_tags: trades,
  }, signal);
  return data === null ? null : parseDirectoryItem("assignable_contractors", data, true);
}
