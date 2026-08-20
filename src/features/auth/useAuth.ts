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

export async function changePassword(
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const sb = supabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export default function useAuth({
  fire,
  setPage,
  setSelectedWO,
  setAiNote,
  setInvoices,
}: any) {
  const qc = useQueryClient();
  const [currentUser, setCurrentUser] = useState<any>(null);
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
    if (expectedUserIdRef.current !== userId) return;
    try {
      const sb = supabase();
      const [profileResult, scopeResult, permissionsResult] = await Promise.all([
        sb.from("profiles").select("*").eq("id", userId).single(),
        (sb as any).rpc("get_my_contractor_scope"),
        (sb as any)
          .from("staff_permission_grants")
          .select("permission")
          .eq("profile_id", userId),
      ]);
      const { data: prof, error } = profileResult;
      if (error) throw error;
      if (scopeResult.error) throw scopeResult.error;
      if (permissionsResult.error) throw permissionsResult.error;
      if (!prof) throw new Error("Profile not found for this account");
      // An older profile request can finish after a new account signs in.
      // Never let that stale response restore the previous identity.
      if (expectedUserIdRef.current !== prof.id) return;
      if (lastLoadedUserIdRef.current === prof.id) return;
      lastLoadedUserIdRef.current = prof.id;
      const profAny = prof as any;
      const scope = scopeResult.data || {};
      setCurrentUser({
        id: prof.id, name: prof.name, email: prof.email, initials: prof.initials, role: prof.role,
        title: prof.title, company: prof.company, phone: prof.phone, territory: prof.territory,
        trades: prof.trades || [], color: prof.color,
        isDemo: DEMO_ACCOUNTS.some(d => d.email === prof.email),
        contractorTier: prof.contractor_tier || null,
        dispatcherId: prof.dispatcher_id || null,
        contractorAccountId: scope.contractorAccountId || (prof.role === "contractor" ? prof.id : null),
        contractorOrganizationId: scope.organizationId || null,
        contractorOrganizationName: scope.organizationName || null,
        contractorAccessLevel: scope.accessLevel || null,
        staffPermissions: (permissionsResult.data || [])
          .map((grant: any) => String(grant.permission)),
        canInvoice: !!scope.canInvoice,
        canManageTeam: !!scope.canManageTeam,
        // Display cap for the WO NTE shown to this contractor. Mask applied
        // at the PortalShell boundary so this never reaches staff math or
        // the NTE-flag bucket. Falls back to 1000 pre-migration.
        contractorNteDisplay: profAny.contractor_nte_display != null ? Number(profAny.contractor_nte_display) : 1000,
        // Reserved for Phase 2 per-contractor rates — the invoice form no
        // longer reads these (rates start empty, Truck Charge defaults 60).
        defaultLaborRate: prof.default_labor_rate ?? null,
        defaultTruckRate: prof.default_truck_rate ?? null,
      });
      setPage(prof.role === "contractor" ? "my_jobs" : "dashboard");
    } catch (err: any) {
      if (expectedUserIdRef.current !== userId) return;
      setLoginError(err?.message || "Could not load your profile");
      if (fire) fire(err?.message || "Could not load your profile");
      throw err;
    } finally {
      if (expectedUserIdRef.current === userId) {
        loginAttemptRef.current = false;
        authTransitionRef.current = null;
        setLoginLoading(false);
      }
    }
  }, [fire, setPage]);

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
      // Gate every profile-scoped query while Supabase changes identity. A
      // successful password sign-in replaces the local session itself, so a
      // pre-login sign-out would only create a 401 window (and its default
      // global scope would revoke the user's sessions on other devices).
      expectedUserIdRef.current = null;
      lastLoadedUserIdRef.current = null;
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
    } catch (err: any) {
      setLoginError(err.message || "Sign in failed");
      loginAttemptRef.current = false;
      authTransitionRef.current = null;
      setLoginLoading(false);
    }
  };
  const logout = async () => {
    loginAttemptRef.current = false;
    authTransitionRef.current = "logout";
    expectedUserIdRef.current = null;
    lastLoadedUserIdRef.current = null;
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
        } catch (err: any) {
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
          // INITIAL_SESSION and cross-tab sign-ins can change identity without
          // going through doLogin in this component.
          qc.clear();
          lastLoadedUserIdRef.current = null;
          setCurrentUser(null);
        }
        expectedUserIdRef.current = nextUserId;
        setHasSession(true);
        hydrate(nextUserId);
      } else if (event === "INITIAL_SESSION" && !session) {
        // No session on mount - make sure the spinner isn't left on.
        expectedUserIdRef.current = null;
        lastLoadedUserIdRef.current = null;
        setHasSession(false);
        setLoginLoading(false);
      } else if (event === "SIGNED_OUT") {
        qc.clear();
        expectedUserIdRef.current = null;
        lastLoadedUserIdRef.current = null;
        setHasSession(false);
        setCurrentUser(null);
        if (!loginAttemptRef.current) setLoginLoading(false);
      }
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [hydrateProfile, qc]);

  return {
    currentUser, setCurrentUser, hasSession, loginEmail, setLoginEmail,
    loginPassword, setLoginPassword, rememberMe, setRememberMe, loginLoading, loginError,
    fadeIn, doLogin, logout
  };
}
