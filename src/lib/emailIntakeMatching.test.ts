import assert from "node:assert/strict";
import test from "node:test";
import { chooseIntakeWorkOrderMatch } from "./emailIntakeMatching";

test("an active exact WOT match takes priority", () => {
  assert.deepEqual(
    chooseIntakeWorkOrderMatch(
      [
        { id: "WOT100", deletedAt: null, matchedBy: "work_order_id" },
        { id: "WOT099", deletedAt: null, matchedBy: "incident_id" },
      ],
    ),
    { id: "WOT100", archived: false },
  );
});

test("an incident match under a different WOT never absorbs a new dispatch", () => {
  assert.equal(
    chooseIntakeWorkOrderMatch([
      { id: "WOT099", deletedAt: null, matchedBy: "incident_id" },
    ]),
    null,
  );
});

test("an archived exact WOT remains archived", () => {
  assert.deepEqual(
    chooseIntakeWorkOrderMatch(
      [{
        id: "WOT100",
        deletedAt: "2026-07-15T15:40:18.993Z",
        matchedBy: "work_order_id",
      }],
    ),
    { id: "WOT100", archived: true },
  );
});

test("an archived incident under a different WOT does not block a new dispatch", () => {
  assert.equal(
    chooseIntakeWorkOrderMatch([{
      id: "WOT099",
      deletedAt: "2026-07-15T15:40:18.993Z",
      matchedBy: "incident_id",
    }]),
    null,
  );
});
