import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const filename = resolve("src/features/work-orders/WorkOrderDetail.tsx");
const detailText = readFileSync(filename, "utf8");
const detail = ts.createSourceFile(filename, detailText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const shellText = readFileSync(resolve("src/components/PortalShell.tsx"), "utf8");
const shell = ts.createSourceFile("PortalShell.tsx", shellText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

const editButtons = findNodes(detail, node => ts.isJsxElement(node)
  && node.openingElement.tagName.getText(detail) === "button"
  && node.openingElement.attributes.getText(detail).includes('setModal("editWO")'));
assert.equal(editButtons.length, 1);
const editButton = editButtons[0];
let guard: ts.Node = editButton.parent;
while (guard.parent && !ts.isBinaryExpression(guard)) guard = guard.parent;
assert.ok(ts.isBinaryExpression(guard));
assert.equal(guard.left.getText(detail), "isManager");
assert.equal(guard.operatorToken.kind, ts.SyntaxKind.AmpersandAmpersandToken);

const roleDeclarations = findNodes(shell, node => ts.isVariableDeclaration(node)
  && node.name.getText(shell) === "isManager");
assert.equal(roleDeclarations.length, 1);
const roleDeclaration = roleDeclarations[0];
assert.ok(ts.isVariableDeclaration(roleDeclaration) && roleDeclaration.initializer);

// Evaluate the actual production role predicate and JSX guard, without loading
// the network-backed detail hooks or changing the form's existing behavior.
const compiled = ts.transpileModule(`
  const isManager = ${roleDeclaration.initializer.getText(shell)};
  exports.control = ${guard.left.getText(detail)} && (${editButton.getText(detail)});
`, { compilerOptions: {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const localRequire = createRequire(filename);

function renderControl(role: string | null, busy = false, staffPermissions: string[] = []) {
  const exports: { control?: ReactNode } = {};
  const opened: string[] = [];
  runInNewContext(compiled, {
    exports,
    require: localRequire,
    currentUser: role ? { role, staffPermissions } : null,
    woData: { id: "WOT-EDIT-SYNTHETIC" },
    isLoading: (key: string) => busy && key === "editWO_WOT-EDIT-SYNTHETIC",
    loadingStyle: () => ({}),
    setModal: (modal: string) => opened.push(modal),
    BtnSpinnerDark: () => null,
    T: { ink: "#000000" },
  });
  return { control: exports.control, opened };
}

test("Edit work order belongs to the header, before invoices or estimates", () => {
  const headerCards = findNodes(detail, node => ts.isJsxElement(node)
    && node.openingElement.tagName.getText(detail) === "div"
    && node.openingElement.attributes.getText(detail).includes('className="card"')
    && findNodes(node, child => ts.isJsxElement(child)
      && child.openingElement.attributes.getText(detail).includes('className="work-order-location-heading"')).length > 0);
  assert.equal(headerCards.length, 1);
  const header = headerCards[0];
  assert.ok(editButton.pos > header.pos && editButton.end < header.end);
  assert.ok(editButton.pos < detailText.indexOf("<ContractorEstimatePanel"));
  assert.ok(editButton.pos < detailText.indexOf("{woAllInvoices.length > 0"));
  assert.match(editButton.getText(detail), /className="btn-soft"/);
  assert.match(editButton.getText(detail), /type="button"/);
});

for (const role of ["manager", "dispatcher", "back_office"]) {
  test(`${role} can open the unchanged editor from the header`, () => {
    const { control, opened } = renderControl(role);
    assert.match(renderToStaticMarkup(control), /Edit work order/);
    assert.ok(isValidElement<{ onClick: () => void; disabled: boolean }>(control));
    assert.equal(control.props.disabled, false);
    control.props.onClick();
    assert.deepEqual(opened, ["editWO"]);
  });
}

for (const role of [null, "contractor", "technician", "unsupported_role"]) {
  test(`${role ?? "missing profile"} does not receive the staff edit control`, () => {
    assert.equal(renderToStaticMarkup(renderControl(role).control), "");
  });
}

test("an existing controller grant does not change the staff edit gate", () => {
  const { control } = renderControl("back_office", false, ["invoice_controller"]);
  assert.match(renderToStaticMarkup(control), /Edit work order/);
});

test("saving disables the header control and keeps its progress label", () => {
  const { control } = renderControl("manager", true);
  assert.ok(isValidElement<{ disabled: boolean }>(control));
  assert.equal(control.props.disabled, true);
  assert.match(renderToStaticMarkup(control), /Saving/);
});

test("edit visibility stays independent of work-order status and invoice data", () => {
  assert.doesNotMatch(guard.getText(detail), /woData\.status|woAllInvoices|woBillingInvoices|hasAnyLiveInvoice/);
  assert.match(shellText, /modal === "editWO" && woData && isManager/);
  assert.match(shellText, /Status, contractor assignment, and timestamps have their own actions and aren't edited here/);
});
