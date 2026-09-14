import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useNetInfo } from "@react-native-community/netinfo";
import { useWorkOrders } from "../data/queries";
import { WorkOrderCard } from "../components/WorkOrderCard";
import { StatePanel } from "../components/StatePanel";
import { colors, spacing, sharedStyles } from "../theme/styles";
export function JobsScreen({ title }: { title: string }) {
  const query = useWorkOrders(); const network = useNetInfo();
  const items = useMemo(() => query.data?.pages.flatMap(page => page.items) ?? [], [query.data]);
  const offline = network.isConnected === false || network.isInternetReachable === false;
  if (query.isPending && !query.data) return <StatePanel title="Loading assigned work" busy />;
  const errorCode = (query.error as { code?: string } | null)?.code;
  if (query.isError && (errorCode === "forbidden" || errorCode === "auth_required")) return <StatePanel title="Access denied"
    message="Your current assignment or company no longer authorizes this queue." />;
  if (query.isError && !query.data) return <StatePanel title="Unable to load work" message="Check your connection and try again."
    actionLabel="Retry" onAction={() => void query.refetch()} />;
  return <View style={sharedStyles.screen}>
    <FlatList data={items} keyExtractor={item => item.id} renderItem={({ item }) => <WorkOrderCard item={item} />}
      contentContainerStyle={styles.list} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}
      onEndReached={() => { if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage(); }}
      onEndReachedThreshold={0.35}
      ListHeaderComponent={<View style={styles.header}><Text accessibilityRole="header" style={sharedStyles.title}>{title}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.state}>{offline ? "Offline - showing previously loaded work" :
          `Last updated ${query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toLocaleTimeString() : "now"}`}</Text></View>}
      ListEmptyComponent={<StatePanel title="No current work orders" message="Pull down to refresh." />}
      ListFooterComponent={query.hasNextPage ? <Pressable accessibilityRole="button" accessibilityLabel="Load more work orders"
        style={sharedStyles.button} onPress={() => void query.fetchNextPage()}>
        <Text style={sharedStyles.buttonText}>{query.isFetchingNextPage ? "Loading..." : "Load more"}</Text></Pressable> : null}
    />
  </View>;
}
const styles = StyleSheet.create({ list: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },
  header: { gap: spacing.sm, marginBottom: spacing.sm }, state: { color: colors.inkMuted } });
