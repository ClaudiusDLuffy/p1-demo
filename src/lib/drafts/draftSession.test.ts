import assert from "node:assert/strict";
import test from "node:test";
import { createDraftSession, DRAFT_MAX_BYTES, DRAFT_MAX_RECORDS, type DraftStorage } from "./draftSession";
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const validate = (value: unknown): { text: string } | null => value && typeof value === "object" && "text" in value
  && typeof value.text === "string" && Object.keys(value).length === 1 ? { text: value.text } : null;
function fixture() {
  const values = new Map<string, string>(); let failRemove = false, failSet = false, silentWrite = false, clock = 1000, counter = 0;
  const storage: DraftStorage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (failSet) throw new Error("synthetic"); if (!silentWrite) values.set(key, value); },
    removeItem: key => { if (failRemove) throw new Error("synthetic"); values.delete(key); } };
  const diagnostics: { category: string; count: number }[] = [];
  const make = (project = "https://synthetic.invalid", environment: "test" | "preview" = "test") => createDraftSession({ project, environment,
    storage, now: () => clock, random: () => `generation-${++counter}`, diagnostic: (category, count) => diagnostics.push({ category, count }) });
  const session = make(); assert.equal(session.activate(user, true), true);
  return { values, storage, session, make, diagnostics, failures: (remove = false, set = false, silent = false) => {
    failRemove = remove; failSet = set; silentWrite = silent;
  }, tick: (time: number) => { clock = time; } };
}
test("same actor/project/environment refresh restores only verified versioned payload", () => {
  const f = fixture(); const lease = f.session.open("staff-billing", "new:WOT100", validate)!;
  assert.equal(lease.save({ text: "synthetic" }).status, "persisted"); assert.equal(lease.isPersisted(), true);
  assert.equal(f.session.hasDrafts(), true); lease.close();
  const next = f.make(); next.activate(user, true); assert.deepEqual(next.open("staff-billing", "new:WOT100", validate)?.read(), { text: "synthetic" });
  for (const isolated of [f.make("https://other.invalid"), f.make(undefined, "preview")]) {
    isolated.activate(user, true); assert.equal(isolated.open("staff-billing", "new:WOT100", validate)?.read(), null);
  }
});
test("logout tombstone fences cleanup/debounced old callbacks and next identity", () => {
  const f = fixture(); const lease = f.session.open("staff-billing", "new", validate)!; lease.save({ text: "synthetic" });
  const staleTicket = f.session.generation(); f.session.revoke(user);
  assert.equal(lease.save({ text: "late" }).status, "revoked"); assert.equal(lease.read(), null); assert.equal(lease.discard(), false);
  assert.equal(f.session.activate(user, true, staleTicket), false);
  f.session.activate(other, true); assert.equal(f.session.open("staff-billing", "new", validate)?.read(), null);
  assert.equal([...f.values.keys()].some(key => key.includes(`:draft:${user}:`)), false);
});
test("cross-tab logout and account switch fence an old tab even before storage event", () => {
  const f = fixture(); const first = f.session.open("quote-calculator", "WOT100", validate)!; first.save({ text: "synthetic" });
  const second = f.make(); second.activate(user, true); second.revoke(user);
  assert.equal(first.save({ text: "late" }).status, "revoked"); f.session.storageChanged();
  assert.equal(f.session.hasDrafts(), false); second.activate(other, true); assert.equal(first.read(), null);
});
test("inactive identity denies recovery and session loss purges without owner supplied", () => {
  const f = fixture(); const lease = f.session.open("staff-billing", "new", validate)!; lease.save({ text: "synthetic" });
  assert.equal(f.session.activate(user, false), false); assert.equal(lease.save({ text: "late" }).status, "revoked");
  f.session.activate(user, true); f.session.open("staff-billing", "next", validate)?.save({ text: "synthetic" });
  const blank = f.make(); assert.equal(blank.revoke(), true); assert.equal(f.session.hasDrafts(), false);
});
test("successful discard prevents stale lease recreation and can retry failed removal safely", () => {
  const f = fixture(); const lease = f.session.open("staff-billing", "new", validate)!; lease.save({ text: "synthetic" });
  f.failures(true); assert.equal(lease.discard(), false); assert.equal(lease.save({ text: "late" }).status, "revoked");
  f.failures(); assert.equal(lease.discard(), true); const replacement = f.session.open("staff-billing", "new", validate)!;
  replacement.save({ text: "new" }); assert.equal(lease.discard(), false); assert.equal(replacement.isPersisted(), true);
});
test("storage denial and quota/readback failures never promise recovery or prevent logout", () => {
  for (const mode of ["throw", "silent"] as const) {
    const f = fixture(); const lease = f.session.open("staff-billing", "new", validate)!;
    f.failures(false, mode === "throw", mode === "silent"); assert.equal(lease.save({ text: "synthetic" }).status, "unavailable");
    assert.equal(lease.isPersisted(), false); assert.doesNotThrow(() => f.session.revoke(user));
    assert.equal(lease.save({ text: "late" }).status, "revoked");
  }
});
test("two tabs compare revisions; stale tab cannot overwrite newer verified draft", () => {
  const f = fixture(); const a = f.session.open("staff-billing", "new", validate)!; a.save({ text: "one" });
  const tab = f.make(); tab.activate(user, true); const b = tab.open("staff-billing", "new", validate)!; b.read(); b.save({ text: "two" });
  assert.equal(a.isPersisted(), false); assert.equal(a.save({ text: "old" }).status, "conflict"); assert.deepEqual(a.read(), { text: "two" });
});
test("read interleaving never labels a different tab's value as confirmation of the old payload", () => {
  const f = fixture(); const first = f.session.open("staff-billing", "new", validate)!; first.save({ text: "one" });
  const key = [...f.values.keys()].find(value => value.includes(`:draft:${user}:`))!;
  const getter = f.storage.getItem; let reads = 0;
  f.storage.getItem = candidate => {
    if (candidate === key && ++reads === 2) {
      const prior = JSON.parse(f.values.get(key)!) as Record<string, unknown>;
      f.values.set(key, JSON.stringify({ ...prior, revision: "other-revision", payload: { text: "two" } }));
    }
    return getter(candidate);
  };
  assert.equal(first.read(), null); assert.equal(first.isPersisted(), false);
});
test("logout interleaving with setItem removes the exact recreated stale write", () => {
  const f = fixture(); const first = f.session.open("staff-billing", "new", validate)!;
  const setter = f.storage.setItem; let injected = false;
  f.storage.setItem = (key, value) => {
    if (!injected && key.includes(`:draft:${user}:`)) { injected = true; f.session.revoke(user); }
    setter(key, value);
  };
  assert.equal(first.save({ text: "late" }).status, "revoked");
  assert.equal([...f.values.keys()].some(key => key.includes(`:draft:${user}:`)), false);
});
test("malformed owner/environment/schema/date metadata is never restored", () => {
  for (const patch of [{ ownerId: other }, { project: "other" }, { environment: "preview" }, { version: 0 }, { savedAt: "never" }, { extra: "synthetic" }]) {
    const f = fixture(); const a = f.session.open("staff-billing", "new", validate)!; a.save({ text: "one" });
    const key = [...f.values.keys()].find(value => value.includes(`:draft:${user}:`))!;
    const raw = JSON.parse(f.values.get(key)!) as Record<string, unknown>; f.values.set(key, JSON.stringify({ ...raw, ...patch }));
    assert.equal(a.read(), null);
    assert.equal(f.values.has(key), false);
  }
});
test("bounded sweep advances beyond 256 unrelated keys and repairs invalid-index orphans", () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++) f.values.set(`unrelated-${index}`, "synthetic");
  f.values.set("p1:staff-billing-draft:v1:unknown:new", "synthetic");
  const lease = f.session.open("staff-billing", "new", validate)!; lease.save({ text: "synthetic" });
  const indexKey = [...f.values.keys()].find(key => key.includes(":draft-index:"))!;
  const payloadKey = [...f.values.keys()].find(key => key.includes(`:draft:${user}:`))!;
  f.values.set(indexKey, "bad-index"); f.session.revoke(user);
  const next = f.make(); next.activate(user, true); next.activate(user, true);
  assert.equal(f.values.has(payloadKey), false); assert.equal(f.values.has("p1:staff-billing-draft:v1:unknown:new"), false);
  assert.equal([...f.values.keys()].filter(key => key.startsWith("unrelated-")).length, 1000);
});
test("billing age boundary expires, quote has no new TTL", () => {
  const f = fixture(); const billing = f.session.open("staff-billing", "new", validate, 100)!;
  const quote = f.session.open("quote-calculator", "WOT100", validate)!; billing.save({ text: "one" }); quote.save({ text: "two" });
  f.tick(1100); assert.ok(billing.read()); f.tick(1101); assert.equal(billing.read(), null); assert.ok(quote.read());
});
test("bounded bytes and registry reject overflow, with no payload truncation", () => {
  const f = fixture(); const lease = f.session.open("staff-billing", "0", validate)!;
  assert.equal(lease.save({ text: "x".repeat(DRAFT_MAX_BYTES) }).status, "oversized"); assert.equal(lease.read(), null);
  for (let index = 1; index < DRAFT_MAX_RECORDS; index++) assert.ok(f.session.open("staff-billing", String(index), validate));
  assert.equal(f.session.open("staff-billing", "overflow", validate), null);
});
test("clean work-order viewing does not allocate saved-draft registry slots", () => {
  const f = fixture();
  for (let index = 0; index < 30; index++) { const lease = f.session.open("quote-calculator", `WOT${index}`, validate); assert.ok(lease); assert.equal(lease.read(), null); lease.close(); }
  assert.equal([...f.values.keys()].some(key => key.includes(":draft-index:")), false);
  assert.equal(f.session.open("quote-calculator", "WOT100", validate)?.save({ text: "synthetic" }).status, "persisted");
});
test("known legacy keys are swept but preferences/Auth/unrelated keys are preserved", () => {
  const f = fixture(); f.values.set("p1:staff-billing-draft:v1:unknown:new", "synthetic");
  f.values.set("p1:quote-calculator:v1:unknown:WOT100", "synthetic");
  f.values.set("sb-synthetic-auth-token", "synthetic"); f.values.set("rememberEmail", "synthetic");
  f.session.revoke(user); assert.equal(f.values.has("p1:staff-billing-draft:v1:unknown:new"), false);
  assert.equal(f.values.has("p1:quote-calculator:v1:unknown:WOT100"), false);
  assert.equal(f.values.has("sb-synthetic-auth-token"), true); assert.equal(f.values.has("rememberEmail"), true);
  assert.ok(f.diagnostics.every(event => Object.keys(event).sort().join() === "category,count"));
});
test("purge failure tombstone survives refresh; old payload cannot recover into new session", () => {
  const f = fixture(); const lease = f.session.open("staff-billing", "new", validate)!; lease.save({ text: "one" });
  f.failures(true); assert.equal(f.session.revoke(), false); f.failures(); const next = f.make(); next.activate(user, true);
  assert.equal(next.open("staff-billing", "new", validate)?.read(), null);
});
test("same-process reauthentication retries failed metadata and payload removal without reviving the old epoch", () => {
  const f = fixture(); const first = f.session.open("staff-billing", "new", validate)!; first.save({ text: "one" });
  f.failures(true, true); assert.equal(f.session.revoke(user), false); f.failures();
  assert.equal(f.session.activate(user, true), true); assert.equal(f.session.open("staff-billing", "new", validate)?.read(), null);
});
