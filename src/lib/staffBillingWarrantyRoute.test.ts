import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Row = Record<string, unknown>;
type Result = { data: Row[]; error: null };
type RequestPort = { headers: Headers; nextUrl: URL; json(): Promise<unknown> };
const invoiceId = "00000000-0000-4000-8000-000000000001";
const workOrderId = "WOTSYNTH100";
const partId = "00000000-0000-4000-8000-000000000002";

/** Actual route auth, canonicalization, tax resolution, RPC mapping and response
 * mapping; only external provider IO is synthetic. This is not a DB/RLS test. */
function routeHarness(options: { role?: string; permissions?: string[]; active?: boolean; parts?: Row[] } = {}) {
  const saves: Row[] = [];
  const invoice: Row = { id: invoiceId, num: "P1-SYNTH-1", invoice_type: "staff", document_kind: "invoice",
    state: "draft", deleted_at: null, work_order_id: null, invoice_date: "2026-09-09", terms: "Net 60",
    subtotal: 0, sales_tax: 0, total: 0 };
  let invoiceLines: Row[] = [];
  const rowsFor = (table: string): Row[] => {
    if (table === "profiles") return [{ id: "synthetic-staff", role: options.role ?? "back_office", name: "Synthetic staff", active: options.active ?? true }];
    if (table === "invoices") return [invoice];
    if (table === "invoice_lines") return invoiceLines;
    if (table === "staff_invoice_sources") return [];
    if (table === "work_orders") return [{ id: workOrderId, deleted_at: null, store_state: "TX" }];
    throw new Error(`Unexpected synthetic table ${table}`);
  };
  class Query implements PromiseLike<Result> {
    private filters: Array<(row: Row) => boolean> = [];
    constructor(private readonly table: string) {}
    select() { return this; }
    eq(field: string, value: unknown) { this.filters.push(row => row[field] === value); return this; }
    is(field: string, value: unknown) { return this.eq(field, value); }
    in(field: string, values: unknown[]) { this.filters.push(row => values.includes(row[field])); return this; }
    order() { return this; }
    range() { return this; }
    private rows() { return rowsFor(this.table).filter(row => this.filters.every(filter => filter(row))); }
    maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
    then<A = Result, B = never>(yes?: ((value: Result) => A | PromiseLike<A>) | null,
      no?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
      return Promise.resolve({ data: this.rows(), error: null }).then(yes, no);
    }
  }
  const database = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Row) => {
      if (name === "list_billable_p1_parts") return { data: options.parts ?? [], error: null };
      assert.equal(name, "save_staff_billing_invoice_v3");
      saves.push(args);
      assert.ok(Array.isArray(args.p_lines));
      invoiceLines = args.p_lines.map((line: unknown, position: number) => {
        assert.ok(typeof line === "object" && line !== null && "qty" in line && "rate" in line);
        assert.ok(typeof line.qty === "number" && typeof line.rate === "number");
        return { ...line, id: `synthetic-line-${position}`, invoice_id: invoiceId, position, amount: line.qty * line.rate };
      });
      const subtotal = invoiceLines.reduce((sum, line) => sum + Number(line.amount), 0);
      Object.assign(invoice, { state: args.p_state, work_order_id: args.p_work_order_id, subtotal,
        sales_tax: args.p_sales_tax, total: subtotal + Number(args.p_sales_tax), terms: args.p_terms });
      return { data: invoiceId, error: null };
    },
  };
  const filename = resolve("src/app/api/billing-invoices/route.ts");
  const requireHere = createRequire(import.meta.url);
  const exports: { POST?: (request: RequestPort) => Promise<Response>; PATCH?: (request: RequestPort) => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Error, process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic" } },
    require: (name: string): unknown => {
      if (name === "next/server") return { NextResponse: Response };
      if (name === "@supabase/supabase-js") return { createClient: () => ({ auth: {
        getUser: async () => ({ data: { user: { id: "synthetic-staff" } }, error: null }),
      } }) };
      if (name === "../../../lib/supabase/server") return { createServerClient: () => database };
      if (name === "../../../lib/server/staffAuthorization") return {
        STAFF_ROLES: new Set(["manager", "dispatcher", "back_office"]),
        loadStaffPermissions: async () => options.permissions ?? [],
        isInvoiceControllerProfile: (profile: { staffPermissions: string[] }) => profile.staffPermissions.includes("invoice_controller"),
      };
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    },
  }, { filename });
  assert.ok(exports.POST && exports.PATCH);
  const post = exports.POST, patch = exports.PATCH;
  const request = async (method: "POST" | "PATCH", lines: unknown[], extra: Row = {}) => {
    const body = { num: "P1-SYNTH-1", userTypedNum: true, invoiceDate: "2026-09-09", storeNumber: "100",
      territory: "Texas", equipmentTag: "7-ELEVEN: Miscellaneous", state: "submitted", terms: "Net 60",
      lines, ...extra };
    const response = await (method === "POST" ? post : patch)({
      headers: new Headers({ authorization: "Bearer synthetic" }),
      nextUrl: new URL(`https://synthetic.invalid/api/billing-invoices?id=${invoiceId}`), json: async () => body,
    });
    const data: unknown = await response.json();
    return { response, data };
  };
  return { request, saves, invoiceLines: () => invoiceLines };
}

const warranty = { type: "Warranty", desc: "Warranty service — no charge", qty: 1, rate: 0, isTaxable: false };
const labor = { type: "Labor", desc: "Additional paid service", qty: 2, rate: 100, isTaxable: false };

for (const method of ["POST", "PATCH"] as const) {
  test(`${method} retains an all-Warranty zero-rate invoice through the actual route and RPC mapping`, async () => {
    for (const state of ["draft", "submitted"]) {
      const h = routeHarness(); const { response, data } = await h.request(method, [{ ...warranty, isTaxable: true }], { state });
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(h.saves.length, 1); assert.equal(h.saves[0].p_sales_tax, 0); assert.equal(h.saves[0].p_state, state);
      assert.equal(h.invoiceLines()[0].type, "Warranty"); assert.equal(h.invoiceLines()[0].rate, 0);
      assert.equal(h.invoiceLines()[0].amount, 0);
      assert.ok(typeof data === "object" && data !== null && "invoice" in data);
      assert.ok(typeof data.invoice === "object" && data.invoice !== null && "total" in data.invoice);
      assert.equal(data.invoice.total, 0);
    }
  });

  test(`${method} retains mixed Warranty and paid lines in order with unchanged tax input`, async () => {
    const h = routeHarness(); const { response, data } = await h.request(method, [warranty, { ...labor, isTaxable: true }], { taxRateOverride: 5 });
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.deepEqual(h.invoiceLines().map(line => line.type), ["Warranty", "Labor"]);
    assert.equal(h.saves[0].p_sales_tax, 10); assert.equal(h.saves[0].p_tax_rate, 0.05);
  });

  test(`${method} preserves positive-rate rounding and the existing optional Travel description`, async () => {
    const h = routeHarness(); const { response, data } = await h.request(method, [
      { ...labor, qty: 1.125, rate: 10.005, sourceUnitCost: 12.345, markupPercent: 25.555 },
      { type: "Travel", desc: "", qty: 1, rate: 110 },
      { ...warranty, rate: 25 },
    ]);
    assert.equal(response.status, 200, JSON.stringify(data));
    const [rounded, travel, paidWarranty] = h.invoiceLines();
    assert.equal(rounded.qty, 1.13); assert.equal(rounded.rate, 10.01);
    assert.equal(rounded.source_unit_cost, 12.35); assert.equal(rounded.markup_percent, 25.6);
    assert.equal(travel.type, "Travel"); assert.equal(travel.description, ""); assert.equal(travel.rate, 110);
    assert.equal(paidWarranty.type, "Warranty"); assert.equal(paidWarranty.rate, 25);
  });

  test(`${method} rejects zero ordinary rates and malformed Warranty values instead of silently dropping a line`, async () => {
    for (const invalid of [
      { ...labor, rate: 0 }, { ...warranty, rate: -1 }, { ...warranty, rate: -0.001 },
      { ...warranty, rate: Number.NaN }, { ...warranty, rate: Number.POSITIVE_INFINITY }, { ...warranty, rate: null },
      { ...warranty, rate: "0" }, { ...warranty, rate: false }, { ...warranty, rate: undefined },
      { type: "Warranty", desc: warranty.desc, qty: 1 }, { ...warranty, qty: 0 }, { ...warranty, qty: -1 },
      { ...warranty, qty: Number.POSITIVE_INFINITY }, { ...warranty, qty: Number.NaN }, { ...warranty, qty: "1" },
      { ...warranty, qty: Number.MAX_VALUE }, { ...warranty, desc: "   " }, { ...warranty, type: "Warranty coverage" },
    ]) {
      for (const lines of [[invalid], [labor, invalid]]) {
        const h = routeHarness(); const { response } = await h.request(method, lines);
        assert.equal(response.status, 400, `Malformed line must reject ${method}`);
        assert.equal(h.saves.length, 0);
      }
    }
  });
}

test("Warranty labeling cannot bypass existing P1-part canonical quantity, type, cost or tax behavior", async () => {
  const h = routeHarness({ parts: [{ part_id: partId, description: "Canonical part", qty: 2, unit_cost: 100, marked_up_unit_rate: 125 }] });
  const { response, data } = await h.request("POST", [{ ...warranty, sourceWorkOrderPartId: partId }], { workOrderId, taxRateOverride: 0 });
  assert.equal(response.status, 200, JSON.stringify(data));
  const [line] = h.invoiceLines(); assert.equal(line.type, "Parts/Hardware");
  assert.equal(line.qty, 2); assert.equal(line.rate, 125); assert.equal(line.amount, 250);
  assert.equal(line.source_work_order_part_id, partId); assert.equal(line.markup_percent, 25);
});

test("the Warranty path does not broaden inactive, contractor or invoice-controller route access", async () => {
  for (const options of [{ active: false }, { role: "contractor" }, { permissions: ["invoice_controller"] }]) {
    const h = routeHarness(options);
    for (const method of ["POST", "PATCH"] as const) {
      const { response } = await h.request(method, [warranty]);
      assert.equal(response.status, 403); assert.equal(h.saves.length, 0);
    }
  }
});
