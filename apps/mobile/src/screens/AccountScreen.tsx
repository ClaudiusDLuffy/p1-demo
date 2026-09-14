import { Pressable, Text, View } from "react-native";
import * as Application from "expo-application";
import { useAuth } from "../auth/AuthProvider";
import { getMobileEnvironment } from "../data/environment";
import { Screen } from "../components/Screen";
import { sharedStyles } from "../theme/styles";
export function AccountScreen() {
  const { profile, signOut } = useAuth(); const env = getMobileEnvironment();
  return <Screen><View style={sharedStyles.content}>
    <Text accessibilityRole="header" style={sharedStyles.title}>Account</Text>
    <View style={sharedStyles.card}>
      <Text style={sharedStyles.label}>{profile?.name || "Approved user"}</Text>
      <Text>{profile?.email}</Text>
      <Text>Access: {profile?.capability.replace("_", " ")}</Text>
      {profile?.organizationName ? <Text>Company: {profile.organizationName}</Text> : null}
    </View>
    <View style={sharedStyles.card}>
      <Text>App version: {Application.nativeApplicationVersion ?? "development"}</Text>
      <Text>Build: {Application.nativeBuildVersion ?? "local"}</Text>
      <Text>Release: {env.EXPO_PUBLIC_RELEASE_SHA}</Text>
      <Text>Environment: {env.EXPO_PUBLIC_P1_APP_ENV}</Text>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Log out" style={sharedStyles.button}
      onPress={() => void signOut()}><Text style={sharedStyles.buttonText}>Log out</Text></Pressable>
  </View></Screen>;
}
