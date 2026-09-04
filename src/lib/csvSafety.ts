const SPREADSHEET_FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f]*[=+\-@]/u;

/** Prevent spreadsheet applications from evaluating user-controlled CSV text. */
export function protectSpreadsheetText(value: unknown): string {
  const text = String(value ?? "");
  return SPREADSHEET_FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function escapeCsvCell(value: unknown): string {
  const protectedText = protectSpreadsheetText(value);
  const escaped = protectedText.replace(/"/g, '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}
