import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const read = (path: string) => readFileSync(path, "utf8");
function productionFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? productionFiles(file)
      : /\.[jt]sx?$/.test(file) && !/\.test\.|TestHarness|TestSupport|test-support/.test(file) ? [file] : [];
  });
}
function namedFunction(file: string, name: string): string {
  const text = read(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `${file}: missing ${name}`);
  return node.getText(source);
}

test("production invoice collectors are restricted to explicit editor/export boundaries", () => {
  const permittedImports: Record<string, readonly string[]> = {
    loadInvoiceById: ["src/features/estimates/ContractorEstimatePanel.tsx"],
    loadInvoices: ["src/features/invoices/queries.ts"], // Retained uncalled compatibility hook.
    useInvoicesQuery: [],
    readCompleteInvoiceDocument: ["src/features/invoices/invoiceReads.ts", "src/features/billing/billingReads.ts"],
    readInvoiceDocument: ["src/lib/db.ts", "src/features/invoices/useInvoiceDocumentAction.ts"],
    readBillingDocument: ["src/features/invoices/useInvoiceDocumentAction.ts"],
    useInvoiceDocumentAction: ["src/components/PortalShell.tsx", "src/features/invoices/useInvoices.ts",
      "src/features/billing/BillingInvoiceCreateModal.tsx", "src/features/work-orders/QuoteCalculatorWorkspace.tsx"],
  };
  for (const file of productionFiles("src")) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const name = element.propertyName?.text ?? element.name.text;
        if (name in permittedImports) assert.ok(permittedImports[name].includes(file), `${name} imported outside its explicit boundary: ${file}`);
      }
    }
  }
});

test("ordinary invoice rows and exact header queries do not enrich each row or collect line pages", () => {
  const page = namedFunction("src/lib/db.ts", "loadInvoicesPage");
  const detail = namedFunction("src/lib/db.ts", "loadInvoiceSummaryById");
  assert.match(page, /list_contractor_invoices_rows_v2/);
  assert.doesNotMatch(page + detail, /count_contractor|loadInvoiceById\(|readInvoiceDocument\(|readInvoiceLines\(|Promise\.all|while\s*\(|\.select\(/);
  assert.match(detail, /readInvoiceSummary\(invoiceId, signal\)/);
  for (const [file, names] of [
    ["src/features/invoices/queries.ts", ["useInvoicesPageQuery", "useInvoiceByIdQuery"]],
    ["src/features/billing/queries.ts", ["useBillingInvoicePageQuery", "useBillingInvoiceByIdQuery", "useBillingSourceInvoiceByIdQuery"]],
  ] as const) {
    for (const name of names) assert.doesNotMatch(namedFunction(file, name), /loadInvoiceById|read\w*Document|collect\w*Pages|fetchNextPage|while\s*\(/);
  }
});

test("normal detail line views use one versioned page and exact actor-scoped invalidation", () => {
  const lines = read("src/features/invoices/invoiceLineQueries.ts");
  assert.match(lines, /invoiceLinesKey\(id, scope, version, current\.cursor, staff, source\)/);
  assert.match(lines, /enabled && visible && input\.projection === "summary"/);
  assert.match(lines, /version >= 0/);
  assert.match(lines, /invoiceByIdKey\(id, scope\)/);
  assert.match(lines, /billingInvoiceByIdKey\(id, scope\)/);
  assert.doesNotMatch(lines, /useInfiniteQuery|fetchNextPage|read\w*Document|collect\w*Pages|while\s*\(|refetchQueries\(/);
  for (const file of ["src/features/invoices/InvoiceDetail.tsx", "src/features/billing/BillingInvoiceDetail.tsx",
    "src/features/billing/SourceContractorInvoiceDrawer.tsx"]) {
    const text = read(file);
    assert.match(text, /useInvoiceLinePage\(/);
    assert.match(text, /InvoiceLinePagination/);
    assert.doesNotMatch(text, /readCompleteInvoiceDocument|readInvoiceDocument|readBillingDocument|collectSupabasePages|fetchNextPage/);
  }
});

test("new invoice transports prohibit select-star, legacy page RPCs and full-line wire aliases", () => {
  for (const file of ["src/features/invoices/invoiceReads.ts", "src/features/billing/billingReads.ts", "src/lib/server/billingCompactReads.ts"]) {
    const text = read(file);
    assert.doesNotMatch(text, /\.select\(["']\*|list_contractor_invoices_page|list_staff_invoices_page/);
    assert.doesNotMatch(text, /\b(?:wot|desc|invoiceDateRaw)\s*:/);
  }
  const server = read("src/lib/server/billingCompactReads.ts");
  assert.doesNotMatch(server, /invoiceSummaryForLegacyUi|invoiceDocumentForLegacyUi|collectSupabasePages|Promise\.all/);
  assert.match(server, /items: result\.items\.map\(parseInvoiceSummary\)/);
  const continuation = server.slice(server.indexOf("const rawGate"));
  assert.doesNotMatch(continuation, /get_invoice_summary_v1|count_\w+|line_type_summary/);
  assert.match(continuation, /list_invoice_lines_page_v1/);
  assert.match(continuation, /p_expected_version:/);
});

test("financial renderers keep explicit complete-document and partial-summary boundaries", () => {
  const collector = read("src/features/invoices/invoiceDocumentRead.ts");
  assert.match(collector, /MAX_COMPLETE_INVOICE_LINES = 1000/);
  assert.match(collector, /MAX_COMPLETE_INVOICE_BYTES = 32 \* 1024 \* 1024/);
  assert.match(collector, /page\.invoiceVersion !== summary\.invoiceVersion/);
  assert.match(collector, /lines\.length !== summary\.lineCount/);
  for (const file of ["src/features/invoices/InvoiceCreateModal.tsx", "src/features/billing/BillingInvoiceCreateModal.tsx"]) {
    assert.ok(/projection !== "complete_document"/.test(read(file)), `${file}: explicit partial-document guard`);
  }
  const download = read("src/features/invoices/useInvoices.ts");
  assert.match(download, /readCompleteDocument\.summary\(String\(inv\.id\)\)/);
  assert.match(download, /readCompleteDocument\(String\(inv\.id\), "pdf"\)/);
  assert.match(download, /rejectPartialInvoiceDocument\(inv\)/);
  assert.doesNotMatch(read("src/features/invoices/InvoiceList.tsx"), /useInvoiceByIdQuery|useInvoiceLinePage|readInvoiceDocument/);
  assert.doesNotMatch(read("src/features/billing/BillingInvoiceList.tsx"), /useBillingInvoiceByIdQuery|useInvoiceLinePage|readBillingDocument/);
});
