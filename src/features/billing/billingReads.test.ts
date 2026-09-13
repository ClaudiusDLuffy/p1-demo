import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { apiFetch } from "../../lib/errors/apiFetch";
import type * as BillingReads from "./billingReads";

function harness(options: { token?: string | null; response?: () => Promise<Response>; session?: () => Promise<void> } = {}) {
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const filename = resolve("src/features/billing/billingReads.ts");
  const requireHere = createRequire(import.meta.url);
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, URLSearchParams, require: (name: string): unknown => {
    if (name.endsWith("/supabase/client")) return { supabase: () => ({ auth: { getSession: async () => {
      await options.session?.(); return { data: { session: options.token === null ? null : { access_token: "synthetic-token" } } };
    } } }) };
    if (name.endsWith("/errors/apiFetch")) return { apiFetch: (input: RequestInfo | URL, init?: RequestInit) => apiFetch(input, init,
      async (input, init) => { requests.push({ input, init }); return options.response ? options.response() : Response.json({ totalCount: 7 }); }) };
    return requireHere(resolve(filename, "..", name));
  } }, { filename });
  return { reads: exports as typeof BillingReads, requests };
}
test("billing count read propagates cancellation and never requests rows", async () => {
  const h = harness(); const controller = new AbortController();
  assert.equal((await h.reads.readBillingCount({ queue: "all" }, controller.signal)).totalCount, 7);
  assert.match(String(h.requests[0].input), /response=count/);
  assert.equal(h.requests[0].init?.signal, controller.signal);
  assert.equal(h.requests[0].init?.method, undefined, "read-only GET, no mutation retry path");
});
test("missing auth and cancellation while resolving session perform no network request", async () => {
  const missing = harness({ token: null });
  await assert.rejects(missing.reads.readBillingCount({ queue: "all" }, new AbortController().signal), { code: "AUTH_REQUIRED" });
  assert.equal(missing.requests.length, 0);
  const controller = new AbortController();
  const cancelled = harness({ session: async () => { controller.abort(); } });
  await assert.rejects(cancelled.reads.readBillingCount({ queue: "all" }, controller.signal));
  assert.equal(cancelled.requests.length, 0);
});
test("billing read preserves Phase5D safe code and correlation, never raw error details", async () => {
  const requestId = "e47fdfbe-2aeb-42c2-ae55-000000000001";
  const h = harness({ response: async () => Response.json({ code: "FORBIDDEN", error: "PRIVATE_SYNTHETIC_DETAIL", correlationId: requestId },
    { status: 403, headers: { "X-Request-ID": requestId } }) });
  await assert.rejects(h.reads.readBillingCount({ queue: "all" }, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE_SYNTHETIC_DETAIL/);
    assert.equal((error as Error & { code: string }).code, "FORBIDDEN");
    assert.equal((error as Error & { correlationId: string }).correlationId, requestId); return true;
  });
});
test("malformed count/page and mismatched exact selected result fail safely", async () => {
  for (const payload of [{ totalCount: "7" }, { totalCount: -7 }]) {
    const h = harness({ response: async () => Response.json(payload) });
    await assert.rejects(h.reads.readBillingCount({ queue: "all" }, new AbortController().signal), { code: "INTERNAL_ERROR" });
  }
  const wrong = harness({ response: async () => Response.json({ invoice: { id: "other", wot: null, state: "draft" } }) });
  await assert.rejects(wrong.reads.readBillingInvoice("selected", new AbortController().signal), { code: "INTERNAL_ERROR" });
});
test("delayed old billing response cannot win after its request was cancelled", async () => {
  let finish: ((response: Response) => void) | undefined;
  const h = harness({ response: () => new Promise(done => { finish = done; }) });
  const controller = new AbortController();
  const pending = h.reads.readBillingRows({ queue: "all" }, controller.signal);
  await new Promise<void>(done => setImmediate(done)); controller.abort();
  finish?.(Response.json({ items: [{ id: "old" }], nextCursor: null, hasMore: false }));
  await assert.rejects(pending);
});

test("R3 billing browser summary canonicalizes request and response UUID without accepting another invoice", async () => {
  const id = "b7300000-abcd-4000-8abc-000000000001";
  const dto = { projection: "summary", id: id.toUpperCase(), num: "P1-SYNTHETIC", state: "draft",
    invoiceVersion: 2, subtotal: 10, salesTax: 0, total: 10, lineCount: 1, sourceCount: 0 };
  const h = harness({ response: async () => Response.json({ invoice: dto }) });
  const result = await h.reads.readBillingSummary(id.toUpperCase(), new AbortController().signal);
  assert.equal(result?.id, id);
  assert.equal(new URL(String(h.requests[0].input), "https://synthetic.invalid").searchParams.get("invoiceId"), id);
  const wrong = harness({ response: async () => Response.json({ invoice: { ...dto, id: "b7300000-abcd-4000-8abc-000000000002" } }) });
  await assert.rejects(wrong.reads.readBillingSummary(id, new AbortController().signal), { code: "INTERNAL_ERROR" });
});

test("R3 billing browser line continuation sends canonical UUID and unchanged opaque cursor", async () => {
  const id = "b7300000-abcd-4000-8abc-000000000001";
  const h = harness({ response: async () => Response.json({ projection: "line_page", items: [],
    pageSize: 50, invoiceVersion: 2, hasMore: false, nextCursor: null }) });
  const cursor = "opaque-SYNTHETIC+/==";
  await h.reads.readBillingLines(id.toUpperCase(), 2, cursor, new AbortController().signal);
  const params = new URL(String(h.requests[0].input), "https://synthetic.invalid").searchParams;
  assert.equal(params.get("invoiceId"), id); assert.equal(params.get("cursor"), cursor);
  assert.equal(params.get("expectedVersion"), "2"); assert.equal(params.get("limit"), "50");
});

test("R3 billing browser source preflight canonicalizes binding and rejects case-disguised duplicates", async () => {
  const id = "b7300000-abcd-4000-8abc-000000000001";
  const dto = { id: id.toUpperCase(), num: "P1-SYNTHETIC", state: "approved", invoiceVersion: 2,
    workOrderId: "WOT-CaseSensitive-SYNTHETIC", subtotal: 10, salesTax: 0, total: 10, lineCount: 1 };
  const h = harness({ response: async () => Response.json({ invoices: [dto] }) });
  const result = await h.reads.readBillingSourceSummaries([id.toUpperCase()], new AbortController().signal);
  assert.equal(result[0].id, id); assert.equal(result[0].workOrderId, "WOT-CaseSensitive-SYNTHETIC");
  assert.equal(new URL(String(h.requests[0].input), "https://synthetic.invalid").searchParams.get("sourceInvoiceIds"), id);
  await assert.rejects(h.reads.readBillingSourceSummaries([id, id.toUpperCase()], new AbortController().signal), { code: "INVALID_REQUEST" });
  assert.equal(h.requests.length, 1, "Duplicate logical sources must not trigger another request");
});
