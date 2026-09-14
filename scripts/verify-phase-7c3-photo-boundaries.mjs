import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const photoBoundaryPaths = [
  ...["photoMetadataContracts", "photoMetadataValidators", "photoMetadataMappers", "photoMetadataReadRepository"]
    .map(name => `src/features/photos/data/${name}.ts`),
  "src/features/photos/browserPhotoFileAdapter.ts", "src/features/photos/browserPhotoStorageAdapter.ts",
  "src/features/photos/photoUploadError.ts", "src/features/photos/photoUploadController.ts",
  "src/features/photos/PhotoGallery.tsx", "src/lib/privateObjectClient.ts", "src/lib/db.ts", "src/features/work-orders/queries.ts",
];
/** @param {ts.Node} node @param {(node: ts.Node) => void} visit */
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
/** @param {string} value */
const normalize = value => value.replace(/\s+/g, "");
/** @param {ReadonlyMap<string, string>} sources */
export function verifyPhotoBoundaries(sources) {
  /** @type {string[]} */
  const errors = [];
  /** @param {boolean} condition @param {string} message */
  const fail = (condition, message) => { if (condition) errors.push(message); };
  const ast = new Map([...sources].map(([name, text]) => [name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)]));
  /** @param {string} name */
  const need = name => { const value = ast.get(name); assert.ok(value, name); return value; };
  /** @param {string} name */
  const owner = name => need("src/features/photos/" + name);
  /** @param {ts.SourceFile} file */
  const imports = file => file.statements.filter(ts.isImportDeclaration).map(node => {
    assert.ok(ts.isStringLiteral(node.moduleSpecifier)); return node.moduleSpecifier.text;
  });
  for (const [name, file] of ast) {
    if (!name.startsWith("src/features/photos/") || name.endsWith("PhotoGallery.tsx") || name.endsWith("photoUploadController.ts")) continue;
    fail(imports(file).some(value => /\/db(?:\.ts)?$|\/server\/|server-only|^node:|^sharp$|^react$/.test(value)), name + ": forbidden dependency");
    walk(file, node => {
      fail(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || node.kind === ts.SyntaxKind.AnyKeyword,
        name + ": unchecked assertion/any");
      fail(ts.isIdentifier(node) && /^(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)$/.test(node.text), name + ": server credential");
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        fail(method === "select" && node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text.includes("*")), name + ": broad select");
        if (name.includes("/data/")) fail(["from", "rpc", "upload", "download", "remove", "insert", "update", "delete", "channel", "subscribe", "getSession"].includes(method),
          name + ": metadata owner performs unrelated IO");
      }
    });
  }
  for (const file of [...ast.values()].filter(file => file.fileName.includes("/photos/data/"))) {
    fail(imports(file).some(value => /Storage|FileAdapter|privateObject|realtime|photoUpload/.test(value)), file.fileName + ": wrong read dependency");
    walk(file, node => fail(ts.isIdentifier(node) && ["File", "Blob", "window", "document", "fetch"].includes(node.text), file.fileName + ": browser dependency"));
  }
  const repository = owner("data/photoMetadataReadRepository.ts"), repositorySource = repository.getText();
  let reads = 0;
  walk(repository, node => { if (ts.isCallExpression(node) && node.expression.getText(repository) === "dependencies.read") {
    const rpc = node.arguments[0];
    reads++; fail(!rpc || !ts.isStringLiteral(rpc) || rpc.text !== "list_work_order_photos_rows_v1", "RPC name changed");
  } });
  fail(reads !== 1, "Photo repository must have exactly one read dispatch");
  fail(!repositorySource.includes("parsePhotoMetadataPage") || !repositorySource.includes("mapPhotoMetadataPage"), "Read must validate and map");
  fail(/\b(?:while|for)\s*\(/.test(repositorySource), "Photo repository must not collect pages");
  const fileAdapter = owner("browserPhotoFileAdapter.ts"), storage = owner("browserPhotoStorageAdapter.ts");
  fail(imports(fileAdapter).some(value => !["../../lib/photoContentPolicy", "./photoUploadError"].includes(value)), "File adapter owns an unrelated dependency");
  fail(!fileAdapter.text.startsWith('"use client";') || !storage.text.startsWith('"use client";'), "Browser entry marker missing");
  fail(imports(storage).some(value => /privateObjectClient|photoUploadController|\/data\//.test(value)), "Storage must not own metadata or authoritative commands");
  fail(/\.(?:remove|delete|insert|update|upsert|rpc|channel|subscribe)\s*\(/.test(storage.text), "Storage adapter must not issue business commands or raw deletion");
  fail(!storage.text.includes("uploadIntentSchema.safeParse") || !storage.text.includes('storage.from("photos").download(path)'), "Exact private Storage boundary missing");
  const facade = need("src/lib/db.ts");
  for (const [name, expression] of [
    ["loadWorkOrderPhotosPage", "readWorkOrderPhotosPage(workOrderId,cursor,limit,signal)"],
    ["loadPhotoBlob", "readPhotoBlob(path)"], ["getPhotoUrl", "readPhotoUrl(path)"],
  ]) {
    const fn = facade.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    fail(!fn || !ts.isFunctionDeclaration(fn) || !fn.body
      || normalize(fn.body.getText(facade)) !== "{return" + expression + ";}", name + ": facade must only forward");
  }
  const queries = need("src/features/work-orders/queries.ts");
  fail(!imports(queries).includes("../photos/data/photoMetadataReadRepository"), "Photo query importer not migrated");
  fail(/\b(?:fetch|Blob|createObjectURL|revokeObjectURL)\b/.test(owner("PhotoGallery.tsx").text), "Gallery still owns byte/URL transport mechanics");
  fail(!owner("photoUploadController.ts").text.includes("await validatePhotoFile(entry.file)"), "Controller file delegation missing");
  fail(!need("src/lib/privateObjectClient.ts").text.includes("photoStorage.uploadReservedPhoto(intent, file, signal)"), "Reserved photo upload delegation missing");
  return { passed: errors.length === 0, errors };
}
export function currentPhotoBoundarySources() {
  return new Map(photoBoundaryPaths.map(name => [name, fs.readFileSync(name, "utf8")]));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyPhotoBoundaries(currentPhotoBoundarySources());
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1;
}
