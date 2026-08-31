import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(
  resolve(process.cwd(), path),
  "utf8",
);

const migration = read(
  "supabase/migrations/0108_restore_emily_quickbooks_handoff.sql",
);
const audit = read(
  "supabase/audits/0108_emily_quickbooks_handoff_authorization_verification.sql",
);

test("Emily handoff authorization is guarded, exact, and idempotent", () => {
  assert.match(
    migration,
    /lower\(trim\(coalesce\(profile\.email, ''\)\)\)[\s\S]*= 'emilyb@phospitality\.com'/,
  );
  assert.match(migration, /matching_profile_count <> 1/);
  assert.match(migration, /active_staff_match_count <> 1/);
  assert.match(migration, /profile\.active = true/);
  assert.match(
    migration,
    /profile\.role in \('manager', 'dispatcher', 'back_office'\)/,
  );
  assert.match(
    migration,
    /insert into public\.staff_permission_grants[\s\S]*'quickbooks_handoff'/,
  );
  assert.match(migration, /on conflict \(profile_id, permission\) do nothing/);
  assert.doesNotMatch(migration, /'invoice_controller'/);
  assert.doesNotMatch(migration, /'quickbooks_export'/);
  assert.doesNotMatch(
    migration,
    /delete from public\.staff_permission_grants/i,
  );
});

test("the production audit fails closed on permission drift", () => {
  assert.match(audit, /exactly_one_emily_profile/);
  assert.match(audit, /emily_handoff_grant_present/);
  assert.match(audit, /exactly_approved_handoff_roster/);
  assert.match(audit, /no_unexpected_handoff_grantees/);
  assert.match(audit, /anonymous_permission_table_blocked/);
  assert.match(audit, /anonymous_export_tables_blocked/);
  assert.match(audit, /handoff_rpcs_server_only/);
  assert.match(
    audit,
    /where permission_grant\.permission = 'quickbooks_handoff'[\s\S]*and not \(/,
  );
  assert.match(
    audit,
    /unexpected - remove pending named-backup approval/,
  );
  assert.match(
    audit,
    /no_unexpected_handoff_grantees[\s\S]*as all_checks_pass/,
  );
});
