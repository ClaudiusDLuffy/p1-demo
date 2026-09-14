"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { signIn, signOut } from "../../lib/db";
import {
  getRememberedEmail,
  getRememberMePreference,
  setRememberMePreference,
  supabase,
} from "../../lib/supabase/client";
import { DEMO_ACCOUNTS } from "../../lib/constants";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { parseAuthProfile, type PortalAuthProfile } from "./authProfile";
import { activateBrowserDraftSession, draftActivationTicket, revokeBrowserDraftSession, suspendBrowserDraftSession } from "../../lib/drafts/browserDraftSession";

type AuthControls = { fire?: (message: string) => void; setPage(page: string): void;
  setSelectedWO(id: string | null): void; setAiNote(value: null): void; setInvoices?(values: never[]): void };

export async function changePassword(
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const sb = supabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) return { success: false, error: safeErrorMessage(error) };
  return { success: true };
}

export default function useAuth({
  fire,
  setPage,
  setSelectedWO,
  setAiNote,
  setInvoices,
}: AuthControls) {
  const qc = useQueryClient();
  const [currentUser, setCurrentUser] = useState<PortalAuthProfile | null>(null);
  const currentProfileRef = useRef<PortalAuthProfile | null>(null);
  const profileRequestRef = useRef(0);
  const [loginEmail, setLoginEmail] = useState(() => getRememberedEmail());
  const [loginPassword, setLoginPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(() => getRememberMePreference());
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const expectedUserIdRef = useRef<string | null>(null);
  const lastLoadedUserIdRef = useRef<string | null>(null);
  const loginAttemptRef = useRef(false);
  const authTransitionRef = useRef<"login" | "logout" | null>(null);

  useEffect(() => { const t = setTimeout(() => setFadeIn(true), 50); return () => clearTimeout(t); }, []);

  const hydrateProfile = useCallback(async (userId: string) => {
    if (expectedUserIdRef.current !== userId) return false;
    const request = ++profileRequestRef.current;
    let draftTicket = draftActivationTicket();
    try {
      const sb = supabase();
      const [profileResult, scopeResult, permissionsResult] = await Promise.all([
        sb.from("profiles").select("*").eq("id", userId).single(),
        // Narrow contract for this existing RPC until generated types include it.
        (sb as unknown as { rpc(name: "get_my_contractor_scope"): PromiseLike<{ data: unknown; error: unknown }> }).rpc("get_my_contractor_scope"),
        sb.from("staff_permission_grants")
          .select("permission")
          .eq("profile_id", userId),
      ]);
      const { data: prof, error } = profileResult;
      if (error) throw error;
      if (!prof) throw new Error("Profile not found for this account");
      // An inactive exact self row is sufficient to stop the old session's
      // read/subscription scope even if active-only scope/grant RPCs deny it.
      if (prof.active !== false && scopeResult.error) throw scopeResult.error;
      if (prof.active !== false && permissionsResult.error) throw permissionsResult.error;
      // An older profile request can finish after a new account signs in.
      // Never let that stale response restore the previous identity.
      if (expectedUserIdRef.current !== prof.id || request !== profileRequestRef.current) return false;
      const next = parseAuthProfile(prof, prof.active ? scopeResult.data : {}, prof.active ? permissionsResult.data : [], DEMO_ACCOUNTS.some(d => d.email === prof.email));
      const previous = currentProfileRef.current;
      const changed = previous !== null && directoryActorScope(previous) !== directoryActorScope(next);
      const initial = lastLoadedUserIdRef.current !== prof.id;
      if (changed) {
        revokeBrowserDraftSession(previous.id);
        draftTicket = draftActivationTicket();
        // Role, active state, company and grant changes are identity changes,
        // not ordinary invalidations. Cancel late old-scope reads before clear.
        await qc.cancelQueries();
        if (expectedUserIdRef.current !== prof.id || request !== profileRequestRef.current) return false;
        qc.clear(); setSelectedWO(null); setAiNote(null); setInvoices?.([]);
      }
      activateBrowserDraftSession(next.id, next.active, draftTicket);
      lastLoadedUserIdRef.current = prof.id;
      currentProfileRef.current = next;
      setCurrentUser(next);
      if (initial || changed) setPage(prof.role === "contractor" ? "my_jobs" : "dashboard");
      return next.active && !changed;
    } catch (err: unknown) {
      if (expectedUserIdRef.current !== userId || request !== profileRequestRef.current) return false;
      setLoginError(safeErrorMessage(err));
      if (fire) fire(safeErrorMessage(err));
      throw err;
    } finally {
      if (expectedUserIdRef.current === userId && request === profileRequestRef.current) {
        loginAttemptRef.current = false;
        authTransitionRef.current = null;
        setLoginLoading(false);
      }
    }
  }, [fire, setPage, qc, setSelectedWO, setAiNote, setInvoices]);

  const refreshCurrentProfile = useCallback(async () => {
    const id = expectedUserIdRef.current;
    return id ? hydrateProfile(id) : false;
  }, [hydrateProfile]);

  // Real Supabase auth - replaces demo button login
  const doLogin = async (email: string, password: string, remember = rememberMe) => {
    if (loginLoading) return;
    const v = (email || "").trim();
    if (!v) { setLoginError("Enter an email to sign in"); return; }
    setLoginError(null);
    setLoginLoading(true);
    loginAttemptRef.current = true;
    authTransitionRef.current = "login";
    try {
      setRememberMePreference(remember, v);
      suspendBrowserDraftSession();
      // Gate every profile-scoped query while Supabase changes identity. A
      // successful password sign-in replaces the local session itself, so a
      // pre-login sign-out would only create a 401 window (and its default
      // global scope would revoke the user's sessions on other devices).
      expectedUserIdRef.current = null;
      lastLoadedUserIdRef.current = null;
      currentProfileRef.current = null;
      qc.clear();
      setHasSession(false);
      setCurrentUser(null);
      setSelectedWO(null);
      setAiNote(null);
      setInvoices?.([]);
      const data = await signIn(v, password);
      if (data?.user?.id) {
        expectedUserIdRef.current = data.user.id;
        setHasSession(true);
        await hydrateProfile(data.user.id);
      } else {
        loginAttemptRef.current = false;
        authTransitionRef.current = null;
        setLoginLoading(false);
      }
    } catch (err: unknown) {
      setLoginError(safeErrorMessage(err));
      loginAttemptRef.current = false;
      authTransitionRef.current = null;
      setLoginLoading(false);
    }
  };
  const logout = async () => {
    // Fence delayed cleanup/autosaves before identity/UI teardown. Failure never blocks sign-out.
    revokeBrowserDraftSession(expectedUserIdRef.current);
    loginAttemptRef.current = false;
    authTransitionRef.current = "logout";
    expectedUserIdRef.current = null;
    lastLoadedUserIdRef.current = null;
    currentProfileRef.current = null;
    qc.clear();
    setHasSession(false);
    setCurrentUser(null);
    setLoginLoading(false);
    setPage("dashboard");
    setSelectedWO(null);
    setLoginEmail("");
    setAiNote(null);
    setInvoices?.([]);
    try {
      await signOut("local");
    } finally {
      authTransitionRef.current = null;
    }
  };

  // -- DATA LOADERS - fire when auth session is available ---------------
  // Single listener handles mount (INITIAL_SESSION), fresh logins (SIGNED_IN),
  // and logout (SIGNED_OUT). Profile fetch is deferred via setTimeout to
  // release the GoTrue internal lock - calling supabase-js methods directly
  // inside onAuthStateChange can deadlock and cause the spinner to hang.
  useEffect(() => {
    let mounted = true;

    const hydrate = (userId: string) => {
      setTimeout(async () => {
        if (!mounted) return;
        try {
          await hydrateProfile(userId);
        } catch {
          if (!mounted) return;
          // hydrateProfile already surfaced the error.
        }
      }, 0);
    };

    const sb = supabase();
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      // A token refresh from the previous identity can arrive while a
      // password request is in flight. The direct sign-in result is the
      // authority until its new user id is known.
      if (authTransitionRef.current === "login" && expectedUserIdRef.current === null) return;
      if (authTransitionRef.current === "logout" && event !== "SIGNED_OUT") return;
      if ((event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session?.user) {
        const nextUserId = session.user.id;
        if (expectedUserIdRef.current !== nextUserId) {
          if (expectedUserIdRef.current) revokeBrowserDraftSession(expectedUserIdRef.current);
          // INITIAL_SESSION and cross-tab sign-ins can change identity without
          // going through doLogin in this component.
          qc.clear();
          lastLoadedUserIdRef.current = null;
          currentProfileRef.current = null;
          setCurrentUser(null);
        }
        expectedUserIdRef.current = nextUserId;
        setHasSession(true);
        hydrate(nextUserId);
      } else if (event === "INITIAL_SESSION" && !session) {
        revokeBrowserDraftSession();
        // No session on mount - make sure the spinner isn't left on.
        expectedUserIdRef.current = null;
        lastLoadedUserIdRef.current = null;
        currentProfileRef.current = null;
        setHasSession(false);
        setLoginLoading(false);
      } else if (event === "SIGNED_OUT") {
        revokeBrowserDraftSession(expectedUserIdRef.current);
        qc.clear();
        expectedUserIdRef.current = null;
        lastLoadedUserIdRef.current = null;
        currentProfileRef.current = null;
        setHasSession(false);
        setCurrentUser(null);
        if (!loginAttemptRef.current) setLoginLoading(false);
      }
    });
    return () => { mounted = false; profileRequestRef.current += 1; subscription.unsubscribe(); };
  }, [hydrateProfile, qc]);

  return {
    currentUser, setCurrentUser, hasSession, loginEmail, setLoginEmail,
    loginPassword, setLoginPassword, rememberMe, setRememberMe, loginLoading, loginError,
    fadeIn, doLogin, logout, refreshCurrentProfile
  };
}
