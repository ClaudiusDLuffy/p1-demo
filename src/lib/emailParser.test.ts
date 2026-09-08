import assert from "node:assert/strict";
import test from "node:test";
import {
  getAllowedDispatchSenders,
  isConfirmedInitialDispatchEmail,
  isConfirmedInitialDispatchSubject,
  isConfirmedPriorityUpdateEmail,
  isConfirmedPriorityUpdateSubject,
  isConfirmedWorkOrderIntakeEmail,
  parseDispatchEmail,
} from "./emailParser";

const dispatchSubject =
  "7-Eleven Priority P1 - Critical Work Order WOT0840902 / INC26682721 has been dispatched";

const envelope = (subject: string, sender = "7elevenna@service-now.com") => ({
  subject,
  from: {
    emailAddress: {
      address: sender,
      name: "7-Eleven",
    },
  },
});

test("accepts a direct dispatch from the approved sender", () => {
  assert.equal(isConfirmedInitialDispatchEmail(envelope(dispatchSubject)), true);
});

test("sender matching is case-insensitive", () => {
  assert.equal(
    isConfirmedInitialDispatchEmail(envelope(dispatchSubject, "7ElevenNA@SERVICE-NOW.COM")),
    true,
  );
});

test("rejects replies and forwards without touching their mailbox state", () => {
  assert.equal(isConfirmedInitialDispatchEmail(envelope(`Re: ${dispatchSubject}`)), false);
  assert.equal(isConfirmedInitialDispatchEmail(envelope(`FW: ${dispatchSubject}`)), false);
  assert.equal(isConfirmedInitialDispatchEmail(envelope(`Fwd: ${dispatchSubject}`)), false);
});

test("rejects status and NTE messages", () => {
  assert.equal(
    isConfirmedInitialDispatchEmail(
      envelope("Work Order Task WOT0840902 has been assigned"),
    ),
    false,
  );
  assert.equal(
    isConfirmedInitialDispatchEmail(
      envelope("WOT0840902 NTE/Quote Has Been Approved"),
    ),
    false,
  );
});

test("rejects direct-looking messages from staff, contractors, or unknown senders", () => {
  assert.equal(
    isConfirmedInitialDispatchEmail(envelope(dispatchSubject, "service@p1pros.com")),
    false,
  );
  assert.equal(
    isConfirmedInitialDispatchEmail(envelope(dispatchSubject, "contractor@example.com")),
    false,
  );
});

test("requires a work-order reference in the direct dispatch subject", () => {
  assert.equal(isConfirmedInitialDispatchSubject("A new work order has been dispatched"), false);
});

test("supports an explicit sender allowlist without broadening the default", () => {
  const senders = getAllowedDispatchSenders(
    "dispatch@7-eleven.example, alerts@7-eleven.example",
  );
  assert.equal(
    isConfirmedInitialDispatchEmail(
      envelope(dispatchSubject, "dispatch@7-eleven.example"),
      senders,
    ),
    true,
  );
  assert.equal(isConfirmedInitialDispatchEmail(envelope(dispatchSubject), senders), false);
});

test("accepts only direct priority updates from the approved sender", () => {
  const subject = "Work Order WOT1266375 priority escalated from P4 to P1";

  assert.equal(isConfirmedPriorityUpdateSubject(subject), true);
  assert.equal(isConfirmedPriorityUpdateEmail(envelope(subject)), true);
  assert.equal(isConfirmedWorkOrderIntakeEmail(envelope(subject)), true);
  assert.equal(isConfirmedPriorityUpdateEmail(envelope(`Re: ${subject}`)), false);
  assert.equal(isConfirmedPriorityUpdateEmail(envelope(`Fwd: ${subject}`)), false);
  assert.equal(
    isConfirmedPriorityUpdateEmail(envelope(subject, "service@p1pros.com")),
    false,
  );
  assert.equal(
    isConfirmedPriorityUpdateEmail(envelope("WOT1266375 priority was updated")),
    false,
  );
});

test("parses an escalated priority from the direct subject when the body is partial", () => {
  const subject = "Work Order WOT1266375 priority escalated from P4 to P1";
  const parsed = parseDispatchEmail({
    ...envelope(subject),
    id: "priority-update",
    internetMessageId: "<priority-update@service-now.com>",
    body: {
      contentType: "text",
      content: "State: Work in Progress",
    },
    receivedDateTime: "2026-09-02T16:00:00.000Z",
    toRecipients: [],
  });

  assert.equal(parsed.emailType, "TYPE_PRIORITY_UPDATE");
  assert.equal(parsed.wotId, "WOT1266375");
  assert.equal(parsed.priority, "p1");
  assert.equal(parsed.parseConfidence, "medium");
});

test("extracts the destination from common priority-transition subjects", () => {
  for (const subject of [
    "Work Order WOT1266375 Priority update from P4 to P1",
    "Work Order WOT1266375 Priority has been escalated from P4 to P1",
    "P1 Priority Escalation - Work Order WOT1266375",
  ]) {
    const parsed = parseDispatchEmail({
      ...envelope(subject),
      id: subject,
      body: { contentType: "text", content: "State: Dispatched" },
      receivedDateTime: "2026-09-02T16:00:00.000Z",
      toRecipients: [],
    });

    assert.equal(isConfirmedPriorityUpdateEmail(envelope(subject)), true);
    assert.equal(parsed.emailType, "TYPE_PRIORITY_UPDATE");
    assert.equal(parsed.priority, "p1");
  }
});

test("parses flexible priority body lines without requiring a hyphen", () => {
  const email = {
    ...envelope("Work Order WOT1266375 has been updated"),
    id: "priority-body-update",
    body: {
      contentType: "html",
      content: "<p><strong>Priority:</strong> p1</p><p>State: Assigned</p>",
    },
    receivedDateTime: "2026-09-02T16:00:00.000Z",
    toRecipients: [],
  };
  const parsed = parseDispatchEmail(email);

  assert.equal(isConfirmedPriorityUpdateEmail(email), true);
  assert.equal(parsed.emailType, "TYPE_PRIORITY_UPDATE");
  assert.equal(parsed.priority, "p1");
});

test("fails closed when the subject and body report different priorities", () => {
  const parsed = parseDispatchEmail({
    ...envelope("7-Eleven Priority P1 - Critical Work Order WOT1266375 has been dispatched"),
    id: "conflicting-priority",
    internetMessageId: "<conflicting-priority@service-now.com>",
    body: {
      contentType: "text",
      content: [
        "Store Location: STORE - 38523",
        "Store Address: 2075 S Buckner Blvd, Dallas, TX, US, 75217",
        "Priority: P4 - Routine",
      ].join("\n"),
    },
    receivedDateTime: "2026-09-02T16:00:00.000Z",
    toRecipients: [],
  });

  assert.equal(parsed.emailType, "TYPE_DISPATCHED");
  assert.equal(parsed.priorityConflict, true);
  assert.equal(parsed.priority, null);
});

test("parses store numbers from nonstandard Texas store labels", () => {
  const parsed = parseDispatchEmail({
    ...envelope(dispatchSubject),
    id: "texas-dispatch",
    body: {
      contentType: "text",
      content: [
        "Store Location: BCP STORE - 42073",
        "Store Address: 100 Main St, Dallas, TX, US, 75001",
        "Priority: P1 - Critical",
        "Short description: Walk-in cooler not holding temperature",
      ].join("\n"),
    },
    receivedDateTime: "2026-08-02T00:49:00+08:00",
    toRecipients: [],
  });

  assert.equal(parsed.storeLocation, "BCP STORE - 42073");
  assert.equal(parsed.storeNumber, "42073");
  assert.equal(parsed.state, "TX");
  assert.equal(parsed.parseConfidence, "high");
});
