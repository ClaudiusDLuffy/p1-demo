import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0109_immediate_seven_eleven_activity_alerts.sql"),
  "utf8",
);
const detailStart = migration.indexOf("create or replace function public.get_portal_work_order");
const navigationStart = migration.indexOf("create or replace function public.get_portal_navigation_summary");
const detailEnd = migration.indexOf("\n$$;", detailStart);
const navigationEnd = migration.indexOf("\n$$;", navigationStart);
const detailProjection = migration.slice(detailStart, detailEnd + 4);
const navigationProjection = migration.slice(navigationStart, navigationEnd + 4);

test("selected-work-order and navigation summaries surface active 7-Eleven flags", () => {
  assert.match(migration, /create or replace function public\.get_portal_work_order/);
  assert.match(migration, /create or replace function public\.get_portal_navigation_summary/);
  assert.match(
    migration,
    /'pending_7eleven_sync_count',[\s\S]*coalesce\(summary\.pending_7eleven_sync_count, 0\)/,
  );
  assert.match(migration, /'sevenElevenUpdateCount',[\s\S]*annotated\.pending_7eleven_sync_count/);
  assert.doesNotMatch(migration, /when work_order\.functional_status::text = 'Completed'/);
});

test("ready-to-bill navigation waits for the current completed invoice set", () => {
  assert.match(
    migration,
    /'readyToBillCount'[\s\S]*public\.contractor_invoicing_is_complete\(annotated\.id\)/,
  );
});

test("compact projections preserve invoker RLS and anonymous revocations", () => {
  assert.doesNotMatch(detailProjection, /security definer/i);
  assert.doesNotMatch(navigationProjection, /security definer/i);
  assert.match(detailProjection, /security invoker/);
  assert.match(navigationProjection, /security invoker/);
  assert.match(migration, /revoke all on function public\.get_portal_work_order\(text\) from public, anon/);
  assert.match(migration, /revoke all on function public\.get_portal_navigation_summary\(\) from public, anon/);
});
