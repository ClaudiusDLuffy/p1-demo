import "server-only";
import { AppError } from "../../lib/errors/AppError";
import type { ControllerExportHistoryRepository } from "./historyRepository";
import type { ControllerExportStorage } from "./exportStorage";
import type { ControllerExportDownload } from "./applicationResults";
import { archiveFilename } from "./snapshot";

export interface ControllerExportSignedDownloadService { load(batchId: string): Promise<ControllerExportDownload> }
export function createSignedDownloadService(history: ControllerExportHistoryRepository,
  storage: ControllerExportStorage): ControllerExportSignedDownloadService {
  return { async load(batchId) {
    const binding = await history.loadDownload(batchId);
    if (!binding) throw new AppError("NOT_FOUND");
    if (binding.status === "cancelled") throw new AppError("CONFLICT");
    const filename = archiveFilename(binding.batchId, binding.format, binding.createdAt);
    const result = await storage.sign(binding, filename);
    if (result.status !== "confirmed") throw new AppError("INTERNAL_ERROR");
    return { batchId: binding.batchId, downloadUrl: result.url, filename, format: binding.format };
  } };
}
