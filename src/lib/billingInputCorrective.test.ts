import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { billingRouteHarness, financialTestIds, validBillingRequest } from "./billingFinancialRouteTestHarness";
import { billingQueryHarness } from "./billing-post-test-support/queryHarness";
import { BILLING_SOURCE_FIELDS, createBillingSourceRepository } from "../server/billing-invoices/billingSourceRepository";
import { BILLING_FINANCIAL_INPUT_FIELDS, createBillingFinancialInputRepository } from "../server/billing-invoices/billingFinancialInputRepository";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";
import { createFakeBillingFinancialInputRepository, createFakeBillingSourceRepository } from "./billing-post-test-support/repositories";

const sourceId = "76100000-0000-4000-8000-000000000001";
const workOrderId = "WOTSYNTHETIC";
const sourceRow = (extra: Record<string, unknown> = {}) => ({
  id: sourceId, work_order_id: workOrderId, invoice_type: "contractor", state: "submitted", deleted_at: null, ...extra,
});
const workOrderRow = (extra: Record<string, unknown> = {}) => ({
  id: workOrderId, duplicate_root_work_order_id: "WOT-EXTERNAL-900001", contractor_assignment_version: 0,
  workflow_cycle: 0, store_state: "TX", ...extra,
});
const financialInput = { workOrderId, storeNumber: "123", territory: "Texas" };
const commandCalls = (harness: ReturnType<typeof billingRouteHarness>) =>
  harness.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4");

test("corrective POST standalone succeeds without a fabricated work order or work-order query", async () => {
  const h = billingRouteHarness({ tableRows: { work_orders: [] } });
  const response = await h.handlers.POST(h.request("POST", {
    ...validBillingRequest(), workOrderId: null, expectedAssignmentVersion: null, expectedWorkflowCycle: null,
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.invoice.id, financialTestIds.invoice);
  assert.equal(body.command.workOrderId, null);
  assert.equal(commandCalls(h).length, 1);
  assert.ok(!h.calls.some(call => call.name === "from:work_orders"));
});

test("corrective POST work-order-backed save still dispatches exactly one authoritative command", async () => {
  const h = billingRouteHarness();
  const response = await h.handlers.POST(h.request("POST", validBillingRequest()));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(commandCalls(h).length, 1);
  assert.ok(h.calls.some(call => call.name === "from:work_orders"));
});

test("corrective POST missing required work order is a safe not-found, not a standalone fallback", async () => {
  const h = billingRouteHarness({ tableRows: { work_orders: [] } });
  const response = await h.handlers.POST(h.request("POST", validBillingRequest()));
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(commandCalls(h).length, 0);
});

for (const [name, row] of [
  ["work-order identity", sourceRow({ work_order_id: 42 })],
  ["source state", sourceRow({ state: 42 })],
  ["source UUID", sourceRow({ id: "not-a-uuid" })],
  ["source deletion timestamp", sourceRow({ deleted_at: "not-a-date" })],
  ["source family", sourceRow({ invoice_type: "staff" })],
] as const) test(`corrective source repository rejects malformed ${name} wire data`, async () => {
  const h = billingQueryHarness([{ data: [row], error: null }]);
  const repository = createBillingSourceRepository(h.session);
  await assert.rejects(repository.loadForSave({ workOrderId, sourceInvoiceIds: [sourceId] }, { signal: null }));
});

test("corrective source repository rejects duplicate and unrequested returned identities", async () => {
  for (const rows of [[sourceRow(), sourceRow()], [sourceRow({ id: financialTestIds.actor })]]) {
    const h = billingQueryHarness([{ data: rows, error: null }]);
    await assert.rejects(createBillingSourceRepository(h.session)
      .loadForSave({ workOrderId, sourceInvoiceIds: [sourceId] }, { signal: null }));
  }
});

test("corrective source repository returns deterministic canonical order despite reversed wire order", async () => {
  const nextId = "76100000-0000-4000-8000-000000000002";
  const h = billingQueryHarness([{ data: [sourceRow({ id: nextId }), sourceRow()], error: null }]);
  const result = await createBillingSourceRepository(h.session)
    .loadForSave({ workOrderId, sourceInvoiceIds: [sourceId, nextId] }, { signal: null });
  assert.deepEqual(result.sourceInvoiceIds, [sourceId, nextId]);
});

test("corrective source query projects explicit facts and reads the maximum 100 IDs without N+1", async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `76100000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const h = billingQueryHarness([{ data: ids.map(id => sourceRow({ id })), error: null }]);
  const result = await createBillingSourceRepository(h.session)
    .loadForSave({ workOrderId, sourceInvoiceIds: ids }, { signal: null });
  assert.equal(h.dispatchCount(), 1);
  assert.equal(h.queries[0].table, "invoices");
  assert.equal(h.queries[0].projection, "id, work_order_id, invoice_type, state, deleted_at");
  assert.deepEqual(h.queries[0].filters, [
    { operator: "in", column: "id", value: ids },
    { operator: "eq", column: "invoice_type", value: "contractor" },
    { operator: "is", column: "deleted_at", value: null },
  ]);
  assert.deepEqual(result.sourceInvoiceIds, ids);
});

test("corrective empty source selection issues no database query", async () => {
  const h = billingQueryHarness([]);
  await createBillingSourceRepository(h.session).loadForSave({ workOrderId, sourceInvoiceIds: [] }, { signal: null });
  assert.equal(h.queries.length, 0);
});

test("corrective source query forwards the exact request signal to supported transport", async () => {
  const controller = new AbortController();
  const h = billingQueryHarness([{ data: [sourceRow()], error: null }]);
  await createBillingSourceRepository(h.session)
    .loadForSave({ workOrderId, sourceInvoiceIds: [sourceId] }, { signal: controller.signal });
  assert.equal(h.queries[0].signal, controller.signal);
});

test("corrective source abort during dispatch reaches transport and stops later work", async () => {
  const controller = new AbortController();
  const h = billingQueryHarness([{ data: [sourceRow()], error: null }], query => {
    assert.equal(query.signal, controller.signal);
    controller.abort();
  });
  await assert.rejects(createBillingSourceRepository(h.session)
    .loadForSave({ workOrderId, sourceInvoiceIds: [sourceId] }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(h.dispatchCount(), 1);
});

for (const [name, row] of [
  ["internal identity", workOrderRow({ id: 42 })],
  ["other target identity", workOrderRow({ id: "ANOTHER-WOT" })],
  ["external identity", workOrderRow({ duplicate_root_work_order_id: 42 })],
  ["assignment version", workOrderRow({ contractor_assignment_version: -1 })],
  ["workflow version", workOrderRow({ workflow_cycle: 1.5 })],
  ["state value", workOrderRow({ store_state: 42 })],
] as const) test(`corrective financial-input repository rejects malformed ${name}`, async () => {
  const h = billingQueryHarness([{ data: row, error: null }]);
  await assert.rejects(createBillingFinancialInputRepository(h.session).loadForSave(financialInput, { signal: null }));
});

test("corrective financial-input query forwards the request signal with the exact work-order filter", async () => {
  const controller = new AbortController();
  const h = billingQueryHarness([{ data: workOrderRow(), error: null }]);
  await createBillingFinancialInputRepository(h.session).loadForSave(financialInput, { signal: controller.signal });
  assert.equal(h.queries[0].signal, controller.signal);
  assert.equal(h.queries[0].table, "work_orders");
  assert.equal(h.queries[0].projection, "id, duplicate_root_work_order_id, contractor_assignment_version, workflow_cycle, store_state");
  assert.deepEqual(h.queries[0].filters, [{ operator: "eq", column: "id", value: workOrderId }]);
  assert.equal(h.queries[0].single, true);
});

test("corrective financial-input transport abort prevents a successful read result", async () => {
  const controller = new AbortController();
  const h = billingQueryHarness([{ data: workOrderRow(), error: null }], query => {
    assert.equal(query.signal, controller.signal);
    controller.abort();
  });
  await assert.rejects(createBillingFinancialInputRepository(h.session)
    .loadForSave(financialInput, { signal: controller.signal }), { name: "AbortError" });
});

test("corrective already-aborted input repositories issue no query", async () => {
  const controller = new AbortController(); controller.abort();
  const h = billingQueryHarness([]);
  await assert.rejects(createBillingSourceRepository(h.session)
    .loadForSave({ workOrderId, sourceInvoiceIds: [sourceId] }, { signal: controller.signal }));
  await assert.rejects(createBillingFinancialInputRepository(h.session)
    .loadForSave(financialInput, { signal: controller.signal }));
  assert.equal(h.queries.length, 0);
});

test("corrective POST malformed financial facts fail before the authoritative command", async () => {
  const h = billingRouteHarness({ tableRows: { work_orders: [workOrderRow({ workflow_cycle: "private-canary" })] } });
  const response = await h.handlers.POST(h.request("POST", validBillingRequest()));
  assert.equal(response.status, 500);
  assert.equal(commandCalls(h).length, 0);
  assert.doesNotMatch(await response.text(), /private-canary/);
});

test("corrective POST malformed source facts stop before financial reads and command dispatch", async () => {
  const h = billingRouteHarness({ tableRows: { invoices: [sourceRow({ state: "PRIVATE-STATE-CANARY" })] } });
  const response = await h.handlers.POST(h.request("POST", { ...validBillingRequest(), sourceInvoiceIds: [sourceId] }));
  assert.equal(response.status, 500);
  assert.equal(commandCalls(h).length, 0);
  assert.ok(!h.calls.some(call => call.name === "from:work_orders"));
  assert.doesNotMatch(await response.text(), /PRIVATE-STATE-CANARY/);
});

test("corrective POST request signal reaches both actual production input repository ports", async () => {
  const h = billingRouteHarness({ tableRows: { invoices: [sourceRow()] }, commandResultOverride: { sourceInvoiceCount: 1 } });
  const request = h.request("POST", { ...validBillingRequest(), sourceInvoiceIds: [sourceId] });
  const response = await h.handlers.POST(request);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(h.calls.find(call => call.name === "signal:invoices")?.payload, request.signal);
  assert.equal(h.calls.find(call => call.name === "signal:work_orders")?.payload, request.signal);
  assert.equal(commandCalls(h).length, 1);
});

test("corrective POST source unavailability preserves the database validation response", async () => {
  const h = billingRouteHarness({ tableRows: { invoices: [] }, commandError: { code: "22023", message: "private source detail" } });
  const response = await h.handlers.POST(h.request("POST", { ...validBillingRequest(), sourceInvoiceIds: [sourceId] }));
  assert.equal(response.status, 422);
  assert.equal(commandCalls(h).length, 1);
  assert.doesNotMatch(await response.text(), /private source detail/);
});

test("corrective POST same-operation source replay reaches the authoritative replay owner", async () => {
  const h = billingRouteHarness({ tableRows: { invoices: [] }, commandResultOverride: { applied: false, reason: "already_applied", sourceInvoiceCount: 1 } });
  const response = await h.handlers.POST(h.request("POST", { ...validBillingRequest(), sourceInvoiceIds: [sourceId] }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(commandCalls(h).length, 1);
});

for (const [name, options, expected] of [
  ["inactive profile", { active: false }, 403],
  ["auth failure", { authFailure: true }, 401],
  ["missing profile", { role: "manager", missingProfile: true }, 403],
  ["contractor role", { role: "contractor" }, 403],
  ["technician role", { role: "technician" }, 403],
  ["report-only technician", { role: "report_only_technician" }, 403],
  ["restricted controller permission", { role: "manager", staffPermissions: ["invoice_controller"] }, 403],
  ["controller shorthand", { controller: true }, 403],
  ["QuickBooks-only non-staff", { role: "contractor", staffPermissions: ["quickbooks_export"] }, 403],
  ["active manager", { role: "manager", active: true }, 200],
  ["active dispatcher", { role: "dispatcher", active: true }, 200],
  ["active back office", { role: "back_office", active: true }, 200],
  ["operational manager with additive QuickBooks grant", { role: "manager", staffPermissions: ["quickbooks_export"] }, 200],
] as const) test(`corrective mutation authorization harness honors ${name}`, async () => {
  for (const method of ["POST", "PATCH"]) {
    const h = billingRouteHarness(options);
    const response = await h.handlers[method](h.request(method, {
      ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null,
    }, method === "PATCH" ? `?id=${financialTestIds.invoice}` : ""));
    assert.equal(response.status, expected, await response.clone().text());
    assert.equal(commandCalls(h).length, expected === 200 ? 1 : 0);
  }
});

test("corrective POST caller-supplied role cannot bypass the strict command or authorize mutation", async () => {
  const h = billingRouteHarness({ role: "contractor" });
  const response = await h.handlers.POST(h.request("POST", { ...validBillingRequest(), role: "manager" }));
  assert.equal(response.status, 422);
  assert.equal(commandCalls(h).length, 0);
});

test("corrective POST request cancellation is preserved through authorization to input reads", async () => {
  const controller = new AbortController(); controller.abort();
  const h = billingRouteHarness();
  const request = new NextRequest("https://synthetic.invalid/api/billing-invoices", {
    method: "POST", headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" },
    body: JSON.stringify(validBillingRequest()), signal: controller.signal,
  });
  const response = await h.handlers.POST(request);
  assert.equal(response.status, 408);
  assert.equal(commandCalls(h).length, 0);
  assert.ok(!h.calls.some(call => call.name === "from:work_orders"));
});

test("corrective installed Supabase source and work-order transports receive the request signal", async () => {
  const controller = new AbortController();
  const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const client = createClient<Database>("https://synthetic.invalid", "synthetic-public-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, signal: init?.signal });
      const data = url.includes("/work_orders?") ? [workOrderRow()] : [sourceRow()];
      return Response.json(data);
    } },
  });
  // Resolve each installed SDK builder at its exact contract, avoiding an
  // unbounded structural comparison of Supabase's generic query overloads.
  const sourceSession = { from: (table: "invoices") => ({ select: (fields: typeof BILLING_SOURCE_FIELDS) => ({
    in: (idColumn: "id", ids: readonly string[]) => ({
      eq: (familyColumn: "invoice_type", family: "contractor") => ({
        is: (deletedColumn: "deleted_at", deleted: null) => ({
          order: (orderColumn: "id", order: { ascending: boolean }) => {
            const query = client.from(table).select(fields).in(idColumn, ids).eq(familyColumn, family)
              .is(deletedColumn, deleted).order(orderColumn, order);
            const execute = async (): Promise<unknown> => { const result = await query; return result; };
            const read: PromiseLike<unknown> & { abortSignal(signal: AbortSignal): PromiseLike<unknown> } = {
              then: (fulfilled, rejected) => execute().then(fulfilled, rejected),
              abortSignal: signal => { query.abortSignal(signal); return read; },
            };
            return read;
          },
        }),
      }),
    }),
  }) }) };
  const financialSession = { from: (table: "work_orders") => ({ select: (fields: typeof BILLING_FINANCIAL_INPUT_FIELDS) => ({
    eq: (column: "id", value: string) => {
      const query = client.from(table).select(fields).eq(column, value);
      return {
        abortSignal: (signal: AbortSignal) => { query.abortSignal(signal); return { maybeSingle: async (): Promise<unknown> => query.maybeSingle() }; },
        maybeSingle: async (): Promise<unknown> => query.maybeSingle(),
      };
    },
  }) }) };
  await createBillingSourceRepository(sourceSession)
    .loadForSave({ workOrderId, sourceInvoiceIds: [sourceId] }, { signal: controller.signal });
  await createBillingFinancialInputRepository(financialSession).loadForSave(financialInput, { signal: controller.signal });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.signal === controller.signal));
  assert.equal(new URL(requests[1].url).searchParams.get("id"), `eq.${workOrderId}`);
});

test("corrective source oversized and duplicate selections fail before query construction", async () => {
  for (const ids of [Array.from({ length: 101 }, (_, index) => `76100000-0000-4000-8000-${String(index).padStart(12, "0")}`), [sourceId, sourceId]]) {
    const h = billingQueryHarness([]);
    await assert.rejects(createBillingSourceRepository(h.session).loadForSave({ workOrderId, sourceInvoiceIds: ids }, { signal: null }));
    assert.equal(h.queries.length, 0);
  }
});

test("corrective repository provider errors retain only a safe public message", async () => {
  const providerError = { code: "PGRST500", message: "PRIVATE-SQL-CANARY", details: "PRIVATE-SQL-DETAIL" };
  const h = billingQueryHarness([{ data: null, error: providerError }]);
  await assert.rejects(createBillingSourceRepository(h.session)
    .loadForSave({ workOrderId, sourceInvoiceIds: [sourceId] }, { signal: null }), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /PRIVATE-SQL/);
    assert.notEqual(error, providerError);
    return true;
  });
});

test("corrective independent repository fakes retain separate calls and request context", async () => {
  const source = createFakeBillingSourceRepository({ sourceInvoiceIds: [sourceId] });
  const financial = createFakeBillingFinancialInputRepository({ kind: "standalone", workOrderId: null });
  const context = { actor: { userId: financialTestIds.actor }, requestId: "synthetic-request", signal: new AbortController().signal };
  const request = { workOrderId, sourceInvoiceIds: [sourceId] };
  assert.deepEqual(await source.repository.loadForSave(request, context), { sourceInvoiceIds: [sourceId] });
  assert.equal(financial.calls.length, 0);
  await financial.repository.loadForSave({ ...financialInput, workOrderId: null }, context);
  assert.deepEqual(source.calls, [request]);
  assert.equal(source.contexts[0], context);
  assert.equal(financial.contexts[0], context);
  assert.notEqual(source.calls, financial.calls);
});

test("corrective independent fake failure and cancellation are not silently ignored", async () => {
  const cause = new Error("Explicit synthetic failure");
  const source = createFakeBillingSourceRepository({ sourceInvoiceIds: [] }, { error: cause });
  await assert.rejects(source.repository.loadForSave({ workOrderId, sourceInvoiceIds: [] }, { signal: null }), error => error === cause);
  const controller = new AbortController();
  const financial = createFakeBillingFinancialInputRepository({ kind: "standalone", workOrderId: null }, { onLoad: () => controller.abort() });
  await assert.rejects(financial.repository.loadForSave({ ...financialInput, workOrderId: null }, { signal: controller.signal }), { name: "AbortError" });
});

test("corrective independent repository fakes reject missing JavaScript fixture fields loudly", () => {
  assert.throws(() => Reflect.apply(createFakeBillingSourceRepository, null, []), /explicit typed source fixture/);
  assert.throws(() => Reflect.apply(createFakeBillingSourceRepository, null, [{}]), /explicit typed source fixture/);
  assert.throws(() => Reflect.apply(createFakeBillingFinancialInputRepository, null, []), /explicit typed financial-input fixture/);
  assert.throws(() => Reflect.apply(createFakeBillingFinancialInputRepository, null, [{ kind: "work_order", workOrderId }]), /explicit typed financial-input fixture/);
});
