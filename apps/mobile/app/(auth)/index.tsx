import { Redirect } from "expo-router";
import { useAuth } from "../../src/auth/AuthProvider";
export default function AuthIndex() {
  return <Redirect href={useAuth().status === "recovery" ? "/reset-password" : "/sign-in"} />;
}
