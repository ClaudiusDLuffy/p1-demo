import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = (name: string) => readFileSync(
  resolve(process.cwd(), `supabase/migrations/${name}`),
  "utf8",
);

const controller = migration("0064_controller_exports_and_staff_permissions.sql");
const additiveQuickBooks = migration("0071_additive_quickbooks_export_permission.sql");
const procurement = migration("0065_p1_parts_procurement.sql");
const technicians = migration("0066_staff_managed_contractor_technicians.sql");
const capitalEnums = migration("0067_pending_capital_completion_enums.sql");
const capitalWorkflow = migration("0068_pending_capital_completion_workflow.sql");

test("controller permissions and invoice numbering are data-driven and atomic", () => {
  assert.match(controller, /staff_permission_grants/);
  assert.match(controller, /public\.is_staff\(\)[\s\S]*and not public\.is_invoice_controller\(\)[\s\S]*or profile_id = auth\.uid\(\)/);
  assert.match(controller, /staff_invoice_default_series/);
  assert.match(controller, /update public\.staff_invoice_default_series[\s\S]*returning prefix, next_number - 1/);
  assert.match(controller, /complete_controller_invoice_export/);
  assert.match(controller, /for update/);
  assert.match(controller, /set state = 'paid'/);
  assert.match(controller, /invoice\.pdf_storage_path is not null[\s\S]*or exists \([\s\S]*from public\.invoice_lines/);
  assert.doesNotMatch(controller, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test("QuickBooks export is additive and preserves the optional restricted role", () => {
  assert.match(additiveQuickBooks, /'quickbooks_export'/);
  assert.match(additiveQuickBooks, /where permission_grant\.permission = 'invoice_controller'/);
  assert.match(additiveQuickBooks, /public\.has_staff_permission\('quickbooks_export'\)/);
  assert.match(additiveQuickBooks, /public\.profile_has_staff_permission\([\s\S]*p_actor_id,[\s\S]*'quickbooks_export'/);
  assert.match(additiveQuickBooks, /complete_controller_invoice_export/);
  assert.doesNotMatch(additiveQuickBooks, /delete from public\.staff_permission_grants/i);
  assert.doesNotMatch(additiveQuickBooks, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test("P1 parts procurement is guarded, configurable, and idempotent", () => {
  assert.match(procurement, /protect_p1_part_procurement_fields_trigger/);
  assert.match(procurement, /p1_part_procurement_transition_guards/);
  assert.match(procurement, /transition_guard\.transaction_id = txid_current\(\)/);
  assert.doesNotMatch(procurement, /set_config\('p1\.parts_procurement_transition'/);
  assert.match(procurement, /request_p1_part_order/);
  assert.match(procurement, /set_p1_part_order_status/);
  assert.match(procurement, /p1_parts_alert_settings/);
  assert.match(procurement, /p1_parts_alert_recipients/);
  assert.match(procurement, /unique \(recipient_id, local_date\)/);
  assert.match(procurement, /claim_p1_parts_alert_delivery/);
  assert.match(procurement, /p1_order_status is not null/);
  assert.match(procurement, /work_order\.status <> 'closed'/);
  assert.match(procurement, /received part cannot be sent to P1 purchasing/i);
  assert.match(procurement, /profile_has_staff_permission\(p_actor_id, 'invoice_controller'\)/);
  assert.match(procurement, /public\.is_staff\(\) and public\.is_invoice_controller\(\)/);
  assert.match(procurement, /not public\.is_staff\(\)[\s\S]*or public\.is_invoice_controller\(\)/);
  assert.doesNotMatch(procurement, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test("staff-managed technician access preserves history and uses service-side transitions", () => {
  assert.match(technicians, /configure_contractor_technician/);
  assert.match(technicians, /deactivate_contractor_technician/);
  assert.match(technicians, /contractor_technician_admin_events/);
  assert.match(technicians, /and work_order\.status <> 'closed'/);
  assert.match(technicians, /existing contractor account with history cannot be converted/i);
  assert.match(technicians, /company administrator cannot be converted to a technician/i);
  assert.match(technicians, /work_order\.contractor_id = member\.id/);
  assert.match(technicians, /invoice\.contractor_id = member\.id/);
  assert.match(technicians, /set active = false/);
  assert.match(technicians, /profile_has_staff_permission\(p_actor_id, 'invoice_controller'\)/);
  assert.match(technicians, /contractor_technician_admin_events_read[\s\S]*public\.is_staff\(\)[\s\S]*and not public\.is_invoice_controller\(\)/);
  assert.doesNotMatch(technicians, /delete from public\.(?:profiles|contractor_technicians)/i);
  assert.doesNotMatch(technicians, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test("capital authorization is a two-stage server-enforced workflow", () => {
  assert.match(capitalEnums, /pending_capital_completion/);
  assert.match(capitalEnums, /Approved - work authorized/);
  assert.match(capitalWorkflow, /v_requires_capital_authorization/);
  assert.match(capitalWorkflow, /capital_status = 'Pending approval'/);
  assert.match(capitalWorkflow, /create or replace function public\.resume_capital_work/);
  assert.match(capitalWorkflow, /v_work_order\.status <> 'pending_capital_completion'/);
  assert.match(capitalWorkflow, /capital_status = 'Approved - work authorized'/);
  assert.match(capitalWorkflow, /'capital_work_authorized'/);
  assert.match(capitalWorkflow, /profile\.active = true/);
  assert.match(capitalWorkflow, /profile_has_staff_permission\(p_actor_id, 'invoice_controller'\)/);
  assert.match(capitalWorkflow, /profile_has_staff_permission\(v_actor\.id, 'invoice_controller'\)/);
});
