import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "supabase/migrations/0161_short_circuit_contractor_profile_reads.sql",
  "utf8",
);
const verification = readFileSync(
  "supabase/audits/0161_short_circuit_contractor_profile_reads_verification.sql",
  "utf8",
);

function position(fragment: RegExp) {
  const match = migration.match(fragment);
  assert.ok(match?.index !== undefined, `Missing ${fragment}`);
  return match.index;
}

test("profile reads short-circuit staff and self before organization or team lookup", () => {
  const functionStart = position(/create or replace function public\.can_read_contractor_profile/);
  const staff = position(/if public\.is_staff\(\) then/);
  const self = position(/if p_profile_id = auth\.uid\(\) then/);
  const organization = position(/from public\.profiles viewer\s+join public\.organizations organization/);
  const team = position(/from public\.contractor_technicians lead_membership/);

  assert.ok(functionStart < staff);
  assert.ok(staff < self);
  assert.ok(self < organization);
  assert.ok(organization < team);
  assert.doesNotMatch(migration, /return public\.contractor_team_lead_can_manage_profile/);
});

test("company administrators and team leads keep the existing organization boundaries", () => {
  assert.match(migration, /if v_access_level = 'company_admin' then/);
  assert.match(migration, /target\.contractor_organization_id = v_organization_id/);
  assert.match(migration, /if v_tier = 'mr_freeze'/);
  assert.match(migration, /v_access_level = 'report_only'/);
  assert.match(migration, /lead_membership\.contractor_id = v_canonical_contractor_id/);
  assert.match(migration, /membership\.contractor_id = v_canonical_contractor_id/);
  assert.match(migration, /target\.id = v_viewer_id\s+or target\.dispatcher_id = v_viewer_id/);
});

test("migration fails closed on authorization drift and preserves the execute surface", () => {
  assert.match(migration, /d8e199f56a957565558495ae6adb781305024e6717edaa18057fd89ac11954e9/);
  assert.match(migration, /Contractor profile authorization drifted; review before optimizing/);
  assert.match(migration, /language plpgsql\s+security definer\s+stable/);
  assert.match(migration, /set search_path = public, pg_temp/);
  assert.match(migration, /revoke all on function public\.can_read_contractor_profile\(uuid\)[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.can_read_contractor_profile\(uuid\)[\s\S]*to authenticated, service_role/);
  assert.match(migration, /has_function_privilege\(\s*'anon'/);
});

test("deployment verification is read-only and checks the exact installed definition", () => {
  assert.match(verification, /PASS_0161_INSTALLED/);
  assert.match(verification, /ad3ea17398cf1695e635f049d4dfdba790f7fed6f5a1568d64a9354e587bcc5e/);
  assert.match(verification, /short_circuit_order_installed/);
  assert.match(verification, /profile_policy_preserved/);
  assert.doesNotMatch(
    verification,
    /^\s*(?:insert|update|delete|truncate|alter|grant|revoke|create|drop)\s/im,
  );
});
