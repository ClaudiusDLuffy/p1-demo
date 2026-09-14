/** File declarations are advisory. Admission requires a supported PDF header
 * at byte zero, followed immediately by an end-of-line character. */
export function hasInvoicePdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 9
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
    && ((bytes[5] === 0x31 && bytes[6] === 0x2e && bytes[7] >= 0x30 && bytes[7] <= 0x37)
      || (bytes[5] === 0x32 && bytes[6] === 0x2e && bytes[7] === 0x30))
    && (bytes[8] === 0x0a || bytes[8] === 0x0d);
}

export const INVOICE_PDF_MAX_BYTES = 5 * 1024 * 1024;
