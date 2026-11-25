import type { CursorPage } from "../../lib/cursorPagination";

/** Explicit close-out preflight only, never a list-screen/background collector.
 * A partial, looping, or interrupted traversal must never mean "checked". */
export async function collectCloseOutEvidencePages<T extends { id: string }>(
  read: (cursor: string | null) => Promise<Pick<CursorPage<T>, "items" | "hasMore" | "nextCursor">>,
  signal: AbortSignal,
): Promise<T[]> {
  const items: T[] = []; const ids = new Set<string>(); const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    signal.throwIfAborted();
    const page = await read(cursor);
    signal.throwIfAborted();
    if (!Array.isArray(page.items) || page.items.length > 100 || typeof page.hasMore !== "boolean") {
      throw new Error("History could not be checked completely.");
    }
    for (const item of page.items) {
      if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)) {
        throw new Error("History changed while loading. Retry the close-out check.");
      }
      ids.add(item.id); items.push(item);
    }
    if (!page.hasMore) {
      if (page.nextCursor !== null) throw new Error("History could not be checked completely.");
      return items;
    }
    if (!page.items.length || typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 8192 || cursors.has(page.nextCursor)) {
      throw new Error("History could not be checked completely.");
    }
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error("This history needs further review before closing. No changes were made.");
}
