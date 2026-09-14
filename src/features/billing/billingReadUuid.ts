/** The existing compact billing UUID contract: exact hyphenated hexadecimal
 * text, with no restriction added to its accepted version/variant bits.
 * HTTP callers reject null; cache callers may retain disabled placeholders.
 * This is read identity only, never financial operation identity or WOT text. */
export function canonicalBillingReadUuid(value: unknown): string | null {
  return typeof value === "string" && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}
