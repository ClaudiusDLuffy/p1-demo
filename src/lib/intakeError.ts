const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function intakeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error.trim() || fallback;
  if (!error || typeof error !== "object") return fallback;

  const record = error as Record<string, unknown>;
  const message = stringValue(record.message);
  const code = stringValue(record.code);
  const details = stringValue(record.details);
  const hint = stringValue(record.hint);
  const primary = message || fallback;
  const context = [
    code ? `code ${code}` : null,
    details,
    hint ? `hint: ${hint}` : null,
  ].filter(Boolean);

  return context.length ? `${primary} (${context.join("; ")})` : primary;
}
