import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env.local") });

const DEFAULT_FILE = "C:\\Users\\nxs\\Downloads\\OPEN WO  7.7 11am.xls";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

type XlsCell = string | number | boolean | "";

type ExcelWorkOrder = {
  rowNumber: number;
  number: string;
  created: string | null;
  state: string;
  priorityRaw: string;
  priority: "p1" | "p2" | "p3" | "p4" | "p5";
  storeNumber: string;
  street: string;
  city: string;
  stateProvince: string;
  summary: string;
  nteApproval: string;
  assignedTo: string;
  resolutionBreachAt: string | null;
  warnings: string[];
};

type ExistingWorkOrder = {
  id: string;
  source: string | null;
  status: string;
  contractor_id: string | null;
  deleted_at: string | null;
  created_at: string | null;
  summary: string | null;
};

type ContractorProfile = {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
};

const args = process.argv.slice(2);
const applyMode = args.includes("--apply");
const includeReviewRows = args.includes("--include-review");
const approvedNteArgIndex = args.findIndex(arg => arg === "--approved-nte");
const approvedNteAmount = approvedNteArgIndex >= 0 && args[approvedNteArgIndex + 1]
  ? Number(args[approvedNteArgIndex + 1])
  : 0;

const fileArgIndex = args.findIndex(arg => arg === "--file");
const filePath = fileArgIndex >= 0 && args[fileArgIndex + 1] ? args[fileArgIndex + 1] : DEFAULT_FILE;

if (!SUPABASE_URL || !SECRET) {
  console.error("Missing env vars in .env.local: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required for read-only duplicate checks.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const readUInt16 = (bytes: Buffer, offset: number) => bytes.readUInt16LE(offset);
const readInt32 = (bytes: Buffer, offset: number) => bytes.readInt32LE(offset);
const readUInt32 = (bytes: Buffer, offset: number) => bytes.readUInt32LE(offset);

const excelSerialToIso = (value: XlsCell): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + value * 24 * 60 * 60 * 1000).toISOString();
};

const escapeText = (value: XlsCell): string => String(value ?? "").trim();
const nullableText = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const mapPriority = (priorityRaw: string): ExcelWorkOrder["priority"] => {
  const normalized = priorityRaw.toLowerCase();
  if (normalized.startsWith("p1")) return "p1";
  if (normalized.startsWith("p2")) return "p2";
  if (normalized.startsWith("p3")) return "p3";
  if (normalized.startsWith("p4")) return "p4";
  if (normalized.startsWith("p5")) return "p5";
  return "p4";
};

const chunk = <T,>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const normalizeMatchText = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(llc|l\.l\.c|inc|inc\.|corp|corporation|co|company|services|service|refrigeration|commercial)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

const mapFunctionalStatus = (state: string) => {
  const normalized = state.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.includes("work in progress")) return "Work in Progress";
  if (normalized.includes("pending capital")) return "Pending Capital Approval";
  if (normalized.includes("awaiting parts")) return "Awaiting Parts";
  if (normalized.includes("completed") || normalized.includes("closed complete")) return "Completed";
  if (normalized.includes("cancelled") || normalized.includes("canceled")) return "Cancelled";
  if (normalized.includes("accepted") || normalized.includes("dispatched")) return "Dispatched";
  return "New";
};

const mapPortalStatus = (functionalStatus: string, contractorId: string | null) => {
  if (functionalStatus === "Work in Progress") return "wip";
  if (functionalStatus === "Awaiting Parts") return "parts";
  if (functionalStatus === "Pending Capital Approval") return "capital";
  if (functionalStatus === "Completed") return "completed";
  return contractorId ? "assigned" : "unassigned";
};

const isReviewRow = (row: ExcelWorkOrder) =>
  row.warnings.some(warning => warning.startsWith("review:"));

const mapReviewDisposition = (row: ExcelWorkOrder) => {
  const text = `${row.summary} ${row.nteApproval}`.toLowerCase();
  if (/billing only|bill only|billing of|do not dispatch po|submit docs|submit invoice|\bpo for\b/.test(text)) {
    return {
      status: "pending_invoice",
      functionalStatus: "Completed",
      isCapital: false,
    };
  }
  return {
    status: "capital",
    functionalStatus: "Pending Capital Approval",
    isCapital: true,
  };
};

const fullAddress = (row: ExcelWorkOrder) =>
  [row.street, row.city, row.stateProvince]
    .map(part => part.trim())
    .filter(Boolean)
    .concat(row.street || row.city || row.stateProvince ? ["US"] : [])
    .join(",");

const readOleChain = (data: Buffer, fat: number[], sectorSize: number, startSid: number): Buffer => {
  const out: Buffer[] = [];
  const seen = new Set<number>();
  let sid = startSid;

  while (sid >= 0 && !seen.has(sid)) {
    seen.add(sid);
    const start = (sid + 1) * sectorSize;
    out.push(data.subarray(start, start + sectorSize));
    sid = sid < fat.length ? fat[sid] : -2;
    if (sid === -2) break;
  }

  return Buffer.concat(out);
};

class SstReader {
  private chunkIndex = 0;
  private offset = 0;

  constructor(private chunks: Buffer[]) {}

  private nextChunk() {
    this.chunkIndex += 1;
    this.offset = 0;
    if (this.chunkIndex >= this.chunks.length) throw new Error("Unexpected end of SST continuation records");
  }

  read(length: number): Buffer {
    const parts: Buffer[] = [];
    let remaining = length;

    while (remaining > 0) {
      if (this.chunkIndex >= this.chunks.length) throw new Error("Unexpected end of SST data");
      if (this.offset >= this.chunks[this.chunkIndex].length) this.nextChunk();
      const current = this.chunks[this.chunkIndex];
      const take = Math.min(remaining, current.length - this.offset);
      parts.push(current.subarray(this.offset, this.offset + take));
      this.offset += take;
      remaining -= take;
    }

    return Buffer.concat(parts);
  }

  readUInt8() {
    return this.read(1).readUInt8(0);
  }

  readUInt16() {
    return this.read(2).readUInt16LE(0);
  }

  readUInt32() {
    return this.read(4).readUInt32LE(0);
  }

  readChars(count: number, highByte: boolean): string {
    const parts: string[] = [];
    let remaining = count;
    let high = highByte;

    while (remaining > 0) {
      if (this.chunkIndex >= this.chunks.length) throw new Error("Unexpected end of SST string data");
      if (this.offset >= this.chunks[this.chunkIndex].length) {
        this.nextChunk();
        high = (this.readUInt8() & 0x01) === 0x01;
      }

      const bytesPerChar = high ? 2 : 1;
      const charsAvailable = Math.floor((this.chunks[this.chunkIndex].length - this.offset) / bytesPerChar);
      if (charsAvailable <= 0) {
        this.nextChunk();
        high = (this.readUInt8() & 0x01) === 0x01;
        continue;
      }

      const takeChars = Math.min(remaining, charsAvailable);
      const raw = this.read(takeChars * bytesPerChar);
      parts.push(raw.toString(high ? "utf16le" : "latin1"));
      remaining -= takeChars;
    }

    return parts.join("");
  }
}

const decodeRk = (rk: number): number => {
  const mult100 = (rk & 0x01) === 0x01;
  const isInteger = (rk & 0x02) === 0x02;
  const bits = rk & 0xfffffffc;
  let out: number;

  if (isInteger) {
    let value = bits >> 2;
    if (value & (1 << 29)) value -= 1 << 30;
    out = value;
  } else {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(bits, 4);
    out = buf.readDoubleLE(0);
  }

  return mult100 ? out / 100 : out;
};

const parseLegacyXls = (file: string): Record<string, XlsCell>[] => {
  const data = readFileSync(file);
  if (!data.subarray(0, 8).equals(Buffer.from("D0CF11E0A1B11AE1", "hex"))) {
    throw new Error("Expected a legacy binary .xls OLE workbook");
  }

  const sectorSize = 1 << readUInt16(data, 30);
  const numFat = readUInt32(data, 44);
  const firstDir = readInt32(data, 48);
  const firstDifat = readInt32(data, 68);
  const numDifat = readUInt32(data, 72);

  const sector = (sid: number) => {
    const start = (sid + 1) * sectorSize;
    return data.subarray(start, start + sectorSize);
  };

  const fatSids: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const sid = readInt32(data, 76 + i * 4);
    if (sid >= 0) fatSids.push(sid);
  }

  let difatSid = firstDifat;
  for (let i = 0; i < numDifat; i += 1) {
    if (difatSid < 0) break;
    const sec = sector(difatSid);
    for (let offset = 0; offset < sectorSize - 4; offset += 4) {
      const sid = sec.readInt32LE(offset);
      if (sid >= 0) fatSids.push(sid);
    }
    difatSid = sec.readInt32LE(sectorSize - 4);
  }

  const fat: number[] = [];
  for (const sid of fatSids.slice(0, numFat || fatSids.length)) {
    const sec = sector(sid);
    for (let offset = 0; offset < sec.length; offset += 4) {
      fat.push(sec.readInt32LE(offset));
    }
  }

  const dirStream = readOleChain(data, fat, sectorSize, firstDir);
  let workbookStart = -1;
  let workbookSize = 0;

  for (let offset = 0; offset + 128 <= dirStream.length; offset += 128) {
    const entry = dirStream.subarray(offset, offset + 128);
    const nameLength = entry.readUInt16LE(64);
    if (nameLength < 2) continue;
    const name = entry.subarray(0, nameLength - 2).toString("utf16le");
    if (name === "Workbook" || name === "Book") {
      workbookStart = entry.readInt32LE(116);
      workbookSize = sectorSize === 4096 ? Number(entry.readBigUInt64LE(120)) : entry.readUInt32LE(120);
      break;
    }
  }

  if (workbookStart < 0) throw new Error("Workbook stream not found");
  const workbook = readOleChain(data, fat, sectorSize, workbookStart).subarray(0, workbookSize);

  const records: Array<{ op: number; payload: Buffer }> = [];
  for (let offset = 0; offset + 4 <= workbook.length;) {
    const op = workbook.readUInt16LE(offset);
    const length = workbook.readUInt16LE(offset + 2);
    records.push({ op, payload: workbook.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }

  const sstChunks: Buffer[] = [];
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].op !== 0x00fc) continue;
    sstChunks.push(records[i].payload);
    for (let j = i + 1; j < records.length && records[j].op === 0x003c; j += 1) {
      sstChunks.push(records[j].payload);
    }
    break;
  }

  const sharedStrings: string[] = [];
  if (sstChunks.length > 0) {
    const reader = new SstReader(sstChunks);
    reader.readUInt32();
    const uniqueCount = reader.readUInt32();
    for (let i = 0; i < uniqueCount; i += 1) {
      const charCount = reader.readUInt16();
      const flags = reader.readUInt8();
      const highByte = (flags & 0x01) === 0x01;
      const hasExt = (flags & 0x04) === 0x04;
      const hasRich = (flags & 0x08) === 0x08;
      const richRuns = hasRich ? reader.readUInt16() : 0;
      const extSize = hasExt ? reader.readUInt32() : 0;
      const text = reader.readChars(charCount, highByte);
      if (richRuns) reader.read(richRuns * 4);
      if (extSize) reader.read(extSize);
      sharedStrings.push(text);
    }
  }

  const rows = new Map<number, Map<number, XlsCell>>();
  let inWorksheet = false;

  const setCell = (row: number, col: number, value: XlsCell) => {
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)?.set(col, value);
  };

  for (const record of records) {
    const payload = record.payload;
    if (record.op === 0x0809 && payload.length >= 4) {
      inWorksheet = payload.readUInt16LE(2) === 0x0010;
      continue;
    }
    if (record.op === 0x000a) {
      inWorksheet = false;
      continue;
    }
    if (!inWorksheet) continue;

    if (record.op === 0x00fd && payload.length >= 10) {
      const row = payload.readUInt16LE(0);
      const col = payload.readUInt16LE(2);
      const sstIndex = payload.readUInt32LE(6);
      setCell(row, col, sharedStrings[sstIndex] ?? "");
    } else if (record.op === 0x0203 && payload.length >= 14) {
      setCell(payload.readUInt16LE(0), payload.readUInt16LE(2), payload.readDoubleLE(6));
    } else if (record.op === 0x027e && payload.length >= 10) {
      setCell(payload.readUInt16LE(0), payload.readUInt16LE(2), decodeRk(payload.readUInt32LE(6)));
    } else if (record.op === 0x00bd && payload.length >= 8) {
      const row = payload.readUInt16LE(0);
      const firstCol = payload.readUInt16LE(2);
      const lastCol = payload.readUInt16LE(payload.length - 2);
      let offset = 4;
      for (let col = firstCol; col <= lastCol; col += 1) {
        if (offset + 6 > payload.length - 2) break;
        setCell(row, col, decodeRk(payload.readUInt32LE(offset + 2)));
        offset += 6;
      }
    }
  }

  const headerRow = rows.get(0);
  if (!headerRow) throw new Error("Header row not found");
  const maxCol = Math.max(...Array.from(headerRow.keys()));
  const headers = Array.from({ length: maxCol + 1 }, (_, index) => escapeText(headerRow.get(index) ?? ""));

  return Array.from(rows.keys())
    .filter(rowNumber => rowNumber !== 0)
    .sort((a, b) => a - b)
    .map(rowNumber => {
      const row = rows.get(rowNumber) ?? new Map<number, XlsCell>();
      return Object.fromEntries(headers.map((header, index) => [header, row.get(index) ?? ""]));
    });
};

const mapExcelRows = (rows: Record<string, XlsCell>[]): ExcelWorkOrder[] => {
  return rows.map((row, index) => {
    const priorityRaw = escapeText(row["Priority"]);
    const summary = escapeText(row["Short description"]);
    const state = escapeText(row["State"]);
    const nteApproval = escapeText(row["NTE Approval"]);
    const warnings: string[] = [];

    if (!excelSerialToIso(row["Resolution Breach Time"])) {
      warnings.push("resolution_breach_at will be null");
    }
    if (/do not dispatch|capital|billing only|quote|proposal/i.test(`${summary} ${nteApproval}`)) {
      warnings.push("review: row looks like capital, quote, proposal, billing-only, or do-not-dispatch");
    }

    return {
      rowNumber: index + 2,
      number: escapeText(row["Number"]),
      created: excelSerialToIso(row["Created"]),
      state,
      priorityRaw,
      priority: mapPriority(priorityRaw),
      storeNumber: escapeText(row["Store Number"]),
      street: escapeText(row["Street"]),
      city: escapeText(row["City"]),
      stateProvince: escapeText(row["State / Province"]),
      summary,
      nteApproval,
      assignedTo: escapeText(row["Assigned to"]),
      resolutionBreachAt: excelSerialToIso(row["Resolution Breach Time"]),
      warnings,
    };
  });
};

const fetchExisting = async (ids: string[]): Promise<Map<string, ExistingWorkOrder>> => {
  const existing = new Map<string, ExistingWorkOrder>();
  for (const idsChunk of chunk(ids, 100)) {
    const { data, error } = await sb
      .from("work_orders")
      .select("id, source, status, contractor_id, deleted_at, created_at, summary")
      .in("id", idsChunk);

    if (error) throw error;
    for (const row of data ?? []) {
      existing.set(row.id, row as ExistingWorkOrder);
    }
  }
  return existing;
};

const fetchContractors = async (): Promise<ContractorProfile[]> => {
  const { data, error } = await sb
    .from("profiles")
    .select("id, name, email, company")
    .eq("role", "contractor")
    .eq("active", true);

  if (error) throw error;
  return (data ?? []) as ContractorProfile[];
};

const findContractorId = (assignedTo: string, contractors: ContractorProfile[]): string | null => {
  const target = normalizeMatchText(assignedTo);
  if (!target || target === "p1pros" || target === "p1") return null;

  for (const contractor of contractors) {
    const names = [contractor.name, contractor.company, contractor.email].map(normalizeMatchText).filter(Boolean);
    if (names.some(name => name === target)) return contractor.id;
  }

  for (const contractor of contractors) {
    const names = [contractor.name, contractor.company].map(normalizeMatchText).filter(Boolean);
    if (names.some(name => name.length >= 4 && (name.includes(target) || target.includes(name)))) return contractor.id;
  }

  return null;
};

const toStorePayload = (row: ExcelWorkOrder) => ({
  store_number: row.storeNumber,
  city: nullableText(row.city),
  state: nullableText(row.stateProvince),
  address: nullableText(fullAddress(row)),
});

const toWorkOrderPayload = (
  row: ExcelWorkOrder,
  contractorId: string | null,
  existing: ExistingWorkOrder | undefined,
) => {
  const review = isReviewRow(row);
  const reviewDisposition = review ? mapReviewDisposition(row) : null;
  const resolvedContractorId = contractorId || existing?.contractor_id || null;
  const functionalStatus = reviewDisposition?.functionalStatus || mapFunctionalStatus(row.state);
  const createdAt = row.created || new Date().toISOString();
  const nte = row.nteApproval.toLowerCase() === "approved" && approvedNteAmount > 0
    ? approvedNteAmount
    : 0;

  return {
    id: row.number,
    store_number: nullableText(row.storeNumber),
    city: nullableText(row.city),
    address: nullableText(fullAddress(row)),
    summary: nullableText(row.summary) || row.number,
    description: nullableText(row.summary) || row.number,
    priority: row.priority,
    status: reviewDisposition?.status || mapPortalStatus(functionalStatus, resolvedContractorId),
    functional_status: functionalStatus,
    contractor_id: resolvedContractorId,
    nte,
    dispatched_at: createdAt,
    sla_started_at: createdAt,
    response_breach_at: null,
    resolution_breach_at: row.resolutionBreachAt,
    source: review ? "bulk_import_review" : existing && !existing.deleted_at ? existing.source || "bulk_import" : "bulk_import",
    is_capital: reviewDisposition?.isCapital || false,
    capital_status: reviewDisposition?.isCapital ? "Pending approval" : null,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    deleted_at: null,
    deleted_by: null,
  };
};

const upsertStores = async (rows: ExcelWorkOrder[]) => {
  const storesByNumber = new Map<string, ReturnType<typeof toStorePayload>>();
  for (const row of rows) {
    if (!row.storeNumber) continue;
    storesByNumber.set(row.storeNumber, toStorePayload(row));
  }

  for (const storesChunk of chunk(Array.from(storesByNumber.values()), 100)) {
    const { error } = await sb
      .from("stores")
      .upsert(storesChunk, { onConflict: "store_number" });
    if (error) throw error;
  }
};

const upsertWorkOrders = async (payloads: ReturnType<typeof toWorkOrderPayload>[]) => {
  for (const payloadChunk of chunk(payloads, 100)) {
    const { error } = await sb
      .from("work_orders")
      .upsert(payloadChunk, { onConflict: "id" });
    if (error) throw error;
  }
};

const main = async () => {
  const rows = parseLegacyXls(filePath);
  const workOrders = mapExcelRows(rows);
  const reviewRows = workOrders.filter(isReviewRow);
  const reviewIds = new Set(reviewRows.map(row => row.number));
  const importableRows = includeReviewRows
    ? workOrders
    : workOrders.filter(row => !reviewIds.has(row.number));
  const allIds = workOrders.map(row => row.number).filter(Boolean);
  const ids = importableRows.map(row => row.number).filter(Boolean);
  const duplicatesInFile = allIds.filter((id, index) => allIds.indexOf(id) !== index);
  const existing = await fetchExisting(ids);
  const contractors = await fetchContractors();
  const contractorByRow = new Map<string, string | null>();
  for (const row of importableRows) {
    contractorByRow.set(row.number, findContractorId(row.assignedTo, contractors));
  }

  const wouldCreate = importableRows.filter(row => !existing.has(row.number));
  const wouldUpdateActive = importableRows.filter(row => {
    const match = existing.get(row.number);
    return match && !match.deleted_at;
  });
  const wouldRestoreSoftDeleted = importableRows.filter(row => {
    const match = existing.get(row.number);
    return match && !!match.deleted_at;
  });
  const p5Rows = importableRows.filter(row => row.priority === "p5");
  const missingBreachRows = importableRows.filter(row => !row.resolutionBreachAt);
  const approvedNteRows = importableRows.filter(row => row.nteApproval.toLowerCase() === "approved");
  const reviewRowsIncluded = importableRows.filter(isReviewRow);
  const assignedRows = importableRows.filter(row => !!contractorByRow.get(row.number));
  const unmatchedAssignedRows = importableRows.filter(row => row.assignedTo && !contractorByRow.get(row.number));
  const payloads = importableRows.map(row => toWorkOrderPayload(row, contractorByRow.get(row.number) || null, existing.get(row.number)));

  console.log(applyMode ? "OPEN WO import apply" : "OPEN WO import dry run");
  console.log(applyMode ? "====================" : "======================");
  console.log(`File: ${filePath}`);
  console.log(applyMode ? "Mode: APPLY; DB writes will be performed after validation" : "Mode: dry-run only; no DB writes are performed");
  console.log("");
  console.log(`Rows parsed: ${workOrders.length}`);
  console.log(`Rows excluded for client confirmation: ${includeReviewRows ? 0 : reviewRows.length}`);
  console.log(`Review rows included for client editing: ${reviewRowsIncluded.length}`);
  console.log(`Rows eligible for import: ${importableRows.length}`);
  console.log(`Unique WOTs: ${new Set(allIds).size}`);
  console.log(`Unique importable WOTs: ${new Set(ids).size}`);
  console.log(`Duplicate WOTs inside file: ${new Set(duplicatesInFile).size}`);
  console.log("");
  console.log(`Would create: ${wouldCreate.length}`);
  console.log(`Would update active: ${wouldUpdateActive.length}`);
  console.log(`Would restore soft-deleted: ${wouldRestoreSoftDeleted.length}`);
  console.log("");
  console.log(`P5 rows imported as p5: ${p5Rows.length}`);
  console.log(`Rows with null resolution_breach_at: ${missingBreachRows.length}`);
  console.log(`Approved NTE rows set to $${approvedNteAmount}: ${approvedNteRows.length}`);
  console.log(`Rows assigned to matched contractors: ${assignedRows.length}`);
  console.log(`Rows with Assigned to value but no contractor match: ${unmatchedAssignedRows.length}`);
  console.log("");

  if (applyMode) {
    const expectedImportable = includeReviewRows ? 443 : 422;
    if (workOrders.length !== 443 || reviewRows.length !== 21 || importableRows.length !== expectedImportable) {
      throw new Error(`Apply stopped: parsed/review/importable counts changed from the reviewed 443/21/${expectedImportable} plan.`);
    }
    if (duplicatesInFile.length > 0) {
      throw new Error("Apply stopped: duplicate WOTs were found inside the Excel file.");
    }
    if (includeReviewRows && approvedNteAmount !== 300) {
      throw new Error("Apply stopped: --include-review requires --approved-nte 300 for the approved NTE update.");
    }
  }

  if (wouldUpdateActive.length > 0) {
    console.log("Existing active matches:");
    for (const row of wouldUpdateActive) {
      const match = existing.get(row.number);
      console.log(`- ${row.number} | source=${match?.source ?? ""} | status=${match?.status ?? ""} | excel_row=${row.rowNumber} | ${row.summary}`);
    }
    console.log("");
  }

  if (wouldRestoreSoftDeleted.length > 0) {
    console.log("Existing soft-deleted matches that would be restored:");
    for (const row of wouldRestoreSoftDeleted) {
      const match = existing.get(row.number);
      console.log(`- ${row.number} | deleted_at=${match?.deleted_at ?? ""} | source=${match?.source ?? ""} | excel_row=${row.rowNumber} | ${row.summary}`);
    }
    console.log("");
  }

  if (p5Rows.length > 0) {
    console.log("P5 rows:");
    for (const row of p5Rows) {
      console.log(`- ${row.number} | excel_row=${row.rowNumber} | ${row.city}, ${row.stateProvince} | ${row.summary}`);
    }
    console.log("");
  }

  if (missingBreachRows.length > 0) {
    console.log("Rows with null resolution_breach_at:");
    for (const row of missingBreachRows) {
      console.log(`- ${row.number} | excel_row=${row.rowNumber} | ${row.priorityRaw} | ${row.summary}`);
    }
    console.log("");
  }

  if (reviewRows.length > 0) {
    console.log(includeReviewRows ? "Review rows included for client editing:" : "Manual review rows excluded from import:");
    for (const row of reviewRows) {
      const disposition = mapReviewDisposition(row);
      console.log(`- ${row.number} | excel_row=${row.rowNumber} | ${row.priorityRaw} | ${row.state} | ${disposition.status} | ${row.summary}`);
    }
    console.log("");
  }

  if (unmatchedAssignedRows.length > 0) {
    console.log("Assigned-to values without a contractor profile match:");
    const uniqueUnmatched = Array.from(new Set(unmatchedAssignedRows.map(row => row.assignedTo).filter(Boolean))).sort();
    for (const assignedTo of uniqueUnmatched) console.log(`- ${assignedTo}`);
    console.log("");
  }

  console.log("Sample importable payloads that would be used:");
  for (const payload of payloads.slice(0, 5)) {
    console.log(JSON.stringify(payload, null, 2));
  }

  if (applyMode) {
    console.log("");
    console.log("Applying import...");
    await upsertStores(importableRows);
    await upsertWorkOrders(payloads);
    console.log(`Import applied: ${payloads.length} work orders upserted, ${new Set(importableRows.map(row => row.storeNumber).filter(Boolean)).size} stores upserted.`);
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
