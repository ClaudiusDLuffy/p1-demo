import assert from "node:assert/strict";
import test from "node:test";
import { scrollWithinContainer, type ScrollContainerLike, type ScrollTargetLike } from "./scrollWithinContainer";

const target = (top: number, bottom: number): ScrollTargetLike => ({
  getBoundingClientRect: () => ({ top, bottom }) as DOMRect,
});
const container = (scrollTop = 100): ScrollContainerLike => ({
  clientHeight: 200,
  clientTop: 2,
  scrollHeight: 1_000,
  scrollTop,
  getBoundingClientRect: () => ({ top: 50 }) as DOMRect,
});

test("visible selection does not move its owning dropdown", () => {
  const list = container();
  scrollWithinContainer(list, target(80, 180));
  assert.equal(list.scrollTop, 100);
});

test("selection above or below moves only the supplied dropdown by the nearest amount", () => {
  const above = container();
  scrollWithinContainer(above, target(32, 70));
  assert.equal(above.scrollTop, 80);

  const below = container();
  scrollWithinContainer(below, target(240, 290));
  assert.equal(below.scrollTop, 138);
});

test("dropdown scrolling remains bounded and tolerates unavailable layout", () => {
  const top = container(5);
  scrollWithinContainer(top, target(-500, -450));
  assert.equal(top.scrollTop, 0);

  const bottom = container(790);
  scrollWithinContainer(bottom, target(500, 700));
  assert.equal(bottom.scrollTop, 800);

  scrollWithinContainer(null, null);
});
