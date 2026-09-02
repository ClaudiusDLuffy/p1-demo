import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0114_atomic_assignment_transition_notifications.sql",
);
const audit = read(
  "supabase/audits/0114_atomic_assignment_transition_notifications_verification.sql",
);
const databaseTypes = read("src/lib/supabase/database.types.ts");
const dataLayer = read("src/lib/db.ts");
const workOrderHook = read("src/features/work-orders/useWorkOrders.ts");
const portalShell = read("src/components/PortalShell.tsx");

const tableStart = migration.indexOf(
  "create table if not exists public.contractor_assignment_transition_deliveries",
);
const assignmentQueueStart = migration.indexOf(
  "create or replace function public.queue_contractor_assignment_transition_delivery",
);
const duplicateQueueStart = migration.indexOf(
  "create or replace function public.queue_duplicate_reassignment_transition_delivery",
);
const transitionStart = migration.indexOf(
  "create or replace function public.transition_work_order_contractor",
);
const wrapperStart = migration.indexOf(
  "create or replace function public.duplicate_work_order_for_reassignment_notified",
);
const claimStart = migration.indexOf(
  "create or replace function public.claim_contractor_assignment_transition_delivery",
);
const completionStart = migration.indexOf(
  "create or replace function public.complete_contractor_assignment_transition_delivery",
);

const deliveryTable = migration.slice(tableStart, assignmentQueueStart);
const assignmentQueue = migration.slice(assignmentQueueStart, duplicateQueueStart);
const duplicateQueue = migration.slice(duplicateQueueStart, transitionStart);
const transitionRpc = migration.slice(transitionStart, wrapperStart);
const duplicateWrapper = migration.slice(wrapperStart, claimStart);
const claimRpc = migration.slice(claimStart, completionStart);
const completionRpc = migration.slice(completionStart);

test("the service-only outbox snapshots only the outgoing contractor", () => {
  assert.ok(tableStart >= 0);
  assert.match(deliveryTable, /event_key text not null unique/);
  assert.match(deliveryTable, /outgoing_contractor_id uuid not null/);
  assert.match(deliveryTable, /outgoing_assignment_version integer not null/);
  assert.match(deliveryTable, /outgoing_contractor_name text not null/);
  assert.match(deliveryTable, /outgoing_contractor_email text/);
  assert.match(
    deliveryTable,
    /'reassigned'[^]*'unassigned'[^]*'duplicated_for_reassignment'/,
  );
  assert.doesNotMatch(deliveryTable, /new_contractor|receiving_contractor/i);
  assert.match(deliveryTable, /enable row level security/);
  assert.match(
    deliveryTable,
    /revoke all on public\.contractor_assignment_transition_deliveries[^]*from public, anon, authenticated/,
  );
  assert.match(
    deliveryTable,
    /grant all on public\.contractor_assignment_transition_deliveries[^]*to service_role/,
  );
});

test("direct assignment changes capture OLD before privacy-boundary mutation commits", () => {
  assert.match(assignmentQueue, /old\.contractor_id is null/);
  assert.match(assignmentQueue, /new\.contractor_id is not distinct from old\.contractor_id/);
  assert.match(assignmentQueue, /old\.contractor_assignment_version/);
  assert.match(
    assignmentQueue,
    /when new\.contractor_id is null then 'unassigned'[^]*else 'reassigned'/,
  );
  assert.match(
    assignmentQueue,
    /after update of contractor_id on public\.work_orders/,
  );
  assert.match(assignmentQueue, /on conflict \(event_key\) do nothing/);
});

test("the staff transition RPC locks, rejects stale state, and writes one audit", () => {
  assert.match(transitionRpc, /returns jsonb/);
  assert.match(transitionRpc, /language plpgsql[^]*security definer/);
  assert.match(transitionRpc, /set search_path = public, pg_temp/);
  assert.match(
    transitionRpc,
    /profile\.active = true[^]*profile\.role in \('manager', 'dispatcher', 'back_office'\)/,
  );
  assert.match(transitionRpc, /'invoice_controller'/);
  assert.match(
    transitionRpc,
    /from public\.work_orders work_order[^]*for update/,
  );
  assert.match(
    transitionRpc,
    /contractor_assignment_version[^]*<> p_expected_assignment_version/,
  );
  assert.match(transitionRpc, /profile\.is_assignable = true/);
  assert.match(
    transitionRpc,
    /update public\.work_orders work_order[^]*set contractor_id = p_new_contractor_id/,
  );
  assert.match(transitionRpc, /insert into public\.activities/);
  assert.match(transitionRpc, /entered_by_role/);
  assert.match(transitionRpc, /v_actor\.role::text/);
  assert.match(transitionRpc, /'work_order_reassigned'/);
  assert.match(transitionRpc, /'work_order_unassigned'/);
  assert.match(transitionRpc, /'deliveryId', v_delivery\.id/);
  assert.match(transitionRpc, /'deliveryStatus', v_delivery\.status/);
});

test("duplicate-for-reassignment queues a notice without mutating its source", () => {
  assert.match(duplicateQueue, /new\.duplicated_from_work_order_id/);
  assert.match(duplicateQueue, /v_source\.contractor_id/);
  assert.match(duplicateQueue, /v_source\.contractor_assignment_version/);
  assert.match(duplicateQueue, /'duplicated_for_reassignment'/);
  assert.match(duplicateQueue, /'duplicate:' \|\| new\.id/);
  assert.doesNotMatch(duplicateQueue, /update public\.work_orders/i);
  assert.match(duplicateQueue, /after insert on public\.work_orders/);

  assert.match(
    duplicateWrapper,
    /public\.duplicate_work_order_for_reassignment\([^]*p_source_work_order_id/,
  );
  assert.match(duplicateWrapper, /'duplicate:' \|\| \(v_result ->> 'workOrderId'\)/);
  assert.match(duplicateWrapper, /'deliveryId', v_delivery\.id/);
  assert.match(duplicateWrapper, /'deliveryStatus', v_delivery\.status/);
});

test("claim and completion are terminal and never return a receiving contractor", () => {
  assert.match(claimRpc, /if auth\.role\(\) <> 'service_role'/);
  assert.match(claimRpc, /where delivery\.id = p_delivery_id[^]*for update/);
  for (const state of [
    "new_claim",
    "already_sent",
    "delivery_unknown",
    "pending_or_unknown",
    "not_deliverable",
  ]) {
    assert.match(claimRpc, new RegExp(`'${state}'`));
  }
  assert.match(claimRpc, /'outgoingContractorEmail'/);
  assert.match(claimRpc, /'externalWorkOrderId'/);
  assert.match(claimRpc, /'portalWorkOrderId'/);
  assert.match(claimRpc, /'transitionType'/);
  assert.doesNotMatch(claimRpc, /newContractor|receivingContractor/);

  assert.match(completionRpc, /if auth\.role\(\) <> 'service_role'/);
  assert.match(completionRpc, /p_status not in \('sent', 'unknown'\)/);
  assert.doesNotMatch(completionRpc, /'failed'/);
});

test("RPC privileges and generated declarations match the integration contract", () => {
  assert.match(
    migration,
    /revoke all on function public\.transition_work_order_contractor\([^]*from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.transition_work_order_contractor\([^]*to authenticated, service_role/,
  );
  assert.match(
    migration,
    /revoke all on function public\.claim_contractor_assignment_transition_delivery\([^]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.claim_contractor_assignment_transition_delivery\([^]*to service_role/,
  );

  assert.match(databaseTypes, /contractor_assignment_transition_deliveries:/);
  assert.match(
    databaseTypes,
    /transition_work_order_contractor:[^]*p_expected_assignment_version: number[^]*p_new_contractor_id: string \| null[^]*Returns: Json/,
  );
  assert.match(
    databaseTypes,
    /duplicate_work_order_for_reassignment_notified:[^]*Returns: Json/,
  );
  assert.match(
    databaseTypes,
    /claim_contractor_assignment_transition_delivery:[^]*Returns: Json/,
  );
});

test("the portal uses the atomic transition and automatically attempts its durable notice", () => {
  assert.match(
    dataLayer,
    /rpc\([\s\S]*"transition_work_order_contractor"[\s\S]*p_expected_assignment_version: expectedAssignmentVersion/,
  );
  assert.match(
    dataLayer,
    /"duplicate_work_order_for_reassignment_notified"/,
  );
  assert.doesNotMatch(dataLayer, /export async function (?:unassignWorkOrder|reassignWorkOrder)\(/);

  assert.ok(
    (workOrderHook.match(/transitionWorkOrderContractor\(/g) || []).length >= 3,
    "assign, reassign, and unassign must use the guarded transition",
  );
  assert.match(
    workOrderHook,
    /fetch\("\/api\/notifications\/assignment-removal"[\s\S]*JSON\.stringify\(\{ deliveryId \}\)/,
  );
  assert.match(
    workOrderHook,
    /duplicateWorkOrderForReassignment\(woId\)[\s\S]*notifyAssignmentRemoval\(result\.deliveryId\)/,
  );
  assert.match(
    workOrderHook,
    /notifyAssignmentRemoval\(transition\?\.deliveryId\)[\s\S]*notifyDispatch\(woId, newContractorId\)/,
  );

  assert.match(
    portalShell,
    /Direct reassignment ends the current contractor&apos;s portal access and automatically emails them/,
  );
  assert.match(
    portalShell,
    /If invoicing may still be needed, use <strong>Duplicate for reassignment<\/strong> instead/,
  );
});

test("the release audit covers security, privacy, provenance, and delivery state", () => {
  for (const check of [
    "delivery_table_rls_enabled",
    "receiving_contractor_absent",
    "assignment_queue_trigger_enabled",
    "duplicate_queue_trigger_enabled",
    "work_order_row_locked",
    "stale_assignment_blocked",
    "outgoing_assignment_snapshotted",
    "duplicate_notice_preserves_source",
    "claim_excludes_receiving_contractor",
    "anonymous_table_access_blocked",
    "outgoing_scope_issue_count",
    "transition_provenance_issue_count",
    "delivery_state_issue_count",
    "all_checks_pass",
  ]) {
    assert.match(audit, new RegExp(check));
  }
});
