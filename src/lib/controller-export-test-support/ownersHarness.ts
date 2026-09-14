import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { ControllerExportReadSession, ControllerExportQuery } from "../../server/controller-exports/eligibilityRepository";

/** Execute real focused owners; only the server-only poison pill is neutralized. */
export function loadControllerOwner<T>(relative: string): T {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const root = resolve(process.cwd(), "src");
  function load(filename: string): Record<string, unknown> {
    const cached = cache.get(filename); if (cached) return cached.exports;
    const loadedModule = { exports: {} }; cache.set(filename, loadedModule);
    const localRequire = createRequire(filename);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    const requireDependency = (name: string): unknown => {
      if (name === "server-only") return {};
      if (name.startsWith(".")) {
        const candidate = resolve(dirname(filename), name);
        if (candidate.startsWith(`${root}/`) && existsSync(`${candidate}.ts`)) return load(`${candidate}.ts`);
      }
      return localRequire(name);
    };
    new Function("module", "exports", "require", code)(loadedModule, loadedModule.exports, requireDependency);
    return loadedModule.exports;
  }
  // Test module interface assertion, not a database/provider result cast.
  return load(resolve(process.cwd(), relative)) as T;
}

export type RecordedExportQuery = { table: string; fields: string; filters: { operator: "eq" | "is" | "in"; column: string; value: unknown }[];
  orders: { column: string; ascending: boolean }[]; range?: [number, number]; signal?: AbortSignal; retry?: false; count?: "exact"; head?: true };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function field(row: unknown, column: string): unknown {
  if (!record(row)) return undefined;
  const [name, jsonField] = column.split("->>");
  if (jsonField) return record(row[name]) ? row[name][jsonField] : undefined;
  const [relation, nested] = column.split(".");
  return nested && record(row[relation]) ? row[relation][nested] : row[column];
}

/** Independent query model with no default network/database fallthrough. */
export function exportQueryFake(tables: Readonly<Record<string, readonly unknown[]>>, intercept?: (query: RecordedExportQuery, dispatch: number) => unknown) {
  const queries: RecordedExportQuery[] = [];
  let dispatches = 0;
  const session: ControllerExportReadSession = { from: table => ({ select: (fields, options) => {
    const recorded: RecordedExportQuery = { table, fields, filters: [], orders: [], ...options };
    queries.push(recorded);
    const query: ControllerExportQuery = {
      eq(column, value) { recorded.filters.push({ operator: "eq", column, value }); return query; },
      is(column, value) { recorded.filters.push({ operator: "is", column, value }); return query; },
      in(column, value) { recorded.filters.push({ operator: "in", column, value }); return query; },
      order(column, options) { recorded.orders.push({ column, ascending: options.ascending }); return query; },
      range(from, to) { recorded.range = [from, to]; return query; },
      abortSignal(signal) { recorded.signal = signal; return query; },
      retry(enabled) { recorded.retry = enabled; return query; },
      then(resolveResult, rejectResult) {
        const run = async (): Promise<unknown> => {
          dispatches += 1;
          const injected = intercept?.(recorded, dispatches);
          if (injected !== undefined) return injected;
          recorded.signal?.throwIfAborted();
          let rows = [...(tables[table] ?? [])].filter(row => recorded.filters.every(filter => {
            const value = field(row, filter.column);
            const uuidColumn = ["invoice_id", "contractor_id", "batch_id"].includes(filter.column) || filter.column === "id" && table !== "work_orders";
            const normalize = (input: unknown) => uuidColumn && typeof input === "string" ? input.toLowerCase() : input;
            return filter.operator === "in" ? Array.isArray(filter.value) && filter.value.some(item => normalize(item) === normalize(value)) : normalize(value) === normalize(filter.value);
          }));
          rows.sort((a, b) => {
            for (const order of recorded.orders) {
              const left = field(a, order.column); const right = field(b, order.column);
              const difference = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
              if (difference) return order.ascending ? difference : -difference;
            }
            return 0;
          });
          if (recorded.head) return { data: null, error: null, count: rows.length };
          if (recorded.range) rows = rows.slice(recorded.range[0], recorded.range[1] + 1);
          return { data: rows, error: null };
        };
        return run().then(resolveResult, rejectResult);
      },
    };
    return query;
  } }) };
  return { session, queries, dispatchCount: () => dispatches };
}

export const exportTestId = (index: number) => `95100000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export const exportInvoiceRow = (index: number, changes: Record<string, unknown> = {}) => ({
  id: exportTestId(index), num: `INV-${700000 + index}`, work_order_id: "WOT900001-2", contractor_id: exportTestId(900),
  store_number: "42", store_address: "Synthetic Store", invoice_date: "2026-09-12", service_date: "2026-09-11", due_date: "2026-10-12",
  terms: "Net 30", cme: null, subtotal: 123.45, sales_tax: 6.55, total: 130, pdf_storage_path: null,
  updated_at: "2026-09-12T00:00:00.000Z", state: "approved", invoice_type: "contractor", deleted_at: null, qbo_synced_at: null, qbo_invoice_id: null,
  ...changes,
});
