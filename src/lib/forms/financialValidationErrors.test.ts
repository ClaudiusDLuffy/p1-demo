import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AppError } from "../errors/AppError";
import {
  financialValidationFocusPath,
  firstFinancialValidationIssue,
} from "./financialValidationErrors";

test("financial command validation preserves local field detail", () => {
  const parsed = z.object({ lines: z.array(z.object({ rate: z.number().max(10, "Rate is too high") })) })
    .safeParse({ lines: [{ rate: 11 }] });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  assert.deepEqual(firstFinancialValidationIssue(parsed.error), {
    path: "lines.0.rate",
    message: "Line 1 rate: Rate is too high",
  });
});

test("server-projected field errors use a safe useful label", () => {
  assert.deepEqual(firstFinancialValidationIssue(new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: ["territory"], message: "private rejected value" }],
  })), {
    path: "territory",
    message: "Territory needs review.",
  });
});

test("hidden financial metadata focuses the nearest editable control", () => {
  assert.equal(financialValidationFocusPath("expectedAssignmentVersion"), "workOrderId");
  assert.equal(financialValidationFocusPath("lines.4.markupPercent"), "lines.4.rate");
  assert.equal(financialValidationFocusPath("lines.4.sourceInvoiceLineId"), "lines.4.sourceReference");
  assert.equal(financialValidationFocusPath("lines.4.sourceWorkOrderPartId"), "lines.4.sourceReference");
  assert.equal(financialValidationFocusPath("territory"), "territory");
});
