import "server-only";
import { AppError } from "../../lib/errors/AppError";
import { zipArchiveByteLength, type ZipArchiveEntry } from "../../lib/zipArchive";
import type { ControllerExportInvoiceFacts } from "./eligibilityRepository";
import type { ControllerExportDocumentInput, ControllerExportDocumentRepository } from "./exportDocumentRepository";
import { createExportSnapshot, CONTROLLER_EXPORT_MANIFEST_NAME } from "./snapshot";
import { MAX_CONTROLLER_ARCHIVE_BYTES, type ControllerExportArchive, type ControllerExportArchiveBuilder } from "./archiveBuilder";

export type PreparedControllerExportArchive = {
  invoices: readonly ControllerExportInvoiceFacts[];
  sources: readonly { invoiceId: string; updatedAt: string }[];
};
export interface ControllerExportPackageBuilder {
  prepare(invoices: readonly ControllerExportInvoiceFacts[]): Promise<PreparedControllerExportArchive>;
  build(prepared: PreparedControllerExportArchive): Promise<ControllerExportArchive>;
}

/** Sequential document assembly. Neither the stage use case nor the ZIP policy performs PDF I/O. */
export function createExportPackageBuilder(documents: ControllerExportDocumentRepository,
  archive: ControllerExportArchiveBuilder, signal: AbortSignal | null): ControllerExportPackageBuilder {
  return {
    async prepare(invoices) {
      signal?.throwIfAborted();
      if (!invoices.length || invoices.length > 500 || new Set(invoices.map(invoice => invoice.id.toLowerCase())).size !== invoices.length) throw new AppError("INTERNAL_ERROR");
      return { invoices: Object.freeze(invoices.map(invoice => Object.freeze({ ...invoice }))),
        sources: Object.freeze(invoices.map(invoice => Object.freeze({ invoiceId: invoice.id, updatedAt: invoice.updatedAt }))) };
    },
    async build({ invoices }) {
      signal?.throwIfAborted();
      const expected = new Set(invoices.map(invoice => invoice.id.toLowerCase()));
      const metadata = new Map<string, ControllerExportDocumentInput>();
      const documentsById = new Map<string, ZipArchiveEntry>();
      const buffered: ZipArchiveEntry[] = [];
      for await (const input of documents.iterateInputs(invoices)) {
        signal?.throwIfAborted();
        const id = input.invoice.id.toLowerCase();
        if (!expected.has(id) || metadata.has(id)) throw new AppError("INTERNAL_ERROR");
        // Retain snapshot metadata, never the complete selection's line descriptions.
        const minimal = { ...input, invoice: { ...input.invoice }, lines: [],
          contractor: input.contractor ? { ...input.contractor } : null, workOrder: input.workOrder ? { ...input.workOrder } : null };
        const entry = createExportSnapshot([minimal]).pdfEntries[0];
        const overhead = zipArchiveByteLength([...buffered, { name: entry.name, data: new Uint8Array() }]);
        const remaining = MAX_CONTROLLER_ARCHIVE_BYTES - overhead;
        if (remaining < 0) throw new AppError("CONFLICT");
        const data = await documents.loadBytes(input, remaining);
        const file = { name: entry.name, data };
        buffered.push(file); documentsById.set(id, file); metadata.set(id, minimal);
        if (zipArchiveByteLength(buffered) > MAX_CONTROLLER_ARCHIVE_BYTES) throw new AppError("CONFLICT");
      }
      if (metadata.size !== expected.size) throw new AppError("INTERNAL_ERROR");
      const ordered = invoices.map(invoice => {
        const input = metadata.get(invoice.id.toLowerCase());
        if (!input) throw new AppError("INTERNAL_ERROR");
        return input;
      });
      const snapshot = createExportSnapshot(ordered);
      const entries: ZipArchiveEntry[] = [{ name: CONTROLLER_EXPORT_MANIFEST_NAME, data: snapshot.manifest },
        ...invoices.map(invoice => {
          const entry = documentsById.get(invoice.id.toLowerCase());
          if (!entry) throw new AppError("INTERNAL_ERROR");
          return entry;
        })];
      return archive.build(entries);
    },
  };
}
