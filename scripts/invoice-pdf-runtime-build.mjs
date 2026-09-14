import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Build-time only. Node 20 cannot execute our TypeScript in an isolated child.
// Compile the same bounded parser, never a second hand-maintained extraction
// implementation. Neither TypeScript nor tsx is loaded by the deployed route.
export const PDF_RUNTIME_FILES = Object.freeze([
  "invoicePdfTypes", "invoicePdfBudget", "invoicePdfContent",
  "invoicePdfTextParser", "invoicePdfDocument", "invoicePdfProcessProtocol",
  "invoicePdfProcessWorker",
]);

/** @param {string} value */
const sha256 = value => createHash("sha256").update(value).digest("hex");

/** @param {string} target @param {string} content */
function writeGenerated(target, content) {
  try { if (readFileSync(target, "utf8") === content) return; }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const pending = `${target}.${randomUUID()}.pending`;
  writeFileSync(pending, content, { mode: 0o600, flag: "wx" });
  renameSync(pending, target);
}

/** @param {string} [root] */
export function buildInvoicePdfRuntime(root = process.cwd()) {
  const output = path.join(root, "node_modules/.cache/p1-invoice-pdf-runtime");
  mkdirSync(output, { recursive: true });
  /** @type {Record<string, {source: string; output: string}>} */
  const hashes = {};
  for (const name of PDF_RUNTIME_FILES) {
    const source = readFileSync(path.join(root, `src/lib/pdf/${name}.ts`), "utf8");
    const result = ts.transpileModule(source, {
      fileName: `${name}.ts`, reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        strict: true, removeComments: false, sourceMap: false,
      },
      transformers: { before: [context => {
        /** @param {ts.Node} node @returns {ts.VisitResult<ts.Node>} */
        const visit = node => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
            && node.moduleSpecifier.text.startsWith(".")) {
            const dependency = node.moduleSpecifier.text;
            if (!PDF_RUNTIME_FILES.some(file => dependency === `./${file}`)) {
              throw new Error("PDF runtime contains an unapproved local import");
            }
            return context.factory.updateImportDeclaration(node, node.modifiers, node.importClause,
              context.factory.createStringLiteral(`${dependency}.mjs`), node.attributes);
          }
          return ts.visitEachChild(node, visit, context);
        };
        return file => ts.visitEachChild(file, visit, context);
      }] },
    });
    if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
      throw new Error("PDF runtime compilation failed");
    }
    hashes[name] = { source: sha256(source), output: sha256(result.outputText) };
    writeGenerated(path.join(output, `${name}.mjs`), result.outputText);
  }
  writeGenerated(path.join(output, "manifest.json"), `${JSON.stringify(hashes, null, 2)}\n`);
  return output;
}
