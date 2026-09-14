import { Pressable, Text, View } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { Screen } from "../components/Screen";
import { sharedStyles } from "../theme/styles";
export function AccessStateScreen({ title, message }: { title: string; message: string }) {
  const { signOut } = useAuth();
  return <Screen><View style={[sharedStyles.content, { flex: 1, justifyContent: "center" }]}>
    <Text accessibilityRole="header" style={sharedStyles.title}>{title}</Text>
    <Text style={sharedStyles.subtitle}>{message}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Log out" style={sharedStyles.button}
      onPress={() => void signOut()}><Text style={sharedStyles.buttonText}>Log out</Text></Pressable>
  </View></Screen>;
}
