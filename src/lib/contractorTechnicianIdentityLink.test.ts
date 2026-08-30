import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0106_contractor_technician_identity_linkage.sql",
);
const audit = read(
  "supabase/audits/0106_contractor_technician_identity_verification.sql",
);
const databaseLoader = read("src/lib/db.ts");
const workOrderDetail = read(
  "src/features/work-orders/WorkOrderDetail.tsx",
);
const subDispatch = read("src/features/contractors/SubDispatchView.tsx");

test("linked dropdown identities follow the portal profile", () => {
  assert.match(
    migration,
    /select profile\.name[\s\S]*into linked_profile_name[\s\S]*new\.name := linked_profile_name/,
  );
  assert.match(
    migration,
    /before insert or update of contractor_id, profile_id, name/,
  );
  assert.match(
    migration,
    /profile\.contractor_access_level in \('invoice', 'report_only'\)/,
  );
  assert.match(
    migration,
    /contractor_account_id_for_profile\(profile\.id\)[\s\S]*= new\.contractor_id/,
  );
});

test("the SCRC Rush repair is exact, guarded, and preserves history", () => {
  for (const expected of [
    "scrcdallastexas@gmail.com",
    "rayrush50@gmail.com",
    "Raymond Rush",
    "rushraymond",
    "raymondrush",
  ]) {
    assert.match(migration, new RegExp(expected.replaceAll(".", "\\.")));
  }
  assert.match(
    migration,
    /A Raymond Rush alias is linked to a different portal profile/,
  );
  assert.match(
    migration,
    /A Raymond Rush work-order label is assigned to a different portal profile/,
  );
  assert.match(
    migration,
    /set name = format\([\s\S]*is_active = false[\s\S]*technician\.profile_id is null/,
  );
  assert.doesNotMatch(migration, /delete from public\./i);
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
});

test("matching Rush work orders are linked to his login identity", () => {
  assert.match(
    migration,
    /update public\.work_orders work_order[\s\S]*assigned_technician_profile_id = rush_profile_id[\s\S]*technician_on_job = canonical_name/,
  );
  assert.match(
    migration,
    /work_order\.contractor_id = scrc_contractor_id[\s\S]*work_order\.assigned_technician_profile_id is null[\s\S]*in \('rush', 'rushraymond', 'raymondrush'\)/,
  );
});

test("the technician loader renders linked portal names as canonical", () => {
  assert.match(
    databaseLoader,
    /portal_profile:profiles!contractor_technicians_profile_id_fkey\(name\)/,
  );
  assert.match(databaseLoader, /name: portalProfile\?\.name \|\| t\.name/);
  assert.match(databaseLoader, /storedName: t\.name/);
});

test("unlinked dropdown entries are explicit record-only choices", () => {
  const recordOnlyLabel = /record only \(no portal login\)/;
  assert.match(workOrderDetail, recordOnlyLabel);
  assert.match(subDispatch, recordOnlyLabel);
  assert.match(
    workOrderDetail,
    /selectedTechnician\?\.profileId[\s\S]*doAssignPortalTechnician/,
  );
  assert.match(
    subDispatch,
    /selectedTechnician\?\.profileId[\s\S]*doAssignPortalTechnician/,
  );
});

test("the production audit verifies identity linkage and assignment integrity", () => {
  for (const expected of [
    "linked_technician_identity_guard_present",
    "contractor_company_and_assignment_wall_preserved",
    "exactly_one_scrc_organization",
    "raymond_rush_profile_configured",
    "raymond_rush_portal_link_configured",
    "active_rush_alias_duplicates_removed",
    "rush_work_orders_identity_linked",
    "current_assignments_valid",
    "assignment_history_consistent",
    "active_record_only_scrc_dropdown_rows",
    "all_checks_pass",
  ]) {
    assert.match(audit, new RegExp(expected));
  }
  assert.match(audit, /work_order\.contractor_id = case/);
  assert.match(
    audit,
    /work_order\.assigned_technician_profile_id = viewer\.id/,
  );
});
