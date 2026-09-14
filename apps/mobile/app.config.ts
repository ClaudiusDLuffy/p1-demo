import type { ExpoConfig, ConfigContext } from "expo/config";

const provisionalIdentifier = "com.p1pros.portal.preview";
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "P1 Pros",
  slug: "p1-pros-mobile",
  version: "0.1.0",
  orientation: "portrait",
  scheme: "p1pros",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: { bundleIdentifier: provisionalIdentifier, supportsTablet: false },
  android: {
    package: provisionalIdentifier,
    adaptiveIcon: {
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundColor: "#155EEF",
      monochromeImage: "./assets/images/android-icon-monochrome.png"
    }
  },
  plugins: [
    "expo-router",
    ["expo-secure-store", { configureAndroidBackup: true }],
    ["expo-splash-screen", { image: "./assets/images/splash-icon.png", resizeMode: "contain", backgroundColor: "#F5F7FA" }]
  ],
  experiments: { typedRoutes: true },
  extra: {
    p1AppEnv: process.env.EXPO_PUBLIC_P1_APP_ENV ?? "",
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? "",
    supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? "",
    releaseSha: process.env.EXPO_PUBLIC_RELEASE_SHA ?? "unknown",
    eas: process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : undefined
  }
});
