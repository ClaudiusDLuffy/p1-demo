import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { MAX_PENDING_REALTIME_EVENTS, REALTIME_BATCH_MS } from "./realtimeBatcher";
import { MAX_INVALIDATION_TARGETS } from "./realtimeInvalidationPlan";
const source = (file: string) => readFileSync(file, "utf8");
function files(path: string): string[] { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(join(path, entry.name)) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [join(path, entry.name)] : []); }
test("production graph has one channel owner and no frozen characterization or raw-event router import", () => {
  const channelOwners: string[] = [];
  for (const path of files("src")) {
    if (/\.test\.[jt]sx?$|TestHarness|TestSupport|legacyRealtime(?:Fixture|Measurement)|realtimeTestSupport/.test(path)) continue;
    const text = source(path);
    if (/\.channel\(["']portal-changes["']\)/.test(text)) channelOwners.push(relative(process.cwd(), path));
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      assert.doesNotMatch(statement.moduleSpecifier.text, /legacyRealtime|realtimeTestSupport/, path);
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const names = bindings.elements.map(element => element.propertyName?.text ?? element.name.text);
      assert.ok(!names.includes("datasetsForRealtimeTables"), `Deprecated broad router imported by ${path}`);
      assert.ok(!names.includes("subscribeToChanges"), `Compatibility subscription imported by ${path}`);
    }
  }
  assert.deepEqual(channelOwners, ["src/lib/realtime/realtimeSubscription.ts"]);
});
test("session and invalidation modules prohibit unscoped/all-cache refetch and raw payload logging", () => {
  const shell = source("src/components/PortalShell.tsx");
  assert.doesNotMatch(shell, /invalidateQueries\(\{\s*refetchType:\s*["']active["']\s*\}\)/);
  assert.match(shell, /usePortalRealtime\(currentUser, refreshCurrentProfile\)/);
  assert.match(shell, /currentUser\.active === true/);
  for (const file of ["realtimeSession", "realtimeBatcher", "realtimeSubscription", "usePortalRealtime"]) {
    const text = source(`src/lib/realtime/${file}.ts`);
    assert.doesNotMatch(text, /refetchQueries\s*\(|\.clear\(\)\s*;\s*\/\/.*cache|console\.(?:log|error|warn)|setQueryData\(/);
    assert.doesNotMatch(text, /invalidateQueries\(\s*\)/);
  }
  assert.match(source("src/lib/realtime/realtimeBatcher.ts"), /cancelRefetch:\s*false/);
  assert.match(source("src/lib/queryClient.ts"), /refetchOnWindowFocus:\s*false/);
  assert.match(source("src/lib/queryClient.ts"), /refetchOnReconnect:\s*false/);
  assert.equal(REALTIME_BATCH_MS, 250); assert.equal(MAX_PENDING_REALTIME_EVENTS, 128); assert.equal(MAX_INVALIDATION_TARGETS, 256);
});
