/** Error normalization reads own data only, never user-controlled accessors. */
export function errorData(value: unknown, key: PropertyKey): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
