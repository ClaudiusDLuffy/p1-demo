export const BILLING_DRAFT_VERSION = 1;
export const BILLING_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type BillingDraftScope = {
  userId: string;
  editingInvoiceId?: string | null;
};

export type BillingDraftPayload = {
  version: typeof BILLING_DRAFT_VERSION;
  savedAt: string;
  form: Record<string, unknown>;
  selectedSourceIds: string[];
  sourceSnapshots: Record<string, unknown>;
  partsMarkup: string;
  customTerritory: boolean;
  numberEdited: boolean;
};

const text = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

const optionalNumber = (value: unknown) => {
  if (value === "" || value == null) return value ?? "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "";
};

const normalizeLine = (line: unknown) => {
  const value = line && typeof line === "object" && !Array.isArray(line)
    ? line as Record<string, unknown>
    : {};
  return {
    type: text(value.type, "Other"),
    desc: text(value.desc ?? value.description),
    qty: optionalNumber(value.qty),
    rate: optionalNumber(value.rate),
    isTaxable: !!value.isTaxable,
    taxTreatmentManual: !!value.taxTreatmentManual,
    sourceInvoiceLineId: text(value.sourceInvoiceLineId) || null,
    sourceWorkOrderPartId: text(value.sourceWorkOrderPartId) || null,
    sourceUnitCost: value.sourceUnitCost == null
      ? null
      : optionalNumber(value.sourceUnitCost),
    markupPercent: value.markupPercent == null
      ? null
      : optionalNumber(value.markupPercent),
  };
};

const normalizeForm = (form: unknown): Record<string, unknown> | null => {
  if (!form || typeof form !== "object" || Array.isArray(form)) return null;
  const value = form as Record<string, unknown>;
  return {
    num: text(value.num),
    invoiceDate: text(value.invoiceDate),
    serviceDate: text(value.serviceDate),
    dueDate: text(value.dueDate),
    workOrderId: text(value.workOrderId),
    territory: text(value.territory),
    equipmentTag: text(value.equipmentTag, "7-ELEVEN: Miscellaneous"),
    storeNumber: text(value.storeNumber),
    storeAddress: text(value.storeAddress),
    terms: text(value.terms, "Net 30"),
    cme: text(value.cme),
    taxState: text(value.taxState),
    taxRateOverride: optionalNumber(value.taxRateOverride),
    salesTaxOverride: optionalNumber(value.salesTaxOverride),
    state: value.state === "draft" ? "draft" : "submitted",
    lines: Array.isArray(value.lines)
      ? value.lines.slice(0, 250).map(normalizeLine)
      : [],
  };
};

export function billingDraftStorageKey(scope: BillingDraftScope) {
  const user = encodeURIComponent(String(scope.userId || "anonymous"));
  const target = scope.editingInvoiceId
    ? `edit:${encodeURIComponent(scope.editingInvoiceId)}`
    : "new";
  return `p1:staff-billing-draft:v${BILLING_DRAFT_VERSION}:${user}:${target}`;
}

export function createBillingDraftPayload(input: {
  form: Record<string, unknown>;
  selectedSourceIds?: unknown[];
  sourceSnapshots?: Record<string, unknown>;
  partsMarkup?: unknown;
  customTerritory?: unknown;
  numberEdited?: unknown;
  savedAt?: string;
}): BillingDraftPayload {
  return {
    version: BILLING_DRAFT_VERSION,
    savedAt: input.savedAt || new Date().toISOString(),
    form: normalizeForm(input.form) || {},
    selectedSourceIds: (input.selectedSourceIds || [])
      .map(id => text(id).trim())
      .filter(Boolean)
      .slice(0, 100),
    sourceSnapshots: input.sourceSnapshots
      && typeof input.sourceSnapshots === "object"
      && !Array.isArray(input.sourceSnapshots)
      ? input.sourceSnapshots
      : {},
    partsMarkup: text(input.partsMarkup, "25"),
    customTerritory: !!input.customTerritory,
    numberEdited: !!input.numberEdited,
  };
}

export function parseBillingDraft(
  raw: string | null,
  now = Date.now(),
): BillingDraftPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BillingDraftPayload>;
    if (parsed.version !== BILLING_DRAFT_VERSION) return null;
    const savedAtMs = new Date(String(parsed.savedAt || "")).getTime();
    if (!Number.isFinite(savedAtMs)) return null;
    if (now - savedAtMs > BILLING_DRAFT_MAX_AGE_MS) return null;
    const form = normalizeForm(parsed.form);
    if (!form) return null;
    return createBillingDraftPayload({
      ...parsed,
      form,
      savedAt: new Date(savedAtMs).toISOString(),
    });
  } catch {
    return null;
  }
}

export function readBillingDraft(
  storage: StorageLike,
  key: string,
  now = Date.now(),
) {
  const draft = parseBillingDraft(storage.getItem(key), now);
  if (!draft) storage.removeItem(key);
  return draft;
}

export function writeBillingDraft(
  storage: StorageLike,
  key: string,
  payload: BillingDraftPayload,
) {
  storage.setItem(key, JSON.stringify(payload));
}

export function removeBillingDraft(storage: StorageLike, key: string) {
  storage.removeItem(key);
}
