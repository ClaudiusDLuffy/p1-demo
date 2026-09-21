import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isShellActionForm, shellFormSnapshot, validatePauseWorkForm } from "./portalFormDismissal";

test("every authored shell action value participates in the dirty snapshot", () => {
  const cases: Readonly<Record<string, readonly string[]>> = {
    setEta: ["etaDateInput", "etaTimeInput"],
    editWO: ["editWoForm"],
    reassign: ["reassignTarget"],
    rejectUnassignedWO: ["rejectWorkOrderReason"],
    deleteWO: ["rejectWorkOrderReason"],
    reopen: ["reopenMode", "reopenReason"],
    startWork: ["startDateInput", "startTimeInput", "startNotesInput"],
    pauseWork: ["pauseDateInput", "pauseTimeInput", "pauseReasonInput", "partDescInput", "partNumInput", "partEtaInput", "pausePartsList", "pauseNotesInput"],
    closeComplete: ["closeDateInput", "closeTimeInput", "assetMakeInput", "assetModelInput", "assetSerialInput", "assetYearInput", "resolutionInput", "resolutionNotesInput"],
  };
  for (const [modal, names] of Object.entries(cases)) {
    assert.equal(isShellActionForm(modal), true, modal);
    for (const name of names) {
      assert.notEqual(shellFormSnapshot(modal, {}), shellFormSnapshot(modal, { [name]: "synthetic edit" }), `${modal}.${name}`);
    }
  }
});

test("unadded part text and nested part/edit changes are not mistaken for a clean form", () => {
  assert.notEqual(shellFormSnapshot("pauseWork", { pausePartsList: [] }),
    shellFormSnapshot("pauseWork", { pausePartsList: [], partDescInput: "Synthetic part" }));
  assert.notEqual(shellFormSnapshot("pauseWork", { pausePartsList: [{ desc: "A", qty: 1 }] }),
    shellFormSnapshot("pauseWork", { pausePartsList: [{ desc: "A", qty: 2 }] }));
  assert.notEqual(shellFormSnapshot("editWO", { editWoForm: { summary: "A" } }),
    shellFormSnapshot("editWO", { editWoForm: { summary: "B" } }));
});

test("unrelated query/selection refreshes do not make authored values dirty", () => {
  const authored = { startDateInput: "2026-09-11", startTimeInput: "09:00", startNotesInput: "Synthetic note" };
  assert.equal(shellFormSnapshot("startWork", authored), shellFormSnapshot("startWork", {
    ...authored, updatedAt: "2026-09-11T01:30:00Z", selectedInvoice: "synthetic-invoice", count: 11,
  }));
  for (const modal of ["unassign", "duplicateForReassignment", "closeWithoutInvoice", "deleteActivity"]) {
    assert.equal(isShellActionForm(modal), true);
    assert.equal(shellFormSnapshot(modal, { unrelated: "changed" }), "[]");
  }
  for (const modal of [null, "", "createInvoice", "not_a_form"]) assert.equal(isShellActionForm(modal), false);
});

test("shell wiring freezes initialization per actor/form/record, not a Realtime row version", () => {
  const source = readFileSync("src/components/PortalShell.tsx", "utf8");
  const scope = source.match(/const shellScope = ([^;]+);/)?.[1];
  assert.ok(scope);
  assert.match(scope, /currentUser\?\.id/);
  assert.match(scope, /modal/);
  assert.match(scope, /woData\?\.id/);
  assert.doesNotMatch(scope, /updatedAt|workflowCycle|contractorAssignmentVersion/);
  const initializer = source.slice(source.indexOf("if (shellFormSession.current === shellScope) return;"),
    source.indexOf("}, [modal, woData, shellScope, shellFormState]);"));
  assert.match(initializer, /shellFormSession\.current = shellScope/);
  assert.match(initializer, /shellFormBaseline\.current = shellFormSnapshot\(modal, initial\)/);
  assert.match(source, /scopeKey: shellScope/);
});

test("browser Back asks the topmost dialog before restoring portal navigation", () => {
  const source = readFileSync("src/components/PortalShell.tsx", "utf8");
  const start = source.indexOf('requestTopModalClose("navigation")');
  assert.ok(start > 0);
  const navigation = source.slice(start, source.indexOf("const restored = portalViewFromHistoryState(event.state);", start));
  assert.match(navigation, /writePortalHistoryStateSafely\(window\.history, "pushState"/);
  assert.match(navigation, /return;/);
  assert.doesNotMatch(navigation, /setModal\(null\)/);
});

test("the unsaved-changes discard action has a complete destructive button treatment", () => {
  const shell = readFileSync("src/components/PortalShell.tsx", "utf8");
  const dialog = readFileSync("src/components/ui/DiscardChangesDialog.tsx", "utf8");
  assert.match(dialog, /className="btn-danger" data-destructive="true"/);
  assert.match(shell, /\.btn-danger \{[^}]*min-height: 44px[^}]*background: \$\{T\.danger\}[^}]*border: 1px solid \$\{T\.danger\}/);
  assert.match(shell, /\.btn-danger:hover:not\(:disabled\)/);
  assert.match(shell, /\.btn-danger:disabled/);
});

test("follow-up dismissal preserves its reason while submission uses the captured optimistic version", () => {
  const source = readFileSync("src/components/PortalShell.tsx", "utf8");
  const start = source.indexOf("<CloseReopenedFollowUpModal");
  const integration = source.slice(start, source.indexOf("/>", start));
  assert.match(integration, /key=\{`\$\{currentUser\.id\}:\$\{followUpCloseSnapshot\.id\}`\}/);
  assert.doesNotMatch(integration, /woData\.updatedAt|key=.*updatedAt/);
  for (const field of ["id", "workflowCycle", "contractorAssignmentVersion", "updatedAt"]) {
    assert.match(integration, new RegExp(`followUpCloseSnapshot\\.${field}`));
  }
});

test("invoice number suggestion is fenced by identity plus a monotonically increasing open generation", () => {
  const source = readFileSync("src/features/invoices/InvoiceCreateModal.tsx", "utf8");
  assert.match(source, /const hydrationGeneration = \+\+hydrationGenerationRef\.current/);
  assert.match(source, /hydratedFormSessionRef\.current !== formSession \|\| hydrationGenerationRef\.current !== hydrationGeneration/);
  assert.ok((source.match(/hydrationGenerationRef\.current \+= 1/g) || []).length >= 2, "Cleanup and accepted close retire the prior generation");
  assert.match(source, /setValue\("num", suggested, \{ shouldDirty: false \}\)/);
});

test("failed ETA/start/pause commands do not close the authored shell form", () => {
  const source = readFileSync("src/components/PortalShell.tsx", "utf8");
  for (const result of ["saved", "started", "paused"]) assert.match(source, new RegExp(`if \\(${result}\\) setModal\\(null\\)`));
});

test("a rejected start is visible inside the native dialog and remains retryable", () => {
  const source = readFileSync("src/components/PortalShell.tsx", "utf8");
  const start = source.indexOf('{modal === "startWork"');
  const modal = source.slice(start, source.indexOf('{modal === "pauseWork"', start));
  assert.match(source, /const \[startWorkError, setStartWorkError\] = useState\(""\)/);
  assert.match(modal, /role="alert" aria-live="assertive"/);
  assert.match(modal, /doStartWork\(woData\.id, startNotesInput, setStartWorkError\)/);
  assert.match(modal, /else setStartWorkError/);
  assert.match(modal, /catch \{/);
});

test("pause requires a reason and a described part only when awaiting parts", () => {
  assert.equal(validatePauseWorkForm("", []), "Choose why work is being paused.");
  assert.equal(validatePauseWorkForm("Awaiting parts", []), "Add at least one part and enter its description before pausing.");
  assert.equal(validatePauseWorkForm("Awaiting parts", [{ description: "  " }]), "Add at least one part and enter its description before pausing.");
  assert.equal(validatePauseWorkForm("Awaiting parts", [{ description: "Evaporator coil" }]), null);
  assert.equal(validatePauseWorkForm("Temporary fix", []), null);
  assert.equal(validatePauseWorkForm("Capital review", []), null);
});

test("a rejected pause is visible inside the native dialog and remains retryable", () => {
  const source = readFileSync("src/components/PortalShell.tsx", "utf8");
  const start = source.indexOf('{modal === "pauseWork"');
  const modal = source.slice(start, source.indexOf('{modal === "closeComplete"', start));
  assert.match(source, /const \[pauseWorkError, setPauseWorkError\] = useState\(""\)/);
  assert.match(modal, /validatePauseWorkForm\(effectiveReason, pausePartsList\)/);
  assert.match(modal, /role="alert" aria-live="assertive"/);
  assert.match(modal, /setPauseWorkError\)/);
  assert.match(modal, /else setPauseWorkError/);
  assert.match(modal, /catch \{/);
});
