import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Link } from "expo-router";
import { mapPublicError } from "@p1/mobile-contracts";
import { useAuth } from "../auth/AuthProvider";
import { Screen } from "../components/Screen";
import { colors, spacing, sharedStyles } from "../theme/styles";
export function SignInScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await signIn(email, password); } catch (value) { setError(mapPublicError(value).message); }
    finally { setBusy(false); }
  };
  return <Screen><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.center}>
    <View style={styles.form}>
      <Text accessibilityRole="header" style={sharedStyles.title}>P1 Pros</Text>
      <Text style={sharedStyles.subtitle}>Sign in with your existing approved account.</Text>
      <Text style={sharedStyles.label}>Email</Text>
      <TextInput accessibilityLabel="Email" autoCapitalize="none" autoComplete="email" keyboardType="email-address"
        value={email} onChangeText={setEmail} style={sharedStyles.input} />
      <Text style={sharedStyles.label}>Password</Text>
      <TextInput accessibilityLabel="Password" autoCapitalize="none" autoComplete="current-password" secureTextEntry
        value={password} onChangeText={setPassword} style={sharedStyles.input} />
      {error ? <Text accessibilityRole="alert" style={sharedStyles.error}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Sign in" disabled={busy}
        style={[sharedStyles.button, busy && styles.disabled]} onPress={() => void submit()}>
        <Text style={sharedStyles.buttonText}>{busy ? "Signing in..." : "Sign in"}</Text>
      </Pressable>
      <Link accessibilityRole="link" href="/forgot-password" style={sharedStyles.link}>Forgot password?</Link>
    </View>
  </KeyboardAvoidingView></Screen>;
}
const styles = StyleSheet.create({ center: { flex: 1, justifyContent: "center", padding: spacing.xl },
  form: { gap: spacing.md }, disabled: { backgroundColor: colors.inkMuted } });
