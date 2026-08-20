import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkArray,
  clampPageSize,
  firstCursorPosition,
  mapChunksWithConcurrency,
  nextCursorPosition,
  previousCursorPosition,
} from "./cursorPagination";

test("clampPageSize keeps interactive pages within safe bounds", () => {
  assert.equal(clampPageSize(undefined), 25);
  assert.equal(clampPageSize(0), 1);
  assert.equal(clampPageSize(30.9), 30);
  assert.equal(clampPageSize(5_000), 100);
});

test("cursor navigation retains an opaque back stack", () => {
  const first = firstCursorPosition();
  const second = nextCursorPosition(first, "cursor-2");
  const third = nextCursorPosition(second, "cursor-3");

  assert.deepEqual(third, {
    page: 3,
    cursor: "cursor-3",
    previousCursors: [null, "cursor-2"],
  });
  assert.deepEqual(previousCursorPosition(third), second);
  assert.deepEqual(previousCursorPosition(second), first);
});

test("bulk rows are chunked without dropping or reordering records", () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("bounded workers preserve result ordering", async () => {
  const result = await mapChunksWithConcurrency(
    [30, 5, 10],
    async (delay, index) => {
      await new Promise(resolve => setTimeout(resolve, delay));
      return index;
    },
    2,
  );
  assert.deepEqual(result, [0, 1, 2]);
});
