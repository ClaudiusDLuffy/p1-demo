import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import type { WorkOrderSummary } from "@p1/mobile-contracts";
import { PriorityBadge, StatusBadge } from "./StatusBadge";
import { colors, spacing, sharedStyles } from "../theme/styles";
export function WorkOrderCard({ item }: { item: WorkOrderSummary }) {
  const location = [item.storeNumber ? `Store ${item.storeNumber}` : null, item.city, item.state].filter(Boolean).join(" - ");
  return <Pressable accessibilityRole="button"
    accessibilityLabel={`Open work order ${item.externalWorkOrderId}, priority ${item.priority}, status ${item.status}`}
    style={({ pressed }) => [sharedStyles.card, pressed && styles.pressed]}
    onPress={() => router.push({ pathname: "/work-orders/[id]", params: { id: item.id } })}>
    <View style={styles.badges}><PriorityBadge priority={item.priority} /><StatusBadge status={item.status} /></View>
    <Text style={styles.id}>{item.externalWorkOrderId}</Text>
    <Text style={styles.summary}>{item.summary || "No service summary"}</Text>
    <Text style={styles.meta}>{location || "Location unavailable"}</Text>
    <Text style={styles.meta}>SLA: {item.responseBreachAt ? "Response breached" : item.resolutionBreachAt ? "Resolution breached" : "Within current policy"}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({ badges: { flexDirection: "row", gap: spacing.sm }, id: { fontSize: 18, fontWeight: "700", color: colors.ink },
  summary: { color: colors.ink, fontSize: 16 }, meta: { color: colors.inkMuted }, pressed: { opacity: 0.75 } });
