import NetInfo from "@react-native-community/netinfo";
import { AppState, type AppStateStatus } from "react-native";
import { focusManager, onlineManager } from "@tanstack/react-query";

let installed = false;
export function installQueryRuntime(): () => void {
  if (installed) return () => undefined;
  installed = true;
  onlineManager.setEventListener(setOnline => NetInfo.addEventListener(state =>
    setOnline(Boolean(state.isConnected && state.isInternetReachable !== false))));
  const subscription = AppState.addEventListener("change", (state: AppStateStatus) =>
    focusManager.setFocused(state === "active"));
  focusManager.setFocused(AppState.currentState === "active");
  return () => { subscription.remove(); installed = false; };
}
