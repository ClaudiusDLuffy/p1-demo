import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/0134_receiving_contractor_dispatch_outbox.sql", "utf8");
const route = readFileSync("src/app/api/notifications/dispatch/route.ts", "utf8");
const worker = readFileSync("src/lib/server/receivingDispatchWorker.ts", "utf8");
const intake = readFileSync("src/lib/emailIntakeProcessor.ts", "utf8");

test("receiving dispatch has immutable assignment identity and bounded claim state", () => {
  assert.match(migration, /unique\(work_order_id, assignment_version, recipient_profile_id, event_type\)/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /status='superseded'/);
  assert.match(migration, /status='not_deliverable'/);
  assert.match(migration, /limit greatest\(1,least\(coalesce\(p_limit,25\),100\)\)/);
  assert.match(migration, /event_type in \('assignment','reassignment','duplicate_assignment'\)/);
});

test("assignment trigger queues current recipient and never queues unassignment", () => {
  assert.match(migration, /if new\.contractor_id is null or \(tg_op='UPDATE' and new\.contractor_id is not distinct from old\.contractor_id\)/);
  assert.match(migration, /'duplicate_assignment'/);
  assert.match(migration, /else 'reassignment' end/);
  assert.match(migration, /on conflict \(work_order_id,assignment_version,recipient_profile_id,event_type\) do nothing/);
});

test("browser dispatch compatibility route does not import or call Graph sending", () => {
  assert.doesNotMatch(route, /sendDispatchNotification|sendEmail|getAccessToken/);
  assert.match(route, /status: "queued"/);
});

test("email intake does not own direct receiving delivery", () => {
  assert.doesNotMatch(intake, /sendDispatchNotification/);
});

test("worker is server-only, bounded, claim-token protected, and classifies ambiguity", () => {
  assert.match(worker, /MAX_BATCH = 25/);
  assert.match(worker, /LEASE_SECONDS = 60/);
  assert.match(worker, /p_claim_token: claimToken/);
  assert.match(worker, /GRAPH_OUTCOME_UNKNOWN/);
  assert.match(worker, /status === "unknown"/);
});

test("service drain route requires CRON_SECRET and uses Node runtime", () => {
  const source = readFileSync("src/app/api/notifications/dispatch/drain/route.ts", "utf8");
  assert.match(source, /runtime = "nodejs"/);
  assert.match(source, /isCronAuthorized/);
  assert.match(readFileSync("src/lib/config/server/cron.ts", "utf8"), /CRON_SECRET/);
  assert.match(readFileSync("src/lib/config/server/cron.ts", "utf8"), /timingSafeEqual/);
  assert.match(source, /status: 401/);
});
