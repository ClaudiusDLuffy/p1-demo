import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";
import { controllerBoundaryHarness } from "../server/controller-exports/testing/boundaryHarness";
import { controllerGraphHarness, controllerScopeFake } from "../server/controller-exports/testing/scopeFake";
import {
  CONTROLLER_EXPORT_BODY_BYTES, parseControllerExportGet, parseControllerExportStage,
  parseControllerExportTransition, readControllerExportBody,
} from "../server/controller-exports/contracts";
import { controllerModuleHarness } from "../server/controller-exports/testing/moduleHarness";
import {
  controllerAuthorizationPorts, controllerTestIds as ids,
  type ControllerAuthorizationOptions,
} from "../server/controller-exports/testing/authorizationPorts";

const url = (query = "") => new URL(`https://synthetic.invalid/api/controller-exports${query}`);
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === expected);
const request = (body?: string, init: RequestInit = {}) => new Request(url(), {
  method: "POST", headers: { Authorization: "Bearer synthetic-controller" },
  ...(body === undefined ? {} : { body }), ...init,
});
const uuid = (index: number) => `81000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const parseStage = async (input: Request) => parseControllerExportStage(await readControllerExportBody(input));
const parseTransition = async (input: Request) => parseControllerExportTransition(await readControllerExportBody(input));

for (const [query, expected] of [
  ["", { mode: "queue" }], ["?mode=unknown&limit=1&cursor=invalid", { mode: "queue" }],
  ["?history=true", { mode: "queue" }], ["?batch=%20&history=1", { mode: "history", format: "json", filter: {} }],
  [`?batch=${ids.batch}&history=1&format=csv`, { mode: "download", batchId: ids.batch }],
  ["?history=1", { mode: "history", format: "json", filter: {} }],
  ["?history=1&format=csv&from=2026-09-01&to=2026-09-30", { mode: "history", format: "csv", filter: { from: "2026-09-01", toExclusive: "2026-10-01T00:00:00.000Z" } }],
  [`?history=1&actor=${ids.actor}`, { mode: "history", format: "json", filter: { actor: ids.actor } }],
  ["?history=1&from=invalid&to=invalid&actor=invalid", { mode: "history", format: "json", filter: {} }],
] as const) test(`controller GET contract preserves mode precedence ${query || "queue"}`, () => {
  assert.deepEqual(parseControllerExportGet(url(query)), expected);
});
test("controller GET rejects an invalid selected download identity", () => {
  assert.throws(() => parseControllerExportGet(url("?batch=not-a-uuid&history=1")), code("INVALID_REQUEST"));
});
for (const body of ["{}", '{"invoiceIds":[]}', '{"unknown":"ignored","operationId":"not-an-operation-contract"}']) {
  test(`controller POST automatic queue is explicit for ${body}`, async () => {
    assert.deepEqual(await parseStage(request(body)), { mode: "automatic" });
  });
}
test("controller POST trims and deduplicates selected UUID identities without inventing an operation", async () => {
  const result = await parseStage(request(JSON.stringify({ invoiceIds: [` ${ids.invoice} `, ids.invoice], actorId: ids.otherActor })));
  assert.deepEqual(result, { mode: "selected", invoiceIds: [ids.invoice] });
});
test("controller POST accepts exactly 500 distinct invoices", async () => {
  const invoiceIds = Array.from({ length: 500 }, (_, i) => uuid(i + 1));
  assert.deepEqual(await parseStage(request(JSON.stringify({ invoiceIds }))), { mode: "selected", invoiceIds });
});
test("controller POST rejects 501 invoices before eligibility or archive work", async () => {
  await assert.rejects(parseStage(request(JSON.stringify({ invoiceIds: Array.from({ length: 501 }, (_, i) => uuid(i + 1)) }))), code("INVALID_REQUEST"));
});
for (const [label, body] of [
  ["empty", ""], ["invalid JSON", "{"], ["null body", "null"], ["array body", "[]"],
  ["primitive body", "true"], ["string IDs", '{"invoiceIds":"invalid"}'],
  ["null IDs", '{"invoiceIds":null}'], ["null element", '{"invoiceIds":[null]}'],
  ["numeric element", '{"invoiceIds":[1]}'], ["boolean element", '{"invoiceIds":[false]}'],
  ["empty element", '{"invoiceIds":[""]}'], ["object element", '{"invoiceIds":[{}]}'],
  ["mixed invalid selection", JSON.stringify({ invoiceIds: [ids.invoice, "bad"] })],
] as const) test(`controller POST malformed ${label} never falls back to automatic export`, async () => {
  await assert.rejects(parseStage(request(body)), code("INVALID_REQUEST"));
});
test("controller actual byte bound accepts exactly 64KiB without requiring Content-Length", async () => {
  const body = `{${" ".repeat(CONTROLLER_EXPORT_BODY_BYTES - 2)}}`;
  assert.equal(new TextEncoder().encode(body).byteLength, 65_536);
  assert.deepEqual(await parseStage(request(body)), { mode: "automatic" });
});
test("controller actual byte bound rejects one byte over despite a lying Content-Length", async () => {
  const body = `{${" ".repeat(CONTROLLER_EXPORT_BODY_BYTES - 1)}}`;
  await assert.rejects(parseStage(request(body, { headers: { "Content-Length": "2" } })), code("PAYLOAD_TOO_LARGE"));
});
test("controller byte bound counts multibyte UTF-8 rather than string length", async () => {
  const body = JSON.stringify({ ignored: "é".repeat(33_000) });
  assert.ok(body.length < CONTROLLER_EXPORT_BODY_BYTES);
  await assert.rejects(parseStage(request(body)), code("PAYLOAD_TOO_LARGE"));
});
test("controller parser reads the actual byte stream once, never Request.json", async () => {
  const input = request("{}"); let calls = 0;
  Object.defineProperty(input, "json", { value: () => { calls++; throw new Error("Unexpected second JSON reader"); } });
  assert.deepEqual(await parseStage(input), { mode: "automatic" });
  assert.equal(calls, 0); assert.equal(input.bodyUsed, true);
});
test("controller parser abort before reading prevents command construction", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(parseStage(request("{}", { signal: abort.signal })), error => error instanceof DOMException && error.name === "AbortError");
});
test("controller parser cancellation interrupts a pending request body read", async () => {
  const abort = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body: stream, signal: abort.signal, duplex: "half" };
  const input = new Request(url(), init);
  const pending = parseStage(input).then(() => "completed", error => error instanceof DOMException && error.name === "AbortError" ? "aborted" : "other_error");
  await Promise.resolve(); abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([pending, new Promise<string>(resolve => { timer = setTimeout(() => resolve("still_waiting_for_body"), 50); })]);
  if (timer) clearTimeout(timer);
  // Unblock the deliberately stalled synthetic stream even on the red path.
  try { streamController?.close(); } catch { /* The corrected reader may already cancel it. */ }
  await pending;
  assert.equal(outcome, "aborted");
});
for (const action of ["confirm", "cancel"] as const) test(`controller PATCH ${action} preserves exact action fields`, async () => {
  const body = { batchId: ` ${ids.batch} `, action: ` ${action} `, reason: " Synthetic reason ", operationId: "ignored" };
  assert.deepEqual(await parseTransition(request(JSON.stringify(body))), {
    action, batchId: ids.batch, ...(action === "cancel" ? { reason: "Synthetic reason" } : {}),
  });
});
for (const [label, body] of [
  ["missing batch", { action: "confirm" }], ["invalid batch", { action: "confirm", batchId: "invalid" }],
  ["unknown action", { action: "CONFIRM", batchId: ids.batch }], ["boolean action", { action: true, batchId: ids.batch }],
  ["missing cancel reason", { action: "cancel", batchId: ids.batch }],
  ["blank cancel reason", { action: "cancel", batchId: ids.batch, reason: "  " }],
  ["coerced cancel reason", { action: "cancel", batchId: ids.batch, reason: 123 }],
  ["oversized cancel reason", { action: "cancel", batchId: ids.batch, reason: "x".repeat(501) }],
] as const) test(`controller PATCH rejects ${label}`, async () => {
  await assert.rejects(parseTransition(request(JSON.stringify(body))), code("INVALID_REQUEST"));
});
test("controller PATCH cancellation accepts exactly 500 reason characters", async () => {
  const reason = "x".repeat(500);
  assert.deepEqual(await parseTransition(request(JSON.stringify({ action: "cancel", batchId: ids.batch, reason }))), { action: "cancel", batchId: ids.batch, reason });
});

const authorize = (options: ControllerAuthorizationOptions = {}, input = request("{}")) => {
  const ports = controllerAuthorizationPorts(options);
  const runtime = controllerModuleHarness({ modules: ports.modules });
  return { ports, runtime, input,
    result: Promise.resolve(runtime.call("src/server/controller-exports/controllerExportContext.ts", "authorizeControllerExport", input)) };
};
for (const role of ["manager", "dispatcher", "back_office"]) {
  for (const permissions of [[], ["invoice_controller"], ["quickbooks_export"], ["quickbooks_handoff"], ["invoice_controller", "quickbooks_handoff"]]) {
    test(`controller authorization preserves ${role} with grants ${permissions.join(",") || "none"}`, async () => {
      const h = authorize({ role, permissions }); const result: unknown = await h.result;
      assert.ok(result && typeof result === "object" && "actor" in result && "signal" in result && "dataSession" in result);
      const actor = result.actor;
      assert.ok(actor && typeof actor === "object" && "role" in actor && "canHandoff" in actor && "userId" in actor);
      assert.equal(actor.role, role); assert.equal(actor.canHandoff, permissions.includes("quickbooks_handoff"));
      assert.equal(actor.userId, ids.actor); assert.equal(result.dataSession, h.ports.session); assert.equal(result.signal, h.input.signal);
      assert.equal(h.ports.calls.filter(call => call.name === "getUser").length, 1);
      assert.equal(h.ports.calls.filter(call => call.name === "read:profiles").length, 1);
      assert.equal(h.ports.calls.filter(call => call.name === "read:staff_permission_grants").length, 1);
      assert.equal(h.runtime.networkCalls(), 0);
    });
  }
}
for (const role of ["contractor", "contractor_member", "technician", "report_only", "former_technician", "invoice_controller"]) {
  test(`controller authorization denies non-staff base role ${role} despite handoff grant`, async () => {
    const h = authorize({ role, permissions: ["quickbooks_handoff"] });
    await assert.rejects(h.result, code("FORBIDDEN"));
    assert.equal(h.ports.calls.filter(call => call.name === "read:staff_permission_grants").length, 0);
  });
}
for (const [label, options, expected] of [
  ["inactive", { active: false }, "FORBIDDEN"], ["missing profile", { missingProfile: true }, "FORBIDDEN"],
  ["invalid token", { invalidToken: true }, "AUTH_REQUIRED"],
  ["auth provider rejection", { authFailure: { message: "Synthetic private auth failure" } }, "AUTH_REQUIRED"],
  ["profile failure", { profileFailure: { code: "42501", message: "Synthetic private SQL detail" } }, "INTERNAL_ERROR"],
  ["different profile identity", { returnedProfileId: ids.otherActor }, "INTERNAL_ERROR"],
  ["malformed profile", { profileResult: { id: ids.actor, name: null, role: "manager", active: "true" } }, "INTERNAL_ERROR"],
  ["missing profile projection", { profileResult: { id: ids.actor, role: "manager", active: true } }, "INTERNAL_ERROR"],
  ["missing auth error field", { authResult: { data: { user: { id: ids.actor } } } }, "AUTH_REQUIRED"],
  ["false auth error field", { authResult: { data: { user: { id: ids.actor } }, error: false } }, "AUTH_REQUIRED"],
  ["missing profile error field", { profileEnvelope: { data: { id: ids.actor, name: null, role: "manager", active: true } } }, "INTERNAL_ERROR"],
  ["false profile error field", { profileEnvelope: { data: { id: ids.actor, name: null, role: "manager", active: true }, error: false } }, "INTERNAL_ERROR"],
  ["missing grants error field", { permissionEnvelope: { data: [{ permission: "quickbooks_handoff" }] } }, "INTERNAL_ERROR"],
  ["false grants error field", { permissionEnvelope: { data: [{ permission: "quickbooks_handoff" }], error: false } }, "INTERNAL_ERROR"],
  ["malformed permission row", { permissionResult: [{ permission: true }] }, "INTERNAL_ERROR"],
  ["null permission result", { permissionResult: null }, "INTERNAL_ERROR"],
] as const) test(`controller actual authorization rejects ${label}`, async () => {
  const h = authorize(options); await assert.rejects(h.result, code(expected));
});
test("controller anonymous authorization performs no SDK or privileged query", async () => {
  const h = authorize({}, request("{}", { headers: {} }));
  await assert.rejects(h.result, code("AUTH_REQUIRED")); assert.equal(h.ports.calls.length, 0);
});
test("controller authorization does not consume caller-supplied role/company identity", async () => {
  const input = request(JSON.stringify({ role: "manager", companyId: ids.actor, staffPermissions: ["quickbooks_handoff"] }));
  const h = authorize({ role: "contractor", permissions: [] }, input);
  await assert.rejects(h.result, code("FORBIDDEN")); assert.equal(input.bodyUsed, false);
});
test("controller profile and grant query transports receive the request-owned signal", async () => {
  const h = authorize(); await h.result;
  assert.equal(h.ports.calls.find(call => call.name === "signal:profiles")?.value, h.input.signal);
  assert.equal(h.ports.calls.find(call => call.name === "signal:staff_permission_grants")?.value, h.input.signal);
  assert.equal(h.ports.calls.find(call => call.name === "retry:profiles")?.value, false);
  assert.equal(h.ports.calls.find(call => call.name === "retry:staff_permission_grants")?.value, false);
});
test("controller auth and privileged SDK fetch options forward cancellation to the real transport seam", async () => {
  const ports = controllerAuthorizationPorts(); const seen: (AbortSignal | null | undefined)[] = [];
  const runtime = controllerModuleHarness({ modules: ports.modules,
    fetch: async (_input, init) => { seen.push(init?.signal); return Response.json({}); } });
  const input = request("{}");
  await runtime.call("src/server/controller-exports/controllerExportContext.ts", "authorizeControllerExport", input);
  const publicFetch = ports.publicFetch(); const privilegedFetch = ports.privilegedFetch();
  assert.equal(typeof publicFetch, "function"); assert.equal(typeof privilegedFetch, "function");
  await publicFetch!("https://synthetic.invalid/auth"); await privilegedFetch!("https://synthetic.invalid/rest");
  assert.equal(seen.length, 2); assert.equal(seen[0], input.signal); assert.equal(seen[1], input.signal);
});
for (const abortAfterProfile of [false, true]) test(`controller installed auth/PostgREST SDK transports preserve exact request signal; abortAfterProfile=${abortAfterProfile}`, async () => {
  const abort = new AbortController(); const input = request("{}", { signal: abort.signal });
  const paths: string[] = []; const signals: (AbortSignal | null | undefined)[] = [];
  const runtime = controllerModuleHarness({ modules: {
    "@supabase/supabase-js": { createClient },
    [resolve("src/lib/supabase/server.ts")]: { createServerClient: (options: { fetch: typeof fetch }) => createClient<Database>("https://synthetic.invalid", "synthetic-service-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: options.fetch },
    }) },
  }, fetch: async (target, init) => {
    const targetUrl = new URL(target instanceof Request ? target.url : String(target));
    assert.equal(targetUrl.origin, "https://synthetic.invalid");
    paths.push(targetUrl.pathname); signals.push(init?.signal);
    if (targetUrl.pathname === "/auth/v1/user") return Response.json({ id: ids.actor });
    if (targetUrl.pathname === "/rest/v1/profiles") {
      assert.equal(targetUrl.searchParams.get("select"), "id,name,role,active");
      assert.equal(targetUrl.searchParams.get("id"), `eq.${ids.actor}`);
      if (abortAfterProfile) abort.abort();
      return Response.json({ id: ids.actor, name: "Synthetic controller", role: "manager", active: true });
    }
    if (targetUrl.pathname === "/rest/v1/staff_permission_grants") return Response.json([{ permission: "quickbooks_handoff" }]);
    throw new Error(`Unexpected synthetic auth URL ${targetUrl.pathname}`);
  } });
  const result = Promise.resolve(runtime.call("src/server/controller-exports/controllerExportContext.ts", "authorizeControllerExport", input));
  if (abortAfterProfile) await assert.rejects(result, error => error instanceof DOMException && error.name === "AbortError");
  else await result;
  assert.deepEqual(paths, ["/auth/v1/user", "/rest/v1/profiles", ...(abortAfterProfile ? [] : ["/rest/v1/staff_permission_grants"])]);
  assert.ok(signals.every(signal => signal === input.signal));
});

const routeRequest = (method: string, query = "", body?: unknown, init: RequestInit = {}) => new Request(url(query), {
  method, headers: { Authorization: "Bearer synthetic-controller", "X-Request-ID": ids.request },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), ...init,
});
const safeFailure = async (response: Response, status: number, expectedCode: string) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("x-request-id"), ids.request);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body: unknown = await response.json();
  assert.ok(body && typeof body === "object" && "code" in body && "correlationId" in body && "error" in body);
  assert.equal(body.code, expectedCode); assert.equal(body.correlationId, ids.request);
  assert.equal(typeof body.error, "string");
  assert.doesNotMatch(JSON.stringify(body), /Synthetic private|stack|SQL detail|provider body|line description|Bearer/i);
  assert.deepEqual(Object.keys(body).sort(), ["code", "correlationId", "error"]);
};

for (const [query, expectedMethod, expectedCommand] of [
  ["", "list", { mode: "queue" }],
  ["?history=1", "list", { mode: "history", format: "json", filter: {} }],
  [`?batch=${ids.batch}`, "list", { mode: "download", batchId: ids.batch }],
] as const) test(`actual controller GET route dispatches ${expectedCommand.mode} through auth/parser/HTTP mapping`, async () => {
  const h = controllerBoundaryHarness(); const input = routeRequest("GET", query);
  const response = await h.route("GET", input);
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-request-id"), ids.request);
  assert.equal(h.service.constructed.length, 1); assert.equal(h.service.calls.length, 1);
  assert.equal(h.service.calls[0]?.method, expectedMethod);
  assert.deepEqual(JSON.parse(JSON.stringify(h.service.calls[0]?.command)), expectedCommand);
  assert.equal(h.service.calls[0]?.context.actor.userId, ids.actor);
  assert.equal(h.service.calls[0]?.context.requestId, ids.request);
  assert.equal(h.service.calls[0]?.context.signal, input.signal);
  assert.ok(h.loaded.some(path => path.endsWith("/app/api/controller-exports/route.ts")));
  assert.ok(h.loaded.some(path => path.endsWith("/controller-exports/httpBoundary.ts")));
  assert.equal(h.loaded.some(path => path.includes("legacyRouteImplementation")), false);
  const body: unknown = await response.json();
  if (expectedCommand.mode === "queue") assert.deepEqual(body, { count: 1, limit: 500, canHandoff: true, pendingCount: 0, oldestPendingAt: null });
  if (expectedCommand.mode === "history") assert.deepEqual(body, { history: [], actors: [] });
  if (expectedCommand.mode === "download") {
    assert.deepEqual(body, { batchId: ids.batch, downloadUrl: "https://synthetic.invalid/private-download", filename: "Synthetic-archive.zip", format: "reference_manifest_v2" });
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal(h.networkCalls(), 0); assert.equal(h.logs.length, 0);
});
test("actual controller CSV route streams established UTF-8 bytes without JSON conversion", async () => {
  const h = controllerBoundaryHarness(); const response = await h.route("GET", routeRequest("GET", "?history=1&format=csv"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "text/csv;charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Synthetic-history.csv"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(bytes, new TextEncoder().encode(`\uFEFFBatch ID,Status\r\n${ids.batch},pending\r\n`));
});
test("actual controller POST returns unchanged private stage receipt, never archive bytes", async () => {
  const h = controllerBoundaryHarness(); const response = await h.route("POST", routeRequest("POST", "", { invoiceIds: [ids.invoice] }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-request-id"), ids.request);
  assert.deepEqual(await response.json(), { batchId: ids.batch, status: "pending", downloadUrl: "https://synthetic.invalid/private-download",
    filename: "Contractor-Bills-2026-09-12-81000000-000.zip", format: "reference_manifest_v2", archiveSha256: "a".repeat(64), archiveBytes: 42 });
  assert.equal(h.service.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.service.calls[0]?.command)), { mode: "selected", invoiceIds: [ids.invoice] });
});
for (const action of ["confirm", "cancel"] as const) test(`actual controller PATCH ${action} retains compatible receipt`, async () => {
  const h = controllerBoundaryHarness(); const response = await h.route("PATCH", routeRequest("PATCH", "", { action, batchId: ids.batch, reason: "Synthetic reason" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-request-id"), ids.request);
  assert.deepEqual(await response.json(), { batch: action === "confirm"
    ? { applied: true, batchId: ids.batch, status: "confirmed", invoiceCount: 1, total: 120, confirmedAt: "2026-09-12T00:00:00.000Z", confirmedBy: ids.actor }
    : { applied: true, batchId: ids.batch, status: "cancelled", reason: "Synthetic reason", cancelledAt: "2026-09-12T00:00:00.000Z", cancelledBy: ids.actor } });
  assert.equal(h.service.calls.length, 1); assert.equal(h.service.calls[0]?.method, "transition");
});
for (const [method, query, body] of [
  ["POST", "", "{"], ["POST", "", { invoiceIds: [null] }], ["POST", "", { invoiceIds: Array.from({ length: 501 }, (_, i) => uuid(i + 1)) }],
  ["PATCH", "", { action: "invalid", batchId: ids.batch }], ["PATCH", "", { action: "cancel", batchId: ids.batch, reason: false }],
  ["GET", "?batch=invalid", undefined],
] as const) test(`actual controller ${method} invalid contract makes zero application/archive/storage calls ${query || JSON.stringify(body)?.slice(0, 35)}`, async () => {
  const h = controllerBoundaryHarness(); const response = await h.route(method, routeRequest(method, query, body));
  await safeFailure(response, 400, "INVALID_REQUEST"); assert.equal(h.service.constructed.length, 0); assert.equal(h.service.calls.length, 0);
  assert.equal(h.logs.length, 1); assert.equal(h.networkCalls(), 0);
});
for (const [method, query, body] of [
  ["POST", "", "{"], ["PATCH", "", "{"], ["GET", "?batch=invalid", undefined],
] as const) test(`actual controller ${method} preserves handoff denial before malformed input`, async () => {
  const h = controllerBoundaryHarness({ authorization: { permissions: ["quickbooks_export"] } });
  const input = routeRequest(method, query, body); const response = await h.route(method, input);
  await safeFailure(response, 403, "FORBIDDEN"); assert.equal(input.bodyUsed, false);
  assert.equal(h.service.constructed.length, 0); assert.equal(h.service.calls.length, 0); assert.equal(h.logs.length, 1);
});
for (const query of ["", "?history=1"]) test(`actual controller GET ${query || "queue"} permits operational staff without handoff grant`, async () => {
  const h = controllerBoundaryHarness({ authorization: { permissions: [] } });
  const response = await h.route("GET", routeRequest("GET", query));
  assert.equal(response.status, 200); assert.equal(h.service.calls.length, 1);
  if (!query) assert.deepEqual(await response.json(), { count: 1, limit: 500, canHandoff: false, pendingCount: 0, oldestPendingAt: null });
});
for (const [label, cause, status, expected] of [
  ["standard Error", new Error("Synthetic private provider body"), 500, "INTERNAL_ERROR"],
  ["Postgres failure", { code: "42501", detail: "Synthetic private SQL detail", message: "Synthetic private line description" }, 403, "FORBIDDEN"],
  ["abort", new DOMException("Synthetic private provider body", "AbortError"), 408, "REQUEST_ABORTED"],
  ["timeout", new DOMException("Synthetic private provider body", "TimeoutError"), 504, "TIMEOUT"],
] as const) test(`actual controller final boundary redacts ${label} and logs once`, async () => {
  const h = controllerBoundaryHarness({ result: () => { throw cause; } });
  const response = await h.route("POST", routeRequest("POST", "", {}));
  await safeFailure(response, status, expected); assert.equal(h.logs.length, 1);
  assert.doesNotMatch(h.logs.join("\n"), /Synthetic private|SQL detail|provider body|line description|Bearer/);
});
test("actual controller logging failure cannot replace its original safe conflict response", async () => {
  const h = controllerBoundaryHarness({ loggingFailure: true, result: () => ({ kind: "failed", code: "CONFLICT", status: 409, outcome: "known_rejected" }) });
  const response = await h.route("POST", routeRequest("POST", "", {}));
  await safeFailure(response, 409, "CONFLICT"); assert.equal(h.logs.length, 1); assert.equal(h.service.calls.length, 1);
});
test("actual controller OPTIONS and unsupported methods preserve method boundary", async () => {
  const h = controllerBoundaryHarness();
  const options = await h.route("OPTIONS", routeRequest("OPTIONS"));
  assert.equal(options.status, 204); assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS, PATCH, POST");
  for (const method of ["PUT", "DELETE"]) {
    const response = await h.route(method, routeRequest(method)); await safeFailure(response, 405, "METHOD_NOT_ALLOWED");
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS, PATCH, POST");
  }
  assert.equal(h.ports.calls.length, 0); assert.equal(h.service.calls.length, 0);
});

for (const [method, query, body, owner, expectedCalls] of [
  ["GET", "", undefined, "listControllerExports.ts", ["eligibility:queue"]],
  ["GET", "?history=1", undefined, "listControllerExports.ts", ["history:recent"]],
  ["GET", `?batch=${ids.batch}`, undefined, "listControllerExports.ts", ["download:sign"]],
  ["POST", "", { invoiceIds: [ids.invoice] }, "stageControllerExport.ts", ["eligibility:selected", "package:prepare", "attempt:create", "archive:build", "storage:upload", "storage:sign", "command:stage"]],
  ["PATCH", "", { batchId: ids.batch, action: "confirm" }, "transitionControllerExport.ts", ["command:confirm"]],
  ["PATCH", "", { batchId: ids.batch, action: "cancel", reason: "Synthetic cancel" }, "transitionControllerExport.ts", ["command:cancel"]],
] as const) test(`controller real application graph ${method} ${owner} preserves dependency sequence`, async () => {
  const h = controllerGraphHarness(); const response = await h.route(method, routeRequest(method, query, body));
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-request-id"), ids.request);
  assert.deepEqual(h.calls, expectedCalls);
  assert.equal(h.contexts.length, 1);
  for (const file of ["/app/api/controller-exports/route.ts", "/controller-exports/httpBoundary.ts", "/controller-exports/applicationService.ts", `/controller-exports/${owner}`, "/controller-exports/httpMapper.ts"]) {
    assert.ok(h.loaded.some(path => path.endsWith(file)), `Real runtime owner not executed: ${file}`);
  }
  assert.equal(h.loaded.some(path => path.includes("legacyRouteImplementation")), false);
  assert.equal(h.networkCalls(), 0);
});
test("controller real stage graph known rejected command reconciles absence before exact object cleanup", async () => {
  const fake = controllerScopeFake();
  fake.scope.stage.commands.execute = async command => { fake.calls.push("command:stage"); fake.commands.push(command); return { status: "known_rejected", code: "40001", cause: new Error("Synthetic private conflict") }; };
  fake.scope.stage.reconciliation.resolve = async (_command, result) => {
    fake.calls.push("command:reconcile"); assert.equal(result.status, "known_rejected");
    return { status: "known_rejected", code: "40001", cause: new Error("Synthetic private conflict"), absenceConfirmed: true };
  };
  const h = controllerGraphHarness({ scope: fake }); const response = await h.route("POST", routeRequest("POST", "", {}));
  await safeFailure(response, 409, "CONFLICT");
  assert.deepEqual(h.calls.slice(-3), ["command:stage", "command:reconcile", "storage:cleanup"]);
  assert.equal(h.commands.length, 1); assert.equal(h.commands[0]?.batchId, ids.batch);
});
for (const phase of ["upload", "stage"] as const) test(`controller real stage graph preserves unresolved ${phase} without unsafe cleanup`, async () => {
  const fake = controllerScopeFake();
  if (phase === "upload") fake.scope.stage.storage.upload = async () => { fake.calls.push("storage:upload"); return { status: "unknown", ownership: "unverified" }; };
  else fake.scope.stage.commands.execute = async command => { fake.calls.push("command:stage"); fake.commands.push(command); return { status: "outcome_unknown", code: "CONTROLLER_EXPORT_OUTCOME_UNKNOWN", cause: new Error("Synthetic private lost response") }; };
  const h = controllerGraphHarness({ scope: fake }); const response = await h.route("POST", routeRequest("POST", "", {}));
  await safeFailure(response, 500, "INTERNAL_ERROR"); assert.equal(h.calls.includes("storage:cleanup"), false);
  assert.equal(h.calls.filter(call => call === "attempt:create").length, 1);
  assert.equal(h.commands.length, phase === "upload" ? 0 : 1);
  assert.equal(h.calls.filter(call => call === "storage:reconcile").length, phase === "upload" ? 1 : 0);
});
test("controller real stage graph retains committed receipt after a late command abort", async () => {
  const abort = new AbortController(); const fake = controllerScopeFake();
  const execute = fake.scope.stage.commands.execute;
  fake.scope.stage.commands.execute = async command => { const result = await execute(command); abort.abort(); return result; };
  const h = controllerGraphHarness({ scope: fake });
  const response = await h.route("POST", routeRequest("POST", "", {}, { signal: abort.signal,
    headers: { Authorization: "Bearer synthetic-controller", "X-Request-ID": ids.request } }));
  assert.equal(response.status, 200); assert.equal(h.commands.length, 1); assert.equal(h.calls.includes("storage:cleanup"), false);
  assert.equal((await response.json()).status, "pending");
});
test("controller real graph prevents every dependency after abort before authorization", async () => {
  const abort = new AbortController(); abort.abort(); const h = controllerGraphHarness();
  const response = await h.route("POST", routeRequest("POST", "", {}, { signal: abort.signal,
    headers: { Authorization: "Bearer synthetic-controller", "X-Request-ID": ids.request } }));
  await safeFailure(response, 408, "REQUEST_ABORTED"); assert.equal(h.calls.length, 0); assert.equal(h.ports.calls.length, 0);
});
