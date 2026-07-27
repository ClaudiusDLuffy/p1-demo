import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchInboxFilter } from "./graphClient";

test("dispatch inbox filter recovers read mail without scanning unrelated senders", () => {
  const filter = buildDispatchInboxFilter(
    "2026-07-27T00:00:00.000Z",
    new Set(["7elevenna@service-now.com"]),
  );

  assert.match(filter, /receivedDateTime ge 2026-07-27T00:00:00\.000Z/);
  assert.match(filter, /from\/emailAddress\/address eq '7elevenna@service-now\.com'/);
  assert.match(filter, /contains\(subject,'dispatch'\)/);
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
