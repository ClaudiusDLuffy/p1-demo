import { AppError } from "../errors/AppError";

export type ExactCountResult = { totalCount: number; aggregates?: Record<string, number> };
export const COUNT_FRESHNESS_DESCRIPTION = "Exact at the last successful refresh; may be stale. Refreshed on relevant updates and stale view activation (30-second freshness window).";

export function parseExactCount(value: unknown): ExactCountResult {
  const row: unknown = typeof value === "string" ? parseJson(value) : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new AppError("INTERNAL_ERROR");
  const data = row as Record<string, unknown>;
  if (typeof data.totalCount !== "number" || !Number.isSafeInteger(data.totalCount) || data.totalCount < 0) {
    throw new AppError("INTERNAL_ERROR");
  }
  const result: ExactCountResult = { totalCount: data.totalCount };
  if (data.aggregates !== undefined && data.aggregates !== null) {
    if (typeof data.aggregates !== "object" || Array.isArray(data.aggregates)) throw new AppError("INTERNAL_ERROR");
    const aggregates: Record<string, number> = {};
    for (const [key, entry] of Object.entries(data.aggregates)) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) throw new AppError("INTERNAL_ERROR");
      aggregates[key] = entry;
    }
    result.aggregates = aggregates;
  }
  return result;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new AppError("INTERNAL_ERROR"); }
}
