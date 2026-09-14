export type PublicErrorCode =
  | "auth_required" | "invalid_credentials" | "account_inactive" | "profile_missing"
  | "profile_invalid" | "unsupported_role" | "forbidden" | "not_found"
  | "network" | "timeout" | "invalid_response" | "unknown";

export class MobileContractError extends Error {
  constructor(public readonly code: PublicErrorCode, message = "The request could not be completed.") {
    super(message);
    this.name = "MobileContractError";
  }
}

export function mapPublicError(value: unknown): MobileContractError {
  if (value instanceof MobileContractError) return value;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "";
  const status = typeof record.status === "number" ? record.status : 0;
  if (code === "invalid_credentials") return new MobileContractError("invalid_credentials", "Email or password is incorrect.");
  if (code === "PGRST116" || status === 404) return new MobileContractError("not_found", "This item is unavailable.");
  if (code === "42501" || status === 401 || status === 403) return new MobileContractError("forbidden", "You do not have access to this item.");
  if (record.name === "AbortError") return new MobileContractError("timeout", "The request timed out.");
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  if (message.includes("network") || message.includes("fetch")) return new MobileContractError("network", "Check your connection and try again.");
  return new MobileContractError("unknown");
}
