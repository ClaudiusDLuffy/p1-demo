import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import * as boundary from "./errors/httpBoundary";
import * as contextModule from "./observability/requestContext";
import * as normalization from "./errors/normalizeUnknown";
import * as legacyResponse from "./errors/legacyResponse";
import * as appErrorModule from "./errors/AppError";
import * as configuration from "./config/shared";
import * as diagnostics from "./server/diagnostics/handler";
import * as requestOperation from "./server/requestOperation";
import * as apiMethodBoundary from "./server/apiMethodBoundary";
import { isPublicErrorCode, errorMetadata } from "./errors/catalog";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";

// Explicit inventory: removing a method cannot silently reduce the coverage.
// These isolated entry-point tests are not provider/JWT/hosted certification.
const routes = [
  ["billing-invoices", ["GET", "POST", "PATCH", "DELETE"]],
  ["client-errors", ["POST"]],
  ["contractor-invoice-holds", ["GET", "PATCH"]],
  ["contractor-invoices", ["DELETE"]],
  ["contractor-technicians/manage", ["POST", "DELETE"]],
  ["controller-exports", ["GET", "POST", "PATCH"]],
  ["email-intake", ["GET", "POST"]],
  ["invoice-pdf/parse-total", ["POST"]],
  ["notifications/assignment-removal", ["POST"]],
  ["notifications/contractor-attention", ["POST"]],
  ["notifications/dispatch", ["POST"]],
  ["notifications/dispatch/drain", ["GET", "POST"]],
  ["notifications/financial/drain", ["GET", "POST"]],
  ["notifications/invoice-review", ["POST"]],
  ["notifications/parts-order", ["GET", "POST"]],
  ["parts-order-settings", ["GET", "PATCH"]],
  ["private-objects/cancel", ["POST"]],
  ["private-objects/delete", ["POST"]],
  ["private-objects/finalize", ["POST"]],
  ["private-objects/intents", ["POST"]],
  ["private-objects/reconcile", ["POST"]],
  ["quickbooks/callback", ["GET"]],
  ["quickbooks/connect", ["POST"]],
  ["quickbooks/connection", ["GET", "DELETE"]],
] as const;
const marker = "SYNTHETIC_PRIVATE_PROVIDER_SQL_CONTENT";
const requireHere = createRequire(import.meta.url);

function sourceFor(route: string) {
  const filename = resolve(`src/app/api/${route}/route.ts`);
  const source = readFileSync(filename, "utf8");
  return { filename, source, ast: ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true) };
}

function handlerBody(ast: ts.SourceFile, name: string): ts.Block {
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) return statement.body;
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      if (ts.isIdentifier(declaration.initializer)) return handlerBody(ast, declaration.initializer.text);
      if ((ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) && ts.isBlock(declaration.initializer.body)) return declaration.initializer.body;
    }
  }
  assert.fail(`Missing handler body: ${name}`);
}

function directReturns(body: ts.Block): ts.ReturnStatement[] {
  const result: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node) => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return result;
}

function faultedRoute(route: string) {
  const { filename, source } = sourceFor(route);
  let initialized = false;
  let portCalls = 0;
  let networkCalls = 0;
  const failure = new Error(marker);
  // A callable module proxy permits harmless top-level schema/alias setup,
  // then faults the first domain/external port invocation inside the handler.
  const port: object = new Proxy(function syntheticPort() { return undefined; }, {
    get: (_target, key) => key === "then" ? undefined : key === "prototype" ? Object.prototype : port,
    apply: () => { if (initialized) { portCalls++; throw failure; } return port; },
    construct: () => { if (initialized) { portCalls++; throw failure; } return {}; },
  });
  const exports: Record<string, unknown> = {};
  const createContext: typeof contextModule.createRequestContext = (request, path) => {
    const context = contextModule.createRequestContext(request, path);
    // Privacy of the single real logging port is tested independently. Suppress
    // its console sink here so this matrix only reports assertion failures.
    context.failureLogged = true;
    return context;
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    exports, Request, Response, Headers, URL, URLSearchParams, AbortController, AbortSignal,
    TextEncoder, TextDecoder, Uint8Array, Buffer, Error, crypto, setTimeout, clearTimeout,
    process: { env: {} }, console: { info() {}, warn() {}, error() {} },
    fetch: async () => { networkCalls++; throw new Error("Unexpected network access"); },
    require: (name: string): unknown => {
      if (name === "next/server") return { NextRequest, NextResponse };
      if (name === "zod" || name.startsWith("node:")) return requireHere(name);
      if (name.endsWith("/observability/requestContext")) return { ...contextModule, createRequestContext: createContext };
      if (name.endsWith("/errors/httpBoundary")) return boundary;
      if (name.endsWith("/errors/normalizeUnknown")) return normalization;
      if (name.endsWith("/errors/legacyResponse")) return legacyResponse;
      if (name.endsWith("/errors/AppError")) return appErrorModule;
      if (name.endsWith("/config/shared")) return configuration;
      if (name.endsWith("/diagnostics/handler")) return diagnostics;
      if (name.endsWith("/server/requestOperation")) return requestOperation;
      if (name.endsWith("/server/apiMethodBoundary")) return apiMethodBoundary;
      if (name.endsWith("/observability/safeLogger")) return { safeLog: () => true };
      return port;
    },
  }, { filename });
  initialized = true;
  return { exports, counts: () => ({ portCalls, networkCalls }) };
}

async function safeFailure(response: Response, expectedId: string) {
  assert.ok(response.status >= 400 && response.status <= 599);
  assert.equal(response.headers.get("X-Request-ID"), expectedId);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const text = await response.text();
  assert.doesNotMatch(text, /SYNTHETIC_PRIVATE|providerPayload|authorization|stack|15005550006/);
  const body: unknown = JSON.parse(text);
  assert.ok(body && typeof body === "object" && "code" in body && "error" in body && "correlationId" in body);
  assert.ok(isPublicErrorCode(body.code));
  assert.equal(body.error, errorMetadata(body.code).message);
  assert.equal(body.correlationId, expectedId);
  return body;
}

test("the explicit public-boundary inventory contains24 routes", () => assert.equal(routes.length, 24));
test("the original business-handler inventory remains exactly37 methods", () => assert.equal(routes.reduce((count, [, methods]) => count + methods.length, 0), 37));
for (const [route, methods] of routes) {
  test(`${route}: every supported method returns through the safe boundary`, () => {
    const { source, ast } = sourceFor(route);
    const businessSource = source.replace(/^export const (?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) = apiMethodBoundary\.(?:methodNotAllowed|OPTIONS);\n/gm, "");
    const exported = [...businessSource.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(match => match[1]);
    assert.deepEqual(exported.sort(), [...methods].sort());
    for (const method of methods) {
      const inspect = (body: ts.Block) => {
        const returns = directReturns(body);
        assert.ok(returns.length > 0);
        for (const statement of returns) {
          let expression = statement.expression;
          while (expression && ts.isAwaitExpression(expression)) expression = expression.expression;
          assert.ok(expression && ts.isCallExpression(expression), `${route}:${method} must return a boundary call`);
          assert.ok(ts.isIdentifier(expression.expression));
          if (expression.expression.text === "runRequestOperation") {
            const callback = expression.arguments[1];
            assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
            inspect(callback.body);
          } else assert.ok(["finalizeApiResponse", "errorResponse", "handleClientDiagnostic"].includes(expression.expression.text), `${route}:${method} bypassed the boundary`);
        }
      };
      inspect(handlerBody(ast, method));
    }
  });

  test(`${route}: framework method replacements are metadata-only and preserve Next OPTIONS/HEAD behavior`, async () => {
    const h = faultedRoute(route);
    const original = Object.fromEntries(methods.map(method => [method, () => new Response(null, { status: 201 })]));
    const oldMethods = autoImplementMethods(original);
    // Isolated compiled module exports are checked below before entering Next's
    // real dispatch table. No business or provider handler is invoked here.
    const current = autoImplementMethods(h.exports as Parameters<typeof autoImplementMethods>[0]);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) {
      if ((methods as readonly string[]).includes(method)) continue;
      if (method === "HEAD" && (methods as readonly string[]).includes("GET")) {
        assert.equal(h.exports.HEAD, undefined, "GET must retain the unchanged implicit HEAD implementation");
        assert.equal(current.HEAD, h.exports.GET); continue;
      }
      assert.equal(typeof h.exports[method], "function");
      const id = crypto.randomUUID();
      const request = new NextRequest(`https://synthetic.invalid/api/${route}?untrusted=private`, {
        method, headers: { "X-Request-ID": id, Authorization: "Bearer private-token" },
        ...(method !== "GET" && method !== "HEAD" ? { body: "unconsumed private body" } : {}),
      });
      const response = await current[method](request, {});
      assert.ok(response instanceof Response);
      assert.equal(response.headers.get("X-Request-ID"), id);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(request.bodyUsed, false);
      if (method === "OPTIONS") {
        const previous = await oldMethods.OPTIONS(request, {});
        assert.ok(previous instanceof Response);
        assert.equal(response.status, previous.status);
        assert.equal(response.headers.get("Allow"), previous.headers.get("Allow"));
        assert.equal(await response.text(), "");
      } else {
        assert.equal(response.status, 405);
        const expectedAllow = [...new Set([...methods, "OPTIONS", ...((methods as readonly string[]).includes("GET") ? ["HEAD"] : [])])].sort().join(", ");
        assert.equal(response.headers.get("Allow"), expectedAllow);
        const text = await response.text();
        if (method === "HEAD") assert.equal(text, "");
        else { const body: unknown = JSON.parse(text); assert.ok(body && typeof body === "object" && "code" in body && body.code === "METHOD_NOT_ALLOWED"); }
        assert.doesNotMatch(text, /private|untrusted|Bearer|\/api\//);
      }
    }
    assert.deepEqual(h.counts(), { portCalls: 0, networkCalls: 0 });
  });

  for (const method of methods) test(`${route}:${method} unexpected dependency failure stays private and correlated`, async () => {
    const h = faultedRoute(route);
    const handler = h.exports[method];
    assert.equal(typeof handler, "function");
    const id = crypto.randomUUID();
    const request = new NextRequest(`https://synthetic.invalid/api/${route}`, {
      method, headers: { "X-Request-ID": id, "Content-Type": "application/json", Authorization: "Bearer synthetic-token" },
      ...(method !== "GET" ? { body: JSON.stringify({ providerPayload: marker }) } : {}),
    });
    let bodyReads = 0;
    for (const reader of ["json", "text", "formData", "arrayBuffer"] as const) Object.defineProperty(request, reader, {
      value: async () => { bodyReads++; throw new Error("Unexpected body consumption"); },
    });
    const result: unknown = await (handler as (request: NextRequest) => Promise<unknown>)(request);
    assert.ok(result instanceof Response);
    await safeFailure(result, id);
    assert.ok(h.counts().portCalls > 0, "A mocked boundary dependency must have failed");
    assert.equal(h.counts().networkCalls, 0);
    assert.equal(bodyReads, 0, "The injected admission failure precedes body consumption");
    // Diagnostic rejection explicitly cancels the unread stream, which sets
    // bodyUsed without reading it; all other entry points leave it untouched.
    if (route !== "client-errors") assert.equal(request.bodyUsed, false);
  });

  test(`${route}: malformed upstream error projection cannot leak provider prose`, async () => {
    for (const payload of [marker, JSON.stringify({ error: marker, providerPayload: marker, stack: marker }), marker.repeat(2_000)]) {
      const id = crypto.randomUUID();
      const context = contextModule.createRequestContext(new Request(`https://synthetic.invalid/api/${route}`, { headers: { "X-Request-ID": id } }), `/api/${route}`);
      context.failureLogged = true;
      const result = await boundary.finalizeApiResponse(new Response(payload, { status: 502 }), context);
      assert.equal(result.status, 502);
      await safeFailure(result, id);
    }
  });
}

test("compatibility finalizer preserves successful JSON, downloads, redirects and empty responses byte-for-byte", async () => {
  const values = [
    Response.json({ success: true, notification: { status: "queued", deliveryId: crypto.randomUUID() } }, { status: 201 }),
    new Response(new Uint8Array([0, 1, 255, 10]), { headers: { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=synthetic.zip" } }),
    new Response(null, { status: 302, headers: { Location: "https://synthetic.invalid/return" } }),
    new Response(null, { status: 204 }),
  ];
  for (const original of values) {
    const before = await original.clone().arrayBuffer();
    const context = contextModule.createRequestContext(new Request("https://synthetic.invalid/api/controller-exports"), "/api/controller-exports");
    const result = await boundary.finalizeApiResponse(original, context);
    assert.equal(result.status, original.status);
    assert.deepEqual(await result.arrayBuffer(), before);
    for (const [key, value] of original.headers) assert.equal(result.headers.get(key), value);
    assert.equal(result.headers.get("X-Request-ID"), context.correlationId);
  }
});

test("failure compatibility aliases remain closed and preserve only trusted service aggregates", async () => {
  for (const route of ["/api/notifications/parts-order", "/api/notifications/dispatch/drain", "/api/notifications/financial/drain", "/api/email-intake"]) {
    const context = contextModule.createRequestContext(new Request(`https://synthetic.invalid${route}`), route);
    context.failureLogged = true;
    const original = { code: "PROVIDER_UNAVAILABLE", error: marker, message: marker, fields: [{ path: "amount", message: marker }], success: false,
      status: "partial", claimed: 2, failed: 1, providerPayload: marker, phone: "+15005550006", runId: crypto.randomUUID(),
      summary: { accepted: 1, unknown: 1, resultCode: "RUN_PARTIAL", providerPayload: marker },
      results: [{ action: "failed", logStatus: "unconfirmed", logError: "PROVIDER_UNAVAILABLE", error: marker, email: "synthetic@example.invalid" }] };
    const result = await boundary.finalizeApiResponse(Response.json(original, { status: 503 }), context);
    const projected = await safeFailure(result, context.correlationId);
    assert.equal("success" in projected && projected.success, false);
    assert.equal("message" in projected && projected.message, errorMetadata("PROVIDER_UNAVAILABLE").message);
    assert.equal("claimed" in projected && projected.claimed, 2);
    assert.equal("failed" in projected && projected.failed, 1);
    assert.deepEqual("fields" in projected && projected.fields, []);
    if (route === "/api/email-intake") assert.deepEqual("results" in projected && projected.results, [{ action: "failed", logStatus: "unconfirmed", logError: "PROVIDER_UNAVAILABLE" }]);
    else assert.deepEqual("summary" in projected && projected.summary, { accepted: 1, unknown: 1, resultCode: "RUN_PARTIAL" });
  }
});

test("financial validation aliases preserve field identity without copying free-form validation text", async () => {
  const context = contextModule.createRequestContext(new Request("https://synthetic.invalid/api/billing-invoices"), "/api/billing-invoices");
  context.failureLogged = true;
  const response = await boundary.finalizeApiResponse(Response.json({ code: "VALIDATION_FAILED", error: marker,
    fields: [{ path: "amount", message: marker }], success: false }, { status: 400 }), context);
  const projected = await safeFailure(response, context.correlationId);
  assert.equal(response.status, 400);
  assert.deepEqual("fields" in projected && projected.fields, [{ path: "amount", code: "INVALID_FIELD", message: "Check this field." }]);
  assert.deepEqual("fieldErrors" in projected && projected.fieldErrors, "fields" in projected && projected.fields);
});
