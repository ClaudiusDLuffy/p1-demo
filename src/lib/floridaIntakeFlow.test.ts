import assert from "node:assert/strict";
import test from "node:test";
import { requiresManualContractorAssignment } from "./autoDispatch";
import {
  isConfirmedInitialDispatchEmail,
  parseDispatchEmail,
} from "./emailParser";
import {
  intakeStateActivationDecision,
  intakeStateBlockReason,
} from "./intakeStatePolicy";
import { createDispatchNotificationPlan } from "./notificationService";

test("accepts a Florida dispatch without auto-assignment", () => {
  const email = {
    id: "wot-florida",
    subject:
      "7-Eleven Priority P2 - High Work Order WOT0990001 / INC27000001 has been dispatched.",
    body: {
      contentType: "text",
      content: [
        "Number: WOT0990001",
        "Incident: INC27000001",
        "Store Location: 7-ELEVEN STORE - 12345",
        "Store Address: 100 Main St,TAMPA,FL,US,33602",
        "Priority: P2 - High",
        "State: Accepted",
        "Line of Service: Plumbing",
        "Short description: Store sink is leaking",
      ].join("\n"),
    },
    from: {
      emailAddress: {
        address: "7elevenna@service-now.com",
        name: "7HELP Service Desk",
      },
    },
    receivedDateTime: "2026-08-04T09:00:00-04:00",
    toRecipients: [],
  };

  assert.equal(isConfirmedInitialDispatchEmail(email), true);

  const parsed = parseDispatchEmail(email);
  assert.equal(parsed.wotId, "WOT0990001");
  assert.equal(parsed.incidentId, "INC27000001");
  assert.equal(parsed.storeNumber, "12345");
  assert.equal(parsed.state, "FL");
  assert.equal(parsed.parseConfidence, "high");
  assert.equal(intakeStateBlockReason(parsed.state, "VA,TX,FL", "true"), null);
  assert.deepEqual(
    intakeStateActivationDecision(
      parsed.state,
      email.receivedDateTime,
      "2026-08-04T08:59:00-04:00",
    ),
    { action: "allow", reason: null },
  );
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
    "New FL Call Needs Assignment - WOT0990001",
  );
});
