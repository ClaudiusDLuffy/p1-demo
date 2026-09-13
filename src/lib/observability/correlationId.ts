export const REQUEST_ID_HEADER = "X-Request-ID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validCorrelationId(value: unknown): string | null {
  return typeof value === "string" && value.length === 36 && UUID.test(value) ? value.toLowerCase() : null;
}
export function normalizeCorrelationId(value?: unknown): string { return validCorrelationId(value) ?? crypto.randomUUID(); }
