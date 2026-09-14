import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { Screen } from "../components/Screen";
import { mapPublicError } from "@p1/mobile-contracts";
import { sharedStyles } from "../theme/styles";
export function ForgotPasswordScreen() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState(""); const [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    try { await requestPasswordReset(email); setMessage("If that account is eligible, a reset link has been sent."); }
    catch (error) { setMessage(mapPublicError(error).message); }
  };
  return <Screen><View style={sharedStyles.content}>
    <Text accessibilityRole="header" style={sharedStyles.title}>Reset password</Text>
    <Text style={sharedStyles.subtitle}>Enter your approved account email.</Text>
    <TextInput accessibilityLabel="Email" autoCapitalize="none" keyboardType="email-address"
      value={email} onChangeText={setEmail} style={sharedStyles.input} />
    {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Send reset link" style={sharedStyles.button}
      onPress={() => void submit()}><Text style={sharedStyles.buttonText}>Send reset link</Text></Pressable>
  </View></Screen>;
}
