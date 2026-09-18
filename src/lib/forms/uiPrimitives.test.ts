import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { TA } from "../../components/ui/TA";
import { Sel } from "../../components/ui/Sel";
import { Modal } from "../../components/ui/Modal";
import { BtnSpinner, BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { mergeDescriptionIds } from "../../components/ui/fieldContext";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "./primitiveComponentTestHarness";

test("Field links generated name, hint/error/required state to native Input and TA", () => {
  for (const control of [createElement(Input, { name: "reason", "aria-describedby": "external" }), createElement(TA, { name: "reason", "aria-describedby": "external" })]) {
    const html = renderToStaticMarkup(createElement(Field, { label: "Synthetic reason", controlId: "reason", required: true,
      hint: "Reason guidance", error: "Reason needed" }, control));
    assert.match(html, /<label id="reason-label" for="reason"/);
    assert.match(html, /id="reason"/); assert.match(html, /aria-labelledby="reason-label"/);
    assert.match(html, /aria-describedby="external reason-hint reason-error"/);
    assert.match(html, /aria-invalid="true"/); assert.match(html, /aria-required="true"/);
    assert.match(html, /id="reason-error" role="alert"/); assert.match(html, /required=""/);
  }
});
test("explicit control IDs and aria descriptions remain deterministic and deduplicated", () => {
  assert.equal(mergeDescriptionIds("outside same", "same hint", undefined, "error"), "outside same hint error");
  assert.equal(mergeDescriptionIds(undefined, ""), undefined);
  const html = renderToStaticMarkup(createElement(Field, { label: "Named", htmlFor: "exact" }, createElement(Input, { id: "exact", "aria-label": "Explicit label" })));
  assert.match(html, /for="exact"/); assert.match(html, /aria-label="Explicit label"/);
  assert.doesNotMatch(html, /aria-labelledby=/);
});
test("group Field renders fieldset/legend without duplicate control IDs", () => {
  const html = renderToStaticMarkup(createElement(Field, { label: "Time range", controlId: "range", group: true },
    createElement(Input, { key: "from", "aria-label": "From" }), createElement(Input, { key: "to", "aria-label": "To" })));
  assert.match(html, /^<fieldset/); assert.match(html, /<legend id="range-label"/);
  const controls = [...html.matchAll(/<input[^>]* id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(controls.length, 2); assert.notEqual(controls[0], controls[1]);
});
test("SSR Modal does not access browser globals and closed Modal renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(Modal, { title: "Closed", open: false })), "");
  assert.match(renderToStaticMarkup(createElement(Modal, { title: "Open", onClose() {} })), /data-modal-anchor="true"/);
});
test("spinners are decorative, never duplicate adjacent loading announcements", () => {
  for (const Spinner of [BtnSpinner, BtnSpinnerDark]) {
    const html = renderToStaticMarkup(createElement(Spinner));
    assert.match(html, /aria-hidden="true"/); assert.doesNotMatch(html, /role="(?:status|alert)"/);
  }
});
test("SSR selection preserves label/ref form names and disabled successful-control behavior", () => {
  const html = renderToStaticMarkup(createElement(Field, { label: "Scope", controlId: "scope" }, createElement(Sel, {
    name: "scope", defaultValue: "b", disabled: true,
  }, createElement("option", { key: "a", value: "a" }, "A"), createElement("option", { key: "b", value: "b" }, "B"))));
  const hidden = html.match(/<input[^>]*type="hidden"[^>]*>/)?.[0] || "";
  for (const attribute of ['name="scope"', 'disabled=""', 'readOnly=""', 'value="b"']) assert.ok(hidden.includes(attribute));
  assert.match(html, /id="scope"[^>]*aria-labelledby="scope-label"/);
  assert.match(html, /role="combobox"/); assert.match(html, /aria-controls=/);
});

const option = (value: string, label: string, disabled = false) => ({ type: "option", props: { value, children: label, disabled } });
const find = (tree: unknown, predicate: (node: UiNode) => boolean) => { const result = uiNodes(tree).find(predicate); assert.ok(result); return result; };
const key = (value: string, target: unknown, at = 1000) => ({ key: value, currentTarget: target, timeStamp: at,
  defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
test("actual Sel exposes non-tabbable div options with unique IDs and keyboard active descendant", () => {
  const h = primitiveHarness("src/components/ui/Sel.tsx");
  const props = { name: "status", defaultValue: "same", children: [option("same", "Same"), option("same", "Same"), option("disabled", "Disabled", true), option("last", "Last")] };
  let tree = h.render("Sel", props); const trigger = find(tree, node => node.type === "button");
  const triggerElement = { focus() {} }; (trigger.props.ref as { current: unknown }).current = triggerElement;
  uiInvoke(trigger, "onKeyDown", key("ArrowDown", triggerElement)); tree = h.render("Sel", props);
  const options = uiNodes(tree).filter(node => node.props.role === "option");
  assert.equal(options.length, 4); assert.ok(options.every(node => node.type === "div" && node.props.tabIndex === undefined));
  assert.equal(new Set(options.map(node => node.props.id)).size, options.length);
  assert.equal(options[2].props["aria-disabled"], true);
  const current = find(tree, node => node.type === "button"); uiInvoke(current, "onKeyDown", key("End", triggerElement)); tree = h.render("Sel", props);
  assert.equal(find(tree, node => node.type === "button").props["aria-activedescendant"], options[3].props.id);
});
test("actual Sel Enter selects once with field name/value and returns focus; Escape consumes without change", () => {
  const h = primitiveHarness("src/components/ui/Sel.tsx"); const changes: { target: { name: string; value: string } }[] = []; let focused = 0;
  const props = { name: "state", value: "a", children: [option("a", "Alpha"), option("b", "Beta")], onChange: (event: { target: { name: string; value: string } }) => changes.push(event) };
  let tree = h.render("Sel", props); const triggerElement = { focus() { focused++; } };
  const trigger = find(tree, node => node.type === "button"); (trigger.props.ref as { current: unknown }).current = triggerElement;
  uiInvoke(trigger, "onClick"); tree = h.render("Sel", props);
  uiInvoke(find(tree, node => node.type === "button"), "onKeyDown", key("End", triggerElement)); tree = h.render("Sel", props);
  uiInvoke(find(tree, node => node.type === "button"), "onKeyDown", key("Enter", triggerElement));
  assert.equal(changes.length, 1); assert.equal(changes[0].target.name, "state"); assert.equal(changes[0].target.value, "b"); assert.equal(focused, 1);
  tree = h.render("Sel", props); uiInvoke(find(tree, node => node.type === "button"), "onClick"); tree = h.render("Sel", props);
  const escape = key("Escape", triggerElement); uiInvoke(find(tree, node => node.type === "button"), "onKeyDown", escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(escape.stopped, true); assert.equal(changes.length, 1);
});
test("open Sel still consumes Escape preemptively prevented by its modal owner", () => {
  const h = primitiveHarness("src/components/ui/Sel.tsx");
  const props = { name: "priority", value: "p3", children: [option("p3", "P3"), option("p4", "P4")] };
  let tree = h.render("Sel", props); const triggerElement = { focus() {} };
  const trigger = find(tree, node => node.type === "button"); (trigger.props.ref as { current: unknown }).current = triggerElement;
  uiInvoke(trigger, "onClick"); tree = h.render("Sel", props);
  const escape = key("Escape", triggerElement); escape.preventDefault();
  uiInvoke(find(tree, node => node.type === "button"), "onKeyDown", escape);
  tree = h.render("Sel", props);
  assert.equal(uiNodes(tree).some(node => node.props.role === "listbox"), false);
});
test("searchable Sel uses named combobox, bounded search, no-results and disabled-option guard", () => {
  const h = primitiveHarness("src/components/ui/Sel.tsx"); let changes = 0;
  const props = { "aria-label": "Technician type", children: Array.from({ length: 11 }, (_, index) => option(String(index), `Choice ${index}`, index === 0)), onChange: () => changes++ };
  let tree = h.render("Sel", props); uiInvoke(find(tree, node => node.type === "button"), "onClick"); tree = h.render("Sel", props);
  const search = find(tree, node => node.type === "input" && node.props.role === "combobox");
  assert.equal(search.props["aria-label"], "Search Technician type"); assert.equal(search.props.maxLength, 200);
  uiInvoke(find(tree, node => node.props.role === "option" && node.props["aria-disabled"] === true), "onClick"); assert.equal(changes, 0);
  uiInvoke(search, "onChange", { target: { value: "x".repeat(250) } }); tree = h.render("Sel", props);
  assert.equal(String(find(tree, node => node.type === "input" && node.props.role === "combobox").props.value).length, 200);
  assert.match(uiText(tree), /No options found/);
});
test("forwarded selection ref focuses visible control for RHF errors", () => {
  const h = primitiveHarness("src/components/ui/Sel.tsx"); let focused = 0;
  const tree = h.render("Sel", { children: [option("a", "Alpha")] });
  const hidden = find(tree, node => node.type === "input" && node.props.type === "hidden");
  const input = { focus() {} }; (hidden.props.ref as { current: unknown }).current = input;
  (find(tree, node => node.type === "button").props.ref as { current: unknown }).current = { focus() { focused++; } };
  assert.equal(h.imperative[0](), input); input.focus(); assert.equal(focused, 1);
});

test("RHF-style reset/setValue through uncontrolled ref updates the visible option label", () => {
  const h = primitiveHarness("src/components/ui/Sel.tsx");
  const props = { name: "terms", defaultValue: "a", children: [option("a", "Net 30"), option("b", "Net 60")] };
  let tree = h.render("Sel", props);
  let stored = "a";
  const input = { get value() { return stored; }, set value(next: string) { stored = next; }, focus() {} };
  (find(tree, node => node.type === "input" && node.props.type === "hidden").props.ref as { current: unknown }).current = input;
  h.imperative[0](); input.value = "b";
  tree = h.render("Sel", props); assert.match(uiText(tree), /Net 60/); assert.equal(input.value, "b");
  // A new RHF ref callback on rerender must not wrap the setter repeatedly.
  h.imperative[0](); input.value = "a"; tree = h.render("Sel", props);
  assert.match(uiText(tree), /Net 30/);
});

test("Field keeps legacy required marker once and warns for zero/multiple associations", () => {
  const html = renderToStaticMarkup(createElement(Field, { label: "Reason *", required: true }, createElement(Input)));
  assert.equal((html.match(/\*/g) || []).length, 1);
  for (const count of [0, 1, 2]) {
    const warnings: string[] = [];
    const h = primitiveHarness("src/components/ui/Field.tsx", {
      console: { warn: (message: string) => warnings.push(message) },
      "./fieldContext": { FieldContext: { Provider: "provider" } },
    });
    const tree = h.render("Field", { label: "Synthetic", controlId: "control" });
    (find(tree, node => node.type === "div").props.ref as { current: unknown }).current = {
      querySelectorAll: () => Array.from({ length: count }, () => ({ id: "control" })),
    };
    h.effects.forEach(effect => effect());
    assert.equal(warnings.length, count === 1 ? 0 : 1);
    assert.ok(warnings.every(message => !message.includes("Synthetic")));
  }
});

test("actual Modal renders named native dialog and dispatches one preferred typed close callback", () => {
  const preferred: string[] = []; let legacy = 0;
  const host = { dataset: {}, isConnected: true, remove() {} };
  const runtime = { registerModal: () => () => undefined, isTopModal: () => true,
    isBackdropRelease: (started: boolean, ended: boolean) => started && ended };
  const h = primitiveHarness("src/components/ui/Modal.tsx", { "../../lib/forms/modalRuntime": runtime });
  const props = { title: "Synthetic modal", description: "Synthetic purpose", onRequestClose: (reason: string) => preferred.push(reason), onClose: () => legacy++ };
  let tree = h.render("Modal", props);
  uiInvoke(find(tree, node => node.props["data-modal-anchor"] === "true"), "ref", {
    ownerDocument: { createElement: () => host, body: { appendChild() {} } },
  });
  tree = h.render("Modal", props); h.effects.forEach(effect => effect());
  const dialog = find(tree, node => node.type === "dialog");
  assert.equal(dialog.props.role, "dialog"); assert.equal(dialog.props["aria-modal"], "true");
  assert.ok(dialog.props["aria-labelledby"]); assert.ok(dialog.props["aria-describedby"]);
  const close = find(tree, node => node.props.className === "modal-close");
  assert.equal(close.props.type, "button"); assert.equal(close.props["aria-label"], "Close dialog");
  uiInvoke(close, "onClick"); assert.deepEqual(preferred, ["close_button"]); assert.equal(legacy, 0);
  const element = { setAttribute() {}, removeAttribute() {} };
  (dialog.props.ref as { current: unknown }).current = element;
  uiInvoke(dialog, "onPointerDown", { target: {}, currentTarget: element });
  uiInvoke(dialog, "onPointerUp", { target: element, currentTarget: element }); assert.equal(preferred.length, 1);
  uiInvoke(dialog, "onPointerDown", { target: element, currentTarget: element });
  uiInvoke(dialog, "onPointerUp", { target: element, currentTarget: element }); assert.equal(preferred.at(-1), "backdrop");
  tree = h.render("Modal", { ...props, dismissDisabled: true }); h.effects.forEach(effect => effect());
  uiInvoke(find(tree, node => node.props.className === "modal-close"), "onClick"); assert.equal(preferred.length, 2);
});

test("legacy Modal close callback remains single and Escape/backdrop opt-outs are independent", () => {
  let closed = 0;
  const host = { dataset: {}, isConnected: true, remove() {} };
  const h = primitiveHarness("src/components/ui/Modal.tsx", { "../../lib/forms/modalRuntime": {
    registerModal: () => () => undefined, isTopModal: () => true,
    isBackdropRelease: (started: boolean, ended: boolean) => started && ended,
  } });
  const props = { title: "Legacy confirmation", onClose: () => closed++, closeOnEscape: false, closeOnBackdrop: false };
  let tree = h.render("Modal", props);
  uiInvoke(find(tree, node => node.props["data-modal-anchor"] === "true"), "ref", {
    ownerDocument: { createElement: () => host, body: { appendChild() {} } },
  });
  tree = h.render("Modal", props); h.effects.forEach(effect => effect());
  let dialog = find(tree, node => node.type === "dialog");
  const element = { setAttribute() {}, removeAttribute() {} };
  (dialog.props.ref as { current: unknown }).current = element;
  let prevented = 0;
  uiInvoke(dialog, "onCancel", { preventDefault() { prevented++; } });
  uiInvoke(dialog, "onPointerDown", { target: element, currentTarget: element });
  uiInvoke(dialog, "onPointerUp", { target: element, currentTarget: element });
  assert.equal(prevented, 1); assert.equal(closed, 0);
  uiInvoke(find(tree, node => node.props.className === "modal-close"), "onClick"); assert.equal(closed, 1);
  tree = h.render("Modal", { ...props, closeOnEscape: true }); h.effects.forEach(effect => effect());
  dialog = find(tree, node => node.type === "dialog");
  uiInvoke(dialog, "onCancel", { preventDefault() {} }); assert.equal(closed, 2);
});

test("Modal reserves Safari native cancel for an expanded owned picker", () => {
  const preferred: string[] = [];
  const host = { dataset: {}, isConnected: true, remove() {} };
  const h = primitiveHarness("src/components/ui/Modal.tsx", { "../../lib/forms/modalRuntime": {
    registerModal: () => () => undefined, isTopModal: () => true,
    isBackdropRelease: (started: boolean, ended: boolean) => started && ended,
  } });
  let tree = h.render("Modal", { title: "Picker owner", onRequestClose: (reason: string) => preferred.push(reason) });
  uiInvoke(find(tree, node => node.props["data-modal-anchor"] === "true"), "ref", {
    ownerDocument: { createElement: () => host, body: { appendChild() {} } },
  });
  tree = h.render("Modal", { title: "Picker owner", onRequestClose: (reason: string) => preferred.push(reason) });
  h.effects.forEach(effect => effect());
  const dialog = find(tree, node => node.type === "dialog");
  let pickerExpanded = true;
  const element = { setAttribute() {}, removeAttribute() {}, querySelector: () => pickerExpanded ? {} : null };
  (dialog.props.ref as { current: unknown }).current = element;
  uiInvoke(dialog, "onKeyDownCapture", { key: "Escape" });
  let prevented = 0;
  uiInvoke(dialog, "onCancel", { preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.deepEqual(preferred, []);
  pickerExpanded = false;
  uiInvoke(dialog, "onCancel", { preventDefault() { prevented++; } });
  assert.deepEqual(preferred, ["escape"]);
});

test("runtime blank Modal names get safe fallbacks and generic non-sensitive warnings", () => {
  const warnings: string[] = [];
  const host = { dataset: {}, isConnected: true, remove() {} };
  const h = primitiveHarness("src/components/ui/Modal.tsx", { console: { warn: (message: string) => warnings.push(message) },
    "../../lib/forms/modalRuntime": { registerModal: () => () => undefined, isTopModal: () => true } });
  let tree = h.render("Modal", { title: " ", closeLabel: "" });
  uiInvoke(find(tree, node => node.props["data-modal-anchor"] === "true"), "ref", {
    ownerDocument: { createElement: () => host, body: { appendChild() {} } },
  });
  tree = h.render("Modal", { title: " ", closeLabel: "" }); h.effects.forEach(effect => effect());
  assert.equal(uiText(find(tree, node => node.type === "h2")), "Dialog");
  assert.equal(find(tree, node => node.props.className === "modal-close").props["aria-label"], "Close dialog");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], "Modal requires a non-empty accessible title and close label.");
});

test("DirectorySelect forwarded form ref focuses visible trigger without changing selected value", () => {
  const h = primitiveHarness("src/features/directory/DirectorySelect.tsx", { "./queries": {
    useDirectoryPage: () => ({ items: [], search: "", setSearch() {}, waiting: false, position: { page: 1 } }),
    useDirectorySelection: () => ({ data: null, isSuccess: true }),
  } });
  let focused = 0;
  const tree = h.render("DirectorySelect", { domain: "assignable_contractors", value: "synthetic-selection" });
  const input = { value: "synthetic-selection", focus() {} };
  (find(tree, node => node.type === "input" && node.props.type === "hidden").props.ref as { current: unknown }).current = input;
  (find(tree, node => node.type === "button").props.ref as { current: unknown }).current = { focus() { focused++; } };
  assert.equal(h.imperative[0](), input); input.focus();
  assert.equal(focused, 1); assert.equal(input.value, "synthetic-selection");
});
