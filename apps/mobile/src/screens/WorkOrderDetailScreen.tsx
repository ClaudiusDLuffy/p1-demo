import { ScrollView, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useNetInfo } from "@react-native-community/netinfo";
import { useActivity, usePhotos, useVisits, useWorkOrder } from "../data/queries";
import { PrivatePhoto } from "../components/PrivatePhoto";
import { PriorityBadge, StatusBadge } from "../components/StatusBadge";
import { StatePanel } from "../components/StatePanel";
import { colors, spacing, sharedStyles } from "../theme/styles";

function MoreButton({ label, visible, busy, action }: { label: string; visible: boolean; busy: boolean; action(): void }) {
  return visible ? <Pressable accessibilityRole="button" accessibilityLabel={label} style={sharedStyles.button} onPress={action}>
    <Text style={sharedStyles.buttonText}>{busy ? "Loading..." : label}</Text></Pressable> : null;
}
export function WorkOrderDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] ?? "" : params.id ?? "";
  const workOrder = useWorkOrder(id); const activity = useActivity(id); const visits = useVisits(id); const photos = usePhotos(id);
  const network = useNetInfo(); const offline = network.isConnected === false || network.isInternetReachable === false;
  if (workOrder.isPending && !workOrder.data) return <StatePanel title="Loading work order" busy />;
  const errorCode = (workOrder.error as { code?: string } | null)?.code;
  if (workOrder.isError && (errorCode === "forbidden" || errorCode === "auth_required")) {
    return <StatePanel title="Access denied"
      message="Your current assignment or company does not authorize this work order." />;
  }
  if (workOrder.isError && !workOrder.data) {
    return <StatePanel title="Work order unavailable" message="Pull back and try again."
      actionLabel="Retry" onAction={() => void workOrder.refetch()} />;
  }
  const item = workOrder.data;
  if (!item) return <StatePanel title="Work order unavailable" message="It may have been removed from your current scope." />;
  const activities = activity.data?.pages.flatMap(page => page.items) ?? [];
  const visitItems = visits.data?.pages.flatMap(page => page.items) ?? [];
  const photoItems = photos.data?.pages.flatMap(page => page.items) ?? [];
  return <ScrollView style={sharedStyles.screen} contentContainerStyle={styles.content}>
    {offline ? <Text accessibilityLiveRegion="polite" style={styles.offline}>Offline - previously loaded information</Text> : null}
    <View style={styles.row}><PriorityBadge priority={item.priority} /><StatusBadge status={item.status} /></View>
    <Text accessibilityRole="header" style={sharedStyles.title}>{item.externalWorkOrderId}</Text>
    <Text style={sharedStyles.subtitle}>{item.summary || "No service summary"}</Text>
    <View style={sharedStyles.card}><Text style={styles.sectionTitle}>Location</Text>
      <Text>{item.storeNumber ? `Store ${item.storeNumber}` : "Store unavailable"}</Text>
      <Text>{[item.address, item.city, item.state, item.postalCode].filter(Boolean).join(", ") || "Address unavailable"}</Text>
    </View>
    <View style={sharedStyles.card}><Text style={styles.sectionTitle}>Service</Text>
      <Text>Status: {item.functionalStatus || item.status.replaceAll("_", " ")}</Text>
      <Text>{item.description || "No service description"}</Text>
      {item.technicianName ? <Text>Technician: {item.technicianName}</Text> : null}
      <Text>SLA: {item.responseBreachAt ? "Response breached" : item.resolutionBreachAt ? "Resolution breached" : "Within current policy"}</Text>
      <Text style={styles.diagnostic}>Assignment v{item.assignmentVersion}{item.lifecycleVersion !== null ? ` - Lifecycle v${item.lifecycleVersion}` : ""}</Text>
    </View>
    <View style={sharedStyles.card}><Text style={styles.sectionTitle}>Parts summary</Text>
      <Text>{item.partsReceived} of {item.partsTotal} received</Text>
      {item.partNeeded ? <Text>Needed: {item.partNeeded}</Text> : null}
      {item.partEta ? <Text>ETA: {item.partEta}</Text> : null}
    </View>
    <View style={sharedStyles.card}><Text style={styles.sectionTitle}>Activity</Text>
      {activity.isPending && !activity.data ? <Text>Loading activity...</Text> : activities.length ? activities.map(entry =>
        <View key={entry.id} style={styles.item}><Text style={styles.itemTitle}>{entry.author}</Text>
          <Text>{entry.text}</Text><Text style={styles.meta}>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "Time unavailable"}</Text></View>)
        : <Text>No visible activity.</Text>}
      <MoreButton label="Load more activity" visible={Boolean(activity.hasNextPage)} busy={activity.isFetchingNextPage}
        action={() => void activity.fetchNextPage()} />
    </View>
    <View style={sharedStyles.card}><Text style={styles.sectionTitle}>Visits</Text>
      {visits.isPending && !visits.data ? <Text>Loading visits...</Text> : visitItems.length ? visitItems.map(visit =>
        <View key={visit.id} style={styles.item}><Text>Started {new Date(visit.checkInAt).toLocaleString()}</Text>
          <Text>{visit.checkOutAt ? `Ended ${new Date(visit.checkOutAt).toLocaleString()}` : "Open visit"}</Text>
          {visit.durationReviewRequired ? <Text style={styles.offline}>Duration review required</Text> : null}</View>)
        : <Text>No visible visits.</Text>}
      <MoreButton label="Load more visits" visible={Boolean(visits.hasNextPage)} busy={visits.isFetchingNextPage}
        action={() => void visits.fetchNextPage()} />
    </View>
    <View style={sharedStyles.card}><Text style={styles.sectionTitle}>Photos</Text>
      <Text style={styles.meta}>Authenticated private previews; photo files are not retained for offline use.</Text>
      {photos.isPending && !photos.data ? <Text>Loading photo metadata...</Text> : photoItems.length ?
        <ScrollView horizontal contentContainerStyle={styles.photoRow}>{photoItems.map(photo =>
          <PrivatePhoto key={photo.id} metadata={photo} />)}</ScrollView> : <Text>No visible photos.</Text>}
      <MoreButton label="Load more photos" visible={Boolean(photos.hasNextPage)} busy={photos.isFetchingNextPage}
        action={() => void photos.fetchNextPage()} />
    </View>
  </ScrollView>;
}
const styles = StyleSheet.create({ content: { padding: spacing.lg, gap: spacing.md }, row: { flexDirection: "row", gap: spacing.sm },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: colors.ink }, item: { borderTopWidth: 1, borderTopColor: colors.border,
    paddingTop: spacing.sm, gap: spacing.xs }, itemTitle: { fontWeight: "600", color: colors.ink },
  meta: { color: colors.inkMuted, fontSize: 12 }, diagnostic: { color: colors.inkMuted, fontSize: 12 },
  offline: { color: colors.warning, fontWeight: "600" }, photoRow: { gap: spacing.md } });
