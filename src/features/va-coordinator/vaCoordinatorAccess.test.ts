import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/0175_va_coordinator_scoped_access.sql"), "utf8");
const managerBackOfficeTeamManagementMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/0178_manager_backoffice_va_team_management.sql"), "utf8");
const testAccountExclusionMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/0179_va_team_test_account_exclusion.sql"), "utf8");
const allWorkOrdersMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/0180_va_coordinator_all_work_orders_archive_teams.sql"), "utf8");
const staffAuthorization = readFileSync(resolve(process.cwd(), "supabase/migrations/0101_enforce_active_staff_authorization.sql"), "utf8");
const portalShell = readFileSync(resolve(process.cwd(), "src/components/PortalShell.tsx"), "utf8");
const workOrderList = readFileSync(resolve(process.cwd(), "src/features/work-orders/WorkOrderList.tsx"), "utf8");
const workOrderDetail = readFileSync(resolve(process.cwd(), "src/features/work-orders/WorkOrderDetail.tsx"), "utf8");

test("VA accounts use the standard portal shell with the scoped VA work-order read path", () => {
  assert.match(portalShell, /return <>\s*<PortalApplication key=/);
  assert.doesNotMatch(portalShell, /VaCoordinatorWorkspace/);
  assert.match(portalShell, /useVaCoordinatorWorkOrder\(/);
  assert.match(portalShell, /useVaCoordinatorTechnicianNotes\(/);
  assert.match(portalShell, /useVaCoordinatorAttachments\(/);
  assert.match(portalShell, /invoices=\{isVaCoordinator \? \[\] : invoices\}/);
  assert.match(portalShell, /function PortalApplication\(/);
});

test("VA list uses the role-scoped page and never falls back to a generic cached work-order list", () => {
  assert.match(workOrderList, /useVaCoordinatorWorkOrders\(/);
  assert.match(workOrderList, /serverPage\?\.items \|\| \(isVaCoordinator \? \[\]/);
  assert.match(workOrderList, /isVaCoordinator \? "Search work order, store, city, or summary/);
  assert.match(workOrderList, /listQueryEnabled && !isVaCoordinator/);
});

test("VA detail is read-only apart from its confirmed note-transfer callback", () => {
  assert.match(workOrderDetail, /currentUser\?\.role === "va_coordinator"/);
  assert.match(workOrderDetail, /contractorHistoryReadOnly = isVaCoordinator \|\|/);
  assert.match(workOrderDetail, /loadAllPhotoPaths=\{isVaCoordinator \?/);
  assert.match(workOrderDetail, /onMarkVaNoteCopiedToSevenEleven=\{onMarkVaNoteCopiedToSevenEleven\}/);
  assert.match(workOrderDetail, /!isVaCoordinator && !focused && billingDocuments/);
  assert.match(workOrderDetail, /!isVaCoordinator && !woData\.billingOnly && <ReceivingDispatchStatus/);
});

test("initial VA visibility was a private team-to-technician mapping over current assignments", () => {
  assert.match(migration, /create schema if not exists va_coordinator_private/);
  assert.match(migration, /revoke all on schema va_coordinator_private from public, anon, authenticated, service_role/);
  assert.match(migration, /team_members[\s\S]*team_technicians/);
  assert.match(migration, /w\.assigned_technician_profile_id/);
  assert.match(migration, /team\.active = true/);
  assert.match(migration, /configure_va_coordinator_team_v1/);
  assert.match(migration, /assignment_events/);
  assert.match(migration, /not public\.is_staff\(\) or public\.is_invoice_controller\(\)/);
  assert.match(migration, /p\.role = 'va_coordinator' and p\.active = true/);
  assert.match(migration, /p\.role = 'contractor' and p\.active = true/);
  assert.match(staffAuthorization, /profile\.role in \('manager', 'dispatcher', 'back_office'\)/);
});

test("team-management reads and writes are restricted to active managers and back-office staff", () => {
  assert.equal((managerBackOfficeTeamManagementMigration.match(/actor\.role in \('manager', 'back_office'\)[\s\S]*?actor\.active = true/g) || []).length, 2);
  assert.match(managerBackOfficeTeamManagementMigration, /configure_va_coordinator_team_v1[\s\S]*?actor\.role in \('manager', 'back_office'\)[\s\S]*?actor\.active = true/);
  assert.match(managerBackOfficeTeamManagementMigration, /list_va_coordinator_team_management_v1[\s\S]*?actor\.role in \('manager', 'back_office'\)[\s\S]*?actor\.active = true/);
  assert.doesNotMatch(managerBackOfficeTeamManagementMigration, /public\.is_staff\(\)|is_invoice_controller/);
  assert.match(managerBackOfficeTeamManagementMigration, /profile\.role = 'va_coordinator' and profile\.active/);
  assert.match(managerBackOfficeTeamManagementMigration, /profile\.role = 'contractor' and profile\.active/);
  assert.match(managerBackOfficeTeamManagementMigration, /technician\.profile_id = profile\.id and technician\.is_active/);
  assert.match(managerBackOfficeTeamManagementMigration, /grant execute on function public\.list_va_coordinator_team_management_v1\(\) to authenticated, service_role/);
  assert.doesNotMatch(managerBackOfficeTeamManagementMigration, /jsonb_build_object\([\s\S]*?'(?:email|phone|billing|pricing)'/i);
});

test("VA team roster excludes explicitly marked test technicians at read and save boundaries", () => {
  assert.match(testAccountExclusionMigration, /add column if not exists is_test_account boolean not null default false/);
  assert.match(testAccountExclusionMigration, /create function public\.list_va_coordinator_team_management_v2\(\)/);
  assert.match(testAccountExclusionMigration, /profile\.is_test_account = true/);
  assert.match(testAccountExclusionMigration, /create function public\.configure_va_coordinator_team_v2/);
  assert.match(testAccountExclusionMigration, /profile\.is_test_account is true/);
  assert.match(testAccountExclusionMigration, /revoke all on function public\.list_va_coordinator_team_management_v1\(\) from authenticated/);
  assert.match(testAccountExclusionMigration, /revoke all on function public\.configure_va_coordinator_team_v1\(uuid,text,uuid\[\],uuid\[\]\) from authenticated/);
});

test("VA read RPCs return a bounded allowlist and use a keyset cursor", () => {
  const list = migration.match(/create function public\.list_va_coordinator_work_orders_v1\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(list, /p_limit integer default 25, p_cursor jsonb default null/);
  assert.match(list, /limit p_limit \+ 1/);
  assert.match(list, /'nextCursor'/);
  assert.match(list, /'assetMake'[\s\S]*'assetModel'[\s\S]*'assetSerial'/);
  assert.doesNotMatch(list, /'(?:invoice[^']*|billing[^']*|nte[^']*|contractor_id|pricing[^']*)'/i);
  assert.match(migration, /a\.entered_by_role = 'contractor'[\s\S]*a\.is_staff_only = false/);
});

test("photo metadata and bytes require a finalized canonical binding and shared VA work-order access", () => {
  assert.match(migration, /binding\.state = 'finalized'/);
  assert.match(migration, /create function public\.can_read_va_coordinator_photo\(uuid, text\)[\s\S]*?binding\.storage_object_id = \$1[\s\S]*?public\.can_access_va_coordinator_work_order\(work_order\.id\)/);
  assert.match(migration, /public\.can_read_va_coordinator_photo\(objects\.id, name\)/);
  assert.doesNotMatch(migration, /create policy va_coordinator_photos_read[\s\S]*auth\.uid\(\) is not null/);
});

test("note transfer reuses the existing sync command and prevents VAs from undoing or reattributing it", () => {
  assert.match(migration, /create or replace function public\.mark_work_order_activity_synced_v1\(p_activity_id uuid, p_synced boolean\)/);
  assert.match(migration, /if v_is_va and not p_synced then/);
  assert.match(migration, /a\.synced_to_7eleven_at is null/);
  assert.match(migration, /synced_to_7eleven_by = case when p_synced then auth\.uid\(\) else null end/);
  assert.match(migration, /create or replace function public\.protect_activity_7eleven_sync\(\)[\s\S]*?g\.command_kind = 'sync'[\s\S]*?public\.can_access_va_coordinator_work_order\(old\.work_order_id\)/);
  assert.match(migration, /old\.synced_to_7eleven_at is not null[\s\S]*?new\.synced_to_7eleven_at is null/);
});

test("current VA access covers every non-deleted work order without changing the scoped DTO", () => {
  assert.match(allWorkOrdersMigration, /public\.is_va_coordinator\(\) and exists \([\s\S]*?work_order\.id = p_work_order_id[\s\S]*?work_order\.deleted_at is null/);
  const list = allWorkOrdersMigration.match(/create or replace function public\.list_va_coordinator_work_orders_v1\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(list, /if not public\.is_va_coordinator\(\)/);
  assert.match(list, /work_order\.deleted_at is null/);
  assert.doesNotMatch(list, /team_members|team_technicians|contractor_technicians|assigned_technician_profile_id\s*=/);
  assert.match(list, /v_cursor_time := 'infinity'::timestamptz/);
  assert.doesNotMatch(list, /p_cursor is null or/);
  assert.match(list, /limit p_limit \+ 1/);
  assert.match(list, /'nextCursor'/);
  assert.match(list, /'assetMake'[\s\S]*'assetModel'[\s\S]*'assetSerial'/);
  assert.doesNotMatch(list, /'(?:invoice[^']*|billing[^']*|nte[^']*|contractor_id|pricing[^']*)'/i);
  assert.match(list, /coalesce\(work_order\.incident_id/);
  assert.match(allWorkOrdersMigration, /work_orders_va_coordinator_updated_cursor_idx/);
});

test("VA team management is hidden and existing team configuration is archived, not deleted", () => {
  assert.match(allWorkOrdersMigration, /update va_coordinator_private\.teams\s+set active = false\s+where active = true/);
  assert.doesNotMatch(allWorkOrdersMigration, /delete\s+from\s+va_coordinator_private\.(?:teams|team_members|team_technicians|assignment_events)/i);
  assert.match(allWorkOrdersMigration, /revoke all on function public\.list_va_coordinator_team_management_v2\(\) from public, anon, authenticated/);
  assert.match(allWorkOrdersMigration, /revoke all on function public\.configure_va_coordinator_team_v2\(uuid, text, uuid\[\], uuid\[\]\) from public, anon, authenticated/);
  assert.doesNotMatch(portalShell, /VaCoordinatorTeamManagement|canManageVaCoordinatorTeams/);
});
