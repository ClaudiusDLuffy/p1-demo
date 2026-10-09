import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Element = { type: unknown; props: Record<string, unknown> };
function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isElement(value) ? [value, ...elements(value.props.children)] : [];
}
function label(value: unknown): string {
  if (Array.isArray(value)) return value.map(label).join("");
  return isElement(value) ? label(value.props.children) : typeof value === "string" ? value : "";
}

// Execute the actual component with only React rendering and child components
// replaced. This does not claim browser layout or authorize access to the page.
function renderDetail(document: Record<string, unknown>, permissions: string[] = [], actor: Record<string, unknown> = {}) {
  const filename = resolve("src/features/billing/BillingInvoiceDetail.tsx");
  const requireHere = createRequire(import.meta.url);
  const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
  const componentImports = new Set([
    "../../components/ui/Badge", "../../components/ui/BtnSpinner", "../../components/ui/CopyWorkOrderButton",
    "../../components/ui/Ico", "../../components/ui/Modal", "./InvoiceLineTypeSubtotals", "./SourceContractorInvoiceDrawer",
  ]);
  const element = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, require: (name: string): unknown => {
    if (name === "react") return {
      useState: (initial: unknown) => [initial, () => undefined],
      useRef: (initial: unknown) => ({ current: initial }),
    };
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (name === "../invoices/invoiceLineQueries") return { useInvoiceLinePage: () => ({ lines: [], hasMore: false, loading: false }) };
    if (componentImports.has(name)) return new Proxy({}, { get: (_target, property) => String(property) });
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  assert.ok(exports.default);
  let downloads = 0;
  const tree = exports.default({
    invoice: { id: "synthetic-billing-invoice", num: "SYNTH-100", state: "submitted", lines: [], ...document },
    currentUser: { role: "back_office", active: true, staffPermissions: permissions, ...actor },
    onDownloadCsv: () => { downloads += 1; }, fmt: (amount: number) => amount.toFixed(2),
  });
  return { buttons: elements(tree).filter(node => node.type === "button"), downloads: () => downloads };
}

test("ordinary billing invoices retain their existing SaasAnt CSV callback without a QuickBooks handoff grant", () => {
  const rendered = renderDetail({ documentKind: "invoice" });
  const button = rendered.buttons.find(node => label(node) === "Download SaasAnt CSV");
  assert.ok(button); assert.ok(typeof button.props.onClick === "function");
  assert.ok(!button.props.disabled);
  button.props.onClick();
  assert.equal(rendered.downloads(), 1);
});

test("capital quotes restore optional manual CSV access without requiring a QuickBooks handoff grant", () => {
  const finalInvoice = renderDetail({ documentKind: "invoice", sourceCapitalQuoteId: "synthetic-quote" });
  assert.ok(finalInvoice.buttons.some(node => label(node) === "Download SaasAnt CSV"));
  for (const permissions of [[], ["quickbooks_export"], ["quickbooks_handoff"]]) {
    const quote = renderDetail({ documentKind: "capital_quote" }, permissions);
    assert.ok(quote.buttons.some(node => label(node) === "Download PDF"));
    const csv = quote.buttons.find(node => label(node) === "Download SaasAnt CSV");
    assert.ok(csv);
    assert.equal(quote.downloads(), 0, "Rendering the quote must not export it automatically");
    assert.equal(typeof csv.props.onClick, "function");
    (csv.props.onClick as () => void)();
    assert.equal(quote.downloads(), 1);
  }
  const controllerQuote = renderDetail({ documentKind: "capital_quote" }, ["invoice_controller"]);
  assert.equal(controllerQuote.buttons.some(node => label(node) === "Download SaasAnt CSV"), false);
  assert.equal(controllerQuote.downloads(), 0);
  for (const actor of [{ active: false }, { role: "contractor" }]) {
    const restricted = renderDetail({ documentKind: "capital_quote" }, [], actor);
    assert.equal(restricted.buttons.some(node => label(node) === "Download SaasAnt CSV"), false);
    assert.equal(restricted.downloads(), 0);
  }
});

test("capital submission is clearly labeled as a record-only action", () => {
  const quote = renderDetail({ documentKind: "capital_quote" });
  assert.ok(quote.buttons.some(node => label(node) === "Mark submitted to 7-Eleven"));
  assert.equal(quote.buttons.some(node => label(node) === "Submit Quote to 7-Eleven"), false);
  const invoice = renderDetail({ documentKind: "invoice" });
  assert.ok(invoice.buttons.some(node => label(node) === "Billed to 7-Eleven"));
});

test("capital quote editor guidance uses the simplified closeout without changing regular-invoice guidance", () => {
  const editor = readFileSync(resolve("src/features/billing/BillingInvoiceCreateModal.tsx"), "utf8");
  assert.match(editor, /\{isCapitalQuote\s*\? "Preparing or updating this quote does not upload it to 7-Eleven or confirm billing\./);
  assert.match(editor, /use Close out to confirm the existing bill or send it to billing/);
  assert.doesNotMatch(editor, /This capital quote is separate from the final invoice\. Submitting it will move/);
  assert.match(editor, /Direction is fixed: P1 Pros bills 7-Eleven\. Linking a work order is optional\./);
});

test("the existing shell retains controller restrictions and full-document validation before an explicit CSV download", () => {
  const shell = readFileSync(resolve("src/components/PortalShell.tsx"), "utf8");
  assert.match(shell, /isManager && !invoiceController && page === "billing" && selectedBillingInvoice && \(\s*<BillingInvoiceDetail/);
  assert.match(shell, /onDownloadCsv=\{\(\) => selectedBillingInvoiceData && doDownloadBillingInvoiceCsv\(selectedBillingInvoiceData\)\}/);
  assert.match(shell, /if \(exportInvoice\.documentKind === "capital_quote" && \(!isManager \|\| invoiceController \|\| currentUser\?\.active !== true\)\)/);
  assert.match(shell, /loadBillingInvoiceForExport\(invoice, "csv"\)/);
  assert.match(shell, /assertStaffInvoiceIntegrity\(exportInvoice\)/);
  assert.match(shell, /loadCompleteInvoice\.assertCurrent\(\);\s*downloadStaffInvoiceCsv/);
  const closeOut = readFileSync(resolve("src/features/work-orders/WorkOrderCloseOutPanel.tsx"), "utf8");
  assert.doesNotMatch(closeOut, /downloadStaffInvoiceCsv|onDownloadCsv|doDownloadBillingInvoiceCsv/);
});
