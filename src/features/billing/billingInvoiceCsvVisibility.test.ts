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
function renderDetail(document: Record<string, unknown>, permissions: string[] = []) {
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
    if (name === "react") return { useState: (initial: unknown) => [initial, () => undefined] };
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (componentImports.has(name)) return new Proxy({}, { get: (_target, property) => String(property) });
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  assert.ok(exports.default);
  let downloads = 0;
  const tree = exports.default({
    invoice: { id: "synthetic-billing-invoice", num: "SYNTH-100", state: "submitted", lines: [], ...document },
    currentUser: { role: "back_office", staffPermissions: permissions },
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

test("a capital final invoice retains CSV access while a capital quote is never exported as a customer invoice", () => {
  const finalInvoice = renderDetail({ documentKind: "invoice", sourceCapitalQuoteId: "synthetic-quote" });
  assert.ok(finalInvoice.buttons.some(node => label(node) === "Download SaasAnt CSV"));
  for (const permissions of [[], ["quickbooks_export"], ["quickbooks_handoff"], ["invoice_controller"]]) {
    const quote = renderDetail({ documentKind: "capital_quote" }, permissions);
    assert.ok(quote.buttons.some(node => label(node) === "Download PDF"));
    assert.equal(quote.buttons.some(node => label(node) === "Download SaasAnt CSV"), false);
    assert.equal(quote.downloads(), 0);
  }
});

test("the existing shell and handler preserve controller-page restrictions and quote-export denial", () => {
  const shell = readFileSync(resolve("src/components/PortalShell.tsx"), "utf8");
  assert.match(shell, /isManager && !invoiceController && page === "billing" && selectedBillingInvoice && \(\s*<BillingInvoiceDetail/);
  assert.match(shell, /onDownloadCsv=\{\(\) => selectedBillingInvoiceData && doDownloadBillingInvoiceCsv\(selectedBillingInvoiceData\)\}/);
  assert.match(shell, /if \(exportInvoice\.documentKind === "capital_quote"\) \{\s*throw new Error\("Capital quotes cannot use the SaasAnt customer-invoice format"\)/);
});
