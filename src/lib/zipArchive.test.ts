import assert from "node:assert/strict";
import test from "node:test";

import { crc32, createZipArchive } from "./zipArchive";

test("CRC32 matches the standard reference vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("controller ZIP output contains local, central, and end records", () => {
  const archive = createZipArchive([
    { name: "../Source-PDFs/invoice.pdf", data: new Uint8Array([1, 2, 3]) },
    { name: "QuickBooks.csv", data: new TextEncoder().encode("a,b\n1,2") },
  ]);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoded = new TextDecoder().decode(archive);

  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(archive.byteLength - 22, true), 0x06054b50);
  assert.equal(view.getUint16(archive.byteLength - 12, true), 2);
  assert.match(decoded, /Source-PDFs\/invoice\.pdf/);
  assert.doesNotMatch(decoded, /\.\.\//);
  assert.match(decoded, /QuickBooks\.csv/);
});
