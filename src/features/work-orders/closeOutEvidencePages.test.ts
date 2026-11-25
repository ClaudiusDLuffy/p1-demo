import assert from "node:assert/strict";
import test from "node:test";
import { collectCloseOutEvidencePages } from "./closeOutEvidencePages";

const signal = () => new AbortController().signal;
test("explicit close-out preflight loads every scoped page, not just the first continuation", async () => {
  const cursors: (string | null)[] = [];
  const result = await collectCloseOutEvidencePages(async cursor => {
    cursors.push(cursor); const index = cursor === null ? 0 : Number(cursor);
    return { items: [{ id: String(index) }], hasMore: index < 3, nextCursor: index < 3 ? String(index + 1) : null };
  }, signal());
  assert.deepEqual(cursors, [null, "1", "2", "3"]);
  assert.deepEqual(result.map(row => row.id), ["0", "1", "2", "3"]);
});
test("empty complete history is valid", async () => {
  assert.deepEqual(await collectCloseOutEvidencePages(async () => ({ items: [], hasMore: false, nextCursor: null }), signal()), []);
});
test("invalid completion metadata cannot masquerade as a checked empty history", async () => {
  await assert.rejects(collectCloseOutEvidencePages(async () => ({ items: [], hasMore: undefined as unknown as boolean, nextCursor: null }), signal()), /could not be checked/);
});
for (const kind of ["missing cursor", "empty continuation", "repeated cursor", "duplicate row", "trailing cursor"] as const) {
  test(`${kind} cannot produce a complete-history result`, async () => {
    let calls = 0;
    await assert.rejects(collectCloseOutEvidencePages(async () => {
      calls++;
      return { items: kind === "empty continuation" ? [] : [{ id: kind === "duplicate row" ? "same" : String(calls) }],
        hasMore: kind !== "trailing cursor", nextCursor: kind === "missing cursor" ? null : "next" };
    }, signal()), /History changed|could not be checked/);
  });
}
test("a later failed page never returns the earlier partial rows", async () => {
  await assert.rejects(collectCloseOutEvidencePages(async cursor => {
    if (cursor) throw new Error("Synthetic unavailable page");
    return { items: [{ id: "first" }], hasMore: true, nextCursor: "next" };
  }, signal()), /Synthetic unavailable/);
});
test("aborting before or during a page stops without returning checked evidence", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(collectCloseOutEvidencePages(async () => { calls++; return { items: [], hasMore: false, nextCursor: null }; }, controller.signal));
  assert.equal(calls, 0);
  const pending = new AbortController();
  await assert.rejects(collectCloseOutEvidencePages(async () => {
    pending.abort(); return { items: [{ id: "late" }], hasMore: false, nextCursor: null };
  }, pending.signal));
});
test("the safety limit fails visibly instead of silently truncating a large history", async () => {
  let calls = 0;
  await assert.rejects(collectCloseOutEvidencePages(async () => {
    calls++; return { items: [{ id: String(calls) }], hasMore: true, nextCursor: String(calls) };
  }, signal()), /further review/);
  assert.equal(calls, 100);
});
