import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { correlatedFetch, currentRequestOperation, runRequestOperation, withRequestCorrelation } from "./server/requestOperation";
import { createRequestContext } from "./observability/requestContext";
import { safeLog } from "./observability/safeLogger";
import { createTwilioPartsSms } from "./server/twilioPartsSms";
import { ConfigurationError } from "./config/shared";

const context = () => createRequestContext(new Request("https://synthetic.invalid/api/billing-invoices", {
  headers: { "X-Request-ID": crypto.randomUUID() },
}), "/api/billing-invoices");
const gate = () => {
  let release: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
};

test("request operation context survives awaits and restores the outside scope", async () => {
  assert.equal(currentRequestOperation(), undefined);
  const expected = context();
  const response = new Response("synthetic-response");
  assert.equal(await runRequestOperation(expected, async () => {
    assert.equal(currentRequestOperation(), expected);
    await Promise.resolve();
    assert.equal(currentRequestOperation(), expected);
    return response;
  }), response);
  assert.equal(currentRequestOperation(), undefined);
});

test("two overlapping request scopes never share correlation or failure-log state", async () => {
  const first = context(); const second = context();
  const entered = gate(); const releaseFirst = gate(); const releaseSecond = gate();
  let started = 0;
  const execute = (expected: ReturnType<typeof context>, release: ReturnType<typeof gate>) => runRequestOperation(expected, async () => {
    if (++started === 2) entered.release();
    await release.ready;
    assert.equal(currentRequestOperation(), expected);
    const current = currentRequestOperation(); assert.ok(current); current.failureLogged = true;
    await Promise.resolve();
    return currentRequestOperation()?.correlationId;
  });
  const firstResult = execute(first, releaseFirst);
  const secondResult = execute(second, releaseSecond);
  await entered.ready;
  assert.equal(currentRequestOperation(), undefined);
  releaseSecond.release();
  assert.equal(await secondResult, second.correlationId);
  assert.equal(first.failureLogged, false);
  releaseFirst.release();
  assert.equal(await firstResult, first.correlationId);
  assert.equal(currentRequestOperation(), undefined);
});

test("nested scope rejection restores the parent and outer rejection restores no scope", async () => {
  const parent = context(); const child = context();
  const failure = new Error("synthetic-failure");
  await assert.rejects(runRequestOperation(parent, async () => {
    await assert.rejects(runRequestOperation(child, async () => {
      await Promise.resolve(); assert.equal(currentRequestOperation(), child); throw failure;
    }), error => error === failure);
    assert.equal(currentRequestOperation(), parent);
    throw failure;
  }), error => error === failure);
  assert.equal(currentRequestOperation(), undefined);
});

test("unscoped correlated fetch preserves the original transport input and options", async () => {
  const originalFetch = globalThis.fetch;
  const input = new URL("https://synthetic.invalid/rest/v1/records");
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
  const response = Response.json({ accepted: true });
  let calls = 0;
  globalThis.fetch = async (actualInput, actualInit) => {
    calls++; assert.equal(actualInput, input); assert.equal(actualInit, init); return response;
  };
  try { assert.equal(await correlatedFetch(input, init), response); assert.equal(calls, 1); }
  finally { globalThis.fetch = originalFetch; }
});

test("scoped fetch adds only safe correlation without changing credentials, operation UUID, body or abort", async () => {
  const originalFetch = globalThis.fetch;
  const expected = context(); const operationId = crypto.randomUUID();
  const controller = new AbortController();
  const headers = new Headers({ Authorization: "Bearer synthetic-service-token", apikey: "synthetic-service-key", "Content-Type": "application/json", "X-Request-ID": crypto.randomUUID() });
  const previousId = headers.get("X-Request-ID");
  const body = JSON.stringify({ p_operation_id: operationId });
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const sent = new Headers(init?.headers);
    assert.equal(sent.get("X-Request-ID"), expected.correlationId);
    assert.equal(sent.get("authorization"), "Bearer synthetic-service-token");
    assert.equal(sent.get("apikey"), "synthetic-service-key");
    assert.equal(init?.body, body); assert.equal(init?.signal, controller.signal);
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    return Response.json({ accepted: true });
  };
  try {
    await runRequestOperation(expected, () => correlatedFetch("https://synthetic.invalid/rest/v1/rpc/synthetic", {
      method: "POST", headers, body, signal: controller.signal, redirect: "error",
    }));
    assert.equal(calls, 1); assert.equal(headers.get("X-Request-ID"), previousId);
  } finally { globalThis.fetch = originalFetch; }
});

test("Request-owned headers remain intact while its scoped clone gains correlation", async () => {
  const originalFetch = globalThis.fetch;
  const expected = context();
  const request = new Request("https://synthetic.invalid/rest/v1/records", { headers: { Authorization: "Bearer synthetic-caller-token" } });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, request);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer synthetic-caller-token");
    assert.equal(headers.get("X-Request-ID"), expected.correlationId);
    return Response.json({ data: [] });
  };
  try {
    await runRequestOperation(expected, () => correlatedFetch(request));
    assert.equal(request.headers.has("X-Request-ID"), false);
    assert.equal(request.bodyUsed, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("malformed inbound references and private fields never become outbound correlation or scoped log content", async () => {
  const originalFetch = globalThis.fetch;
  const expected = createRequestContext(new Request("https://synthetic.invalid/api/billing-invoices", {
    headers: { "X-Request-ID": "synthetic@example.invalid?token=synthetic-private-token" },
  }), "/api/billing-invoices");
  const logs: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const id = new Headers(init?.headers).get("X-Request-ID");
    assert.equal(id, expected.correlationId); assert.match(id ?? "", /^[a-f0-9-]{36}$/);
    return Response.json({ data: [] });
  };
  try {
    await runRequestOperation(expected, async () => {
      await correlatedFetch("https://synthetic.invalid/rest/v1/records");
      const scoped = currentRequestOperation(); assert.ok(scoped);
      safeLog("operation_failure", scoped, { code: "PROVIDER_UNAVAILABLE", Authorization: "synthetic-private-token",
        providerResponse: "synthetic-private-body", email: "synthetic@example.invalid", phone: "+15005550006" }, line => logs.push(line));
    });
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0]).correlationId, expected.correlationId);
    assert.doesNotMatch(logs[0], /synthetic-private|synthetic@example|15005550006|Authorization/);
  } finally { globalThis.fetch = originalFetch; }
});

test("server Supabase uses correlated fetch by default but preserves an explicitly injected bounded transport", async () => {
  const filename = resolve("src/lib/supabase/server.ts");
  const requireHere = createRequire(import.meta.url);
  const choices: unknown[] = [];
  const exports: { createServerClient?: (options?: { fetch?: typeof fetch }) => unknown } = {};
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, require: (name: string): unknown => {
    if (name === "@supabase/supabase-js") return { createClient: (_url: string, _key: string, options: { global: { fetch: unknown } }) => { choices.push(options.global.fetch); return {}; } };
    if (name.endsWith("/config/server/supabase")) return { getServerSupabaseConfig: () => ({ url: "https://synthetic.invalid", secret: "synthetic-service-key" }) };
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  assert.ok(exports.createServerClient);
  const expected = context(); const controller = new AbortController(); let called = 0;
  const injected: typeof fetch = async (_input, init) => {
    called++; assert.equal(init?.signal, controller.signal);
    assert.equal(new Headers(init?.headers).get("X-Request-ID"), expected.correlationId);
    return Response.json({ data: [] });
  };
  exports.createServerClient(); exports.createServerClient({ fetch: injected });
  assert.equal(choices[0], correlatedFetch);
  const selected = choices[1]; assert.equal(typeof selected, "function");
  await runRequestOperation(expected, () => (selected as typeof fetch)("https://synthetic.invalid/rest/v1/records", { signal: controller.signal }));
  assert.equal(called, 1);
});

test("a reusable injected transport reads the current request at call time and propagates abort without swallowing failures", async () => {
  const first = context(); const second = context(); const controller = new AbortController();
  const seen: (string | null)[] = []; const failure = new Error("synthetic-transport-failure");
  const transport = withRequestCorrelation(async (_input, init) => {
    seen.push(new Headers(init?.headers).get("X-Request-ID"));
    assert.equal(init?.signal, controller.signal);
    throw failure;
  });
  for (const expected of [first, second]) {
    await assert.rejects(runRequestOperation(expected, () => transport("https://synthetic.invalid/rest/v1/records", { signal: controller.signal })), error => error === failure);
  }
  assert.deepEqual(seen, [first.correlationId, second.correlationId]);
  assert.equal(currentRequestOperation(), undefined);
});

test("worker summary logs retain bounded outcome counters and classify failed HTTP results without content", () => {
  const logs: string[] = []; const expected = context(); const runId = crypto.randomUUID();
  assert.equal(safeLog("parts_sms_worker_run", expected, { runId, claimed: 3, sent: 1, unknown: 1, notDeliverable: 1,
    recoveredUnknown: 1, superseded: 2, configured: false, status: 503, code: "CONFIG_INCOMPLETE", statusChecked: 100_001,
    accepted: -1, failed: Infinity, providerResponse: "synthetic-private-body" }, line => logs.push(line)), true);
  const row = JSON.parse(logs[0]);
  assert.equal(row.level, "error"); assert.equal(row.status, 503); assert.equal(row.runId, runId);
  assert.equal(row.sent, 1); assert.equal(row.notDeliverable, 1); assert.equal(row.recoveredUnknown, 1); assert.equal(row.configured, false);
  for (const field of ["statusChecked", "accepted", "failed", "providerResponse"]) assert.equal(Object.hasOwn(row, field), false);
});

for (const injected of [false, true]) test(`Twilio ${injected ? "injected" : "default"} send/status transport carries scope without changing provider outcomes`, async () => {
  const originalFetch = globalThis.fetch; const expected = context();
  const sid = `SM${"a".repeat(32)}`; const calls: string[] = [];
  const configuration = { accountSid: `AC${"b".repeat(32)}`, username: `AC${"b".repeat(32)}`,
    password: "synthetic-password", messagingServiceSid: `MG${"c".repeat(32)}`, from: "" };
  const send: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get("X-Request-ID"), expected.correlationId);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from(`${configuration.username}:${configuration.password}`).toString("base64")}`);
    assert.ok(init?.signal); assert.equal(init.redirect, "error");
    calls.push(init?.method ?? "GET");
    if (init?.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("To"), "+15005550006"); assert.equal(body.get("Body"), "synthetic-parts-request");
      assert.equal(body.has("correlationId"), false);
      return Response.json({ sid, status: "queued" }, { status: 201 });
    }
    assert.ok(String(input).endsWith(`/${sid}.json`));
    return Response.json({ sid, status: "delivered" });
  };
  globalThis.fetch = injected ? async () => { throw new Error("Injected transport was bypassed"); } : send;
  try {
    const provider = createTwilioPartsSms(configuration, injected ? { fetch: send } : {});
    await runRequestOperation(expected, async () => {
      assert.deepEqual(await provider.send({ phoneE164: "+15005550006", body: "synthetic-parts-request" }), { status: "accepted", sid, providerStatus: "queued" });
      assert.deepEqual(await provider.lookup(sid), { status: "observed", providerStatus: "delivered" });
    });
    assert.deepEqual(calls, ["POST", "GET"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Graph send transport preserves its confirmed acceptance contract while forwarding correlation", async () => {
  const filename = resolve("src/lib/graphClient.ts"); const requireHere = createRequire(import.meta.url);
  const originalFetch = globalThis.fetch; const expected = context(); let calls = 0;
  const exports: { sendEmail?: (token: string, to: string[], subject: string, body: string, signal?: AbortSignal, requireAccepted?: boolean) => Promise<void> } = {};
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("X-Request-ID"), expected.correlationId);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-provider-token");
    assert.ok(init?.signal); assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { message: { subject: "synthetic-subject", body: { contentType: "Text", content: "synthetic-body" },
      toRecipients: [{ emailAddress: { address: "synthetic@example.invalid" } }] }, saveToSentItems: true });
    return new Response(null, { status: 202 });
  };
  try {
    runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, AbortController, AbortSignal, URLSearchParams, setTimeout, clearTimeout, require: (name: string): unknown => {
        if (name.endsWith("/config/server/graph")) return { requireGraphConfig: () => ({ userEmail: "synthetic@example.invalid" }) };
        return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
      } }, { filename });
    const send = exports.sendEmail; assert.ok(send);
    await runRequestOperation(expected, () => send("synthetic-provider-token", ["synthetic@example.invalid"], "synthetic-subject", "synthetic-body", undefined, true));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

for (const family of ["receiving", "financial", "parts"] as const) {
  for (const mode of ["success", "configuration", "throw"] as const) test(`${family} ${mode} drain emits one correlated boundary-owned outcome log`, async () => {
    const path = family === "receiving" ? "notifications/dispatch/drain" : family === "financial" ? "notifications/financial/drain" : "notifications/parts-order";
    const filename = resolve(`src/app/api/${path}/route.ts`); const requireHere = createRequire(import.meta.url);
    const originalInfo = console.info; const logs: string[] = []; const id = crypto.randomUUID();
    const exports: { GET?: (request: Request) => Promise<Response> } = {};
    const summary = { runId: crypto.randomUUID(), claimed: 1, sent: 0, accepted: 0, unknown: 1, notDeliverable: 0,
      recurrenceQueued: 0, recurrenceBlocked: 0, heartbeatConfirmed: true, resultCode: mode === "configuration" ? "TWILIO_NOT_CONFIGURED" : "RUN_COMPLETE",
      evaluation: "queued", configurationCode: mode === "configuration" ? "CONFIG_INCOMPLETE" : null };
    const worker = async () => {
      assert.equal(currentRequestOperation()?.correlationId, id);
      if (mode === "throw") throw new Error("synthetic-private-provider-error");
      return summary;
    };
    console.info = (line: unknown) => { assert.equal(typeof line, "string"); logs.push(String(line)); };
    try {
      runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { exports, require: (name: string): unknown => {
          if (name.endsWith("/config/server/cron")) return { isCronAuthorized: () => true, assertScheduledJobsAllowed: () => undefined };
          if (name.endsWith("/config/server/graph")) return { graphDeliveryConfigurationError: () => mode === "configuration" ? new ConfigurationError("CONFIG_INCOMPLETE", "graph") : null };
          if (name.endsWith("/server/receivingDispatchWorker")) return { drainReceivingDispatches: worker };
          if (name.endsWith("/server/financialNotificationWorker")) return { drainFinancialNotifications: worker };
          if (name.endsWith("/server/partsSmsWorker")) return { drainPartsSms: worker };
          return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
        } }, { filename });
      const get = exports.GET; assert.ok(get);
      const request = new Request(`https://synthetic.invalid/api/${path}`, { headers: { "X-Request-ID": id } });
      Object.defineProperty(request, "nextUrl", { value: new URL(request.url) });
      const response = await get(request);
      assert.equal(response.status, mode === "success" ? 200 : 503);
      assert.equal(logs.length, 1);
      const log = JSON.parse(logs[0]); assert.equal(log.correlationId, id);
      assert.equal(log.level, mode === "success" ? "info" : "error");
      assert.equal(log.status, response.status);
      assert.doesNotMatch(logs[0], /synthetic-private-provider-error|phone|authorization|providerResponse/);
      assert.equal(response.headers.get("X-Request-ID"), id);
    } finally { console.info = originalInfo; }
  });
}

const routes = ["billing-invoices", "contractor-invoice-holds", "contractor-invoices", "contractor-technicians/manage", "controller-exports",
  "email-intake", "invoice-pdf/parse-total", "notifications/assignment-removal", "notifications/contractor-attention", "notifications/dispatch",
  "notifications/dispatch/drain", "notifications/financial/drain", "notifications/invoice-review", "notifications/parts-order", "parts-order-settings",
  "private-objects/cancel", "private-objects/delete", "private-objects/finalize", "private-objects/intents", "private-objects/reconcile",
  "quickbooks/callback", "quickbooks/connect", "quickbooks/connection"] as const;

for (const route of routes) test(`${route}: existing outer error boundary owns one awaited request scope around its complete flow`, () => {
  const path = `src/app/api/${route}/route.ts`;
  const source = readFileSync(path, "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let contexts = 0; let scopes = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const statements = node.body.statements;
      const declaration = statements.find(statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(item => item.initializer && ts.isCallExpression(item.initializer)
          && ts.isIdentifier(item.initializer.expression) && item.initializer.expression.text === "createRequestContext"));
      if (declaration) {
        contexts++;
        const boundary = statements.find(ts.isTryStatement); assert.ok(boundary?.catchClause);
        assert.equal(boundary.tryBlock.statements.length, 1);
        const returned = boundary.tryBlock.statements[0]; assert.ok(ts.isReturnStatement(returned));
        assert.ok(returned.expression && ts.isAwaitExpression(returned.expression));
        const call = returned.expression.expression; assert.ok(ts.isCallExpression(call));
        assert.ok(ts.isIdentifier(call.expression)); assert.equal(call.expression.text, "runRequestOperation");
        assert.equal(call.arguments[0].getText(ast), "context");
        const body = call.arguments[1]; assert.ok(ts.isArrowFunction(body) && ts.isBlock(body.body));
        assert.ok(body.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword));
        assert.match(boundary.catchClause.getText(ast), /return errorResponse\(boundaryError, context\)/);
        scopes++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(contexts > 0); assert.equal(scopes, contexts);
  assert.match(source, /import \{ runRequestOperation \} from ".*\/server\/requestOperation"/);
});

test("server operation scope is not a global mutable request context or a browser module", () => {
  const source = readFileSync("src/lib/server/requestOperation.ts", "utf8");
  assert.match(source, /node:async_hooks/);
  assert.match(source, /operations\.run\(context, operation\)/);
  assert.doesNotMatch(source, /enterWith\(|globalThis\.|process\.env|["']use client["']/);
  assert.equal(routes.length, 23);
});
