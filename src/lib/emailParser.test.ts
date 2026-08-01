import assert from "node:assert/strict";
import test from "node:test";
import {
  getAllowedDispatchSenders,
  isConfirmedInitialDispatchEmail,
  isConfirmedInitialDispatchSubject,
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
