const DEFAULT_PAGE_SIZE = 1000;

type SupabasePage<T> = {
  data: T[] | null;
  error: unknown;
};

/**
 * PostgREST limits a response to the project's configured maximum row count
 * (1,000 in production). Fetch every page so older related records do not
 * silently disappear as a table grows beyond that limit.
 */
export async function collectSupabasePages<T>(
  loadPage: (
    from: number,
    to: number,
  ) => PromiseLike<SupabasePage<T>>,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive integer");
  }

  const rows: T[] = [];
  let from = 0;

  while (true) {
    const page = await loadPage(from, from + pageSize - 1);
    if (page.error) throw page.error;

    const pageRows = page.data || [];
    rows.push(...pageRows);

    if (pageRows.length < pageSize) return rows;
    from += pageSize;
  }
}

