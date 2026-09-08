import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDispatchInboxFilter,
  GraphHttpError,
  isGraphHttpError,
} from "./graphClient";

test("dispatch inbox filter recovers read mail without scanning unrelated senders", () => {
  const filter = buildDispatchInboxFilter(
    "2026-07-27T00:00:00.000Z",
    new Set(["7elevenna@service-now.com"]),
  );

  assert.match(filter, /receivedDateTime ge 2026-07-27T00:00:00\.000Z/);
  assert.match(filter, /from\/emailAddress\/address eq '7elevenna@service-now\.com'/);
  assert.match(filter, /contains\(subject,'WOT'\)/);
  assert.match(filter, /contains\(subject,'FWKD'\)/);
  assert.doesNotMatch(filter, /\bisRead\b/);
});

test("dispatch inbox filter can retain the normal unread queue", () => {
  const filter = buildDispatchInboxFilter(
    "2026-07-27T00:00:00.000Z",
    new Set(["7elevenna@service-now.com"]),
    true,
  );

  assert.match(filter, /isRead eq false/);
});

test("Graph HTTP failures preserve safe retry semantics without provider payloads", () => {
  const rateLimited = new GraphHttpError(
    "Graph send-mail request",
    new Response(null, {
      status: 429,
      headers: { "retry-after": "12" },
    }),
  );
  assert.equal(isGraphHttpError(rateLimited), true);
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.deliveryOutcomeUnknown, false);
  assert.equal(rateLimited.retryAfterSeconds, 12);
  assert.doesNotMatch(rateLimited.message, /token|authorization|response body/i);

  const invalidRequest = new GraphHttpError(
    "Graph send-mail request",
    new Response(null, { status: 400 }),
  );
  assert.equal(invalidRequest.retryable, false);
  assert.equal(invalidRequest.deliveryOutcomeUnknown, false);

  for (const status of [408, 500, 503]) {
    const ambiguous = new GraphHttpError(
      "Graph send-mail request",
      new Response(null, { status }),
    );
    assert.equal(ambiguous.retryable, false);
    assert.equal(ambiguous.deliveryOutcomeUnknown, true);
  }
});
