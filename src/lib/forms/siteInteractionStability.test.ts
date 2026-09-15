import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");
const select = read("src/components/ui/Sel.tsx");
const dateTimePicker = read("src/components/ui/DateTimePicker.tsx");
const directorySelect = read("src/features/directory/DirectorySelect.tsx");
const portalShell = read("src/components/PortalShell.tsx");
const billingEditor = read("src/features/billing/BillingInvoiceCreateModal.tsx");

test("shared dropdowns reveal choices without scrolling a page or modal ancestor", () => {
  for (const source of [select, dateTimePicker, directorySelect]) {
    assert.doesNotMatch(source, /\.scrollIntoView\(/);
    assert.match(source, /scrollWithinContainer/);
    assert.match(source, /preventScroll: true/);
  }
  assert.match(select, /useModalPortalHost\(\)/);
  assert.match(select, /createPortal\(/);
  assert.match(select, /position: "fixed"/);
  assert.match(select, /portalHost \|\| document\.body/);
  assert.match(select, /window\.addEventListener\("scroll", updatePosition, true\)/);
  assert.match(select, /!listRef\.current\?\.contains\(target\)/);
  assert.doesNotMatch(select, /top: "calc\(100% \+ 6px\)"/);
});

test("closed mobile navigation is absent and an open drawer isolates background controls", () => {
  assert.match(portalShell, /\{drawerOpen && <>/);
  assert.match(portalShell, /role="dialog"/);
  assert.match(portalShell, /aria-modal="true"/);
  assert.match(portalShell, /className="desktop-sidebar" inert=\{drawerOpen \? true : undefined\}/);
  assert.match(portalShell, /className="main-wrap" inert=\{drawerOpen \? true : undefined\}/);
  assert.doesNotMatch(portalShell, /pointerEvents: drawerOpen \? "all" : "none"/);
});

test("invoice draft validation exposes and selects the first visible invalid field", () => {
  assert.match(billingEditor, /shouldFocusError: false/);
  assert.match(billingEditor, /submitValidInvoice\("draft"\)/);
  assert.match(billingEditor, /handleSubmit\(data => \{/);
  assert.match(billingEditor, /}, handleInvalid\)/);
  assert.match(billingEditor, /data-validation-control="territory"/);
  assert.match(billingEditor, /Invoice was not saved\./);
  assert.match(billingEditor, /closest<HTMLElement>\("\.modal-inner"\)/);
  assert.doesNotMatch(
    billingEditor,
    /aria-label="Custom invoice territory"[\s\S]{0,180}\bautoFocus\b/,
  );
});

test("invoice save failures remain visible inside the billing dialog", () => {
  assert.match(billingEditor, /const \[actionError, setActionError\] = useState\(""\)/);
  assert.match(billingEditor, /setActionError\(`\$\{state === "draft" \? "Draft" : "Invoice"\} was not saved\./);
  assert.match(billingEditor, /\{actionError && \(/);
  assert.match(billingEditor, /<div role="alert"[\s\S]*\{actionError\}/);
});

test("billing line type choices explicitly update controlled form state", () => {
  assert.match(billingEditor, /const nextType = normalizeStaffBillingLineType\(event\.target\.value\);/);
  assert.match(billingEditor, /setValue\(`lines\.\$\{i\}\.type` as const, nextType, \{[\s\S]*?shouldDirty: true,[\s\S]*?shouldTouch: true,[\s\S]*?shouldValidate: true,/);
});

test("invoice hydration stays clean and source preview uses the invoice dialog layer", () => {
  assert.match(billingEditor, /const shouldDirty = workOrderSelectionAuthored\.current/);
  assert.match(billingEditor, /setValue\("territory", territoryFromState\(storeState\), \{\s*shouldDirty,/);
  const drawer = billingEditor.indexOf("<SourceContractorInvoiceDrawer");
  assert.ok(drawer > billingEditor.indexOf("</form>"));
  assert.ok(drawer < billingEditor.lastIndexOf("</Modal>"));
});
