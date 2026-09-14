import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { AppError } from "../../lib/errors/AppError";
import { directoryItemValue, directoryLabelIds, directoryScopeKey, normalizeDirectorySearch,
  parseDirectoryItem, parseDirectoryPage } from "./contracts";
import type * as DirectoryApi from "./api";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n = 1) => ({ id: id(n), name: "Synthetic person" });
const assignable = (n = 1) => ({ ...item(n), company: null, territory: null });
const label = (n = 1) => ({ ...item(n), company: null, initials: null, color: null });
const technician = (n = 9) => ({ ...item(n), contractorId: id(5), profileId: id(7), isActive: true, profileActive: true, contractorAccessLevel: "invoice" });
const page = (items = [item()]) => ({ items, pageSize: 25, hasMore: false, nextCursor: null });
const requireHere = createRequire(import.meta.url);
const apiFile = resolve("src/features/directory/api.ts");
const apiCode = ts.transpileModule(readFileSync(apiFile, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function apiHarness(result: { data: unknown; error: unknown }, gate?: Promise<void>) {
  const calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const exports = {} as typeof DirectoryApi;
  runInNewContext(apiCode, { exports, AbortSignal, Promise, Set,
    require: (name: string) => name.endsWith("/supabase/client") ? { supabase: () => ({
      rpc: (name: string, args: Record<string, unknown>) => {
        const call: typeof calls[number] = { name, args }; calls.push(call);
        const request = { abortSignal(signal: AbortSignal) { call.signal = signal; return request; },
          then: async (done: (value: unknown) => unknown) => { await gate; return done(result); } };
        return request;
      },
    }) } : requireHere(resolve(apiFile, "..", name)),
  }, { filename: apiFile });
  return { api: exports, calls };
}

test("directory search normalizes case/ordinary whitespace and rejects controls and oversize input", () => {
  assert.equal(normalizeDirectorySearch("  SYNTHETIC   Company\u00a0North  "), "synthetic company north");
  for (const control of ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f"]) {
    assert.throws(() => normalizeDirectorySearch(`A${control}B`), { code: "INVALID_REQUEST" });
  }
  assert.equal(normalizeDirectorySearch("a".repeat(200)).length, 200);
  assert.throws(() => normalizeDirectorySearch("a".repeat(201)), { code: "INVALID_REQUEST" });
});
test("actor scope keys separate role, company, grants, active state and team authority", () => {
  const actor = { id: id(1), role: "contractor", active: true };
  for (const change of [{ id: id(2) }, { role: "manager" }, { active: false }, { contractorAccountId: id(3) },
    { contractorOrganizationId: id(4) }, { contractorAccessLevel: "admin" }, { contractorTier: "direct" },
    { canManageTeam: true }, { staffPermissions: ["invoice_controller"] }]) {
    assert.notDeepEqual(directoryScopeKey(actor), directoryScopeKey({ ...actor, ...change }));
  }
  assert.deepEqual(directoryScopeKey({ staffPermissions: ["b", "a"] }), directoryScopeKey({ staffPermissions: ["a", "b"] }));
});
test("visible labels are exact UUIDs, deduplicated, bounded and never name-derived", () => {
  assert.deepEqual(directoryLabelIds([id(2), "Synthetic name", id(1), id(1), null]), [id(1), id(2)]);
  assert.equal(directoryLabelIds(Array.from({ length: 100 }, (_, n) => id(n))).length, 100);
  assert.throws(() => directoryLabelIds(Array.from({ length: 101 }, (_, n) => id(n))), { code: "INVALID_REQUEST" });
  assert.equal(directoryItemValue({ ...item(), profileId: id(7) }, true), id(7));
  assert.equal(directoryItemValue({ ...item(), profileId: null }, true), `legacy:${id(1)}`);
});
test("minimal domains reject full-profile, grant, contact and membership leakage", () => {
  for (const domain of ["staff_choices", "contractor_filter", "legacy_team", "assignable_contractors", "contacts", "profile_labels"] as const) {
    for (const key of ["email", "phone", "staffPermissions", "role", "active", "contractorOrganizationId", "grants"]) {
      assert.throws(() => parseDirectoryItem(domain, { ...item(), [key]: "private" }), { code: "INTERNAL_ERROR" });
    }
  }
  assert.equal(parseDirectoryItem("contact_detail", { ...label(), title: null, email: "synthetic@example.invalid", phone: null }).email, "synthetic@example.invalid");
});
test("directory parser bounds strings, arrays, counts and technician identity fields", () => {
  assert.throws(() => parseDirectoryItem("contacts", { ...item(), name: "x".repeat(501) }), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("contacts", { ...item(), company: "x".repeat(501) }), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("contractor_directory", { ...item(), trades: Array(51).fill("x") }), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("contractor_directory", { ...item(), trades: ["x".repeat(201)] }), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("contractor_directory", { ...item(), activeCount: -1 }), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("company_technicians", { ...item(), isActive: null }), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("company_technicians", { ...item(), profileId: "Synthetic name" }), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("company_technicians", { ...item(), contractorId: null }), { code: "INTERNAL_ERROR" });
  assert.equal(parseDirectoryItem("company_technicians", { ...technician(), profileActive: null }).profileActive, null);
  for (const key of ["contractorId", "profileId", "isActive", "profileActive", "contractorAccessLevel"]) {
    const invalid: Record<string, unknown> = technician(); delete invalid[key];
    assert.throws(() => parseDirectoryItem("company_technicians", invalid), { code: "INTERNAL_ERROR" });
  }
  assert.throws(() => parseDirectoryItem("contractor_directory", { ...label(), territory: null, trades: [] }), { code: "INTERNAL_ERROR" });
});
test("exact editable names retain original text under a separate documented256KiB body bound", () => {
  const longName = "Synthetic original ".repeat(100);
  const row = { ...technician(), name: longName, email: null, phone: null };
  assert.equal(parseDirectoryItem("technician_detail", row, true).name, longName);
  assert.throws(() => parseDirectoryItem("technician_detail", row), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("technician_detail", { ...row, name: "x".repeat(65_537) }, true), { code: "INTERNAL_ERROR" });
  assert.throws(() => parseDirectoryItem("contact_detail", { ...label(), title: "x".repeat(65_536), name: "x".repeat(65_536),
    company: "x".repeat(65_536), email: "x".repeat(65_536), phone: "x".repeat(65_536) }, true), { code: "INTERNAL_ERROR" });
});
test("pages permit at most50 records and require explicit valid continuation", () => {
  assert.equal(parseDirectoryPage("staff_choices", page()).items.length, 1);
  assert.equal(parseDirectoryPage("staff_choices", { ...page(Array.from({ length: 50 }, (_, n) => item(n))), pageSize: 50 }).items.length, 50);
  for (const bad of [{ ...page(), pageSize: 51 }, { ...page(), pageSize: 0 }, { ...page(Array.from({ length: 26 }, (_, n) => item(n))) },
    { ...page(), hasMore: true }, { ...page([]), hasMore: true, nextCursor: "cursor" },
    { ...page(), nextCursor: "cursor" }, { ...page(), hasMore: true, nextCursor: "x".repeat(8193) },
    { ...page(), hasMore: true, nextCursor: "bad cursor" }, { ...page(), grants: [] }, page([item(), item()])]) {
    assert.throws(() => parseDirectoryPage("staff_choices", bad), { code: "INTERNAL_ERROR" });
  }
});
test("page API sends only one bounded RPC and consumes the caller AbortSignal", async () => {
  const h = apiHarness({ data: page(), error: null }); const controller = new AbortController();
  await h.api.loadDirectoryPage("staff_choices", "  SYNTHETIC  ", null, null, controller.signal);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, "list_directory_page_v1");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args)), { p_domain: "staff_choices", p_query: "synthetic", p_contractor_id: null, p_limit: 25, p_cursor: null });
  assert.equal(h.calls[0].signal, controller.signal);
});
test("aborted directory requests cannot deliver late pages or selected records", async () => {
  let finish!: () => void; const gate = new Promise<void>(done => { finish = done; });
  const h = apiHarness({ data: page(), error: null }, gate); const controller = new AbortController();
  const pending = h.api.loadDirectoryPage("staff_choices", "", null, null, controller.signal);
  controller.abort(); finish();
  await assert.rejects(pending, { name: "AbortError" });
  const before = h.calls.length;
  await assert.rejects(h.api.loadDirectorySelection("staff_choices", id(1), null, controller.signal), { name: "AbortError" });
  assert.equal(h.calls.length, before);
});
test("exact selection is independent of page contents and validates row versus profile UUID", async () => {
  const h = apiHarness({ data: assignable(999), error: null });
  assert.equal((await h.api.loadDirectorySelection("assignable_contractors", id(999)))?.id, id(999));
  assert.equal(h.calls[0].name, "get_directory_selection_v1");
  assert.equal(await h.api.loadDirectorySelection("assignable_contractors", "Synthetic person"), null);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.api.loadDirectorySelection("assignable_contractors", id(998)), { code: "INTERNAL_ERROR" });
  const tech = apiHarness({ data: technician(), error: null });
  assert.equal((await tech.api.loadDirectorySelection("technician_profile", id(7), id(5)))?.id, id(9));
  await assert.rejects(tech.api.loadDirectorySelection("company_technicians", id(7), id(5)), { code: "INTERNAL_ERROR" });
  await assert.rejects(tech.api.loadDirectorySelection("technician_profile", id(7), id(6)), { code: "INTERNAL_ERROR" });
});
test("visible label API rejects unrequested IDs and duplicates without collecting pages", async () => {
  const h = apiHarness({ data: [label(1), label(2)], error: null });
  assert.equal((await h.api.loadDirectoryLabels([id(2), id(1), id(1)])).length, 2);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, "get_directory_profile_labels_v1");
  await assert.rejects(h.api.loadDirectoryLabels([id(1), id(3)]), { code: "INTERNAL_ERROR" });
  const duplicates = apiHarness({ data: [label(), label()], error: null });
  await assert.rejects(duplicates.api.loadDirectoryLabels([id(1), id(2)]), { code: "INTERNAL_ERROR" });
  await h.api.loadDirectoryLabels([]); assert.equal(h.calls.length, 2);
});
test("directory error handling uses fixed codes and safe-read retry metadata", async () => {
  for (const [code, expected] of [["PDC01", "INVALID_CURSOR"], ["42501", "FORBIDDEN"], ["57014", "TIMEOUT"]]) {
    const h = apiHarness({ data: null, error: { code, message: "private diagnostic" } });
    await assert.rejects(h.api.loadDirectoryPage("contacts"), (error: unknown) => error instanceof AppError && error.code === expected && !error.message.includes("private"));
  }
  const h = apiHarness({ data: null, error: { code: "XX000", message: "private invalid cursor text" } });
  await assert.rejects(h.api.loadDirectoryPage("contacts"), { code: "INTERNAL_ERROR" });
});
test("auto assignment requests one server candidate without any directory collector", async () => {
  const h = apiHarness({ data: assignable(7), error: null });
  assert.equal((await h.api.loadAutoAssignmentCandidate("Synthetic City", ["HVAC"]))?.id, id(7));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, "get_directory_auto_assignment_candidate_v1");
});
test("all former live bootstrap loaders and all-user props are removed", () => {
  for (const path of ["src/components/PortalShell.tsx", "src/features/work-orders/queries.ts", "src/lib/db.ts"]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /loadAllProfiles|loadProfiles|loadStaffPermissionGrants|loadContractorTechnicians|loadTechnicians|useProfilesQuery|useTechniciansQuery/);
  }
  const shell = readFileSync("src/components/PortalShell.tsx", "utf8");
  assert.doesNotMatch(shell, /USERS|profilesData|techniciansData|staffProfiles=|contractorsOnly=/);
  assert.match(shell, /DirectoryScopeProvider key=\{JSON.stringify\(directoryScopeKey\(currentUser\)\)\}/);
});
