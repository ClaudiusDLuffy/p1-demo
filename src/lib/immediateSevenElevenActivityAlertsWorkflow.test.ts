import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/0109_immediate_seven_eleven_activity_alerts.sql",
);
const audit = read(
  "supabase/audits/0109_immediate_seven_eleven_activity_alerts_verification.sql",
);

const insertTriggerStart = migration.indexOf(
  "create or replace function public.stamp_activity_actor_audit()",
);
const updateTriggerStart = migration.indexOf(
  "create or replace function public.enforce_activity_channel_update()",
);
const detailStart = migration.indexOf(
  "create or replace function public.get_portal_work_order",
);
const navigationStart = migration.indexOf(
  "create or replace function public.get_portal_navigation_summary",
);
const tableStart = migration.indexOf(
  "create or replace function public.list_work_orders_table_page",
);

const insertTrigger = migration.slice(insertTriggerStart, updateTriggerStart);
const updateTrigger = migration.slice(updateTriggerStart, detailStart);
const detailProjection = migration.slice(detailStart, navigationStart);
const navigationProjection = migration.slice(navigationStart, tableStart);
const tableProjection = migration.slice(tableStart);

test("0109 canonicalizes the four 7-Eleven lifecycle events at both write boundaries", () => {
  for (const body of [insertTrigger, updateTrigger]) {
    assert.match(
      body,
      /'check_in', 'check_out', 'job_paused', 'job_completed'/,
    );
    assert.match(body, /lifecycle_event/);
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = public, pg_temp/);
  }

  assert.match(insertTrigger, /requested_channel := 'field_note'/);
  assert.match(
    insertTrigger,
    /new\.requires_7eleven_sync := requested_channel = 'field_note'/,
  );
  assert.match(updateTrigger, /new\.activity_channel := 'field_note'/);
  assert.match(
    updateTrigger,
    /new\.requires_7eleven_sync := new\.activity_channel = 'field_note'/,
  );
  assert.match(
    updateTrigger,
    /new\.event_key is distinct from old\.event_key/,
  );
  assert.match(updateTrigger, /new\.type is distinct from old\.type/);
  assert.match(
    updateTrigger,
    /Only staff can change activity classification/,
  );

  assert.match(
    migration,
    /before update of[\s\S]*activity_channel,[\s\S]*event_key,[\s\S]*type,/,
  );
});

test("invoice, general, internal, and system activity cannot enter the queue", () => {
  assert.match(insertTrigger, /invoice_event/);
  assert.match(insertTrigger, /requested_channel = 'contractor_message'/);
  assert.match(insertTrigger, /requested_channel = 'internal_note'/);
  assert.match(insertTrigger, /requested_channel := 'system_event'/);
  assert.match(
    migration,
    /set activity_channel = 'system_event'[\s\S]*requires_7eleven_sync = true[\s\S]*event_key not in/,
  );
});

test("repair is restricted to the current open workflow and assignment", () => {
  const repair = migration.slice(
    migration.indexOf("-- Repair only the currently open lifecycle"),
    detailStart,
  );

  assert.match(repair, /work_order\.status::text <> 'closed'/);
  assert.match(
    repair,
    /activity\.workflow_cycle = work_order\.workflow_cycle/,
  );
  assert.match(
    repair,
    /activity\.contractor_assignment_version[\s\S]*= work_order\.contractor_assignment_version/,
  );
  assert.match(
    repair,
    /activity\.created_at >= work_order\.contractor_assignment_started_at/,
  );
  assert.match(repair, /activity\.synced_to_7eleven_at is null/);
  assert.doesNotMatch(repair, /work_order\.status::text = 'closed'/);
});

test("detail, navigation, and sortable queues surface active pending updates", () => {
  assert.match(
    detailProjection,
    /'pending_7eleven_sync_count',[\s\S]*coalesce\(summary\.pending_7eleven_sync_count, 0\)/,
  );
  assert.doesNotMatch(
    detailProjection,
    /when work_order\.functional_status::text = 'Completed'/,
  );

  assert.match(
    navigationProjection,
    /coalesce\(activity\.pending_7eleven_sync_count, 0\)[\s\S]*as pending_7eleven_sync_count/,
  );
  assert.match(
    navigationProjection,
    /or annotated\.pending_7eleven_sync_count > 0/,
  );

  assert.match(
    tableProjection,
    /when 'dashboard_seven_eleven_updates' then[\s\S]*coalesce\(summary\.pending_7eleven_sync_count, 0\) > 0/,
  );
  assert.match(
    tableProjection,
    /or coalesce\(summary\.pending_7eleven_sync_count, 0\) > 0/,
  );
  assert.doesNotMatch(
    tableProjection,
    /work_order\.functional_status::text = 'Completed'/,
  );
});

test("both page RPCs preserve RLS, grants, and cursor pagination", () => {
  assert.match(
    migration,
    /alter function public\.list_work_orders_page\([\s\S]*\) security invoker;/,
  );
  assert.match(
    migration,
    /alter function public\.list_work_orders_page\([\s\S]*\) set search_path = public, pg_temp;/,
  );
  assert.match(tableProjection, /security invoker/);
  assert.match(tableProjection, /set search_path = public, pg_temp/);
  assert.match(tableProjection, /portal_decode_cursor\(p_cursor\)/);
  assert.match(tableProjection, /portal_encode_cursor\(jsonb_build_object/);
  assert.match(tableProjection, /'pendingRank', last_row\._pending_rank/);
  assert.match(tableProjection, /limit \(select page_size \+ 1 from args\)/);
  assert.match(
    migration,
    /grant execute on function public\.list_work_orders_table_page\([\s\S]*to authenticated, service_role;/,
  );
  assert.match(migration, /commit;\s*$/);
});

test("activity alerts are published for immediate cross-session refresh", () => {
  assert.match(
    migration,
    /alter publication supabase_realtime add table public\.activities/,
  );
  assert.match(migration, /when duplicate_object then null/);
  assert.match(audit, /activities_realtime_enabled/);
  assert.match(audit, /pg_publication_tables/);
});

test("0109 audit reports explicit code and data-quality checks in one row", () => {
  for (const check of [
    "lifecycle_insert_canonicalized",
    "lifecycle_update_canonicalized",
    "activity_identity_update_staff_only",
    "lifecycle_triggers_installed",
    "non_queue_channels_excluded",
    "detail_surfaces_active_alerts",
    "navigation_surfaces_active_alerts",
    "sortable_queue_surfaces_active_alerts",
    "legacy_queue_preserves_active_pagination",
    "read_rpcs_preserve_rls",
    "anonymous_execute_blocked",
    "activities_realtime_enabled",
    "current_cycle_lifecycle_issue_count",
    "forbidden_pending_activity_count",
    "channel_sync_invariant_issue_count",
    "all_checks_pass",
  ]) {
    assert.match(audit, new RegExp(check));
  }

  assert.match(audit, /from checks;\s*$/);
});
