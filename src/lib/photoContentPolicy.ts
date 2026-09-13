// Browser-safe guidance and early signature screening only. Admission still
// requires trusted full-image inspection and current-parent authorization.
export const PHOTO_CONTENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxWidth: 12_000,
  maxHeight: 12_000,
  maxTotalPixels: 40_000_000,
  maxFrames: 100,
  timeoutMs: 10_000,
  // A local 40MP WebP inspection peaked near 575MB RSS; do not run two
  // native decoders alongside the application in one serverless instance.
  maxConcurrentInspections: 1,
} as const;

export const PHOTO_IMAGE_FORMATS = {
  jpeg: { label: "JPEG", mimeType: "image/jpeg", extension: "jpg", extensions: ["jpg", "jpeg"] },
  png: { label: "PNG", mimeType: "image/png", extension: "png", extensions: ["png"] },
  webp: { label: "WebP", mimeType: "image/webp", extension: "webp", extensions: ["webp"] },
  gif: { label: "GIF", mimeType: "image/gif", extension: "gif", extensions: ["gif"] },
  tiff: { label: "TIFF", mimeType: "image/tiff", extension: "tiff", extensions: ["tif", "tiff"] },
} as const;
export type PhotoImageFormat = keyof typeof PHOTO_IMAGE_FORMATS;
export type PhotoImageMetadata = {
  format: PhotoImageFormat;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  frames: number;
};

const formatLabels = Object.values(PHOTO_IMAGE_FORMATS).map(format => format.label);
export const PHOTO_ACCEPTED_FORMAT_LIST = `${formatLabels.slice(0, -1).join(", ")}, or ${formatLabels[formatLabels.length - 1]}`;
export const PHOTO_ACCEPTED_FORMAT_GUIDANCE = `Upload a ${PHOTO_ACCEPTED_FORMAT_LIST} image, up to ${PHOTO_CONTENT_LIMITS.maxBytes / (1024 * 1024)} MB. HEIC and HEIF upload support is temporarily unavailable; BMP uploads are unsupported. Convert a copy to ${PHOTO_IMAGE_FORMATS.jpeg.label} or ${PHOTO_IMAGE_FORMATS.png.label} first. Existing uploaded photos are unaffected.`;
export const PHOTO_INPUT_ACCEPT = Object.values(PHOTO_IMAGE_FORMATS)
  .flatMap(format => [format.mimeType, ...format.extensions.map(extension => `.${extension}`)])
  .join(",");

export type PhotoSignature =
  | { status: "accepted"; format: PhotoImageFormat }
  | { status: "unsupported"; format: "heif" | "bmp" | "unknown" };

function matches(bytes: Uint8Array, offset: number, values: readonly number[]): boolean {
  return bytes.length >= offset + values.length && values.every((value, index) => bytes[offset + index] === value);
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

// File extensions and caller-supplied MIME values are deliberately absent.
// A JPEG named .heic remains a JPEG; HEIC bytes named .jpg remain rejected.
export function detectPhotoSignature(bytes: Uint8Array): PhotoSignature {
  if (ascii(bytes, 0, 2) === "BM") return { status: "unsupported", format: "bmp" };
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brands = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
    for (let offset = 8; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
      if (offset !== 12 && brands.has(ascii(bytes, offset, 4))) return { status: "unsupported", format: "heif" };
    }
  }
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return { status: "accepted", format: "jpeg" };
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { status: "accepted", format: "png" };
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return { status: "accepted", format: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return { status: "accepted", format: "webp" };
  if ([[0x49, 0x49, 0x2a, 0], [0x4d, 0x4d, 0, 0x2a], [0x49, 0x49, 0x2b, 0], [0x4d, 0x4d, 0, 0x2b]]
    .some(signature => matches(bytes, 0, signature))) return { status: "accepted", format: "tiff" };
  return { status: "unsupported", format: "unknown" };
}
