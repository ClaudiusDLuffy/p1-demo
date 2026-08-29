import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0104_contractor_reassignment_silo_hardening.sql",
);
const audit = read(
  "supabase/audits/0104_contractor_work_order_silo_verification.sql",
);
const preflight = read(
  "supabase/audits/0104_contractor_work_order_silo_preflight.sql",
);

test("changing contractor atomically ends and clears the technician assignment", () => {
  assert.match(
    migration,
    /before update of contractor_id[\s\S]*when \(old\.contractor_id is distinct from new\.contractor_id\)/,
  );
  assert.match(
    migration,
    /update public\.work_order_technician_assignments assignment[\s\S]*assignment\.ended_at is null/,
  );
  for (const field of [
    "assigned_technician_profile_id",
    "technician_assigned_at",
    "technician_assigned_by",
    "technician_on_job",
  ]) {
    assert.match(migration, new RegExp(`new\\.${field} := null`));
  }
});

test("only the canonical company account is company-wide and every member is assignment scoped", () => {
  assert.match(
    migration,
    /viewer\.id = organization\.canonical_contractor_id[\s\S]*viewer\.contractor_access_level = 'company_admin'/,
  );
  assert.match(
    migration,
    /viewer\.id is distinct from organization\.canonical_contractor_id[\s\S]*assigned_technician_profile_id = viewer\.id[\s\S]*technician\.profile_id = viewer\.id[\s\S]*technician\.is_active = true/,
  );
  assert.doesNotMatch(
    migration,
    /viewer\.contractor_access_level = 'invoice'[\s\S]*not public\.is_linked_contractor_technician/,
  );
});

test("member role mistakes cannot grant company management or directory scope", () => {
  for (const functionName of [
    "can_invoice_for_contractor",
    "can_manage_contractor_company",
    "can_read_contractor_profile",
    "can_manage_work_order_technician",
  ]) {
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.${functionName}`),
    );
  }
  assert.match(
    migration,
    /can_manage_contractor_company\(\)[\s\S]*organization\.canonical_contractor_id = profile\.id/,
  );
  assert.match(
    migration,
    /can_manage_work_order_technician[\s\S]*organization\.canonical_contractor_id = viewer\.id/,
  );
  assert.match(
    migration,
    /create policy ct_read[\s\S]*organization\.canonical_contractor_id = viewer\.id/,
  );
  assert.match(
    migration,
    /profile\.contractor_access_level = 'invoice'[\s\S]*technician\.profile_id = profile\.id[\s\S]*technician\.is_active = true/,
  );
  assert.match(
    migration,
    /revoke all on function public\.contractor_account_id_for_profile\(uuid\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /revoke all on function public\.is_linked_contractor_technician\(uuid, uuid\)[\s\S]*from public, anon, authenticated/,
  );
});

test("legacy invoice RPCs are internal and their public wrappers require the current assignment", () => {
  assert.match(
    migration,
    /alter function public\.attach_contractor_invoice_pdf\(uuid, text\)[\s\S]*rename to attach_contractor_invoice_pdf_company_scope_legacy/,
  );
  assert.match(
    migration,
    /alter function public\.submit_contractor_invoice_once\([\s\S]*rename to submit_contractor_invoice_once_company_scope_legacy/,
  );
  assert.match(
    migration,
    /revoke all on function public\.attach_contractor_invoice_pdf_company_scope_legacy\([\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /revoke all on function public\.submit_contractor_invoice_once_company_scope_legacy\([\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /create or replace function public\.attach_contractor_invoice_pdf\([\s\S]*can_access_contractor_work_order\(invoice\.work_order_id\)[\s\S]*attach_contractor_invoice_pdf_company_scope_legacy/,
  );
  assert.match(
    migration,
    /create or replace function public\.submit_contractor_invoice_once\([\s\S]*existing_work_order_id is distinct from p_work_order_id[\s\S]*can_access_contractor_work_order\(existing_work_order_id\)[\s\S]*can_access_contractor_work_order\(p_work_order_id\)[\s\S]*submit_contractor_invoice_once_company_scope_legacy/,
  );
});

test("the repair touches only technician assignments invalid for the current contractor", () => {
  assert.match(
    migration,
    /where work_order\.assigned_technician_profile_id is not null[\s\S]*technician\.contractor_id = work_order\.contractor_id/,
  );
  assert.match(migration, /technician\.is_active = true/);
  assert.match(migration, /profile\.role = 'contractor'/);
  assert.match(migration, /profile\.active = true/);
  assert.match(
    migration,
    /contractor_account_id_for_profile\(profile\.id\)[\s\S]*= work_order\.contractor_id/,
  );
  assert.doesNotMatch(migration, /delete from public\./i);
});

test("the production audit verifies policies, RPC execution mode, roles, and live assignments", () => {
  for (const expected of [
    "canonical_contractor_wall_enforced",
    "canonical_company_admin_only",
    "organization_members_assignment_scoped",
    "management_helpers_canonical_only",
    "invoice_members_require_active_link",
    "security_definer_invoice_rpcs_assignment_scoped",
    "arbitrary_profile_identity_lookup_blocked",
    "legacy_invoice_rpc_execute_blocked",
    "technician_directory_canonical_only",
    "work_order_rls_scoped",
    "related_data_rls_scoped",
    "sensitive_staff_data_rls_scoped",
    "read_rpcs_preserve_rls",
    "reassignment_clears_technician",
    "current_assignments_valid",
    "assignment_history_consistent",
    "profile_roles_consistent",
    "profile_role_issues",
    "organizations_consistent",
    "organization_issues",
    "staff_role_users",
    "company_wide_scope_users",
    "organization_member_scope_users",
    "all_checks_pass",
  ]) {
    assert.match(audit, new RegExp(expected));
  }
  assert.match(audit, /procedure\.prosecdef/);
  assert.match(audit, /count\(distinct procedure\.proname\) = 10 as all_present/);
  assert.match(audit, /count\(distinct technician\.contractor_id\) > 1/);
  assert.match(audit, /technician\.is_active = true/);
  assert.match(audit, /expected_scoped_policies/);
  assert.match(audit, /expected_staff_only_policies/);
  assert.match(audit, /work_order_assignment_history_staff_read/);
  assert.match(audit, /contractor_invoice_payment_holds_read/);
  assert.match(audit, /controller_export_items_read/);
  assert.match(audit, /contractor_estimate_attachments_storage_read/);
  assert.match(audit, /get_work_order_activity_summaries/);
  assert.match(audit, /list_contractor_invoices_page/);
  assert.match(audit, /standalone canonical contractor account/);
  assert.match(audit, /noncanonical company member has company_admin access level/);
  assert.match(audit, /contractor organization member has no active technician link/);
  assert.match(
    audit,
    /profile\.contractor_organization_id is null[\s\S]*profile\.id = organization\.canonical_contractor_id/,
  );
});

test("the preflight is read-only and reports cross-company impact before deployment", () => {
  const executableSql = preflight.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(
    executableSql,
    /^\s*(insert\s+into|update\s+\S+\s+set|delete\s+from|alter\s+table|drop\s+|create\s+|truncate\s+)/im,
  );
  for (const expected of [
    "current_scope",
    "post_migration_scope",
    "scope_changes",
    "company_accounts_whose_scope_changes",
    "currently_visible_unassigned_work_orders",
    "active_current_company_link_rows",
    "active_other_company_link_rows",
    "required_action",
    "safety_note",
    "manual_role_confirmation_required",
    "assignment_will_be_cleared",
  ]) {
    assert.match(preflight, new RegExp(expected));
  }
  assert.match(preflight, /full company queue via unlinked invoice fallback/);
  assert.match(preflight, /do not share this login/i);
  assert.match(
    preflight,
    /confirm this is a real p1 staff account and not a contractor account with the wrong role/i,
  );
  assert.match(preflight, /lower\(company\) like '%starnes%'/);
});
