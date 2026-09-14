import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Linking from "expo-linking";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { MobileContractError, mapPublicError, type MobileProfile } from "@p1/mobile-contracts";
import { getNativeSupabase, bindAuthRefresh } from "./supabase";
import { createProfileBoundary, loadMobileProfile } from "./profileRepository";
import { applyRecoveryLink } from "./passwordReset";
import { purgeAllMobileReadCaches } from "../storage/readCache";
import { purgePhotoFiles } from "../data/privatePhotos";

export type AuthStatus = "resolving" | "signed_out" | "recovery" | "active" | "inactive" | "unsupported" | "error";
type AuthValue = {
  status: AuthStatus; session: Session | null; profile: MobileProfile | null; message: string | null;
  signIn(email: string, password: string): Promise<void>; signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>; updatePassword(password: string): Promise<void>;
};
const AuthContext = createContext<AuthValue | null>(null);
async function purgeDeviceState(): Promise<void> {
  await Promise.allSettled([purgeAllMobileReadCaches(), purgePhotoFiles()]);
}
export function AuthProvider({ children, client = getNativeSupabase() }: { children: ReactNode; client?: SupabaseClient }) {
  const [status, setStatus] = useState<AuthStatus>("resolving");
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<MobileProfile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const identity = useRef<string | null>(null);
  const generation = useRef(0);

  const resolve = useCallback(async (next: Session | null) => {
    const request = ++generation.current;
    const nextId = next?.user.id ?? null;
    if (identity.current !== nextId) {
      setStatus("resolving"); setProfile(null); setSession(null); setMessage(null);
      await purgeDeviceState();
      if (request !== generation.current) return;
      identity.current = nextId;
    }
    if (!next || !nextId) {
      setSession(null); setProfile(null); setStatus("signed_out"); return;
    }
    setStatus("resolving"); setSession(null); setProfile(null);
    try {
      const nextProfile = await loadMobileProfile(createProfileBoundary(client), nextId);
      if (request !== generation.current || nextProfile.userId !== nextId) return;
      setSession(next); setProfile(nextProfile);
      setStatus(nextProfile.capability === "unsupported" ? "unsupported" : "active");
    } catch (error) {
      if (request !== generation.current) return;
      const safe = mapPublicError(error);
      setSession(next); setProfile(null); setMessage(safe.message);
      setStatus(safe.code === "account_inactive" ? "inactive" : "error");
      await purgeDeviceState();
    }
  }, [client]);

  useEffect(() => {
    const unbindRefresh = bindAuthRefresh(client.auth);
    let mounted = true;
    const enterRecovery = (next: Session) => {
      generation.current += 1; identity.current = next.user.id;
      setSession(next); setProfile(null); setMessage(null); setStatus("recovery");
    };
    const initialize = async () => {
      const local = await client.auth.getSession();
      if (!mounted) return;
      if (local.error || !local.data.session) { await resolve(null); return; }
      const verified = await client.auth.getUser();
      if (!mounted) return;
      if (verified.error || verified.data.user?.id !== local.data.session.user.id) {
        await client.auth.signOut({ scope: "local" }); await resolve(null); return;
      }
      await resolve(local.data.session);
    };
    void initialize();
    const { data } = client.auth.onAuthStateChange((event, next) => {
      if (!mounted) return;
      if (event === "SIGNED_OUT") void resolve(null);
      else if (event === "PASSWORD_RECOVERY" && next) enterRecovery(next);
      else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        setTimeout(() => { if (mounted) void resolve(next); }, 0);
      }
    });
    const handleUrl = ({ url }: { url: string }) => {
      void applyRecoveryLink(client, url).then(async () => {
        const current = await client.auth.getSession();
        if (mounted && current.data.session) enterRecovery(current.data.session);
      }).catch(() => undefined);
    };
    const linkSubscription = Linking.addEventListener("url", handleUrl);
    void Linking.getInitialURL().then(url => { if (url) handleUrl({ url }); });
    return () => {
      mounted = false; generation.current += 1; data.subscription.unsubscribe();
      linkSubscription.remove(); unbindRefresh();
    };
  }, [client, resolve]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!email.trim() || !password) throw new MobileContractError("invalid_credentials", "Enter your email and password.");
    setStatus("resolving"); setMessage(null); generation.current += 1; identity.current = null;
    setSession(null); setProfile(null); await purgeDeviceState();
    const result = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (result.error || !result.data.session) {
      setStatus("signed_out");
      throw new MobileContractError("invalid_credentials", "Email or password is incorrect.");
    }
    await resolve(result.data.session);
  }, [client, resolve]);
  const signOut = useCallback(async () => {
    generation.current += 1; identity.current = null; setSession(null); setProfile(null); setStatus("resolving");
    await purgeDeviceState(); await client.auth.signOut({ scope: "local" }); setStatus("signed_out");
  }, [client]);
  const requestPasswordReset = useCallback(async (email: string) => {
    const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: "p1pros://reset-password" });
    if (error) throw mapPublicError(error);
  }, [client]);
  const updatePassword = useCallback(async (password: string) => {
    if (password.length < 8) throw new MobileContractError("auth_required", "Use at least 8 characters.");
    const { error } = await client.auth.updateUser({ password });
    if (error) throw mapPublicError(error);
    await resolve((await client.auth.getSession()).data.session);
  }, [client, resolve]);
  const value = useMemo<AuthValue>(() => ({ status, session, profile, message, signIn, signOut,
    requestPasswordReset, updatePassword }), [status, session, profile, message, signIn, signOut,
      requestPasswordReset, updatePassword]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required");
  return value;
}
