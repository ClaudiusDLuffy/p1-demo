import { errorData } from "./errorData";

export type PublicFieldError = { path: string; code: string; message: string };
export const MAX_FIELD_ERRORS = 20;
// Form/schema field NAMES only, never caller-controlled record keys. Kept
// separate from request validation: an unknown field still yields an error,
// but cannot carry rejected input into the public response through its path.
// Sources: staff/contractor invoice, lifecycle/assignment, private-object,
// parts-settings, diagnostics and shared create/report form contracts.
const publicSegments = new Set([
  "request", "field", "id", "action", "amount", "type", "desc", "description", "qty", "rate", "isTaxable",
  "taxTreatmentManual", "sourceInvoiceLineId", "sourceWorkOrderPartId", "sourceUnitCost", "markupPercent",
  "operationId", "expectedInvoiceVersion", "expectedAssignmentVersion", "expectedWorkflowCycle", "expectedLifecycleVersion",
  "num", "userTypedNum", "workOrderId", "storeNumber", "storeAddress", "cme", "invoiceDate", "serviceDate", "dueDate",
  "terms", "state", "territory", "equipmentTag", "taxState", "salesTaxOverride", "taxRateOverride", "lines", "sourceInvoiceIds",
  "reason", "invoiceId", "invoiceIds", "event", "holdId", "expectedHoldId", "expectedReviewRevision", "reviewRevision",
  "salesTax", "pdfStoragePath", "mode", "totalOverride", "tax", "uploadOnly", "uploadedTotal", "total",
  "kind", "name", "mimeType", "sizeBytes", "sha256", "batchId", "file", "parentId", "purpose", "intentId", "metadataId",
  "bindingId", "limit", "dryRun", "profileId", "phoneE164", "active", "email", "enabled", "timezone", "cutoffTime", "recipients",
  "version", "code", "correlationId", "level", "source", "message", "stack", "route", "portalView", "details", "context",
  "scope", "page", "itemCount", "totalCount", "hasMore", "contractorScopeResolved",
  "partNumber", "expectedReturnDate", "eta", "checkedInAt", "checkedOutAt", "notes", "parts", "legacyPartNeeded", "legacyPartEta",
  "completedAt", "assetMake", "assetModel", "assetSerial", "assetYear", "resolutionCode", "resolutionNotes", "contractorId", "confirmed",
  "wot", "incidentId", "store", "city", "addr", "afm", "afmEmail", "lineOfService", "businessService", "category", "subCategory",
  "priority", "nte", "assign", "summary", "technicianName", "arrivalTime", "departureTime", "workPerformed", "partsUsed", "password", "confirm",
]);
function safeSegment(value: unknown): string {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? String(value) : "field";
  if (typeof value !== "string") return "field";
  if (publicSegments.has(value)) return value;
  return /^(0|[1-9][0-9]{0,6})$/.test(value) && Number(value) <= 1_000_000 ? value : "field";
}
export function safeFieldErrors(input: unknown): PublicFieldError[] | undefined {
  try {
    if (!Array.isArray(input)) return undefined;
    const length = errorData(input, "length");
    if (typeof length !== "number") return undefined;
    const fields: PublicFieldError[] = [];
    for (let index = 0; index < Math.min(length, MAX_FIELD_ERRORS); index++) {
      const path = errorData(errorData(input, String(index)), "path");
      let joined: unknown = path;
      if (Array.isArray(path)) {
        const pathLength = errorData(path, "length");
        if (typeof pathLength !== "number") continue;
        const parts: string[] = [];
        for (let partIndex = 0; partIndex < Math.min(pathLength, 8); partIndex++) {
          const part = errorData(path, String(partIndex));
          parts.push(safeSegment(part));
        }
        joined = parts.join(".");
      }
      if (typeof joined !== "string" || joined.length > 100 || !/^[a-zA-Z0-9_.\[\]-]*$/.test(joined)) continue;
      const segments = joined.match(/[a-zA-Z0-9_-]+/g) ?? [];
      if (segments.length > 8) continue;
      const safePath = joined.replace(/[a-zA-Z0-9_-]+/g, safeSegment);
      if (safePath.length > 100) continue;
      // Validation-library messages can embed rejected values. Publish a fixed
      // message, never issue.input or an arbitrary provider message.
      fields.push({ path: safePath || "request", code: "INVALID_FIELD", message: "Check this field." });
    }
    return fields.length ? fields : undefined;
  } catch { return undefined; }
}
