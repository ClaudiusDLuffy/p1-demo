import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const route = readFileSync(
  resolve(process.cwd(), "src/app/api/notifications/assignment-removal/route.ts"),
  "utf8",
);
const notificationService = readFileSync(
  resolve(process.cwd(), "src/lib/notificationService.ts"),
  "utf8",
);

test("assignment-removal route accepts only a durable delivery identifier", () => {
  assert.match(route, /body\.deliveryId/);
  assert.doesNotMatch(route, /body\.(?:contractorId|contractorEmail|newContractorId)/);
  assert.match(route, /requireStaffRequest\(request\)/);
});

test("assignment-removal route claims once and records every terminal send outcome", () => {
  assert.match(route, /claim_contractor_assignment_transition_delivery/);
  assert.equal(
    (route.match(/complete_contractor_assignment_transition_delivery/g) || []).length,
    1,
  );
  assert.match(route, /claim\.claimStatus === "already_sent"/);
  assert.match(route, /claim\.claimStatus === "not_deliverable"/);
  assert.match(route, /claim\.claimStatus === "pending_or_unknown"/);
  assert.match(route, /claim\.claimStatus === "delivery_unknown"/);
  assert.match(route, /complete\("unknown", message\)/);
  assert.match(route, /complete\("sent", null\)/);
});

test("assignment-removal route sends only the server-claimed outgoing snapshot", () => {
  assert.match(route, /claim\.outgoingContractorEmail/);
  assert.match(route, /sendWorkOrderAssignmentRemovalNotification/);
  assert.doesNotMatch(route, /newContractor(?:Name|Email|Id)/);
  assert.doesNotMatch(route, /\.from\("profiles"\)/);
});

test("assignment-removal sender fails closed when Graph authentication is unavailable", () => {
  const senderStart = notificationService.indexOf(
    "export async function sendWorkOrderAssignmentRemovalNotification",
  );
  const senderEnd = notificationService.indexOf(
    "export async function sendContractorPortalPing",
  );
  const sender = notificationService.slice(senderStart, senderEnd);

  assert.match(sender, /const accessToken = await getAccessToken\(\)/);
  assert.match(sender, /if \(!accessToken\)/);
  assert.match(sender, /throw new Error\("Missing Graph access token"\)/);
  assert.match(sender, /await sendEmail\(/);
});
