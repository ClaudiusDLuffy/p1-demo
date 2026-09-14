import { StyleSheet } from "react-native";
import { colors, minimumTouchTarget, radii, spacing, typography } from "@p1/design-tokens";
export { colors, minimumTouchTarget, radii, spacing, typography };
export const sharedStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, padding: spacing.lg, gap: spacing.sm },
  title: { color: colors.ink, fontSize: typography.heading, fontWeight: "700" },
  subtitle: { color: colors.inkMuted, fontSize: typography.body },
  label: { color: colors.ink, fontSize: typography.label, fontWeight: "600" },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.sm, paddingHorizontal: spacing.md, color: colors.ink, backgroundColor: colors.surface },
  button: { minHeight: minimumTouchTarget, borderRadius: radii.sm, backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.onPrimary, fontSize: typography.body, fontWeight: "700" },
  link: { color: colors.primary, fontSize: typography.body, minHeight: minimumTouchTarget,
    textAlignVertical: "center" },
  error: { color: colors.danger, fontSize: typography.label },
});
