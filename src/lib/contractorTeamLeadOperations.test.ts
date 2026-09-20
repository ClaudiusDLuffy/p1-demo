import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/0158_contractor_team_lead_operations.sql",
), "utf8");

test("team lead authority is active, organization-bound, linked, and report-only", () => {
  assert.match(migration, /create or replace function public\.is_contractor_team_lead/);
  assert.match(migration, /organization\.active = true[\s\S]*canonical_contractor_id is not null/);
  assert.match(migration, /membership\.profile_id = lead\.id[\s\S]*membership\.is_active = true/);
  assert.match(migration, /lead\.contractor_tier = 'mr_freeze'/);
  assert.match(migration, /lead\.contractor_access_level = 'report_only'/);
  assert.match(migration, /target\.contractor_organization_id = organization\.id/);
  assert.match(migration, /target\.id = lead\.id or target\.dispatcher_id = lead\.id/);
});

test("team lead work-order access and assignment remain bounded to the current team", () => {
  assert.match(migration, /create or replace function public\.can_access_contractor_work_order/);
  assert.match(migration, /work_order\.contractor_id = case[\s\S]*canonical\.id/);
  assert.match(migration, /contractor_team_lead_can_manage_profile\([\s\S]*work_order\.assigned_technician_profile_id/);
  assert.match(migration, /create or replace function public\.can_manage_work_order_technician/);
  assert.match(migration, /A team lead may assign only an active member of their own team/);
  assert.match(migration, /p_technician_profile_id is null[\s\S]*contractor_team_lead_can_manage_profile/);
});

test("proxy visits retain acting accounts and technician subjects independently", () => {
  assert.match(migration, /add column if not exists technician_profile_id uuid/);
  assert.match(migration, /checked_in_by and checked_out_by remain the acting portal accounts/);
  assert.match(migration, /coalesce\(v_work\.assigned_technician_profile_id, auth\.uid\(\)\)/);
  assert.match(migration, /'actedByProfileId', v_actor\.id/);
  assert.match(migration, /'onBehalfOfTechnician'/);
  assert.match(migration, /new\.technician_profile_id is distinct from old\.technician_profile_id/);
});

test("time correction authorization and overlap checks follow the actual technician", () => {
  assert.match(migration, /visit_technician_id := coalesce\(visit\.technician_profile_id, visit\.checked_in_by\)/);
  assert.match(migration, /contractor_team_lead_can_manage_profile\([\s\S]*visit_technician_id/);
  assert.match(migration, /coalesce\(other\.technician_profile_id, other\.checked_in_by\) = visit_technician_id/);
  assert.match(migration, /insert into public\.work_order_visit_corrections/);
  assert.match(migration, /'technicianProfileId', visit_technician_id/);
});

test("team directory and client capability use current authoritative scope", () => {
  assert.match(migration, /'canLeadTeam', public\.can_lead_contractor_team\(\)/);
  assert.match(migration, /p_domain = 'legacy_team'[\s\S]*public\.can_lead_contractor_team\(\)/);
  assert.match(migration, /when 'legacy_team' then p\.role = 'contractor' and p\.active = true/);
  assert.match(migration, /contractor_team_lead_can_manage_profile\([\s\S]*p\.id/);
});

test("migration retains explicit grants and private implementation helpers", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(migration, /revoke all on function public\.is_contractor_team_lead[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.can_lead_contractor_team\(\)[\s\S]*to authenticated, service_role/);
  assert.match(migration, /revoke all on function public\.correct_work_order_visit_lc_core[\s\S]*from public, anon, authenticated, service_role/);
});

test("canonical private photo access follows the same team wall without granting invoice files", () => {
  assert.match(migration, /create or replace function public\.private_object_actor_access/);
  assert.match(migration, /actor\.contractor_tier = 'mr_freeze'[\s\S]*target\.dispatcher_id = actor\.id/);
  assert.match(migration, /and \([\s\S]*not p_invoice_capable[\s\S]*actor\.contractor_access_level = 'invoice'/);
  assert.match(migration, /revoke all on function public\.private_object_actor_access\(uuid, text, boolean\)/);
});
