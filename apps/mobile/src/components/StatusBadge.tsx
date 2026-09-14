import { StyleSheet, Text, View } from "react-native";
import { priorityColors, statusColors } from "@p1/design-tokens";
import type { WorkOrderPriority, WorkOrderStatus } from "@p1/mobile-contracts";
export function PriorityBadge({ priority }: { priority: WorkOrderPriority }) {
  const color = priorityColors[priority];
  return <View accessibilityLabel={`Priority ${priority.toUpperCase()}`} style={[styles.badge, { backgroundColor: color.background }]}>
    <Text style={{ color: color.foreground, fontWeight: "700" }}>{priority.toUpperCase()}</Text>
  </View>;
}
export function StatusBadge({ status }: { status: WorkOrderStatus }) {
  const group = status === "closed" ? "closed" : status === "completed" ? "completed"
    : status === "parts" || status.startsWith("pending_") ? "attention" : "active";
  const color = statusColors[group];
  return <View accessibilityLabel={`Status ${status.replaceAll("_", " ")}`} style={[styles.badge, { backgroundColor: color.background }]}>
    <Text style={{ color: color.foreground, fontWeight: "600" }}>{status.replaceAll("_", " ")}</Text>
  </View>;
}
const styles = StyleSheet.create({ badge: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 } });
