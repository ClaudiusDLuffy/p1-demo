import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";
import type { ControllerExportContext } from "../server/controller-exports/controllerExportContext";
import type { ControllerExportHistoryRepository } from "../server/controller-exports/historyRepository";
import { controllerModuleHarness } from "../server/controller-exports/testing/moduleHarness";
import { mapControllerExportHistory, controllerExportHistoryCsvRows, CONTROLLER_EXPORT_CSV_HEADER } from "../server/controller-exports/historyMapper";
import { listControllerExports } from "../server/controller-exports/listControllerExports";
import { mapControllerExportHttp } from "../server/controller-exports/httpMapper";

const id = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-09-12T03:00:00.000Z";
const batch = (n = 1) => ({ id: id(n), status: "pending", created_at: at, created_by: id(700),
  confirmed_at: null, confirmed_by: null, cancelled_at: null, cancelled_by: null, cancellation_reason: null,
  invoice_count: 1, total: 31.27 });
const item = (n = 1) => ({ batch_id: id(n), invoice_id: id(1000 + n), invoice_num: `INV-${n}`,
  work_order_id: "WOT900001-2", contractor_id: id(701), total: 31.27, exported_at: at });
const profiles = [{ id: id(700), name: "Synthetic Controller", company: null },
  { id: id(701), name: "Synthetic Contractor", company: "Synthetic Mechanical" }];
type Call = { url: URL; signal: AbortSignal | null | undefined };
function harness(respond: (call: Call) => unknown, signal: AbortSignal | null = null) {
  const calls: Call[] = [];
  const client = createClient<Database>("https://controller-history.invalid", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const call = { url: new URL(String(input)), signal: init?.signal }; calls.push(call);
      assert.equal(call.url.hostname, "controller-history.invalid");
      const value = respond(call);
      return value instanceof Response ? value : Response.json(value);
    } },
  });
  const context: ControllerExportContext = { actor: { userId: id(700), profileId: id(700), role: "manager", canHandoff: true },
    requestId: "history-synthetic", signal, dataSession: client };
  const modules = controllerModuleHarness();
  const repository = modules.call("src/server/controller-exports/historyRepository.ts", "createHistoryRepository", context) as ControllerExportHistoryRepository;
  return { context, repository, calls, modules };
}
function respond(call: Call): unknown {
  if (call.url.pathname.endsWith("controller_invoice_export_batches")) return [batch()];
  if (call.url.pathname.endsWith("controller_invoice_export_items")) return [item()];
  if (call.url.pathname.endsWith("profiles")) return profiles;
  throw new Error("Unexpected synthetic query");
}
test("controller history loads one bounded page, retains internal WOT, and maps exact immutable public fields", async () => {
  const h = harness(respond);
  const facts = await h.repository.loadRecent({});
  assert.deepEqual(JSON.parse(JSON.stringify(mapControllerExportHistory(facts))), { history: [{ id: id(1), status: "pending", createdAt: at,
    createdBy: id(700), confirmedAt: null, confirmedBy: null, cancelledAt: null, cancelledBy: null,
    cancellationReason: null, invoiceCount: 1, total: 31.27, createdByName: "Synthetic Controller", confirmedByName: "", cancelledByName: "",
    items: [{ invoiceId: id(1001), invoiceNumber: "INV-1", workOrderId: "WOT900001-2", contractorId: id(701), contractorName: "Synthetic Mechanical", total: 31.27 }] }],
    actors: [{ id: id(700), name: "Synthetic Controller" }] });
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0].url.searchParams.get("limit"), "100");
  assert.equal(h.calls[0].url.searchParams.get("order"), "created_at.desc,id.desc");
  assert.ok(h.calls.every(call => !call.url.searchParams.get("select")?.includes("*")));
});
test("controller history empty page performs no item or profile lookup", async () => {
  const h = harness(() => []);
  assert.equal(JSON.stringify(mapControllerExportHistory(await h.repository.loadRecent({}))), '{"history":[],"actors":[]}');
  assert.equal(h.calls.length, 1);
});
test("controller history filters preserve exact UTC dates and actor binding", async () => {
  const h = harness(() => []);
  await h.repository.loadRecent({ from: "2026-09-10", toExclusive: "2026-09-13T00:00:00.000Z", actor: id(700) });
  assert.deepEqual(h.calls[0].url.searchParams.getAll("created_at"), ["gte.2026-09-10T00:00:00.000Z", "lt.2026-09-13T00:00:00.000Z"]);
  assert.equal(h.calls[0].url.searchParams.get("created_by"), `eq.${id(700)}`);
});
for (const [label, value] of [
  ["null", null], ["object", {}], ["unknown state", [{ ...batch(), status: "paid" }]],
  ["invalid id", [{ ...batch(), id: "broken" }]], ["string count", [{ ...batch(), invoice_count: "1" }]],
  ["negative total", [{ ...batch(), total: -1 }]], ["invalid time", [{ ...batch(), created_at: "today" }]],
  ["double resolution", [{ ...batch(), status: "confirmed", confirmed_at: at, confirmed_by: id(700), cancelled_at: at }]],
  ["duplicate batch", [batch(), batch()]],
] as const) test(`controller history rejects malformed ${label}`, async () => {
  const h = harness(() => value);
  await assert.rejects(h.repository.loadRecent({}), error => error instanceof Error && !error.message.includes("broken"));
  assert.equal(h.calls.length, 1);
});
for (const [label, rows] of [
  ["foreign batch", [{ ...item(), batch_id: id(3) }]], ["duplicate item", [item(), item()]],
  ["missing immutable item", []], ["malformed invoice id", [{ ...item(), invoice_id: "private" }]],
] as const) test(`controller history rejects ${label} without mapping guessed facts`, async () => {
  const h = harness(call => call.url.pathname.endsWith("controller_invoice_export_items") ? rows : respond(call));
  await assert.rejects(h.repository.loadRecent({}));
  assert.equal(h.calls.length, 2);
});
test("controller history cancellation forwards the request signal and stops later query families", async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return [batch()]; }, controller.signal);
  await assert.rejects(h.repository.loadRecent({}));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal, controller.signal);
});
test("controller history failure does not implicitly retry the read", async () => {
  const h = harness(() => new Response("synthetic unavailable", { status: 503 }));
  await assert.rejects(h.repository.loadRecent({}));
  assert.equal(h.calls.length, 1);
});
test("controller complete CSV pages are lazy, stable, and never truncated at the JSON history limit", async () => {
  const h = harness(call => {
    const params = call.url.searchParams;
    if (call.url.pathname.endsWith("controller_invoice_export_batches")) {
      const offset = Number(params.get("offset"));
      return Array.from({ length: offset === 0 ? 100 : offset === 100 ? 1 : 0 }, (_, i) => batch(offset + i + 1));
    }
    if (call.url.pathname.endsWith("controller_invoice_export_items")) {
      return Array.from({ length: params.get("batch_id")?.includes(id(101)) ? 1 : 100 }, (_, i) => item(params.get("batch_id")?.includes(id(101)) ? 101 : i + 1));
    }
    return profiles;
  });
  const iterator = h.repository.pages({})[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(h.calls.filter(call => call.url.pathname.endsWith("controller_invoice_export_batches")).length, 1);
  const second = await iterator.next();
  assert.equal(second.value?.batches[0].id, id(101));
  assert.equal((await iterator.next()).done, true);
  assert.ok(h.calls.filter(call => call.url.pathname.endsWith("controller_invoice_export_batches"))
    .every(call => call.url.searchParams.get("order") === "created_at.asc,id.asc"));
});
test("controller CSV preserves BOM CRLF escaping exact money and no internal-only fields", async () => {
  const h = harness(respond);
  const facts = await h.repository.loadRecent({});
  const output = CONTROLLER_EXPORT_CSV_HEADER + [...controllerExportHistoryCsvRows(facts)].join("");
  assert.ok(output.startsWith("\uFEFFBatch ID,Status,Created By,"));
  assert.equal(output.split("\r\n").length, 3);
  assert.ok(output.endsWith(`,INV-1,WOT900001-2,Synthetic Mechanical,31.27,31.27,\r\n`));
  assert.ok(!output.includes("object_path"));
});
test("controller CSV HTTP stream preserves exact content and closes its repository iterator on cancel", async () => {
  let closed = 0;
  const h = harness(respond);
  const page = await h.repository.loadRecent({});
  const history: ControllerExportHistoryRepository = { ...h.repository,
    async *pages() { try { yield page; yield page; } finally { closed++; } } };
  const result = await listControllerExports({ mode: "history", format: "csv", filter: {} }, h.context, {
    history, eligibility: { async queueSummary() { throw new Error("Not a queue read"); } },
    downloads: { async load() { throw new Error("Not a download"); } }, now: () => new Date(at),
  });
  assert.equal(result.kind, "csv");
  const response = mapControllerExportHttp(result);
  assert.equal(response.headers.get("content-type"), "text/csv;charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Contractor-Bill-Handoff-Audit-2026-09-12.csv"');
  const reader = response.body?.getReader();
  await reader?.read(); await reader?.cancel();
  assert.equal(closed, 1);
});
for (const [label, row] of [
  ["pending", { id: id(1), object_path: `2026-09-12/${id(1)}.zip`, status: "pending", created_at: at, archive_format: "reference_manifest_v2" }],
  ["legacy confirmed", { id: id(1), object_path: `2026-09-12/${id(1)}.zip`, status: "confirmed", created_at: at, archive_format: null }],
] as const) test(`controller download binding validates ${label} without rebuilding an archive`, async () => {
  const h = harness(() => [row]);
  const binding = await h.repository.loadDownload(id(1));
  assert.equal(binding?.batchId, id(1));
  assert.equal(binding?.format, row.archive_format ?? "legacy_saas_ant_v1");
  assert.equal(h.calls.length, 1);
});
for (const objectPath of ["../foreign.zip", `2026-09-12/${id(2)}.zip`, `/2026-09-12/${id(1)}.zip`, `2026-99-99/${id(1)}.zip`]) {
  test(`controller download refuses foreign or malformed binding ${objectPath}`, async () => {
    const h = harness(() => [{ id: id(1), object_path: objectPath, status: "pending", created_at: at, archive_format: "reference_manifest_v2" }]);
    await assert.rejects(h.repository.loadDownload(id(1)));
  });
}
