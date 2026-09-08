import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(process.cwd(), "src/lib/emailAssignmentRemovalProcessor.ts"),
  "utf8",
);

test("email assignment removal uses only the private durable claim", () => {
  assert.match(source, /export async function deliverEmailAssignmentRemoval\(/);
  assert.match(source, /claim_email_assignment_removal_delivery/);
  assert.doesNotMatch(
    source,
    /claim_contractor_assignment_transition_delivery/,
  );
  assert.match(source, /transitionType !== "unassigned"/);
  assert.doesNotMatch(source, /p_actor_id/);
});

test("delivery validates transport before claiming and never automatically resends uncertain states", () => {
  const deliver = source.slice(
    source.indexOf("export async function deliverEmailAssignmentRemoval"),
    source.indexOf("export async function drainEmailAssignmentRemovals"),
  );

  assert.ok(
    deliver.indexOf("requireAccessToken(accessToken)")
      < deliver.indexOf("claim_email_assignment_removal_delivery"),
  );
  assert.match(deliver, /claim\.claimStatus === "already_sent"/);
  assert.match(deliver, /claim\.claimStatus === "not_deliverable"/);
  assert.match(deliver, /claim\.claimStatus === "pending_or_unknown"/);
  assert.match(deliver, /claim\.claimStatus === "delivery_unknown"/);
  assert.match(deliver, /claim\.claimStatus !== "new_claim"/);
  assert.equal((deliver.match(/await sendEmail\(/g) || []).length, 1);
  assert.doesNotMatch(deliver, /retry|setTimeout/);
});

test("delivery sends the claimed snapshot and records sent or unknown exactly once", () => {
  const deliver = source.slice(
    source.indexOf("export async function deliverEmailAssignmentRemoval"),
    source.indexOf("export async function drainEmailAssignmentRemovals"),
  );

  assert.match(deliver, /claim\.outgoingContractorEmail/);
  assert.match(deliver, /claim\.externalWorkOrderId \|\| claim\.workOrderId/);
  assert.match(deliver, /createWorkOrderAssignmentRemovalNotificationPlan/);
  assert.match(deliver, /await sendEmail\(accessToken/);
  assert.equal(
    (deliver.match(/complete_contractor_assignment_transition_delivery/g) || []).length,
    1,
  );
  assert.match(deliver, /complete\("unknown", message\)/);
  assert.match(deliver, /complete\("sent", null\)/);
  assert.match(deliver, /Leave the row claimed/);
});

test("drain is restricted to pending intake-owned deliveries and is bounded deterministically", () => {
  const drain = source.slice(
    source.indexOf("export async function drainEmailAssignmentRemovals"),
  );

  assert.match(drain, /\.from\("email_priority_escalation_events"\)/);
  assert.match(
    drain,
    /contractor_assignment_transition_deliveries!email_priority_escalation_assignment_removal_delivery_fkey!inner/,
  );
  assert.match(drain, /\.eq\("assignment_delivery\.status", "pending"\)/);
  assert.match(drain, /\.order\("created_at", \{ ascending: true \}\)/);
  assert.match(drain, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(drain, /\.limit\(EMAIL_ASSIGNMENT_REMOVAL_BATCH_SIZE\)/);
  assert.match(source, /EMAIL_ASSIGNMENT_REMOVAL_BATCH_SIZE = 10/);
  assert.match(drain, /Promise\.all/);
  assert.match(drain, /deliverEmailAssignmentRemoval\(id, accessToken\)/);
});
