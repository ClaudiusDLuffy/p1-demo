import { AppError } from "../../lib/errors/AppError";

export const LIST_EXPORT_ROW_LIMIT = 10_000;
export const LIST_EXPORT_BYTE_LIMIT = 10 * 1024 * 1024;
export class ListExportLimitError extends Error {
  constructor(message = "This export exceeds 10,000 records. Narrow the filters and try again. No partial file was downloaded.") {
    super(message); this.name = "ListExportLimitError";
  }
}
export type ExportPage<T> = { items: readonly T[]; hasMore: boolean; nextCursor: string | null };

/** Explicit list download, never a background bulk read or an accounting handoff. */
export async function collectListExport<T extends { id: string }>(
  read: (cursor: string | null, signal: AbortSignal) => Promise<ExportPage<T>>,
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<T[]> {
  const rows = new Map<string, T>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
    signal.throwIfAborted();
    const page = await read(cursor, signal);
    signal.throwIfAborted();
    if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") throw new AppError("INTERNAL_ERROR");
    for (const row of page.items) {
      if (typeof row.id !== "string" || !row.id) throw new AppError("INTERNAL_ERROR");
      // Preserve first-seen order and values when a live record moves across pages.
      if (!rows.has(row.id)) rows.set(row.id, row);
    }
    if (rows.size > LIST_EXPORT_ROW_LIMIT) throw new ListExportLimitError();
    onProgress(rows.size);
    if (!page.hasMore) return [...rows.values()];
    if (!page.items.length || !page.nextCursor || cursors.has(page.nextCursor)) throw new AppError("INTERNAL_ERROR");
    if (rows.size === LIST_EXPORT_ROW_LIMIT) throw new ListExportLimitError();
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new AppError("INTERNAL_ERROR");
}

export function downloadListCsv(csv: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  try {
    link.href = url; link.download = fileName;
    document.body.appendChild(link); link.click();
  } finally {
    link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
