import assert from "node:assert/strict";
import test from "node:test";
import { firstValidationIssue } from "./validationErrors";

test("preferred visible form order wins over object insertion order", () => {
  assert.deepEqual(firstValidationIssue({
    lines: [{ rate: { message: "Rate is required" } }],
    territory: { message: "Territory is required" },
  }, ["territory", "lines"]), {
    path: "territory",
    message: "Territory is required",
  });
});

test("nested array errors retain their registered field path", () => {
  assert.deepEqual(firstValidationIssue({
    lines: [{ qty: { message: "Qty must be greater than 0", ref: {} } }],
  }), {
    path: "lines.0.qty",
    message: "Qty must be greater than 0",
  });
});

test("field-array root errors navigate to the field group", () => {
  assert.deepEqual(firstValidationIssue({
    lines: { root: { message: "At least one line item is required" } },
  }), {
    path: "lines",
    message: "At least one line item is required",
  });
  assert.equal(firstValidationIssue({}), null);
});
