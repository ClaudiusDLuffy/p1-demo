import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  emailPriorityDeliveryClaimSchema,
  emailPriorityDeliveryRetrySchema,
  emailPrioritySourceMessageId,
  emailPriorityUpdateResultSchema,
  priorityIntakeCutoverDecision,
  priorityEscalationSlaFields,
} from "./emailPriorityEscalation";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/0120_atomic_email_priority_escalations.sql",
    import.meta.url,
  ),
  "utf8",
);

test("uses the immutable internet message ID with a Graph ID fallback", () => {
  assert.equal(
    emailPrioritySourceMessageId({
      id: "graph-id",
      internetMessageId: " <priority@service-now.com> ",
    }),
    "<priority@service-now.com>",
  );
  assert.equal(
    emailPrioritySourceMessageId({ id: "graph-id", internetMessageId: null }),
    "graph-id",
  );
});

test("recomputes escalated SLA deadlines from the original intake anchor", () => {
  assert.deepEqual(
    priorityEscalationSlaFields("p1", "2026-09-02T15:00:00.000Z"),
    {
      expectedSlaStartedAt: "2026-09-02T15:00:00.000Z",
      responseBreachAt: "2026-09-02T17:00:00.000Z",
      resolutionBreachAt: "2026-09-02T19:00:00.000Z",
    },
  );
  assert.deepEqual(priorityEscalationSlaFields("p1", null), {
    expectedSlaStartedAt: null,
    responseBreachAt: null,
    resolutionBreachAt: null,
  });
});

test("requires an explicit priority-intake cutover and skips older notices", () => {
  assert.deepEqual(
    priorityIntakeCutoverDecision("2026-09-08T00:00:00.000Z", undefined),
    {
      action: "hold",
      reason: "EMAIL_PRIORITY_INTAKE_START_AT is required before priority updates can run; mailbox left unchanged",
    },
  );
  assert.equal(
    priorityIntakeCutoverDecision(
      "2026-09-08T00:00:00.000Z",
      "not-a-date",
    ).action,
    "hold",
  );
  assert.equal(
    priorityIntakeCutoverDecision(
      "2026-09-08T00:00:00.000Z",
      "2026-09-08",
    ).action,
    "hold",
  );
  assert.equal(
    priorityIntakeCutoverDecision(
      "not-a-date",
      "2026-09-08T00:00:00.000Z",
    ).action,
    "hold",
  );
  assert.equal(
    priorityIntakeCutoverDecision(
      "2026-09-07T23:59:59.999Z",
      "2026-09-08T00:00:00.000Z",
    ).action,
    "skip",
  );
  assert.deepEqual(
    priorityIntakeCutoverDecision(
      "2026-09-08T00:00:00.000Z",
      "2026-09-08T00:00:00.000Z",
    ),
    { action: "process" },
  );
});

test("validates database priority update and delivery contracts at runtime", () => {
  assert.equal(
    emailPriorityUpdateResultSchema.safeParse({
      applied: true,
      replayed: false,
      outcome: "escalated",
      eventId: "7ce58bd2-6276-48c6-8b52-b76e295f5453",
      workOrderId: "WOT1266375",
      externalWorkOrderId: "WOT1266375",
      previousPriority: "p4",
      reportedPriority: "p1",
      currentPriority: "p1",
      deliveryStatus: "pending",
    }).success,
    true,
  );
  assert.equal(
    emailPriorityDeliveryClaimSchema.safeParse({
      claimStatus: "new_claim",
      eventId: "7ce58bd2-6276-48c6-8b52-b76e295f5453",
      workOrderId: "WOT1266375",
      externalWorkOrderId: "WOT1266375",
      previousPriority: "p4",
      reportedPriority: "p0",
      incidentId: null,
      storeNumber: null,
      storeState: null,
      city: null,
      address: null,
      summary: null,
      contractorName: null,
      sourceReceivedAt: "2026-09-02T16:00:00.000Z",
    }).success,
    false,
  );
  assert.equal(
    emailPriorityDeliveryRetrySchema.safeParse({
      eventId: "7ce58bd2-6276-48c6-8b52-b76e295f5453",
      deliveryStatus: "pending",
      attemptCount: 1,
      nextAttemptAt: "2026-09-02T16:00:30.000Z",
    }).success,
    true,
  );
});

test("migration serializes, orders, and atomically audits email escalations", () => {
  assert.match(migration, /create table if not exists public\.email_priority_escalation_events/);
  assert.match(migration, /source_message_id text not null unique/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /priority_source_received_at/);
  assert.match(migration, /v_priority_family_id/);
  assert.match(migration, /family\.duplicate_root_work_order_id = v_priority_family_id/);
  assert.match(migration, /family\.priority_source_received_at desc/);
  const familyWatermarkQuery = migration.slice(
    migration.indexOf("select\n    family.priority_source_message_id"),
    migration.indexOf("v_is_fresh :="),
  );
  assert.doesNotMatch(familyWatermarkQuery, /family\.deleted_at/);
  const applyFunction = migration.slice(
    migration.indexOf("create or replace function public.apply_email_work_order_priority_escalation"),
    migration.indexOf("comment on function public.apply_email_work_order_priority_escalation"),
  );
  assert.ok(
    applyFunction.indexOf("'work-order-priority:' || v_priority_family_id")
      < applyFunction.indexOf("coalesce(family.duplicate_sequence, 0) desc"),
  );
  assert.match(applyFunction, /coalesce\(family\.duplicate_sequence, 0\) desc[\s\S]*for update/);
  assert.match(
    migration,
    /create or replace function public\.duplicate_work_order_for_reassignment_notified[\s\S]*Active operational P1 staff required[\s\S]*'work-order-priority:' \|\| v_priority_family_id[\s\S]*A newer reassignment continuation exists/,
  );
  assert.match(
    migration,
    /Reassignment copy must use the current active continuation[\s\S]*Reassignment copy priority or SLA state is stale/,
  );
  assert.match(
    migration,
    /revoke all on function public\.duplicate_work_order_for_reassignment\(text\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(migration, /p_source_received_at > v_family_source_received_at/);
  assert.match(
    migration,
    /work_order_priority_rank\(v_reported_priority\)[\s\S]*< public\.work_order_priority_rank\(v_work_order\.priority\)/,
  );
  assert.match(migration, /v_outcome := 'not_escalation'/);
  assert.match(migration, /v_outcome := 'non_operational'/);
  assert.match(
    migration,
    /work_order_accepts_email_priority_escalation\([\s\S]*'pending_capital_completion'/,
  );
  assert.match(migration, /is distinct from 'Cancelled'/);
  assert.match(migration, /'work_order_priority_escalated'/);
  assert.match(migration, /returning id into v_activity_id/);
  assert.match(migration, /delivery_status[\s\S]*'pending'/);
  assert.match(migration, /delivery_attempt_count between 0 and 3/);
  assert.match(migration, /retry_email_priority_escalation_delivery/);
});

test("priority replay is bound to the original payload and returns the current family head", () => {
  const applyFunction = migration.slice(
    migration.indexOf("create or replace function public.apply_email_work_order_priority_escalation"),
    migration.indexOf("comment on function public.apply_email_work_order_priority_escalation"),
  );
  const replayBranch = applyFunction.slice(
    applyFunction.indexOf("if found then"),
    applyFunction.indexOf("select work_order.*\n  into v_work_order"),
  );

  assert.match(
    replayBranch,
    /v_existing\.source_received_at is distinct from p_source_received_at/,
  );
  assert.match(
    replayBranch,
    /v_existing\.source_subject is distinct from left/,
  );
  assert.match(
    replayBranch,
    /v_priority_family_id is distinct from\s+v_existing\.external_work_order_id/,
  );
  assert.match(replayBranch, /'work-order-priority:' \|\| v_priority_family_id/);
  assert.match(
    replayBranch,
    /coalesce\(family\.duplicate_sequence, 0\) desc[\s\S]*for share/,
  );
  assert.match(replayBranch, /'workOrderId', v_work_order\.id/);
});

test("only the notified duplicate wrapper can allocate a reassignment family child", () => {
  const provenanceGuard = migration.slice(
    migration.indexOf("create or replace function public.protect_work_order_priority_email_provenance"),
    migration.indexOf("create or replace function public.protect_work_order_priority_escalation_activity"),
  );
  const duplicateWrapper = migration.slice(
    migration.indexOf("create or replace function public.duplicate_work_order_for_reassignment_notified"),
    migration.indexOf("comment on function public.duplicate_work_order_for_reassignment_notified"),
  );

  assert.match(
    migration,
    /create table if not exists public\.work_order_priority_family_transition_guards/,
  );
  assert.match(
    migration,
    /revoke all on public\.work_order_priority_family_transition_guards\s+from public, anon, authenticated, service_role/,
  );
  assert.match(
    provenanceGuard,
    /delete from public\.work_order_priority_family_transition_guards[\s\S]*get diagnostics v_guard_consumed = row_count/,
  );
  assert.match(
    provenanceGuard,
    /Reassignment copies must be created through the notified duplication workflow/,
  );
  assert.ok(
    duplicateWrapper.indexOf("insert into public.work_order_priority_family_transition_guards")
      < duplicateWrapper.indexOf("public.duplicate_work_order_for_reassignment("),
  );
  assert.match(duplicateWrapper, /transition guard was not consumed safely/i);
});

test("priority audit activities are service-managed and manual edits target only the current family head", () => {
  const provenanceGuard = migration.slice(
    migration.indexOf("create or replace function public.protect_work_order_priority_email_provenance"),
    migration.indexOf("create or replace function public.protect_work_order_priority_escalation_activity"),
  );
  const manualUpdateGuard = provenanceGuard.slice(
    provenanceGuard.indexOf("if tg_op = 'UPDATE'\n     and coalesce(auth.role(), '')"),
  );
  const activityGuard = migration.slice(
    migration.indexOf("create or replace function public.protect_work_order_priority_escalation_activity"),
    migration.indexOf("create or replace function public.apply_email_work_order_priority_escalation"),
  );

  assert.match(
    manualUpdateGuard,
    /coalesce\(family\.duplicate_sequence, 0\) desc/,
  );
  assert.match(
    manualUpdateGuard,
    /newer reassignment continuation exists; refresh before changing priority or SLA fields/,
  );
  assert.doesNotMatch(manualUpdateGuard, /pg_advisory_xact_lock/);
  assert.match(activityGuard, /work_order_priority_escalated/);
  assert.match(
    migration,
    /coalesce\(auth\.role\(\), ''\) not in \('service_role', ''\)/,
  );
  assert.match(
    activityGuard,
    /before insert or update or delete[\s\S]*on public\.activities/,
  );
});

test("priority provenance and outbox functions are service-only", () => {
  assert.match(migration, /enable row level security/);
  assert.match(
    migration,
    /revoke all on public\.email_priority_escalation_events[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /if auth\.role\(\) <> 'service_role'[\s\S]*Service role required/,
  );
  assert.match(
    migration,
    /revoke all on function public\.apply_email_work_order_priority_escalation\([\s\S]*from public, anon, authenticated/,
  );
  const applyGrant = migration.slice(
    migration.lastIndexOf(
      "grant execute on function public.apply_email_work_order_priority_escalation",
    ),
    migration.lastIndexOf(
      "grant execute on function public.duplicate_work_order_for_reassignment_notified",
    ),
  );
  assert.match(applyGrant, /to service_role/);
  assert.doesNotMatch(applyGrant, /to authenticated/);
  assert.match(
    migration,
    /new\.priority is distinct from old\.priority[\s\S]*new\.sla_started_at is distinct from old\.sla_started_at/,
  );
  assert.match(
    migration,
    /public\.is_staff\(\)[\s\S]*not public\.is_invoice_controller\(\)/,
  );
});

test("processor routes repeat dispatches and explicit updates through the same RPC", () => {
  const processor = readFileSync(
    new URL("./emailIntakeProcessor.ts", import.meta.url),
    "utf8",
  );
  const escalationProcessor = readFileSync(
    new URL("./emailPriorityEscalationProcessor.ts", import.meta.url),
    "utf8",
  );
  const compactPatch = processor.slice(
    processor.indexOf("const compactPatch"),
    processor.indexOf("const saveAfmContact"),
  );
  const repeatDispatchBranch = processor.slice(
    processor.indexOf("} else if (match) {"),
    processor.indexOf("const workOrderId = parsed.wotId"),
  );

  assert.doesNotMatch(compactPatch, /patch\.priority/);
  assert.match(processor, /isConfirmedWorkOrderIntakeEmail/);
  assert.match(processor, /parsed\.emailType === "TYPE_PRIORITY_UPDATE"/);
  assert.ok(
    (processor.match(/applyEmailPriorityEscalation\(/g) || []).length >= 2,
  );
  assert.match(escalationProcessor, /claim_email_priority_escalation_delivery/);
  assert.match(escalationProcessor, /complete_email_priority_escalation_delivery/);
  assert.match(escalationProcessor, /retry_email_priority_escalation_delivery/);
  assert.match(escalationProcessor, /refresh_email_work_order_dispatch/);
  assert.match(escalationProcessor, /isGraphHttpError/);
  assert.match(escalationProcessor, /deliveryOutcomeUnknown/);
  assert.match(escalationProcessor, /Promise\.all/);
  assert.match(processor, /parsed\.priorityConflict/);
  assert.match(processor, /EMAIL_PRIORITY_INTAKE_START_AT/);
  assert.match(processor, /priorityUpdate\.outcome === "non_operational"/);
  assert.ok(
    processor.indexOf("for (const email of emails)")
      < processor.lastIndexOf("drainPendingPriorityEscalationNotifications(accessToken)"),
  );
  assert.match(
    repeatDispatchBranch,
    /applyEmailPriorityEscalation\(\s*match\.id,\s*parsed,\s*email,\s*patch[\s\S]*const resolvedWorkOrderId = priorityUpdate\.workOrderId/,
  );
  assert.doesNotMatch(repeatDispatchBranch, /\.from\("work_orders"\)[\s\S]*\.update\(/);
  assert.doesNotMatch(repeatDispatchBranch, /saveAfmContact\(/);
});
