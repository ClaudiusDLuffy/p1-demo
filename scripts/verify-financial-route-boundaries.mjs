import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const boundaries = new Map([
  ["src/app/api/billing-invoices/route.ts", "../../../server/billing-invoices/applicationService"],
  ["src/app/api/controller-exports/route.ts", "../../../server/controller-exports/httpBoundary"],
  ["src/server/controller-exports/httpBoundary.ts", "./applicationService"],
]);

export function verifyFinancialRouteBoundaries(sources = new Map([...boundaries.keys()].map(file => [file, readFileSync(file, "utf8")]))) {
  for (const [file, expected] of boundaries) {
    const source = sources.get(file);
    if (!source) throw new Error(`${file}: boundary missing`);
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let delegated = false;
    const visit = node => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const edge = node.moduleSpecifier.text;
        if (edge === expected) delegated = true;
        if (/legacyRouteImplementation|billingMutationUseCases/.test(edge)) throw new Error(`${file}: legacy owner`);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
        && /legacyRouteImplementation|billingMutationUseCases/.test(node.moduleSpecifier.text)) throw new Error(`${file}: legacy re-export`);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.expression;
        const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
          : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text
          : ts.isIdentifier(expression) ? expression.text : "";
        if (["from", "rpc", "select", "createSignedUrl", "upload", "download", "remove", "JSZip", "generateInvoicePdf"].includes(name)) {
          throw new Error(`${file}: direct side effect ${name}`);
        }
        if ((expression.kind === ts.SyntaxKind.ImportKeyword || name === "require")
          && node.arguments?.some(argument => ts.isStringLiteralLike(argument) && /legacyRouteImplementation|billingMutationUseCases/.test(argument.text))) {
          throw new Error(`${file}: dynamic legacy owner`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (!delegated) throw new Error(`${file}: actual typed delegation missing`);
  }
  return { passed: true, boundaries: boundaries.size };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(verifyFinancialRouteBoundaries()));
}
