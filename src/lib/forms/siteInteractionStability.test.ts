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

test("invoice hydration stays clean and source preview uses the invoice dialog layer", () => {
  assert.match(billingEditor, /const shouldDirty = workOrderSelectionAuthored\.current/);
  assert.match(billingEditor, /setValue\("territory", territoryFromState\(storeState\), \{\s*shouldDirty,/);
  const drawer = billingEditor.indexOf("<SourceContractorInvoiceDrawer");
  assert.ok(drawer > billingEditor.indexOf("</form>"));
  assert.ok(drawer < billingEditor.lastIndexOf("</Modal>"));
});
