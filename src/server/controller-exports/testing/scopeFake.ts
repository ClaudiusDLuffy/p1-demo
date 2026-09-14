import { resolve } from "node:path";
import type { ControllerExportScope } from "../createControllerExportScope";
import type { ControllerExportStageDependencies } from "../stageControllerExport";
import type { ControllerExportInvoiceFacts } from "../eligibilityRepository";
import type { ControllerExportContext } from "../controllerExportContext";
import type { StageCommand } from "../stageCommandRepository";
import { controllerModuleHarness } from "./moduleHarness";
import { controllerAuthorizationPorts, controllerTestIds as ids, type ControllerAuthorizationOptions } from "./authorizationPorts";

export const controllerInvoiceFacts = (id = ids.invoice): ControllerExportInvoiceFacts => ({
  id, num: "INV-700001", workOrderId: "WOT900001-2", contractorId: ids.otherActor,
  storeNumber: "42", storeAddress: "Synthetic Store", invoiceDate: "2026-09-12", serviceDate: "2026-09-11",
  dueDate: "2026-10-12", terms: "Net 30", cme: null, subtotal: 100, salesTax: 20, total: 120,
  pdfStoragePath: null, updatedAt: "2026-09-12T00:00:00.000Z",
});

/** Focused repository/adapter ports, not synthetic route or application behavior. */
export function controllerScopeFake(overrides: {
  stage?: Partial<ControllerExportStageDependencies>;
  list?: Partial<ControllerExportScope["list"]>;
  transition?: Partial<ControllerExportScope["transition"]>;
} = {}) {
  const calls: string[] = [];
  const commands: StageCommand[] = [];
  const eligibility = {
    async loadSelected(selected: readonly string[]) { calls.push("eligibility:selected"); return selected.map(controllerInvoiceFacts); },
    async loadAutomatic() { calls.push("eligibility:automatic"); return [controllerInvoiceFacts()]; },
    async queueSummary() { calls.push("eligibility:queue"); return { count: 1, pendingCount: 0, oldestPendingAt: null }; },
  };
  const scope: ControllerExportScope = {
    list: { eligibility,
      history: {
        async loadRecent() { calls.push("history:recent"); return { batches: [], items: [], profiles: [] }; },
        async *pages() { calls.push("history:pages"); yield { batches: [], items: [], profiles: [] }; },
        async loadDownload() { calls.push("history:download"); return null; },
      },
      downloads: { async load(batchId) { calls.push("download:sign"); return { batchId, downloadUrl: "https://synthetic.invalid/private-download", filename: "Synthetic.zip", format: "reference_manifest_v2" }; } },
      now: () => new Date("2026-09-12T00:00:00.000Z"), ...overrides.list },
    stage: { eligibility,
      packages: {
        async prepare(invoices) { calls.push("package:prepare"); return { invoices,
          sources: invoices.map(invoice => ({ invoiceId: invoice.id, updatedAt: invoice.updatedAt })) }; },
        async build() { calls.push("archive:build"); return { bytes: new Uint8Array([80, 75, 3, 4]), byteLength: 4, sha256: "a".repeat(64) }; },
      },
      storage: {
        async upload() { calls.push("storage:upload"); return { status: "confirmed", ownership: "exact_attempt_object" }; },
        async reconcileUpload() { calls.push("storage:reconcile"); return { status: "unknown", ownership: "unverified" }; },
        async cleanup() { calls.push("storage:cleanup"); return { status: "confirmed" }; },
        async sign() { calls.push("storage:sign"); return { status: "confirmed", url: "https://synthetic.invalid/private-download" }; },
      },
      commands: { async execute(command) { calls.push("command:stage"); commands.push(command); return { status: "committed", receipt: {
        batchId: command.batchId, status: "pending", invoiceCount: command.sources.length, total: 120, objectPath: command.objectPath,
        archiveSha256: command.archiveSha256, archiveBytes: command.archiveBytes, archiveFormat: "reference_manifest_v2" } }; } },
      reconciliation: { async resolve(_command, result) { calls.push("command:reconcile"); return result; } },
      createAttempt() { calls.push("attempt:create"); return { batchId: ids.batch, objectPath: `2026-09-12/${ids.batch}.zip`, filename: "Synthetic.zip" }; },
      ...overrides.stage },
    transition: { commands: { async execute(command) { calls.push(`command:${command.action}`); return { status: "committed", receipt: command.action === "confirm"
      ? { applied: true, batchId: command.batchId, status: "confirmed", invoiceCount: 1, total: 120, confirmedAt: "2026-09-12T00:00:00.000Z", confirmedBy: ids.actor }
      : { applied: true, batchId: command.batchId, status: "cancelled", cancelledAt: "2026-09-12T00:00:00.000Z", cancelledBy: ids.actor, reason: command.reason } }; } },
      reconciliation: { async resolve(_command, result) { calls.push("transition:reconcile"); return result; } }, ...overrides.transition },
  };
  return { scope, calls, commands };
}

/** Actual route → boundary → applicationService → typed use case, with only
 * request-scoped I/O capabilities replaced. No legacy or public-mapper fake. */
export function controllerGraphHarness(options: {
  authorization?: ControllerAuthorizationOptions;
  scope?: ReturnType<typeof controllerScopeFake>;
  loggingFailure?: boolean;
} = {}) {
  const ports = controllerAuthorizationPorts(options.authorization);
  const fake = options.scope ?? controllerScopeFake();
  const contexts: ControllerExportContext[] = [];
  const runtime = controllerModuleHarness({ loggingFailure: options.loggingFailure, modules: {
    ...ports.modules,
    [resolve("src/server/controller-exports/createControllerExportScope.ts")]: {
      createControllerExportScope(context: ControllerExportContext) { contexts.push(context); return fake.scope; },
    },
  } });
  return { ...runtime, ports, ...fake, contexts };
}
