import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0112_duplicate_work_order_for_reassignment.sql",
);
const audit = read(
  "supabase/audits/0112_duplicate_work_order_for_reassignment_verification.sql",
);
const dataLayer = read("src/lib/db.ts");
const databaseTypes = read("src/lib/supabase/database.types.ts");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const shell = read("src/components/PortalShell.tsx");
const activityPanels = read(
  "src/features/work-orders/WorkOrderActivityPanels.tsx",
);
const controllerExports = read("src/app/api/controller-exports/route.ts");
const invoiceCsv = read("src/lib/invoiceCsv.ts");
const notificationRoute = read("src/app/api/notifications/dispatch/route.ts");
const notificationService = read("src/lib/notificationService.ts");
const emailIntakeProcessor = read("src/lib/emailIntakeProcessor.ts");
const emailIntakeMatching = read("src/lib/emailIntakeMatching.ts");

const rpcStart = migration.indexOf(
  "create or replace function public.duplicate_work_order_for_reassignment",
);
const rpc = migration.slice(rpcStart);

const workOrderInsert = rpc.match(
  /insert into public\.work_orders \(([\s\S]*?)\n    \) values \(([\s\S]*?)\n    \)\n    on conflict/i,
);

assert.ok(workOrderInsert, "work-order insert contract must be present");

const splitSqlList = (value: string) => value
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);

const insertedColumns = splitSqlList(workOrderInsert[1]);
const insertedValues = splitSqlList(workOrderInsert[2]);
const insertedValueByColumn = Object.fromEntries(
  insertedColumns.map((column, index) => [column, insertedValues[index]]),
);

const copiedSourceFields = {
  incident_id: "v_source.incident_id",
  store_number: "v_source.store_number",
  city: "v_source.city",
  address: "v_source.address",
  store_state: "v_source.store_state",
  store_timezone: "v_source.store_timezone",
  store_county: "v_source.store_county",
  store_postal_code: "v_source.store_postal_code",
  line_of_service: "v_source.line_of_service",
  business_service: "v_source.business_service",
  category: "v_source.category",
  sub_category: "v_source.sub_category",
  summary: "v_source.summary",
  description: "v_source.description",
  priority: "v_source.priority",
  afm_id: "v_source.afm_id",
  afm_name: "v_source.afm_name",
  source: "v_source.source",
  sla_started_at: "v_source.sla_started_at",
  response_breach_at: "v_source.response_breach_at",
  resolution_breach_at: "v_source.resolution_breach_at",
  nte: "v_source_nte",
} as const;

const resetFields = {
  afm_email: "null",
  nte_flag_threshold: "null",
  nte_flagged: "false",
  nte_flag_amount: "null",
  status: "'unassigned'",
  functional_status: "'New'",
  contractor_id: "null",
  assigned_technician_profile_id: "null",
  technician_on_job: "null",
  technician_assigned_at: "null",
  technician_assigned_by: "null",
  contractor_assignment_started_at: "null",
  contractor_assignment_version: "0",
  eta: "null",
  dispatched_at: "null",
  start_time: "null",
  end_time: "null",
  closed_at: "null",
  asset_make: "null",
  asset_model: "null",
  asset_serial: "null",
  asset_year: "null",
  invoice_total: "null",
  billing_only: "false",
  billing_ready_at: "null",
  billing_ready_by: "null",
  contractor_invoicing_completed_at: "null",
  contractor_invoicing_completed_by: "null",
  contractor_invoicing_assignment_version: "null",
  contractor_invoicing_workflow_cycle: "null",
  contractor_invoicing_completion_source: "null",
  is_capital: "false",
  capital_status: "null",
  repair_quote: "null",
  install_quote: "null",
  capital_notes: "null",
  part_needed: "null",
  part_eta: "null",
  resolution_code: "null",
  resolution_notes: "null",
  staff_notes_seen_at: "null",
  workflow_cycle: "0",
  deleted_at: "null",
  deleted_by: "null",
} as const;

test("duplicate provenance is constrained, immutable, and root-sequenced", () => {
  assert.match(migration, /duplicated_from_work_order_id text/);
  assert.match(migration, /duplicate_root_work_order_id text/);
  assert.match(migration, /duplicate_sequence integer/);
  assert.match(migration, /work_orders_duplicate_provenance_check/);
  assert.match(
    migration,
    /id = duplicate_root_work_order_id[\s\S]*duplicate_sequence::text/,
  );
  assert.match(migration, /work_orders_duplicate_root_sequence_key/);
  assert.match(migration, /on delete restrict/g);
  assert.match(migration, /Work-order duplicate provenance is immutable/);
});

test("the RPC is atomic and excludes non-operational callers and sources", () => {
  assert.ok(rpcStart >= 0);
  assert.match(rpc, /returns jsonb/);
  assert.match(rpc, /language plpgsql[\s\S]*security definer/);
  assert.match(rpc, /set search_path = public, pg_temp/);
  assert.match(
    rpc,
    /profile\.active = true[\s\S]*profile\.role in \('manager', 'dispatcher', 'back_office'\)/,
  );
  assert.match(
    rpc,
    /not public\.profile_has_staff_permission\([\s\S]*'invoice_controller'/,
  );
  assert.match(rpc, /work_order\.deleted_at is null[\s\S]*for share/);
  assert.match(rpc, /v_source\.billing_only/);
  assert.match(rpc, /coalesce\(v_source\.is_capital, false\)/);
  assert.match(rpc, /v_source\.contractor_id is null/);
  assert.match(rpc, /v_root_work_order_id !~ '\^WOT\[0-9\]\{6,12\}\$'/);
  assert.match(rpc, /Only canonical 7-Eleven WOT work orders can be duplicated/);
  for (const status of [
    "assigned",
    "wip",
    "parts",
    "completed",
    "pending_invoice",
    "pending_approval",
    "pending_payment",
  ]) {
    assert.match(rpc, new RegExp(`'${status}'`));
  }
  assert.match(rpc, /pg_advisory_xact_lock/);
  assert.match(rpc, /hashtextextended/);
  assert.match(
    rpc,
    /where existing_work_order\.id = v_duplicate_work_order_id/,
  );
  assert.match(rpc, /on conflict \(id\) do nothing/);
  assert.match(rpc, /v_duplicate_sequence := v_duplicate_sequence \+ 1/);
});

test("only 7-Eleven source data is copied and every assignment output is reset", () => {
  assert.equal(insertedColumns.length, insertedValues.length);

  for (const [column, value] of Object.entries(copiedSourceFields)) {
    assert.equal(insertedValueByColumn[column], value, `${column} must be copied`);
  }

  for (const [column, value] of Object.entries(resetFields)) {
    assert.equal(insertedValueByColumn[column], value, `${column} must reset`);
  }

  assert.equal(insertedValueByColumn.id, "v_duplicate_work_order_id");
  assert.equal(
    insertedValueByColumn.duplicated_from_work_order_id,
    "v_source.id",
  );
  assert.equal(
    insertedValueByColumn.duplicate_root_work_order_id,
    "v_root_work_order_id",
  );
  assert.equal(
    insertedValueByColumn.duplicate_sequence,
    "v_duplicate_sequence",
  );
  assert.equal(insertedValueByColumn.created_by, "v_actor.id");
  assert.equal(insertedValueByColumn.created_at, "v_created_at");
  assert.equal(insertedValueByColumn.updated_at, "v_created_at");
  assert.doesNotMatch(rpc, /\bsla_deadline_at\b|\bsla_breached_at\b/);
});

test("private NTE and AFM contact copy without inheriting any child workflow", () => {
  assert.match(
    rpc,
    /select financial\.nte[\s\S]*from public\.work_order_financials/,
  );
  assert.match(
    rpc,
    /insert into public\.work_order_afm_contacts[\s\S]*source_contact\.afm_email/,
  );

  const insertedTables = Array.from(
    rpc.matchAll(/insert into public\.([a-z_]+)/gi),
    match => match[1],
  );
  assert.deepEqual(insertedTables, [
    "work_orders",
    "work_order_afm_contacts",
    "activities",
  ]);
  assert.doesNotMatch(rpc, /update public\.work_orders/i);
  assert.doesNotMatch(rpc, /delete from public\.work_orders/i);
});

test("the new work order receives one private non-7-Eleven audit event", () => {
  assert.match(rpc, /'work_order_duplicated'/);
  assert.match(rpc, /'system_event'/);
  assert.match(
    rpc,
    /'system_event',[\s\S]*v_actor\.role::text,[\s\S]*false,[\s\S]*true,[\s\S]*false,[\s\S]*false/,
  );
  assert.match(rpc, /'sourceWorkOrderId', v_source\.id/);
  assert.match(rpc, /'duplicateRootWorkOrderId', v_root_work_order_id/);
  assert.match(rpc, /'duplicateSequence', v_duplicate_sequence/);
});

test("the RPC result and execution grants match the future app contract", () => {
  assert.match(
    rpc,
    /return jsonb_build_object\([\s\S]*'applied', true[\s\S]*'reason', 'duplicated'[\s\S]*'workOrderId', v_inserted_work_order_id[\s\S]*'sourceWorkOrderId', v_source\.id[\s\S]*'rootWorkOrderId', v_root_work_order_id[\s\S]*'duplicateSequence', v_duplicate_sequence/,
  );
  assert.match(
    migration,
    /revoke all on function public\.duplicate_work_order_for_reassignment\(text\)[\s\S]*from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.duplicate_work_order_for_reassignment\(text\)[\s\S]*to authenticated, service_role/,
  );
});

test("the P1-only portal action confirms and opens the new unassigned copy", () => {
  assert.match(
    dataLayer,
    /rpc\([\s\S]*"duplicate_work_order_for_reassignment_notified"[\s\S]*p_source_work_order_id: workOrderId/,
  );
  assert.match(
    databaseTypes,
    /duplicate_work_order_for_reassignment_notified:[\s\S]*p_source_work_order_id: string[\s\S]*Returns: Json/,
  );
  assert.match(hook, /await duplicateWorkOrderForReassignment\(woId\)/);
  assert.match(hook, /setSelectedWO\(result\.workOrderId\)/);
  assert.match(hook, /setPage\("wo_detail"\)/);
  assert.match(detail, /canDuplicateWorkOrderForReassignment/);
  assert.match(detail, /setModal\("duplicateForReassignment"\)/);
  assert.match(detail, /Duplicate for reassignment/);
  assert.match(shell, /title="Duplicate for reassignment\?"/);
  assert.match(shell, /original work order remains unchanged/i);
  assert.match(shell, /Technician details, invoices, notes, activities, visits, photos/);
  assert.match(shell, /await doDuplicateForReassignment\(woData\.id\)/);
});

test("outbound systems use the canonical WOT while portal records keep the suffix", () => {
  assert.match(dataLayer, /externalWorkOrderId: w\.duplicate_root_work_order_id \|\| w\.id/);
  assert.match(detail, /canonicalSevenElevenWorkOrderId\(woData\)/);
  assert.match(activityPanels, /Copy 7-Eleven WOT/);
  assert.match(
    notificationRoute,
    /externalWorkOrderId: wo\.duplicate_root_work_order_id \|\| wo\.id/,
  );
  assert.match(notificationService, /workOrder\.externalWorkOrderId/);
  assert.match(invoiceCsv, /invoice\.externalWorkOrderId/);
  assert.match(
    controllerExports,
    /select\("id,duplicate_root_work_order_id(?:,[^"]+)?"\)/,
  );
  assert.match(controllerExports, /externalWorkOrderIdById/);
  assert.match(controllerExports, /externalWorkOrderIdFor\(invoice\.work_order_id\)/);
  assert.match(shell, /externalWorkOrderId = canonicalSevenElevenWorkOrderId/);
  assert.match(
    emailIntakeProcessor,
    /\.eq\("duplicate_root_work_order_id", id\)/,
  );
  assert.match(
    emailIntakeMatching,
    /matchedBy === "canonical_work_order_id"[\s\S]*duplicateSequence/,
  );

  assert.match(migration, /id = v_duplicate_work_order_id/);
  assert.doesNotMatch(
    migration,
    /update public\.invoices[\s\S]*work_order_id = v_duplicate_work_order_id/i,
  );
});

test("the deployment audit covers isolation, fidelity, and authorization", () => {
  assert.match(audit, /duplicate_function_guarded/);
  assert.match(audit, /duplicate_function_returns_json/);
  assert.match(audit, /invoice_controller_blocked/);
  assert.match(audit, /canonical_wot_root_required/);
  assert.match(audit, /root_allocation_locked/);
  assert.match(audit, /archived_ids_not_recycled/);
  assert.match(audit, /source_mutation_absent/);
  assert.match(audit, /child_copy_absent/);
  assert.match(audit, /fresh_duplicate_rows as/);
  assert.match(audit, /activity\.event_key <> 'work_order_duplicated'/);
  assert.match(audit, /provenance_issue_count/);
  assert.match(audit, /reset_state_issue_count/);
  assert.match(audit, /copied_source_issue_count/);
  assert.match(audit, /unexpected_child_artifact_count/);
  assert.match(audit, /as all_checks_pass/);
});
