import { T } from "./constants";
import { evaluateSla, type SlaWorkOrder } from "./sla/evaluation";

export type SlaDisplayWorkOrder = SlaWorkOrder;

export type SlaRemaining = {
  remainingHours: number;
  elapsedHours: number | null;
  slaHours: number | null;
  percent: number | null;
};

export const slaRemaining = (workOrder: SlaDisplayWorkOrder, now: Date = new Date()): SlaRemaining | null => {
  const state = evaluateSla(workOrder, now);
  if (state.remainingHours === null) return null;
  return {
    remainingHours: state.remainingHours,
    elapsedHours: state.progress?.elapsedHours ?? null,
    slaHours: state.progress?.slaHours ?? null,
    percent: state.progress?.percent ?? null,
  };
};

export const slaLabel = (workOrder: SlaDisplayWorkOrder, now: Date = new Date()) => {
  const state = evaluateSla(workOrder, now);
  const remaining = state.remainingHours;
  if (remaining === null) return null;
  if (state.breached) {
    return {
      text: remaining <= 0 ? `${Math.floor(-remaining)}h past SLA` : "Response breached",
      color: T.danger,
      bg: T.dangerSoft,
      severity: "breach",
    };
  }
  if (remaining < 1) {
    return {
      text: `${Math.round(remaining * 60)}m to breach`,
      color: T.danger,
      bg: T.dangerSoft,
      severity: "critical",
    };
  }
  if (state.progress && state.progress.percent >= 75) {
    return { text: `${Math.floor(remaining)}h left`, color: T.accent, bg: T.accentSoft, severity: "warn" };
  }
  if (state.progress && state.progress.percent >= 50) {
    return { text: `${Math.floor(remaining)}h left`, color: T.warn, bg: T.warnSoft, severity: "ok" };
  }
  return { text: `${Math.floor(remaining)}h left`, color: T.success, bg: T.successSoft, severity: "safe" };
};
