import assert from "node:assert/strict";
import test from "node:test";
import { intakeErrorMessage } from "./intakeError";

test("preserves native error messages", () => {
  assert.equal(intakeErrorMessage(new Error("Graph timeout"), "fallback"), "Graph timeout");
});

test("exposes Supabase error objects instead of reporting unknown processing error", () => {
  assert.equal(
    intakeErrorMessage({
      message: "duplicate key value violates unique constraint",
      code: "23505",
      details: "Key (incident_id)=(INC26457189) already exists.",
    }, "unknown processing error"),
    "duplicate key value violates unique constraint (code 23505; Key (incident_id)=(INC26457189) already exists.)",
  );
});

test("uses the supplied fallback for non-descriptive values", () => {
  assert.equal(intakeErrorMessage(null, "unknown processing error"), "unknown processing error");
});
