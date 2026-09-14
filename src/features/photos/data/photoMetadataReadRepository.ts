import { boundedReadRpc } from "../../../lib/counts/readRpc";
import { clampPageSize } from "../../../lib/cursorPagination";
import type { PhotoMetadataPage, PhotoMetadataReadDependencies } from "./photoMetadataContracts";
import { parsePhotoMetadataPage } from "./photoMetadataValidators";
import { mapPhotoMetadataPage } from "./photoMetadataMappers";

/** One cancellable existing RPC; no Storage, counts, collector, or subscription ownership. */
export function createPhotoMetadataReadRepository(dependencies: PhotoMetadataReadDependencies = { read: boundedReadRpc }) {
  return {
    async loadWorkOrderPhotosPage(workOrderId: string, cursor: string | null = null, limit = 24,
      signal?: AbortSignal): Promise<PhotoMetadataPage> {
      if (!workOrderId) throw new Error("A work order ID is required");
      const data = await dependencies.read("list_work_order_photos_rows_v1", {
        p_work_order_id: workOrderId, p_limit: clampPageSize(limit), p_cursor: cursor,
      }, signal);
      return mapPhotoMetadataPage(parsePhotoMetadataPage(data, workOrderId));
    },
  };
}
const production = createPhotoMetadataReadRepository();
export function loadWorkOrderPhotosPage(workOrderId: string, cursor: string | null = null, limit = 24,
  signal?: AbortSignal): Promise<PhotoMetadataPage> {
  return production.loadWorkOrderPhotosPage(workOrderId, cursor, limit, signal);
}
