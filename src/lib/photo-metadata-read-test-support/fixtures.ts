export const PHOTO_PARENT = "SYNTHETIC-PHOTO-PARENT-7C3-2";
export const PHOTO_UPLOADER = "a8500000-0000-4000-8000-000000000001";
export type PhotoRowFixture = {
  id: string;
  work_order_id: string;
  storage_path: string;
  uploader_id: string | null;
  uploader_name: string | null;
  caption: string | null;
  created_at: string | null;
};
export const photoId = (index = 1): string => `a8100000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export const photoPath = (index = 1): string => `wo/${PHOTO_PARENT}/a8400000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export function photoFixture(overrides: Partial<PhotoRowFixture> = {}, index = 1): PhotoRowFixture {
  return {
    id: photoId(index), work_order_id: PHOTO_PARENT, storage_path: photoPath(index),
    uploader_id: PHOTO_UPLOADER, uploader_name: "Synthetic uploader", caption: "Synthetic caption only",
    created_at: "2026-09-12T03:00:00.123456+00:00", ...overrides,
  };
}
/** Independently written expected public shape; production mapper is never used to generate expected output. */
export function expectedPhotoPage(paths: string[], nextCursor: string | null = null, totalCount: number | null = null,
  aggregates?: Record<string, number>) {
  return { items: paths, nextCursor, hasMore: nextCursor !== null, totalCount, aggregates };
}
