import assert from "node:assert/strict";
import test from "node:test";
import { billingWorkOrderOptions } from "./billingWorkOrderOptions";

const workOrders = Array.from({ length: 100 }, (_, index) => ({
  id: `WOT${String(index + 1).padStart(4, "0")}`,
  store: String(10000 + index),
  city: index === 94 ? "Odessa" : "Dallas",
  summary: index === 94 ? "Selected older work order" : "Service call",
}));

test("keeps an older selected work order in the bounded selector", () => {
  const options = billingWorkOrderOptions(workOrders, "", "WOT0095", 80);

  assert.equal(options.length, 80);
  assert.equal(options[0].id, "WOT0095");
  assert.equal(options.filter(item => item.id === "WOT0095").length, 1);
});

test("searches all work orders before applying the display limit", () => {
  const options = billingWorkOrderOptions(workOrders, "odessa", null, 8);

  assert.deepEqual(options.map(item => item.id), ["WOT0095"]);
});

test("does not duplicate a selected work order already inside the limit", () => {
  const options = billingWorkOrderOptions(workOrders, "", "WOT0002", 80);

  assert.equal(options.length, 80);
  assert.equal(options.filter(item => item.id === "WOT0002").length, 1);
});
