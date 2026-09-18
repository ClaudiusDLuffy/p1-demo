import assert from "node:assert/strict";
import test from "node:test";
import { isBackdropRelease, isTopModal, MAX_MODAL_DEPTH, registerModal, requestTopModalClose } from "./modalRuntime";

// Injected DOM contract, not a browser/assistive-technology certification.
// Casts are confined to this test adapter; runtime production uses native DOM.
class Element {
  ownerDocument: Owner;
  children: Element[] = [];
  parent: Element | null = null;
  attributes = new Map<string, string>();
  inert = false;
  isConnected = true;
  tabIndex = 0;
  hidden = false;
  disabled = false;
  open = false;
  showFails = false;
  closeFails = false;
  focusFails = false;
  opened = 0;
  closed = 0;
  textContent = "";
  style = { overflow: "auto" };
  classList = { contains: (value: string) => this.attributes.get("class")?.split(" ").includes(value) || false };
  constructor(owner: Owner, readonly tag = "div") { this.ownerDocument = owner; }
  append(child: Element) { this.children.push(child); child.parent = this; return child; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); if (name === "open") this.open = true; }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === "open") this.open = false; }
  contains(element: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
  closest(_selector: string): Element | null {
    return this.inert || this.hidden || this.attributes.get("aria-hidden") === "true" ? this : this.parent?.closest(_selector) || null;
  }
  matches(selector: string) {
    if (selector.includes(":disabled")) return this.disabled || this.attributes.get("aria-disabled") === "true" || this.attributes.get("type") === "hidden";
    if (selector.includes("data-destructive")) return this.attributes.get("data-destructive") === "true" || this.attributes.get("type") === "submit" || this.classList.contains("btn-danger");
    if (selector.includes("input, textarea")) return ["input", "textarea", "select"].includes(this.tag) || this.attributes.get("role") === "combobox";
    return false;
  }
  getClientRects(): object[] { return this.hidden || (this.tag === "dialog" && !this.open) ? [] : this.parent ? this.parent.getClientRects() : [{}]; }
  querySelectorAll() {
    const nodes: Element[] = [];
    const visit = (element: Element) => { for (const child of element.children) { if (["button", "input", "select", "textarea", "a"].includes(child.tag)) nodes.push(child); visit(child); } };
    visit(this); return nodes;
  }
  querySelector(selector: string) {
    if (selector.includes("aria-expanded")) return this.querySelectorAll().find(element =>
      element.attributes.get("aria-expanded") === "true" && element.attributes.has("aria-haspopup")) || null;
    const key = selector.includes("restore-focus") ? "data-modal-restore-focus" : "data-modal-initial-focus";
    return selector.includes("main") ? null : this.querySelectorAll().find(element => element.attributes.get(key) === "true") || null;
  }
  focus() { if (this.focusFails) throw new Error("Synthetic focus failure"); this.ownerDocument.activeElement = this; }
  showModal() { this.opened++; if (this.showFails) throw new Error("Unsupported native dialog"); this.open = true; }
  close() { this.closed++; if (this.closeFails) throw new Error("Cleanup failed"); this.open = false; }
}
class Owner {
  body = new Element(this);
  activeElement: Element | null = null;
  defaultView = { HTMLElement: Element };
  listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(name: string, callback: (event: never) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)?.add(callback);
  }
  removeEventListener(name: string, callback: (event: never) => void) { this.listeners.get(name)?.delete(callback); }
  emit(name: string, event: unknown) { this.listeners.get(name)?.forEach(callback => callback(event as never)); }
}
const documentOf = (owner: Owner) => owner as unknown as Document;
const elementOf = (element: Element | null) => element as unknown as HTMLElement | null;
function setup(owner = new Owner()) {
  const host = owner.body.append(new Element(owner));
  const dialog = host.append(new Element(owner, "dialog")); dialog.tabIndex = -1;
  const close = dialog.append(new Element(owner, "button")); close.textContent = "x"; close.setAttribute("class", "modal-close");
  const destructive = dialog.append(new Element(owner, "button")); destructive.textContent = "Delete invoice";
  const input = dialog.append(new Element(owner, "input"));
  const cancel = dialog.append(new Element(owner, "button")); cancel.textContent = "Cancel";
  const requests: string[] = [];
  const register = (initial: Element | null = null, restore: Element | null = null) => registerModal({
    dialog: dialog as unknown as HTMLDialogElement, host: elementOf(host)!, requestClose: reason => requests.push(reason),
    initialFocus: () => elementOf(initial), restoreFocus: () => elementOf(restore),
  });
  return { owner, host, dialog, close, destructive, input, cancel, requests, register };
}
const key = (value: string, shiftKey = false) => ({ key: value, shiftKey, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; } });

test("one modal names stack owner, locks/restores scroll/inert and enters safe input", () => {
  const h = setup(); const background = h.owner.body.append(new Element(h.owner));
  background.setAttribute("aria-hidden", "false");
  const cleanup = h.register();
  assert.equal(h.owner.activeElement, h.input); assert.equal(h.owner.body.style.overflow, "hidden");
  assert.equal(background.inert, true); assert.equal(background.getAttribute("aria-hidden"), "true");
  assert.equal(h.dialog.opened, 1); assert.equal(isTopModal(h.dialog as unknown as HTMLDialogElement), true);
  cleanup(); cleanup();
  assert.equal(background.inert, false); assert.equal(background.getAttribute("aria-hidden"), "false");
  assert.equal(h.owner.body.style.overflow, "auto"); assert.equal(h.dialog.closed, 1);
  assert.equal(h.owner.listeners.get("keydown")?.size, 0);
});
test("safe focus priority is explicit, marked, interactive, then container; destructive default excluded", () => {
  const explicit = setup(); const remove = explicit.register(explicit.cancel); assert.equal(explicit.owner.activeElement, explicit.cancel); remove();
  const marked = setup(); marked.cancel.setAttribute("data-modal-initial-focus", "true");
  const removeMarked = marked.register(); assert.equal(marked.owner.activeElement, marked.cancel); removeMarked();
  const empty = setup(); empty.dialog.children = [empty.destructive]; empty.destructive.tabIndex = 0;
  const removeEmpty = empty.register(); assert.equal(empty.owner.activeElement, empty.dialog); removeEmpty();
});
test("hidden/disabled/inert initial targets are skipped", () => {
  for (const setting of ["hidden", "disabled", "inert"] as const) {
    const h = setup(); h.cancel[setting] = true; const remove = h.register(h.cancel);
    assert.equal(h.owner.activeElement, h.input); remove();
  }
});
test("Tab and Shift Tab wrap within current top modal, including empty dialogs", () => {
  const h = setup(); const remove = h.register();
  h.cancel.focus(); const forward = key("Tab"); h.owner.emit("keydown", forward);
  assert.equal(forward.defaultPrevented, true); assert.equal(h.owner.activeElement, h.close);
  const backward = key("Tab", true); h.owner.emit("keydown", backward);
  assert.equal(backward.defaultPrevented, true); assert.equal(h.owner.activeElement, h.cancel);
  h.dialog.children = []; const empty = key("Tab"); h.owner.emit("keydown", empty);
  assert.equal(empty.defaultPrevented, true); assert.equal(h.owner.activeElement, h.dialog); remove();
});
test("nested dialogs use one listener pair and only topmost receives Escape/navigation", () => {
  const first = setup(); const removeFirst = first.register(); const second = setup(first.owner); const removeSecond = second.register();
  assert.equal(first.owner.listeners.get("keydown")?.size, 1); assert.equal(first.host.inert, true);
  first.owner.emit("keydown", key("Escape")); assert.deepEqual(first.requests, []); assert.deepEqual(second.requests, ["escape"]);
  assert.equal(requestTopModalClose("navigation", documentOf(first.owner)), true);
  assert.deepEqual(second.requests, ["escape", "navigation"]);
  removeSecond(); assert.equal(first.host.inert, false); assert.equal(first.owner.activeElement, first.input);
  removeFirst(); assert.equal(requestTopModalClose("navigation", documentOf(first.owner)), false);
});
test("Escape consumed by nested selection does not dismiss modal", () => {
  const h = setup(); const remove = h.register(); const event = key("Escape"); event.preventDefault();
  h.owner.emit("keydown", event); assert.deepEqual(h.requests, []); remove();
});
test("expanded modal-owned picker receives Escape before the document modal listener", () => {
  const h = setup(); const picker = h.dialog.append(new Element(h.owner, "button"));
  picker.setAttribute("aria-haspopup", "listbox"); picker.setAttribute("aria-expanded", "true");
  const remove = h.register(); const first = key("Escape");
  h.owner.emit("keydown", first); assert.deepEqual(h.requests, []); assert.equal(first.defaultPrevented, true);
  picker.setAttribute("aria-expanded", "false"); const second = key("Escape");
  h.owner.emit("keydown", second); assert.deepEqual(h.requests, ["escape"]); assert.equal(second.defaultPrevented, true);
  remove();
});
test("focus outside top modal is recovered and disconnected restore falls back to parent", () => {
  const h = setup(); const trigger = h.owner.body.append(new Element(h.owner, "button")); trigger.focus();
  const remove = h.register(); h.owner.emit("focusin", { target: trigger }); assert.equal(h.owner.activeElement, h.input);
  remove(); assert.equal(h.owner.activeElement, trigger);
  const parent = setup(); const removeParent = parent.register(); const child = setup(parent.owner); const removeChild = child.register(null, trigger);
  trigger.isConnected = false; removeChild(); assert.equal(parent.owner.activeElement, parent.input); removeParent();
});
test("Strict Mode mount/cleanup/remount and cleanup failure leave no permanent inert/listeners", () => {
  const h = setup(); const background = h.owner.body.append(new Element(h.owner));
  background.inert = true;
  const first = h.register(); first(); const second = h.register(); h.dialog.closeFails = true; second();
  assert.equal(h.dialog.opened, 2); assert.equal(h.dialog.open, false); assert.equal(background.inert, true);
  assert.equal(h.owner.listeners.get("keydown")?.size, 0); assert.equal(h.owner.body.style.overflow, "auto");
});
test("unsupported native showModal uses same guarded focus/stack cleanup fallback", () => {
  const h = setup(); h.dialog.showFails = true; const remove = h.register();
  assert.equal(h.dialog.open, true); assert.equal(h.owner.activeElement, h.input); remove(); assert.equal(h.dialog.open, false);
});
test("stack bound rejects excess and still cleans every prior resource", () => {
  const owner = new Owner(); const cleanups: (() => void)[] = [];
  for (let index = 0; index < MAX_MODAL_DEPTH; index++) cleanups.push(setup(owner).register());
  assert.throws(() => setup(owner).register(), /nesting limit/);
  cleanups.reverse().forEach(remove => remove()); assert.equal(owner.listeners.get("keydown")?.size, 0);
});
test("pointer-down inside or pointer-up inside cannot dismiss backdrop", () => {
  assert.equal(isBackdropRelease(false, true), false); assert.equal(isBackdropRelease(true, false), false);
  assert.equal(isBackdropRelease(false, false), false); assert.equal(isBackdropRelease(true, true), true);
});
test("SSR navigation registry has no browser global dependency", () => assert.equal(requestTopModalClose("navigation"), false));

test("invalid explicit restoration falls back to valid previous focus, then safe app, then body", () => {
  const first = setup(); const previous = first.owner.body.append(new Element(first.owner, "button")); previous.focus();
  const invalid = first.owner.body.append(new Element(first.owner, "button")); invalid.disabled = true;
  first.register(null, invalid)(); assert.equal(first.owner.activeElement, previous);
  const second = setup(); const detached = second.owner.body.append(new Element(second.owner, "button")); detached.focus();
  const fallback = second.owner.body.append(new Element(second.owner, "button"));
  const cleanup = second.register(); detached.isConnected = false; cleanup(); assert.equal(second.owner.activeElement, fallback);
  const empty = setup(); const remove = empty.register(); remove();
  assert.equal(empty.owner.activeElement, empty.owner.body); assert.equal(empty.owner.body.getAttribute("tabindex"), null);
});

test("throwing initial/restore focus cannot strand modal resources", () => {
  const h = setup(); h.input.focusFails = true;
  const restore = h.owner.body.append(new Element(h.owner, "button")); restore.focusFails = true;
  const cleanup = h.register(null, restore);
  assert.equal(h.owner.activeElement, h.dialog);
  assert.doesNotThrow(cleanup);
  assert.equal(h.owner.listeners.get("keydown")?.size, 0); assert.equal(h.owner.listeners.get("focusin")?.size, 0);
  assert.equal(h.owner.body.style.overflow, "auto"); assert.equal(requestTopModalClose("navigation", documentOf(h.owner)), false);
});

test("individual inert/style restoration failure is retried once and cannot abort remaining cleanup", () => {
  const h = setup(); const first = h.owner.body.append(new Element(h.owner)); const other = h.owner.body.append(new Element(h.owner));
  let inert = false, failInert = true, overflow = "auto", failStyle = true;
  Object.defineProperty(first, "inert", { get: () => inert, set: (next: boolean) => {
    if (!next && failInert) { failInert = false; throw new Error("Synthetic inert cleanup failure"); } inert = next;
  } });
  Object.defineProperty(h.owner.body.style, "overflow", { get: () => overflow, set: (next: string) => {
    if (next === "auto" && failStyle) { failStyle = false; throw new Error("Synthetic style cleanup failure"); } overflow = next;
  } });
  const cleanup = h.register(); assert.doesNotThrow(cleanup);
  assert.equal(first.inert, false); assert.equal(other.inert, false); assert.equal(overflow, "auto");
  assert.equal(h.owner.listeners.get("keydown")?.size, 0); assert.equal(requestTopModalClose("navigation", documentOf(h.owner)), false);
});
