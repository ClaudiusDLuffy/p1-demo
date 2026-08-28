import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = (path: string) => readFileSync(
  resolve(process.cwd(), path),
  "utf8",
);

const migration = source("supabase/migrations/0102_private_contractor_estimate_templates.sql");
const audit = source("supabase/audits/0102_contractor_estimate_template_verification.sql");
const publisher = source("scripts/publish-contractor-estimate-templates.ts");
const dataLayer = source("src/lib/db.ts");
const estimatePanel = source("src/features/estimates/ContractorEstimatePanel.tsx");

test("approved templates use a private read-only xlsx library", () => {
  assert.match(migration, /create table if not exists public\.contractor_estimate_templates/);
  assert.match(migration, /alter table public\.contractor_estimate_templates enable row level security/);
  assert.match(migration, /'contractor-estimate-templates',[\s\S]*false,[\s\S]*15728640/);
  assert.match(migration, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(migration, /public\.is_staff\(\)/);
  assert.match(migration, /public\.can_invoice_for_contractor/);
  assert.match(migration, /revoke all on table public\.contractor_estimate_templates[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(migration, /create policy contractor_estimate_templates_storage_(?:insert|update|delete)/);
});

test("the publisher is limited to the two approved workbooks", () => {
  assert.match(migration, /template_key in \('heatcraft', 'carrier'\)/);
  assert.match(publisher, /key: "heatcraft"/);
  assert.match(publisher, /key: "carrier"/);
  assert.match(publisher, /createHash\("sha256"\)/);
  assert.match(publisher, /--dry-run/);
  assert.doesNotMatch(publisher, /Site Square Footage|HVAC Load Calculator/i);
});

test("invoice-capable contractors can discover and download templates", () => {
  assert.match(dataLayer, /loadContractorEstimateTemplates/);
  assert.match(dataLayer, /\.from\("contractor_estimate_templates"\)/);
  assert.match(dataLayer, /\.from\("contractor-estimate-templates"\)[\s\S]*\.download\(template\.storagePath\)/);
  assert.match(estimatePanel, /Approved equipment form templates/);
  assert.match(estimatePanel, /Download a blank form, complete it in Excel/);
  assert.match(estimatePanel, /downloadContractorEstimateTemplate/);
});

test("deployment audit requires private storage, both objects, and no private workbook", () => {
  assert.match(audit, /private_xlsx_bucket_present/);
  assert.match(audit, /approved_metadata_published/);
  assert.match(audit, /approved_objects_published/);
  assert.match(audit, /private_workbooks_excluded/);
  assert.match(audit, /as all_checks_pass/);
});
