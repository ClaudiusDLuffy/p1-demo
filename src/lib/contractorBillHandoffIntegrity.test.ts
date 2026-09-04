import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0117_immutable_contractor_bill_handoff_packages.sql");
const audit = read("supabase/audits/0117_immutable_contractor_bill_handoff_packages_verification.sql");
const contractMigration = read("supabase/migrations/0118_contract_immutable_contractor_bill_handoff.sql");
const contractAudit = read("supabase/audits/0118_contract_immutable_contractor_bill_handoff_verification.sql");
const rolloutDocs = read("docs/quickbooks-sandbox.md");
const route = read("src/app/api/controller-exports/route.ts");

const definition = (name: string, source = migration) => source.match(
  new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
)?.[0] || "";

test("pending package guards bypass caller RLS and retain a pinned search path", () => {
  for (const name of [
    "guard_pending_contractor_bill_invoice",
    "guard_pending_contractor_bill_lines",
    "touch_invoice_after_line_change",
    "guard_contractor_bill_handoff_batch",
    "guard_contractor_bill_handoff_item",
  ]) {
    assert.match(definition(name), /security definer/);
    assert.match(definition(name), /set search_path = public, pg_temp/);
  }
  assert.match(audit, /trigger_guards_security_definer/);
  assert.match(definition("guard_pending_contractor_bill_invoice"), /auth\.role\(\)[\s\S]*service_role/);
});

test("staging locks parent and child rows and binds source plus archive revisions", () => {
  const stage = definition("stage_contractor_bill_handoff");
  assert.match(stage, /order by invoice\.id[\s\S]*for update of invoice/);
  assert.match(stage, /order by line\.invoice_id, line\.id[\s\S]*for update of line/);
  assert.match(stage, /invoice\.updated_at = \(source\.value->>'updatedAt'\)::timestamptz/);
  assert.match(stage, /archive_sha256/);
  assert.match(stage, /source_updated_at/);
  assert.match(stage, /source_pdf_path/);
  assert.match(audit, /legacy_pending_batch_count/);
  assert.match(audit, /invoice\.pdf_storage_path is distinct from item\.source_pdf_path/);
});

test("0117 expands compatibly and 0118 contracts only after the rollback window", () => {
  assert.doesNotMatch(migration, /controller_export_pending_verified_check/);
  assert.doesNotMatch(migration, /Legacy contractor-bill staging is disabled/);
  assert.doesNotMatch(migration, /Automatically cancelled during immutable contractor-bill handoff contract/);
  assert.equal(definition("stage_controller_invoice_export"), "");
  assert.equal(definition("complete_controller_invoice_export"), "");
  assert.match(audit, /legacy_stage_compatibility_preserved/);
  assert.match(audit, /legacy_complete_compatibility_preserved/);
  assert.match(audit, /verified_pending_constraint_deferred/);

  assert.match(contractMigration, /set local lock_timeout = '5s'/);
  assert.match(contractMigration, /lock table public\.controller_invoice_export_batches in access exclusive mode/);
  assert.match(contractMigration, /set status = 'cancelled'[\s\S]*archive_format is distinct from 'reference_manifest_v2'/);
  assert.match(contractMigration, /add constraint controller_export_pending_verified_check/);
  assert.match(
    definition("stage_controller_invoice_export", contractMigration),
    /Legacy contractor-bill staging is disabled[\s\S]*errcode = '55000'/,
  );
  assert.match(
    definition("complete_controller_invoice_export", contractMigration),
    /Legacy contractor-bill staging is disabled[\s\S]*errcode = '55000'/,
  );
  assert.doesNotMatch(contractMigration, /delete from public\.controller_invoice_export_(?:batches|items)/i);
  assert.match(contractAudit, /unverified_pending_batch_count = 0/);
  assert.match(contractAudit, /legacy_stage_disabled/);
  assert.match(contractAudit, /legacy_complete_disabled/);
  assert.match(contractAudit, /protected_stage_access_guarded/);
  assert.match(contractAudit, /pg_get_constraintdef\(constraint_row\.oid\)/);

  const lockTimeout = contractMigration.indexOf("set local lock_timeout = '5s'");
  const cutoffLock = contractMigration.indexOf("lock table public.controller_invoice_export_batches");
  const cancelLegacyPending = contractMigration.indexOf("set status = 'cancelled'");
  const requireVerifiedPending = contractMigration.indexOf("add constraint controller_export_pending_verified_check");
  const disableLegacyStage = contractMigration.indexOf("create or replace function public.stage_controller_invoice_export");
  assert.ok(lockTimeout >= 0 && lockTimeout < cutoffLock);
  assert.ok(cutoffLock < cancelLegacyPending);
  assert.ok(cancelLegacyPending < requireVerifiedPending);
  assert.ok(requireVerifiedPending < disableLegacyStage);

  const expand = rolloutDocs.indexOf("0117_immutable_contractor_bill_handoff_packages.sql");
  const deploy = rolloutDocs.indexOf("Deploy the revision-bound application");
  const rollbackWindow = rolloutDocs.indexOf("Close the rollback window for the old application");
  const contract = rolloutDocs.indexOf("0118_contract_immutable_contractor_bill_handoff.sql");
  assert.ok(expand >= 0 && expand < deploy);
  assert.ok(deploy < rollbackWindow);
  assert.ok(rollbackWindow < contract);
  assert.match(rolloutDocs, /do not apply 0118 while rollback could restore an app[\s\S]*calls the legacy RPCs/);
  assert.match(rolloutDocs, /five-second timeout[\s\S]*no contract changes commit/);
});

test("archive staging reconciles every RPC failure before cleanup", () => {
  assert.match(route, /try \{[\s\S]*stageResult = await auth\.sb\.rpc\([\s\S]*stageFailure = stageResult\.error;[\s\S]*\} catch \(error\) \{[\s\S]*stageFailure = error;/);
  assert.match(route, /archive_sha256,archive_bytes,archive_format/);
  assert.match(route, /fingerprintMatches/);
  assert.match(route, /if \(recoveryError\)[\s\S]*retained for recovery/);
  assert.match(route, /if \(cleanupError\)[\s\S]*orphaned archive could not be removed/);
  assert.match(route, /The archive was discarded and no invoices were changed/);
});

test("transport-ambiguous staging never deletes the uploaded archive", () => {
  assert.match(route, /let stageOutcomeAmbiguous = false/);
  assert.match(
    route,
    /stageFailure = stageResult\.error;[\s\S]*stageOutcomeAmbiguous = Boolean\(stageFailure\)[\s\S]*!hasDefinitiveDatabaseErrorCode\(stageFailure\)/,
  );
  assert.match(route, /catch \(error\) \{[\s\S]*stageFailure = error;[\s\S]*stageOutcomeAmbiguous = true;/);
  assert.match(
    route,
    /if \(stageOutcomeAmbiguous\) \{[\s\S]*archive was retained for safe reconciliation and was not deleted[\s\S]*\}[\s\S]*let cleanupError/,
  );
});

test("500-item and accumulated exclusion lookups stay below one URL-sized chunk", () => {
  assert.match(route, /controller_invoice_export_batches!inner\(status\)/);
  assert.match(route, /for \(const ids of chunk\(\[\.\.\.excludedIds\]\)\)/);
  assert.match(route, /for \(const ids of chunk\(requestedIds\)\)/);
  assert.match(route, /for \(const ids of chunk\(contractorIds\)\)/);
  assert.match(route, /for \(const ids of chunk\(workOrderIds\)\)/);
  assert.doesNotMatch(route, /\.not\("id", "in"/);
  assert.doesNotMatch(route, /\.in\("id", requestedIds\)/);
  assert.doesNotMatch(route, /\.in\("id", contractorIds\)/);
  assert.doesNotMatch(route, /\.in\("id", workOrderIds\)/);
  assert.doesNotMatch(route, /\.in\("batch_id", batchIds\)/);
});

test("malformed or shape-invalid batch requests fail closed", () => {
  assert.match(route, /const body = await request\.json\(\) as \{ invoiceIds\?: unknown \}/);
  assert.match(route, /body\.invoiceIds !== undefined && !Array\.isArray\(body\.invoiceIds\)/);
  assert.doesNotMatch(route, /request\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
  assert.match(route, /return jsonError\("Invalid JSON body", 400\)/);
});

test("large private ZIPs bypass the function response body", () => {
  assert.match(route, /zipArchiveByteLength\(entries\)/);
  assert.match(route, /createSignedUrl\(objectPath, 120/);
  assert.doesNotMatch(route, /new NextResponse\(Buffer\.from\(archive\)/);
});
