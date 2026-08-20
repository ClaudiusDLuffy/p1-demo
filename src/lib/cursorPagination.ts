export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  aggregates?: Record<string, number>;
};

export type CursorPosition = {
  page: number;
  cursor: string | null;
  previousCursors: Array<string | null>;
};

export const clampPageSize = (
  value: unknown,
  fallback = DEFAULT_PAGE_SIZE,
) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(parsed)));
};

export const emptyCursorPage = <T>(): CursorPage<T> => ({
  items: [],
  nextCursor: null,
  hasMore: false,
  totalCount: 0,
});

export const firstCursorPosition = (): CursorPosition => ({
  page: 1,
  cursor: null,
  previousCursors: [],
});

export const nextCursorPosition = (
  position: CursorPosition,
  nextCursor: string | null,
): CursorPosition => {
  if (!nextCursor) return position;
  return {
    page: position.page + 1,
    cursor: nextCursor,
    previousCursors: [...position.previousCursors, position.cursor],
  };
};

export const previousCursorPosition = (
  position: CursorPosition,
): CursorPosition => {
  if (position.page <= 1 || position.previousCursors.length === 0) {
    return firstCursorPosition();
  }
  const previousCursors = position.previousCursors.slice(0, -1);
  return {
    page: position.page - 1,
    cursor: position.previousCursors[position.previousCursors.length - 1] ?? null,
    previousCursors,
  };
};

export const chunkArray = <T>(rows: readonly T[], chunkSize = 100): T[][] => {
  const size = clampPageSize(chunkSize, MAX_PAGE_SIZE);
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
};

/**
 * Runs bulk-only work with a bounded number of chunks in flight. Interactive
 * list screens should use cursor pages instead of this helper.
 */
export async function mapChunksWithConcurrency<T, R>(
  chunks: readonly T[],
  worker: (chunk: T, index: number) => Promise<R>,
  concurrency = 3,
): Promise<R[]> {
  if (chunks.length === 0) return [];
  const width = Math.min(Math.max(1, Math.trunc(concurrency)), chunks.length);
  const results = new Array<R>(chunks.length);
  let nextIndex = 0;

  const run = async () => {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(chunks[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, run));
  return results;
}
