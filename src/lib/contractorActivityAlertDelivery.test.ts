import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0110_idempotent_contractor_activity_alerts.sql",
);
const audit = read(
  "supabase/audits/0110_idempotent_contractor_activity_alerts_verification.sql",
);
const route = read("src/app/api/notifications/contractor-attention/route.ts");

test("one activity owns one service-only contractor email delivery", () => {
  assert.match(
    migration,
    /activity_id uuid primary key[\s\S]*references public\.activities\(id\)/,
  );
  assert.match(migration, /enable row level security/);
  assert.match(
    migration,
    /revoke all on public\.contractor_activity_alert_deliveries[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant all on public\.contractor_activity_alert_deliveries[\s\S]*to service_role/,
  );
});

test("concurrent and repeated claims return distinct terminal delivery states", () => {
  assert.match(migration, /on conflict \(activity_id\) do nothing/);
  assert.match(
    migration,
    /if delivery\.status = 'sent' then[\s\S]*return 'already_sent'/,
  );
  assert.match(
    migration,
    /if delivery\.status = 'unknown' then[\s\S]*return 'delivery_unknown'/,
  );
  assert.match(migration, /return 'pending_or_unknown'/);
  assert.doesNotMatch(migration, /status = 'claimed',[\s\S]*status = 'failed'/);
  assert.match(migration, /if auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /activity\.contractor_assignment_version[\s\S]*= work_order\.contractor_assignment_version/);
});

test("the route claims before Graph and never retries an unknown outcome", () => {
  const claimIndex = route.indexOf('"claim_contractor_activity_alert_delivery"');
  const sendIndex = route.indexOf("sendContractorPortalPing(contractor.email)");
  assert.ok(claimIndex >= 0 && sendIndex > claimIndex);
  assert.match(
    route.slice(claimIndex, sendIndex),
    /deliveryClaim === "already_sent"[\s\S]*deliveryClaim === "pending_or_unknown"[\s\S]*deliveryClaim === "delivery_unknown"/,
  );
  assert.equal(
    (route.match(/"complete_contractor_activity_alert_delivery"/g) || []).length,
    2,
  );
  assert.match(route, /p_status: "unknown"/);
  assert.doesNotMatch(route, /p_status: "failed"/);
  assert.match(route, /p_status: "sent"/);
  assert.match(route, /p_actor_id: auth\.profile\.id/);
});

test("the release audit checks privilege, uniqueness, scope, and delivery state", () => {
  assert.match(audit, /anonymous_table_access_blocked/);
  assert.match(audit, /authenticated_table_access_blocked/);
  assert.match(audit, /one_delivery_per_activity/);
  assert.match(audit, /delivery_scope_issue_count/);
  assert.match(audit, /delivery_state_issue_count/);
  assert.match(audit, /all_checks_pass/);
});
