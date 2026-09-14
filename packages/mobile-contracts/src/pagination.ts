import { z } from "zod";
import { MobileContractError } from "./errors";
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export type CursorPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean; totalCount: number | null };
export const clampPageSize = (value: unknown, fallback = DEFAULT_PAGE_SIZE): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(parsed))) : fallback;
};
export const cursorPageSchema = <T extends z.ZodType>(item: T) => z.object({
  items: z.array(item).max(MAX_PAGE_SIZE), nextCursor: z.string().min(1).max(8192).nullable(),
  hasMore: z.boolean(), totalCount: z.number().int().nonnegative().nullable().optional(),
  aggregates: z.record(z.string(), z.union([z.number(), z.string()])).optional().nullable(),
}).refine(page => page.hasMore === (page.nextCursor !== null));
export function decodePage(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new MobileContractError("invalid_response"); }
}
