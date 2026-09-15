export type ValidationIssue = { path: string; message: string };

function issueWithin(value: unknown, path: string): ValidationIssue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return { path, message: record.message.trim() };
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = issueWithin(value[index], path ? `${path}.${index}` : String(index));
      if (issue) return issue;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (["message", "ref", "type", "types"].includes(key)) continue;
    const nestedPath = key === "root" ? path : path ? `${path}.${key}` : key;
    const issue = issueWithin(nested, nestedPath);
    if (issue) return issue;
  }
  return null;
}

export function firstValidationIssue(
  errors: unknown,
  preferredRoots: readonly string[] = [],
): ValidationIssue | null {
  if (!errors || typeof errors !== "object") return null;
  const record = errors as Record<string, unknown>;
  const visited = new Set<string>();
  for (const root of preferredRoots) {
    if (!(root in record)) continue;
    visited.add(root);
    const issue = issueWithin(record[root], root);
    if (issue) return issue;
  }
  for (const [root, value] of Object.entries(record)) {
    if (visited.has(root)) continue;
    const issue = issueWithin(value, root);
    if (issue) return issue;
  }
  return null;
}
