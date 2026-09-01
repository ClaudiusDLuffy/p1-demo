import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0095_activity_channels.sql");
const db = read("src/lib/db.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const activityPanels = read("src/features/work-orders/WorkOrderActivityPanels.tsx");

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

test("portal uses dedicated 7-Eleven and general activity areas", () => {
  assert.match(hook, /requestedChannel: "field_note" \| "internal_note" \| "contractor_message"/);
  assert.match(hook, /staffOnly: isStaffOnly/);
  assert.match(hook, /requiresSevenElevenSync: channel === "field_note"/);
  assert.match(detail, /<WorkOrderActivityPanels/);
  assert.match(activityPanels, /7-Eleven updates \/ job notes/);
  assert.match(activityPanels, /General chat &amp; activity/);
  assert.match(activityPanels, /P1 internal only/);
  assert.match(activityPanels, /P1 \+ assigned contractor/);
  assert.match(activityPanels, /activityChannel === "field_note" && activity\.requiresSevenElevenSync/);
  assert.doesNotMatch(activityPanels, /aria-label="Activity channels"|Choose note channel/);
});

test("staff contractor-visible chat is atomically flagged before its automatic email", () => {
  assert.match(db, /requires_contractor_attention: !!audit\.requiresContractorAttention/);
  assert.match(db, /if \(!audit\.requiresContractorAttention\)[\s\S]*?return null/);
  assert.match(db, /insert\.select\("id"\)\.single\(\)/);
  assert.match(
    hook,
    /shouldAutomaticallyNotifyContractor\([\s\S]*?currentUser\?\.role,[\s\S]*?channel/,
  );
  assert.match(
    hook,
    /requiresContractorAttention: automaticallyNotifyContractor/,
  );
  assert.match(
    hook,
    /if \(automaticallyNotifyContractor && activityId\)[\s\S]*?await notifyContractorAttention\(woId, activityId\)/,
  );
  assert.match(hook, /Message posted and contractor alert saved, but notification delivery needs review/);
  assert.match(activityPanels, /Posting automatically sends a portal email/);
  assert.match(activityPanels, /Send &amp; notify contractor|Send & notify contractor/);
});
