"use client";
// @ts-nocheck
import { computeSlaState, formatRemaining } from "../lib/slaConfig";

// Colors copied from Portal.tsx theme so this component doesn't need to
// import the whole T object. Keep in sync if the palette changes.
const C = {
  ink: "#1F1E1C",
  muted: "#6B6760",
  subtle: "#9A958D",
  success: "#4A7C59",
  successSoft: "#E8F0EA",
  warn: "#A67C00",
  warnSoft: "#FBF4DC",
  accent: "#C15F3C",
  accentSoft: "#F5E6DC",
  danger: "#C0392B",
  dangerSoft: "#FBEDEA",
};

type Props = {
  responseBreachAt: string | null;
  resolutionBreachAt: string | null;
  size?: "sm" | "md";
};

export function SlaBadge({ responseBreachAt, resolutionBreachAt, size = "sm" }: Props) {
  const state = computeSlaState(responseBreachAt, resolutionBreachAt);
  if (!state) return null;

  // Color logic per spec:
  //  - both green → green
  //  - response amber/red while resolution green → amber/red (response is the gate to arrival)
  //  - response breached, resolution still good → red "Response Breached" w/ resolution countdown
  //  - both breached → red "Both Breached" (pulse)
  let color = C.success;
  let bg = C.successSoft;
  let label: string;
  let pulse = false;
  if (state.responseBreached && state.resolutionBreached) {
    color = C.danger; bg = C.dangerSoft;
    label = "Both Breached";
    pulse = true;
  } else if (state.responseBreached) {
    color = C.danger; bg = C.dangerSoft;
    label = "Response Breached";
  } else if (state.responseRemainingHours < 1) {
    color = C.danger; bg = C.dangerSoft;
    label = `Response in ${formatRemaining(state.responseRemainingHours)}`;
  } else if (state.responseRemainingHours < 2) {
    color = C.warn; bg = C.warnSoft;
    label = `Response in ${formatRemaining(state.responseRemainingHours)}`;
  } else {
    const headlineLabel = state.headline === "response" ? "Response" : "Resolution";
    label = `${headlineLabel} in ${formatRemaining(state.headlineRemainingHours)}`;
  }

  if (size === "sm") {
    return (
      <span style={{
        fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
        color, background: bg, border: `1px solid ${color}22`,
        whiteSpace: "nowrap",
        animation: pulse ? "slaBadgePulse 1.6s infinite" : undefined,
      }}>
        {label}
        <style>{`@keyframes slaBadgePulse { 0%,100% { opacity: 1 } 50% { opacity: 0.6 } }`}</style>
      </span>
    );
  }

  // md — full detail. Used on WO detail.
  const responseStr = state.responseBreached
    ? `breached ${formatRemaining(state.responseRemainingHours)}`
    : formatRemaining(state.responseRemainingHours);
  const resolutionStr = state.resolutionBreached
    ? `breached ${formatRemaining(state.resolutionRemainingHours)}`
    : formatRemaining(state.resolutionRemainingHours);
  return (
    <div style={{ padding: "10px 14px", borderRadius: 12, background: bg, border: `1px solid ${color}33`, display: "inline-flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, letterSpacing: 0.2 }}>{label}</div>
      <div style={{ fontSize: 11, color: C.muted }}>
        Response: <span style={{ color: state.responseBreached ? C.danger : C.ink, fontWeight: 600 }}>{responseStr}</span>
        {" · "}
        Resolution: <span style={{ color: state.resolutionBreached ? C.danger : C.ink, fontWeight: 600 }}>{resolutionStr}</span>
      </div>
      <div style={{ fontSize: 10, color: C.subtle, marginTop: 2 }}>
        Resp deadline: <span className="mono">{state.responseBreachAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        {" · Res deadline: "}
        <span className="mono">{state.resolutionBreachAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}
