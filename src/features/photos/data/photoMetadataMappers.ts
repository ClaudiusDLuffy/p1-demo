import type { CursorPage } from "../../../lib/cursorPagination";
import type { PhotoMetadataPage, PhotoMetadataRow } from "./photoMetadataContracts";

/** Preserve database order and exact path/cursor bytes, including reviewed legacy paths. */
export function mapPhotoMetadataPage(page: CursorPage<PhotoMetadataRow>): PhotoMetadataPage {
  return { ...page, items: page.items.map(row => row.storage_path) };
}
