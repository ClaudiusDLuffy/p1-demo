export const parseAllowedIntakeStates = (
  raw: string | null | undefined,
): string[] | null => {
  if (!raw) return null;

  const states = raw
    .split(",")
    .map((state) => state.trim().toUpperCase())
    .filter(Boolean);

  if (states.length === 0 || states.includes("ALL") || states.includes("*")) {
    return null;
  }

  return [...new Set(states)];
};

const enabled = (value: string | null | undefined) =>
  String(value || "").trim().toLowerCase() === "true";

export function intakeStateBlockReason(
  state: string | null | undefined,
  allowedStatesRaw: string | null | undefined,
  texasEnabledRaw: string | null | undefined,
) {
  const normalizedState = String(state || "").trim().toUpperCase();
  const allowedStates = parseAllowedIntakeStates(allowedStatesRaw);

  // Texas intake can be prepared and deployed without activating production.
  // Enabling it requires both the allowlist and this explicit switch.
  if (normalizedState === "TX" && !enabled(texasEnabledRaw)) {
    return "state TX intake is not enabled";
  }

  if (!allowedStates) return null;
  if (!normalizedState) {
    return `state missing; allowed intake states: ${allowedStates.join(", ")}`;
  }
  if (!allowedStates.includes(normalizedState)) {
    return `state ${normalizedState} not in allowed intake states: ${allowedStates.join(", ")}`;
  }

  return null;
}
