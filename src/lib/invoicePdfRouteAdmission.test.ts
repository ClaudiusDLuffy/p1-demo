import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { NextRequest, NextResponse } from "next/server";
import ts from "typescript";
import { InvoicePdfError, type InvoicePdfErrorCode } from "./pdf/invoicePdfBudget";
import type { InvoicePdfExtraction } from "./pdf/invoicePdfTypes";
import { InvoicePdfRequestError, readUploadedInvoicePdf, type InvoicePdfRequestCode } from "./server/invoicePdfRequest";
import * as requestContext from "./observability/requestContext";
import * as httpBoundary from "./errors/httpBoundary";
import * as requestOperation from "./server/requestOperation";
import * as apiMethodBoundary from "./server/apiMethodBoundary";

// Execute the actual route with synthetic authorization/parser ports. Real
// admission helpers have separate streamed-request and current-profile tests.
// This does not claim Supabase gateway or PDF worker integration coverage.
const filename = resolve("src/app/api/invoice-pdf/parse-total/route.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const fixture: InvoicePdfExtraction = { total: 160, confidence: "high", matchedLabel: "Total Due",
  invoiceNumber: "SYNTHETIC-200", invoiceNumberConfidence: "high", matchedNumberLabel: "Invoice Number",
  lines: [{ type: "Labor", desc: "Synthetic labor", qty: 2, rate: 80, amount: 160, confidence: "high" }], lineConfidence: "high" };
function harness(options: {
  authorize?: (request: Request) => Promise<void>;
  parse?: (bytes: Uint8Array, options: { signal?: AbortSignal }) => Promise<InvoicePdfExtraction>;
} = {}) {
  const order: string[] = [];
  let parseCalls = 0;
  const exports: { POST?: (request: NextRequest) => Promise<Response>; runtime?: string; maxDuration?: number } = {};
  runInNewContext(compiled, { exports, require: (name: string): unknown => {
    if (name === "next/server") return { NextResponse };
    if (name.endsWith("/observability/requestContext")) return requestContext;
    if (name.endsWith("/errors/httpBoundary")) return httpBoundary;
    if (name.endsWith("/server/requestOperation")) return requestOperation;
    if (name.endsWith("/server/apiMethodBoundary")) return apiMethodBoundary;
    if (name.endsWith("/invoicePdfParser")) return { extractInvoiceDataFromPdf: async (bytes: Uint8Array, parseOptions: { signal?: AbortSignal }) => {
      order.push("parse"); parseCalls++;
      return options.parse ? options.parse(bytes, parseOptions) : fixture;
    } };
    if (name.endsWith("/invoicePdfBudget")) return { InvoicePdfError };
    if (name.endsWith("/invoicePdfAuthorization")) return { requireInvoicePdfActor: async (request: Request) => {
      order.push("authorize"); await options.authorize?.(request);
    } };
    if (name.endsWith("/invoicePdfRequest")) return { InvoicePdfRequestError, readUploadedInvoicePdf: async (request: Request) => {
      order.push("body"); return readUploadedInvoicePdf(request);
    } };
    throw new Error(`Unexpected test import: ${name}`);
  } }, { filename });
  assert.ok(exports.POST); assert.equal(exports.runtime, "nodejs"); assert.equal(exports.maxDuration, 60);
  return { post: exports.POST, order, parseCalls: () => parseCalls };
}
function request(options: { bytes?: string; extra?: boolean; signal?: AbortSignal } = {}) {
  const form = new FormData();
  form.append("file", new File([options.bytes ?? "%PDF-1.7\nsynthetic transport fixture"], "synthetic.bin", { type: "text/plain" }));
  if (options.extra) form.append("role", "manager");
  return new NextRequest("https://portal.invalid/api/invoice-pdf/parse-total", {
    method: "POST", headers: { Authorization: "Bearer synthetic" }, body: form, signal: options.signal,
  });
}
async function safeFailure(response: Response, status: number, code: string) {
  assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "code" in body && "error" in body);
  assert.equal(body.code, code); assert.equal(typeof body.error, "string");
  assert.deepEqual(Object.keys(body).sort(), ["code", "correlationId", "error"]);
  assert.ok("correlationId" in body && typeof body.correlationId === "string");
  assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get("X-Request-ID"), body.correlationId);
  assert.doesNotMatch(String(body.error), /\/private\/|native canvas|provider-secret|SELECT|stack trace/);
}

test("route authenticates before consuming multipart and preserves the complete successful parser result", async () => {
  const h = harness({ authorize: async req => { assert.equal(req.bodyUsed, false); }, parse: async (bytes, options) => {
    assert.match(new TextDecoder().decode(bytes), /^%PDF-1\.7\n/); assert.ok(options.signal instanceof AbortSignal); return fixture;
  } });
  const response = await h.post(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("X-Request-ID") || "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(await response.json(), fixture); assert.deepEqual(h.order, ["authorize", "body", "parse"]);
});

test("route rejects every authorization outcome before body or parser execution", async () => {
  const outcomes: readonly [InvoicePdfRequestCode, number][] = [["AUTH_REQUIRED", 401], ["AUTH_INVALID", 401],
    ["ACCOUNT_INACTIVE", 403], ["FORBIDDEN", 403], ["AUTH_TIMEOUT", 408], ["REQUEST_ABORTED", 408]];
  for (const [code, status] of outcomes) {
    const h = harness({ authorize: async () => { throw new InvoicePdfRequestError(code); } });
    const req = request(); await safeFailure(await h.post(req), status, code);
    assert.equal(req.bodyUsed, false); assert.deepEqual(h.order, ["authorize"]); assert.equal(h.parseCalls(), 0);
  }
});

test("route refuses spoofed signatures and extra multipart fields before extraction", async () => {
  for (const [options, code, status] of [[{ bytes: "not PDF bytes" }, "PDF_INVALID_SIGNATURE", 415],
    [{ extra: true }, "PDF_REQUEST_INVALID", 400]] as const) {
    const h = harness(); await safeFailure(await h.post(request(options)), status, code); assert.equal(h.parseCalls(), 0);
  }
});

test("route maps typed parser failures to bounded safe responses without technical cause details", async () => {
  const outcomes: readonly [InvoicePdfErrorCode, number][] = [["REQUEST_ABORTED", 408], ["PDF_PARSE_TIMEOUT", 408],
    ["PDF_TOO_LARGE", 413], ["PDF_PAGE_LIMIT", 413], ["PDF_ITEM_LIMIT", 413], ["PDF_TEXT_LIMIT", 413], ["PDF_OUTPUT_LIMIT", 413],
    ["PDF_INVALID_SIGNATURE", 415], ["PDF_ENCRYPTED_UNSUPPORTED", 422], ["PDF_MALFORMED", 422],
    ["PDF_PARSE_BUSY", 503], ["PDF_PARSE_FAILED", 500], ["PDF_CLEANUP_FAILED", 500]];
  for (const [code, status] of outcomes) {
    const h = harness({ parse: async () => { throw new InvoicePdfError(code, new Error("/private/provider-secret native canvas stack trace")); } });
    await safeFailure(await h.post(request()), status, code); assert.equal(h.parseCalls(), 1);
  }
});

test("unexpected authorization or parsing failures produce500 without provider details", async () => {
  const fail = async (): Promise<never> => { throw new Error("/private/provider-secret SELECT native canvas stack trace"); };
  for (const options of [{ authorize: fail }, { parse: fail }]) {
    const h = harness(options); await safeFailure(await h.post(request()), 500, "PDF_PARSE_FAILED");
  }
});

test("an abort immediately after extraction cannot publish an otherwise successful result", async () => {
  const controller = new AbortController();
  const h = harness({ parse: async () => { controller.abort(new Error("/private/provider-secret")); return fixture; } });
  await safeFailure(await h.post(request({ signal: controller.signal })), 408, "REQUEST_ABORTED");
  assert.equal(h.parseCalls(), 1);
});
