import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildDashboardWorkBuckets,
  dashboardWorkMatchesSearch,
} from "./workBuckets";

const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);
const dashboardWorkBucketsSource = readFileSync(
  resolve(process.cwd(), "src/features/dashboard/DashboardWorkBuckets.tsx"),
  "utf8",
);

test("dashboard operational queues start collapsed and expand only by user action", () => {
  assert.match(
    dashboardWorkBucketsSource,
    /useState<Partial<Record<DashboardBucketId, boolean>>>\(\{\}\)/,
  );
  assert.match(
    dashboardWorkBucketsSource,
    /const isExpanded = expanded\[bucket\.id\] === true/,
  );
});

test("dashboard buckets expose each operational queue without merging their meanings", () => {
  const buckets = buildDashboardWorkBuckets({
    workOrders: [
      { id: "WO-PENDING", status: "pending_invoice", priority: "p3" },
      { id: "WO-REVIEW", status: "assigned", priority: "p1" },
      { id: "WO-PARTS", status: "parts", hasPendingSevenElevenSync: true },
      { id: "WO-UNREAD-ONLY", status: "assigned", hasUnreadNotes: true },
      { id: "WO-UNASSIGNED", status: "unassigned" },
      { id: "WO-P1-PART", status: "assigned" },
      { id: "WO-CAPITAL", status: "pending_capital_completion" },
      { id: "WO-CLOSED", status: "closed", hasPendingSevenElevenSync: true },
    ],
    invoices: [
      { wot: "WO-REVIEW", state: "revised", invoiceType: "contractor" },
    ],
    parts: [
      {
        workOrderId: "WO-P1-PART",
        orderingResponsibility: "p1",
        p1OrderStatus: "requested",
      },
    ],
  });
  const byId = new Map(buckets.map(bucket => [bucket.id, bucket.workOrders]));

  assert.equal(buckets[0]?.id, "unassigned");
  assert.deepEqual(ids(byId.get("pending_submission") || []), ["WO-PENDING"]);
  assert.deepEqual(ids(byId.get("pending_approval") || []), ["WO-REVIEW"]);
  assert.deepEqual(ids(byId.get("awaiting_parts") || []), ["WO-PARTS"]);
  assert.deepEqual(ids(byId.get("seven_eleven_updates") || []), ["WO-PARTS"]);
  assert.deepEqual(ids(byId.get("unassigned") || []), ["WO-UNASSIGNED"]);
  assert.deepEqual(ids(byId.get("p1_parts_to_order") || []), ["WO-P1-PART"]);
  assert.deepEqual(ids(byId.get("pending_capital_completion") || []), ["WO-CAPITAL"]);

  assert.ok(!ids(byId.get("seven_eleven_updates") || []).includes("WO-UNREAD-ONLY"));
  assert.ok(!buckets.some(bucket => ids(bucket.workOrders).includes("WO-CLOSED")));
});

test("dashboard queue search includes identifiers, store, descriptions, and status", () => {
  const workOrder = {
    id: "WOT123",
    store: "38527",
    summary: "Ice cream freezer",
    description: "Product is melting",
    functionalStatus: "Awaiting Parts",
  };

  assert.equal(dashboardWorkMatchesSearch(workOrder, "38527"), true);
  assert.equal(dashboardWorkMatchesSearch(workOrder, "awaiting"), true);
  assert.equal(dashboardWorkMatchesSearch(workOrder, "slurpee"), false);
});
