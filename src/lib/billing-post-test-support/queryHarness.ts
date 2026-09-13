export type BillingQueryResult = { data: unknown; error: unknown };
export type BillingRecordedQuery = {
  table: string;
  projection: string | null;
  filters: { operator: "eq" | "in" | "is"; column: string; value: unknown }[];
  order: { column: string; ascending: boolean }[];
  single: boolean;
  signal: AbortSignal | null;
};

/** A wire-result recorder, not a production repository or hidden database fixture. */
export function billingQueryHarness(
  results: readonly BillingQueryResult[],
  onRead?: (query: BillingRecordedQuery, index: number) => void,
) {
  const queries: BillingRecordedQuery[] = [];
  let dispatched = 0;
  class Query implements Promise<BillingQueryResult> {
    readonly [Symbol.toStringTag] = "Promise";
    constructor(private readonly record: BillingRecordedQuery) {}
    select(projection: string) { this.record.projection = projection; return this; }
    eq(column: string, value: unknown) { this.record.filters.push({ operator: "eq", column, value }); return this; }
    in(column: string, value: readonly unknown[]) { this.record.filters.push({ operator: "in", column, value }); return this; }
    is(column: string, value: unknown) { this.record.filters.push({ operator: "is", column, value }); return this; }
    order(column: string, options: { ascending: boolean }) { this.record.order.push({ column, ...options }); return this; }
    maybeSingle() { this.record.single = true; return this; }
    abortSignal(signal: AbortSignal) { this.record.signal = signal; return this; }
    private async execute(): Promise<BillingQueryResult> {
      this.record.signal?.throwIfAborted();
      const index = dispatched++;
      onRead?.(this.record, index);
      this.record.signal?.throwIfAborted();
      const result = results[index];
      if (!result) throw new Error(`Missing explicit synthetic query result ${index}`);
      return result;
    }
    then<T = BillingQueryResult, R = never>(
      fulfilled?: ((value: BillingQueryResult) => T | PromiseLike<T>) | null,
      rejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
    ): Promise<T | R> { return this.execute().then(fulfilled, rejected); }
    catch<R = never>(rejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<BillingQueryResult | R> {
      return this.execute().catch(rejected);
    }
    finally(settled?: (() => void) | null): Promise<BillingQueryResult> { return this.execute().finally(settled); }
  }
  const session = {
    from(table: string) {
      const record: BillingRecordedQuery = { table, projection: null, filters: [], order: [], single: false, signal: null };
      queries.push(record);
      return new Query(record);
    },
  };
  return { session, queries, dispatchCount: () => dispatched };
}
