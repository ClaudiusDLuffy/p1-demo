export const colors = {
  background: "#F5F7FA", surface: "#FFFFFF", surfaceMuted: "#EEF2F6",
  ink: "#172033", inkMuted: "#5A6578", border: "#D8DEE8",
  primary: "#155EEF", primaryPressed: "#004EEB", onPrimary: "#FFFFFF",
  success: "#137A4A", successSoft: "#E8F7EF", warning: "#9A5B00",
  warningSoft: "#FFF4D6", danger: "#B42318", dangerSoft: "#FDECEA",
  info: "#175CD3", infoSoft: "#EAF2FF",
} as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radii = { sm: 8, md: 12, lg: 18, pill: 999 } as const;
export const typography = { caption: 12, body: 16, label: 14, title: 22, heading: 28 } as const;
export const minimumTouchTarget = 44;
export const priorityColors = {
  p1: { foreground: colors.danger, background: colors.dangerSoft },
  p2: { foreground: colors.warning, background: colors.warningSoft },
  p3: { foreground: colors.info, background: colors.infoSoft },
  p4: { foreground: colors.inkMuted, background: colors.surfaceMuted },
  p5: { foreground: colors.inkMuted, background: colors.surfaceMuted },
} as const;
export const statusColors = {
  closed: { foreground: colors.inkMuted, background: colors.surfaceMuted },
  completed: { foreground: colors.success, background: colors.successSoft },
  active: { foreground: colors.info, background: colors.infoSoft },
  attention: { foreground: colors.warning, background: colors.warningSoft },
} as const;
