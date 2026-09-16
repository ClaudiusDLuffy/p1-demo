import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  safeVisitCorrectionError,
  validateVisitCorrection,
  VisitCorrectionError,
} from "./visitCorrection";

const validCorrection = {
  checkInAt: "2026-09-14T21:00:00.000Z",
  checkOutAt: "2026-09-14T23:00:00.000Z",
  originalCheckInAt: "2026-09-14T20:00:00.000Z",
  originalCheckOutAt: "2026-09-14T22:00:00.000Z",
  reason: "Corrected from technician timesheet",
  nowMs: Date.parse("2026-09-15T00:00:00.000Z"),
};

test("visit corrections reject invalid time order before calling the RPC", () => {
  assert.throws(
    () => validateVisitCorrection({
      ...validCorrection,
      checkInAt: "2026-09-14T23:00:00.000Z",
      checkOutAt: "2026-09-14T21:00:00.000Z",
    }),
    (error: unknown) => error instanceof VisitCorrectionError
      && error.code === "VISIT_TIME_ORDER"
      && /check-out cannot be before/i.test(error.message),
  );
});

test("visit corrections mirror the server's bounded date and reason rules", () => {
  assert.doesNotThrow(() => validateVisitCorrection(validCorrection));
  for (const [changes, expectedCode] of [
    [{ reason: "no" }, "VISIT_REASON_REQUIRED"],
    [{ checkOutAt: "2026-09-15T00:06:00.000Z" }, "VISIT_TIME_FUTURE"],
    [{ checkInAt: "2026-09-10T00:00:00.000Z" }, "VISIT_DURATION_LIMIT"],
    [{
      checkInAt: validCorrection.originalCheckInAt,
      checkOutAt: validCorrection.originalCheckOutAt,
    }, "VISIT_TIMES_UNCHANGED"],
  ] as const) {
    assert.throws(
      () => validateVisitCorrection({ ...validCorrection, ...changes }),
      (error: unknown) => error instanceof VisitCorrectionError
        && error.code === expectedCode,
    );
  }
});

test("visit correction errors expose only exact reviewed business guidance", () => {
  assert.match(
    safeVisitCorrectionError({
      code: "P0001",
      message: "The corrected time overlaps another visit for this technician",
    }).message,
    /overlap another visit/i,
  );
  const unknown = safeVisitCorrectionError({
    code: "P0001",
    message: "private customer/token/path detail",
  });
  assert.equal(unknown.code, "VISIT_CORRECTION_UNCONFIRMED");
  assert.doesNotMatch(unknown.message, /customer|token|path/i);
});

test("database adapters use workflow-specific safe error boundaries", () => {
  const db = readFileSync("src/lib/db.ts", "utf8");
  const visitStart = db.indexOf("export async function correctWorkOrderVisit");
  const visitEnd = db.indexOf("export type ActivityAuditOptions", visitStart);
  const visitCorrection = db.slice(visitStart, visitEnd);
  assert.match(visitCorrection, /if \(error\) throw safeVisitCorrectionError\(error\)/);
});

test("an unchanged rejected visit correction cannot generate repeated conflict requests", () => {
  const timeline = readFileSync("src/features/work-orders/VisitTimeline.tsx", "utf8");
  assert.match(timeline, /const \[rejectedCorrection, setRejectedCorrection\] = useState<string \| null>\(null\)/);
  assert.match(timeline, /rejectedCorrection === correctionFingerprint/);
  assert.match(timeline, /failure\.code === "VISIT_TIME_OVERLAP" \|\| failure\.code === "VISIT_CHANGED"/);
});

test("capital quote saves capture an exact work-order version and handle thrown API rejections", () => {
  const modal = readFileSync(
    "src/features/billing/BillingInvoiceCreateModal.tsx",
    "utf8",
  );
  assert.match(modal, /void refetchExactWorkOrder\(\)[\s\S]*captureStaffInvoiceSnapshot\([\s\S]*result\.data/);
  assert.doesNotMatch(modal, /selectedWorkOrderId \? selectedWorkOrder : null/);
  assert.match(modal, /recordStaffFinancialAttemptError\(financialAttempt\.current, err\)/);
  assert.match(modal, /if \(!financialContextReady\)/);
  assert.match(modal, /disabled=\{submitting \|\| !financialContextReady\}/);
});
