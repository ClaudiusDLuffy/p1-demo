import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "../auth/AuthProvider";
import { mapPublicError } from "@p1/mobile-contracts";
import { Screen } from "../components/Screen";
import { sharedStyles } from "../theme/styles";
export function ResetPasswordScreen() {
  const { updatePassword } = useAuth(); const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    try { await updatePassword(password); setMessage("Password updated."); router.replace("/"); }
    catch (error) { setMessage(mapPublicError(error).message); }
  };
  return <Screen><View style={sharedStyles.content}>
    <Text accessibilityRole="header" style={sharedStyles.title}>Choose a new password</Text>
    <TextInput accessibilityLabel="New password" secureTextEntry autoComplete="new-password"
      value={password} onChangeText={setPassword} style={sharedStyles.input} />
    {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Update password" style={sharedStyles.button}
      onPress={() => void submit()}><Text style={sharedStyles.buttonText}>Update password</Text></Pressable>
  </View></Screen>;
}
