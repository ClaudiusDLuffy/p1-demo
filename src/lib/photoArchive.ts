import { createZipArchive, type ZipArchiveEntry } from "./zipArchive";

export const PHOTO_ARCHIVE_MAX_BYTES = 95 * 1024 * 1024;

export type PhotoArchiveProgress = {
  completed: number;
  total: number;
};

export type PhotoArchiveResult = {
  archive: Uint8Array;
  downloadedCount: number;
  skippedCount: number;
};

type PhotoBlob = Pick<Blob, "arrayBuffer" | "size" | "type">;

const MIME_EXTENSION: Record<string, string> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

const PHOTO_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jfif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

const extensionForPhoto = (path: string, mimeType: string): string => {
  const fromPath = String(path || "")
    .split(/[?#]/, 1)[0]
    .match(/\.([a-z0-9]{2,10})$/i)?.[1]
    ?.toLowerCase();
  if (fromPath && PHOTO_EXTENSIONS.has(fromPath)) {
    if (fromPath === "jpeg" || fromPath === "jfif") return "jpg";
    if (fromPath === "tif") return "tiff";
    return fromPath;
  }
  return MIME_EXTENSION[String(mimeType || "").toLowerCase()] || "jpg";
};

const filenameToken = (value: string, fallback: string): string => {
  const token = String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
};

export function photoArchiveFilename(workOrderId: string): string {
  return `${filenameToken(workOrderId, "work-order")}-photos.zip`;
}

export async function buildPhotoArchive(
  rawPaths: readonly string[],
  loadBlob: (path: string) => Promise<PhotoBlob>,
  onProgress?: (progress: PhotoArchiveProgress) => void,
): Promise<PhotoArchiveResult> {
  const paths = [...new Set(rawPaths.filter(Boolean))];
  if (paths.length === 0) throw new Error("Select at least one photo to download");

  const entries: ZipArchiveEntry[] = [];
  let skippedCount = 0;
  let sourceBytes = 0;
  const digits = Math.max(2, String(paths.length).length);

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    try {
      const blob = await loadBlob(path);
      if (sourceBytes + blob.size > PHOTO_ARCHIVE_MAX_BYTES) {
        throw new Error(
          "The selected photos exceed the 95 MB safe archive limit. Select fewer photos and try again.",
        );
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      sourceBytes += bytes.byteLength;
      entries.push({
        name: `photo-${String(index + 1).padStart(digits, "0")}.${extensionForPhoto(path, blob.type)}`,
        data: bytes,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("safe archive limit")) {
        throw error;
      }
      skippedCount += 1;
    }
    onProgress?.({ completed: index + 1, total: paths.length });
  }

  if (entries.length === 0) {
    throw new Error("None of the selected photos could be downloaded");
  }

  const archive = createZipArchive(entries);
  if (archive.byteLength > PHOTO_ARCHIVE_MAX_BYTES) {
    throw new Error(
      "The selected photos exceed the 95 MB safe archive limit. Select fewer photos and try again.",
    );
  }

  return {
    archive,
    downloadedCount: entries.length,
    skippedCount,
  };
}
