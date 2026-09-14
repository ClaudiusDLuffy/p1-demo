import process from "node:process";
import { ConfigurationError, readValue, strictBoolean, type EnvironmentValues } from "../shared";
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
function timestamp(values: EnvironmentValues, name: string, required = false): string | undefined {
  const raw = readValue(values, name);
  if (!raw) { if (required) throw new ConfigurationError("CONFIG_INCOMPLETE", "email_intake", [name]); return undefined; }
  const [year, month, day] = raw.slice(0, 10).split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!instant.test(raw) || month < 1 || month > 12 || day < 1 || day > daysInMonth || !Number.isFinite(new Date(raw).getTime())) throw new ConfigurationError("CONFIG_INVALID", "email_intake", [name]);
  return new Date(raw).toISOString();
}
export function getEmailIntakeConfig(values: EnvironmentValues = process.env) {
  const enabled = strictBoolean(values, "EMAIL_INTAKE_ENABLED", "email_intake");
  // Disabled optional intake does not force unrelated provider/startup config.
  if (!enabled) return { enabled: false as const };
  const startAt = timestamp(values, "EMAIL_INTAKE_START_AT", true)!;
  const rawHours = readValue(values, "EMAIL_INTAKE_RECOVERY_LOOKBACK_HOURS");
  const hours = rawHours ? Number(rawHours) : 24;
  if (!Number.isFinite(hours) || hours <= 0) throw new ConfigurationError("CONFIG_INVALID", "email_intake", ["EMAIL_INTAKE_RECOVERY_LOOKBACK_HOURS"]);
  return { enabled: true as const, startAt, recoveryLookbackHours: Math.min(hours, 168), ...getEmailIntakePolicyConfig(values) };
}

export function getEmailIntakeSenderConfig(values: EnvironmentValues = process.env): string {
  const allowedSenders = readValue(values, "EMAIL_INTAKE_ALLOWED_SENDERS");
  const senders = allowedSenders.split(",").map(value => value.trim()).filter(Boolean);
  if (senders.length > 25 || senders.some(value => value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
    throw new ConfigurationError("CONFIG_INVALID", "email_intake", ["EMAIL_INTAKE_ALLOWED_SENDERS"]);
  }
  return allowedSenders;
}

/** Policy readers retain existing source defaults; they never enable intake. */
export function getEmailIntakePolicyConfig(values: EnvironmentValues = process.env) {
  const allowedSenders = getEmailIntakeSenderConfig(values);
  const allowedStates = readValue(values, "EMAIL_INTAKE_ALLOWED_STATES");
  if (allowedStates.split(",").map(value => value.trim()).filter(Boolean).some(value => !/^(?:[A-Z]{2}|ALL|\*)$/i.test(value))) {
    throw new ConfigurationError("CONFIG_INVALID", "email_intake", ["EMAIL_INTAKE_ALLOWED_STATES"]);
  }
  const texasRaw = readValue(values, "EMAIL_INTAKE_TEXAS_ENABLED").toLowerCase();
  if (texasRaw && !["true", "false"].includes(texasRaw)) throw new ConfigurationError("CONFIG_INVALID", "email_intake", ["EMAIL_INTAKE_TEXAS_ENABLED"]);
  return { allowedSenders, allowedStates,
    texasEnabled: texasRaw === "true", floridaStartAt: timestamp(values, "EMAIL_INTAKE_FLORIDA_START_AT"),
    priorityStartAt: timestamp(values, "EMAIL_PRIORITY_INTAKE_START_AT") };
}
