import { AppError } from "../errors/AppError";
import { parseBillingReadInput, type BillingReadInput } from "../../features/billing/billingReadContracts";
import { canonicalBillingReadUuid } from "../../features/billing/billingReadUuid";

export type CompactBillingRead =
  | { kind: "page"; page: BillingReadInput }
  | { kind: "count"; page: BillingReadInput }
  | { kind: "summary"; invoiceId: string }
  | { kind: "sources"; invoiceIds: readonly string[] }
  | { kind: "lines"; invoiceId: string; limit: number; cursor: string | null; expectedVersion: number | null };

const invalid = (): never => { throw new AppError("INVALID_REQUEST"); };

/** Explicit opt-in: stale clients keep their original read representation. */
export function parseCompactBillingRead(search: URLSearchParams): CompactBillingRead | null {
  const contract = search.get("contract");
  if (contract === null) return null;
  if (contract !== "compact-v1") return invalid();
  for (const key of ["contract", "invoiceId", "sourceInvoiceIds", "lines", "limit", "cursor", "expectedVersion"]) {
    if (search.getAll(key).length !== 1 && search.has(key)) return invalid();
  }
  const invoiceId = search.get("invoiceId");
  const sourceIds = search.get("sourceInvoiceIds");
  if (sourceIds !== null) {
    if (invoiceId !== null || search.has("lines") || sourceIds.length > 3_699) return invalid();
    const ids = sourceIds.split(",").map(value => canonicalBillingReadUuid(value) ?? invalid());
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) return invalid();
    return { kind: "sources", invoiceIds: ids };
  }
  if (invoiceId !== null) {
    const canonicalId = canonicalBillingReadUuid(invoiceId) ?? invalid();
    if (!search.has("lines")) {
      if (search.has("cursor") || search.has("expectedVersion")) return invalid();
      return { kind: "summary", invoiceId: canonicalId };
    }
    if (search.get("lines") !== "1") return invalid();
    const limit = search.get("limit") ?? "50";
    if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) return invalid();
    const cursor = search.get("cursor");
    if (cursor !== null && (!cursor.length || cursor.length > 8192 || /[\u0000-\u0020\u007f]/.test(cursor))) {
      throw new AppError("INVALID_CURSOR");
    }
    const version = search.get("expectedVersion");
    if (version !== null && (!/^(0|[1-9]\d{0,15})$/.test(version) || !Number.isSafeInteger(Number(version)))) return invalid();
    if (cursor !== null && version === null) throw new AppError("INVALID_CURSOR");
    return { kind: "lines", invoiceId: canonicalId, limit: Number(limit), cursor, expectedVersion: version === null ? null : Number(version) };
  }
  if (search.has("lines") || search.has("expectedVersion")) return invalid();
  const rowSearch = new URLSearchParams(search);
  if (!rowSearch.has("response")) rowSearch.set("response", "rows");
  const page = parseBillingReadInput(rowSearch);
  return { kind: page.response === "count" ? "count" : "page", page };
}
