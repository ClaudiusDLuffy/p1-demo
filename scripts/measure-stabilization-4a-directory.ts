import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read-only synthetic replay. No application environment, credentials, browser,
// database or network is used. The snapshot is supplied by the local operator.
async function main() {
const snapshot = process.env.P1_4A_SNAPSHOT;
assert.ok(snapshot, "P1_4A_SNAPSHOT must identify the verified pre-4A snapshot");
const manifestText = readFileSync(resolve(snapshot, "SHA256SUMS.json"), "utf8");
assert.equal(createHash("sha256").update(manifestText).digest("hex"), "83dbfe4b4b48ade412cb7d6586d2b8ce3ed8e085b65ab6abe321bb56d7d28689");
const filename = resolve(snapshot, "source/src/lib/db.ts");
const entry = (JSON.parse(manifestText) as { path: string; sha256: string }[]).find(item => item.path === "source/src/lib/db.ts");
assert.ok(entry);
assert.equal(createHash("sha256").update(readFileSync(filename)).digest("hex"), entry.sha256);
const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
const selected = source.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && ["loadAllProfiles", "loadTechnicians"].includes(statement.name?.text || "")
  || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "mapProfile"));
assert.equal(selected.length, 3);
const sourceText = selected.map(statement => statement.getText(source)).join("\n");
const compiled = ts.transpileModule(sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixtureCount = 2500, syntheticPostgrestCap = 1000;
const profiles = Array.from({ length: fixtureCount }, (_, n) => ({ id: uuid(n + 1), name: `Synthetic contractor ${String(n).padStart(4, "0")}`,
  initials: "SC", email: `synthetic-${n}@example.invalid`, role: "contractor", active: true, title: "Synthetic title", company: `Synthetic company ${n}`,
  phone: "+10000000000", territory: "Synthetic territory", trades: ["HVAC", "Electrical"], color: "#123456", contractor_tier: "direct",
  dispatcher_id: null, contractor_organization_id: null, contractor_access_level: null, is_assignable: true }));
const grants = profiles.map(profile => ({ profile_id: profile.id, permission: "synthetic_permission" }));
const technicians = profiles.map((profile, n) => ({ id: uuid(n + 10000), contractor_id: profile.id, profile_id: null, name: `Synthetic technician ${n}`,
  tier: "direct", is_active: true, portal_profile: null }));
const datasets: Record<string, unknown[]> = { profiles, staff_permission_grants: grants, contractor_technicians: technicians };
const requests: { table: string; projection: string; rows: number; jsonBodyBytes: number }[] = [];
const ports = { from: (table: string) => ({ select: (projection: string) => {
  const rows = datasets[table].slice(0, syntheticPostgrestCap);
  const request = { order: () => request, then: (done: (result: unknown) => unknown) => {
    requests.push({ table, projection, rows: rows.length, jsonBodyBytes: Buffer.byteLength(JSON.stringify(rows)) });
    return Promise.resolve(done({ data: rows, error: null }));
  } };
  return request;
} }) };
const exports: { loadAllProfiles?: () => Promise<unknown[]>; loadTechnicians?: () => Promise<unknown[]> } = {};
runInNewContext(compiled, { exports, supabase: () => ports, normalizeUnknownError: () => new Error("Synthetic failure"), Map, Promise });
assert.ok(exports.loadAllProfiles && exports.loadTechnicians);
const [loadedProfiles, loadedTechnicians] = await Promise.all([exports.loadAllProfiles(), exports.loadTechnicians()]);
const currentShell = readFileSync("src/components/PortalShell.tsx", "utf8");
assert.doesNotMatch(currentShell, /useProfilesQuery|useTechniciansQuery|USERS|techniciansData/);
assert.match(currentShell, /useDirectoryLabels\([\s\S]*isAuthenticated && Boolean\(selectedWO\)/);
const displayPage = { items: profiles.slice(0, 25).map(profile => ({ id: profile.id, name: profile.name, company: profile.company, territory: profile.territory })),
  pageSize: 25, hasMore: true, nextCursor: "synthetic_opaque_cursor" };
console.log(JSON.stringify({ measurement: "synthetic source/loader replay; not browser or production", fixtureCountPerTable: fixtureCount, syntheticPostgrestCap,
  before: { requests, requestCount: requests.length, transferredRows: requests.reduce((sum, request) => sum + request.rows, 0),
    jsonBodyBytes: requests.reduce((sum, request) => sum + request.jsonBodyBytes, 0), retainedProfileRows: loadedProfiles.length, retainedTechnicianRows: loadedTechnicians.length,
    unreachableWithoutError: fixtureCount - loadedProfiles.length },
  afterInitialClosedDirectory: { requestCount: 0, transferredDirectoryRows: 0, directoryResponseBodyBytes: 0,
    evidence: "Shell source guard plus actual-hook QueryObserver initial-role test; self authentication remains separately exact-scoped" },
  afterOpeningOneAssignablePickerFixture: { requestCount: 1, transferredDirectoryRows: 25, jsonBodyBytes: Buffer.byteLength(JSON.stringify(displayPage)),
    note: "Representative serialized DTO fixture, not observed network transport or compressed bytes" },
  unavailableMeasurements: ["browser first-usable time", "browser memory", "production network latency", "production returned-row totals"],
}, null, 2));
}
void main().catch(() => { console.error("Synthetic directory measurement failed"); process.exitCode = 1; });
