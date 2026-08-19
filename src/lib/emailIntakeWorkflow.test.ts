import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BILLING_ONLY_INTAKE_REASON,
  billingOnlyIntakeFields,
} from "./emailIntakeWorkflow";

test("do-not-dispatch intake goes directly to billing without an assignment", () => {
  assert.deepEqual(
    billingOnlyIntakeFields("2026-08-19T18:06:07.640Z"),
    {
      status: "pending_invoice",
      functional_status: "Completed",
      contractor_id: null,
      assigned_technician_profile_id: null,
      technician_on_job: null,
      technician_assigned_at: null,
      technician_assigned_by: null,
      contractor_assignment_started_at: null,
      eta: null,
      dispatched_at: null,
      sla_started_at: null,
      billing_only: true,
      billing_ready_at: "2026-08-19T18:06:07.640Z",
      billing_ready_by: null,
    },
  );
  assert.match(BILLING_ONLY_INTAKE_REASON, /notifications suppressed/);
});

test("the processor creates billing-only dispatches without resolving or notifying a contractor", () => {
  const source = readFileSync(
    new URL("./emailIntakeProcessor.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /parsed\.doNotDispatch\)[\s\S]{0,80}do not dispatch flag detected/);
  assert.match(source, /const contractor = billingOnly \? null : await resolveContractor\(parsed\)/);
  assert.match(source, /if \(billingOnly\)[\s\S]*BILLING_ONLY_ACTIVITY[\s\S]*else if \(contractor\)/);
});
