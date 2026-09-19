const FALLBACK_VERSION = "local-development";
const MAX_VERSION_LENGTH = 120;
const SAFE_VERSION = /^[A-Za-z0-9._-]+$/;

export function normalizeDeploymentVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_VERSION_LENGTH || !SAFE_VERSION.test(normalized)) return null;
  return normalized;
}

export function shortDeploymentVersion(value: string): string {
  if (value === FALLBACK_VERSION) return "local";
  if (/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value)) return value;
  const withoutVercelPrefix = value.startsWith("dpl_") ? value.slice(4) : value;
  return withoutVercelPrefix.slice(0, 10);
}

export function deploymentChanged(running: string, available: unknown): available is string {
  const normalized = normalizeDeploymentVersion(available);
  return normalized !== null && normalized !== running;
}

export function normalizeDeploymentUpdatedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function formatDeploymentUpdatedAt(value: unknown): string | null {
  const normalized = normalizeDeploymentUpdatedAt(value);
  if (!normalized) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).formatToParts(new Date(normalized));
  const valueByType = new Map(parts.map(part => [part.type, part.value]));
  return `${valueByType.get("month")} ${valueByType.get("day")}, ${valueByType.get("year")}, `
    + `${valueByType.get("hour")}:${valueByType.get("minute")} ${valueByType.get("dayPeriod")} `
    + valueByType.get("timeZoneName");
}

export const RUNNING_DEPLOYMENT_VERSION =
  normalizeDeploymentVersion(process.env.NEXT_PUBLIC_P1_BUILD_VERSION) || FALLBACK_VERSION;

export const RUNNING_DEPLOYMENT_UPDATED_AT =
  normalizeDeploymentUpdatedAt(process.env.NEXT_PUBLIC_P1_BUILD_UPDATED_AT);
