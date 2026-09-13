import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { currentPhotoBoundarySources, verifyPhotoBoundaries } from "../../../scripts/verify-phase-7c3-photo-boundaries.mjs";

test("photo ownership/import guard accepts current focused boundaries", () => {
  assert.deepEqual(verifyPhotoBoundaries(currentPhotoBoundarySources()), { passed: true, errors: [] });
});
for (const [file, extra] of [
  ["data/photoMetadataReadRepository.ts", 'import { x } from "../../../lib/db";'],
  ["data/photoMetadataMappers.ts", 'const value = fetch("/synthetic");'],
  ["browserPhotoFileAdapter.ts", 'import { supabase } from "../../lib/supabase/client";'],
  ["browserPhotoStorageAdapter.ts", 'import { deleteBoundObject } from "../../lib/privateObjectClient";'],
  ["browserPhotoStorageAdapter.ts", 'storage.remove(["synthetic"]);'],
]) test(`photo guard rejects misplaced responsibility in ${file}: ${extra}`, () => {
  const sources = currentPhotoBoundarySources(), name = "src/features/photos/" + file;
  sources.set(name, sources.get(name) + "\n" + extra);
  assert.equal(verifyPhotoBoundaries(sources).passed, false);
});
test("db photo Blob and URL compatibility functions forward exact arguments and outcomes", async () => {
  const source = readFileSync("src/lib/db.ts", "utf8");
  const ast = ts.createSourceFile("db.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ["loadPhotoBlob", "getPhotoUrl"].includes(node.name?.text ?? "")).map(node => node.getText(ast)).join("\n");
  assert.equal(declarations.includes("readPhotoBlob"), true);
  const calls: string[] = [], blob = new Blob(["synthetic"]);
  const exports: { loadPhotoBlob?: (path: string) => Promise<Blob>; getPhotoUrl?: (path: string) => Promise<string | null> } = {};
  runInNewContext(ts.transpileModule(declarations, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, readPhotoBlob: async (path: string) => { calls.push(path); return blob; },
      readPhotoUrl: async (path: string) => { calls.push(path); return path ? "blob:synthetic" : null; } });
  assert.ok(exports.loadPhotoBlob && exports.getPhotoUrl);
  assert.equal(await exports.loadPhotoBlob("wo/SYNTHETIC/reviewed"), blob);
  assert.equal(await exports.getPhotoUrl("wo/SYNTHETIC/reviewed"), "blob:synthetic");
  assert.equal(await exports.getPhotoUrl(""), null);
  assert.deepEqual(calls, ["wo/SYNTHETIC/reviewed", "wo/SYNTHETIC/reviewed", ""]);
});
