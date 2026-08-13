import assert from "node:assert/strict";
import test from "node:test";
import { collectSupabasePages } from "./paginatedQuery";

test("collects records beyond the PostgREST maximum response size", async () => {
  const source = Array.from({ length: 2005 }, (_, index) => ({ id: index }));
  const ranges: Array<[number, number]> = [];

  const rows = await collectSupabasePages(async (from, to) => {
    ranges.push([from, to]);
    return { data: source.slice(from, to + 1), error: null };
  });

  assert.equal(rows.length, source.length);
  assert.deepEqual(rows.at(-1), { id: 2004 });
  assert.deepEqual(ranges, [
    [0, 999],
    [1000, 1999],
    [2000, 2999],
  ]);
});

test("propagates a page error instead of returning an incomplete timeline", async () => {
  const expected = new Error("activity page failed");

  await assert.rejects(
    collectSupabasePages(async from => ({
      data: from === 0 ? Array.from({ length: 1000 }, () => null) : null,
      error: from === 0 ? null : expected,
    })),
    expected,
  );
});

