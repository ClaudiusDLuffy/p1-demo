import type { CursorPage } from "../../../lib/cursorPagination";

/** Exact seven-field RPC row, before conversion to the compatible path page. */
export type PhotoMetadataRow = Readonly<{
  id: string;
  work_order_id: string;
  storage_path: string;
  uploader_id: string | null;
  uploader_name: string | null;
  caption: string | null;
  created_at: string | null;
}>;
export type PhotoMetadataPage = CursorPage<string>;
export type PhotoMetadataReadDependencies = Readonly<{
  read: (name: "list_work_order_photos_rows_v1", args: {
    p_work_order_id: string; p_limit: number; p_cursor: string | null;
  }, signal?: AbortSignal) => Promise<unknown>;
}>;
