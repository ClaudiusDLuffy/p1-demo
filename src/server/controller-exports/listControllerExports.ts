import { AppError } from "../../lib/errors/AppError";
import type { ControllerExportGetCommand } from "./contracts";
import type { ControllerExportContext } from "./controllerExportContext";
import type { ControllerExportHistoryRepository } from "./historyRepository";
import type { ControllerExportApplicationResult, ControllerExportDownload } from "./applicationResults";
import { CONTROLLER_EXPORT_CSV_HEADER, controllerExportHistoryCsvRows, mapControllerExportHistory } from "./historyMapper";

export interface ControllerExportListDependencies {
  eligibility: { queueSummary(): Promise<{ count: number; pendingCount: number; oldestPendingAt: string | null }> };
  history: ControllerExportHistoryRepository;
  downloads: { load(batchId: string): Promise<ControllerExportDownload> };
  now(): Date;
}
export async function listControllerExports(command: ControllerExportGetCommand, context: ControllerExportContext,
  dependencies: ControllerExportListDependencies): Promise<ControllerExportApplicationResult> {
  context.signal?.throwIfAborted();
  if (command.mode === "queue") return { kind: "queue", ...await dependencies.eligibility.queueSummary(),
    limit: 500, canHandoff: context.actor.canHandoff };
  if (command.mode === "download") {
    if (!context.actor.canHandoff) throw new AppError("FORBIDDEN");
    return { kind: "download", body: await dependencies.downloads.load(command.batchId) };
  }
  if (command.format === "json") return { kind: "history", body: mapControllerExportHistory(await dependencies.history.loadRecent(command.filter)) };
  const pages = dependencies.history.pages(command.filter)[Symbol.asyncIterator]();
  // Fail the request normally if the first database page cannot be read. Later pages remain backpressured.
  const first = await pages.next();
  async function* rows(): AsyncGenerator<string> {
    try {
      yield CONTROLLER_EXPORT_CSV_HEADER;
      let next = first;
      while (!next.done) {
        context.signal?.throwIfAborted();
        yield* controllerExportHistoryCsvRows(next.value);
        next = await pages.next();
      }
    } finally { await pages.return?.(); }
  }
  return { kind: "csv", rows: rows(), filename: `Contractor-Bill-Handoff-Audit-${dependencies.now().toISOString().slice(0, 10)}.csv` };
}
