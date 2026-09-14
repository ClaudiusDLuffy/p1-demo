import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Zip, ZipDeflate, ZipPassThrough, zipSync } from "fflate";
import ts from "typescript";
import { PrivateObjectError } from "./privateObjectContracts";

// Execute the actual server implementation; only Next's virtual marker is
// replaced. No Storage, credentials, network or customer documents are used.
const filename = resolve("src/lib/server/privateAttachmentInspection.ts");
const requireHere = createRequire(import.meta.url);
const exports: Partial<typeof import("./server/privateAttachmentInspection")> = {};
runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, {
  exports, Buffer, TextDecoder,
  require: (name: string): unknown => name === "server-only" ? {}
    : requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name),
}, { filename });
assert.ok(exports.inspectPrivateAttachment);
const inspect = exports.inspectPrivateAttachment;
const inspectXlsx = (bytes: Uint8Array) => inspect(bytes, "estimate_attachment");

const encoder = new TextEncoder();
// A complete tiny OOXML workbook, compressed by the installed ZIP writer.
// This is generated test data, not an existing contractor equipment form.
const workbook: Record<string, Uint8Array> = Object.fromEntries(Object.entries({
  "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Synthetic</t></is></c></row></sheetData></worksheet>',
}).map(([name, contents]) => [name, encoder.encode(contents)]));
const mtime = new Date("2020-01-01T00:00:00Z");

function archive(extra: Record<string, Uint8Array> = {}, level: 0 | 6 = 6): Buffer {
  return Buffer.from(zipSync({ ...workbook, ...extra }, { level, mtime }));
}
function streamedArchive(compressed: boolean): Buffer {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes); });
  for (const [name, bytes] of Object.entries(workbook)) {
    const file = compressed ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    file.mtime = mtime; zip.add(file); file.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}
function directory(bytes: Buffer) {
  const end = bytes.length - 22;
  const start = bytes.readUInt32LE(end + 16);
  const entries: { central: number; local: number; nameLength: number; name: string }[] = [];
  let cursor = start;
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    entries.push({ central: cursor, local: bytes.readUInt32LE(cursor + 42), nameLength,
      name: bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8") });
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  return { end, start, entries };
}
function withoutDescriptorSignatures(bytes: Buffer): Buffer {
  const { start, end, entries } = directory(bytes);
  const central = Buffer.from(bytes.subarray(start, end));
  const locals: Buffer[] = [];
  let nextLocal = 0;
  for (const entry of entries) {
    const descriptor = entry.local + 30 + bytes.readUInt16LE(entry.local + 26)
      + bytes.readUInt16LE(entry.local + 28) + bytes.readUInt32LE(entry.central + 20);
    assert.equal(bytes.readUInt32LE(descriptor), 0x08074b50);
    central.writeUInt32LE(nextLocal, entry.central - start + 42);
    const local = Buffer.concat([bytes.subarray(entry.local, descriptor), bytes.subarray(descriptor + 4, descriptor + 16)]);
    locals.push(local); nextLocal += local.length;
  }
  const ending = Buffer.from(bytes.subarray(end)); ending.writeUInt32LE(nextLocal, 16);
  return Buffer.concat([...locals, central, ending]);
}
function rejected(bytes: Uint8Array) {
  assert.throws(() => inspectXlsx(bytes), (error: unknown) => {
    assert.ok(error instanceof PrivateObjectError);
    assert.equal(error.code, "INVALID_ATTACHMENT"); assert.equal(error.httpStatus, 422);
    assert.doesNotMatch(error.message, /RangeError|offset|node_modules|\/private\/|stack|crc/i);
    return true;
  });
}

test("attachment PDFs retain the existing signature-only policy and exact byte digest", () => {
  for (const purpose of ["invoice_original", "invoice_generated"] as const) {
    const bytes = Buffer.from("prefix%PDF-synthetic signature-only fixturesuffix");
    const view = bytes.subarray(6, bytes.length - 6);
    const result = inspect(view, purpose);
    assert.equal(result.format, "pdf"); assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.sizeBytes, view.length);
    assert.equal(result.sha256, createHash("sha256").update(view).digest("hex"));
    assert.equal(result.width, null); assert.equal(result.height, null); assert.equal(result.frames, null);
    assert.throws(() => inspect(encoder.encode("not a PDF"), purpose), PrivateObjectError);
  }
});

test("attachment byte limits remain 5 MiB for PDFs and 15 MiB for XLSX", () => {
  const pdf = Buffer.alloc(5 * 1024 * 1024); pdf.write("%PDF-");
  assert.equal(inspect(pdf, "invoice_original").sizeBytes, pdf.length);
  assert.throws(() => inspect(Buffer.concat([pdf, Buffer.from([0])]), "invoice_original"), PrivateObjectError);
  rejected(new Uint8Array(0)); rejected(new Uint8Array(15 * 1024 * 1024 + 1));
});

test("real generated stored, deflated and streamed OOXML ZIPs are accepted", () => {
  for (const bytes of [archive({}, 0), archive({}, 6), streamedArchive(false), streamedArchive(true),
    archive({ "xl/": new Uint8Array(), "xl/media/é.png": encoder.encode("synthetic optional part") })]) {
    const result = inspectXlsx(bytes);
    assert.equal(result.format, "xlsx"); assert.equal(result.extension, "xlsx");
    assert.equal(result.mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.sizeBytes, bytes.length);
  }
});

test("unsigned streamed descriptors, ZIP comments and bounded extra fields remain supported", () => {
  const commented = archive(); commented.writeUInt16LE(9, commented.length - 2);
  for (const bytes of [withoutDescriptorSignatures(streamedArchive(true)), withoutDescriptorSignatures(streamedArchive(false)),
    Buffer.concat([commented, Buffer.from("synthetic")]),
    zipSync(workbook, { mtime, extra: { 0xcafe: new Uint8Array([1, 2, 3]) }, comment: "Synthetic entry comment" })]) {
    assert.equal(inspectXlsx(bytes).format, "xlsx");
  }
});

test("a forged central directory without corresponding local entries is rejected", () => {
  const original = archive(); const { start } = directory(original);
  const forged = Buffer.from(original.subarray(start));
  forged.writeUInt32LE(0, forged.length - 22 + 16);
  rejected(forged);
});

test("unsafe, ambiguous and control-bearing ZIP entry names are rejected", () => {
  for (const name of ["../outside.xml", "/root.xml", "C:/drive.xml", "C:relative.xml", "a\\b.xml",
    "xl/../outside.xml", "xl/./part.xml", "xl//part.xml", "xl/\u0000.xml", "xl/\u001f.xml", "xl/\u007f.xml", ""]) {
    rejected(archive({ [name]: encoder.encode("synthetic") }));
  }
});

test("duplicate central names and local/central filename disagreement are rejected", () => {
  const duplicate = archive({ "aa.xml": encoder.encode("one"), "bb.xml": encoder.encode("two") });
  const { entries } = directory(duplicate);
  const second = entries.find(entry => entry.name === "bb.xml"); assert.ok(second);
  duplicate.write("aa.xml", second.central + 46); duplicate.write("aa.xml", second.local + 30);
  rejected(duplicate);
  const mismatch = archive(); const first = directory(mismatch).entries[0]; assert.ok(first);
  mismatch[first.local + 30] = 0x58; rejected(mismatch);
});

test("EOCD count, disk, directory bounds and truncated headers are checked", () => {
  for (const [offset, value, width] of [[8, 1, 2], [10, 0, 2], [4, 1, 2], [6, 1, 2], [12, 0, 4], [16, 0xffffffff, 4]]) {
    const bytes = archive(); const { end } = directory(bytes);
    if (width === 2) bytes.writeUInt16LE(value, end + offset); else bytes.writeUInt32LE(value, end + offset);
    rejected(bytes);
  }
  for (const length of [1, 21, 22, 35, 80]) rejected(archive().subarray(0, length));
});

test("invalid local signatures, offsets, flags and compression agreement are rejected", () => {
  for (const mutate of [
    (bytes: Buffer, central: number, local: number) => bytes.writeUInt32LE(0, local),
    (bytes: Buffer, central: number) => bytes.writeUInt32LE(0xffffffff, central + 42),
    (bytes: Buffer, central: number, local: number) => bytes.writeUInt16LE(1, local + 6),
    (bytes: Buffer, central: number, local: number) => bytes.writeUInt16LE(0, local + 8),
    (bytes: Buffer, central: number, local: number) => { bytes.writeUInt16LE(1, central + 8); bytes.writeUInt16LE(1, local + 6); },
    (bytes: Buffer, central: number, local: number) => { bytes.writeUInt16LE(99, central + 10); bytes.writeUInt16LE(99, local + 8); },
  ]) {
    const bytes = archive(); const first = directory(bytes).entries[0]; assert.ok(first);
    mutate(bytes, first.central, first.local); rejected(bytes);
  }
});

test("declared payload, local size and CRC mismatches cannot escape the container", () => {
  for (const field of [14, 18, 22]) {
    const bytes = archive(); const first = directory(bytes).entries[0]; assert.ok(first);
    bytes.writeUInt32LE(0xffffffff, first.local + field); rejected(bytes);
  }
  const bytes = archive(); const first = directory(bytes).entries[0]; assert.ok(first);
  bytes.writeUInt32LE(0xfffffff0, first.central + 20); bytes.writeUInt32LE(0xfffffff0, first.local + 18);
  rejected(bytes);
});

test("overlapping local payload spans are rejected even when central values agree", () => {
  const bytes = archive(); const { start, entries } = directory(bytes); const first = entries[0]; assert.ok(first);
  const payload = first.local + 30 + bytes.readUInt16LE(first.local + 26) + bytes.readUInt16LE(first.local + 28);
  const overlapSize = start - payload;
  bytes.writeUInt32LE(overlapSize, first.central + 20); bytes.writeUInt32LE(overlapSize, first.local + 18);
  rejected(bytes);
});

test("streamed data descriptors are checked rather than trusting the central directory", () => {
  const bytes = streamedArchive(true); const first = directory(bytes).entries[0]; assert.ok(first);
  const descriptor = first.local + 30 + bytes.readUInt16LE(first.local + 26)
    + bytes.readUInt16LE(first.local + 28) + bytes.readUInt32LE(first.central + 20);
  assert.equal(bytes.readUInt32LE(descriptor), 0x08074b50);
  bytes.writeUInt32LE(0xffffffff, descriptor + 8); rejected(bytes);
});

test("malformed extra fields, ZIP64 reinterpretation and unsafe Unicode overrides are rejected", () => {
  rejected(zipSync(workbook, { mtime, extra: { 1: new Uint8Array(16) } }));
  rejected(zipSync(workbook, { mtime, extra: { 0x7075: Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from("../outside.xml")]) } }));
  for (const inLocal of [true, false]) {
    const bytes = Buffer.from(zipSync(workbook, { mtime, extra: { 0xcafe: new Uint8Array([1, 2, 3]) } }));
    const first = directory(bytes).entries[0]; assert.ok(first);
    const extra = inLocal ? first.local + 30 + first.nameLength : first.central + 46 + first.nameLength;
    bytes.writeUInt16LE(0xffff, extra + 2); rejected(bytes);
  }
});

test("UTF-8 errors and BOM filename aliases cannot impersonate required OOXML parts", () => {
  const malformed = archive(); const first = directory(malformed).entries[0]; assert.ok(first);
  malformed.writeUInt16LE(0x800, first.local + 6); malformed.writeUInt16LE(0x800, first.central + 8);
  malformed[first.local + 30] = 0xff; malformed[first.central + 46] = 0xff; rejected(malformed);
  const bomAliased = { ...workbook }; delete bomAliased["[Content_Types].xml"];
  bomAliased["\ufeff[Content_Types].xml"] = workbook["[Content_Types].xml"];
  rejected(zipSync(bomAliased, { mtime }));
});

test("entry counts are bounded and arbitrary ZIPs are not accepted as workbook containers", () => {
  const extras: Record<string, Uint8Array> = {};
  for (let i = 0; i < 4096 - Object.keys(workbook).length; i++) extras[`synthetic/${i}.xml`] = new Uint8Array();
  assert.equal(inspectXlsx(archive(extras)).format, "xlsx");
  extras["synthetic/overflow.xml"] = new Uint8Array(); rejected(archive(extras));
  rejected(zipSync({ "safe.txt": encoder.encode("not a workbook") }, { mtime }));
});
