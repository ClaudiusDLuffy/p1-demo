import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { decideDismissal } from "../src/lib/forms/dismissal";
import { isBackdropRelease, MAX_MODAL_DEPTH } from "../src/lib/forms/modalRuntime";
import { nextEnabledOption, typeaheadOption } from "../src/lib/forms/selectModel";
import { getCspReportOnlyHeaders } from "../src/lib/config/server/browserSecurity";
import { PRESERVED_ENFORCED_CSP, readNextHeaders } from "../src/lib/csp-test-support/configuration";

const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
  .filter(path => /\.[cm]?[jt]sx?$/.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path)
    && !/(?:test-support|TestHarness|legacyRealtimeFixture)/.test(path));
const visit = (node: ts.Node, inspect: (node: ts.Node) => void): void => {
  inspect(node); ts.forEachChild(node, child => visit(child, inspect));
};
const attribute = (node: ts.JsxOpeningLikeElement, name: string) => node.attributes.properties
  .find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name);
const literal = (item: ts.JsxAttribute | undefined): string | null => item?.initializer && ts.isStringLiteral(item.initializer)
  ? item.initializer.text : null;
const knownControls = new Set(["Input", "TA", "Sel", "DirectorySelect", "DatePickerField", "TimePickerField"]);
const retiredDraftAccess = new Set(["readBillingDraft", "writeBillingDraft", "clearBillingDraft", "billingDraftStorageKey",
  "removeBillingDraft", "readQuoteCalculatorDraft", "writeQuoteCalculatorDraft", "clearQuoteCalculatorDraft",
  "quoteCalculatorDraftStorageKey", "quoteCalculatorDraftKey"]);

/** Structural safeguards complement, and do not substitute for, browser/AT checks. */
export async function verifyAccessiblePrimitives(runRegressionGuards = true) {
  const counts = { productionFiles: 0, modalCalls: 0, fieldCalls: 0, explicitFields: 0, groupedFields: 0, contextFields: 0, nativeDialogOwners: 0, featureDialogOwners: 0, nonModalPickerDialogs: 0, options: 0, buttons: 0, formButtons: 0 };
  const issues: string[] = [];
  for (const path of files("src")) {
    counts.productionFiles++;
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const aliases = new Map<string, string>();
    visit(file, node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
      }
    });
    const fail = (node: ts.Node, code: string) => issues.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${code}`);
    visit(file, node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /draft-test-support/.test(node.moduleSpecifier.text)) fail(node, "PRODUCTION_LEGACY_DRAFT_IMPORT");
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "clear" && /(?:^|\.)localStorage$/.test(node.expression.expression.getText())) fail(node, "GLOBAL_STORAGE_CLEAR");
      if (ts.isIdentifier(node) && retiredDraftAccess.has(node.text)) fail(node, "RETIRED_DIRECT_DRAFT_ACCESS");
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const name = aliases.get(node.tagName.getText()) ?? node.tagName.getText();
      if (name === "button") {
        counts.buttons++;
        let parent: ts.Node | undefined = node.parent;
        let insideForm = false;
        while (parent && !ts.isSourceFile(parent)) {
          if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText() === "form") {
            insideForm = true;
            break;
          }
          parent = parent.parent;
        }
        if (insideForm) {
          counts.formButtons++;
          if (!attribute(node, "type")) fail(node, "FORM_BUTTON_WITHOUT_EXPLICIT_TYPE");
        }
        const nativeAction = ["submit", "reset"].includes(literal(attribute(node, "type")) ?? "");
        const hasSpread = node.attributes.properties.some(item => ts.isJsxSpreadAttribute(item));
        const deliberatelyInactive = attribute(node, "disabled") !== undefined || attribute(node, "draggable") !== undefined;
        if (!attribute(node, "onClick") && !attribute(node, "formAction") && !nativeAction && !hasSpread && !deliberatelyInactive) {
          fail(node, "ACTIVE_BUTTON_WITHOUT_ACTION");
        }
      }
      if (["dialog", "alertdialog"].includes(literal(attribute(node, "role")) ?? "")
        && path !== "src/components/ui/Modal.tsx") {
        // Shared date/time pickers are explicitly non-modal popovers. They do
        // not own the native dialog stack or bypass the shared Modal contract.
        const sharedPicker = path === "src/components/ui/DateTimePicker.tsx"
          && literal(attribute(node, "role")) === "dialog"
          && literal(attribute(node, "aria-modal")) === "false"
          && ["Choose date", "Choose time"].includes(literal(attribute(node, "aria-label")) ?? "")
          && attribute(node, "id") !== undefined;
        const mobileNavigationDrawer = path === "src/components/PortalShell.tsx"
          && literal(attribute(node, "role")) === "dialog"
          && literal(attribute(node, "aria-modal")) === "true"
          && literal(attribute(node, "aria-label")) === "Navigation menu"
          && attribute(node, "ref")?.initializer?.getText() === "{drawerPanelRef}";
        if (sharedPicker) counts.nonModalPickerDialogs++;
        else if (mobileNavigationDrawer) counts.featureDialogOwners++;
        else fail(node, "FEATURE_OWNS_DIALOG_ROLE");
      }
      if (name === "dialog") {
        counts.nativeDialogOwners++;
        if (path !== "src/components/ui/Modal.tsx") fail(node, "FEATURE_OWNS_NATIVE_DIALOG");
      }
      if (name === "Modal") {
        counts.modalCalls++;
        if (!attribute(node, "title") || literal(attribute(node, "title")) === "") fail(node, "MISSING_MODAL_NAME");
        if (!attribute(node, "onRequestClose") && !attribute(node, "onClose")) fail(node, "MISSING_MODAL_DISMISSAL");
      }
      if (name === "Field") {
        counts.fieldCalls++;
        if (!attribute(node, "label")) fail(node, "MISSING_FIELD_LABEL");
        if (attribute(node, "group")) { counts.groupedFields++; return; }
        if (["controlId", "htmlFor", "id"].some(key => attribute(node, key))) { counts.explicitFields++; return; }
        let associated = false;
        const subtree = ts.isJsxOpeningElement(node) ? node.parent : node;
        visit(subtree, child => {
          if (child === node || (!ts.isJsxOpeningElement(child) && !ts.isJsxSelfClosingElement(child))) return;
          associated ||= knownControls.has(aliases.get(child.tagName.getText()) ?? child.tagName.getText());
        });
        if (!associated) fail(node, "FIELD_WITHOUT_ASSOCIATED_CONTROL_OR_GROUP");
        else counts.contextFields++;
      }
      if (path === "src/components/ui/Sel.tsx" && literal(attribute(node, "role")) === "option") {
        counts.options++;
        if (name === "button" || attribute(node, "tabIndex")) fail(node, "TABBABLE_SELECT_OPTION");
        if (!attribute(node, "aria-selected") || !attribute(node, "aria-disabled")) fail(node, "SELECT_OPTION_STATE_MISSING");
      }
    });
  }
  assert.equal(counts.nativeDialogOwners, 1);
  assert.equal(counts.featureDialogOwners, 1);
  assert.equal(counts.nonModalPickerDialogs, 2);
  assert.ok(counts.modalCalls > 30 && counts.fieldCalls > 50 && counts.options > 0);
  assert.deepEqual(issues, [], "Production primitive structural guard failed");
  const guardedFeatures = ["src/features/receiving-dispatch/DispatchReconciliationDialog.tsx",
    "src/features/financial-notifications/FinancialNoticeDialog.tsx", "src/features/parts-sms/PartsSmsDialog.tsx",
    "src/features/invoices/InvoiceDetail.tsx", "src/features/invoices/InvoiceList.tsx",
    "src/features/work-orders/WorkOrderDetail.tsx", "src/features/billing/BillingInvoiceCreateModal.tsx",
    "src/features/work-orders/QuoteCalculatorWorkspace.tsx", "src/features/invoices/InvoiceCreateModal.tsx"];
  for (const path of guardedFeatures) assert.match(readFileSync(path, "utf8"), /useUnsavedChangesGuard/);
  assert.equal(MAX_MODAL_DEPTH, 32);
  assert.equal(isBackdropRelease(false, true), false);
  assert.equal(isBackdropRelease(true, false), false);
  assert.equal(decideDismissal({ dirty: true, busy: false, persistence: "persist_failed", reason: "escape" }).action, "confirm_discard");
  assert.equal(decideDismissal({ dirty: true, busy: true, persistence: "dirty_not_persisted", reason: "backdrop" }).action, "blocked");
  const options = [false, true, false].map((disabled, index) => ({ index, disabled, value: String(index), label: `Choice ${index}`, sub: "", search: "" }));
  assert.equal(nextEnabledOption(options, 0, "next"), 2);
  assert.equal(typeaheadOption(options, 0, "Choice 2"), 2);
  const headers = await readNextHeaders(() => getCspReportOnlyHeaders({}));
  const enforced = headers[0].headers.find(header => header.key === "Content-Security-Policy")?.value;
  assert.equal(enforced, PRESERVED_ENFORCED_CSP);
  const hash = createHash("sha256").update(enforced).digest("hex");
  assert.equal(hash, "16dfd6aca089a948513be619c399fcdea4c6b4151ff58af0a62587c62b70ccab");
  const candidate = getCspReportOnlyHeaders({ NODE_ENV: "production", VERCEL_ENV: "preview", P1_APP_ENV: "preview",
    NEXT_PUBLIC_P1_APP_ENV: "preview", P1_ENABLE_CSP_REPORT_ONLY: "true", NEXT_PUBLIC_SUPABASE_URL: "https://syntheticpreview.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic", P1_EXPECTED_SUPABASE_PROJECT_REF: "syntheticpreview",
    P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticproduction" });
  assert.equal(candidate.length, 1);
  assert.match(candidate[0].value, /connect-src 'self' https:\/\/syntheticpreview\.supabase\.co wss:\/\/syntheticpreview\.supabase\.co;/);
  assert.doesNotMatch(candidate[0].value, /\*|unsafe-inline|unsafe-eval|report-uri|report-to|graph\.microsoft|twilio/);
  let priorGuardTests = 0;
  if (runRegressionGuards) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec",
      "src/lib/realtime/realtimeOwnership.test.ts", "src/lib/counts/countQueries.test.ts",
      "src/lib/directoryProductionBoundary.test.ts", "src/features/invoices/invoiceReadImportGuard.test.ts",
      "src/lib/forms/modalRuntime.test.ts", "src/lib/forms/dismissal.test.ts", "src/lib/cspReportOnly.test.ts"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    assert.equal(result.status, 0, "Existing count/realtime/directory/invoice/modal/CSP guards failed; run their focused tests for details");
    priorGuardTests = Number(result.stdout.match(/ℹ pass (\d+)/)?.[1] ?? 0);
    assert.ok(priorGuardTests > 0);
  }
  return { result: "passed", evidence: "LOCAL_STATIC_AND_INJECTED_RUNTIME", counts,
    representativeDirtyFeatures: guardedFeatures.length, priorGuardTests, enforcedPolicySha256: hash,
    realBrowserVerified: false, assistiveTechnologyVerified: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyAccessiblePrimitives().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ result: "failed", code: "ACCESSIBLE_PRIMITIVE_GUARD_FAILED",
      issues: error instanceof assert.AssertionError ? error.actual : undefined }));
    process.exitCode = 1;
  });
}
