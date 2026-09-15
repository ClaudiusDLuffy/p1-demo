// Only the existing shell-owned action forms. This is a dirty-state adapter,
// not an authority, cache, or workflow state machine.
const fields: Readonly<Record<string, readonly string[]>> = {
  setEta: ["etaDateInput", "etaTimeInput"],
  editWO: ["editWoForm"],
  reassign: ["reassignTarget"],
  unassign: [],
  rejectUnassignedWO: ["rejectWorkOrderReason"],
  deleteWO: ["rejectWorkOrderReason"],
  reopen: ["reopenMode", "reopenReason"],
  startWork: ["startDateInput", "startTimeInput", "startNotesInput"],
  pauseWork: ["pauseDateInput", "pauseTimeInput", "pauseReasonInput", "partDescInput", "partNumInput", "partEtaInput", "pausePartsList", "pauseNotesInput"],
  closeComplete: ["closeDateInput", "closeTimeInput", "assetMakeInput", "assetModelInput", "assetSerialInput", "assetYearInput", "resolutionInput", "resolutionNotesInput"],
  duplicateForReassignment: [], closeWithoutInvoice: [], deleteActivity: [],
};

export function isShellActionForm(modal: string | null): boolean {
  return modal !== null && Object.hasOwn(fields, modal);
}

export function shellFormSnapshot(modal: string | null, state: Readonly<Record<string, unknown>>): string {
  return JSON.stringify((modal && fields[modal] || []).map(key => state[key] ?? null));
}

export function validatePauseWorkForm(
  reason: string,
  parts: readonly { description?: string }[],
): string | null {
  if (reason !== "Awaiting parts" && reason !== "Temporary fix") {
    return "Choose why work is being paused.";
  }
  if (reason === "Awaiting parts" && !parts.some(part => part.description?.trim())) {
    return "Add at least one part and enter its description before pausing.";
  }
  return null;
}
