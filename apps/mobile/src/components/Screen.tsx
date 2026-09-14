import type { ReactNode } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { sharedStyles } from "../theme/styles";
export function Screen({ children }: { children: ReactNode }) {
  return <SafeAreaView style={sharedStyles.screen}>{children}</SafeAreaView>;
}
