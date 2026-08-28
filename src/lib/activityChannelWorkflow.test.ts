import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0095_activity_channels.sql");
const db = read("src/lib/db.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");

test("activity channels are constrained and only field notes can enter the 7-Eleven queue", () => {
  assert.match(migration, /add column if not exists activity_channel/);
  for (const channel of ["field_note", "internal_note", "contractor_message", "system_event", "legacy"]) {
    assert.match(migration, new RegExp(`'${channel}'`));
  }
  assert.match(
    migration,
    /requires_7eleven_sync = \(activity_channel = 'field_note'\)/,
  );
  assert.match(
    migration,
    /Only field notes can require a 7-Eleven update/,
  );
  assert.match(migration, /new\.requires_7eleven_sync := requested_channel = 'field_note'/);
});

test("internal conversation is database-private and cannot request contractor action", () => {
  assert.match(
    migration,
    /when is_staff_only then 'internal_note'\s+when requires_contractor_attention then 'contractor_message'/,
  );
  assert.match(
    migration,
    /update public\.activities\s+set\s+is_staff_only = true,\s+requires_contractor_attention = false,\s+contractor_attention_acknowledged_at = null,\s+contractor_attention_acknowledged_by = null,\s+requires_7eleven_sync = false\s+where activity_channel = 'internal_note'/,
  );
  assert.match(
    migration,
    /requested_channel = 'internal_note'[\s\S]*new\.is_staff_only := true/,
  );
  assert.match(
    migration,
    /activity_channel <> 'internal_note'[\s\S]*is_staff_only = true[\s\S]*requires_contractor_attention = false/,
  );
  assert.match(migration, /Only staff can create internal notes/);
  assert.match(
    migration,
    /activity\.activity_channel in \([\s\S]*'field_note', 'contractor_message', 'legacy'/,
  );
});

test("legacy workflow events are classified server-side without trusting the browser", () => {
  assert.match(migration, /create or replace function public\.stamp_activity_actor_audit/);
  assert.match(migration, /select role::text into actor_role[\s\S]*from public\.profiles/);
  assert.match(migration, /new\.type = 'system'[\s\S]*requested_channel := 'system_event'/);
  assert.match(migration, /Only staff can reclassify activity/);
  assert.match(db, /activityChannel: a\.activity_channel/);
  assert.match(db, /activity_channel: audit\.activityChannel \|\| "legacy"/);
});

test("portal posts and displays field, internal, contractor-chat, and system streams separately", () => {
  assert.match(hook, /requestedChannel: "field_note" \| "internal_note" \| "contractor_message"/);
  assert.match(hook, /staffOnly: isStaffOnly/);
  assert.match(hook, /requiresSevenElevenSync: channel === "field_note"/);
  assert.match(detail, /aria-label="Activity channels"/);
  assert.match(detail, /P1 internal only/);
  assert.match(detail, /Field note for 7-Eleven/);
  assert.match(detail, /Contractor chat/);
  assert.match(detail, /activityChannel === "field_note" && e\.requiresSevenElevenSync/);
});
