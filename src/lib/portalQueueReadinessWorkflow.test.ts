import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0087_portal_queue_readiness.sql"),
  "utf8",
);

test("selected-work-order and navigation summaries gate 7-Eleven flags", () => {
  assert.match(migration, /create or replace function public\.get_portal_work_order/);
  assert.match(migration, /create or replace function public\.get_portal_navigation_summary/);
  assert.match(
    migration,
    /when work_order\.functional_status::text = 'Completed'[\s\S]*then coalesce\(activity\.raw_pending_7eleven_sync_count/,
  );
});

test("ready-to-bill navigation waits for the current completed invoice set", () => {
  assert.match(
    migration,
    /'readyToBillCount'[\s\S]*public\.contractor_invoicing_is_complete\(annotated\.id\)/,
  );
});

test("compact projections preserve invoker RLS and anonymous revocations", () => {
  assert.doesNotMatch(migration, /security definer/i);
  assert.match(migration, /security invoker/g);
  assert.match(migration, /revoke all on function public\.get_portal_work_order\(text\) from public, anon/);
  assert.match(migration, /revoke all on function public\.get_portal_navigation_summary\(\) from public, anon/);
});
