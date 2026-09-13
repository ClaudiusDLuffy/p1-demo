// Focused local contract verifier. It performs no provider calls or deployments.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/0133_receiving_contractor_dispatch_outbox.sql", import.meta.url), "utf8");
const audit = readFileSync(new URL("../supabase/audits/0133_receiving_contractor_dispatch_integrity_verification.sql", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/notifications/dispatch/route.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/lib/server/receivingDispatchWorker.ts", import.meta.url), "utf8");
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
check("dedicated outbox identity is unique by assignment version, recipient and event", () => assert.match(migration, /unique\(work_order_id, assignment_version, recipient_profile_id, event_type\)/));
check("assignment trigger queues initial and reassignment events", () => { assert.match(migration, /after insert or update of contractor_id,contractor_assignment_version/); assert.match(migration, /'assignment' else 'reassignment'/); });
check("unassignment creates no receiving event", () => assert.match(migration, /if new\.contractor_id is null/));
check("missing or inactive recipient is visible as not deliverable", () => assert.match(migration, /status='not_deliverable'/));
check("superseded assignments are quarantined before claim", () => assert.match(migration, /status='superseded'/));
check("claims are bounded and overlap-safe", () => { assert.match(migration, /for update skip locked/); assert.match(migration, /least\(coalesce\(p_limit,25\),100\)/); });
check("claim, start and completion are separate service functions", () => { assert.match(migration, /claim_receiving_dispatch_deliveries_v1/); assert.match(migration, /start_receiving_dispatch_delivery_v1/); assert.match(migration, /complete_receiving_dispatch_delivery_v1/); });
check("unresolved outcomes have a reasoned reconciliation boundary", () => { assert.match(migration, /resolve_receiving_dispatch_delivery_v1/); assert.match(migration, /A bounded reconciliation reason is required/); });
check("completion rejects unsafe states and preserves retry delay", () => { assert.match(migration, /Invalid receiving dispatch completion state/); assert.match(migration, /interval '5 minutes'/); });
check("browser compatibility route cannot directly send Graph mail", () => { assert.doesNotMatch(route, /sendDispatchNotification|sendEmail|getAccessToken/); assert.match(route, /status: "queued"/); });
check("worker is bounded and server-only", () => { assert.match(worker, /MAX_BATCH = 25/); assert.match(worker, /LEASE_SECONDS = 60/); assert.match(worker, /createServerClient/); });
check("ambiguous provider outcomes become unknown", () => assert.match(worker, /GRAPH_OUTCOME_UNKNOWN/));
check("audit is read-only and reports unresolved integrity states", () => { assert.doesNotMatch(audit, /\b(insert|update|delete|truncate)\b/i); assert.match(audit, /expired_claims/); assert.match(audit, /unknown_deliveries/); });
check("cron route is protected by CRON_SECRET through the Phase 5D configuration boundary", () => {
  const drain = readFileSync(new URL("../src/app/api/notifications/dispatch/drain/route.ts", import.meta.url), "utf8");
  const cron = readFileSync(new URL("../src/lib/config/server/cron.ts", import.meta.url), "utf8");
  assert.match(drain, /import \{ isCronAuthorized, assertScheduledJobsAllowed \} from/);
  assert.match(drain, /const authorized = isCronAuthorized/);
  assert.ok(drain.indexOf("if (!authorized(request))") < drain.indexOf("await drainReceivingDispatches()"));
  assert.match(cron, /requiredValue\(values, "CRON_SECRET", "cron", 4096\)/);
  assert.match(cron, /left\.length === right\.length && timingSafeEqual\(left, right\)/);
});
console.log(`Receiving-dispatch verification: ${passed} passed. Synthetic/static only; no Graph, JWT/PostgREST gateway, or independent-session claim proof.`);
