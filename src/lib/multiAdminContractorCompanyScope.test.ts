import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0105_multi_admin_contractor_company_scope.sql",
);
const audit = read(
  "supabase/audits/0105_multi_admin_contractor_company_scope_verification.sql",
);
const profileSecurityMigration = read(
  "supabase/migrations/0056_contractor_company_scope.sql",
);
const notificationRoute = read(
  "src/app/api/notifications/invoice-review/route.ts",
);

test("company admins are company-wide only behind the exact contractor wall", () => {
  assert.match(
    migration,
    /canonical\.id = organization\.canonical_contractor_id[\s\S]*canonical\.active = true[\s\S]*work_order\.contractor_id = case[\s\S]*then canonical\.id[\s\S]*else viewer\.id/,
  );
  assert.match(
    migration,
    /or viewer\.contractor_access_level = 'company_admin'/,
  );
  const accessFunction = migration.match(
    /create or replace function public\.can_access_contractor_work_order\([\s\S]*?\n\$\$;/,
  );
  assert.ok(accessFunction);
  assert.doesNotMatch(
    accessFunction[0],
    /viewer\.id = organization\.canonical_contractor_id/,
  );
});

test("invoice and report-only members remain active-link and current-assignment scoped", () => {
  assert.match(
    migration,
    /viewer\.contractor_access_level in \('invoice', 'report_only'\)[\s\S]*work_order\.assigned_technician_profile_id = viewer\.id[\s\S]*technician\.profile_id = viewer\.id[\s\S]*technician\.contractor_id = work_order\.contractor_id[\s\S]*technician\.is_active = true/,
  );
  assert.match(
    migration,
    /profile\.contractor_access_level = 'invoice'[\s\S]*technician\.contractor_id = p_contractor_id[\s\S]*technician\.is_active = true/,
  );
});

test("management, profile, and technician directory access stays inside one organization", () => {
  assert.match(
    migration,
    /can_manage_work_order_technician[\s\S]*organization\.canonical_contractor_id = work_order\.contractor_id/,
  );
  assert.match(
    migration,
    /can_read_contractor_profile[\s\S]*target\.contractor_organization_id[\s\S]*= viewer\.contractor_organization_id/,
  );
  assert.match(
    migration,
    /create policy ct_read[\s\S]*organization\.canonical_contractor_id[\s\S]*= contractor_technicians\.contractor_id/,
  );
  assert.match(
    profileSecurityMigration,
    /new\.contractor_organization_id is distinct from old\.contractor_organization_id[\s\S]*new\.contractor_access_level is distinct from old\.contractor_access_level[\s\S]*Profile permission fields may only be changed by P1 staff/,
  );
});

test("the approved SCRC role map is guarded and repaired idempotently", () => {
  for (const email of [
    "scrcdallastexas@gmail.com",
    "jenniferk@scrcdtx.com",
    "nancypb.scrc@gmail.com",
    "ap@scrcdtx.com",
    "rayrush50@gmail.com",
  ]) {
    assert.match(migration, new RegExp(email.replace(".", "\\.")));
  }
  assert.match(
    migration,
    /\('jenniferk@scrcdtx\.com'::text, 'company_admin'::text\)/,
  );
  assert.match(
    migration,
    /\('nancypb\.scrc@gmail\.com'::text, 'company_admin'::text\)/,
  );
  assert.match(
    migration,
    /\('ap@scrcdtx\.com'::text, 'report_only'::text\)/,
  );
  assert.match(
    migration,
    /\('rayrush50@gmail\.com'::text, 'report_only'::text\)/,
  );
  assert.match(
    migration,
    /technician\.contractor_id is distinct from scrc_contractor_id[\s\S]*raise exception 'SCRC member % has a technician link to another contractor'/,
  );
  assert.match(
    migration,
    /update public\.contractor_technicians[\s\S]*profile_id = member_profile\.id[\s\S]*is_active = true/,
  );
  assert.match(
    migration,
    /is_assignable = \(member_profile\.id = scrc_contractor_id\)/,
  );
  assert.match(migration, /is_assignable = false/);
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.doesNotMatch(migration, /delete from public\./i);
});

test("additional company admins can receive their own invoice review notifications", () => {
  assert.match(
    notificationRoute,
    /belongsToInvoiceCompany[\s\S]*creatorCanInvoice = creator\.contractor_access_level === "company_admin"/,
  );
  assert.doesNotMatch(
    notificationRoute,
    /creator\.id === canonicalContractorId[\s\S]*creator\.contractor_access_level === "company_admin"/,
  );
  assert.match(
    notificationRoute,
    /creatorCanInvoice[\s\S]*belongsToInvoiceCompany/,
  );
});

test("the production audit verifies structural isolation and the exact SCRC roster", () => {
  for (const expected of [
    "contractor_company_wall_enforced",
    "multiple_company_admins_enabled",
    "non_admin_members_assignment_scoped",
    "company_identity_canonicalized",
    "invoice_permissions_company_scoped",
    "management_permissions_company_scoped",
    "technician_directory_company_scoped",
    "contractor_self_promotion_blocked",
    "work_order_rls_scoped",
    "related_data_rls_scoped",
    "sensitive_staff_data_rls_scoped",
    "invoice_rpcs_work_order_scoped",
    "read_rpcs_preserve_rls",
    "current_assignments_valid",
    "assignment_history_consistent",
    "profile_roles_consistent",
    "organizations_consistent",
    "approved_admins_configured",
    "approved_members_configured",
    "no_unapproved_scrc_admins",
    "no_scrc_cross_company_links",
    "scrc_company_admin_users",
    "scrc_assignment_scoped_users",
    "all_checks_pass",
  ]) {
    assert.match(audit, new RegExp(expected));
  }
  for (const email of [
    "scrcdallastexas@gmail.com",
    "jenniferk@scrcdtx.com",
    "nancypb.scrc@gmail.com",
    "alan_yeager@icloud.com",
    "dfwregoftexhvacr@gmail.com",
    "info.mrfreezems@gmail.com",
    "scrcrob@gmail.com",
    "ap@scrcdtx.com",
    "rayrush50@gmail.com",
  ]) {
    assert.match(audit, new RegExp(email.replace(".", "\\.")));
  }
  assert.match(audit, /exactly_approved_active_roster/);
  assert.match(audit, /count\(profile\.id\) = 3/);
  assert.match(audit, /count\(profile\.id\) = 6/);
});
