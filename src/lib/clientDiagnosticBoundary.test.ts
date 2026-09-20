import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { handleClientDiagnostic, type DiagnosticDependencies } from "./server/diagnostics/handler";
import { sendClientReport } from "./observability/clientReportTransport";
import { clientReportSchema, CLIENT_DIAGNOSTIC_BODY_BYTES, CLIENT_REPORT_ACCEPTED_HEADER } from "./observability/clientReportContracts";
import { redact, redactText } from "./observability/redaction";
import { createRequestContext } from "./observability/requestContext";
import { logBoundaryFailure, safeLog } from "./observability/safeLogger";

const payload = () => ({ version: 1, code: "INTERNAL_ERROR", level: "error", source: "synthetic_test", message: "Synthetic operation failed." });
const request = (body: string, length?: string) => new Request("https://portal.example.invalid/api/client-errors", {
  method: "POST", headers: { "Content-Type": "application/json", ...(length === undefined ? {} : { "Content-Length": length }) }, body,
});
function ports(options: { auth?: string; allowed?: boolean; logFailure?: boolean } = {}) {
  const seen = { admitted: 0, logged: 0 };
  const dependencies: DiagnosticDependencies = {
    authorize: async () => { if (options.auth) throw new AppError(options.auth === "inactive" ? "ACCOUNT_INACTIVE" : "AUTH_REQUIRED"); return crypto.randomUUID(); },
    admit: async () => { seen.admitted++; return { allowed: options.allowed !== false, retryAfterSeconds: 60 }; },
    log: () => { seen.logged++; return !options.logFailure; },
  };
  return { seen, dependencies };
}
for (const length of [undefined, "1", String(CLIENT_DIAGNOSTIC_BODY_BYTES)]) {
  test(`actual diagnostic bytes cannot bypass cap with declared ${length ?? "absent"} length`, async () => {
    const h = ports(); const body = JSON.stringify(payload()).padEnd(CLIENT_DIAGNOSTIC_BODY_BYTES + 1, " ");
    const response = await handleClientDiagnostic(request(body, length), h.dependencies);
    assert.equal(response.status, 413); assert.equal(h.seen.logged, 0); assert.ok(response.headers.get("X-Request-ID"));
  });
}
test("exact cap succeeds and acknowledged response is correlated", async () => {
  const h = ports(); const response = await handleClientDiagnostic(request(JSON.stringify(payload()).padEnd(CLIENT_DIAGNOSTIC_BODY_BYTES, " ")), h.dependencies);
  assert.equal(response.status, 202); assert.equal(h.seen.logged, 1);
  assert.equal(response.headers.get(CLIENT_REPORT_ACCEPTED_HEADER), "1");
  assert.ok(response.headers.get("X-Request-ID"));
  assert.equal(await response.text(), "");
});
for (const auth of ["anonymous", "inactive"]) test(`diagnostics rejects ${auth} before admission/body`, async () => {
  const h = ports({ auth }); const req = request(JSON.stringify(payload()));
  const response = await handleClientDiagnostic(req, h.dependencies);
  assert.equal(response.status, auth === "inactive" ? 403 : 401); assert.equal(h.seen.admitted, 0); assert.equal(h.seen.logged, 0);
});
test("rate rejection is bounded and has no payload log", async () => {
  const h = ports({ allowed: false }); const response = await handleClientDiagnostic(request(JSON.stringify(payload())), h.dependencies);
  assert.equal(response.status, 429); assert.equal(h.seen.logged, 0); assert.equal(response.headers.get("retry-after"), "60");
});
for (const extra of [{ authorization: "synthetic" }, { details: { secret: "synthetic" } }, { context: { password: "synthetic" } }, { fullResponse: "synthetic" }]) {
  test(`closed diagnostic schema denies ${Object.keys(extra)[0]}`, () => assert.equal(clientReportSchema.safeParse({ ...payload(), ...extra }).success, false));
}
for (const status of [400, 401, 403, 413, 429, 500]) test(`reporter acknowledges HTTP ${status} without throwing`, async () => {
  const result = await sendClientReport(payload(), { token: async () => "synthetic-token", fetch: async () => new Response("private synthetic body", { status }) });
  assert.equal(result.status, status === 429 ? "rate_limited" : status >= 500 ? "unavailable" : "rejected");
});
test("reporter accepts only a correlated 202 header acknowledgment", async () => {
  const result = await sendClientReport(payload(), { token: async () => "synthetic-token", fetch: async (_url, init) => {
    const id = new Headers(init?.headers).get("X-Request-ID");
    return new Response(null, { status: 202, headers: {
      "X-Request-ID": String(id), [CLIENT_REPORT_ACCEPTED_HEADER]: "1",
    } });
  } });
  assert.equal(result.status, "accepted");
  assert.equal((await sendClientReport(payload(), { token: async () => "synthetic-token", fetch: async () => new Response(null, { status: 202 }) })).status, "unavailable");
});

test("reporter settles from a valid header receipt without reading a stalled WebKit-style body", async () => {
  const result = await sendClientReport(payload(), { token: async () => "synthetic-token", timeoutMs: 10, fetch: async (_url, init) => {
    const id = String(new Headers(init?.headers).get("X-Request-ID"));
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    return new Response(body, { status: 202, headers: {
      "X-Request-ID": id, [CLIENT_REPORT_ACCEPTED_HEADER]: "1",
    } });
  } });
  assert.equal(result.status, "accepted");
});
test("reporter bounds a never-resolving transport and aborts it", async () => {
  let signal: AbortSignal | null | undefined;
  const result = await sendClientReport(payload(), { token: async () => "synthetic-token", timeoutMs: 10,
    fetch: async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => undefined); } });
  assert.equal(result.status, "unavailable"); assert.equal(signal?.aborted, true);
});
test("preauth reporting and explicit abort make zero requests", async () => {
  let sent = 0; const fetcher: typeof fetch = async () => { sent++; throw new Error("Must not send"); };
  assert.equal((await sendClientReport(payload(), { token: async () => null, fetch: fetcher })).status, "unavailable");
  assert.equal((await sendClientReport(payload(), { token: async () => "synthetic", fetch: fetcher, signal: AbortSignal.abort() })).status, "aborted");
  assert.equal(sent, 0);
});
test("redaction bounds circular, nested, getter and synthetic secret values", () => {
  const input: Record<string, unknown> = { access_token: "synthetic-secret", nested: [{ Authorization: "Bearer fixture" }], message: "Bearer fixture-token", url: "https://fixture.invalid/private?token=fixture" };
  input.loop = input;
  const output = JSON.stringify(redact(input));
  assert.doesNotMatch(output, /synthetic-secret|fixture-token|token=fixture/);
  assert.match(output, /CIRCULAR/);
  assert.equal(redactText("synthetic@example.invalid +15555550123"), "[CONTACT] [CONTACT]");
  assert.doesNotThrow(() => redact(new Proxy({}, { ownKeys: () => { throw new Error("synthetic"); } })));
});
test("boundary owns one safe log and sink failure cannot replace primary error", () => {
  const context = createRequestContext(request("{}"), "/api/client-errors"); const lines: string[] = [];
  const error = new Error("synthetic private SQL token=fixture");
  logBoundaryFailure(context, error, line => lines.push(line)); logBoundaryFailure(context, error, line => lines.push(line));
  assert.equal(lines.length, 1); assert.doesNotMatch(lines[0], /private SQL|fixture/);
  assert.equal(safeLog("client_diagnostic", context, { authorization: "synthetic", code: "INTERNAL_ERROR" }, () => { throw new Error("sink unavailable"); }), false);
});
