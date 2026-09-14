import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

// This is a batch-specific ratchet against the independently verified pre-3D
// snapshot, not a replacement for the repository's ordinary TypeScript check.
const expectedChecksums = "0d5ef26815c04a8929bc1743f2c46eb0bf2d1db1f7d219eeb8140d9b68b0e567";
const repository = process.cwd();
const snapshotSetting = process.env.P1_3D_SNAPSHOT;
if (!snapshotSetting) throw new Error("P1_3D_SNAPSHOT must identify the verified pre-3D recovery snapshot");
const snapshot = resolve(snapshotSetting);
const digest = value => createHash("sha256").update(value).digest("hex");
const read = path => readFileSync(path, "utf8");
const git = args => execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const safePath = path => {
  assert.equal(typeof path, "string");
  assert.ok(path && !isAbsolute(path) && !path.split("/").includes(".."), "Unsafe snapshot path");
  return path;
};

const checksumsText = read(resolve(snapshot, "SHA256SUMS.json"));
assert.equal(digest(checksumsText), expectedChecksums, "Pre-3D checksum manifest does not match the verified receipt");
const checksums = JSON.parse(checksumsText);
assert.ok(Array.isArray(checksums));
for (const item of checksums) {
  assert.equal(digest(readFileSync(resolve(snapshot, safePath(item.path)))), item.sha256, `Snapshot checksum mismatch: ${item.path}`);
}
const context = JSON.parse(read(resolve(snapshot, "context.json")));
assert.match(context.head, /^[a-f0-9]{40}$/);
assert.equal(context.branch, "fix/stabilize-app");
const manifest = JSON.parse(read(resolve(snapshot, "path-manifest.json")));
assert.ok(Array.isArray(manifest));
const starting = new Map(manifest.map(item => [safePath(item.path), item]));
assert.equal(starting.size, manifest.length, "Snapshot contains duplicate source identities");
const tracked = new Set(git(["ls-tree", "-r", "--name-only", "-z", context.head]).split("\0").filter(Boolean));
const changed = new Set([
  ...git(["diff", "--name-only", "-z", context.head]).split("\0"),
  ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
].filter(Boolean));
const roots = [...changed].filter(path => {
  if (!/\.tsx?$/.test(path)) return false;
  assert.ok(existsSync(path), `Changed TypeScript source was removed: ${path}`);
  return digest(readFileSync(path)) !== starting.get(path)?.sha256;
}).sort();
assert.ok(roots.length, "No Phase 3D roots were discovered");
const legacyRoots = roots.filter(path => starting.has(path) || tracked.has(path));
const newRoots = roots.filter(path => !legacyRoots.includes(path));
const rootSet = new Set(roots.map(path => resolve(path)));
const legacySet = new Set(legacyRoots.map(path => resolve(path)));

/** Reconstruct excluded tracked text IN MEMORY; never write or log old content. */
function applyZeroContextPatch(original, patch, path) {
  const section = patch.split(`diff --git a/${path} b/${path}\n`)[1]?.split("\ndiff --git ")[0];
  assert.ok(section, `Excluded source is missing from tracked patch: ${path}`);
  const input = original.split("\n");
  const output = [];
  let consumed = 0;
  let cursor = 0;
  const lines = section.split("\n");
  while (cursor < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[cursor++]);
    if (!header) continue;
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    const index = Number(header[1]) - (oldCount === 0 ? 0 : 1);
    assert.ok(index >= consumed, "Tracked patch has unordered hunks");
    output.push(...input.slice(consumed, index));
    consumed = index;
    let removed = 0;
    let added = 0;
    while (removed < oldCount || added < newCount) {
      const line = lines[cursor++];
      assert.equal(typeof line, "string", "Truncated tracked patch");
      if (line.startsWith("-")) {
        assert.ok(input[consumed++] === line.slice(1), "Tracked patch source mismatch");
        removed++;
      } else if (line.startsWith("+")) {
        output.push(line.slice(1));
        added++;
      } else if (line.startsWith(" ")) {
        assert.ok(input[consumed] === line.slice(1), "Tracked patch context mismatch");
        output.push(input[consumed++]);
        removed++;
        added++;
      } else throw new Error("Unsupported tracked patch encoding");
    }
    assert.equal(removed, oldCount);
    assert.equal(added, newCount);
  }
  output.push(...input.slice(consumed));
  return output.join("\n");
}
assert.equal(applyZeroContextPatch("one\ntwo\n", "diff --git a/example b/example\n@@ -1,0 +2 @@\n+inserted\n@@ -2 +3 @@\n-two\n+changed\n", "example"), "one\ninserted\nchanged\n");

const patch = read(resolve(snapshot, "tracked-changes.patch"));
const baselineCache = new Map();
let restoredSourceFiles = 0;
let reconstructedExcludedFiles = 0;
function baselineSource(path) {
  if (baselineCache.has(path)) return baselineCache.get(path);
  const entry = starting.get(path);
  let source;
  if (entry) {
    source = entry.copy === "tracked-zero-context-patch-only"
      ? applyZeroContextPatch(git(["show", `${context.head}:${path}`]), patch, path)
      : read(resolve(snapshot, safePath(entry.copy)));
    assert.equal(digest(source), entry.sha256, `Reconstructed pre-3D source hash mismatch: ${path}`);
    if (entry.copy === "tracked-zero-context-patch-only") reconstructedExcludedFiles++;
    restoredSourceFiles++;
  } else if (tracked.has(path)) {
    source = git(["show", `${context.head}:${path}`]);
    restoredSourceFiles++;
  }
  baselineCache.set(path, source);
  return source;
}

assert.equal(digest(read("tsconfig.json")), digest(baselineSource("tsconfig.json")), "Repository compiler configuration changed after the verified baseline");
for (const path of ["package.json", "package-lock.json"]) {
  assert.equal(digest(read(path)), digest(baselineSource(path)), "Dependency configuration changed after the verified baseline");
}
const directives = source => source.match(/^\s*\/\/\s*@ts-(?:nocheck|ignore)\b.*$/gm) ?? [];
const inheritedSuppressions = [];
for (const path of roots) {
  const current = directives(read(path));
  const previous = legacyRoots.includes(path) ? directives(baselineSource(path)) : [];
  const remaining = [...previous];
  for (const directive of current) {
    const index = remaining.indexOf(directive);
    assert.ok(index !== -1, `New TypeScript suppression in Phase 3D root: ${path}`);
    remaining.splice(index, 1);
  }
  if (current.length) inheritedSuppressions.push({ path, count: current.length });
}

const configuration = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
if (configuration.error) throw new Error("Cannot read compiler configuration");
const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, repository);
const options = { ...parsed.options, strict: true, noImplicitAny: true, strictNullChecks: true, noEmit: true, incremental: false };
const host = ts.createCompilerHost(options);
const originalRead = host.readFile;
const originalExists = host.fileExists;
const localPath = filename => {
  const path = relative(repository, resolve(filename));
  return path && !path.startsWith("../") && !isAbsolute(path) && !path.startsWith("node_modules/") && !path.startsWith(".next/") ? path : null;
};
host.readFile = filename => {
  const path = localPath(filename);
  if (path && (starting.has(path) || tracked.has(path))) return baselineSource(path);
  if (path && changed.has(path)) return undefined;
  return originalRead(filename);
};
host.fileExists = filename => {
  const path = localPath(filename);
  if (path && (starting.has(path) || tracked.has(path))) return true;
  if (path && changed.has(path)) return false;
  return originalExists(filename);
};
const baselineProgram = ts.createProgram(legacyRoots.map(path => resolve(path)), options, host);
const baselineDiagnostics = ts.getPreEmitDiagnostics(baselineProgram)
  .filter(item => item.file && legacySet.has(resolve(item.file.fileName)));
for (const path of legacyRoots) {
  assert.equal(digest(baselineProgram.getSourceFile(resolve(path))?.text ?? ""), digest(baselineSource(path)), `Compiler did not use pre-3D source: ${path}`);
}
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(roots.map(path => resolve(path)), options));
const focused = diagnostics.filter(item => !item.file || rootSet.has(resolve(item.file.fileName)));
const currentLegacy = focused.filter(item => item.file && legacySet.has(resolve(item.file.fileName)));
const clean = focused.filter(item => !currentLegacy.includes(item));
const identity = item => `${item.file ? relative(repository, item.file.fileName) : "compiler"}:${item.code}:${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`;
const counts = new Map();
for (const item of baselineDiagnostics) counts.set(identity(item), (counts.get(identity(item)) ?? 0) + 1);
const addedLegacy = currentLegacy.filter(item => {
  const count = counts.get(identity(item)) ?? 0;
  if (!count) return true;
  counts.set(identity(item), count - 1);
  return false;
});
const describe = item => ({
  file: item.file ? relative(repository, item.file.fileName) : "compiler",
  code: item.code,
  line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null,
  message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
});
console.log(JSON.stringify({
  roots, newRoots, existingRoots: legacyRoots, snapshotChecksumsVerified: checksums.length,
  restoredSourceFiles, reconstructedExcludedFiles, inheritedSuppressions,
  cleanRootDiagnostics: clean.map(describe),
  legacyBefore: baselineDiagnostics.length, legacyAfter: currentLegacy.length,
  retainedLegacyDiagnostics: currentLegacy.filter(item => !addedLegacy.includes(item)).map(describe),
  newLegacyDiagnostics: addedLegacy.map(describe),
  transitiveDiagnostics: diagnostics.length - focused.length,
  policy: "Every new/touched 3D TypeScript root is covered. New roots must be strict clean; existing roots may retain only exact verified pre-3D diagnostic identities/counts. Any inherited suppression is listed, not claimed as strict-certified. Baseline code is restored in memory, including excluded tracked source; no suppression or compiler rule is weakened. This is not repository-wide strict certification.",
}, null, 2));
if (clean.length || addedLegacy.length) process.exitCode = 1;
