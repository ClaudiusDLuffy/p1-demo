export type VerifiedLocationTaxRate = {
  id: string;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceName: string;
  sourceVersion: string;
  sourceUrl: string;
  jurisdictions: Array<Record<string, unknown>>;
};

export function postalCodeFromAddress(value: unknown): string {
  const match = String(value || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return match?.[1] || "";
}

export function mapVerifiedLocationTaxRate(
  value: unknown,
): VerifiedLocationTaxRate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rate = Number(row.rate);
  if (
    typeof row.id !== "string"
    || !row.id
    || !Number.isFinite(rate)
    || rate < 0
    || rate > 1
  ) return null;

  return {
    id: row.id,
    rate,
    effectiveFrom: String(row.effectiveFrom || row.effective_from || ""),
    effectiveTo: row.effectiveTo == null && row.effective_to == null
      ? null
      : String(row.effectiveTo || row.effective_to),
    sourceName: String(row.sourceName || row.source_name || "Texas Comptroller"),
    sourceVersion: String(row.sourceVersion || row.source_version || ""),
    sourceUrl: String(row.sourceUrl || row.source_url || ""),
    jurisdictions: Array.isArray(row.jurisdictions)
      ? row.jurisdictions.filter(item => Boolean(item) && typeof item === "object") as Array<Record<string, unknown>>
      : [],
  };
}

