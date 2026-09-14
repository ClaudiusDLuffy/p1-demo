import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextRequest } from "next/server";
import { FinancialNoticeError } from "../features/financial-notifications/contracts";
import { parsePaymentHoldPage, parsePaymentHoldQuery, paymentHoldReadError, type PaymentHold } from "./paymentHoldPagination";
import { financialHttpError, financialRpcError, readFinancialRequest } from "./server/financialNotificationHttp";

const actor = "40000000-0000-4000-8000-000000000001";
const hold: PaymentHold = { invoiceId: "60000000-0000-4000-8000-000000000001", invoiceNumber: "SYNTHETIC-1",
  workOrderId: "WOT-SYNTHETIC-CHILD", externalWorkOrderId: "WOT-SYNTHETIC-ROOT", contractorName: "Synthetic company",
  total: 123.45, holdAt: "2026-01-01T00:00:00.123456+00:00", holdBy: actor, holdByName: "Synthetic staff", reason: "Synthetic reason" };
const page = (size = 25) => ({ holds: [hold], canRelease: true, pageSize: size, hasMore: false, nextCursor: null });
const code = (expected: string) => (error: unknown) => error instanceof FinancialNoticeError && error.code === expected;
const requireHere = createRequire(import.meta.url);
function compile<T>(path: string, replacements: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const filename = resolve(path); const exports = {};
  const output = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(output, { exports, AbortSignal, Buffer, URLSearchParams, Headers, URL, Response, Map, Set, Date, Promise,
    setTimeout, clearTimeout, ...globals,
    require: (name: string) => Object.hasOwn(replacements, name) ? replacements[name]
      : requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name) }, { filename });
  return exports as T; // The fixture owns the VM CommonJS export boundary.
}

test("hold query preserves default100, explicit1/25/100 and opaque position", () => {
  assert.deepEqual(parsePaymentHoldQuery(new URLSearchParams()), { p_limit: 100, p_cursor: null });
  for (const limit of [1, 25, 100]) assert.deepEqual(parsePaymentHoldQuery(new URLSearchParams(`limit=${limit}&cursor=YWJj`)), { p_limit: limit, p_cursor: "YWJj" });
});
for (const input of ["limit=", "limit=0", "limit=-1", "limit=101", "limit=1.5", "limit=01", "limit=1e2", "limit=NaN", "limit=Infinity", "limit=%2025", "limit=%2B25", "limit=25&limit=25", "cursor=a&cursor=b", "offset=25", "actorId=x", "pageSize=25"]) {
  test(`hold query rejects noncanonical or unsupported parameters: ${input}`, () => {
    assert.throws(() => parsePaymentHoldQuery(new URLSearchParams(input)), code("VALIDATION_FAILED"));
  });
}
for (const cursor of ["", "a+b", "a b", "a=", "x".repeat(4097)]) {
  test(`hold cursor transport validation rejects malformed input of length${cursor.length}`, () => {
    assert.throws(() => parsePaymentHoldQuery(new URLSearchParams({ cursor })), code("INVALID_CURSOR"));
  });
}
test("hold page validates bounded metadata while preserving all legacy fields and microseconds", () => {
  assert.deepEqual(parsePaymentHoldPage(page(), 25), page());
  const legacy = { ...hold, invoiceNumber: "n".repeat(2000), reason: "r".repeat(2000), workOrderId: null, externalWorkOrderId: null };
  assert.deepEqual(parsePaymentHoldPage({ ...page(), holds: [legacy] }, 25).holds[0], legacy);
  for (const invalid of [{ ...page(), holds: Array(26).fill(hold) }, { ...page(), pageSize: 100 },
    { ...page(), hasMore: true }, { ...page(), nextCursor: "YWJj" }, { ...page(), holds: [hold, hold] },
    { ...page(), holds: [{ ...hold, total: Infinity }] }, { ...page(), privateProviderBody: "hidden" }]) {
    assert.throws(() => parsePaymentHoldPage(invalid, 25), code("RESULT_UNCONFIRMED"));
  }
});
test("hold read classification trusts local errors and explicit SQLSTATE, never database prose", () => {
  assert.equal(paymentHoldReadError({ code: "PDC01", message: "private SQL" }).code, "INVALID_CURSOR");
  assert.equal(paymentHoldReadError({ code: "unknown", message: "INVALID_CURSOR", details: "FORBIDDEN" }).code, "RESULT_UNCONFIRMED");
});

function routeHarness() {
  let denied: number | null = null; let data: unknown; let dbError: unknown = null;
  const calls: { name: string; args: { p_limit: number; p_cursor: string | null }; signal: AbortSignal }[] = [];
  const route = compile<{ GET: (request: NextRequest) => Promise<Response> }>("src/app/api/contractor-invoice-holds/route.ts", {
    "../../../lib/server/financialNotificationHttp": { financialHttpError, financialRpcError, readFinancialRequest,
      authorizeFinancialRequest: async (_request: NextRequest, allowController: boolean) => {
        assert.equal(allowController, true);
        return denied ? { error: financialHttpError(denied === 401 ? "AUTH_REQUIRED" : "FORBIDDEN", "private auth", denied) }
          : { caller: { rpc: (name: string, args: { p_limit: number; p_cursor: string | null }) => ({
            abortSignal: async (signal: AbortSignal) => { calls.push({ name, args, signal }); return { data: data ?? page(args.p_limit), error: dbError }; },
          }) }, canRelease: true };
      } },
  });
  const request = (query = "", signal?: AbortSignal) => route.GET(new NextRequest(`http://synthetic.invalid/api/contractor-invoice-holds${query}`, {
    headers: { "x-request-id": "12345678-1234-4123-8123-123456789012" }, signal,
  }));
  return { request, calls, deny: (status: number) => { denied = status; }, fail: (error: unknown) => { dbError = error; }, malformed: (value: unknown) => { data = value; } };
}
test("hold GET uses caller RPC, exact additive page contract, no-store and correlation", async () => {
  const h = routeHarness();
  for (const [query, size] of [["", 100], ["?limit=25", 25]] as const) {
    const response = await h.request(query); assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("x-request-id"), "12345678-1234-4123-8123-123456789012");
    assert.deepEqual(await response.json(), page(size));
  }
  assert.ok(h.calls.every(call => call.name === "list_contractor_invoice_payment_holds_page_v1"));
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args)), { p_limit: 100, p_cursor: null });
});
test("hold GET rejects malformed input before RPC and authenticates before parsing", async () => {
  const h = routeHarness(); assert.equal((await h.request("?limit=101")).status, 400); assert.equal(h.calls.length, 0);
  h.deny(401); assert.equal((await h.request("?limit=101")).status, 401); assert.equal(h.calls.length, 0);
  h.deny(403); assert.equal((await h.request()).status, 403);
});
test("hold GET forwards caller cancellation and refuses raw/malformed upstream output", async () => {
  const h = routeHarness(); const controller = new AbortController();
  await h.request("?limit=25&cursor=YWJj", controller.signal); controller.abort(); assert.ok(h.calls[0].signal.aborted);
  assert.equal(h.calls[0].args.p_cursor, "YWJj");
  for (const [error, status, expectedCode] of [[{ code: "PDC01", message: "private@secret.invalid SELECT" }, 400, "INVALID_CURSOR"],
    [{ message: "private@secret.invalid SELECT" }, 503, "RESULT_UNCONFIRMED"]] as const) {
    const failing = routeHarness(); failing.fail(error); const response = await failing.request();
    assert.equal(response.status, status); const body = await response.json(); assert.equal(body.code, expectedCode);
    assert.ok(body.correlationId); assert.doesNotMatch(JSON.stringify(body), /private|SELECT|@/);
  }
  h.malformed({ holds: [hold], canRelease: true }); assert.equal((await h.request()).status, 503);
});

test("durable original route reproduction:1001 eligible holds are truncated to100 without continuation", async () => {
  type Row = Record<string, unknown>;
  const ids = Array.from({ length: 1001 }, (_, i) => `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  const rows: Record<string, Row[]> = {
    contractor_invoice_payment_holds: ids.map(invoice_id => ({ invoice_id, placed_at: hold.holdAt, placed_by: actor, reason: hold.reason })),
    invoices: ids.map(id => ({ id, num: id, work_order_id: null, contractor_id: null, total: 1, invoice_type: "contractor", deleted_at: null })),
    profiles: [{ id: actor, name: "Synthetic staff" }], work_orders: [],
  };
  const sb = { from: (table: string) => {
    const predicates: ((row: Row) => boolean)[] = []; let limit = 1000;
    const chain = { select: () => chain, order: () => chain,
      limit: (value: number) => { limit = Math.min(value, 1000); return chain; },
      eq: (key: string, value: unknown) => { predicates.push(row => row[key] === value); return chain; },
      is: (key: string, value: unknown) => { predicates.push(row => row[key] === value); return chain; },
      in: (key: string, values: unknown[]) => { predicates.push(row => values.includes(row[key])); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table].filter(row => predicates.every(fn => fn(row))).slice(0, limit), error: null }).then(resolve),
    }; return chain;
  } };
  const baseline = compile<{ GET: (request: NextRequest) => Promise<Response> }>("src/lib/financial-notification-test-support/holds-route.fixture", {
    "../../../lib/server/staffAuthorization": { requireStaffRequest: async () => ({ sb, profile: {} }), canHandoffQuickBooksProfile: () => true },
    "../../../lib/notificationService": {},
  });
  const result = await (await baseline.GET(new NextRequest("http://synthetic.invalid/holds"))).json();
  assert.equal(result.holds.length, 100); assert.equal(result.nextCursor, undefined); assert.equal(result.hasMore, undefined);
});

type Element = { type: unknown; props: Record<string, unknown> };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("type" in value) || !("props" in value)) return [];
  const node = value as Element; return [node, ...elements(node.props.children)];
}
function uiHarness() {
  const states: unknown[] = []; let index = 0;
  const react = { useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
    useRef: (value: unknown) => { const key = index++; states[key] ??= { current: value }; return states[key]; },
    useState: (initial: unknown) => { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
      return [states[key], (value: unknown) => { states[key] = typeof value === "function" ? value(states[key]) : value; }]; },
  };
  type Query = { queryKey: unknown[]; queryFn: (input: { signal: AbortSignal }) => Promise<unknown>; enabled?: boolean };
  type Result = { data?: unknown; error?: Error; isLoading?: boolean; isFetching?: boolean };
  let query: Query; const results = new Map<string, Result>(); const requests: { path: string; signal?: AbortSignal | null }[] = [];
  const actions: string[] = []; const invalidated: unknown[] = [];
  const component = compile<{ default: (props: Record<string, unknown>) => unknown }>("src/features/invoices/ControllerExportPanel.tsx", {
    react, "react/jsx-runtime": { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) },
    "../../lib/useCursorPagination": compile("src/lib/useCursorPagination.ts", { react }),
    "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries: async (input: unknown) => { invalidated.push(input); } }),
      useQuery: (options: Query) => { if (options.queryKey[0] !== "controller-invoice-payment-holds") return { data: { count: 0, canHandoff: true } };
        query = options; return results.get(JSON.stringify(options.queryKey)) || { isLoading: true, isFetching: true }; } },
    "../../lib/supabase/client": { supabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "synthetic" } } }) } }) },
    "../../lib/errors/apiFetch": { apiFetch: async (path: string, init: RequestInit) => { requests.push({ path, signal: init.signal }); return Response.json(page()); } },
    "../work-orders/queries": { WORK_ORDERS_KEY: ["work-orders"] },
    "./queries": { CONTROLLER_INVOICE_HOLDS_KEY: ["controller-invoice-payment-holds"], INVOICES_KEY: ["invoices"] },
    "./QuickBooksSandboxConnection": { default: "QuickBooksSandboxConnection" },
    "../../lib/financialNotificationCommands": { prepareInvoicePaymentHold: async () => { actions.push("prepare"); return { expectedSourceEventId: actor }; },
      updateInvoicePaymentHold: async (_id: string, action: string, _reason: string, source: string) => { actions.push(action); assert.equal(source, actor); return {}; } },
    "../../lib/financialNotificationCommandContracts": { financialNotificationFeedback: () => "notification queued", safeFinancialNotificationCommandError: () => ({ uncertain: false }) },
    "../financial-notifications/queries": { invalidateFinancialNotices: async () => { actions.push("invalidate-notices"); } },
  }, { window: { prompt: () => { actions.push("prompt"); return "Synthetic release"; } } });
  let profile = { id: actor, role: "manager", active: true, staffPermissions: ["quickbooks_handoff"] };
  const render = () => { index = 0; return elements(component.default({ invoices: [], currentUser: profile })); };
  const button = (nodes: Element[], label: string) => { const node = nodes.find(node => node.type === "button" && node.props.children === label); assert.ok(node); return node; };
  return { render, button, requests, actions, invalidated, query: () => query!,
    result: (result: Result) => results.set(JSON.stringify(query!.queryKey), result),
    profile: (next: typeof profile) => { profile = next; }, currentProfile: () => profile };
}
test("hold UI navigates real pages, carries abort, resets actor/role/grant scope and refreshes newest", async () => {
  const h = uiHarness(); h.render(); const firstKey = JSON.stringify(h.query().queryKey);
  const controller = new AbortController(); await h.query().queryFn({ signal: controller.signal });
  assert.match(h.requests[0].path, /limit=25/); assert.equal(h.requests[0].signal, controller.signal);
  h.result({ data: { ...page(), hasMore: true, nextCursor: "YWJj" } }); let nodes = h.render();
  assert.equal(h.button(nodes, "Previous holds").props.disabled, true);
  (h.button(nodes, "Next holds").props.onClick as () => void)(); nodes = h.render();
  assert.equal(h.query().queryKey.at(-1), "YWJj"); assert.ok(nodes.some(node => node.props.children === "Loading payment holds…"));
  h.result({ data: { ...page(), holds: [] } }); nodes = h.render();
  assert.equal(h.button(nodes, "Next holds").props.disabled, true);
  assert.equal(h.button(nodes, "Previous holds").props.disabled, false);
  (h.button(nodes, "Previous holds").props.onClick as () => void)(); nodes = h.render();
  assert.equal(JSON.stringify(h.query().queryKey), firstKey);
  (h.button(nodes, "Refresh newest holds").props.onClick as () => void)(); h.render();
  assert.equal(h.query().queryKey.at(-1), null); assert.notEqual(JSON.stringify(h.query().queryKey), firstKey);
  for (const patch of [{ id: "40000000-0000-4000-8000-000000000002" }, { role: "back_office" }, { staffPermissions: [] }]) {
    const before = JSON.stringify(h.query().queryKey); h.profile({ ...h.currentProfile(), ...patch }); h.render();
    assert.equal(h.query().queryKey.at(-1), null); assert.notEqual(JSON.stringify(h.query().queryKey), before);
  }
  h.profile({ ...h.currentProfile(), active: false }); nodes = h.render();
  assert.equal(h.query().enabled, false); assert.ok(!nodes.some(node => node.props["aria-label"] === "Current payment holds"));
});
test("hold UI hides stale actionable rows on error and retains safe release flow/invalidation", async () => {
  const h = uiHarness(); h.render(); h.result({ data: page(), error: new Error("private upstream failure") });
  let nodes = h.render(); assert.ok(!nodes.some(node => node.props.children === "Release"));
  assert.equal(h.button(nodes, "Next holds").props.disabled, true); assert.equal(h.button(nodes, "Refresh newest holds").props.disabled, false);
  h.result({ data: page() }); nodes = h.render(); (h.button(nodes, "Release").props.onClick as () => void)();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.actions, ["prepare", "prompt", "release", "invalidate-notices"]);
  const scoped = h.invalidated.find(value => value && typeof value === "object" && "predicate" in value);
  assert.ok(scoped && typeof scoped === "object" && "predicate" in scoped && typeof scoped.predicate === "function");
  const matches = scoped.predicate as (query: { queryKey: readonly unknown[] }) => boolean;
  assert.equal(matches({ queryKey: h.query().queryKey }), true);
  const otherActorKey = [...h.query().queryKey]; otherActorKey[1] = ["other-actor", "manager"];
  assert.equal(matches({ queryKey: otherActorKey }), false);
  assert.equal(matches({ queryKey: ["work-order-by-id", "unrelated"] }), false);
});
