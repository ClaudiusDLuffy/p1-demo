import assert from "node:assert/strict";
import test from "node:test";
import { requiresManualContractorAssignment } from "./autoDispatch";
import {
  isConfirmedInitialDispatchEmail,
  parseDispatchEmail,
} from "./emailParser";
import { intakeStateBlockReason } from "./intakeStatePolicy";
import { createDispatchNotificationPlan } from "./notificationService";

test("accepts the WOT0983212 Texas dispatch pattern without auto-assignment", () => {
  const email = {
    id: "wot0983212",
    subject:
      "7-Eleven Priority P1 - Critical Work Order WOT0983212 / INC26910424 has been dispatched.",
    body: {
      contentType: "text",
      content: [
        "Number: WOT0983212",
        "Incident: INC26910424",
        "Store Location: BCP STORE - 42073",
        "Store Address: 100 Main St,DALLAS,TX,US,75001",
        "Priority: P1 - Critical",
        "State: Accepted",
        "Line of Service: Refrigeration",
        "Short description: Walk-in cooler not holding temperature",
      ].join("\n"),
    },
    from: {
      emailAddress: {
        address: "7elevenna@service-now.com",
        name: "7HELP Service Desk",
      },
    },
    receivedDateTime: "2026-08-02T00:49:00+08:00",
    toRecipients: [],
  };

  assert.equal(isConfirmedInitialDispatchEmail(email), true);

  const parsed = parseDispatchEmail(email);
  assert.equal(parsed.wotId, "WOT0983212");
  assert.equal(parsed.incidentId, "INC26910424");
  assert.equal(parsed.storeNumber, "42073");
  assert.equal(parsed.state, "TX");
  assert.equal(parsed.parseConfidence, "high");
  assert.equal(intakeStateBlockReason(parsed.state, "VA,TX", "true"), null);
  assert.equal(requiresManualContractorAssignment(parsed), true);

  const notification = createDispatchNotificationPlan(
    {
      workOrder: {
        id: parsed.wotId || "",
        incidentId: parsed.incidentId,
        storeNumber: parsed.storeNumber,
        city: parsed.city,
        state: parsed.state,
        address: parsed.address,
        priority: parsed.priority,
        summary: parsed.summary,
      },
      contractorAssigned: false,
    },
    [
      "mandy@p1pros.com",
      "lynzy@p1pros.com",
      "landryd@phospitality.com",
    ],
  );

  assert.deepEqual(notification.contractorRecipients, []);
  assert.deepEqual(notification.internalRecipients, [
    "mandy@p1pros.com",
    "lynzy@p1pros.com",
    "landryd@phospitality.com",
    "service@p1pros.com",
  ]);
  assert.equal(
    notification.ownerSubject,
    "New TX Call Needs Assignment - WOT0983212",
  );
});
