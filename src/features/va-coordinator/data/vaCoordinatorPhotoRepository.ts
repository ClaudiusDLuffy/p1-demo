import { loadPhotoBlob } from "../../photos/browserPhotoStorageAdapter";

/** Reuses the portal's validated private-photo transport; authorization remains in Storage RLS. */
export function loadVaCoordinatorPhoto(path: string): Promise<Blob> {
  return loadPhotoBlob(path);
}
