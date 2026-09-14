import { Redirect } from "expo-router";
import { useAuth } from "../../src/auth/AuthProvider";
import { capabilityHome } from "../../src/navigation/capabilityRoute";
export default function AppIndex() {
  const profile = useAuth().profile;
  return <Redirect href={profile ? capabilityHome(profile.capability) : "/sign-in"} />;
}
