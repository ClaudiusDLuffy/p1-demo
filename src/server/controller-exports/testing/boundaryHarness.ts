import { resolve } from "node:path";
import type { ControllerExportApplicationService } from "../applicationService";
import type { ControllerExportApplicationResult } from "../applicationResults";
import type { ControllerExportContext } from "../controllerExportContext";
import type { ControllerExportGetCommand, ControllerExportStageCommand, ControllerExportTransitionCommand } from "../contracts";
import { controllerModuleHarness } from "./moduleHarness";
import { controllerAuthorizationPorts, controllerTestIds, type ControllerAuthorizationOptions } from "./authorizationPorts";

export type ControllerServiceCall =
  | { method: "list"; command: ControllerExportGetCommand; context: ControllerExportContext }
  | { method: "stage"; command: ControllerExportStageCommand; context: ControllerExportContext }
  | { method: "transition"; command: ControllerExportTransitionCommand; context: ControllerExportContext };
type ResultFactory = (call: ControllerServiceCall) => ControllerExportApplicationResult | Promise<ControllerExportApplicationResult>;

/** Independent application-service port: expected HTTP objects are written in
 * tests, never obtained by invoking the production HTTP mapper. */
export class ControllerServiceFake implements ControllerExportApplicationService {
  readonly calls: ControllerServiceCall[] = [];
  readonly constructed: ControllerExportContext[] = [];
  constructor(private readonly result?: ResultFactory) {}
  private async execute(call: ControllerServiceCall): Promise<ControllerExportApplicationResult> {
    this.calls.push(call);
    if (this.result) return this.result(call);
    if (call.method === "stage") return { kind: "staged", replayed: false, body: { batchId: controllerTestIds.batch,
      status: "pending", downloadUrl: "https://synthetic.invalid/private-download",
      filename: "Contractor-Bills-2026-09-12-81000000-000.zip", format: "reference_manifest_v2",
      archiveSha256: "a".repeat(64), archiveBytes: 42 } };
    if (call.method === "transition") return { kind: "transition", batch: call.command.action === "confirm"
      ? { applied: true, batchId: call.command.batchId, status: "confirmed", invoiceCount: 1, total: 120,
        confirmedAt: "2026-09-12T00:00:00.000Z", confirmedBy: controllerTestIds.actor }
      : { applied: true, batchId: call.command.batchId, status: "cancelled", reason: call.command.reason,
        cancelledAt: "2026-09-12T00:00:00.000Z", cancelledBy: controllerTestIds.actor } };
    if (call.command.mode === "download") return { kind: "download", body: { batchId: call.command.batchId,
      downloadUrl: "https://synthetic.invalid/private-download", filename: "Synthetic-archive.zip", format: "reference_manifest_v2" } };
    if (call.command.mode === "history") {
      if (call.command.format === "csv") return { kind: "csv", filename: "Synthetic-history.csv",
        rows: (async function* () { yield "\uFEFFBatch ID,Status\r\n"; yield `${controllerTestIds.batch},pending\r\n`; })() };
      return { kind: "history", body: { history: [], actors: [] } };
    }
    return { kind: "queue", count: 1, limit: 500, canHandoff: call.context.actor.canHandoff,
      pendingCount: 0, oldestPendingAt: null };
  }
  list(command: ControllerExportGetCommand, context: ControllerExportContext) { return this.execute({ method: "list", command, context }); }
  stage(command: ControllerExportStageCommand, context: ControllerExportContext) { return this.execute({ method: "stage", command, context }); }
  transition(command: ControllerExportTransitionCommand, context: ControllerExportContext) { return this.execute({ method: "transition", command, context }); }
}

export function controllerBoundaryHarness(options: {
  authorization?: ControllerAuthorizationOptions;
  result?: ResultFactory;
  loggingFailure?: boolean;
} = {}) {
  const ports = controllerAuthorizationPorts(options.authorization);
  const service = new ControllerServiceFake(options.result);
  const runtime = controllerModuleHarness({ loggingFailure: options.loggingFailure, modules: {
    ...ports.modules,
    [resolve("src/server/controller-exports/applicationService.ts")]: {
      createControllerExportService(context: ControllerExportContext) { service.constructed.push(context); return service; },
    },
  } });
  return { ...runtime, ports, service };
}
