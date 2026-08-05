import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeBillingActivity,
  isStaffBillingActivityViewer,
  visibleBillingActivities,
} from "./billingActivity";

const activities = [
  { id: "note", type: "note", eventKey: "note", text: "Technician found a failed fan motor.", createdAt: "2026-08-06T01:00:00Z" },
  { id: "status", type: "system", eventKey: "status_change", text: "Moved to Work Complete.", createdAt: "2026-08-06T02:00:00Z" },
  { id: "billing", type: "system", eventKey: "staff_billing", text: "P1 invoice total $1,200 with 30% margin.", createdAt: "2026-08-06T03:00:00Z" },
];

test("the billing activity panel has a hard staff-role boundary", () => {
  assert.equal(isStaffBillingActivityViewer("manager"), true);
  assert.equal(isStaffBillingActivityViewer("contractor"), false);
  assert.deepEqual(visibleBillingActivities(activities, "contractor"), []);
});

test("staff see operational notes and status, never staff billing entries", () => {
  const visible = visibleBillingActivities(activities, "dispatcher");
  assert.deepEqual(visible.map(item => item.id), ["status", "note"]);
  assert.equal(isSafeBillingActivity(activities[2]), false);
});

