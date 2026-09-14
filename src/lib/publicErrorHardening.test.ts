import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { normalizeUnknownError, safeErrorMessage } from "./errors/normalizeUnknown";
import { publicError } from "./errors/publicError";
import { queryRetry, queryRetryDelay } from "./errors/retryPolicy";
import { safeFieldErrors } from "./errors/fieldErrors";
import { coreErrorCodes } from "./errors/codes";
import { domainErrorCodes } from "./errors/domainCodes";
import { errorMetadata, isPublicErrorCode } from "./errors/catalog";
import { z } from "zod";

test("public projection re-derives the message after an AppError message was mutated", () => {
  const error = new AppError("FORBIDDEN");
  error.message = "SYNTHETIC_PRIVATE_DETAIL";
  assert.doesNotMatch(JSON.stringify(publicError(error, crypto.randomUUID())), /SYNTHETIC_PRIVATE_DETAIL/);
  assert.equal(safeErrorMessage(error), "You do not have permission to perform this action.");
});

test("mutated public field error entries are re-sanitized at projection", () => {
  const error = new AppError("VALIDATION_FAILED", { fieldErrors: [{ path: "amount" }] });
  assert.ok(error.fieldErrors);
  error.fieldErrors[0].message = "SYNTHETIC_PRIVATE_FIELD";
  assert.doesNotMatch(JSON.stringify(publicError(error, crypto.randomUUID())), /SYNTHETIC_PRIVATE_FIELD/);
});

test("forged AppError prototypes cannot bypass safe defaults", () => {
  const forged: unknown = Object.create(AppError.prototype);
  const normalized = normalizeUnknownError(forged);
  assert.equal(normalized.code, "INTERNAL_ERROR");
  assert.equal(normalized.status, 500);
  assert.doesNotThrow(() => publicError(normalized, crypto.randomUUID()));
});

test("hostile getters on an AppError are not invoked by normalization or projection", () => {
  const error = new AppError("FORBIDDEN");
  let reads = 0;
  Object.defineProperty(error, "message", { get() { reads++; throw new Error("SYNTHETIC_GETTER"); } });
  assert.doesNotThrow(() => publicError(error, crypto.randomUUID()));
  assert.equal(reads, 0);
});

test("hostile constructor option getters are not executed", () => {
  let reads = 0;
  const options = Object.defineProperty({}, "status", { get() { reads++; throw new Error("SYNTHETIC_GETTER"); } });
  assert.doesNotThrow(() => new AppError("FORBIDDEN", options));
  assert.equal(reads, 0);
});

test("field sanitization is bounded and does not execute array item getters", () => {
  const fields: unknown[] = [];
  let reads = 0;
  Object.defineProperty(fields, "0", { get() { reads++; throw new Error("SYNTHETIC_GETTER"); } });
  assert.doesNotThrow(() => safeFieldErrors(fields));
  assert.equal(reads, 0);
});

test("read retry fails closed when Retry-After exceeds the bounded retry delay", () => {
  assert.equal(queryRetry(0, new AppError("RATE_LIMITED", { retryAfterSeconds: 11 })), false);
  assert.equal(queryRetry(0, new AppError("RATE_LIMITED", { retryAfterSeconds: 60 })), false);
  assert.equal(queryRetry(0, new AppError("RATE_LIMITED", { retryAfterSeconds: 10 })), true);
});

test("catalog entries and aliases are complete, finite and immutable", () => {
  assert.equal(Object.isFrozen(coreErrorCodes), true);
  assert.equal(Object.isFrozen(domainErrorCodes), true);
  for (const code of [...Object.keys(coreErrorCodes), ...Object.keys(domainErrorCodes)]) {
    assert.ok(isPublicErrorCode(code));
    const metadata = errorMetadata(code);
    assert.equal(Object.isFrozen(metadata), true);
    assert.equal(typeof metadata.message, "string");
    assert.ok(metadata.message.length > 0 && metadata.message.length <= 250);
    assert.ok(Number.isInteger(metadata.status) && metadata.status >= 400 && metadata.status <= 599);
    assert.ok(["never", "safe_read", "reconcile"].includes(metadata.retry));
    assert.ok(["sign_in", "contact_admin", "correct_fields", "refresh_record", "retry_read", "wait", "reconcile", "contact_support"].includes(metadata.recovery));
  }
});

test("bounded retry rejects invalid counts and produces only finite delays", () => {
  const error = new AppError("NETWORK_UNAVAILABLE");
  for (const invalid of [Number.NaN, Infinity, -1, 0.5]) {
    assert.equal(queryRetry(invalid, error), false);
    assert.ok(Number.isFinite(queryRetryDelay(invalid, error)));
  }
});

test("normalization retains domain specificity, safe metadata and original cause", () => {
  const cause = new Error("SYNTHETIC_ORIGINAL");
  const correlationId = crypto.randomUUID();
  const original = new AppError("HOLD_NOTIFICATION_SUPERSEDED", { cause, correlationId, retryAfterSeconds: 12 });
  const normalized = normalizeUnknownError(original);
  assert.equal(normalized.code, original.code);
  assert.equal(normalized.cause, cause);
  assert.equal(normalized.correlationId, correlationId);
  assert.equal(normalized.retryAfterSeconds, 12);
});

test("safe own-data normalization preserves real Zod and native abort results", () => {
  const result = z.object({ amount: z.number() }).safeParse({ amount: "SYNTHETIC_INVALID" });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(normalizeUnknownError(result.error).fieldErrors, [{ path: "amount", code: "INVALID_FIELD", message: "Check this field." }]);
  assert.equal(normalizeUnknownError(new DOMException("SYNTHETIC_ABORT", "AbortError")).code, "REQUEST_ABORTED");
  assert.equal(normalizeUnknownError(new TypeError("Failed to fetch")).code, "NETWORK_UNAVAILABLE");
});

test("client display includes a validated support reference only where the catalog requests it", () => {
  const correlationId = crypto.randomUUID();
  for (const code of [...Object.keys(coreErrorCodes), ...Object.keys(domainErrorCodes)]) {
    assert.ok(isPublicErrorCode(code));
    const message = safeErrorMessage(new AppError(code, { correlationId }));
    assert.equal(message, errorMetadata(code).supportReference
      ? `${errorMetadata(code).message} Error reference: ${correlationId}`
      : errorMetadata(code).message);
  }
});

test("client support references exclude invalid, inherited and mutated private values", () => {
  const metadata = errorMetadata("INTERNAL_ERROR");
  assert.equal(safeErrorMessage(new AppError("INTERNAL_ERROR")), metadata.message);
  const error = new AppError("INTERNAL_ERROR", { correlationId: "SYNTHETIC_PRIVATE_REFERENCE" });
  assert.equal(safeErrorMessage(error), metadata.message);
  Object.defineProperty(error, "correlationId", { value: "SYNTHETIC_MUTATED_REFERENCE" });
  assert.equal(safeErrorMessage(error), metadata.message);
  let reads = 0;
  Object.defineProperty(error, "correlationId", { configurable: true, get() { reads++; return "SYNTHETIC_GETTER_REFERENCE"; } });
  assert.equal(safeErrorMessage(error), metadata.message);
  assert.equal(reads, 0);
  assert.equal(safeErrorMessage(Object.assign(Object.create({ correlationId: crypto.randomUUID() }), { code: "INTERNAL_ERROR" })), metadata.message);
});

test("dynamic record keys never become public validation path content", () => {
  const parsed = z.object({ details: z.record(z.string(), z.number()) }).safeParse({ details: { SYNTHETIC_PRIVATE_RECORD_KEY: "invalid" } });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const error = normalizeUnknownError(parsed.error);
  assert.deepEqual(error.fieldErrors, [{ path: "details.field", code: "INVALID_FIELD", message: "Check this field." }]);
  assert.doesNotMatch(JSON.stringify(publicError(error, crypto.randomUUID())), /SYNTHETIC_PRIVATE_RECORD_KEY/);
});

test("closed validation paths retain known form fields and bounded indices only", () => {
  const result = safeFieldErrors([
    { path: ["lines", 999, "rate"] }, { path: "recipients[24].phoneE164" },
    { path: ["sourceInvoiceIds", 0] }, { path: ["file", "sizeBytes"] },
    { path: ["parts", 2, "expectedReturnDate"] }, { path: ["expectedAssignmentVersion"] },
    { path: ["SYNTHETIC_SECRET", 15_005_550_006] },
  ]);
  assert.deepEqual(result?.map(item => item.path), ["lines.999.rate", "recipients[24].phoneE164", "sourceInvoiceIds.0", "file.sizeBytes", "parts.2.expectedReturnDate", "expectedAssignmentVersion", "field.field"]);
  assert.equal(safeFieldErrors(Array.from({ length: 100 }, () => ({ path: ["amount"] })))?.length, 20);
});
