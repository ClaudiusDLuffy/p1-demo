import "server-only";
import { z } from "zod";
import { AppError } from "../../lib/errors/AppError";
import { generateInvoicePDFBlob } from "../../lib/invoicePdf";
import { verifiedInvoiceObject } from "../../lib/server/verifiedInvoiceObject";
import { readBoundedObjectBytes, type ControllerExportDownload } from "./boundedObjectDownload";
import { exportChunks, exportUuidKey, readExportRows, EXPORT_READ_PAGE_SIZE, CONTROLLER_EXPORT_LIMIT, createControllerExportReadSession, callExportClientMethod,
  type ControllerExportReadSession, type ControllerExportInvoiceFacts } from "./eligibilityRepository";

export type ControllerExportLine = { id: string; invoiceId: string; position: number; type: string; description: string | null; qty: number; rate: number; amount: number | null };
export type ControllerExportContractor = { id: string; name: string; company: string | null; email: string | null; phone: string | null };
export type ControllerExportWorkOrder = { id: string; duplicate_root_work_order_id: string | null; line_of_service: string | null; business_service: string | null; category: string | null; sub_category: string | null; summary: string | null; description: string | null };
export type ControllerExportDocumentInput = {
  invoice: ControllerExportInvoiceFacts; lines: readonly ControllerExportLine[];
  contractor: ControllerExportContractor | null; workOrder: ControllerExportWorkOrder | null; useStoredOriginal: boolean;
};
export type ControllerExportDocumentSession = ControllerExportReadSession & {
  rpc(name: "get_verified_invoice_object_v1", args: { p_invoice_id: string }): PromiseLike<unknown>;
  storage: { from(bucket: "invoice-pdfs"): { download(path: string, options: Record<string, never>, parameters?: { signal: AbortSignal }): ControllerExportDownload } };
};
export interface ControllerExportDocumentRepository {
  iterateInputs(invoices: readonly ControllerExportInvoiceFacts[]): AsyncIterable<ControllerExportDocumentInput>;
  loadInputs(invoices: readonly ControllerExportInvoiceFacts[]): Promise<readonly ControllerExportDocumentInput[]>;
  loadBytes(input: ControllerExportDocumentInput, remainingBytes: number): Promise<Uint8Array>;
}
const uuid = z.uuid();
const text = z.string().max(10000);
const lineSchema = z.object({ id: uuid, invoice_id: uuid, position: z.number().int().nonnegative(), type: z.string().max(80),
  description: z.string().max(4000).nullable(), qty: z.number().finite(), rate: z.number().finite(), amount: z.number().finite().nullable() });
const contractorSchema = z.object({ id: uuid, name: text, company: text.nullable(), email: text.nullable(), phone: text.nullable() });
const workOrderSchema = z.object({ id: z.string().min(1).max(120), duplicate_root_work_order_id: z.string().max(120).nullable(),
  line_of_service: text.nullable(), business_service: text.nullable(), category: text.nullable(),
  sub_category: text.nullable(), summary: text.nullable(), description: text.nullable() });
const responseSchema = z.object({ data: z.unknown(), error: z.unknown() })
  .refine(value => Object.hasOwn(value, "data") && Object.hasOwn(value, "error"));
export const MAX_EXPORT_DOCUMENT_BYTES = 95 * 1024 * 1024;
const MAX_LINES_PER_INVOICE = 1000; // Existing authoritative contractor-write ceiling (0124).
// Narrow only the trusted client capability to avoid instantiating the entire
// generated database intersection. The shared helper still validates raw RPC data.
const verifyBinding = verifiedInvoiceObject as unknown as (session: ControllerExportDocumentSession, invoiceId: string, path: string) => Promise<{ bindingId: string; bucket: "invoice-pdfs"; objectPath: string }>;
const promiseCapability = z.custom<PromiseLike<unknown>>(value => value !== null && (typeof value === "object" || typeof value === "function") && typeof Reflect.get(value, "then") === "function");

export function createControllerExportDocumentSession(client: unknown, signal: AbortSignal | null): ControllerExportDocumentSession {
  const read = createControllerExportReadSession(client);
  return { ...read,
    rpc: async (name, args) => {
      let request = callExportClientMethod(client, "rpc", [name, args]);
      if (request && typeof request === "object" && typeof Reflect.get(request, "retry") === "function") request = callExportClientMethod(request, "retry", [false]);
      if (signal && request && typeof request === "object" && typeof Reflect.get(request, "abortSignal") === "function") request = callExportClientMethod(request, "abortSignal", [signal]);
      return await promiseCapability.parse(request);
    },
    storage: { from: bucket => ({ download: (path, options, parameters) => ({ asStream: async () => {
      if (!client || typeof client !== "object") throw new AppError("INTERNAL_ERROR");
      const storage: unknown = Reflect.get(client, "storage");
      const download = callExportClientMethod(callExportClientMethod(storage, "from", [bucket]), "download", [path, options, parameters]);
      return await promiseCapability.parse(callExportClientMethod(download, "asStream", []));
    } }) }) },
  };
}

/** Complete write-bounded facts, then sequential document reads; no PDF parser or OCR. */
export function createExportDocumentRepository(client: unknown, signal: AbortSignal | null,
  dependencies: { generatePdf?: typeof generateInvoicePDFBlob } = {}): ControllerExportDocumentRepository {
  const session = createControllerExportDocumentSession(client, signal);
  const generate = dependencies.generatePdf ?? generateInvoicePDFBlob;
  async function* iterateInputs(invoices: readonly ControllerExportInvoiceFacts[]): AsyncGenerator<ControllerExportDocumentInput> {
      signal?.throwIfAborted();
      if (!invoices.length || invoices.length > CONTROLLER_EXPORT_LIMIT || new Set(invoices.map(invoice => exportUuidKey(invoice.id))).size !== invoices.length) throw new AppError("INVALID_REQUEST");
      for (const group of exportChunks(invoices)) {
        const ids = group.map(invoice => exportUuidKey(invoice.id));
        const originals = new Set<string>();
        const workOrderIds = [...new Set(group.flatMap(invoice => invoice.workOrderId ? [invoice.workOrderId] : []))];
        if (workOrderIds.length) {
          for (let from = 0; ; from += EXPORT_READ_PAGE_SIZE) {
            const rows = await readExportRows(session.from("activities")
              .select("id,work_order_id,event_data").in("work_order_id", workOrderIds)
              .in("event_data->>invoiceId", ids).eq("event_key", "invoice_uploaded").is("deleted_at", null)
              .order("created_at", { ascending: true }).order("id", { ascending: true })
              .range(from, from + EXPORT_READ_PAGE_SIZE - 1),
            z.object({ id: uuid, work_order_id: z.string().min(1).max(120), event_data: z.object({ invoiceId: uuid }) }), signal);
            for (const row of rows) {
              const key = exportUuidKey(row.event_data.invoiceId);
              if (!ids.includes(key) || !workOrderIds.includes(row.work_order_id)) throw new AppError("INTERNAL_ERROR");
              originals.add(key);
            }
            if (rows.length < EXPORT_READ_PAGE_SIZE) break;
          }
        }
      const contractors = new Map<string, ControllerExportContractor>();
      const workOrders = new Map<string, ControllerExportWorkOrder>();
      const contractorIds = [...new Set(group.flatMap(invoice => invoice.contractorId ? [exportUuidKey(invoice.contractorId)] : []))];
      if (contractorIds.length) {
        const rows = await readExportRows(session.from("profiles").select("id,name,company,email,phone").in("id", contractorIds), contractorSchema, signal);
        for (const row of rows) {
          const key = exportUuidKey(row.id);
          if (!contractorIds.includes(key) || contractors.has(key)) throw new AppError("INTERNAL_ERROR");
          contractors.set(key, { id: row.id, name: row.name, company: row.company ?? null, email: row.email ?? null, phone: row.phone ?? null });
        }
      }
      if (workOrderIds.length) {
        const rows = await readExportRows(session.from("work_orders")
          .select("id,duplicate_root_work_order_id,line_of_service,business_service,category,sub_category,summary,description")
          .in("id", workOrderIds), workOrderSchema, signal);
        for (const row of rows) {
          if (!workOrderIds.includes(row.id) || workOrders.has(row.id)) throw new AppError("INTERNAL_ERROR");
          workOrders.set(row.id, { id: row.id, duplicate_root_work_order_id: row.duplicate_root_work_order_id ?? null,
            line_of_service: row.line_of_service ?? null, business_service: row.business_service ?? null,
            category: row.category ?? null, sub_category: row.sub_category ?? null, summary: row.summary ?? null, description: row.description ?? null });
        }
      }
      const invoicesById = new Map(group.map(invoice => [exportUuidKey(invoice.id), invoice]));
      const makeInput = (key: string, lines: readonly ControllerExportLine[]): ControllerExportDocumentInput => {
        const invoice = invoicesById.get(key);
        if (!invoice) throw new AppError("INTERNAL_ERROR");
        if (!invoice.pdfStoragePath && !lines.length) throw new AppError("CONFLICT");
        return { invoice, lines, contractor: invoice.contractorId ? contractors.get(exportUuidKey(invoice.contractorId)) ?? null : null,
          workOrder: invoice.workOrderId ? workOrders.get(invoice.workOrderId) ?? null : null,
          useStoredOriginal: Boolean(invoice.pdfStoragePath) && (originals.has(key) || lines.length === 0) };
      };
      // Sorted pages allow release of an invoice's full lines immediately after
      // its sequential PDF generation. No500-invoice line-fact collector exists.
      const emitted = new Set<string>();
      let current: string | null = null; let lines: ControllerExportLine[] = []; let seenLines = new Set<string>();
      for (let from = 0; ; from += EXPORT_READ_PAGE_SIZE) {
        const rows = await readExportRows(session.from("invoice_lines")
          .select("id,invoice_id,position,type,description,qty,rate,amount").in("invoice_id", ids)
          .order("invoice_id", { ascending: true }).order("position", { ascending: true }).order("id", { ascending: true })
          .range(from, from + EXPORT_READ_PAGE_SIZE - 1), lineSchema, signal);
        for (const row of rows) {
          const key = exportUuidKey(row.invoice_id); const lineKey = exportUuidKey(row.id);
          if (!invoicesById.has(key) || current !== null && key < current) throw new AppError("INTERNAL_ERROR");
          if (current !== null && key !== current) {
            emitted.add(current); yield makeInput(current, lines);
            lines = []; seenLines = new Set<string>();
          }
          current = key;
          if (seenLines.has(lineKey)) throw new AppError("INTERNAL_ERROR");
          seenLines.add(lineKey);
          if (lines.length === MAX_LINES_PER_INVOICE) throw new AppError("CONFLICT");
          const previous = lines.at(-1);
          if (previous && (row.position < previous.position || row.position === previous.position && lineKey < exportUuidKey(previous.id))) throw new AppError("INTERNAL_ERROR");
          lines.push({ id: row.id, invoiceId: row.invoice_id, position: row.position, type: row.type,
            description: row.description, qty: row.qty, rate: row.rate, amount: row.amount });
        }
        if (rows.length < EXPORT_READ_PAGE_SIZE) break;
      }
      if (current !== null) { emitted.add(current); yield makeInput(current, lines); }
      for (const id of ids) if (!emitted.has(id)) yield makeInput(id, []);
    }
  }
  return {
    iterateInputs,
    async loadInputs(invoices) {
      // Explicit small collector for isolated consumers. Production packaging
      // uses iterateInputs and never retains every invoice's complete lines.
      if (invoices.length > 100) throw new AppError("INVALID_REQUEST");
      const collected = new Map<string, ControllerExportDocumentInput>();
      for await (const input of iterateInputs(invoices)) collected.set(exportUuidKey(input.invoice.id), input);
      return invoices.map(invoice => {
        const input = collected.get(exportUuidKey(invoice.id));
        if (!input) throw new AppError("INTERNAL_ERROR");
        return input;
      });
    },
    async loadBytes(input, remainingBytes) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || remainingBytes > MAX_EXPORT_DOCUMENT_BYTES) throw new AppError("INVALID_REQUEST");
      const { invoice, lines, contractor } = input;
      let blob: Blob;
      if (input.useStoredOriginal) {
        if (!invoice.pdfStoragePath) throw new AppError("CONFLICT");
        // Capability assertion only: the shared verified-object owner validates
        // its RPC receipt and exact expected parent-bound path at runtime.
        const binding = await verifyBinding(session, invoice.id, invoice.pdfStoragePath);
        signal?.throwIfAborted();
        const raw: unknown = await session.storage.from(binding.bucket).download(binding.objectPath, {}, signal ? { signal } : undefined).asStream();
        signal?.throwIfAborted();
        const result = responseSchema.safeParse(raw);
        if (!result.success || result.data.error !== null) throw new AppError("INTERNAL_ERROR");
        return readBoundedObjectBytes(result.data.data, remainingBytes, signal);
      } else {
        blob = generate({ num: invoice.num, wot: invoice.workOrderId ?? "", store: invoice.storeNumber ?? "",
          storeAddr: invoice.storeAddress ?? "", invoiceDate: invoice.invoiceDate, serviceDate: invoice.serviceDate ?? undefined,
          terms: invoice.terms ?? undefined, cme: invoice.cme ?? undefined,
          lines: lines.map(line => ({ type: line.type, desc: line.description ?? "", qty: line.qty, rate: line.rate, amount: line.amount ?? 0 })),
          subtotal: invoice.subtotal ?? 0, salesTax: invoice.salesTax ?? 0, total: invoice.total ?? 0 }, null,
        { perspective: "contractor", fromName: contractor?.company || contractor?.name || "Contractor", fromEmail: contractor?.email ?? "", fromPhone: contractor?.phone ?? "" });
      }
      signal?.throwIfAborted();
      // Generated PDF code returns a Blob synchronously; generation is bounded
      // by one invoice's authoritative1000-line input, not transport-cancellable.
      if (!(blob instanceof Blob) || blob.size > remainingBytes) throw new AppError("CONFLICT");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      signal?.throwIfAborted();
      if (bytes.byteLength !== blob.size) throw new AppError("INTERNAL_ERROR");
      return bytes;
    },
  };
}
