import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing, sharedStyles } from "../theme/styles";
export function StatePanel({ title, message, actionLabel, onAction, busy = false }: {
  title: string; message?: string; actionLabel?: string; onAction?: () => void; busy?: boolean;
}) {
  return <View accessible accessibilityRole="summary" style={styles.container}>
    {busy ? <ActivityIndicator accessibilityLabel="Loading" color={colors.primary} /> : null}
    <Text style={styles.title}>{title}</Text>
    {message ? <Text style={styles.message}>{message}</Text> : null}
    {actionLabel && onAction ? <Pressable accessibilityRole="button" accessibilityLabel={actionLabel}
      style={sharedStyles.button} onPress={onAction}><Text style={sharedStyles.buttonText}>{actionLabel}</Text></Pressable> : null}
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.xl, gap: spacing.md, alignItems: "center", justifyContent: "center" },
  title: { color: colors.ink, fontSize: 20, fontWeight: "700", textAlign: "center" },
  message: { color: colors.inkMuted, fontSize: 16, textAlign: "center" },
});
