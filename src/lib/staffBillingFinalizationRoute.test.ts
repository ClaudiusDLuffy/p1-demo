import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Row = Record<string, unknown>;
type QueryResult = { data: Row[]; error: unknown };
type RequestPort = { headers: Headers; nextUrl: URL; json(): Promise<unknown> };
const invoiceId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";

// Execute the real route. Only Auth/PostgREST IO is fake; no provider, customer
// record, environment file, or deployed database is used.
function routeHarness(options: {
  rpcError?: unknown;
  rpcThrows?: boolean;
  reloadError?: unknown;
  missingAfterBilling?: boolean;
  active?: boolean;
  role?: string;
  controller?: boolean;
  finalization?: Row;
} = {}) {
  const calls: string[] = [];
  const invoice: Row = { id: invoiceId, invoice_type: "staff", document_kind: "invoice",
    num: "P1-SYNTHETIC", state: "approved", work_order_id: null, deleted_at: null,
    invoice_date: "2026-09-10", total: 0 };
  const rowsFor = (table: string): Row[] => {
    if (table === "profiles") return [{ id: actorId, role: options.role ?? "back_office",
      active: options.active ?? true, name: "Synthetic staff" }];
    if (table === "invoices") return options.missingAfterBilling ? [] : [invoice];
    if (table === "invoice_lines" || table === "staff_invoice_sources") return [];
    throw new Error(`Unexpected fixture table: ${table}`);
  };
  class Query implements PromiseLike<QueryResult> {
    private filters: Array<(row: Row) => boolean> = [];
    constructor(private readonly table: string) {}
    select() { return this; }
    eq(field: string, value: unknown) { this.filters.push(row => row[field] === value); return this; }
    is(field: string, value: unknown) { return this.eq(field, value); }
    order() { return this; }
    range() { return this; }
    private result(): QueryResult {
      calls.push(this.table);
      return { data: rowsFor(this.table).filter(row => this.filters.every(filter => filter(row))),
        error: this.table === "invoices" ? options.reloadError ?? null : null };
    }
    async maybeSingle() { const result = this.result(); return { ...result, data: result.data[0] ?? null }; }
    then<A = QueryResult, B = never>(yes?: ((value: QueryResult) => A | PromiseLike<A>) | null,
      no?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
      return Promise.resolve(this.result()).then(yes, no);
    }
  }
  const database = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Row) => {
      calls.push(name);
      assert.equal(name, "mark_staff_invoice_billed");
      assert.equal(args.p_invoice_id, invoiceId);
      assert.equal(args.p_actor_id, actorId);
      if (options.rpcThrows) throw options.rpcError;
      return { data: options.rpcError ? null : options.finalization ?? {
        applied: true, invoiceId, transitioned: true, workOrderClosed: true,
      }, error: options.rpcError ?? null };
    },
  };
  const filename = resolve("src/app/api/billing-invoices/route.ts");
  const requireHere = createRequire(import.meta.url);
  const exports: { PATCH?: (request: RequestPort) => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Error, process: { env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic",
  } }, require: (name: string): unknown => {
    if (name === "next/server") return { NextResponse: Response };
    if (name === "@supabase/supabase-js") return { createClient: () => ({ auth: {
      getUser: async () => ({ data: { user: { id: actorId } }, error: null }),
    } }) };
    if (name === "../../../lib/supabase/server") return { createServerClient: () => database };
    if (name === "../../../lib/server/staffAuthorization") return {
      STAFF_ROLES: new Set(["manager", "dispatcher", "back_office"]),
      loadStaffPermissions: async () => [], isInvoiceControllerProfile: () => options.controller ?? false,
    };
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  assert.ok(exports.PATCH);
  const patch = exports.PATCH;
  return { calls, request: () => patch({ headers: new Headers({ authorization: "Bearer synthetic" }),
    nextUrl: new URL(`https://synthetic.invalid/api/billing-invoices?id=${invoiceId}`),
    json: async () => ({ action: "mark_billed" }),
  }) };
}

const guards = [
  ["23514", 'new row for relation "work_order_visits" violates check constraint "work_order_visits_checkout_complete"', "BILLING_VISIT_TIME_REVIEW_REQUIRED", 409, /open visit.*check-in time or checkout details.*review/i],
  ["40001", "This billing document belongs to a prior workflow cycle and cannot close the reopened work order", "BILLING_PRIOR_WORKFLOW", 409, /creation date.*missing or predates reopening/i],
  ["23514", "Only a billing document ready for 7-Eleven can be submitted", "BILLING_NOT_READY", 409, /not ready/i],
  ["23514", "Current reopened workflow metadata is missing", "BILLING_WORKFLOW_REVIEW_REQUIRED", 409, /history.*incomplete/i],
  ["23514", "Billing audit state does not match the invoice state", "BILLING_AUDIT_REVIEW_REQUIRED", 409, /do not match/i],
  ["23514", "This work order was closed without additional billing; reopen it before billing another invoice", "BILLING_WORK_ORDER_CLOSED", 409, /closed without additional billing/i],
  ["23514", "Capital quote is not linked to an active capital work order", "BILLING_CAPITAL_LINK_REQUIRED", 409, /active capital work order/i],
  ["42501", "Staff access required", "BILLING_FORBIDDEN", 403, /permission/i],
  ["42501", "Operational staff access required", "BILLING_FORBIDDEN", 403, /permission/i],
  ["P0002", "Billing invoice not found", "BILLING_NOT_FOUND", 404, /not found/i],
] as const;

for (const [code, message, publicCode, status, safeMessage] of guards) {
  test(`mark_billed explains ${publicCode} from a plain PostgREST error without exposing details`, async () => {
    const h = routeHarness({ rpcError: { code, message, details: "PRIVATE-SYNTHETIC-DETAIL", hint: "PRIVATE-SYNTHETIC-HINT" } });
    const response = await h.request();
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, publicCode);
    assert.match(body.error, safeMessage);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SYNTHETIC/);
    assert.deepEqual(h.calls, ["profiles", "mark_staff_invoice_billed"]);
  });
}

test("unknown, altered and thrown provider errors stay safe without an automatic mutation retry", async () => {
  for (const rpcError of [
    { code: "23514", message: "PRIVATE-SYNTHETIC-CONSTRAINT", details: "private" },
    { code: "XX000", message: guards[0][1] },
    { code: "40001", message: `${guards[0][1]} PRIVATE-SYNTHETIC` },
    new Error("PRIVATE-SYNTHETIC-TRANSPORT"), null, "PRIVATE-SYNTHETIC-TEXT",
  ]) {
    const h = routeHarness({ rpcError, rpcThrows: true });
    const response = await h.request();
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, "BILLING_FINALIZATION_UNCONFIRMED");
    assert.match(body.error, /refresh.*before trying again/i);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SYNTHETIC|workflow cycle/);
    assert.equal(h.calls.filter(call => call === "mark_staff_invoice_billed").length, 1);
  }
});

test("a successful transaction followed by reload failure is not reported as a failed billing transaction", async () => {
  for (const options of [
    { reloadError: { message: "PRIVATE-SYNTHETIC-READ-FAILURE" } },
    { missingAfterBilling: true },
    { reloadError: { message: "PRIVATE-SYNTHETIC-READ-FAILURE" }, finalization: { applied: false, reason: "already_billed" } },
    { reloadError: { message: "PRIVATE-SYNTHETIC-READ-FAILURE" }, finalization: { applied: false, reason: "already_submitted" } },
  ]) {
    const h = routeHarness(options);
    const response = await h.request();
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, "BILLING_REFRESH_REQUIRED");
    assert.match(body.error, /confirmed.*refresh/i);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SYNTHETIC/);
    assert.equal(h.calls.filter(call => call === "mark_staff_invoice_billed").length, 1);
  }
});

test("normal, capital and replay billing success retain the invoice/finalization response", async () => {
  for (const finalization of [
    { applied: true, workOrderClosed: true, pendingCapitalCompletion: false },
    { applied: true, workOrderClosed: false, pendingCapitalCompletion: true },
    { applied: false, reason: "already_billed", workOrderClosed: false },
  ]) {
    const h = routeHarness({ finalization });
    const response = await h.request();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.invoice.id, invoiceId);
    assert.deepEqual(body.finalization, finalization);
  }
});

test("billing error handling does not broaden active operational staff authorization", async () => {
  for (const options of [{ active: false }, { role: "contractor" }, { controller: true }]) {
    const h = routeHarness(options);
    assert.equal((await h.request()).status, 403);
    assert.deepEqual(h.calls, ["profiles"]);
  }
});
