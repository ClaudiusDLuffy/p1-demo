import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest } from "next/server";
import { configurationFixture } from "./config-test-support/runtimeConfig";

// Synthetic ports execute the real route handlers. No HTTP/database service is contacted.
export const financialTestIds = {
  actor: "76000000-0000-4000-8000-000000000001",
  invoice: "76000000-0000-4000-8000-000000000002",
  operation: "76000000-0000-4000-8000-000000000003",
};
export const validBillingRequest = () => ({
  operationId: financialTestIds.operation, expectedInvoiceVersion: null,
  workOrderId: "WOTSYNTHETIC", expectedAssignmentVersion: 0, expectedWorkflowCycle: 0,
  num: "P1-SYNTHETIC", userTypedNum: true, state: "draft", territory: "Texas",
  equipmentTag: "7-ELEVEN: Ice", storeNumber: "123", storeAddress: "Synthetic address",
  invoiceDate: "2026-09-08", serviceDate: "2026-09-08", terms: "Net 30",
  taxState: "TX", salesTaxOverride: 0, sourceInvoiceIds: [],
  lines: [{ type: "Labor", desc: "Synthetic work", qty: 1, rate: 10, isTaxable: false }],
});
type Row = Record<string, unknown>;
type PortResult = { data: unknown; error: unknown };
type Handler = (request: Request) => Promise<Response>;
export function billingRouteHarness(options: { controller?: boolean; auditFailure?: boolean; contractor?: boolean;
  active?: boolean; role?: string; externalRoot?: string; commandResultOverride?: Row;
  commandError?: { code: string; message: string }; pageResult?: unknown; countResult?: unknown;
  readError?: { code: string; message: string }; authFailure?: boolean;
  missingProfile?: boolean; profileError?: boolean; permissionError?: boolean; staffPermissions?: readonly string[];
  loggingFailure?: boolean;
  compactRpc?: (name: string, payload: Row) => PortResult | undefined;
  tableRows?: Readonly<Record<string, readonly Row[]>> } = {}) {
  const calls: { name: string; payload?: unknown }[] = [];
  const logs: string[] = [];
  const invoice: Row = { id: financialTestIds.invoice, num: "P1-SYNTHETIC", state: "draft",
    invoice_type: options.contractor ? "contractor" : "staff", invoice_version: 1,
    work_order_id: "WOTSYNTHETIC", subtotal: 10, sales_tax: 0, total: 10,
    invoice_date: "2026-09-08", service_date: "2026-09-08", deleted_at: null };
  let committedLineCount = 0;
  let committedSourceCount = 0;
  class Query implements PromiseLike<PortResult> {
    private singleRow = false;
    private mutation: Row | null = null;
    private filters: ((row: Row) => boolean)[] = [];
    private pageRange: { from: number; to: number } | null = null;
    private orders: { column: string; ascending: boolean }[] = [];
    constructor(private table: string) { calls.push({ name: `from:${table}` }); }
    select(fields?: string) { calls.push({ name: `select:${this.table}`, payload: fields }); return this; }
    private equal(column: string, left: unknown, right: unknown) {
      // PostgreSQL UUID columns compare parsed identity, not input letter case.
      // Work-order IDs are TEXT and intentionally remain case-sensitive.
      const uuidColumns: Record<string, readonly string[]> = {
        invoices: ["id", "contractor_id", "source_capital_quote_id"],
        invoice_lines: ["id", "invoice_id", "source_invoice_line_id", "source_work_order_part_id"],
        staff_invoice_sources: ["id", "staff_invoice_id", "contractor_invoice_id"],
        profiles: ["id"], staff_permission_grants: ["profile_id"],
      };
      return uuidColumns[this.table]?.includes(column) && typeof left === "string" && typeof right === "string"
        ? left.toLowerCase() === right.toLowerCase() : left === right;
    }
    eq(column: string, value: unknown) { this.filters.push(row => this.equal(column, row[column], value)); return this; }
    neq() { return this; }
    is(column: string, value: unknown) { this.filters.push(row => row[column] === value); return this; }
    in(column: string, values: readonly unknown[]) { this.filters.push(row => values.some(value => this.equal(column, row[column], value))); return this; }
    order(column: string, options: { ascending?: boolean } = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
    range(from: number, to: number) { this.pageRange = { from, to }; calls.push({ name: `range:${this.table}`, payload: { from, to } }); return this; }
    limit() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    abortSignal(signal: AbortSignal) { calls.push({ name: `signal:${this.table}`, payload: signal }); signal.throwIfAborted(); return this; }
    update(payload: Row) { this.mutation = payload; calls.push({ name: `update:${this.table}`, payload }); return this; }
    insert(payload: Row) { this.mutation = payload; calls.push({ name: `insert:${this.table}`, payload }); return this; }
    then<TResult1 = PortResult, TResult2 = never>(
      fulfilled?: ((value: PortResult) => TResult1 | PromiseLike<TResult1>) | null,
      rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      let rows: Row[] = [];
      if (this.table === "profiles") rows = options.missingProfile ? [] : [{ id: financialTestIds.actor, role: options.role ?? "manager", name: "Synthetic Staff", active: options.active !== false }];
      if (this.table === "staff_permission_grants") rows = [...(options.staffPermissions ?? []), ...(options.controller ? ["invoice_controller"] : [])]
        .map(permission => ({ profile_id: financialTestIds.actor, permission }));
      if (this.table === "invoices") {
        if (this.mutation) Object.assign(invoice, this.mutation);
        rows = [invoice];
      }
      if (this.table === "work_orders") rows = [{ id: "WOTSYNTHETIC", duplicate_root_work_order_id: options.externalRoot || null, store_state: "TX", contractor_assignment_version: 0, workflow_cycle: 0 }];
      if (this.table === "invoice_lines") rows = [{ id: financialTestIds.operation, invoice_id: invoice.id, position: 1, type: "Labor", description: "Synthetic work", qty: 1, rate: 10, amount: 10 }];
      // Opt-in read fixtures model the actual parent-ID filters. Legacy
      // command fixtures and their mutation expectations are unchanged.
      if (options.tableRows?.[this.table]) rows = options.tableRows[this.table]
        .filter(row => this.filters.every(matches => matches(row)));
      rows = rows.filter(row => this.filters.every(matches => matches(row)));
      if (this.orders.length) rows = [...rows].sort((a, b) => {
        for (const order of this.orders) {
          const left = a[order.column]; const right = b[order.column];
          const comparison = typeof left === "number" && typeof right === "number"
            ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
          if (comparison) return order.ascending ? comparison : -comparison;
        }
        return 0;
      });
      if (this.pageRange) rows = rows.slice(this.pageRange.from, this.pageRange.to + 1);
      const error = (this.table === "profiles" && options.profileError) || (this.table === "staff_permission_grants" && options.permissionError)
        ? { code: "42501", message: "Synthetic profile/permission lookup failure" }
        : this.table === "activities" && this.mutation && options.auditFailure
        ? { code: "23514", message: "Synthetic audit constraint failure" } : null;
      return Promise.resolve({ data: this.singleRow ? rows[0] || null : rows, error }).then(fulfilled, rejected);
    }
  }
  const executeRpc = async (name: string, payload: Row) => {
    calls.push({ name: `rpc:${name}`, payload });
    const compact = options.compactRpc?.(name, payload);
    if (compact) return compact;
    if (name === "list_billable_p1_parts") return { data: [], error: null };
    if (name === "list_staff_invoices_page" || name === "list_staff_invoices_rows_v1" || name === "list_staff_invoices_rows_v2") {
      const supplied = options.pageResult ?? { items: [], hasMore: false, nextCursor: null, totalCount: name === "list_staff_invoices_page" ? 0 : null };
      // The real SQL page contains headers, never lines/source documents or
      // application-computed margins. Production repositories must load facts.
      return { data: supplied, error: options.readError ?? null };
    }
    if (name === "count_staff_invoices_v1") return { data: options.countResult ?? { totalCount: 12 }, error: options.readError ?? null };
    if (name === "get_invoice_summary_v1") return { data: {
      projection: "summary", ...invoice, invoice_version: invoice.invoice_version,
      review_revision: 1, line_count: committedLineCount, source_count: committedSourceCount,
      contractor_assignment_version: invoice.work_order_id === null ? null : 0,
      workflow_cycle: invoice.work_order_id === null ? null : 0,
      external_work_order_id: options.externalRoot || null,
    }, error: options.readError ?? null };
    if (name === "get_invoice_source_summaries_v1") return { data: { invoices: [] }, error: options.readError ?? null };
    if (name === "list_invoice_lines_page_v1") return { data: { invoiceVersion: invoice.invoice_version, items: [], hasMore: false, nextCursor: null }, error: options.readError ?? null };
    if (name.includes("staff_invoice_num")) return { data: "P1-SYNTHETIC", error: null };
    if (options.commandError) return { data: null, error: options.commandError };
    if (name === "mark_staff_invoice_ready") {
      invoice.state = "submitted";
      return { data: { invoiceId: financialTestIds.invoice, state: "submitted", transitioned: true, ...options.commandResultOverride }, error: null };
    }
    if (name === "mark_staff_invoice_billed") {
      invoice.state = "submitted";
      return { data: { applied: true, reason: "billed", invoiceId: financialTestIds.invoice, documentKind: "invoice",
        workOrderId: invoice.work_order_id, transitioned: true, workOrderClosed: true,
        pendingCapitalCompletion: false, workOrderStatus: "closed", visitsClosed: 1, ...options.commandResultOverride }, error: null };
    }
    if (name === "save_staff_billing_invoice_v4") {
      const command = payload.p_payload as Row;
      // Model the same committed document counts independently in both SQL
      // responses. A successful refresh must not invent an empty document.
      committedLineCount = Array.isArray(command.lines) ? command.lines.length : 0;
      committedSourceCount = Array.isArray(command.sourceInvoiceIds) ? command.sourceInvoiceIds.length : 0;
      Object.assign(invoice, { work_order_id: payload.p_work_order_id, state: command.state, invoice_version: 2,
        store_number: command.storeNumber, territory: command.territory });
      return { data: { applied: true, reason: "applied", invoiceId: financialTestIds.invoice,
        invoiceNum: "P1-SYNTHETIC", invoiceVersion: 2, operationId: payload.p_operation_id,
        workOrderId: payload.p_work_order_id, assignmentVersion: payload.p_expected_assignment_version,
        workflowCycle: payload.p_expected_workflow_cycle, state: command.state,
        subtotal: 10, salesTax: 0, total: 10,
        lineCount: committedLineCount,
        sourceInvoiceCount: committedSourceCount,
        activityId: payload.p_work_order_id === null ? null : financialTestIds.operation,
        ...options.commandResultOverride }, error: null };
    }
    if (name === "delete_invoice_admin_v1") {
      if (options.auditFailure) return { data: null, error: { code: "23514", message: "Sensitive synthetic database detail /private/internal" } };
      invoice.deleted_at = "2026-09-08T10:00:00Z";
      return { data: { applied: true, reason: "applied", invoiceId: financialTestIds.invoice,
        invoiceNum: "P1-SYNTHETIC", invoiceVersion: 2, operationId: payload.p_operation_id,
        workOrderId: invoice.work_order_id, assignmentVersion: 0, workflowCycle: 0,
        activityId: invoice.work_order_id === null ? null : financialTestIds.operation,
        deletedAt: invoice.deleted_at, invoiceType: payload.p_invoice_type, ...options.commandResultOverride }, error: null };
    }
    return { data: financialTestIds.invoice, error: null };
  };
  const sb = { from: (table: string) => new Query(table), rpc: (name: string, payload: Row) => {
    const result = executeRpc(name, payload);
    return Object.assign(result, { abortSignal: (signal: AbortSignal) => { calls.push({ name: `signal:rpc:${name}`, payload: signal }); signal.throwIfAborted(); return result; } });
  } };
  // Compile the actual route, dispatcher and method boundaries with only
  // instance-scoped I/O ports. No replacement HTTP/correlation implementation.
  const routePath = `src/app/api/${options.contractor ? "contractor-invoices" : "billing-invoices"}/route.ts`;
  const filename = options.contractor ? resolve(routePath) : resolve("src/server/billing-invoices/patchBillingInvoice.ts");
  const requireHere = createRequire(import.meta.url);
  const runtimeFor = (modulePath: string) => ({ process: { env: {} }, console: { error: () => undefined },
    Date, URL, Request, Response, Headers, TextDecoder, TextEncoder, crypto: globalThis.crypto,
    require: (name: string): unknown => {
      const configuration = configurationFixture(name); if (configuration) return configuration;
      if (name === "@supabase/supabase-js") return { createClient: () => ({ auth: { getUser: async () => {
        calls.push({ name: "auth" }); return { data: { user: options.authFailure ? null : { id: financialTestIds.actor } }, error: null };
      } } }) };
      if (name === "next/server") return { NextResponse: Response };
      if (name.endsWith("/supabase/server")) return { createServerClient: () => sb };
      if (name === "server-only") return {};
      if (name.endsWith("/observability/safeLogger")) {
        const actual: typeof import("./observability/safeLogger") = requireHere(resolve(modulePath, "..", name));
        return { ...actual, logBoundaryFailure: (context: Parameters<typeof actual.logBoundaryFailure>[0], cause: unknown) =>
          actual.logBoundaryFailure(context, cause, line => { logs.push(line); if (options.loggingFailure) throw new Error("Synthetic logging failure"); }) };
      }
      if (name.endsWith("/server/staffAuthorization") || name.endsWith("/billingReadContext") || name.endsWith("/billingMutationContext")) {
        return loadRuntimeModule(resolve(modulePath, "..", `${name}.ts`));
      }
      if (name.endsWith("/errors/httpBoundary") || /\/(applicationService|postBillingInvoice|patchBillingInvoice|deleteBillingInvoice)$/.test(name)) {
        return loadRuntimeModule(resolve(modulePath, "..", `${name}.ts`));
      }
      if (!name.startsWith(".")) return requireHere(name);
      return requireHere(resolve(modulePath, "..", name));
    },
  });
  const compile = (modulePath: string, moduleExports: Record<string, unknown>) => {
    const compiled = ts.transpileModule(readFileSync(modulePath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, { ...runtimeFor(modulePath), exports: moduleExports }, { filename: modulePath });
  };
  const modules = new Map<string, Record<string, unknown>>();
  const loadRuntimeModule = (modulePath: string): Record<string, unknown> => {
    const existing = modules.get(modulePath);
    if (existing) return existing;
    const output: Record<string, unknown> = {};
    modules.set(modulePath, output);
    compile(modulePath, output);
    return output;
  };
  const mutationExports: Record<string, unknown> = {};
  compile(filename, mutationExports);
  const exports: Record<string, Handler> = mutationExports as Record<string, Handler>;
  if (!options.contractor) {
    const routeExports: Record<string, unknown> = {};
    compile(resolve(routePath), routeExports);
    for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"]) {
      if (typeof routeExports[method] !== "function") throw new Error(`Missing real billing route ${method}`);
      exports[method] = routeExports[method] as Handler;
    }
  }
  const request = (method: string, body?: unknown, query = "", init: RequestInit = {}) => new NextRequest(`https://synthetic.invalid/api/billing-invoices${query}`, {
    method, headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...init,
    signal: init.signal ?? undefined,
  });
  return { calls, logs, invoice, handlers: exports, request };
}
