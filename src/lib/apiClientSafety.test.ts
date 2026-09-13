import assert from "node:assert/strict";
import test from "node:test";
import { apiFetch } from "./errors/apiFetch";
import { AppError } from "./errors/AppError";
import { parseApiError } from "./errors/clientApiError";
import { safeErrorMessage } from "./errors/normalizeUnknown";
import { queryRetry } from "./errors/retryPolicy";
const id = "77777777-7777-4777-8777-777777777777";

test("API parser retains safe domain code/reference but never arbitrary body messages", async () => {
  const error = await parseApiError(Response.json({ code: "TWILIO_UNKNOWN", error: "Bearer synthetic-private-token", stack: "private-worker" },
    { status: 502, headers: { "X-Request-ID": id } }));
  assert.equal(error.code, "TWILIO_UNKNOWN"); assert.equal(error.correlationId, id);
  assert.equal(queryRetry(0, error), false); assert.doesNotMatch(safeErrorMessage(error), /synthetic|private-worker|Bearer/);
});
for (const body of ["<html>private provider detail</html>", "", "{invalid", "x".repeat(16_385)]) {
  test(`malformed/oversized API error is safe (${body.length} bytes)`, async () => {
    const error = await parseApiError(new Response(body, { status: 503 }));
    assert.equal(error.code, "PROVIDER_UNAVAILABLE"); assert.doesNotMatch(error.message, /private provider|invalid|xxx/);
  });
}
test("first-party success payload and response identity remain untouched", async () => {
  const expected = Response.json({ queued: true, operationId: id });
  assert.equal(await apiFetch("/api/synthetic", undefined, async () => expected), expected);
});
for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
  test(`${method} transport failure remains unconfirmed and never query-retryable`, async () => {
    let requests = 0;
    await assert.rejects(apiFetch("/api/synthetic", { method }, async () => { requests++; throw new TypeError("Failed to fetch"); }), error => {
      assert.ok(error instanceof AppError); assert.equal(error.code, "RESULT_UNCONFIRMED"); assert.equal(queryRetry(0, error), false); return true;
    });
    assert.equal(requests, 1);
  });
}
test("safe read transport failure may retry twice; no fetch helper retries itself", async () => {
  let requests = 0;
  await assert.rejects(apiFetch("/api/synthetic", undefined, async () => { requests++; throw new TypeError("Failed to fetch"); }), error => {
    assert.ok(error instanceof AppError); assert.equal(error.code, "NETWORK_UNAVAILABLE");
    assert.equal(queryRetry(0, error), true); assert.equal(queryRetry(1, error), true); assert.equal(queryRetry(2, error), false); return true;
  });
  assert.equal(requests, 1);
});
