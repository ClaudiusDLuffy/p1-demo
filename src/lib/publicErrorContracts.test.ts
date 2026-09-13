import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { normalizeUnknownError } from "./errors/normalizeUnknown";
import { publicError } from "./errors/publicError";
import { queryRetry, queryRetryDelay } from "./errors/retryPolicy";
import { normalizeCorrelationId } from "./observability/correlationId";

test("unknown SQL/provider details never become public messages", () => {
  const cause = new Error("synthetic SQL SELECT private_table password=fixture-secret");
  const error = normalizeUnknownError(cause);
  assert.equal(error.cause, cause);
  assert.equal(error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(publicError(error, crypto.randomUUID())), /SELECT|password|fixture-secret|stack/);
});
for (const [sql, code] of [["42501", "FORBIDDEN"], ["23505", "CONFLICT"], ["PT409", "STALE_VERSION"], ["22023", "VALIDATION_FAILED"], ["P0002", "NOT_FOUND"]]) {
  test(`normalizes structured database ${sql} without its message`, () => {
    assert.equal(normalizeUnknownError({ code: sql, message: "synthetic private detail" }).code, code);
  });
}
for (const status of [400, 401, 403, 404, 409, 413, 415, 422]) {
  test(`deterministic HTTP ${status} is never query-retried`, () => assert.equal(queryRetry(0, { status }), false));
}
test("transient reads are bounded; unknown delivery is never retried", () => {
  assert.equal(queryRetry(0, new AppError("NETWORK_UNAVAILABLE")), true);
  assert.equal(queryRetry(2, new AppError("NETWORK_UNAVAILABLE")), false);
  assert.equal(queryRetry(0, new AppError("DELIVERY_UNKNOWN")), false);
  assert.equal(queryRetry(0, new AppError("RESULT_UNCONFIRMED")), false);
  assert.ok(queryRetryDelay(100, new AppError("RATE_LIMITED")) <= 10_000);
});
test("correlation input accepts only normalized UUIDs, never tokens", () => {
  const valid = crypto.randomUUID();
  assert.equal(normalizeCorrelationId(valid.toUpperCase()), valid);
  for (const value of [undefined, "Bearer fixture-token", "x".repeat(500), "a\r\nb"]) {
    assert.match(normalizeCorrelationId(value), /^[0-9a-f-]{36}$/);
    assert.notEqual(normalizeCorrelationId(value), value);
  }
});
