import assert from "node:assert/strict";
import test from "node:test";
import { retryWorkOrderRead } from "../features/work-orders/workOrderQueryPolicy";
import { AppError } from "./errors/AppError";

const tableRead = { contractorFilter: "synthetic company", tableSortColumn: "contractor" } as const;

test("table-mode statement timeout is not automatically retried", () => {
  assert.equal(retryWorkOrderRead(tableRead, 0, { code: "57014", message: "private database detail" }), false);
  assert.equal(retryWorkOrderRead({ scope: "dashboard_p1_parts_to_order" }, 0, new AppError("TIMEOUT")), false);
});

test("ordinary work-order reads retain the shared safe-read retry policy", () => {
  assert.equal(retryWorkOrderRead({}, 0, new AppError("TIMEOUT")), true);
  assert.equal(retryWorkOrderRead({}, 2, new AppError("TIMEOUT")), false);
  assert.equal(retryWorkOrderRead({}, 0, new AppError("VALIDATION_FAILED")), false);
});

test("table mode retains retries for transient transport failures", () => {
  assert.equal(retryWorkOrderRead(tableRead, 0, new AppError("NETWORK_UNAVAILABLE")), true);
  assert.equal(retryWorkOrderRead(tableRead, 2, new AppError("NETWORK_UNAVAILABLE")), false);
});
