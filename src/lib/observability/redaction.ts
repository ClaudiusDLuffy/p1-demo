export const REDACTED = "[REDACTED]";
export const REDACTION_LIMITS = { depth: 4, keys: 32, totalKeys: 128, array: 20, string: 2_000 } as const;
const secretKey = /authorization|cookie|password|passcode|secret|token|apikey|servicerole|privatekey|credential|session|signedurl|signature|twilioauth|accountsid|messagesid|servicesid|providersid|phone|mobile|email|body|payload|stack|message|detail|customer|description|invoicecontent|providerresponse/i;
export function sensitiveKey(key: string): boolean { return secretKey.test(key.replace(/[^a-z0-9]/gi, "")); }
export function redactText(value: string, maximum: number = REDACTION_LIMITS.string): string {
  const limit = Number.isFinite(maximum) ? Math.max(0, Math.min(Math.floor(maximum), REDACTION_LIMITS.string)) : REDACTION_LIMITS.string;
  return value.slice(0, limit)
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){0,2}/g, REDACTED)
    .replace(/\b(?:sb_secret_|sk_live_|sk_test_|sk-proj-|ghp_|github_pat_)[a-zA-Z0-9_-]+/g, REDACTED)
    .replace(/\b(?:AC|SK|SM|MM|MG)[a-f0-9]{32}\b/gi, REDACTED)
    .replace(/(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s]+/gi, REDACTED)
    .replace(/\b(?:https?|file):\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\b(?:authorization|cookie|password|passcode|secret|token|api[_-]?key|service[_-]?role|client[_-]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[CONTACT]")
    .replace(/(?:\+\d[\d ().-]{6,}\d|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\d{10,15}\b)/g, "[CONTACT]")
    .slice(0, limit);
}
export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>(); let keys = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return redactText(item);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item !== "object") return "[UNSUPPORTED]";
    if (depth >= REDACTION_LIMITS.depth) return "[DEPTH_LIMIT]";
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    if (item instanceof Error) return { name: "Error", message: "An operation failed." };
    if (Array.isArray(item)) {
      const length = Object.getOwnPropertyDescriptor(item, "length")?.value;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return "[UNSUPPORTED]";
      const result: unknown[] = [];
      for (let index = 0; index < Math.min(length, REDACTION_LIMITS.array); index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        result.push(descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[UNSUPPORTED]");
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(item).slice(0, REDACTION_LIMITS.keys)) {
      if (++keys > REDACTION_LIMITS.totalKeys) break;
      // Object descriptors avoid executing arbitrary payload getters.
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      const outputKey = redactText(key, 80);
      if (outputKey === "__proto__" || outputKey === "constructor") continue;
      result[outputKey] = sensitiveKey(key) ? REDACTED : descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[UNSUPPORTED]";
    }
    return result;
  };
  try { return visit(value, 0); } catch { return REDACTED; }
}
