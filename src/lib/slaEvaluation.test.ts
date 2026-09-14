import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import * as slaConfig from "./slaConfig";
import * as evaluation from "./sla/evaluation";
import { evaluateSla, type SlaWorkOrder } from "./sla/evaluation";
import { priorityEditSlaPatch } from "./sla/priorityEdit";
import { SLA_COMPATIBILITY_POLICY, SLA_POLICY_PROVENANCE } from "./sla/policy";
import { slaLabel, slaRemaining } from "./slaDisplay";
import { getSlaAgingStyle, getSlaDueTime, sortWorkOrders } from "./workOrderView";
import { filterAndSortWorkOrderTable } from "./workOrderTable";

const now = new Date("2026-09-10T12:00:00.000Z");
const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

for (const priority of ["p1", "p2", "p3", "p4", "p5"] as const) {
  test(`one compatibility policy: ${priority} legacy display, sorting and overdue agree`, () => {
    const row = { id: "SYNTHETIC", priority, dispatchedAt: at(-1), slaStartedAt: at(20) };
    const hours = SLA_COMPATIBILITY_POLICY[priority].legacyHours;
    const model = evaluateSla(row, now);
    assert.equal(model.dueTime, hours ? Date.parse(at(hours - 1)) : null);
    assert.equal(getSlaDueTime(row, now), model.dueTime);
    assert.equal(slaRemaining(row, now)?.remainingHours ?? null, model.remainingHours);
    assert.equal(filterAndSortWorkOrderTable([row], { sla: "overdue" }, { column: "sla", direction: "asc" }, undefined, now).length, Number(model.breached));
  });
}

test("stored pair remains authoritative across priority changes and both legacy/intake anchors", () => {
  const stored = { dispatchedAt: at(-100), slaStartedAt: at(-2), responseBreachAt: at(1), resolutionBreachAt: at(3) };
  for (const priority of ["p1", "p2", "p3", "p4", "p5", "unknown", null]) {
    const model = evaluateSla({ ...stored, priority }, now);
    assert.equal(model.dueTime, Date.parse(at(1)));
    assert.equal(model.source, "stored");
    assert.equal(model.progress?.slaHours, 3);
  }
});

test("a missed response and future resolution has a future headline but active breach everywhere", () => {
  const row = { id: "SYNTHETIC", priority: "p1", responseBreachAt: at(-1), resolutionBreachAt: at(4) };
  const model = evaluateSla(row, now);
  assert.equal(model.headline, "resolution");
  assert.equal(model.dueTime, Date.parse(at(4)));
  assert.equal(model.breached, true);
  assert.equal(slaLabel(row, now)?.severity, "breach");
  assert.equal(slaLabel(row, now)?.text, "Response breached");
  assert.equal(getSlaAgingStyle(row, now).label, "Breached");
  assert.equal(filterAndSortWorkOrderTable([row], { sla: "overdue" }, { column: "sla", direction: "asc" }, undefined, now).length, 1);
});

test("check-in closes the response obligation and retains late-arrival audit", () => {
  const row = { responseBreachAt: at(-2), resolutionBreachAt: at(4), startTimeRaw: at(-1) };
  const model = evaluateSla(row, now);
  assert.equal(model.responseMet, true);
  assert.equal(model.responseWasLate, true);
  assert.equal(model.breached, false);
  assert.equal(model.dueTime, Date.parse(at(4)));
});

test("response-only stored deadline is not completed by an invalid check-in", () => {
  const row = { responseBreachAt: at(-2), startTimeRaw: "invalid", priority: "p1", dispatchedAt: at(-100) };
  const model = evaluateSla(row, now);
  assert.equal(model.responseMet, false);
  assert.equal(model.dueTime, Date.parse(at(-2)));
  assert.equal(model.breached, true);
  assert.equal(model.resolutionTime, null);
});

test("response-only completed deadline remains audit data without inventing a resolution deadline", () => {
  const row = { responseBreachAt: at(-2), startTimeRaw: at(-1), priority: "p1", dispatchedAt: at(-100) };
  const before = JSON.stringify(row);
  const model = evaluateSla(row, now);
  assert.equal(model.responseTime, Date.parse(at(-2)));
  assert.equal(model.responseWasLate, true);
  assert.equal(model.dueTime, null);
  assert.equal(model.breached, false);
  assert.equal(slaRemaining(row, now), null);
  assert.equal(JSON.stringify(row), before);
});

test("resolution-only stored deadline stays visible with unknown priority and no fabricated progress denominator", () => {
  const row = { priority: "unknown", resolutionBreachAt: at(2) };
  assert.deepEqual(slaRemaining(row, now), { remainingHours: 2, elapsedHours: null, slaHours: null, percent: null });
  assert.equal(getSlaDueTime(row, now), Date.parse(at(2)));
});

test("missing and unknown priority never fabricate a legacy deadline", () => {
  for (const priority of [null, undefined, "", "p6", "unknown"]) {
    assert.equal(evaluateSla({ priority, dispatchedAt: at(-4) }, now).dueTime, null);
  }
  assert.equal(evaluateSla({ priority: "p1", slaStartedAt: at(-4) }, now).dueTime, null);
  assert.equal(evaluateSla({ priority: "P1", dispatched_at: at(-4) }, now).dueTime, Date.parse(at(4)));
});

test("raw database aliases and application projection share the same stored deadlines", () => {
  const camel = { responseBreachAt: at(-1), resolutionBreachAt: at(3), slaStartedAt: at(-3), startTimeRaw: at(-2), priority: "p1" };
  const raw = { response_breach_at: at(-1), resolution_breach_at: at(3), sla_started_at: at(-3), start_time: at(-2), priority: "p1" };
  assert.deepEqual(evaluateSla(camel, now), evaluateSla(raw, now));
});

test("exact deadline is breached and invalid clocks never produce NaN", () => {
  assert.equal(evaluateSla({ resolutionBreachAt: now.toISOString() }, now).breached, true);
  const model = evaluateSla({ responseBreachAt: at(1), resolutionBreachAt: at(2) }, new Date("invalid"));
  assert.equal(model.remainingHours, null);
  assert.equal(model.progress, null);
  assert.equal(slaConfig.computeSlaState(at(1), at(2), null, new Date("invalid")), null);
  assert.equal(slaConfig.formatRemaining(Number.NaN), "Not set");
  assert.deepEqual(slaConfig.computeSlaBreaches("p1", new Date("invalid")), { responseBreachAt: null, resolutionBreachAt: null });
});

test("stored epoch deadline is not treated as absent", () => {
  const row = { id: "SYNTHETIC-EPOCH", responseBreachAt: "1970-01-01T00:00:00Z" };
  assert.equal(getSlaDueTime(row, now), 0);
  assert.equal(sortWorkOrders([{ id: "SYNTHETIC-NONE", responseBreachAt: null }, row], "sla_due", now)[0].id, row.id);
});

test("manual priority edit preserves full, partial and invalid stored fields without filling either half", () => {
  const rows: SlaWorkOrder[] = [
    { responseBreachAt: at(1), resolutionBreachAt: at(3) },
    { responseBreachAt: at(1), resolutionBreachAt: null },
    { responseBreachAt: null, resolutionBreachAt: at(3) },
    { responseBreachAt: "invalid" },
    { response_breach_at: at(1) },
  ];
  for (const row of rows) {
    const before = JSON.stringify(row);
    assert.deepEqual(priorityEditSlaPatch(row, "p1", now), {});
    assert.equal(JSON.stringify(row), before);
  }
});

test("manual priority edit retains existing generation only when neither deadline exists", () => {
  assert.deepEqual(priorityEditSlaPatch({ slaStartedAt: at(-1) }, "p1", now), { responseBreachAt: at(1), resolutionBreachAt: at(3) });
  assert.deepEqual(priorityEditSlaPatch({}, "p1", now), { responseBreachAt: at(2), resolutionBreachAt: at(4) });
  assert.deepEqual(priorityEditSlaPatch({}, "p5", now), { responseBreachAt: null, resolutionBreachAt: null });
  assert.deepEqual(priorityEditSlaPatch({ slaStartedAt: "invalid" }, "p1", now), {});
});

test("read evaluation is immutable and policy is explicitly awaiting owner approval", () => {
  const row = Object.freeze({ priority: "p1", responseBreachAt: at(1) });
  evaluateSla(row, now);
  assert.equal(SLA_POLICY_PROVENANCE.approval, "owner_confirmation_required");
  assert.equal(SLA_POLICY_PROVENANCE.legacyAnchor, "dispatched_at");
  assert.equal(SLA_POLICY_PROVENANCE.storedDeadlines, "authoritative_no_backfill");
});

type BadgeInput = { responseBreachAt: string | null; resolutionBreachAt: string | null; responseMetAt?: string | null; size?: "sm" | "md" };
const badgeExports: { SlaBadge?: (props: BadgeInput) => ReactNode } = {};
runInNewContext(ts.transpileModule(readFileSync("src/components/SlaBadge.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { exports: badgeExports, require: (path: string): unknown => {
    if (path === "react/jsx-runtime") return { jsx, jsxs };
    if (path === "../lib/slaConfig") return slaConfig;
    if (path === "../lib/sla/evaluation") return evaluation;
    throw new Error("Unexpected SLA badge import");
  } });

test("actual badge renders a stored partial deadline instead of silently disappearing", () => {
  assert.ok(badgeExports.SlaBadge);
  const markup = renderToStaticMarkup(badgeExports.SlaBadge({ responseBreachAt: "2099-01-01T00:00:00Z", resolutionBreachAt: null }));
  assert.match(markup, /Response in/);
  assert.doesNotMatch(markup, /NaN|Invalid Date/);
});

test("actual badge labels a completed partial response without an invented countdown", () => {
  assert.ok(badgeExports.SlaBadge);
  const markup = renderToStaticMarkup(badgeExports.SlaBadge({ responseBreachAt: "2020-01-01T00:00:00Z", resolutionBreachAt: null, responseMetAt: "2020-01-01T01:00:00Z" }));
  assert.match(markup, /Responded · Resolution deadline not set/);
  assert.doesNotMatch(markup, /breached|NaN|Invalid Date/);
});

test("actual consumer wiring uses the pure model and safe manual priority command", () => {
  const portal = readFileSync("src/components/PortalShell.tsx", "utf8");
  // The shell count is now authorized/on demand, never recomputed from its
  // partial exact-record cache. Stored-deadline list evaluation stays intact.
  assert.ok(/slaBreached: navigationSummary\?\.slaBreachedCount \?\? null/.test(portal));
  assert.match(portal, /Object\.assign\(patch, priorityEditSlaPatch\(woData, editWoForm\.priority\)\)/);
  assert.doesNotMatch(portal, /computeSlaBreaches\(editWoForm\.priority/);
  assert.ok(!/return evaluateSla\(w, slaTick\)\.breached/.test(portal));
  assert.match(portal, /slaNow=\{slaTick\}/);
  const list = readFileSync("src/features/work-orders/WorkOrderList.tsx", "utf8");
  assert.match(list, /sortBy,\s+slaNow,/);
  assert.match(list, /isManager, slaNow, sortBy/);
});
