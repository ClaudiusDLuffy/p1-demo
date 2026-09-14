import assert from "node:assert/strict";
import test from "node:test";
import { sendClientReport } from "./observability/clientReportTransport";
import { redact, redactText } from "./observability/redaction";
import { errorMetadata } from "./errors/catalog";
import { safeLog } from "./observability/safeLogger";
import { createRequestContext } from "./observability/requestContext";

test("client diagnostic transport omits free-form stack and replaces message with a catalog value", async () => {
  const correlationId = crypto.randomUUID();
  let outbound = "";
  const result = await sendClientReport({ version: 1, code: "INTERNAL_ERROR", correlationId,
    level: "error", source: "synthetic_fixture", message: "SYNTHETIC_PRIVATE_MESSAGE", stack: "SYNTHETIC_PRIVATE_STACK" }, {
    token: async () => "synthetic-token",
    fetch: async (_input, init) => {
      outbound = String(init?.body);
      return Response.json({ accepted: true, correlationId }, { status: 202, headers: { "X-Request-ID": correlationId } });
    },
  });
  assert.equal(result.status, "accepted");
  assert.doesNotMatch(outbound, /SYNTHETIC_PRIVATE_MESSAGE|SYNTHETIC_PRIVATE_STACK|"stack"/);
  assert.equal(JSON.parse(outbound).message, errorMetadata("INTERNAL_ERROR").message);
});

test("nested diagnostic redaction masks contact, content and provider-identity keys", () => {
  const value = redact({ nested: { phone: 15005550006, email: "synthetic@example.invalid", smsBody: "SYNTHETIC_SMS_BODY",
    twilioAccountSid: `AC${"a".repeat(32)}`, providerResponse: "SYNTHETIC_PROVIDER_BODY", customerDescription: "SYNTHETIC_CUSTOMER_TEXT" } });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /15005550006|synthetic@example|SYNTHETIC_SMS_BODY|AC[a-f0-9]{32}|SYNTHETIC_PROVIDER_BODY|SYNTHETIC_CUSTOMER_TEXT/);
});

test("free-form diagnostic redaction also masks unformatted test phone and provider SID values", () => {
  const redacted = redactText(`phone 15005550006 provider AC${"a".repeat(32)} message SM${"b".repeat(32)}`);
  assert.doesNotMatch(redacted, /15005550006|AC[a-f0-9]{32}|SM[a-f0-9]{32}/);
});

test("safe logger never emits rejected diagnostic text even when mixed with allowed fields", () => {
  const logs: string[] = [];
  const context = createRequestContext(new Request("https://example.invalid/api/client-errors"), "/api/client-errors");
  assert.equal(safeLog("client_diagnostic", context, { code: "INTERNAL_ERROR", count: 2,
    message: "SYNTHETIC_PRIVATE_MESSAGE", stack: "SYNTHETIC_PRIVATE_STACK", phone: "+15005550006", providerResponse: "SYNTHETIC_PROVIDER_BODY" }, line => logs.push(line)), true);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /SYNTHETIC_|15005550006/);
  assert.equal(JSON.parse(logs[0]).count, 2);
});

test("diagnostic transport settles a token lookup that ignores cancellation", async () => {
  const result = await sendClientReport({ version: 1, code: "INTERNAL_ERROR", level: "error", source: "synthetic_fixture", message: "SYNTHETIC_PRIVATE" }, {
    token: () => new Promise(() => undefined),
    fetch: async () => { throw new Error("Unexpected fetch"); },
    timeoutMs: 5,
  });
  assert.equal(result.status, "unavailable");
});

test("diagnostic transport bounds a stalled send and propagates abort", async () => {
  let signal: AbortSignal | null | undefined;
  const result = await sendClientReport({ version: 1, code: "INTERNAL_ERROR", level: "error", source: "synthetic_fixture", message: "SYNTHETIC_PRIVATE" }, {
    token: async () => "synthetic-token",
    fetch: async (_input, init) => { signal = init?.signal; return new Promise<Response>(() => undefined); },
    timeoutMs: 5,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(signal?.aborted, true);
});

test("diagnostic transport never claims acceptance for a mismatched receipt", async () => {
  const result = await sendClientReport({ version: 1, code: "INTERNAL_ERROR", level: "error", source: "synthetic_fixture", message: "SYNTHETIC_PRIVATE" }, {
    token: async () => "synthetic-token",
    fetch: async () => Response.json({ accepted: true, correlationId: crypto.randomUUID() }, { status: 202 }),
  });
  assert.equal(result.status, "unavailable");
});

test("redaction never invokes indexed array getters or an overridden slice method", () => {
  let reads = 0;
  const input: unknown[] = [];
  Object.defineProperty(input, "0", { get() { reads++; return "SYNTHETIC_ARRAY_GETTER"; } });
  Object.defineProperty(input, "slice", { value() { reads++; return ["SYNTHETIC_SLICE_OVERRIDE"]; } });
  assert.deepEqual(redact(input), ["[UNSUPPORTED]"]);
  assert.equal(reads, 0);
});

test("invalid redaction maxima cannot bypass the absolute string cap", () => {
  for (const maximum of [-1, -2_000, Number.NaN, Infinity, -Infinity, 1.5]) {
    assert.ok(redactText("x".repeat(25_000), maximum).length <= 2_000);
  }
  assert.equal(redactText("fixture", 0), "");
  assert.equal(redactText("fixture", 3), "fix");
  assert.ok(redactText("eyJa ".repeat(5_000)).length <= 2_000);
});
