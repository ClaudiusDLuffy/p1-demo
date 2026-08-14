export type ZipArchiveEntry = {
  name: string;
  data: Uint8Array;
  modifiedAt?: Date;
};

const encoder = new TextEncoder();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const safeArchiveName = (name: string) => {
  const normalized = String(name || "file")
    .replace(/\\/g, "/")
    .split("/")
    .filter(segment => segment && segment !== "." && segment !== "..")
    .join("/");
  return normalized || "file";
};

const dosDateTime = (date: Date) => {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = (date.getHours() << 11)
    | (date.getMinutes() << 5)
    | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9)
    | ((date.getMonth() + 1) << 5)
    | date.getDate();
  return { dosDate, dosTime };
};

const concatBytes = (chunks: Uint8Array[]) => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

/**
 * Builds a standards-compliant ZIP using the "stored" method (no compression).
 * Controller bundles mostly contain PDFs, which are already compressed; this
 * avoids a runtime dependency and preserves every source byte exactly.
 */
export function createZipArchive(entries: ZipArchiveEntry[]): Uint8Array {
  if (entries.length === 0) throw new Error("A ZIP archive needs at least one file");
  if (entries.length > 65_535) throw new Error("ZIP entry limit exceeded");

  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(safeArchiveName(entry.name));
    const data = entry.data;
    const checksum = crc32(data);
    const { dosDate, dosTime } = dosDateTime(entry.modifiedAt || new Date());

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 names
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localChunks.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    localOffset += local.byteLength + data.byteLength;
  }

  const centralDirectory = concatBytes(centralChunks);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...localChunks, centralDirectory, end]);
}
