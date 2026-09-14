import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { MobileQueryProvider } from "../src/data/QueryProvider";
import { getMobileEnvironment } from "../src/data/environment";
import { installQueryRuntime } from "../src/storage/queryRuntime";
import { colors, spacing } from "../src/theme/styles";

function Routes() {
  const { status } = useAuth();
  if (status === "resolving") return <View style={styles.center}><ActivityIndicator accessibilityLabel="Restoring session" />
    <Text>Restoring secure session...</Text></View>;
  return <MobileQueryProvider><Stack screenOptions={{ headerBackTitle: "Back", contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Protected guard={status === "signed_out" || status === "recovery"}>
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
    </Stack.Protected>
    <Stack.Protected guard={status === "active"}>
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
    </Stack.Protected>
    <Stack.Protected guard={status === "unsupported"}>
      <Stack.Screen name="unsupported-role" options={{ title: "Web portal required" }} />
    </Stack.Protected>
    <Stack.Protected guard={status === "inactive"}>
      <Stack.Screen name="inactive-profile" options={{ title: "Inactive account" }} />
    </Stack.Protected>
    <Stack.Protected guard={status === "error"}>
      <Stack.Screen name="profile-error" options={{ title: "Access unavailable" }} />
    </Stack.Protected>
  </Stack></MobileQueryProvider>;
}
export default function RootLayout() {
  useEffect(() => installQueryRuntime(), []);
  try { getMobileEnvironment(); } catch {
    return <SafeAreaProvider><View style={styles.center}><Text accessibilityRole="header" style={styles.title}>Configuration required</Text>
      <Text style={styles.message}>This internal build is missing its approved mobile environment.</Text></View></SafeAreaProvider>;
  }
  return <SafeAreaProvider><StatusBar style="dark" /><AuthProvider><Routes /></AuthProvider></SafeAreaProvider>;
}
const styles = StyleSheet.create({ center: { flex: 1, padding: spacing.xl, gap: spacing.md, alignItems: "center",
  justifyContent: "center", backgroundColor: colors.background }, title: { fontSize: 24, fontWeight: "700", color: colors.ink },
  message: { fontSize: 16, color: colors.inkMuted, textAlign: "center" } });
