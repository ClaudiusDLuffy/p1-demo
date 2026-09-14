import "server-only";
import { createHash } from "node:crypto";
import { PrivateObjectError } from "../privateObjectContracts";

const invalidWorkbook = () => new PrivateObjectError("INVALID_ATTACHMENT", "Choose a valid .xlsx equipment form.", 422);

function zipName(bytes: Buffer, utf8: boolean): string {
  let name: string;
  try {
    // Preserve legacy ZIP byte names without lossy UTF-8 replacement aliases.
    name = utf8 ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString("latin1");
  } catch { throw invalidWorkbook(); }
  const parts = name.split("/");
  if (name.endsWith("/")) parts.pop(); // Explicit directory entries are valid.
  if (!name || /[\\:\u0000-\u001f\u007f]/u.test(name)
    || parts.some(part => !part || part === "." || part === "..")) throw invalidWorkbook();
  return name;
}

function checkExtraFields(bytes: Buffer, start: number, end: number): void {
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) throw invalidWorkbook();
    const tag = bytes.readUInt16LE(cursor);
    const length = bytes.readUInt16LE(cursor + 2);
    const next = cursor + 4 + length;
    // ZIP64 is unnecessary for the bounded 15 MiB / 4096-entry envelope and
    // would reinterpret sizes/offsets that this deliberately narrow reader owns.
    if (next > end || tag === 0x0001) throw invalidWorkbook();
    if (tag === 0x7075) {
      // A Unicode-path override must not introduce a second unsafe path.
      if (length < 5 || bytes[cursor + 4] !== 1) throw invalidWorkbook();
      zipName(bytes.subarray(cursor + 9, next), true);
    }
    cursor = next;
  }
}

/**
 * Bound and cross-check the ZIP container, without decompressing its contents.
 * This proves corresponding local entries and required OOXML part names, not
 * workbook XML semantics, decompressed CRC correctness, malware or formula safety.
 */
function inspectWorkbookContainer(buffer: Buffer): void {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw invalidWorkbook();
  const count = buffer.readUInt16LE(end + 10);
  const directoryStart = buffer.readUInt32LE(end + 16);
  let cursor = directoryStart;
  if (!count || count > 4096 || buffer.readUInt16LE(end + 8) !== count
    || cursor + buffer.readUInt32LE(end + 12) !== end) throw invalidWorkbook();
  const names = new Set<string>();
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalidWorkbook();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraStart = cursor + 46 + nameLength;
    const extraEnd = extraStart + buffer.readUInt16LE(cursor + 30);
    const next = extraEnd + buffer.readUInt16LE(cursor + 32);
    // Stored/deflated entries, optional data descriptor and UTF-8 are supported.
    // Encryption, masked headers, other compression and multi-disk ZIP are not.
    if (next > end || (flags & ~0x080e) !== 0 || ![0, 8].includes(method)
      || (method === 0 && ((flags & 6) !== 0 || compressed !== expanded))
      || expanded === 0xffffffff || buffer.readUInt16LE(cursor + 34) !== 0) throw invalidWorkbook();
    const nameBytes = buffer.subarray(cursor + 46, extraStart);
    const name = zipName(nameBytes, (flags & 0x0800) !== 0);
    if (names.has(name)) throw invalidWorkbook();
    names.add(name);
    checkExtraFields(buffer, extraStart, extraEnd);

    const local = buffer.readUInt32LE(cursor + 42);
    if (local + 30 > directoryStart || buffer.readUInt32LE(local) !== 0x04034b50
      || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method
      || buffer.readUInt16LE(local + 26) !== nameLength) throw invalidWorkbook();
    const localExtra = local + 30 + nameLength;
    const payload = localExtra + buffer.readUInt16LE(local + 28);
    let entryEnd = payload + compressed;
    if (entryEnd > directoryStart || !buffer.subarray(local + 30, localExtra).equals(nameBytes)) throw invalidWorkbook();
    checkExtraFields(buffer, localExtra, payload);
    const descriptor = (flags & 8) !== 0;
    for (const [offset, expected] of [[14, crc], [18, compressed], [22, expanded]]) {
      const actual = buffer.readUInt32LE(local + offset);
      if (actual !== expected && !(descriptor && actual === 0)) throw invalidWorkbook();
    }
    if (descriptor) {
      // Both signed and unsigned data descriptors occur in normal ZIP writers.
      const matches = (offset: number) => offset + 12 <= directoryStart
        && buffer.readUInt32LE(offset) === crc && buffer.readUInt32LE(offset + 4) === compressed
        && buffer.readUInt32LE(offset + 8) === expanded;
      if (entryEnd + 4 <= directoryStart && buffer.readUInt32LE(entryEnd) === 0x08074b50 && matches(entryEnd + 4)) entryEnd += 16;
      else if (matches(entryEnd)) entryEnd += 12;
      else throw invalidWorkbook();
    }
    spans.push({ start: local, end: entryEnd });
    cursor = next;
  }
  if (cursor !== end || !names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) throw invalidWorkbook();
  spans.sort((left, right) => left.start - right.start);
  let previousEnd = 0;
  for (const span of spans) {
    if (span.start < previousEnd) throw invalidWorkbook();
    previousEnd = span.end;
  }
}

/** Purpose validation only; this does not implement the deferred PDF parser gate. */
export function inspectPrivateAttachment(bytes: Uint8Array, purpose: "invoice_original" | "invoice_generated" | "estimate_attachment") {
  const maximum = (purpose === "estimate_attachment" ? 15 : 5) * 1024 * 1024;
  if (!bytes.length || bytes.length > maximum) throw new PrivateObjectError("INVALID_ATTACHMENT", "The attachment exceeds the supported size.", 422);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (purpose !== "estimate_attachment") {
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new PrivateObjectError("INVALID_ATTACHMENT", "Choose a PDF document.", 422);
    }
    return { format: "pdf", mimeType: "application/pdf", extension: "pdf", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), width: null, height: null, frames: null };
  }
  inspectWorkbookContainer(buffer);
  return { format: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx",
    sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: null, height: null, frames: null };
}
