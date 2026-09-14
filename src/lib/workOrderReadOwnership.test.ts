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
const repository = "src/features/work-orders/data/workOrderReadRepository.ts";
const mapper = "src/features/work-orders/data/workOrderMappers.ts";
const facade = "src/lib/db.ts";
const queries = "src/features/work-orders/queries.ts";
const guardUrl = pathToFileURL(resolve("scripts/verify-phase-7c1-work-order-read-boundary.mjs")).href;

async function verify(input: Map<string, string>): Promise<unknown> {
  const namespace: unknown = await import(guardUrl);
  assert.ok(namespace !== null && typeof namespace === "object");
  const method: unknown = Reflect.get(namespace, "verifyWorkOrderReadBoundary");
  assert.equal(typeof method, "function");
  if (typeof method !== "function") throw new Error("Missing executable ownership guard");
  return Reflect.apply(method, undefined, [input]);
}

test("work-order ownership guard accepts the complete production feature/facade graph", async () => {
  const result: unknown = await verify(sources);
  assert.ok(result !== null && typeof result === "object");
  assert.equal(Reflect.get(result, "passed"), true);
  assert.equal(Reflect.get(result, "facadeMethods"), 2);
});

const injections: readonly [string, string, string][] = [
  ["React in repository", repository, 'import React from "react";'],
  ["Supabase in mapper", mapper, 'import { supabase } from "../../../lib/supabase/client";'],
  ["ambient clock in mapper", mapper, 'export const syntheticClock = () => Date.now();'],
  ["database write", repository, 'export const syntheticWrite = (client) => client.insert({});'],
  ["Storage call", repository, 'export const syntheticUpload = (client) => client.upload("private", new Blob());'],
  ["Realtime call", repository, 'export const syntheticRealtime = (client) => client.channel("work-orders").subscribe();'],
  ["unrelated query", repository, 'export const syntheticInvoiceRead = (port) => port.read("list_invoices", {}, undefined);'],
  ["per-row query", repository, 'export async function syntheticN1(rows, port) { for (const row of rows) await port.read("get_portal_work_order", {id:row.id}, undefined); }'],
  ["all-page collector", repository, 'export async function syntheticCollector(port) { while (true) await port.read("list_work_orders_rows_v1", {}, undefined); }'],
  ["unchecked raw cast", repository, 'export const syntheticUnsafe = (raw:unknown) => raw as any;'],
  ["concrete raw row cast", repository, 'export const syntheticUnsafeRow = (raw:unknown) => raw as WorkOrderReadRow;'],
  ["angle-bracket raw row cast", repository, 'export const syntheticUnsafeAngle = (raw:unknown) => <WorkOrderReadRow>raw;'],
  ["legacy mapper duplication", facade, 'const mapWO = value => value;'],
  ["legacy argument duplication", facade, 'export function workOrderReadArgs(params = {}) { return params; }'],
  ["new all-record loader importer", "src/features/work-orders/SyntheticCollector.ts", 'import { loadWorkOrders } from "../../lib/db";'],
  ["new all-record hook importer", "src/features/work-orders/SyntheticHook.ts", 'import { useWorkOrdersQuery } from "./queries";'],
  ["Node server dependency", repository, 'import fs from "node:fs";'],
];
for (const [label, filename, injected] of injections) {
  test(`work-order ownership guard rejects ${label}`, async () => {
    const changed = new Map(sources);
    changed.set(filename, `${sources.get(filename) || ""}\n${injected}\n`);
    await assert.rejects(verify(changed));
  });
}

test("work-order raw-assertion rule does not rewrite unrelated legacy boundaries", async () => {
  const changed = new Map(sources);
  changed.set("src/lib/SyntheticOutOfScope.ts", 'export const existingLegacyBridge = (raw:unknown) => raw as ExistingLegacyRow;');
  await assert.doesNotReject(verify(changed));
});

for (const [label, filename, before, after] of [
  ["dropped transport signal", repository, 'args, signal);', 'args, undefined);'],
  ["missing runtime validator", repository, 'parseWorkOrderReadPage(data)', 'syntheticUncheckedPage(data)'],
  ["changed facade signature", facade, 'export async function loadWorkOrdersPage(', 'export async function renamedLoadWorkOrdersPage('],
  ["changed page query key", queries, 'queryKey: workOrderPagesKey(', 'queryKey: syntheticOtherPageKey('],
  ["missing independent count subscription", queries, 'const countQuery = useWorkOrdersCountQuery(', 'const countQuery = syntheticCombinedCount('],
] as const) {
  test(`work-order ownership guard rejects ${label}`, async () => {
    const original = sources.get(filename);
    assert.ok(original, `Negative probe owner ${filename} must exist`);
    assert.ok(original.includes(before), `Negative probe must actually change ${label}`);
    const changed = new Map(sources);
    changed.set(filename, original.replace(before, after));
    await assert.rejects(verify(changed));
  });
}
