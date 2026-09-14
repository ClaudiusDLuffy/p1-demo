"use client";

import { detectPhotoSignature, PHOTO_ACCEPTED_FORMAT_GUIDANCE, PHOTO_CONTENT_LIMITS,
  PHOTO_IMAGE_FORMATS } from "../../lib/photoContentPolicy";
import { PhotoUploadError } from "./photoUploadError";

/** Browser byte mechanics only. No paths, authorization, Storage, workflow, or UI state. */
export async function readPhotoBytes(file: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  return bytes;
}
export async function digestPhotoBytes(file: Blob, signal?: AbortSignal): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await readPhotoBytes(file, signal));
  signal?.throwIfAborted();
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function photoContentType(file: Blob, signal?: AbortSignal): Promise<string> {
  const signature = detectPhotoSignature(new Uint8Array(await readPhotoBytes(file.slice(0, 64), signal)));
  if (signature.status !== "accepted") throw new PhotoUploadError(PHOTO_ACCEPTED_FORMAT_GUIDANCE, false);
  return PHOTO_IMAGE_FORMATS[signature.format].mimeType;
}
export async function validatePhotoFile(file: Blob, signal?: AbortSignal): Promise<void> {
  if (file.size === 0 || file.size > PHOTO_CONTENT_LIMITS.maxBytes) {
    throw new PhotoUploadError(PHOTO_ACCEPTED_FORMAT_GUIDANCE, false);
  }
  await photoContentType(file, signal);
  // Full decoding, dimensions/aggregate pixels/frames/deadline remain trusted server admission.
}
export function requirePhotoBlob(value: unknown): Blob {
  if (!(value instanceof Blob)) throw new Error("Empty photo response from storage");
  return value;
}
export function createPhotoObjectUrl(blob: Blob): string {
  return URL.createObjectURL(requirePhotoBlob(blob));
}
export function revokePhotoObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}
export function createPhotoArchiveObjectUrl(archive: Uint8Array): string {
  const bytes = new Uint8Array(archive.byteLength);
  bytes.set(archive);
  return createPhotoObjectUrl(new Blob([bytes.buffer], { type: "application/zip" }));
}
