import { Link, Stack } from "expo-router";
import { Pressable, Text } from "react-native";
import { colors, spacing, minimumTouchTarget } from "@p1/design-tokens";

function AccountLink() {
  return <Link href="/account" asChild><Pressable accessibilityRole="button" accessibilityLabel="Open account"
    style={{ minHeight: minimumTouchTarget, minWidth: minimumTouchTarget, justifyContent: "center", paddingHorizontal: spacing.sm }}>
    <Text style={{ color: colors.primary, fontWeight: "700" }}>Account</Text>
  </Pressable></Link>;
}

export default function AppLayout() {
  const screenOptions = { headerRight: () => <AccountLink /> };
  return <Stack screenOptions={screenOptions}><Stack.Screen name="index" options={{ headerShown: false }} />
    <Stack.Screen name="jobs/index" options={{ title: "My Jobs" }} />
    <Stack.Screen name="company/index" options={{ title: "Company Queue" }} />
    <Stack.Screen name="work-orders/[id]" options={{ title: "Work order" }} />
    <Stack.Screen name="account" options={{ title: "Account", headerRight: () => null }} /></Stack>;
}
