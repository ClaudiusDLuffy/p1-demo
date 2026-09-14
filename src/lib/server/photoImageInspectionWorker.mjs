// @ts-check
// Dedicated disposable process: stdin is bounded image bytes; stdout is one
// small JSON result. No file/URL sources, credentials or user-controlled code.
import sharp from "sharp";
import { createHash } from "node:crypto";

/** @typedef {{maxBytes:number,maxWidth:number,maxHeight:number,maxTotalPixels:number,maxFrames:number}} Limits */
/** @param {unknown} value @returns {Limits} */
function parseLimits(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid worker limits");
  /** @param {string} key */
  const read = key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const field = descriptor?.value;
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field <= 0) throw new Error("Invalid worker limit");
    return field;
  };
  return { maxBytes: read("maxBytes"), maxWidth: read("maxWidth"), maxHeight: read("maxHeight"),
    maxTotalPixels: read("maxTotalPixels"), maxFrames: read("maxFrames") };
}

/** @param {string} code */
function reject(code) {
  process.stdout.write(JSON.stringify({ ok: false, code }));
}

/** @param {Buffer} bytes */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Sharp deliberately tolerates some missing trailers. Require complete JPEG,
 * PNG, WebP and GIF containers in addition to full native raster decoding.
 * For APNG, a declared frame count must match the decoder's actual page count;
 * a build that can only see its default image must not approve all frames.
 * @param {Buffer} bytes @param {string} format
 * @returns {{complete:boolean,frames?:number}}
 */
function container(bytes, format) {
  if (format === "jpeg") return { complete: bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 };
  if (format === "gif") return { complete: bytes.length >= 7 && bytes[bytes.length - 1] === 0x3b };
  if (format === "webp") return { complete: bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length };
  if (format !== "png") return { complete: true };
  let offset = 8;
  let first = true;
  let imageData = false;
  /** @type {number|undefined} */
  let frames;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) return { complete: false };
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (first && (type !== "IHDR" || size !== 13)) return { complete: false };
    if (!first && type === "IHDR") return { complete: false };
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return { complete: false };
    first = false;
    if (type === "IDAT") imageData = true;
    if (type === "acTL") {
      if (size !== 8 || frames !== undefined) return { complete: false };
      frames = bytes.readUInt32BE(offset + 8);
      if (frames < 1) return { complete: false };
    }
    if (type === "IEND") return { complete: size === 0 && end === bytes.length && imageData, frames };
    offset = end;
  }
  return { complete: false };
}

async function inspect() {
  const limits = parseLimits(JSON.parse(process.argv[2] || "null"));
  const expectedFormat = process.argv[3];
  if (!["jpeg", "png", "webp", "gif", "tiff"].includes(expectedFormat)) throw new Error("Invalid format");
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid byte stream");
    size += chunk.length;
    if (size > limits.maxBytes) { reject("IMAGE_TOO_LARGE"); return; }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  chunks.length = 0;
  if (bytes.length === 0) { reject("EMPTY_IMAGE"); return; }
  const structure = container(bytes, expectedFormat);
  if (!structure.complete) { reject("INVALID_IMAGE_CONTENT"); return; }
  if (structure.frames !== undefined && structure.frames > limits.maxFrames) { reject("IMAGE_RESOURCE_LIMIT"); return; }
  sharp.cache(false);
  sharp.concurrency(1);
  const options = { failOn: /** @type {const} */ ("warning"), limitInputPixels: limits.maxTotalPixels,
    sequentialRead: true, unlimited: false, animated: true };
  /** @type {import("sharp").Metadata} */
  let metadata;
  try { metadata = await sharp(bytes, options).metadata(); }
  catch (error) {
    reject(error instanceof Error && error.message.includes("pixel limit") ? "IMAGE_RESOURCE_LIMIT" : "INVALID_IMAGE_CONTENT");
    return;
  }
  const frames = metadata.pages ?? 1;
  const height = metadata.pageHeight ?? metadata.height;
  const width = metadata.width;
  if (metadata.format !== expectedFormat) { reject("INVALID_IMAGE_CONTENT"); return; }
  // A default PNG image is not proof of even a one-frame APNG animation.
  // Require explicit native page metadata, never the static-image fallback.
  if (structure.frames !== undefined && (metadata.pages === undefined || structure.frames !== frames)) {
    reject("INVALID_IMAGE_CONTENT"); return;
  }
  if (![width, height, frames].every(value => Number.isSafeInteger(value) && value > 0)
    || width > limits.maxWidth || height > limits.maxHeight || frames > limits.maxFrames
    || width * height * frames > limits.maxTotalPixels) { reject("IMAGE_RESOURCE_LIMIT"); return; }
  // All pages are decoded. stats() performs complete raster statistics in
  // native code, not a header-only probe; no raw 160MB image is sent to parent.
  // Native allocations are not hard-capped by V8 heap flags or Sharp cache.
  try { await sharp(bytes, options).stats(); }
  catch { reject("INVALID_IMAGE_CONTENT"); return; }
  process.stdout.write(JSON.stringify({ ok: true, format: expectedFormat, sizeBytes: size,
    sha256: createHash("sha256").update(bytes).digest("hex"), width, height, frames }));
}

inspect().catch(() => reject("IMAGE_INSPECTION_FAILED"));
