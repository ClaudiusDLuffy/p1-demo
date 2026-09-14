import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const collect = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const name = join(directory, entry.name);
  return entry.isDirectory() ? collect(name) : /\.[jt]sx?$/.test(name) ? [name] : [];
});
const sources = new Map(collect("src").map(name => [name, readFileSync(name, "utf8")]));
const activity = "src/features/work-orders/data/activityReadRepository.ts";
const activityMapper = "src/features/work-orders/data/activityMappers.ts";
const visit = "src/features/work-orders/data/visitReadRepository.ts";
const visitMapper = "src/features/work-orders/data/visitMappers.ts";
const facade = "src/lib/db.ts";
const queries = "src/features/work-orders/queries.ts";
const guardUrl = pathToFileURL(resolve("scripts/verify-phase-7c2-activity-visit-read-boundary.mjs")).href;

async function verify(input: Map<string, string>): Promise<unknown> {
  const namespace: unknown = await import(guardUrl);
  assert.ok(namespace !== null && typeof namespace === "object");
  const method: unknown = Reflect.get(namespace, "verifyActivityVisitReadBoundary");
  assert.equal(typeof method, "function");
  if (typeof method !== "function") throw new Error("Missing executable activity/visit ownership guard");
  const result: unknown = Reflect.apply(method, undefined, [input]);
  return result;
}

test("activity/visit ownership guard accepts separate production owners and compatible facades", async () => {
  const result = await verify(sources);
  assert.ok(result !== null && typeof result === "object");
  assert.equal(Reflect.get(result, "passed"), true);
  assert.equal(Reflect.get(result, "owners"), 8);
  assert.equal(Reflect.get(result, "facadeMethods"), 2);
});

const injections: readonly [string, string, string][] = [
  ["React in activity repository", activity, 'import React from "react";'],
  ["React runtime in visit repository", visit, 'import { jsx } from "react/jsx-runtime";'],
  ["Supabase in activity mapper", activityMapper, 'import { supabase } from "../../../lib/supabase/client";'],
  ["Supabase in visit mapper", visitMapper, 'import { supabase } from "../../../lib/supabase/client";'],
  ["configuration in mapper", activityMapper, 'import { config } from "../../../lib/config/runtime";'],
  ["ambient mapper clock", visitMapper, 'export const syntheticClock = () => new Date();'],
  ["activity mutation", activity, 'export const syntheticMutation = (client) => client.insert({});'],
  ["visit mutation", visit, 'export const syntheticMutation = (client) => client.update({});'],
  ["Storage operation", visit, 'export const syntheticUpload = (client) => client.upload("private", new Blob());'],
  ["Realtime owner", activity, 'export const syntheticChannel = (client) => client.channel("activity").subscribe();'],
  ["legacy db cycle", activity, 'import { loadWorkOrderActivitiesPage } from "../../../lib/db";'],
  ["broad delegated owner", activity, 'import { readEverything } from "./timelineRepository";'],
  ["cross-family visit query", activity, 'export const syntheticWrongFamily = (port) => port.read("list_work_order_visits_rows_v1", {}, undefined);'],
  ["cross-family activity query", visit, 'export const syntheticWrongFamily = (port) => port.read("list_work_order_activities_rows_v1", {}, undefined);'],
  ["broad projection", visit, 'export const syntheticProjection = (client) => client.select("*");'],
  ["N+1", activity, 'export async function syntheticN1(rows, port) { for (const row of rows) await port.read("list_work_order_activities_rows_v1", {id:row.id}, undefined); }'],
  ["async per-row query", visit, 'export const syntheticN1 = (rows, port) => Promise.all(rows.map(row => port.read("list_work_order_visits_rows_v1", {}, undefined)));'],
  ["all-page collector", visit, 'export async function syntheticCollector(port) { while (true) await port.read("list_work_order_visits_rows_v1", {}, undefined); }'],
  ["raw-result cast", activity, 'export const syntheticUnsafe = (raw:unknown) => raw as ActivityReadRow;'],
  ["angle-bracket cast", visit, 'export const syntheticUnsafe = (raw:unknown) => <VisitReadRow>raw;'],
  ["any boundary", visit, 'export const syntheticUnsafe = (raw:any) => raw;'],
  ["legacy activity mapper", facade, 'const mapActivity = row => row;'],
  ["legacy visit mapper", facade, 'const mapVisit = row => row;'],
  ["dynamic legacy import", activity, 'export const syntheticLegacy = () => import("../../../lib/db");'],
  ["CommonJS legacy import", visit, 'export const syntheticLegacy = () => require("../../../lib/db");'],
  ["direct network", visit, 'export const syntheticNetwork = () => fetch("https://example.invalid");'],
  ["native server client edge", visit, 'import fs from "node:fs";'],
  ["new complete-visit collector importer", "src/features/work-orders/SyntheticCollector.ts", 'import { loadAllWorkOrderVisits } from "../../lib/db";'],
];
for (const [label, filename, injected] of injections) {
  test(`activity/visit ownership guard rejects ${label}`, async () => {
    const changed = new Map(sources);
    changed.set(filename, `${sources.get(filename) || ""}\n${injected}\n`);
    await assert.rejects(verify(changed));
  });
}

const replacements: readonly [string, string, string, string][] = [
  ["dropped activity signal", activity, "}, signal);", "}, undefined);"],
  ["dropped visit signal", visit, "}, signal);", "}, undefined);"],
  ["lost activity parent binding", activity, "p_work_order_id: workOrder.id", 'p_work_order_id: "other-parent"'],
  ["lost visit parent binding", visit, "p_work_order_id: workOrderId", 'p_work_order_id: "other-parent"'],
  ["changed cursor bytes", visit, "p_cursor: cursor", "p_cursor: cursor?.toLowerCase()"],
  ["missing activity validator", activity, "parseActivityReadPage(data, workOrder.id)", "syntheticUnchecked(data)"],
  ["missing visit validator", visit, "parseVisitReadPage(data, workOrderId)", "syntheticUnchecked(data)"],
  ["discarded validated page", visit, "const page = parseVisitReadPage(data, workOrderId);", "const discarded = parseVisitReadPage(data, workOrderId); const page = data;"],
  ["changed facade name", facade, "export async function loadWorkOrderActivitiesPage(", "export async function renamedActivitiesPage("],
  ["changed detail query key", queries, "queryKey: workOrderDetailsKey(", "queryKey: syntheticKey("],
  ["lost query actor scope", queries, "workOrderDetailsKey(workOrderId, scope)", 'workOrderDetailsKey(workOrderId, "global")'],
  ["lost count parent", queries, 'workOrderChildCountKey(scope, workOrderId, "activities")', 'workOrderChildCountKey(scope, "other", "activities")'],
  ["transport no longer supports cancellation", "src/lib/counts/readRpc.ts", "request.abortSignal(signal)", "request"],
];
for (const [label, filename, before, after] of replacements) {
  test(`activity/visit ownership guard rejects ${label}`, async () => {
    const original = sources.get(filename);
    assert.ok(original);
    assert.ok(original.includes(before), `Negative probe must actually alter ${label}`);
    const changed = new Map(sources);
    changed.set(filename, original.replace(before, after));
    await assert.rejects(verify(changed));
  });
}

test("activity/visit raw-boundary guard does not rewrite unrelated legacy source", async () => {
  const changed = new Map(sources);
  changed.set("src/lib/SyntheticUnrelated.ts", 'export const existingLegacy = (raw:unknown) => raw as ExistingLegacyRow;');
  await assert.doesNotReject(verify(changed));
});
