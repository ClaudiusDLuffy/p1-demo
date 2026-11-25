import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("src/lib/db.ts", "utf8");
const start = source.indexOf("export async function markWorkOrderNotesSeen(");
const end = source.indexOf("/** @deprecated Raw visit writes", start);
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
type Reply = { data: { updated_at: string } | null; error: Error | null };
const timestamp = "2026-11-25T12:00:00.123456+00:00";
function harness(update: Reply, read: Reply = update) {
  const calls: { name: string; value?: unknown }[] = [];
  const chain = {
    update(value: unknown) { calls.push({ name: "update", value }); return this; },
    eq(name: string, value: unknown) { calls.push({ name, value }); return this; },
    or(value: string) { calls.push({ name: "predicate", value }); return this; },
    select(value: string) { calls.push({ name: "select", value }); return this; },
    maybeSingle: async () => update,
    single: async () => { calls.push({ name: "read-current" }); return read; },
  };
  const exports: { markWorkOrderNotesSeen?: (id: string, at: string) => Promise<string> } = {};
  runInNewContext(compiled, { exports, Date, Number, Error, supabase: () => ({ from: () => chain }),
    normalizeUnknownError: (error: Error) => error });
  assert.ok(exports.markWorkOrderNotesSeen);
  return { calls, acknowledge: (at = timestamp) => exports.markWorkOrderNotesSeen!("SYNTHETIC-WO", at) };
}

test("note acknowledgement preserves microseconds and only advances an older read position", async () => {
  const h = harness({ data: { updated_at: timestamp }, error: null });
  assert.equal(await h.acknowledge(), timestamp);
  assert.equal(h.calls.find(call => call.name === "predicate")?.value,
    `staff_notes_seen_at.is.null,staff_notes_seen_at.lt.${timestamp}`);
  assert.equal(h.calls.some(call => call.name === "read-current"), false);
});
test("duplicate or older acknowledgement reads the current version without a second update", async () => {
  const newer = "2026-11-25T12:00:00.123457+00:00";
  const h = harness({ data: null, error: null }, { data: { updated_at: newer }, error: null });
  assert.equal(await h.acknowledge(), newer);
  assert.equal(h.calls.filter(call => call.name === "update").length, 1);
  assert.equal(h.calls.filter(call => call.name === "read-current").length, 1);
});
test("failed acknowledgement does not fall through to a success read", async () => {
  const error = new Error("Synthetic write denied");
  const h = harness({ data: null, error });
  await assert.rejects(h.acknowledge(), error);
  assert.equal(h.calls.some(call => call.name === "read-current"), false);
});
test("readback failure remains a failure", async () => {
  const error = new Error("Synthetic read denied");
  await assert.rejects(harness({ data: null, error: null }, { data: null, error }).acknowledge(), error);
});
test("missing readback version cannot authorize a guarded action", async () => {
  await assert.rejects(harness({ data: null, error: null }).acknowledge(), /did not return its updated version/);
});
test("invalid timestamps cannot enter a PostgREST predicate", async () => {
  for (const value of ["", "invalid", "2026-11-25T12:00:00Z,other.eq.true"]) {
    const h = harness({ data: null, error: null });
    await assert.rejects(h.acknowledge(value), /timestamp is invalid/);
    assert.equal(h.calls.length, 0);
  }
});
