import type { generateInvoicePDFBlob } from "../../lib/invoicePdf";

type PdfArguments = Parameters<typeof generateInvoicePDFBlob>;
type PdfGenerator = (...args: PdfArguments) => Blob;
type GenerationIdentity = {
  actorId: string | null;
  invoiceId: string;
  invoiceVersion: number | null;
  operationId: string | null;
};
const MAX_INVOICES = 8;
const MAX_CACHED_PDF_BYTES = 5 * 1024 * 1024;

/** The generator's public rendering inputs, not volatile query/cache metadata.
 * Keep this projection aligned with invoicePdf's Invoice and options contract.
 * This fingerprint controls local retry identity only, never authorization. */
function fingerprint(identity: GenerationIdentity, [invoice, logo, options]: PdfArguments): string {
  return JSON.stringify([
    identity.actorId, identity.invoiceId, identity.invoiceVersion, identity.operationId,
    invoice.num, invoice.documentKind, invoice.wot, invoice.externalWorkOrderId,
    invoice.store, invoice.storeAddr, invoice.invoiceDate, invoice.serviceDate,
    invoice.terms, invoice.cme,
    invoice.lines.map(line => [line.type, line.desc, line.qty, line.rate, line.amount]),
    invoice.subtotal, invoice.salesTax, invoice.total,
    logo, options?.perspective, options?.fromName, options?.fromEmail, options?.fromPhone,
    options?.billTo?.name, options?.billTo?.apAddr1, options?.billTo?.apAddr2,
  ]);
}

/** One most-recent generation per invoice; at most eight upload-sized PDFs.
 * Retaining the exact Blob preserves the attachment adapter's operation UUID
 * across uncertain uploads, even when a caller rebuilds its input objects.
 * A hook remount or eviction ends this in-memory retry window. Durable cleanup
 * remains the upload manifest's responsibility, not this rendering cache. */
export function createGeneratedInvoicePdfAttempts() {
  const entries = new Map<string, { fingerprint: string; blob: Blob }>();
  return {
    get(identity: GenerationIdentity, args: PdfArguments, generate: PdfGenerator): Blob {
      const key = JSON.stringify([identity.actorId, identity.invoiceId]);
      const nextFingerprint = fingerprint(identity, args);
      const existing = entries.get(key);
      if (existing?.fingerprint === nextFingerprint) {
        entries.delete(key);
        entries.set(key, existing);
        return existing.blob;
      }
      const blob = generate(...args);
      entries.delete(key);
      // Oversized PDFs may still be downloaded, but the upload adapter rejects
      // them before reserving anything; retaining them cannot recover an upload.
      if (identity.invoiceId && blob.size <= MAX_CACHED_PDF_BYTES) {
        entries.set(key, { fingerprint: nextFingerprint, blob });
        while (entries.size > MAX_INVOICES) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
      }
      return blob;
    },
  };
}
